"""Optional Google Cloud Vision OCR; no image leaves the machine without a key."""

import base64
from io import BytesIO
import time
import httpx
from .config import settings


class CloudOCRError(ValueError):
    pass


def _box(vertices):
    if not vertices:
        return None
    xs = [int(v.get("x", 0)) for v in vertices]
    ys = [int(v.get("y", 0)) for v in vertices]
    return [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]


def parse_vision(response):
    """Keep paragraph boundaries, text coordinates and language diagnostics."""
    result = []
    for page in response.get("fullTextAnnotation", {}).get("pages", []):
        for block in page.get("blocks", []):
            for paragraph in block.get("paragraphs", []):
                words = paragraph.get("words", [])
                text_words = [
                    "".join(s.get("text", "") for s in word.get("symbols", []))
                    for word in words
                ]
                languages = paragraph.get("property", {}).get("detectedLanguages", [])
                language = max(languages, key=lambda item: item.get("confidence", 0)).get("languageCode", "") if languages else ""
                joiner = "" if language.startswith(("ja", "zh")) else " "
                text = joiner.join(w for w in text_words if w).strip()
                box = _box(paragraph.get("boundingBox", {}).get("vertices", []))
                word_boxes = [
                    b for word in words
                    if (b := _box(word.get("boundingBox", {}).get("vertices", [])))
                ]
                if text and box and box[2] > 0 and box[3] > 0:
                    result.append({
                        "box": box,
                        "words": word_boxes,
                        "source_text": text,
                        "confidence": float(paragraph.get("confidence", block.get("confidence", 0.7))),
                        "cloud_language": language,
                        "cloud_language_confidence": max((item.get("confidence", 0) for item in languages), default=0),
                    })
    return result


def recognize(image):
    if not settings.google_vision_api_key:
        raise CloudOCRError("Google Cloud Vision OCR is not configured.")
    buffer = BytesIO()
    image.convert("RGB").save(buffer, format="JPEG", quality=88)
    if buffer.tell() > 10 * 1024 * 1024:
        raise CloudOCRError("Image exceeds the configured cloud OCR upload limit.")
    body = {
        "requests": [{
            "image": {"content": base64.b64encode(buffer.getvalue()).decode("ascii")},
            "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
        }]
    }
    for attempt in range(3):
        try:
            with httpx.Client(timeout=60, follow_redirects=False) as client:
                response = client.post(
                    "https://vision.googleapis.com/v1/images:annotate",
                    headers={"X-goog-api-key": settings.google_vision_api_key},
                    json=body,
                )
        except httpx.HTTPError:
            if attempt == 2:
                raise CloudOCRError("Cloud OCR is unavailable; local OCR will continue.") from None
            time.sleep(2**attempt)
            continue
        if response.status_code in (429, 500, 503) and attempt < 2:
            time.sleep(2**attempt)
            continue
        if response.status_code != 200:
            raise CloudOCRError("Cloud OCR could not process this page; local OCR will continue.")
        try:
            annotation = response.json()["responses"][0]
            if annotation.get("error"):
                raise CloudOCRError("Cloud OCR returned an error; local OCR will continue.")
            return parse_vision(annotation)
        except (KeyError, IndexError, TypeError, ValueError):
            raise CloudOCRError("Cloud OCR returned an invalid response; local OCR will continue.") from None
    raise CloudOCRError("Cloud OCR is unavailable; local OCR will continue.")
