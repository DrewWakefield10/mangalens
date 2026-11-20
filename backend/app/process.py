import json
import logging
import re
import sys
import time
from sqlalchemy import select
from PIL import Image
import numpy as np
from .config import settings
from .db import DB, Glossary, Job, Page, Project, Region, uid
from .bubble_ocr import bubble_ocr
from .bubble_render import BOUNDARY
from .bubbles import VERSION, approved_bubbles, detect_speech_bubbles, eligible, fingerprint, mark_scan_failed, scan_for
from .geometry import polygon_mask
from .rendering import render_page
from .storage import asset
from .translation import cached_translate, quality_warnings
from .diagnostics import record

log = logging.getLogger("mangalens")


def previous_render(page, project, regions, selections, job_kind):
    target_id = page.metrics.get("render_region_id") if job_kind == "render" else None
    target = next((r for r in regions if r.id == target_id), None)
    if not target or not page.revision or len(regions) != len(selections):
        return None, None
    images = []
    try:
        for kind, mode in (("translated", "RGB"), ("clean", "RGB"), ("mask", "L")):
            with Image.open(asset(project.id, page.id, kind)) as image:
                if image.size != (page.width, page.height):
                    return None, None
                images.append(image.convert(mode))
    except OSError:
        return None, None
    return target, images


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
            scan = scan_for(page)
            if job.kind == "bubble_scan":
                candidates = detect_speech_bubbles(original)
                if not isinstance(candidates, list):
                    raise ValueError("The detector returned unusable bubble geometry.")
                db.refresh(project)
                if project.cancelled:
                    raise InterruptedError("Processing cancelled.")
                page.metrics = {**page.metrics, "bubble_scan": {
                    **scan, "status": "ready", "revision": uid(), "bubbles": candidates,
                    "reviewed": not candidates,
                }}
                job.status = "completed"
                db.commit()
                return
            if scan.get("status") != "ready" or not scan.get("reviewed"):
                raise ValueError("Review and confirm speech bubbles before processing.")
            selections = approved_bubbles(page)
            ocr_source = page.metrics.get("ocr_source_override", project.source_lang)
            group_height = max(1, page.height // 10)
            selections.sort(key=lambda item: (item["box"][1] // group_height,
                             item["box"][1] if project.direction == "vertical" else
                             item["box"][0] if project.direction == "ltr" else -item["box"][0],
                             item["box"][1]))
            if job.kind in ("translate", "ocr", "ocr_region", "bubble_update"):
                stage("recognizing")
                current = {r.render.get("bubble_id"): r for r in regions if r.render.get("bubble_id")}
                selected_regions = []
                ocr_settings = fingerprint(ocr_source, project.quality, project.direction)
                recognize = bubble_ocr(db, page, project, ocr_source) if selections else None
                process_ids = set()
                translation_settings = fingerprint(project.provider, project.target_lang, project.style, project.quality)
                for position, bubble in enumerate(selections):
                    db.refresh(project)
                    if project.cancelled:
                        raise InterruptedError("Processing cancelled.")
                    r = current.get(bubble["id"])
                    changed = not r or not eligible(page, r)
                    if r is None:
                        r = Region(id=uid(), page_id=page.id, position=position, box=bubble["box"])
                    retry_ocr = job.kind == "ocr" or (r.render or {}).get("pending_ocr")
                    if (changed or retry_ocr or (job.kind == "translate" and (
                            not r.source_text.strip() or r.render.get("ocr_settings") != ocr_settings))):
                        result = recognize(original, bubble, retry=bool(retry_ocr))
                        retry_count = int((r.render or {}).get("ocr_retry_count", 0)) + int(bool(retry_ocr))
                        if not changed and r.render.get("source_verified"):
                            r.render = {**r.render, "ocr_suggestion": result["source_text"],
                                        "ocr_cloud_suggestion": result["render"].get("ocr_cloud_suggestion", ""),
                                        "ocr_attempts": result["render"]["ocr_attempts"]}
                            retry_ocr = False
                        else:
                            r.box = bubble["box"]
                            for name, value in result.items():
                                setattr(r, name, value)
                            r.translation = ""
                            r.restored = False
                            r.warnings = []
                        r.render = {**r.render, "ocr_retry_count": retry_count, "pending_ocr": False}
                        record(r.render, "DETECTED")
                        if r.render["boundary_crossing"]:
                            r.warnings = [BOUNDARY]
                        elif not r.source_text.strip():
                            r.warnings = ["OCR could not read the lettering. Retry OCR or verify a transcription."]
                        ocr_status = (
                            "OCR_NOT_RUN" if r.render["boundary_crossing"]
                            else "OCR_SUCCESS" if r.source_text.strip() else "OCR_FAILED"
                        )
                        record(r.render, ocr_status, r.warnings[0] if r.warnings else "")
                    if (changed or retry_ocr or not r.translation or
                            r.render.get("translation_settings") != translation_settings):
                        if job.kind not in ("ocr_region", "bubble_update") or changed or retry_ocr:
                            process_ids.add(r.id)
                    r.position = position
                    db.add(r)
                    selected_regions.append(r)
                for old in regions:
                    if old not in selected_regions:
                        db.delete(old)
                regions = selected_regions
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
                page_dialogue = [
                    r.source_text for r in regions
                    if r.source_text.strip()
                    and not r.render.get("boundary_crossing")
                    and (r.render.get("source_verified") or r.confidence >= settings.ocr_min_confidence and not r.render.get("ocr_uncertain"))
                    and (r.language not in ("ja", "ko", "zh-CN", "zh-TW") or re.search(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]", r.source_text))
                ]
                successes = 0
                for r in regions:
                    db.refresh(project)
                    if project.cancelled:
                        raise InterruptedError("Processing cancelled.")
                    if (r.id not in process_ids or r.restored or not r.source_text.strip()
                            or r.render.get("boundary_crossing")):
                        continue
                    if not r.render.get("source_verified") and (
                        r.render.get("ocr_uncertain") or r.confidence < settings.ocr_min_confidence
                    ):
                        r.translation = ""
                        record(r.render, "NEEDS_MANUAL_REVIEW", "Verify the recognized source text before translation")
                        r.warnings = ["Verify the recognized source text before translation."]
                        continue
                    if (
                        r.language == project.target_lang
                        and (project.source_lang != "auto" or r.render.get("language_confidence", 0) >= 0.85)
                    ):
                        r.translation = r.source_text
                        r.render = {**r.render, "source_is_target": True, "translation_error": "",
                                    "translation_quality": [], "translation_verified": False,
                                    "translation_settings": translation_settings}
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
                            neighbor_context,
                            details=details,
                            fallback_source=r.language,
                            fallback_confidence=r.render.get("language_confidence", 1),
                            bubble_scope=[VERSION, page.digest, r.render["bubble_polygon"]],
                        )
                        if provider == "deepl" and project.quality == "quality" and quality_warnings(r.source_text, texts[0], project.target_lang):
                            retry_details = {}
                            try:
                                revised, retry_provider, retry_cached = cached_translate(
                                    db, project.owner, [r.source_text], source, project,
                                    glossary,
                                    neighbor_context + "\nKeep every meaningful detail of this dialogue.",
                                    details=retry_details,
                                    fallback_source=r.language,
                                    fallback_confidence=r.render.get("language_confidence", 1),
                                    bubble_scope=[VERSION, page.digest, r.render["bubble_polygon"]],
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
                            "translation_settings": translation_settings,
                            "translation_error": "",
                            "translation_verified": False,
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
                        r.translation = ""
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
                db.commit()
                stage("reviewing_translation")
            # Reevaluate quality on render-only retries too, so improved
            # safeguards apply to already translated pages.
            eligible_regions = [r for r in regions if eligible(page, r)]
            target, previous = (
                previous_render(page, project, eligible_regions, selections, job.kind)
                if len(eligible_regions) == len(regions) else (None, None)
            )
            regions = eligible_regions
            render_regions = [target] if target else regions
            for r in render_regions:
                if r.translation and not r.restored:
                    r.render = {
                        **r.render,
                        "translation_quality": [] if r.render.get("translation_verified") else quality_warnings(
                            r.source_text, r.translation, project.target_lang
                        ),
                    }
            stage("cleaning")
            output, clean, mask, notices = render_page(
                original,
                render_regions,
                cache_path=None if target else asset(project.id, page.id, "bubble-cleanup-cache"),
            )
            if target:
                scope = Image.fromarray(polygon_mask((original.height, original.width),
                                                     target.render["bubble_polygon"]))
                for saved, updated in zip(previous, (output, clean, mask)):
                    saved.paste(updated, (0, 0), scope)
                output, clean, mask = previous
            allowed = np.zeros((original.height, original.width), np.uint8)
            for bubble in selections:
                allowed |= polygon_mask(allowed.shape, bubble["polygon"])
            outside = allowed == 0
            pixels = np.asarray(original)
            if (np.any(np.asarray(output)[outside] != pixels[outside])
                    or np.any(np.asarray(clean)[outside] != pixels[outside])
                    or np.any(np.asarray(mask)[outside])):
                raise ValueError("Page validation rejected edits outside approved speech bubbles.")
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
            for r in render_regions:
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
                                        "OCR could not read",
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
            pending = sum(item["decision"] == "pending" for item in scan["bubbles"])
            page.status = (
                "needs_review" if unresolved or pending else
                "no_speech_bubbles" if not scan["bubbles"] else
                "no_bubbles_selected" if not regions else "completed"
            )
            page.revision += 1
            page.error = ""
            page.metrics = {
                **{k: v for k, v in page.metrics.items() if k != "render_region_id"},
                "seconds": round(time.monotonic() - start, 2),
                "regions": len(regions),
                "detection_outcome": (
                    "NO_SPEECH_BUBBLES_FOUND" if not scan["bubbles"] else
                    "NO_BUBBLES_SELECTED" if not regions else
                    "BUBBLE_BOUNDARY_REVIEW" if all(r.render.get("boundary_crossing") for r in regions) else
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
                "unresolved_regions": len(unresolved) + pending,
                "completion": "PARTIALLY_COMPLETED" if unresolved or pending else "COMPLETED",
                "languages": sorted({r.language for r in regions if r.source_text.strip()}),
                "pipeline_version": VERSION,
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
            if page and job and job.kind != "bubble_scan":
                page.status = (
                    "cancelled" if isinstance(exc, InterruptedError) else "failed"
                )
                page.error = message[:1000]
            if job and job.kind == "bubble_scan" and page:
                mark_scan_failed(page, f"{type(exc).__name__}: {exc}"[:1000])
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
