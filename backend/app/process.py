import hashlib
import json
import logging
import re
import sys
import time
from sqlalchemy import func, select
from PIL import Image
from .config import settings
from .db import DB, Cache, Edit, Glossary, Job, Page, Project, Region, UsageEvent
from .ocr import recognize, recognize_selection
from .manga_recognition import available as manga_available
from .geometry import overlap
from .rendering import render_page
from .storage import asset
from .translation import cached_translate, quality_warnings
from .translation import month_start
from .cloud_ocr import recognize as cloud_recognize, CloudOCRError
from .ocr_space import recognize as ocr_space_recognize, OCRSpaceError, reserve_request, finish_request
from .diagnostics import record

log = logging.getLogger("mangalens")


def run(job_id):
    with DB() as db:
        job = db.get(Job, job_id)
        if not job:
            return
        page = db.get(Page, job.page_id)
        project = db.get(Project, page.project_id)
        start = time.monotonic()

        def stage(name):
            db.refresh(project)
            if project.cancelled:
                raise InterruptedError("Processing cancelled.")
            page.status = name
            page.metrics = {
                **page.metrics,
                "current_step": name,
                "elapsed_seconds": round(time.monotonic() - start, 1),
                "regions_detected": len(regions),
                "recognized_regions": sum(bool(r.source_text.strip()) for r in regions),
                "languages": sorted({r.language for r in regions if r.source_text.strip()}),
                "current_provider": project.provider,
            }
            db.commit()

        try:
            with Image.open(asset(project.id, page.id)) as opened:
                original = opened.convert("RGB")
            regions = list(
                db.scalars(
                    select(Region)
                    .where(Region.page_id == page.id)
                    .order_by(Region.position)
                )
            )
            if job.kind in ("translate", "ocr", "ocr_region"):
                ocr_source = page.metrics.get(
                    "ocr_source_override", project.source_lang
                )
                # An upgrade/retry replaces automatic detections only. Existing
                # edit history also protects corrections made before v2.
                preserved = [
                    r
                    for r in regions
                    if (r.render or {}).get("manual")
                    or db.scalar(select(Edit.id).where(Edit.region_id == r.id).limit(1))
                ]
                needs_ocr = job.kind == "ocr" or (
                    job.kind == "translate"
                    and (not regions or page.metrics.get("pipeline_version") != 2)
                )
                if needs_ocr:
                    stage("scanning")
                    ocr_key = hashlib.sha256(
                        json.dumps(
                            [
                                project.owner,
                                "manga-ocr-v4",
                                page.digest,
                                ocr_source,
                                project.direction,
                                project.quality,
                                manga_available(),
                                settings.cloud_ocr_provider,
                                settings.ocr_min_confidence,
                                settings.ocr_min_agreement,
                                bool(settings.ocr_space_api_key),
                                bool(settings.google_vision_api_key),
                                [
                                    (p.name, p.stat().st_mtime_ns, p.stat().st_size)
                                    for p in (settings.model_dir / "manga-ocr").glob(
                                        "provenance.json"
                                    )
                                ],
                                [
                                    (p.name, p.stat().st_mtime_ns)
                                    for p in (settings.model_dir / "tessdata").glob(
                                        "*.traineddata"
                                    )
                                ],
                            ]
                        ).encode()
                    ).hexdigest()
                    cache = db.get(Cache, ocr_key) if job.kind != "ocr" else None
                    diagnostics = []
                    cloud_regions = []
                    if not cache and project.quality == "quality" and settings.cloud_ocr_provider == "ocr_space" and settings.ocr_space_api_key:
                        request_count = 0

                        def before_ocr_space_request(engine):
                            nonlocal request_count
                            db.refresh(project)
                            if project.cancelled:
                                raise InterruptedError("Processing cancelled.")
                            event_id = reserve_request(db, project.owner, engine, request_count)
                            request_count += 1
                            return event_id

                        def after_ocr_space_request(event_id, status):
                            finish_request(db, event_id, status)

                        try:
                            cloud_regions = ocr_space_recognize(
                                original, ocr_source, before_ocr_space_request,
                                after_ocr_space_request, diagnostics,
                            )
                        except OCRSpaceError as exc:
                            diagnostics.append({"attempt": "OCR.space", "result": str(exc)})
                    elif not cache and project.quality == "quality" and settings.cloud_ocr_provider == "google_vision" and settings.google_vision_api_key:
                        cloud_count = db.scalar(
                            select(func.count(UsageEvent.id)).where(
                                UsageEvent.provider == "google_vision",
                                UsageEvent.created >= month_start(),
                            )
                        ) or 0
                        if cloud_count < settings.cloud_ocr_monthly_request_budget:
                            try:
                                cloud_regions = cloud_recognize(original)
                                db.add(UsageEvent(owner=project.owner, provider="google_vision", kind="ocr", status="completed"))
                                db.commit()
                            except CloudOCRError:
                                diagnostics.append({"attempt": "google cloud vision", "result": "unavailable; local OCR continued"})
                                db.add(UsageEvent(owner=project.owner, provider="google_vision", kind="ocr", status="failed"))
                                db.commit()
                        else:
                            diagnostics.append({"attempt": "google cloud vision", "result": "local monthly OCR request budget reached"})
                    stage("recognizing")
                    recognized = (
                        cache.value["regions"]
                        if cache
                        else recognize(
                            original,
                            ocr_source,
                            project.direction,
                            project.quality,
                            diagnostics=diagnostics,
                            cloud_regions=cloud_regions,
                        )
                    )
                    existing_cache = db.get(Cache, ocr_key)
                    cache_value = {
                        "regions": recognized,
                        "attempts": (
                            cache.value.get("attempts", []) if cache else diagnostics
                        ),
                    }
                    if existing_cache:
                        existing_cache.value = cache_value
                    else:
                        db.add(
                            Cache(key=ocr_key, owner=project.owner, value=cache_value)
                        )
                    page.metrics = {
                        **page.metrics,
                        "ocr_attempts": cache_value["attempts"],
                    }
                    old_auto = [r for r in regions if r not in preserved]
                    regions = list(preserved)
                    for index, region in enumerate(recognized):
                        if any(overlap(region["box"], r.box) > 0.15 for r in preserved):
                            continue
                        match = max(old_auto, key=lambda r: overlap(region["box"], r.box), default=None)
                        if match is not None and overlap(region["box"], match.box) >= 0.6:
                            old_auto.remove(match)
                            item = match
                            retry_count = int((item.render or {}).get("ocr_retry_count", 0)) + 1
                            history = list((item.render or {}).get("stage_history", []))
                            for field, value in region.items():
                                setattr(item, field, value)
                            item.render = {**item.render, "ocr_retry_count": retry_count, "stage_history": history}
                            item.translation = ""
                            item.position = index
                        else:
                            item = Region(page_id=page.id, position=index, **region)
                            item.render = {**item.render, "ocr_retry_count": 0}
                            db.add(item)
                        regions.append(item)
                        options = dict(item.render or {})
                        record(options, "DETECTED")
                        record(options, "OCR_PENDING")
                        record(options, "OCR_SUCCESS" if item.source_text.strip() else "OCR_FAILED", "" if item.source_text.strip() else "No reliable text recognized")
                        if item.source_text.strip():
                            record(options, "LANGUAGE_IDENTIFIED")
                        options["classification"] = (
                            "speech_bubble" if options.get("bubble_polygon")
                            else "text_on_art" if re.search(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]", item.source_text)
                            else "uncertain_candidate"
                        )
                        has_script = bool(re.search(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]", item.source_text))
                        options["text_evidence"] = (
                            "confirmed" if has_script and (options.get("source_verified") or options.get("ocr_corroborated"))
                            else "probable" if has_script and (item.confidence >= settings.ocr_min_confidence or options.get("ocr_provider") == "ocr_space")
                            else "uncertain"
                        )
                        item.render = options
                    for stale in old_auto:
                        db.delete(stale)
                    # Reinsert preserved manual regions into the reading order;
                    # otherwise duplicate positions can reorder page context.
                    regions.sort(key=lambda r: (r.box[1] // 160,
                                 -r.box[0] if project.direction == "rtl" else r.box[0], r.box[1]))
                    for position, item in enumerate(regions):
                        item.position = position
                    db.commit()
                if job.kind == "ocr_region":
                    for r in regions:
                        if not (r.render or {}).get("pending_ocr"):
                            continue
                        options = dict(r.render or {})
                        record(options, "OCR_PENDING")
                        r.render = options
                        diagnostics = []
                        result = recognize_selection(
                            original,
                            r.render.get("source_box", r.box),
                            r.language,
                            diagnostics,
                        )
                        cloud_suggestion = ""
                        if (
                            project.quality == "quality"
                            and settings.cloud_ocr_provider == "ocr_space"
                            and settings.ocr_space_api_key
                            and not r.render.get("source_verified")
                            and (not result["source_text"].strip() or result["confidence"] < settings.ocr_min_confidence)
                        ):
                            bx, by, bw, bh = r.render.get("source_box", r.box)
                            left, top = max(0, bx - 12), max(0, by - 12)
                            right, bottom = min(original.width, bx + bw + 12), min(original.height, by + bh + 12)
                            crop = original.crop((left, top, right, bottom))
                            crop_requests = 0
                            def before_region_request(engine):
                                nonlocal crop_requests
                                db.refresh(project)
                                if project.cancelled:
                                    raise InterruptedError("Processing cancelled.")
                                event_id = reserve_request(db, project.owner, engine, crop_requests)
                                crop_requests += 1
                                return event_id
                            def after_region_request(event_id, status):
                                finish_request(db, event_id, status)
                            try:
                                alternatives = ocr_space_recognize(crop, r.language, before_region_request, after_region_request, diagnostics)
                                alternatives.sort(key=lambda item: (-item["box"][0], item["box"][1]))
                                cloud_suggestion = "\n".join(item["source_text"] for item in alternatives if item["source_text"].strip())
                            except OCRSpaceError as exc:
                                diagnostics.append({"attempt": "targeted OCR.space crop", "result": str(exc)})
                        r.render = {
                            **r.render,
                            "pending_ocr": False,
                            "ocr_suggestion": result["source_text"],
                            "ocr_cloud_suggestion": cloud_suggestion,
                            "ocr_attempts": diagnostics,
                            "ocr_retry_count": int(r.render.get("ocr_retry_count", 0)) + 1,
                        }
                        record(r.render, "OCR_SUCCESS" if result["source_text"].strip() else "OCR_FAILED", "" if result["source_text"].strip() else "No text recognized on retry")
                        if not r.source_text.strip():
                            r.source_text = result["source_text"]
                            r.confidence = result["confidence"]
                        r.warnings = ["Review the OCR suggestion before translating."]
                    db.commit()
                stage("detecting_languages")
                stage("translating")
                if (
                    sum(len(r.source_text) for r in regions)
                    > settings.max_translation_chars
                ):
                    raise ValueError("Page exceeds the translation character budget.")
                glossary = {
                    g.source: g.target
                    for g in db.scalars(
                        select(Glossary).where(Glossary.project_id == project.id)
                    )
                }
                previous = db.scalars(
                    select(Region)
                    .join(Page)
                    .where(Page.project_id == project.id, Page.position < page.position)
                    .order_by(Page.position, Region.position)
                ).all()
                context = "\n".join(
                    r.source_text + " → " + r.translation for r in previous
                )[-6000:]
                page_dialogue = [
                    r.source_text for r in regions
                    if r.source_text.strip()
                    and (r.confidence >= settings.ocr_min_confidence or r.render.get("ocr_provider") == "ocr_space" or r.render.get("ocr_corroborated"))
                    and (r.language not in ("ja", "ko", "zh-CN", "zh-TW") or re.search(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]", r.source_text))
                ]
                successes = 0
                failures = 0
                for r in regions:
                    db.refresh(project)
                    if project.cancelled:
                        raise InterruptedError("Processing cancelled.")
                    if (
                        r.restored
                        or not r.source_text.strip()
                        or job.kind == "ocr_region"
                    ):
                        continue
                    if (
                        r in preserved
                        and r.translation
                        and r.render.get("translation_target", project.target_lang)
                        == project.target_lang
                    ):
                        continue
                    corroborated = bool(r.render.get("ocr_corroborated"))
                    # OCR.space has no confidence score. Its uncorroborated
                    # text can be translated for review, but must never be
                    # painted over the original image automatically.
                    cloud_suggestion = (
                        r.render.get("ocr_provider") == "ocr_space"
                        and len(re.findall(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]", r.source_text)) >= 3
                    )
                    if not r.render.get("source_verified") and not corroborated and not cloud_suggestion and (
                        not r.render.get("ocr_confidence_available", True)
                        or r.render.get("ocr_cloud_disagreement")
                        or r.confidence < settings.ocr_min_confidence
                    ):
                        r.translation = ""
                        r.render = {**r.render, "translation_pending_review": True, "state": "needs_review"}
                        record(r.render, "NEEDS_MANUAL_REVIEW", "Verify the recognized source text before translation")
                        r.warnings = list(dict.fromkeys(r.warnings + ["Verify the recognized source text before translation."]))
                        continue
                    if cloud_suggestion and not corroborated and not r.render.get("source_verified"):
                        r.render = {**r.render, "translation_pending_review": True}
                    if (
                        r.language == project.target_lang
                        and (project.source_lang != "auto" or r.render.get("language_confidence", 0) >= 0.85)
                    ):
                        r.translation = r.source_text
                        r.render = {**r.render, "source_is_target": True, "translation_error": "", "translation_quality": []}
                        continue
                    try:
                        record(r.render, "TRANSLATION_PENDING")
                        if (project.provider == "argos" and ocr_source == "auto"
                                and r.render.get("language_confidence", 0) < 0.75
                                and not r.render.get("source_verified")):
                            raise ValueError("Source language is uncertain. Select Japanese, Korean, or Chinese before offline translation.")
                        details = {}
                        source = (
                            "auto"
                            if project.provider == "deepl"
                            and project.source_lang == "auto"
                            and r.render.get("language_confidence", 1) < 0.75
                            else r.language
                        )
                        neighbor_context = "\n".join(
                            text for text in page_dialogue if text != r.source_text
                        )[-1800:]
                        texts, provider, cached = cached_translate(
                            db,
                            project.owner,
                            [r.source_text],
                            source,
                            project,
                            glossary,
                            (context + "\n" + neighbor_context)[-4000:],
                            details=details,
                            fallback_source=r.language,
                            fallback_confidence=r.render.get("language_confidence", 1),
                        )
                        if provider == "deepl" and project.quality == "quality" and quality_warnings(r.source_text, texts[0], project.target_lang):
                            retry_details = {}
                            try:
                                revised, retry_provider, retry_cached = cached_translate(
                                    db, project.owner, [r.source_text], source, project,
                                    glossary,
                                    (context + "\n" + neighbor_context + "\nKeep every meaningful detail of this dialogue.")[-4000:],
                                    details=retry_details,
                                    fallback_source=r.language,
                                    fallback_confidence=r.render.get("language_confidence", 1),
                                )
                                if len(quality_warnings(r.source_text, revised[0], project.target_lang)) < len(quality_warnings(r.source_text, texts[0], project.target_lang)):
                                    texts, provider, cached, details = revised, retry_provider, retry_cached, retry_details
                            except ValueError:
                                pass
                        r.translation = texts[0]
                        detected = (details.get("detected_languages") or [""])[0].lower()
                        if source == "auto" and detected:
                            r.language = {"zh": "zh-CN"}.get(detected, detected)
                        quality_notes = quality_warnings(
                            r.source_text, r.translation, project.target_lang
                        )
                        r.render = {
                            **r.render,
                            "translation_target": project.target_lang,
                            "translation_error": "",
                            "state": "translation_completed",
                            "translation_quality": quality_notes,
                            "translation_provider": provider,
                            "translation_cached": cached,
                            "translation_request_attempts": details.get("request_attempts", 0),
                            "translation_rate_limit_responses": details.get("rate_limit_responses", 0),
                            "translation_billed_characters": details.get("billed_characters", 0),
                            "source_is_target": False,
                            "detected_translation_language": detected,
                        }
                        record(r.render, "TRANSLATION_SUCCESS")
                        successes += 1
                        page.metrics = {
                            **page.metrics,
                            "translation_provider": provider,
                            "translation_cache_hit": cached,
                            "translated_regions": successes,
                        }
                        db.commit()
                    except Exception as exc:
                        if isinstance(exc, InterruptedError):
                            raise
                        failures += 1
                        r.render = {
                            **r.render,
                            "state": "failed",
                            "translation_error": (
                                str(exc)
                                if isinstance(exc, ValueError)
                                else "Translation service failed for this region."
                            ),
                            "translation_http_status": getattr(exc, "status_code", 0),
                            "translation_temporary": getattr(exc, "status_code", 0) in (429, 500, 503, 504, 529),
                        }
                        record(r.render, "TRANSLATION_FAILED", r.render["translation_error"])
                        db.commit()
                if (
                    failures
                    and not successes
                    and not any(
                        r.translation and not r.render.get("translation_error")
                        for r in regions
                    )
                ):
                    raise ValueError(
                        "Translation service could not process any recognized regions. Source text is saved; retry translation or choose a configured provider."
                    )
                db.commit()
                stage("reviewing_translation")
            # Reevaluate quality on render-only retries too, so improved
            # safeguards apply to already translated pages.
            for r in regions:
                if r.translation and not r.restored:
                    r.render = {
                        **r.render,
                        "translation_quality": quality_warnings(
                            r.source_text, r.translation, project.target_lang
                        ),
                    }
            stage("cleaning")
            output, clean, mask, notices = render_page(
                original,
                regions,
                cache_path=asset(project.id, page.id, "cleanup-cache"),
            )
            stage("rendering")
            for kind, image in [
                ("translated", output),
                ("clean", clean),
                ("mask", mask),
            ]:
                final = asset(project.id, page.id, kind)
                temporary = final.with_suffix(".tmp")
                image.save(temporary, format="PNG")
                temporary.replace(final)
            stage("validating")
            for r in regions:
                if r.render.get("pending_retry_stage"):
                    options = dict(r.render)
                    options["last_retry_stage"] = options.pop("pending_retry_stage")
                    r.render = options
                options = dict(r.render)
                options["classification"] = options.get("classification") or (
                    "speech_bubble" if options.get("bubble_polygon") else
                    "manual_text_region" if options.get("manual") else "uncertain_candidate"
                )
                options["text_evidence"] = (
                    "confirmed" if r.source_text.strip() and (options.get("source_verified") or options.get("ocr_corroborated"))
                    else "probable" if r.source_text.strip() and (options.get("manual") or r.confidence >= settings.ocr_min_confidence or options.get("ocr_provider") == "ocr_space")
                    else "uncertain"
                )
                r.render = options
                r.warnings = list(
                    dict.fromkeys(
                        (
                            [
                                w
                                for w in r.warnings
                                if w.startswith(
                                    (
                                        "Low OCR",
                                        "OCR.space",
                                        "OCR readings",
                                        "OCR models",
                                        "Bubble boundary",
                                        "Review the OCR",
                                        "Verify the recognized",
                                    )
                                )
                            ]
                            if not r.render.get("source_verified")
                            else []
                        )
                        + r.render.get("translation_quality", [])
                        + (
                            ["Low OCR confidence; verify source text."]
                            if r.confidence < settings.ocr_min_confidence
                            and not r.render.get("source_verified")
                            and not r.render.get("ocr_corroborated")
                            and r.render.get("ocr_confidence_available", True)
                            else []
                        )
                        + notices[r.id]
                    )
                )
                if r.warnings:
                    options = {**r.render, "state": "needs_review"}
                    if options.get("diagnostic_status") == "COMPLETED":
                        record(options, "NEEDS_MANUAL_REVIEW", r.warnings[0])
                    r.render = options
                if not r.render.get("stage_history"):
                    options = dict(r.render)
                    record(options, "DETECTED")
                    record(options, "OCR_SUCCESS" if r.source_text.strip() else "OCR_FAILED")
                    r.render = options
            unresolved = [
                r for r in regions
                if not r.restored and not r.render.get("source_is_target")
                and (r.render.get("actual_font_size") is None or r.warnings)
            ]
            page.status = (
                "needs_review"
                if not regions or unresolved
                else "completed"
            )
            page.revision += 1
            page.error = (
                ""
                if regions
                else "Automatic recognition could not confidently identify dialogue after fallback attempts. Add text regions in the editor to continue."
            )
            page.metrics = {
                **page.metrics,
                "seconds": round(time.monotonic() - start, 2),
                "regions": len(regions),
                "detection_outcome": (
                    "NO_TEXT_DETECTED" if not regions else
                    "OCR_FAILED" if not any(r.source_text.strip() for r in regions) else
                    "TEXT_RECOGNIZED"
                ),
                "recognized_regions": sum(bool(r.source_text.strip()) for r in regions),
                "translated_regions": sum(bool(r.translation.strip()) and not r.render.get("translation_error") for r in regions),
                "translation_success_regions": sum(bool(r.translation.strip()) and not r.render.get("translation_error") for r in regions),
                "masked_regions": sum(r.render.get("mask_candidate_pixels", 0) > 0 for r in regions),
                "cleaned_regions": sum(r.render.get("mask_applied_pixels", 0) > 0 for r in regions),
                "rendered_regions": sum(r.render.get("actual_font_size") is not None for r in regions),
                "completed_regions": sum(r.render.get("diagnostic_status") == "COMPLETED" for r in regions),
                "confirmed_text_regions": sum(r.render.get("text_evidence") == "confirmed" for r in regions),
                "probable_text_regions": sum(r.render.get("text_evidence") == "probable" for r in regions),
                "uncertain_candidates": sum(r.render.get("text_evidence") == "uncertain" for r in regions),
                "unresolved_regions": len(unresolved),
                "completion": "PARTIALLY_COMPLETED" if unresolved or not regions else "COMPLETED",
                "languages": sorted({r.language for r in regions if r.source_text.strip()}),
                "pipeline_version": 2,
                "coverage": "Selected regions validated; inspect for undetected dialogue.",
            }
            job.status = "completed"
            job.error = ""
            db.commit()
            for r in regions:
                log.info(json.dumps({
                    "event": "region_status", "page_id": page.id, "region_id": r.id,
                    "status": r.render.get("diagnostic_status"),
                    "reason": r.render.get("failure_reason", ""),
                }))
            log.info(
                json.dumps(
                    {
                        "event": "page_completed",
                        "page_id": page.id,
                        "metrics": page.metrics,
                    }
                )
            )
        except Exception as exc:
            db.rollback()
            # Do not expose upstream request URLs (which could contain secrets).
            message = (
                str(exc)
                if isinstance(exc, (ValueError, InterruptedError))
                else f"{type(exc).__name__}: processing failed. Check provider availability and worker logs."
            )
            page = db.get(Page, page.id)
            job = db.get(Job, job_id)
            if page:
                page.status = (
                    "cancelled" if isinstance(exc, InterruptedError) else "failed"
                )
                page.error = message[:1000]
            if job:
                job.status = "failed"
                job.error = message[:1000]
            db.commit()
            log.error(
                json.dumps(
                    {
                        "event": "page_failed",
                        "job_id": job_id,
                        "type": type(exc).__name__,
                    }
                )
            )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run(sys.argv[1])
