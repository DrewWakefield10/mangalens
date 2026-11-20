"""Geometric speech bubble proposals and the authoritative scan/approval rules."""

import hashlib
import json
from itertools import combinations

import cv2
import numpy as np
from PIL import Image

from .geometry import bounds, polygon_mask

VERSION = "speech-bubbles-v1"


def fingerprint(*values):
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def scan_for(page):
    scan = page.metrics.get("bubble_scan", {})
    if scan.get("version") == VERSION and scan.get("digest") == page.digest:
        return scan
    return {}


def approved_bubbles(page):
    scan = scan_for(page)
    if scan.get("status") != "ready" or not scan.get("reviewed"):
        return []
    return [item for item in scan["bubbles"] if item["decision"] == "approved"]


def mark_scan_failed(page, reason):
    page.metrics = {**page.metrics, "bubble_scan": {
        **scan_for(page), "status": "failed", "reason": reason, "reviewed": False, "bubbles": [],
    }}


def eligible(page, region):
    options = region.render or {}
    return any(
        options.get("bubble_id") == item["id"]
        and options.get("bubble_polygon") == item["polygon"]
        and options.get("bubble_version") == VERSION
        for item in approved_bubbles(page)
    )


def validate_polygon(points, width, height):
    outline = np.asarray(points, dtype=np.int32)
    if (len(points) < 3 or len({tuple(point) for point in points}) != len(points)
            or np.any(outline < 0) or np.any(outline >= (width, height))
            or not 150 <= cv2.contourArea(outline) <= width * height * 0.85):
        raise ValueError("Draw a usable bubble boundary inside the page.")

    def side(a, b, c):
        return int(b[0] - a[0]) * int(c[1] - a[1]) - int(b[1] - a[1]) * int(c[0] - a[0])

    edges = list(zip(points, points[1:] + points[:1]))
    for (i, (a, b)), (j, (c, d)) in combinations(enumerate(edges), 2):
        if j - i in (1, len(edges) - 1):
            continue
        if (all(max(min(a[k], b[k]), min(c[k], d[k])) <= min(max(a[k], b[k]), max(c[k], d[k]))
                for k in (0, 1))
                and side(a, b, c) * side(a, b, d) <= 0
                and side(c, d, a) * side(c, d, b) <= 0):
            raise ValueError("Bubble edges cannot cross.")
    return list(cv2.boundingRect(outline))


def intersect(a, b):
    x, y = max(a["box"][0], b["box"][0]), max(a["box"][1], b["box"][1])
    right = min(item["box"][0] + item["box"][2] for item in (a, b))
    bottom = min(item["box"][1] + item["box"][3] for item in (a, b))
    if right <= x or bottom <= y:
        return False
    shape = (bottom - y, right - x)
    masks = [polygon_mask(shape, [[px - x, py - y] for px, py in item["polygon"]])
             for item in (a, b)]
    return bool(np.any(masks[0] & masks[1]))


def detect_speech_bubbles(image):
    """Find framed, light interiors without an OCR or model dependency."""
    scale = min(1, 1500 / max(image.size))
    reduced = image.resize(tuple(max(1, round(d * scale)) for d in image.size))
    gray = np.asarray(reduced.convert("L"))
    gap = max(3, min(9, round(min(gray.shape) * 0.008) | 1))
    ink = (gray < 140).astype(np.uint8)
    closed = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((gap, gap), np.uint8))
    white = ((gray > 185) & (closed == 0)).astype(np.uint8)
    soft = (cv2.GaussianBlur(gray, (9, 9), 0) > 228).astype(np.uint8)
    contours = []
    for mask, fuzzy in ((white, False), (soft, True)):
        found, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        contours.extend((contour, fuzzy) for contour in sorted(found, key=cv2.contourArea, reverse=True))
    proposals = []
    for contour, fuzzy in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = cv2.contourArea(contour)
        if (min(w, h) < 29 or area < 600 or area > gray.size * 0.38
                or x < 2 or y < 2 or x + w >= gray.shape[1] - 2 or y + h >= gray.shape[0] - 2
                or area / (w * h) < 0.43 or max(w / h, h / w) > 5):
            continue
        if area / max(1, cv2.contourArea(cv2.convexHull(contour))) < 0.66:
            continue
        # Straight-sided narration boxes lack the rounded or jagged silhouette
        # of the supported speech bubbles.
        corners = cv2.approxPolyDP(contour, max(2, min(w, h) * 0.045), True)
        if len(corners) == 4 and area / (w * h) > 0.84:
            continue
        margin = 5
        left, top = max(0, x - margin), max(0, y - margin)
        patch = gray[top:y + h + margin, left:x + w + margin]
        local = contour - np.array([[[left, top]]], dtype=np.int32)
        inside = np.zeros(patch.shape, np.uint8)
        cv2.drawContours(inside, [local], -1, 1, cv2.FILLED)
        ring = cv2.dilate(inside, np.ones((5, 5), np.uint8)) > inside
        support = np.mean(patch[ring] < (225 if fuzzy else 170)) if np.any(ring) else 0
        fill = np.mean(patch[inside > 0] > 185)
        text_fraction = np.mean(patch[inside > 0] < 155)
        if support < 0.27 or fill < 0.78 or not 0.007 <= text_fraction <= 0.19:
            continue
        # Opening cuts narrow tails and jagged tips. Erosion keeps the scan
        # and later artwork edits away from the printed border.
        radius = max(3, min(19, round(min(w, h) * 0.115)))
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1,) * 2)
        core = cv2.morphologyEx(inside, cv2.MORPH_OPEN, kernel)
        core = cv2.erode(core, np.ones((5, 5), np.uint8))
        cores, _ = cv2.findContours(core, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cores:
            continue
        dark = ((patch < 155) & (core > 0)).astype(np.uint8)
        _, _, stats, _ = cv2.connectedComponentsWithStats(dark)
        components = [int(value) for value in stats[1:, 4] if value >= 4]
        bright = np.mean(patch[core > 0] >= 242)
        density = float(dark.sum()) / max(1, int(core.sum()))
        if (bright < 0.60 or len(components) < 2 or sum(components) < 35
                or density < 0.009 or max(components) > sum(components) * 0.68):
            continue
        rim = (core > 0) & (cv2.erode(core, np.ones((3, 3), np.uint8)) == 0)
        touches_edge = bool(np.any(rim & (patch < 145)))
        main = max(cores, key=cv2.contourArea)
        solidity = cv2.contourArea(main) / max(1, cv2.contourArea(cv2.convexHull(main)))
        outer_ring = cv2.dilate(inside, np.ones((9, 9), np.uint8)) > cv2.dilate(inside, np.ones((5, 5), np.uint8))
        light_outside = np.mean(patch[outer_ring] > 220) if np.any(outer_ring) else 0
        polygon = cv2.approxPolyDP(main, 1.1, True).reshape(-1, 2)
        polygon = np.rint((polygon + [left, top]) / scale).astype(int).tolist()
        if not 3 <= len(polygon) <= 120:
            continue
        try:
            box = validate_polygon(polygon, *image.size)
        except ValueError:
            continue
        # Snapshots use a stable ID so an unchanged selection keeps its work.
        strong_outline = (support >= 0.55 and solidity >= 0.94 if fuzzy else
                          support >= 0.62 and (solidity >= 0.90 or light_outside > 0.34))
        accepted = strong_outline and fill >= 0.84 and not touches_edge and bright >= 0.77
        reason = ("Lettering or artwork touches the edge. Check the boundary." if touches_edge
                  else "The outline does not clearly separate this bubble from the artwork.")
        item = {"id": fingerprint(polygon)[:24], "polygon": polygon, "box": box,
                "detection": "accepted" if accepted else "uncertain",
                "decision": "approved" if accepted else "pending",
                "reason": "" if accepted else reason}
        if not any(intersect(item, previous) for previous in proposals):
            proposals.append(item)
        if len(proposals) == 80:
            break
    return sorted(proposals, key=lambda item: (item["box"][1] // max(1, image.height // 10),
                                               -item["box"][0], item["box"][1]))


def masked_crop(original, polygon):
    """Return the only image allowed to reach an OCR engine, and its position."""
    x, y, w, h = cv2.boundingRect(np.asarray(polygon, dtype=np.int32))
    interior = polygon_mask((h, w), [[px - x, py - y] for px, py in polygon])
    pixels = np.array(original.crop((x, y, x + w, y + h)).convert("RGB"))
    gray = cv2.cvtColor(pixels, cv2.COLOR_RGB2GRAY)
    # A connected ink stroke cut by the selection can be incomplete lettering.
    # Exclude the entire bubble from OCR if ink reaches its immediate edge.
    inner = cv2.erode(np.pad(interior, 2), np.ones((5, 5), np.uint8))[2:-2, 2:-2]
    crossing = bool(np.any((gray < 145) & (interior > 0) & (inner == 0)))
    pixels[interior == 0] = 255
    return Image.fromarray(pixels), (x, y), crossing
