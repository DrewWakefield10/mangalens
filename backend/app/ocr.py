import os
import re
import shutil
import time
from collections import Counter, defaultdict
from pathlib import Path
import pytesseract
from PIL import Image
from .config import settings
import cv2
import numpy as np
from difflib import SequenceMatcher
from .geometry import detect_bubbles, overlap, polygon_mask, bounds
from . import manga_recognition

LANGUAGES = {
    "ja": "jpn",
    "ko": "kor",
    "zh-CN": "chi_sim",
    "zh-TW": "chi_tra",
    "ru": "rus",
    "en": "eng",
}
if settings.tesseract_cmd:
    pytesseract.pytesseract.tesseract_cmd = settings.tesseract_cmd
elif (
    not shutil.which("tesseract")
    and Path("C:/Program Files/Tesseract-OCR/tesseract.exe").exists()
):
    pytesseract.pytesseract.tesseract_cmd = (
        "C:/Program Files/Tesseract-OCR/tesseract.exe"
    )


def config():
    folder = settings.model_dir / "tessdata"
    # Environment avoids Windows subprocess quoting bugs for paths with spaces.
    if folder.exists():
        os.environ["TESSDATA_PREFIX"] = str(folder)
    return ""


def installed():
    try:
        return pytesseract.get_languages(config=config())
    except Exception:
        return []


def identify(text):
    # Script evidence in an interjection is not reliable language identification.
    short = sum(c.isalnum() for c in text) < 3
    if re.search("[\u3040-\u30ff]", text):
        return "ja", 0.55 if short else 0.9
    if re.search("[\uac00-\ud7af]", text):
        return "ko", 0.55 if short else 0.9
    if re.search("[\u0400-\u04ff]", text):
        return "ru", 0.9
    if re.search("[\u4e00-\u9fff]", text):
        # Variant-specific characters are clues, not proof: Han-only Japanese
        # names and text shared by both Chinese scripts stay ambiguous.
        if re.search("[\u6c23\u9ad4\u66f8\u9580\u8eca\u570b\u6703]", text):
            return "zh-TW", 0.65
        if re.search("[\u6c14\u4f53\u4e66\u95e8\u8f66\u56fd\u4f1a]", text):
            return "zh-CN", 0.65
        return "zh-CN", 0.45
    return "en", 0.6


def _languages(source):
    available = installed()
    if source == "auto":
        # Run orientations separately; mixing horizontal and vertical models in
        # one automatic layout pass does not establish column reading order.
        langs = [v for v in LANGUAGES.values() if v in available]
    elif source in LANGUAGES:
        langs = [LANGUAGES[source]]
    else:
        raise ValueError("This source language is not configured for OCR.")
    if not langs or any(v not in available for v in langs):
        raise ValueError("OCR model unavailable. Run scripts/setup_models.py.")
    return "+".join(langs), available


def _attempt(image, lang, psm, name, diagnostics, offset=(0, 0), scale=1):
    try:
        data = pytesseract.image_to_data(
            image,
            lang=lang,
            config=config() + f" --psm {psm}",
            output_type=pytesseract.Output.DICT,
            timeout=25,
        )
    except RuntimeError:
        diagnostics.append({"attempt": name, "result": "timeout or engine error"})
        return []
    groups = defaultdict(list)
    for i, text in enumerate(data["text"]):
        if not text.strip() or float(data["conf"][i]) < 0:
            continue
        x, y, w, h = [
            int(data[k][i]) / scale for k in ("left", "top", "width", "height")
        ]
        groups[data["block_num"][i]].append(
            {
                "text": text.strip(),
                "box": [
                    round(x + offset[0]),
                    round(y + offset[1]),
                    max(1, round(w)),
                    max(1, round(h)),
                ],
                "confidence": float(data["conf"][i]) / 100,
            }
        )
    results = []
    for words in groups.values():
        x = min(t["box"][0] for t in words)
        y = min(t["box"][1] for t in words)
        right = max(t["box"][0] + t["box"][2] for t in words)
        bottom = max(t["box"][1] + t["box"][3] for t in words)
        text = " ".join(t["text"] for t in words)
        text = re.sub(r"(?<=[\u3000-\u9fff])\s+(?=[\u3000-\u9fff])", "", text)
        results.append(
            {
                "box": [x, y, right - x, bottom - y],
                "words": [t["box"] for t in words],
                "source_text": text,
                "confidence": sum(t["confidence"] * len(t["text"]) for t in words)
                / sum(len(t["text"]) for t in words),
            }
        )
    diagnostics.append(
        {"attempt": name, "regions": len(results), "model": lang, "psm": psm}
    )
    return results


def _score(result):
    text = result["source_text"]
    meaningful = sum(c.isalnum() for c in text)
    return result["confidence"] * min(1, meaningful / 4)


def _crop_attempt(image, lang, psm, name, diagnostics, offset, scale):
    """One selected bubble can contain several OCR blocks; keep all of them."""
    blocks = _attempt(image, lang, psm, name, diagnostics, offset, scale)
    if len(blocks) < 2:
        return blocks
    blocks.sort(key=lambda b: (-b["box"][0], b["box"][1]) if psm == 5
                else (b["box"][1], b["box"][0]))
    left = min(b["box"][0] for b in blocks)
    top = min(b["box"][1] for b in blocks)
    right = max(b["box"][0] + b["box"][2] for b in blocks)
    bottom = max(b["box"][1] + b["box"][3] for b in blocks)
    length = sum(len(b["source_text"]) for b in blocks)
    return [{"source_text": "\n".join(b["source_text"] for b in blocks),
             "box": [left, top, right - left, bottom - top],
             "words": [w for b in blocks for w in b["words"]],
             "confidence": sum(b["confidence"] * len(b["source_text"]) for b in blocks) / max(1, length)}]


def recognize_selection(image, box, source="ja", diagnostics=None, manga=True):
    diagnostics = diagnostics if diagnostics is not None else []
    lang, available = _languages(source)
    x, y, w, h = box
    right, bottom = min(image.width, x + w), min(image.height, y + h)
    x, y = max(0, x), max(0, y)
    w, h = right - x, bottom - y
    if w <= 0 or h <= 0:
        raise ValueError("OCR selection is outside the image.")
    box = [x, y, w, h]
    crop = image.crop((x, y, x + w, y + h))
    scale = min(3, max(1, 420 / max(w, h)))
    enlarged = crop.resize(
        (round(w * scale), round(h * scale)), Image.Resampling.LANCZOS
    )
    choices = []
    vertical = []
    if source in ("ja", "auto") and "jpn_vert" in available:
        vertical = _crop_attempt(
            enlarged, "jpn_vert", 5, "vertical crop", diagnostics, (x, y), scale
        )
        choices.extend(vertical)
    horizontal = _crop_attempt(enlarged, lang, 6, "horizontal crop", diagnostics, (x, y), scale)
    choices.extend(horizontal)
    best = (
        max(choices, key=_score)
        if choices
        else {"source_text": "", "confidence": 0, "words": [], "box": box}
    )
    # A confidence score cannot compare different reading orders. Tall/square
    # Japanese crops use vertical column order when that model found text.
    hangul_horizontal = source == "auto" and horizontal and re.search(r"[\uac00-\ud7af]", horizontal[0]["source_text"])
    if hangul_horizontal:
        best = horizontal[0]
    if vertical and not hangul_horizontal and h > w * 0.8 and _score(max(vertical, key=_score)) > 0.35:
        best = max(vertical, key=_score)
    # A block-layout pass can invent a second line in a short Hangul crop.
    # Retry only wide, single-band crops, retaining page-coordinate mapping.
    if source != "ja" and w > h * 3 and _score(best) < 0.9:
        rows = np.flatnonzero((np.asarray(crop.convert("L")) < 185).sum(axis=1) > 2)
        if len(rows) and (len(rows) == 1 or np.max(np.diff(rows)) <= max(3, h * 0.15)):
            single = _crop_attempt(enlarged, lang, 7, "single-line crop fallback", diagnostics, (x, y), scale)
            choices.extend(single)
            if single and _score(single[0]) > _score(best) + 0.03:
                best = single[0]
    if _score(best) < 0.65:
        gray = np.asarray(enlarged.convert("L"))
        enhanced = cv2.createCLAHE(clipLimit=1.5, tileGridSize=(8, 8)).apply(gray)
        choices.extend(
            _crop_attempt(
                Image.fromarray(enhanced),
                (
                    "jpn_vert"
                    if source in ("ja", "auto") and "jpn_vert" in available
                    else lang
                ),
                5 if source in ("ja", "auto") else 6,
                "contrast crop fallback",
                diagnostics,
                (x, y),
                scale,
            )
        )
        best = max(choices, key=_score) if choices else best
    # Only invoke the generative recognizer when independent OCR sees Japanese.
    # It can hallucinate dialogue on artwork, so geometry alone is insufficient.
    if (
        source in ("ja", "auto")
        and manga
        and manga_recognition.available()
        and re.search("[\u3040-\u30ff\u4e00-\u9fff]", best["source_text"])
    ):
        try:
            text = manga_recognition.recognize_crop(crop)
            agreement = SequenceMatcher(
                None, re.sub(r"\W", "", best["source_text"]), re.sub(r"\W", "", text)
            ).ratio()
            diagnostics.append(
                {
                    "attempt": "manga crop",
                    "result": "recognized",
                    "agreement": round(agreement, 3),
                }
            )
            best = {
                **best,
                "source_text": text,
                "manga_agreement": agreement,
                "engine": "manga-ocr",
            }
        except Exception:
            diagnostics.append(
                {
                    "attempt": "manga crop",
                    "result": "unavailable; Tesseract result retained",
                }
            )
    return best


def recognize(
    image, source="auto", direction="rtl", quality="balanced", diagnostics=None,
    cloud_regions=None,
):
    diagnostics = diagnostics if diagnostics is not None else []
    lang, available = _languages(source)
    started = time.monotonic()
    scale = min(1, 2400 / max(image.size))
    primary_image = (
        image.resize(
            (round(image.width * scale), round(image.height * scale)),
            Image.Resampling.LANCZOS,
        )
        if scale < 1
        else image
    )
    primary = _attempt(primary_image, lang, 3, "primary page", diagnostics, scale=scale)
    bubbles = detect_bubbles(image, cloud_regions)
    diagnostics.append(
        {"attempt": "bubble component detector", "candidates": len(bubbles)}
    )
    results = []
    for candidate in bubbles[:40]:
        if time.monotonic() - started > (240 if quality == "quality" else 120 if quality == "balanced" else 60):
            diagnostics.append(
                {
                    "attempt": "crop budget",
                    "result": "time limit; remaining candidates need manual review",
                }
            )
            break
        # Recognize a tight text crop, not an entire bubble containing a portrait.
        tx, ty, tw, th = candidate["text_box"]
        left, top = max(0, tx - 3), max(0, ty - 3)
        crop_box = [left, top, min(image.width, tx + tw + 3) - left,
                    min(image.height, ty + th + 3) - top]
        result = recognize_selection(image, crop_box, source, diagnostics, manga=quality != "fast")
        # Unconfirmed shape proposals are not allowed to erase artwork.
        uncertain = (
            _score(result) < 0.25 or len(re.sub(r"\W", "", result["source_text"])) < 2
        )
        if uncertain:
            result = {**result, "source_text": "", "confidence": 0}
        result.update(box=candidate["box"], words=candidate["words"])
        result["render"] = {
            "bubble_polygon": candidate["polygon"],
            "source_box": candidate["text_box"],
            "detection_confidence": candidate["detection_confidence"],
            "bubble_confidence": 0.65,
            "ocr_engine": result.pop("engine", "tesseract"),
            "pipeline_version": 2,
            "ocr_uncertain": uncertain,
        }
        if "manga_agreement" in result:
            result["render"]["ocr_agreement"] = result.pop("manga_agreement")
        results.append(result)

    # Cloud OCR supplies independent text locations. Keep local bubble geometry
    # for safe cleanup; direct-on-art text stays review-only.
    if cloud_regions:
        grouped = defaultdict(list)
        for region in cloud_regions:
            center = (region["box"][0] + region["box"][2] / 2,
                      region["box"][1] + region["box"][3] / 2)
            bubble_index = next(
                (i for i, bubble in enumerate(bubbles[:40])
                 if bubble["box"][0] <= center[0] <= bubble["box"][0] + bubble["box"][2]
                 and bubble["box"][1] <= center[1] <= bubble["box"][1] + bubble["box"][3]),
                None,
            )
            grouped[bubble_index if bubble_index is not None else id(region)].append(region)
        for key, paragraphs in grouped.items():
            paragraphs.sort(key=lambda p: (-p["box"][0], p["box"][1]) if direction == "rtl" else (p["box"][1], p["box"][0]))
            x = min(p["box"][0] for p in paragraphs)
            y = min(p["box"][1] for p in paragraphs)
            right = max(p["box"][0] + p["box"][2] for p in paragraphs)
            bottom = max(p["box"][1] + p["box"][3] for p in paragraphs)
            cloud_confidence_available = all(p.get("ocr_confidence_available", True) for p in paragraphs)
            cloud = {
                "box": [x, y, right - x, bottom - y],
                "words": [word for p in paragraphs for word in p["words"]],
                "source_text": "\n".join(p["source_text"] for p in paragraphs),
                "confidence": sum(p["confidence"] for p in paragraphs) / len(paragraphs) if cloud_confidence_available else 0.0,
            }
            best_language = max(paragraphs, key=lambda p: p["cloud_language_confidence"])
            provider = paragraphs[0].get("ocr_provider", "google_vision")
            engine = paragraphs[0].get("ocr_engine", "google_vision")
            polygon = bubbles[key]["polygon"] if isinstance(key, int) and key < len(bubbles) else None
            if polygon:
                cloud["box"] = bubbles[key]["box"]
            cloud["render"] = {
                "source_box": [x, y, right - x, bottom - y],
                "bubble_polygon": polygon,
                "pipeline_version": 2,
                "detection_confidence": 0.8,
                "bubble_confidence": 0.65 if polygon else 0,
                "ocr_engine": f"ocr_space_{engine}" if provider == "ocr_space" else "google_vision",
                "ocr_provider": provider,
                "ocr_confidence_available": cloud_confidence_available,
                "cloud_language": best_language["cloud_language"],
                "cloud_language_confidence": best_language["cloud_language_confidence"],
            }
            existing = next((r for r in results if overlap(cloud["box"], r["box"]) > 0.15), None)
            if existing:
                alternatives = existing["render"].setdefault("ocr_alternatives", [])
                if cloud["source_text"] != existing["source_text"] and cloud["source_text"] not in alternatives:
                    alternatives.append(cloud["source_text"])
                # A separate pronoun in furigana can change a proper name's
                # meaning even when both OCR engines agree on the main kanji.
                # Keep it as a translation-review signal, not source text.
                if re.search(r"(?:\u30a2\u30a4\u30c4|\u30b3\u30a4\u30c4|\u30bd\u30a4\u30c4|\u3042\u3044\u3064|\u3053\u3044\u3064|\u305d\u3044\u3064)", cloud["source_text"]) and not re.search(r"(?:\u30a2\u30a4\u30c4|\u30b3\u30a4\u30c4|\u30bd\u30a4\u30c4|\u3042\u3044\u3064|\u3053\u3044\u3064|\u305d\u3044\u3064)", existing["source_text"]):
                    existing["render"]["ocr_semantic_ambiguity"] = True
                local_chars = re.sub(r"\W", "", existing["source_text"])
                cloud_chars = re.sub(r"\W", "", cloud["source_text"])
                # Engine 3 can report Japanese vertical columns in reverse
                # order. Compare both sequence and character evidence; retain
                # the actual alternatives for a human to review.
                char_agreement = sum((Counter(local_chars) & Counter(cloud_chars)).values()) / max(1, len(local_chars), len(cloud_chars))
                agreement = max(SequenceMatcher(None, local_chars, cloud_chars).ratio(), char_agreement)
                if (
                    provider == "ocr_space"
                    and existing["render"].get("ocr_engine") == "manga-ocr"
                    and polygon
                    and min(len(local_chars), len(cloud_chars)) >= 2
                    and (
                        char_agreement >= 0.78
                        or (
                            len(local_chars) >= 5
                            and sum((Counter(local_chars) & Counter(cloud_chars)).values()) / max(1, len(local_chars)) >= 0.9
                            and min(len(local_chars), len(cloud_chars)) / max(len(local_chars), len(cloud_chars)) >= 0.6
                        )
                    )
                ):
                    existing["render"]["ocr_corroborated"] = True
                    existing["render"]["ocr_cloud_agreement"] = round(char_agreement, 3)
                if cloud_confidence_available and (not existing["source_text"].strip() or _score(existing) < _score(cloud) * 0.75):
                    existing.update({field: cloud[field] for field in ("source_text", "confidence", "words")})
                    existing["render"].update({field: cloud["render"][field] for field in ("source_box", "ocr_engine", "ocr_provider", "ocr_confidence_available", "cloud_language", "cloud_language_confidence")})
                elif not cloud_confidence_available and (not existing["source_text"].strip() or (_score(existing) < 0.45 and len(cloud["source_text"]) > len(existing["source_text"]))):
                    existing.update({field: cloud[field] for field in ("source_text", "confidence", "words")})
                    existing["render"].update({field: cloud["render"][field] for field in ("source_box", "ocr_engine", "ocr_provider", "ocr_confidence_available", "cloud_language", "cloud_language_confidence")})
                elif not cloud_confidence_available and agreement < 0.55:
                    existing["render"]["ocr_cloud_disagreement"] = True
            else:
                results.append(cloud)
        diagnostics.append({"attempt": "cloud OCR merge", "regions": len(cloud_regions), "groups": len(grouped)})

    def merge(items):
        for item in items:
            if _score(item) < 0.25 or not re.search(r"\w", item["source_text"]):
                continue
            # Drop broad blocks spanning several bubbles, instead of allowing
            # a second region to paint across successful bubble replacements.
            if any(overlap(item["box"], r["box"]) > 0.15 for r in results):
                continue
            item["render"] = {
                "source_box": item["box"],
                "pipeline_version": 2,
                "detection_confidence": 0.45,
                "bubble_confidence": 0,
                "ocr_engine": "tesseract",
            }
            results.append(item)

    merge(primary)
    if quality != "fast" and (not results or any(r["confidence"] < 0.65 for r in results)):
        gray = np.asarray(image.convert("L"))
        threshold = cv2.adaptiveThreshold(
            gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 12
        )
        merge(
            _attempt(
                Image.fromarray(threshold),
                lang,
                11,
                "adaptive sparse fallback",
                diagnostics,
            )
        )
    if quality != "fast" and (not results or max(image.size) > 2200):
        # Bounded overlapping tiles, mapping every box back to original pixels.
        attempts = 0
        for y in range(0, image.height, 900):
            for x in range(0, image.width, 900):
                crop = image.crop(
                    (x, y, min(x + 1100, image.width), min(y + 1100, image.height))
                )
                merge(
                    _attempt(
                        crop, lang, 11, "overlapping tile fallback", diagnostics, (x, y)
                    )
                )
                attempts += 1
                if attempts >= 12:
                    break
            if attempts >= 12:
                break
    for r in results:
        detected, confidence = identify(r["source_text"])
        cloud_language = r["render"].get("cloud_language", "")
        cloud_confidence = r["render"].get("cloud_language_confidence", 0)
        if cloud_language and cloud_confidence >= 0.75:
            code = cloud_language.lower()
            detected = (
                "zh-TW" if code.startswith("zh-hant")
                else "zh-CN" if code.startswith("zh")
                else code.split("-")[0]
            )
            confidence = cloud_confidence
        r["language"] = source if source != "auto" else detected
        r["render"]["language_confidence"] = 1.0 if source != "auto" else confidence
        r["render"]["language_uncertain"] = source == "auto" and confidence < 0.75
        r["orientation"] = "vertical" if r["language"] == "ja" else "horizontal"
        r["warnings"] = []
        if r["render"]["language_uncertain"] and r["source_text"].strip():
            r["warnings"].append("Source language is uncertain; select a language before offline translation.")
        if not r["render"].get("ocr_confidence_available", True) and not r["render"].get("ocr_corroborated"):
            r["warnings"].append("OCR.space does not report confidence; verify source text.")
        elif r["confidence"] < settings.ocr_min_confidence and not r["render"].get("ocr_corroborated"):
            r["warnings"].append("Low OCR confidence; verify source text.")
        if r["render"].get("ocr_cloud_disagreement"):
            r["warnings"].append("OCR readings disagree; verify source text and alternatives.")
        if r["render"].get("ocr_semantic_ambiguity"):
            r["warnings"].append("OCR alternative includes a separate pronoun; verify the translation and any character name.")
        if r["render"].get("ocr_uncertain"):
            r["warnings"].append(
                "Automatic recognition is uncertain; enter source text or retry this region."
            )
        if r["render"].get("ocr_agreement", 1) < settings.ocr_min_agreement and not r["render"].get("ocr_corroborated"):
            r["warnings"].append("OCR models disagree; verify source text.")
        if not r["render"].get("bubble_polygon"):
            r["warnings"].append(
                "Bubble boundary uncertain; verify the selected text area."
            )
        r["render"]["state"] = "ocr_completed"
    results.sort(
        key=lambda r: (
            r["box"][1] // 160,
            -r["box"][0] if direction == "rtl" else r["box"][0],
            r["box"][1],
        )
    )
    diagnostics.append(
        {
            "attempt": "summary",
            "regions": len(results),
            "coverage": "unverified; inspect for missed dialogue",
        }
    )
    return results
