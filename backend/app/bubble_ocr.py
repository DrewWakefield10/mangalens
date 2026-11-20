"""OCR for approved speech bubbles. Every provider receives the masked crop."""

from sqlalchemy import func, select

from .bubbles import VERSION, fingerprint, masked_crop
from .cloud_ocr import CloudOCRError, recognize as cloud_recognize
from .config import settings
from .db import Cache, UsageEvent
from .manga_recognition import available as manga_available
from .ocr import identify, recognize_selection
from .ocr_space import OCRSpaceError, finish_request, recognize as space_recognize, reserve_request
from .translation import month_start


def bubble_ocr(db, page, project, source):
    requests = 0
    available = manga_available()
    models = [(path.name, path.stat().st_mtime_ns)
              for path in sorted(settings.model_dir.glob("tessdata/*.traineddata"))]

    def reserve(engine):
        nonlocal requests
        db.refresh(project)
        if project.cancelled:
            raise InterruptedError("Processing cancelled.")
        event = reserve_request(db, project.owner, engine, requests)
        requests += 1
        return event

    def recognize(original, bubble, retry=False):
        key = fingerprint(project.owner, VERSION, page.digest, bubble["id"], bubble["polygon"], source,
                          project.direction, project.quality, models, available,
                          settings.cloud_ocr_provider, bool(settings.ocr_space_api_key),
                          bool(settings.google_vision_api_key), settings.ocr_min_confidence,
                          settings.ocr_min_agreement)
        cached = db.get(Cache, key)
        if cached and not retry:
            return cached.value
        crop, (x, y), crossing = masked_crop(original, bubble["polygon"])
        options = {"bubble_version": VERSION, "bubble_id": bubble["id"],
                   "bubble_polygon": bubble["polygon"], "classification": "speech_bubble",
                   "boundary_crossing": crossing, "source_box": bubble["box"]}
        attempts = []
        result = {"source_text": "", "confidence": 0, "words": [], "box": [0, 0, *crop.size]}
        if not crossing:
            try:
                result = recognize_selection(crop, [0, 0, *crop.size], source, attempts,
                                             manga=project.quality != "fast")
            except (ValueError, OSError, RuntimeError) as exc:
                attempts.append({"attempt": "local OCR", "result": type(exc).__name__})
            if project.quality == "quality" and result["confidence"] < settings.ocr_min_confidence:
                try:
                    alternatives = []
                    if settings.cloud_ocr_provider == "ocr_space" and settings.ocr_space_api_key:
                        alternatives = space_recognize(
                            crop, source, reserve, lambda event, state: finish_request(db, event, state),
                            attempts,
                        )
                    elif settings.cloud_ocr_provider == "google_vision" and settings.google_vision_api_key:
                        used = db.scalar(select(func.count(UsageEvent.id)).where(
                            UsageEvent.provider == "google_vision", UsageEvent.created >= month_start(),
                        )) or 0
                        if used < settings.cloud_ocr_monthly_request_budget:
                            db.add(UsageEvent(owner=project.owner, provider="google_vision",
                                              kind="ocr", status="attempted"))
                            db.commit()
                            alternatives = cloud_recognize(crop)
                    if alternatives:
                        vertical = source == "ja" and crop.height > crop.width
                        ordered = sorted(alternatives, key=lambda item: (
                            (-item["box"][0], item["box"][1]) if vertical
                            else (item["box"][1], item["box"][0])))
                        options["ocr_cloud_suggestion"] = "\n".join(
                            item["source_text"] for item in ordered if item["source_text"].strip()
                        )
                except (OCRSpaceError, CloudOCRError) as exc:
                    attempts.append({"attempt": "masked cloud OCR", "result": str(exc)})
        language, certainty = identify(result["source_text"])
        if source != "auto":
            language, certainty = source, 1
        words = [[a + x, b + y, w, h] for a, b, w, h in result["words"]]
        if words:
            a, b, w, h = result["box"]
            # A small halo includes antialiased edges while the polygon still
            # clips every candidate cleanup pixel.
            left, top = max(0, a - 3), max(0, b - 3)
            right, bottom = min(crop.width, a + w + 3), min(crop.height, b + h + 3)
            options["source_box"] = [x + left, y + top, right - left, bottom - top]
        agreement = result.get("manga_agreement", 1)
        options.update(language_confidence=certainty, ocr_attempts=attempts,
                       ocr_provider=result.get("engine", "tesseract"), ocr_agreement=agreement,
                       ocr_uncertain=agreement < settings.ocr_min_agreement,
                       ocr_settings=fingerprint(source, project.quality, project.direction))
        value = {"source_text": result["source_text"], "confidence": result["confidence"],
                 "language": language, "words": words, "render": options}
        if result["source_text"].strip() and result["confidence"] >= settings.ocr_min_confidence:
            if cached:
                cached.value = value
            else:
                db.add(Cache(key=key, owner=project.owner, value=value))
        return value

    return recognize
