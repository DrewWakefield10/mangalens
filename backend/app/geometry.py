"""Conservative, deterministic bubble interiors and text component proposals.

These are geometric candidates, not a semantic detector. Recognition must confirm
them; uncertain or open bubbles remain available for manual selection.
"""

import cv2
import numpy as np


def rect_mask(shape, box):
    mask = np.zeros(shape[:2], np.uint8)
    x, y, w, h = map(int, box)
    left, top = max(0, x), max(0, y)
    right, bottom = min(shape[1], x + w), min(shape[0], y + h)
    if w > 0 and h > 0 and right > left and bottom > top:
        mask[top:bottom, left:right] = 255
    return mask


def polygon_mask(shape, polygon, padding=0):
    mask = np.zeros(shape[:2], np.uint8)
    if polygon:
        cv2.fillPoly(mask, [np.array(polygon, np.int32)], 255)
    if padding:
        k = padding * 2 + 1
        mask = cv2.erode(mask, np.ones((k, k), np.uint8))
    return mask


def bounds(mask):
    points = cv2.findNonZero(mask)
    return list(cv2.boundingRect(points)) if points is not None else [0, 0, 0, 0]


def overlap(a, b):
    x, y = max(a[0], b[0]), max(a[1], b[1])
    right, bottom = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    return (
        max(0, right - x) * max(0, bottom - y) / max(1, min(a[2] * a[3], b[2] * b[3]))
    )


def text_components(gray, interior):
    """Exclude border-connected ink and large illustrations, retain small strokes."""
    safe = cv2.erode(interior, np.ones((5, 5), np.uint8))
    ink = ((gray < 185) & (safe > 0)).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(ink, 8)
    _, _, bw, bh = bounds(interior)
    selected = np.zeros_like(gray)
    boxes = []
    rejected = np.zeros_like(gray)
    for i in range(1, n):
        x, y, w, h, area = map(int, stats[i])
        # Text components on 850px manga pages are usually 3-25px across.
        if (
            3 <= area
            and 1 <= w <= max(32, bw * 0.35)
            and 1 <= h <= max(36, bh * 0.25)
            and max(w / h, h / w) < 30
        ):
            selected[labels == i] = 255
            boxes.append([x, y, w, h])
        elif area > 15:
            rejected[labels == i] = 255
    # Small disconnected features inside an illustration (eyes, mouth) must not
    # become text merely because they have character-sized components.
    n, _, stats, _ = cv2.connectedComponentsWithStats(
        (rejected > 0).astype(np.uint8), 8
    )
    for x, y, w, h, area in stats[1:]:
        if area > 80 and w > 25 and h > 25:
            selected[max(0, y - 2) : y + h + 2, max(0, x - 2) : x + w + 2] = 0
    boxes = [
        b for b in boxes if np.any(selected[b[1] : b[1] + b[3], b[0] : b[0] + b[2]])
    ]
    return selected, boxes, rejected


def detect_bubbles(image, evidence=None):
    gray = cv2.cvtColor(np.asarray(image.convert("RGB")), cv2.COLOR_RGB2GRAY)
    candidates = []
    # Separate light connected components handle ovals, rectangles and irregular
    # enclosed shapes without treating a bounding rectangle as their interior.
    for threshold in (210, 180):
        white = cv2.morphologyEx(
            (gray > threshold).astype(np.uint8),
            cv2.MORPH_OPEN,
            np.ones((3, 3), np.uint8),
        )
        n, labels, stats, _ = cv2.connectedComponentsWithStats(white, 8)
        for i in range(1, n):
            x, y, w, h, area = map(int, stats[i])
            if not (
                600 < area < gray.size * 0.4
                and min(w, h) > 25
                and area / (w * h) > 0.38
            ):
                continue
            if x == 0 or y == 0 or x + w >= image.width or y + h >= image.height:
                continue
            if any(overlap([x, y, w, h], c["box"]) > 0.85 for c in candidates):
                continue
            component = (labels[y : y + h, x : x + w] == i).astype(np.uint8)
            contours, _ = cv2.findContours(
                component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
            )
            contour = max(contours, key=cv2.contourArea) + np.array([[[x, y]]])
            contour_area = cv2.contourArea(contour)
            if (
                contour_area / max(1, cv2.contourArea(cv2.convexHull(contour))) < 0.85
                or cv2.arcLength(contour, True) ** 2 / max(1, contour_area) > 32
            ):
                continue
            polygon = cv2.approxPolyDP(contour, 1.0, True).reshape(-1, 2).tolist()
            interior = polygon_mask(gray.shape, polygon)
            ink, boxes, rejected = text_components(gray, interior)
            corroborated_short_text = any(
                len(item.get("source_text", "").strip()) >= 2
                and overlap([x, y, w, h], item["box"]) >= 0.65
                and any("\u3000" <= char <= "\u9fff" for char in item["source_text"])
                for item in (evidence or [])
            )
            minimum_boxes = 2 if corroborated_short_text else 4
            minimum_ink = 20 if corroborated_short_text else 45
            if len(boxes) < minimum_boxes or np.count_nonzero(ink) < minimum_ink:
                continue
            # Reject faces, clothes and fragments: useful text must occupy several
            # small disconnected components, with limited non-text ink nearby.
            if np.count_nonzero(rejected) > area * 0.25:
                continue
            text_box = bounds(ink)
            tx, ty, tw, th = text_box
            if tw < 5 or th < 10:
                continue
            candidates.append(
                {
                    "box": [x, y, w, h],
                    "polygon": polygon,
                    "text_box": text_box,
                    "words": boxes,
                    "detection_confidence": 0.65,
                }
            )
    return sorted(candidates, key=lambda c: (c["box"][1] // 120, -c["box"][0]))[:80]
