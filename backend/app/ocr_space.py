"""OCR.space free API adapter. It never calls a PRO endpoint."""

from dataclasses import dataclass
from datetime import datetime, timezone
from difflib import SequenceMatcher
from io import BytesIO
import time

import httpx
from PIL import Image
from sqlalchemy import select

from .config import settings
from .db import UsageEvent
from .budgets import locked_budget


ENDPOINT = "https://api.ocr.space/parse/image"
MAX_UPLOAD_BYTES = 1_000_000  # Documented free-plan file limit.
LANGUAGE_CODES = {
    "ja": "jpn", "ko": "kor", "zh-CN": "chs", "zh-TW": "cht",
    "en": "eng", "ru": "rus",
}


class OCRSpaceError(ValueError):
    def __init__(self, message, status="failed"):
        super().__init__(message)
        self.status = status


@dataclass
class Tile:
    image: bytes
    x: int
    y: int
    width: int
    height: int


def engine_for(source):
    # Engine 2 documents Latin and Chinese support. Engine 3 covers Japanese,
    # Korean, and automatic detection and has a separate free monthly quota.
    return 2 if source in ("zh-CN", "zh-TW", "en", "ru") else 3


def language_for(source, engine):
    if source == "auto":
        return "auto"
    return LANGUAGE_CODES.get(source, "auto")


def reserve_request(db, owner, engine, page_requests):
    """Reserve every free API attempt before sending its image."""
    with locked_budget(db, "ocr_space"):
        return _reserve_locked(db, owner, engine, page_requests)


def _reserve_locked(db, owner, engine, page_requests):
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    events = db.scalars(select(UsageEvent).where(
        UsageEvent.provider.in_(("ocr_space_2", "ocr_space_3")),
        UsageEvent.created >= month_start,
    )).all()
    daily = sum(event.created >= day_start for event in events)
    engine3 = sum(event.provider == "ocr_space_3" for event in events)
    if (page_requests >= settings.ocr_space_page_request_budget
            or daily >= settings.ocr_space_daily_request_budget
            or len(events) >= settings.ocr_space_monthly_request_budget
            or (engine == 3 and engine3 >= settings.ocr_space_engine3_monthly_budget)):
        raise OCRSpaceError("Local OCR.space free-request budget reached; local OCR will continue.", "budget")
    event = UsageEvent(owner=owner, provider=f"ocr_space_{engine}", kind="ocr", status="attempted")
    db.add(event)
    db.flush()
    return event.id


def finish_request(db, event_id, status):
    event = db.get(UsageEvent, event_id)
    event.status = status
    db.commit()


def _jpeg(image, quality):
    stream = BytesIO()
    image.convert("RGB").save(stream, format="JPEG", quality=quality, optimize=True)
    return stream.getvalue()


def prepare_tiles(image):
    """Preserve readable pixels; tile before compressing a whole page too far."""
    whole = _jpeg(image, 90)
    if len(whole) <= MAX_UPLOAD_BYTES:
        return [Tile(whole, 0, 0, image.width, image.height)]
    tiles = []
    stride = 1400
    for y in range(0, image.height, stride):
        for x in range(0, image.width, stride):
            right, bottom = min(image.width, x + 1500), min(image.height, y + 1500)
            crop = image.crop((x, y, right, bottom))
            encoded = _jpeg(crop, 90)
            if len(encoded) > MAX_UPLOAD_BYTES:
                encoded = _jpeg(crop, 80)
            if len(encoded) > MAX_UPLOAD_BYTES:
                # A smaller tile retains more detail than further compression.
                half = max(1, (bottom - y) // 2)
                for top in (0, half):
                    part = crop.crop((0, top, right - x, min(bottom - y, top + half + 40)))
                    data = _jpeg(part, 85)
                    if len(data) > MAX_UPLOAD_BYTES:
                        raise OCRSpaceError("This page needs smaller OCR tiles; local OCR will continue.")
                    tiles.append(Tile(data, x, y + top, part.width, part.height))
            else:
                tiles.append(Tile(encoded, x, y, crop.width, crop.height))
    return tiles


def parse_response(payload, tile, source, engine):
    """Use only actual word coordinates; OCR.space does not return confidence."""
    try:
        exit_code = int(payload.get("OCRExitCode", 0))
    except (TypeError, ValueError):
        exit_code = 0
    if payload.get("IsErroredOnProcessing") or exit_code not in (1, 2):
        raise OCRSpaceError("OCR.space could not read this image; local OCR will continue.")
    regions = []
    for page in payload.get("ParsedResults") or []:
        try:
            page_exit = int(page.get("FileParseExitCode", 0))
        except (TypeError, ValueError):
            page_exit = 0
        if page_exit != 1:
            continue
        overlay = (page.get("TextOverlay") or {}).get("Lines") or []
        for line in overlay:
            words = []
            text_words = []
            for word in line.get("Words") or []:
                text = str(word.get("WordText") or "").strip()
                try:
                    left, top = int(word["Left"]), int(word["Top"])
                    w, h = int(word["Width"]), int(word["Height"])
                    right, bottom = min(tile.width, left + w), min(tile.height, top + h)
                    left, top = max(0, left), max(0, top)
                    x, y = left + tile.x, top + tile.y
                    w, h = right - left, bottom - top
                except (KeyError, TypeError, ValueError):
                    continue
                if text and w > 0 and h > 0 and x >= 0 and y >= 0:
                    words.append([x, y, w, h])
                    text_words.append(text)
            if not words:
                continue
            x = min(box[0] for box in words)
            y = min(box[1] for box in words)
            right = max(box[0] + box[2] for box in words)
            bottom = max(box[1] + box[3] for box in words)
            text = str(line.get("LineText") or "").strip() or (
                "" if source in ("ja", "zh-CN", "zh-TW") else " "
            ).join(text_words)
            if text:
                regions.append({
                    "box": [x, y, right - x, bottom - y],
                    "words": words,
                    "source_text": text,
                    "confidence": 0.0,  # Internal safety gate; provider returned none.
                    "cloud_language": source if source != "auto" else "",
                    "cloud_language_confidence": 0.0,
                    "ocr_provider": "ocr_space",
                    "ocr_engine": engine,
                    "ocr_confidence_available": False,
                })
    return regions


def deduplicate(regions):
    kept = []
    for region in regions:
        match = next((item for item in kept if
            _overlap(region["box"], item["box"]) > 0.6 and
            SequenceMatcher(None, region["source_text"], item["source_text"]).ratio() > 0.65
        ), None)
        if match is None:
            kept.append(region)
        elif len(region["source_text"]) > len(match["source_text"]):
            match.update(region)
    return kept


def _overlap(a, b):
    x = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    y = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    return x * y / max(1, min(a[2] * a[3], b[2] * b[3]))


def recognize_tile(tile, source, engine, before_request, after_request):
    if not settings.ocr_space_api_key:
        raise OCRSpaceError("OCR.space is not configured.")
    data = {
        "language": language_for(source, engine),
        "OCREngine": str(engine),
        "isOverlayRequired": "true",
        "scale": "true",
    }
    for attempt in range(2):
        token = before_request(engine)
        status = "failed"
        try:
            with httpx.Client(timeout=75, follow_redirects=False) as client:
                response = client.post(
                    ENDPOINT,
                    headers={"apikey": settings.ocr_space_api_key},
                    files={"file": ("page.jpg", tile.image, "image/jpeg")},
                    data=data,
                )
            if response.status_code in (429, 503):
                status = "rate_limited"
                raise OCRSpaceError("OCR.space free endpoint is throttled; local OCR will continue.", "overloaded" if response.status_code == 503 else status)
            if response.status_code in (401, 403):
                raise OCRSpaceError("OCR.space rejected the API key; local OCR will continue.")
            if response.status_code in (500, 502, 504) and attempt == 0:
                continue
            if response.status_code != 200:
                raise OCRSpaceError("OCR.space is unavailable; local OCR will continue.")
            try:
                payload = response.json()
            except ValueError:
                raise OCRSpaceError("OCR.space returned an invalid response; local OCR will continue.") from None
            message = str(payload.get("ErrorMessage") or "").lower()
            if any(term in message for term in ("limit", "quota", "throttle", "exceed")):
                status = "rate_limited"
                raise OCRSpaceError("OCR.space free quota or rate limit was reached; local OCR will continue.", status)
            if any(term in message for term in ("apikey", "api key", "invalid key")):
                raise OCRSpaceError("OCR.space rejected the API key; local OCR will continue.")
            regions = parse_response(payload, tile, source, engine)
            status = "completed"
            return regions
        except httpx.HTTPError:
            if attempt == 0:
                time.sleep(1)
                continue
            raise OCRSpaceError("OCR.space is unreachable; local OCR will continue.") from None
        finally:
            after_request(token, status)
    raise OCRSpaceError("OCR.space is unavailable; local OCR will continue.")


def recognize(image, source, before_request, after_request, diagnostics=None):
    diagnostics = diagnostics if diagnostics is not None else []
    tiles = prepare_tiles(image)
    engine = engine_for(source)
    regions = []
    for tile in tiles:
        try:
            regions.extend(recognize_tile(tile, source, engine, before_request, after_request))
        except OCRSpaceError as exc:
            diagnostics.append({"attempt": "OCR.space", "result": str(exc), "engine": engine})
            if exc.status in ("rate_limited", "budget"):
                break
            if engine == 2 and settings.ocr_space_engine3_fallback:
                try:
                    regions.extend(recognize_tile(tile, source, 3, before_request, after_request))
                    diagnostics.append({"attempt": "OCR.space fallback", "engine": 3, "result": "completed"})
                except OCRSpaceError as fallback_error:
                    diagnostics.append({"attempt": "OCR.space fallback", "engine": 3, "result": str(fallback_error)})
                    if fallback_error.status in ("rate_limited", "budget"):
                        break
    regions = deduplicate(regions)
    diagnostics.append({"attempt": "OCR.space", "engine": engine, "tiles": len(tiles), "regions": len(regions)})
    return regions
