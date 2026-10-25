from functools import lru_cache
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, features
from fontTools.ttLib import TTFont
from .config import settings
from .geometry import polygon_mask, rect_mask, bounds, text_components
import hashlib
import json
import re


@lru_cache(maxsize=1)
def glyphs():
    if not settings.font_path.exists():
        raise ValueError("Typesetting font unavailable. Run scripts/setup_models.py.")
    font = TTFont(settings.font_path)
    result = set().union(*(set(t.cmap) for t in font["cmap"].tables))
    font.close()
    return result


def wrap(draw, text, font, width):
    lines = []
    for paragraph in text.split("\n"):
        line = ""
        tokens = paragraph.split(" ") if " " in paragraph else list(paragraph)
        separator = " " if " " in paragraph else ""
        for token in tokens:
            candidate = (line + separator + token).strip()
            if draw.textlength(candidate, font=font) <= width:
                line = candidate
            else:
                if line:
                    lines.append(line)
                line = ""
                for char in token:
                    if draw.textlength(line + char, font=font) > width and line:
                        lines.append(line)
                        line = ""
                    line += char
        lines.append(line)
    return lines


def usable_area(original, region):
    opts = region.render or {}
    shape = (original.height, original.width)
    polygon = opts.get("bubble_polygon")
    padding = max(3, min(10, round(min(region.box[2:]) * 0.045)))
    area = (
        polygon_mask(shape, polygon, padding)
        if polygon
        else rect_mask(shape, region.box)
    )
    if not polygon:
        area = cv2.erode(area, np.ones((7, 7), np.uint8))
    # A manually resized box further constrains the detected interior.
    area = cv2.bitwise_and(area, rect_mask(shape, region.box))
    if polygon:
        gray = np.asarray(original.convert("L"))
        _, _, art = text_components(gray, polygon_mask(shape, polygon))
        n, labels, stats, _ = cv2.connectedComponentsWithStats(
            (art > 0).astype(np.uint8), 8
        )
        for i in range(1, n):
            x, y, w, h, a = stats[i]
            if a > 50:
                area[max(0, y - 4) : y + h + 4, max(0, x - 4) : x + w + 4] = 0
    return area


def fit_text(original, region, allowed):
    """Measure actual glyph pixels; reject overflow, including offsets/long words."""
    x, y, w, h = bounds(allowed)
    opts = region.render or {}
    if w < 8 or h < 8:
        return None
    measure = ImageDraw.Draw(original)
    ceiling = min(int(opts.get("font_size") or max(16, min(w, h) * 0.19)), 72)
    for size in range(ceiling, 11, -1):
        font = ImageFont.truetype(str(settings.font_path), size)
        for fraction in (1, 0.9, 0.8, 0.7, 0.6):
            width = max(8, int(w * fraction))
            lines = wrap(measure, region.translation, font, width)
            lh = round(size * 1.25)
            total = len(lines) * lh
            if total > h:
                continue
            for cy in (0.5, 0.4, 0.6, 0.3, 0.7):
                top = round(y + (h - total) * cy) + int(opts.get("offset_y", 0))
                layer = Image.new("L", original.size)
                draw = ImageDraw.Draw(layer)
                for i, line in enumerate(lines):
                    length = draw.textlength(line, font=font)
                    left = x + (w - length) / 2
                    if opts.get("align") == "left":
                        left = x + (w - width) / 2
                    elif opts.get("align") == "right":
                        left = x + (w + width) / 2 - length
                    draw.text(
                        (round(left) + int(opts.get("offset_x", 0)), top + i * lh),
                        line,
                        font=font,
                        fill=255,
                        anchor="lt",
                    )
                pixels = np.asarray(layer)
                if np.any(pixels) and not np.any((pixels > 0) & (allowed == 0)):
                    return layer, size
    return None


def build_text_mask(array, region):
    """Propose lettering pixels in page coordinates; do not alter artwork."""
    opts = region.render or {}
    gray = cv2.cvtColor(array, cv2.COLOR_RGB2GRAY)
    source_box = opts.get("source_box", region.box)
    source = rect_mask(gray.shape, source_box)
    polygon = opts.get("bubble_polygon")
    interior = (
        polygon_mask(gray.shape, polygon, 2)
        if polygon
        else rect_mask(gray.shape, source_box)
    )
    if polygon:
        ink, _, protected = text_components(gray, polygon_mask(gray.shape, polygon))
        ink = cv2.bitwise_and(ink, source)
    else:
        # Connected components protect long panel rules; manual exclusions can
        # refine the mask for text over artwork.
        ink, _, protected = text_components(gray, interior)
        ink = cv2.bitwise_and(ink, source)
    for box in opts.get("mask_include", []):
        extra = (gray < 210).astype(np.uint8) * 255
        ink = cv2.bitwise_or(ink, cv2.bitwise_and(extra, rect_mask(gray.shape, box)))
    exclusions = np.zeros_like(gray)
    for box in opts.get("mask_exclude", []):
        exclusions = cv2.bitwise_or(exclusions, rect_mask(gray.shape, box))
    base_ink = ink.copy()
    radius = int(opts.get("mask_dilation", 1))
    mask = cv2.dilate(ink, np.ones((radius * 2 + 1, radius * 2 + 1), np.uint8))
    mask = cv2.bitwise_and(mask, interior)
    mask[exclusions > 0] = 0
    if not np.any(mask):
        return None, "No text pixels could be safely removed; original region preserved."
    return {
        "gray": gray,
        "mask": mask,
        "base_ink": base_ink,
        "interior": interior,
        "exclusions": exclusions,
        "protected": protected,
    }, ""


def clean_region(array, region, allowed, mask_data=None):
    mask_data, reason = (mask_data, "") if mask_data is not None else build_text_mask(array, region)
    if mask_data is None:
        return None, None, [reason]
    gray = mask_data["gray"]
    mask = mask_data["mask"].copy()
    base_ink = mask_data["base_ink"]
    interior = mask_data["interior"]
    exclusions = mask_data["exclusions"]
    protected = mask_data["protected"]
    ring = cv2.dilate(mask, np.ones((9, 9), np.uint8)) > 0
    ring &= (mask == 0) & (interior > 0) & (protected == 0)
    samples = array[ring]
    if len(samples) < 10:
        return (
            None,
            None,
            ["Background could not be estimated; original region preserved."],
        )
    background = np.median(samples, axis=0)
    uniform = (
        np.mean(np.max(np.abs(samples.astype(float) - background), axis=1) < 15) > 0.8
    )
    clean = array.copy()
    notices = []
    if uniform:
        clean[mask > 0] = background.astype(np.uint8)
        # Pixel coverage check over all proposed lettering, with one bounded
        # mask refinement. This is not a semantic guarantee for undetected ink.
        residual = (
            (cv2.cvtColor(clean, cv2.COLOR_RGB2GRAY) < float(np.mean(background)) - 40)
            & (base_ink > 0)
            & (exclusions == 0)
        )
        if residual.sum() > 3:
            mask = cv2.bitwise_and(
                cv2.dilate(mask, np.ones((3, 3), np.uint8)), interior
            )
            mask[exclusions > 0] = 0
            clean[mask > 0] = background.astype(np.uint8)
        residual = (
            (cv2.cvtColor(clean, cv2.COLOR_RGB2GRAY) < float(np.mean(background)) - 40)
            & (base_ink > 0)
            & (exclusions == 0)
        )
        if residual.sum() > 3:
            return (
                None,
                None,
                ["Source lettering remains after cleanup; original region preserved."],
            )
    else:
        clean = cv2.inpaint(clean, mask, 3, cv2.INPAINT_TELEA)
        notices.append("Textured background reconstruction needs visual review.")
        residual = (cv2.cvtColor(clean, cv2.COLOR_RGB2GRAY) < 80) & (base_ink > 0)
        if residual.sum() > max(8, np.count_nonzero(base_ink) * 0.1):
            return None, None, ["Cleanup remains uncertain; original region preserved."]
    # Excluded original ink cannot be covered by new typography.
    if np.any((base_ink > 0) & (exclusions > 0)):
        notices.append("Mask exclusions retain original ink; inspect the result.")
    return clean, mask, notices


def render_page(original, regions, cache_path=None):
    from .diagnostics import record
    original = original.convert("RGB")
    array = np.asarray(original)
    notices = {r.id: [] for r in regions}
    layouts = {}
    areas = {}
    occupied = np.zeros(array.shape[:2], np.uint8)
    for r in regions:
        opts = r.render or {}
        opts = {**opts, "state": "detected"}
        opts["stage_statuses"] = {
            **{k: v for k, v in opts.get("stage_statuses", {}).items()
               if k not in ("mask", "cleaning", "rendering")},
            "cleaning": {"status": "NOT_RUN", "reason": "Awaiting a safe mask and renderable translation."},
            "rendering": {"status": "NOT_RUN", "reason": "Awaiting validated cleanup."},
        }
        opts.pop("actual_font_size", None)
        opts.pop("cleanup_cache_hit", None)
        r.render = opts
        if r.restored:
            opts["state"] = "restored"
            continue
        if opts.get("source_is_target"):
            opts["state"] = "original_language"
            continue
        if hasattr(r, "source_text") and not r.source_text.strip():
            notices[r.id].append("Text region detected, but OCR returned no readable text. Retry recognition or enter the source text.")
            continue
        if not opts.get("source_verified") and getattr(r, "language", None) == "ja" and len(re.findall(r"[\u3040-\u30ff\u3400-\u9fff]", getattr(r, "source_text", ""))) < 3:
            notices[r.id].append("Short Japanese interjection needs translation review; original preserved.")
            continue
        if opts.get("ocr_semantic_ambiguity") and not opts.get("source_verified"):
            notices[r.id].append("OCR alternative changes the referent; review the translation before replacing original text.")
            continue
        # Geometric proposals can be faces or clothing. A generative recognizer
        # is not evidence on its own: require corroboration before erasing ink.
        if not opts.get("source_verified") and (
            (getattr(r,'language',None)=='ja' and not re.search('[\u3040-\u30ff\u4e00-\u9fff]',getattr(r,'source_text','')))
            or
            (not opts.get("ocr_corroborated") and opts.get("ocr_agreement", 1) < settings.ocr_min_agreement)
            or (not opts.get("ocr_corroborated") and getattr(r, "confidence", 1) < settings.ocr_min_confidence)
            or (
                opts.get("pipeline_version") == 2
                and not opts.get("bubble_polygon")
                and not opts.get("manual")
            )
        ):
            notices[r.id].append(
                "Recognition or bubble association needs confirmation; original preserved."
            )
            continue
        if opts.get("ocr_uncertain") and not opts.get("source_verified") and not opts.get("ocr_corroborated"):
            notices[r.id].append(
                "Uncertain OCR; verify source text before replacement."
            )
            continue
        if opts.get("translation_error"):
            notices[r.id].append(opts["translation_error"])
            continue
        if not r.translation.strip():
            notices[r.id].append("Missing translation; original region preserved.")
            continue
        if opts.get("translation_quality"):
            notices[r.id].extend(opts["translation_quality"])
            continue
        if any(ord(c) not in glyphs() for c in r.translation if not c.isspace()):
            notices[r.id].append("Missing font glyphs; original region preserved.")
            continue
        area = usable_area(original, r)
        layout = fit_text(original, r, area)
        if not layout:
            notices[r.id].append(
                "Translation does not fit inside the safe region at 12px; original preserved."
            )
            continue
        if np.any((area > 0) & (occupied > 0)):
            notices[r.id].append(
                "Overlapping text regions require review; original region preserved."
            )
            continue
        occupied = cv2.bitwise_or(occupied, area)
        layouts[r.id] = layout
        areas[r.id] = area
        opts["state"] = "translation_completed"
    candidate_masks = {}
    for r in regions:
        opts = dict(r.render or {})
        opts["mask_applied_pixels"] = 0
        if r.restored or opts.get("source_is_target") or (hasattr(r, "source_text") and not r.source_text.strip()):
            opts.update(mask_status="not_applicable", mask_candidate_pixels=0, mask_failure_reason="")
        else:
            record(opts, "MASK_PENDING")
            proposal, reason = build_text_mask(array, r)
            if proposal is None:
                opts.update(mask_status="failed", mask_candidate_pixels=0, mask_failure_reason=reason)
                record(opts, "MASK_FAILED", reason)
            else:
                if r.id in layouts:
                    candidate_masks[r.id] = proposal
                opts.update(mask_status="candidate", mask_candidate_pixels=int(np.count_nonzero(proposal["mask"])), mask_failure_reason="")
                record(opts, "MASK_SUCCESS")
                if r.id in layouts:
                    record(opts, "INPAINTING_PENDING")
        r.render = opts
    # Cleanup excludes translation and typography. Per-region signatures let a
    # mask retry reuse every other successfully cleaned region.
    original_digest = hashlib.sha256(array.tobytes()).hexdigest()
    region_ids = {r.id: index + 1 for index, r in enumerate(regions)}
    signatures = {}
    for r in regions:
        if r.id not in layouts:
            continue
        opts = r.render or {}
        signature_input = [
            region_ids[r.id], r.box, r.words,
            {k: opts.get(k) for k in (
                "source_box", "bubble_polygon", "mask_include", "mask_exclude",
                "mask_dilation", "mask_revision",
            )},
        ]
        signatures[r.id] = hashlib.sha256(json.dumps(signature_input, sort_keys=True).encode()).hexdigest()
    key = hashlib.sha256(json.dumps(["cleanup-v6", original_digest, signatures], sort_keys=True).encode()).hexdigest()
    loaded = False
    reused_ids = set()
    recompute_ids = set(layouts)
    cleanup_notices = {}
    successful = []
    if cache_path and cache_path.with_suffix(".json").exists():
        try:
            metadata = json.loads(cache_path.with_suffix(".json").read_text())
            if metadata.get("original_digest") == original_digest and metadata.get("region_ids") == region_ids:
                clean_array = np.array(
                    Image.open(cache_path.with_suffix(".clean.png")).convert("RGB")
                )
                mask = np.array(
                    Image.open(cache_path.with_suffix(".mask.png")).convert("L")
                )
                owners = np.array(Image.open(cache_path.with_suffix(".owners.png")))
                loaded = (
                    clean_array.shape == array.shape
                    and mask.shape == array.shape[:2]
                    and owners.shape == mask.shape
                )
                if loaded:
                    previous = metadata.get("signatures", {})
                    changed = {rid for rid in set(previous) | set(signatures) if previous.get(rid) != signatures.get(rid)}
                    if metadata.get("key") != key and len(changed) != 1:
                        loaded = False
                    else:
                        cleanup_notices = dict(metadata.get("notices", {}))
                        successful = list(metadata.get("successful", []))
                        # A final typography rejection rolls cleanup back. It
                        # must be tried again after a text/offset edit, although
                        # those edits intentionally do not invalidate good masks.
                        recompute_ids = (changed | (set(layouts) - set(successful))) & set(layouts)
                        for rid in changed:
                            if rid in successful:
                                restore = owners == region_ids[rid]
                                clean_array[restore] = array[restore]
                                mask[restore] = 0
                                owners[restore] = 0
                                successful.remove(rid)
                            cleanup_notices.pop(rid, None)
                        reused_ids = set(successful)
        except (OSError, ValueError, KeyError):
            loaded = False
    if not loaded:
        clean_array = array.copy()
        mask = np.zeros(array.shape[:2], np.uint8)
        owners = np.zeros(array.shape[:2], np.uint16)
        recompute_ids = set(layouts)
        cleanup_notices = {}
        successful = []
        reused_ids = set()
    if recompute_ids:
        for r in regions:
            if r.id not in recompute_ids:
                continue
            if r.id not in candidate_masks:
                cleanup_notices[r.id] = [r.render.get("mask_failure_reason") or "No safe text mask is available."]
                continue
            cleaned, region_mask, notes = clean_region(array, r, areas[r.id], candidate_masks[r.id])
            cleanup_notices[r.id] = notes
            if cleaned is None:
                continue
            if np.any((region_mask > 0) & (mask > 0)):
                cleanup_notices[r.id].append(
                    "Overlapping source masks need review; original preserved."
                )
                continue
            clean_array[region_mask > 0] = cleaned[region_mask > 0]
            owners[region_mask > 0] = region_ids[r.id]
            mask = cv2.bitwise_or(mask, region_mask)
            successful.append(r.id)
    output = Image.fromarray(clean_array)
    for r in regions:
        notices[r.id] += cleanup_notices.get(r.id, [])
        opts = r.render or {}
        if r.id in successful:
            layer, size = layouts[r.id]
            # No typography may cover unremoved dark original pixels.
            pixels = np.asarray(layer) > 0
            leftover = (
                (cv2.cvtColor(clean_array, cv2.COLOR_RGB2GRAY) < 110)
                & (mask == 0)
                & pixels
            )
            if np.any(leftover):
                # Restore this region's cleanup as well as omitting its overlay.
                reason = "Lettering or artwork remains under the proposed text; original preserved."
                notices[r.id].append(reason)
                cleanup_notices.setdefault(r.id, []).append(reason)
                restore = owners == region_ids[r.id]
                out = np.array(output)
                out[restore] = array[restore]
                output = Image.fromarray(out)
                clean_array[restore] = array[restore]
                mask[restore] = 0
                owners[restore] = 0
                successful.remove(r.id)
                opts["state"] = "needs_review"
                record(opts, "INPAINTING_FAILED", notices[r.id][-1])
                continue
            record(opts, "MASK_APPLIED")
            record(opts, "INPAINTING_SUCCESS")
            record(opts, "RENDERING_PENDING")
            output.paste("#171719", (0, 0), layer)
            opts.update(
                state="rendering_completed",
                actual_font_size=size,
                cleanup_cache_hit=r.id in reused_ids,
            )
            record(opts, "RENDERING_SUCCESS")
            record(opts, "COMPLETED")
        elif not r.restored:
            opts["state"] = "needs_review"
            reason = notices[r.id][0] if notices[r.id] else "Region was not rendered"
            if hasattr(r, "source_text") and not r.source_text.strip():
                record(opts, "OCR_FAILED", reason)
            elif r.id in layouts and opts.get("mask_status") == "failed":
                record(opts, "MASK_FAILED", opts.get("mask_failure_reason") or reason)
            elif r.id in layouts:
                record(opts, "INPAINTING_FAILED", reason)
            elif "fit" in reason or "glyph" in reason:
                record(opts, "RENDERING_FAILED", reason)
            elif opts.get("translation_error"):
                record(opts, "TRANSLATION_FAILED", reason)
            else:
                record(opts, "NEEDS_MANUAL_REVIEW", reason)
        r.render = dict(opts)
    for r in regions:
        opts = dict(r.render or {})
        applied = int(np.count_nonzero((owners == region_ids[r.id]) & (mask > 0)))
        opts["mask_applied_pixels"] = applied
        if applied:
            opts["mask_status"] = "applied"
        r.render = opts
    if cache_path:
        for suffix, pixels in [
            (".clean.png", clean_array),
            (".mask.png", mask),
            (".owners.png", owners),
        ]:
            target = cache_path.with_suffix(suffix)
            temporary = target.with_suffix(".tmp")
            Image.fromarray(pixels).save(temporary, format="PNG")
            temporary.replace(target)
        temporary = cache_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps({
            "key": key, "original_digest": original_digest,
            "region_ids": region_ids, "signatures": signatures,
            "notices": cleanup_notices, "successful": successful,
        }))
        temporary.replace(cache_path.with_suffix(".json"))
    return output, Image.fromarray(clean_array), Image.fromarray(mask), notices
