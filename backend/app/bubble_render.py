"""Cleanup and text fitting inside an approved speech bubble."""

import re

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .geometry import bounds, polygon_mask, rect_mask

BOUNDARY = "Source lettering crosses the bubble boundary"
CLEANUP = "Original lettering could not be fully removed"
TOO_LONG = "Translation is too long to fit at a readable size"


def inset(mask, padding):
    return cv2.erode(mask, np.ones((2 * padding + 1,) * 2, np.uint8),
                     borderType=cv2.BORDER_CONSTANT, borderValue=0)


def runs(mask, limit=600):
    """Horizontal runs in original page coordinates for the editor overlay."""
    x, y, w, h = bounds(mask.astype(np.uint8))
    output = []
    for row in range(y, y + h):
        edges = np.flatnonzero(np.diff(np.pad(mask[row, x:x + w] > 0, 1)))
        for start, end in zip(edges[::2], edges[1::2]):
            if len(output) == limit:
                return output, True
            output.append([int(x + start), row, int(end - start)])
    return output, False


def overlay(region, field, mask):
    debug = region.render.setdefault("layout_debug", {})
    pixels, truncated = runs(mask)
    debug[field] = pixels
    debug[field + "_truncated"] = truncated


def approved_mask(array, region, interior=None):
    opts = region.render
    gray = cv2.cvtColor(array, cv2.COLOR_RGB2GRAY)
    outline = polygon_mask(gray.shape, opts["bubble_polygon"])
    interior = inset(outline, 1) if interior is None else interior
    x, y, w, h = bounds(outline)
    if not w or not h:
        return None, CLEANUP
    patch = gray[y:y + h, x:x + w]
    # Closing estimates the background across narrow dark strokes and retains
    # gradual shading. Keep the estimate independent of the reconstructed pixels.
    # A polygon boundary must not introduce an artificial dark edge.
    support = np.where(outline[y:y + h, x:x + w] > 0, patch, 0).astype(np.uint8)
    reference = gray.copy()
    local = cv2.morphologyEx(support, cv2.MORPH_CLOSE,
                             cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21)))
    reference[y:y + h, x:x + w] = np.maximum(patch, local)
    contrast = cv2.subtract(reference, gray)
    high = ((contrast >= 22) & (outline > 0)).astype(np.uint8)
    sx, sy, sw, sh = opts.get("source_box") or region.box
    source = rect_mask(gray.shape, [sx, sy, sw, sh])
    halo = max(5, min(18, round(min(w, h) * .12)))
    nearby = rect_mask(gray.shape, [sx - halo, sy - halo, sw + 2 * halo, sh + 2 * halo])
    for box in opts.get("mask_include", []):
        source |= rect_mask(gray.shape, box)
        nearby |= rect_mask(gray.shape, box)
    protected = np.zeros_like(gray)
    for box in opts.get("mask_exclude", []):
        protected |= rect_mask(gray.shape, box)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(high, 8)
    ink = np.zeros_like(gray)
    rejected = np.zeros_like(gray)
    crossing = np.zeros_like(gray)
    body = inset(outline, min(8, max(3, min(w, h) // 8)))
    for index in range(1, count):
        a, b, cw, ch, size = stats[index]
        local_slice = np.s_[b:b + ch, a:a + cw]
        component = labels[local_slice] == index
        anchors = np.count_nonzero(component & (source[local_slice] > 0))
        near = np.count_nonzero(component & (nearby[local_slice] > 0))
        touching = component & (interior[local_slice] == 0)
        body_pixels = np.count_nonzero(component & (body[local_slice] > 0))
        if anchors and body_pixels >= 5 and np.any(touching):
            crossing[local_slice][touching] = 255
            continue
        if np.any(touching):
            # Unassigned fragments on the outline can belong to the tail or
            # border. Leave them out of both the mask and text candidates.
            continue
        if not near:
            # An isolated probable glyph beyond the OCR extent must be
            # reviewed. Tiny texture/screening dots are not treated as words.
            if body_pixels and 10 <= size <= 0.055 * w * h and cw <= w * .5 and ch <= h * .5:
                rejected[local_slice][component] = 255
            continue
        if (size > .13 * w * h or cw > .8 * w or ch > .8 * h
                or np.any(component & (protected[local_slice] > 0))):
            if anchors:
                rejected[local_slice][component] = 255
            continue
        if anchors or near >= size * .5:
            ink[local_slice][component] = 255
    if np.any(crossing):
        overlay(region, "source", ink)
        overlay(region, "rejected", crossing)
        return None, BOUNDARY
    if np.any(rejected) or not np.any(ink):
        overlay(region, "source", ink)
        overlay(region, "rejected", rejected)
        return None, CLEANUP
    # Account for weak antialiased pixels connected to a letter. Weak
    # contrast elsewhere in the bubble does not authorize changes.
    fringe = (contrast >= 5) & (interior > 0) & (protected == 0)
    expanded = cv2.dilate(ink, np.ones((5, 5), np.uint8))
    expected = (fringe & (expanded > 0)) | (ink > 0)
    radius = max(1, min(4, int(opts.get("mask_dilation", 1))))
    mask = cv2.dilate(expected.astype(np.uint8) * 255, np.ones((2 * radius + 1,) * 2, np.uint8))
    mask &= interior
    mask[protected > 0] = 0
    if np.count_nonzero(mask) > .45 * np.count_nonzero(interior):
        overlay(region, "rejected", expected)
        return None, CLEANUP
    overlay(region, "source", mask)
    return dict(mask=mask, expected=expected, interior=interior, exclusions=protected,
                gray=gray, reference=reference), ""


def reconstruct(array, region, data):
    mask = data["mask"].copy()
    interior, protected = data["interior"], data["exclusions"]
    ring = ((cv2.dilate(mask, np.ones((11, 11), np.uint8)) > 0)
            & (mask == 0) & (interior > 0) & (protected == 0))
    samples = array[ring]
    if len(samples) < 8:
        overlay(region, "rejected", data["expected"])
        return None, None, [CLEANUP]
    background = np.median(samples, axis=0)
    uniform = np.mean(np.max(np.abs(samples.astype(float) - background), axis=1) < 9) >= .87
    notes = [] if uniform else ["Review the reconstructed background."]
    for attempt in range(2):
        cleaned = array.copy()
        if uniform:
            cleaned[mask > 0] = np.round(background).astype(np.uint8)
        else:
            cleaned = cv2.inpaint(cleaned, mask, 3 + 2 * attempt, cv2.INPAINT_TELEA)
        gray = cv2.cvtColor(cleaned, cv2.COLOR_RGB2GRAY)
        residual = data["expected"] & (
            (mask == 0) | (cv2.subtract(data["reference"], gray) > (12 if uniform else 22))
        )
        if not np.any(residual):
            overlay(region, "source", mask)
            return cleaned, mask, notes
        expanded = cv2.dilate(mask | (residual.astype(np.uint8) * 255), np.ones((5, 5), np.uint8))
        expanded &= interior
        expanded[protected > 0] = 0
        if np.count_nonzero(expanded) > .45 * np.count_nonzero(interior):
            break
        mask = expanded
    overlay(region, "rejected", residual)
    return None, None, [CLEANUP]


def tokens(text):
    script = r"\u0e00-\u0e7f\u2e80-\u9fff\uf900-\ufaff"
    # Keep leading Thai vowels and following combining marks with their base.
    thai = r"[\u0e40-\u0e44]*[\u0e01-\u0e2e][\u0e30-\u0e3a\u0e45\u0e47-\u0e4e]*|[\u0e00-\u0e7f]"
    pattern = rf"{thai}|[\u2e80-\u9fff\uf900-\ufaff]|[^\s{script}]+|[^\S\n]+"
    return [re.findall(pattern, line) for line in re.split(r"\r\n?|\n", text)]


def fit_approved(original, region, allowed, font_path):
    x, y, w, h = bounds(allowed)
    if min(w, h) < 8:
        return None
    opts = region.render
    paragraphs = tokens(region.translation)
    measure = ImageDraw.Draw(original)
    ox, oy = int(opts.get("offset_x", 0)), int(opts.get("offset_y", 0))
    # Offsets participate in the search. A box can guide the editor without
    # shrinking the approved usable interior.
    if abs(ox) >= w or abs(oy) >= h:
        return None
    for size in range(min(int(opts.get("font_size") or 100), 100), 11, -1):
        font = ImageFont.truetype(str(font_path), size)
        # Nominal ascent/descent include generous font metrics. Use actual
        # glyph extents to estimate the band, then validate the entire raster.
        _, upper, _, lower = font.getbbox(region.translation.replace("\n", ""), anchor="ls")
        if lower <= upper or lower - upper > h:
            continue
        band_height = lower - upper
        widest = measure.textlength(region.translation.replace("\n", " "), font=font)
        min_lines = max(len(paragraphs), int(widest / max(1, w)) - 1, 1)
        line_height = max(band_height + 2, round(size * (1.15 if min_lines >= 4 else 1.22)))
        max_lines = int((h - band_height) / line_height) + 1
        for line_count in range(min_lines, min(max_lines, min_lines + 9) + 1):
            block_height = (line_count - 1) * line_height + band_height
            for center in (.50, .33, .67, .15, .85):
                first = round(y + (h - block_height) * center)
                lines = []
                pi, wi = 0, 0
                for index in range(line_count):
                    top = first + index * line_height
                    baseline = top - upper
                    start_y, end_y = top + oy, top + band_height + oy
                    if start_y < y or end_y > y + h:
                        break
                    columns = np.all(allowed[start_y:end_y, x:x + w] > 0, axis=0)
                    spans = np.flatnonzero(np.diff(np.pad(columns, 1)))
                    if not spans.size:
                        break
                    left, right = max(zip(spans[::2], spans[1::2]), key=lambda pair: pair[1] - pair[0])
                    text = ""
                    while wi < len(paragraphs[pi]):
                        candidate = text + paragraphs[pi][wi]
                        a, _, b, _ = font.getbbox(candidate.strip(), anchor="ls")
                        if b - a > right - left:
                            break
                        text = candidate
                        wi += 1
                    if not text and wi < len(paragraphs[pi]):
                        break
                    text = text.strip()
                    if text:
                        a, _, b, _ = font.getbbox(text, anchor="ls")
                        fitted = right - left - (b - a)
                        align = opts.get("align")
                        dx = 0 if align == "left" else fitted if align == "right" else fitted / 2
                        lines.append((round(x + left + dx - a + ox), baseline + oy, text))
                    if wi == len(paragraphs[pi]):
                        pi, wi = pi + 1, 0
                    if pi == len(paragraphs):
                        break
                if pi != len(paragraphs) or not lines:
                    continue
                boxes = [measure.textbbox((lx, ly), text, font=font, anchor="ls") for lx, ly, text in lines]
                left = min(box[0] for box in boxes)
                top = min(box[1] for box in boxes)
                right = max(box[2] for box in boxes)
                bottom = max(box[3] for box in boxes)
                # Rasterize the complete glyph bounds, including overhangs,
                # before considering page clipping.
                glyphs = Image.new("L", (right - left, bottom - top))
                draw = ImageDraw.Draw(glyphs)
                for lx, ly, text in lines:
                    draw.text((lx - left, ly - top), text, font=font, anchor="ls", fill=255)
                if left < 0 or top < 0 or right > original.width or bottom > original.height:
                    continue
                pixels = np.asarray(glyphs) > 0
                overflow = pixels & (allowed[top:bottom, left:right] == 0)
                if np.any(overflow):
                    reject = np.zeros_like(allowed)
                    reject[top:bottom, left:right] = overflow
                    overlay(region, "rejected", reject)
                    continue
                if np.any(pixels):
                    region.render.get("layout_debug", {}).pop("rejected", None)
                    layer = Image.new("L", original.size)
                    layer.paste(glyphs, (left, top))
                    return layer, size
    return None
