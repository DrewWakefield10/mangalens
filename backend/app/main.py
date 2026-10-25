import asyncio
from collections import defaultdict, deque
import hashlib
import io
import json
from pathlib import Path
import secrets
import time
from typing import Literal
import zipfile
import numpy as np
from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session as DBSession
from sqlalchemy.exc import IntegrityError
from PIL import Image
from .config import settings
from .db import (
    DB,
    Cache,
    Edit,
    Feedback,
    Glossary,
    Job,
    Page,
    Project,
    Region,
    Session,
    uid,
)
from .ocr import installed
from .sources import import_manifest
from .storage import asset, natural, remove_project, save_original, unpack
from .translation import (
    PROVIDERS,
    capability,
    offline_pairs,
    offline_fallback_available,
    validate_offline_pair,
    usage_summary,
    default_provider,
)
from .deepl_client import account_usage, DeepLError
from .rendering import build_text_mask
from .limits import BodyLimitMiddleware

app = FastAPI(
    title="MangaLens API",
    version="0.1.0",
    description="Private temporary sessions, durable page jobs and CPU manga translation. Session cookie required for project APIs.",
)
app.add_middleware(
    BodyLimitMiddleware, max_bytes=(settings.max_upload_mb + 2) * 1024**2
)
rates = defaultdict(deque)


@app.exception_handler(IntegrityError)
async def conflict_handler(request, exc):
    return JSONResponse(
        {
            "detail": "A conflicting operation already exists. Refresh the project and try again."
        },
        status_code=409,
    )


@app.middleware("http")
async def protect(request: Request, call_next):
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        if request.headers.get("x-mangalens-client") != "web":
            return Response("Missing X-MangaLens-Client header", 403)
        origin = request.headers.get("origin")
        trusted_origins = {value.strip().rstrip("/")
                           for value in settings.allowed_origin.split(",") if value.strip()}
        trusted_origins.add("http://127.0.0.1:3000")
        if origin and origin.rstrip("/") not in trusted_origins:
            return Response("Origin not allowed", 403)
        try:
            content_length = int(request.headers.get("content-length", "0"))
        except ValueError:
            return Response("Invalid Content-Length", 400)
        if content_length > (settings.max_upload_mb + 2) * 1024**2:
            return Response("Upload exceeds request limit", 413)
        host = request.client.host if request.client else "unknown"
        now = time.time()
        entries = rates[host]
        while entries and entries[0] < now - 60:
            entries.popleft()
        if len(entries) >= 90:
            return Response("Too many requests; try again shortly.", 429)
        entries.append(now)
        if len(rates) > 10000:
            for key in list(rates):
                if not rates[key] or rates[key][-1] < now - 60:
                    rates.pop(key, None)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "same-origin"
    return response


def database():
    with DB() as db:
        yield db


def owner(request: Request, db: DBSession = Depends(database)):
    token = request.cookies.get("mangalens_session", "")
    key = hashlib.sha256(token.encode()).hexdigest()
    session = db.get(Session, key)
    if (
        not token
        or not session
        or session.created < time.time() - settings.session_days * 86400
    ):
        raise HTTPException(
            401, "Session expired. Reload the app to start a private session."
        )
    return session


def project_for(db, project_id, session):
    project = db.get(Project, project_id)
    if not project or project.owner != session.id:
        raise HTTPException(404, "Project not found.")
    return project


def page_for(db, page_id, session):
    page = db.get(Page, page_id)
    if not page:
        raise HTTPException(404, "Page not found.")
    return page, project_for(db, page.project_id, session)


def active(db, project_id):
    return db.scalar(
        select(Job.id)
        .join(Page)
        .where(Page.project_id == project_id, Job.status.in_(["queued", "running"]))
        .limit(1)
    )


def serialize_region(r):
    return {
        k: getattr(r, k)
        for k in (
            "id",
            "page_id",
            "position",
            "box",
            "words",
            "source_text",
            "translation",
            "language",
            "confidence",
            "orientation",
            "kind",
            "render",
            "warnings",
            "restored",
        )
    }


def serialize_page(p):
    return {
        **{
            k: getattr(p, k)
            for k in (
                "id",
                "position",
                "name",
                "width",
                "height",
                "status",
                "error",
                "revision",
                "metrics",
            )
        },
        "original": f"/api/pages/{p.id}/image/original",
        "thumbnail": f"/api/pages/{p.id}/image/thumbnail",
        "translated": f"/api/pages/{p.id}/image/translated?v={p.revision}",
    }


def serialize_project(db, p):
    pages = list(
        db.scalars(select(Page).where(Page.project_id == p.id).order_by(Page.position))
    )
    return {
        **{
            k: getattr(p, k)
            for k in (
                "id",
                "title",
                "created",
                "source",
                "source_lang",
                "target_lang",
                "style",
                "quality",
                "provider",
                "direction",
                "last_page",
                "cancelled",
            )
        },
        "pages": [serialize_page(page) for page in pages],
        "ready": sum(page.status in ("completed", "needs_review") for page in pages),
        "active": bool(active(db, p.id)),
    }


@app.get("/api/health")
def health(db: DBSession = Depends(database)):
    from .manga_recognition import available as manga_available

    db.execute(text("SELECT 1"))
    return {
        "status": "ok",
        "ocr_languages": installed(),
        "manga_ocr_available": manga_available(),
        "providers": {p: capability(p) for p in PROVIDERS},
        "default_provider": default_provider(),
        "cloud_ocr_available": bool(settings.ocr_space_api_key) if settings.cloud_ocr_provider == "ocr_space" else bool(settings.google_vision_api_key),
        "cloud_ocr_provider": settings.cloud_ocr_provider,
        "ocr_space_engine3_fallback": settings.ocr_space_engine3_fallback,
        "offline_pairs": offline_pairs(),
        "offline_fallback_available": offline_fallback_available(),
        "font_available": settings.font_path.exists(),
        "retention_days": settings.retention_days,
        "source_hosts": [h for h in settings.authorized_source_hosts.split(",") if h],
        "max_upload_mb": settings.max_upload_mb,
    }


@app.get("/api/usage")
def usage(session=Depends(owner), db=Depends(database)):
    result = usage_summary(db, session.id)
    if settings.deepl_api_key:
        try:
            result["deepl"]["account"] = account_usage()
        except DeepLError:
            result["deepl"]["account_error"] = "DeepL usage is temporarily unavailable."
    return result


@app.post("/api/session")
def create_session(
    request: Request, response: Response, db: DBSession = Depends(database)
):
    token = request.cookies.get("mangalens_session", "")
    session = (
        db.get(Session, hashlib.sha256(token.encode()).hexdigest()) if token else None
    )
    if not session or session.created < time.time() - settings.session_days * 86400:
        token = secrets.token_urlsafe(32)
        session = Session(id=hashlib.sha256(token.encode()).hexdigest())
        db.add(session)
        db.commit()
    response.set_cookie(
        "mangalens_session",
        token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        max_age=settings.session_days * 86400,
        path="/",
    )
    return {"preferences": session.preferences, "temporary": True}


def create_project(db, session, title, files, source="Upload"):
    images = []
    total = 0
    try:
        for name, data in sorted(files, key=lambda f: natural(f[0])):
            total += len(data)
            if total > settings.max_upload_mb * 1024**2:
                raise ValueError("Total upload exceeds size limit.")
            images.extend(unpack(name, data))
            if len(images) > settings.max_pages:
                raise ValueError("Too many chapter pages.")
            if sum(im.width * im.height for _, im in images) > settings.max_pixels * 4:
                raise ValueError(
                    "Chapter exceeds decoded memory limit; split into smaller chapters."
                )
        if not images:
            raise ValueError("No images were uploaded.")
        project = Project(
            id=uid(),
            owner=session.id,
            title=title or "Untitled chapter",
            source=source,
            provider=default_provider(),
        )
        db.add(project)
        db.flush()
        try:
            for position, (name, im) in enumerate(images):
                page_id = uid()
                digest = save_original(project.id, page_id, im)
                db.add(
                    Page(
                        id=page_id,
                        project_id=project.id,
                        position=position,
                        name=name,
                        width=im.width,
                        height=im.height,
                        digest=digest,
                    )
                )
            db.commit()
        except Exception:
            db.rollback()
            remove_project(project.id)
            raise
        return serialize_project(db, project)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@app.post("/api/projects/upload", status_code=201)
def upload(
    files: list[UploadFile] = File(...),
    title: str = Form("Untitled chapter", max_length=200),
    authorized: bool = Form(False),
    session=Depends(owner),
    db=Depends(database),
):
    if not authorized:
        raise HTTPException(422, "Confirm you have permission to process these files.")
    if len(files) > settings.max_pages:
        raise HTTPException(422, "Too many files.")
    inputs = []
    total = 0
    for file in files:
        data = file.file.read(settings.max_upload_mb * 1024**2 + 1)
        total += len(data)
        if total > settings.max_upload_mb * 1024**2:
            raise HTTPException(413, "Upload exceeds size limit.")
        inputs.append((file.filename or "image.png", data))
    return create_project(db, session, title, inputs)


class SourceImport(BaseModel):
    url: str = Field(max_length=2048)
    authorized: bool


@app.post("/api/projects/import", status_code=201)
def from_url(body: SourceImport, session=Depends(owner), db=Depends(database)):
    if not body.authorized:
        raise HTTPException(422, "Permission confirmation required.")
    try:
        title, files = import_manifest(body.url)
    except Exception as e:
        raise HTTPException(
            422,
            (
                str(e)
                if isinstance(e, ValueError)
                else "Unable to retrieve authorized source."
            ),
        ) from e
    return create_project(db, session, title, files, body.url)


@app.get("/api/projects")
def projects(session=Depends(owner), db=Depends(database)):
    return [
        serialize_project(db, p)
        for p in db.scalars(
            select(Project)
            .where(Project.owner == session.id)
            .order_by(Project.created.desc())
        )
    ]


@app.get("/api/projects/{project_id}")
def project(project_id: str, session=Depends(owner), db=Depends(database)):
    return serialize_project(db, project_for(db, project_id, session))


@app.get("/api/projects/{project_id}/events")
async def events(project_id: str, session=Depends(owner), db=Depends(database)):
    project_for(db, project_id, session)
    owner_id = session.id
    db.close()  # Do not hold a database connection for the life of an SSE stream.

    async def stream():
        last = ""
        for _ in range(300):
            with DB() as connection:
                p = connection.get(Project, project_id)
                if not p or p.owner != owner_id:
                    return
                state = json.dumps(serialize_project(connection, p))
            if state != last:
                yield f"data: {state}\n\n"
                last = state
            else:
                yield ": heartbeat\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"}
    )


class Start(BaseModel):
    source_lang: Literal["auto", "ja", "ko", "zh-CN", "zh-TW", "ru", "en"] = "auto"
    target_lang: Literal[
        "en",
        "ja",
        "ko",
        "zh-CN",
        "zh-TW",
        "ru",
        "es",
        "fr",
        "de",
        "pt",
        "id",
        "vi",
        "th",
        "tl",
    ] = "en"
    quality: Literal["fast", "balanced", "quality"] = "quality"
    style: Literal["faithful", "natural", "literal", "concise"] = "natural"
    provider: Literal["argos", "openai", "ollama", "deepl", "google", "azure"] = default_provider()
    direction: Literal["rtl", "ltr", "vertical"] = "rtl"
    order: list[str] = Field(default_factory=list, max_length=100)


@app.post("/api/projects/{project_id}/start")
def start(project_id: str, body: Start, session=Depends(owner), db=Depends(database)):
    p = project_for(db, project_id, session)
    if active(db, p.id):
        raise HTTPException(409, "Project is already processing.")
    if body.provider == "argos":
        try:
            validate_offline_pair(body.source_lang, body.target_lang)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
    if not capability(body.provider):
        raise HTTPException(
            422,
            f"{body.provider} is unconfigured. Install a local model or configure credentials on the server.",
        )
    pages = list(
        db.scalars(select(Page).where(Page.project_id == p.id).order_by(Page.position))
    )
    if body.order and (
        len(body.order) != len(pages) or set(body.order) != {x.id for x in pages}
    ):
        raise HTTPException(422, "Page order must include each page exactly once.")
    changed_source = p.source_lang != body.source_lang
    previous_target = p.target_lang
    if previous_target != body.target_lang:
        for r in db.scalars(select(Region).join(Page).where(Page.project_id == p.id)):
            r.render = {
                **r.render,
                "translation_target": r.render.get(
                    "translation_target", previous_target
                ),
            }
    for key, value in body.model_dump(exclude={"order"}).items():
        setattr(p, key, value)
    p.cancelled = False
    for page in pages:
        if body.order:
            page.position = body.order.index(page.id)
        if changed_source:
            page.metrics = {**page.metrics, "pipeline_version": 0}
        page.status = "queued"
        page.error = ""
        db.add(Job(page_id=page.id, created=time.time() + page.position * 0.001))
    db.commit()
    return serialize_project(db, p)


@app.post("/api/projects/{project_id}/cancel")
def cancel(project_id: str, session=Depends(owner), db=Depends(database)):
    p = project_for(db, project_id, session)
    p.cancelled = True
    for job in db.scalars(
        select(Job).join(Page).where(Page.project_id == p.id, Job.status == "queued")
    ):
        job.status = "cancelled"
        db.get(Page, job.page_id).status = "cancelled"
    db.commit()
    return {"cancelled": True}


@app.post("/api/pages/{page_id}/retry")
def retry(page_id: str, session=Depends(owner), db=Depends(database)):
    page, p = page_for(db, page_id, session)
    if active(db, p.id):
        raise HTTPException(
            409, "Wait for active processing to finish before retrying."
        )
    if p.provider == "argos":
        try:
            validate_offline_pair(p.source_lang, p.target_lang)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
    p.cancelled = False
    page.status = "queued"
    page.error = ""
    db.add(Job(page_id=page.id))
    db.commit()
    return {"queued": True}


@app.get("/api/pages/{page_id}/image/{kind}")
def image(
    page_id: str,
    kind: Literal["original", "translated", "thumbnail", "clean", "mask"],
    v: int | None = None,
    session=Depends(owner),
    db=Depends(database),
):
    page, p = page_for(db, page_id, session)
    if kind in ("translated", "clean", "mask"):
        if page.status not in ("completed", "needs_review"):
            raise HTTPException(404, "This image is not ready yet.")
        if v is not None and v != page.revision:
            raise HTTPException(409, "Image revision changed. Refresh the page to load the current views.")
    path = asset(p.id, page.id, kind)
    if not path.exists():
        raise HTTPException(404, "This image is not ready yet.")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-store"})


@app.get("/api/regions/{region_id}/mask-candidate")
def mask_candidate(
    region_id: str,
    v: int | None = None,
    session=Depends(owner),
    db=Depends(database),
):
    """Show proposed removal pixels on the original; never apply them here."""
    region = db.get(Region, region_id)
    if region is None:
        raise HTTPException(404, "Region not found.")
    page, project = page_for(db, region.page_id, session)
    if page.status not in ("completed", "needs_review"):
        raise HTTPException(404, "This preview is not ready yet.")
    if v is not None and v != page.revision:
        raise HTTPException(409, "Image revision changed. Refresh the page to load the current views.")
    with Image.open(asset(project.id, page.id, "original")) as image:
        original = np.asarray(image.convert("RGB"))
    displayed = original.copy()
    count = 0
    if not region.restored and region.source_text.strip():
        proposal, _ = build_text_mask(original, region)
        if proposal is not None:
            selected = proposal["mask"] > 0
            count = int(np.count_nonzero(selected))
            displayed[selected] = (
                displayed[selected].astype(np.uint16) * 2
                + np.array([255, 35, 130], dtype=np.uint16) * 3
            ) // 5
    stream = io.BytesIO()
    Image.fromarray(displayed).save(stream, format="PNG")
    return Response(
        stream.getvalue(),
        media_type="image/png",
        headers={"Cache-Control": "no-store", "X-Mask-Candidate-Pixels": str(count)},
    )


@app.get("/api/pages/{page_id}/regions")
def regions(page_id: str, session=Depends(owner), db=Depends(database)):
    page_for(db, page_id, session)
    return [
        serialize_region(r)
        for r in db.scalars(
            select(Region).where(Region.page_id == page_id).order_by(Region.position)
        )
    ]


class RegionEdit(BaseModel):
    source_text: str = Field(max_length=10000)
    translation: str = Field(max_length=10000)
    font_size: int = Field(default=42, ge=12, le=100)
    align: Literal["left", "center", "right"] = "center"
    offset_x: int = Field(default=0, ge=-1000, le=1000)
    offset_y: int = Field(default=0, ge=-1000, le=1000)
    restored: bool = False
    box: list[int] | None = None
    language: Literal["ja", "ko", "zh-CN", "zh-TW", "ru", "en"] = "ja"
    source_box: list[int] | None = None
    mask_include: list[list[int]] = Field(default_factory=list, max_length=50)
    mask_exclude: list[list[int]] = Field(default_factory=list, max_length=50)
    mask_dilation: int = Field(default=1, ge=0, le=4)
    source_verified: bool = False


def check_box(box, page):
    if (
        len(box) != 4
        or min(box) < 0
        or min(box[2:]) < 2
        or box[0] + box[2] > page.width
        or box[1] + box[3] > page.height
    ):
        raise HTTPException(422, "Selection must stay inside the page.")


class RegionCreate(BaseModel):
    box: list[int]
    language: Literal["ja", "ko", "zh-CN", "zh-TW", "ru", "en"] = "ja"
    run_ocr: bool = True


@app.post("/api/pages/{page_id}/regions", status_code=201)
def add_region(
    page_id: str, body: RegionCreate, session=Depends(owner), db=Depends(database)
):
    page, p = page_for(db, page_id, session)
    if active(db, p.id):
        raise HTTPException(409, "Wait for processing before adding a region.")
    check_box(body.box, page)
    existing = list(db.scalars(select(Region).where(Region.page_id == page.id)))
    if len(existing) >= 100:
        raise HTTPException(422, "Maximum 100 regions per page.")
    r = Region(
        page_id=page.id,
        position=len(existing),
        box=body.box,
        words=[body.box],
        source_text="",
        language=body.language,
        confidence=0,
        render={
            "manual": True,
            "source_box": body.box,
            "pending_ocr": body.run_ocr,
            "pipeline_version": 2,
            "state": "detected",
        },
        warnings=["Review the source text and translation."],
    )
    db.add(r)
    db.add(Job(page_id=page.id, kind="ocr_region" if body.run_ocr else "render"))
    p.cancelled = False
    page.status = "queued"
    db.commit()
    return serialize_region(r)


class OCRRetry(BaseModel):
    source_lang: Literal["auto", "ja", "ko", "zh-CN", "zh-TW", "ru", "en"] | None = None


@app.post("/api/pages/{page_id}/ocr")
def retry_ocr(
    page_id: str, body: OCRRetry, session=Depends(owner), db=Depends(database)
):
    page, p = page_for(db, page_id, session)
    if active(db, p.id):
        raise HTTPException(409, "Wait for processing before retrying OCR.")
    if body.source_lang:
        page.metrics = {**page.metrics, "ocr_source_override": body.source_lang}
    db.add(Job(page_id=page.id, kind="ocr"))
    p.cancelled = False
    page.status = "queued"
    page.error = ""
    db.commit()
    return {"queued": True}


@app.post("/api/regions/{region_id}/ocr")
def retry_region_ocr(region_id: str, session=Depends(owner), db=Depends(database)):
    r = db.get(Region, region_id)
    if not r:
        raise HTTPException(404, "Region not found.")
    page, p = page_for(db, r.page_id, session)
    if active(db, p.id):
        raise HTTPException(409, "Wait for processing before retrying OCR.")
    r.render = {**r.render, "pending_ocr": True, "manual": True}
    db.add(Job(page_id=page.id, kind="ocr_region"))
    page.status = "queued"
    p.cancelled = False
    db.commit()
    return {"queued": True}


@app.post("/api/regions/{region_id}/retry/{stage}")
def retry_region_stage(
    region_id: str,
    stage: Literal["mask", "clean", "render"],
    session=Depends(owner),
    db=Depends(database),
):
    r = db.get(Region, region_id)
    if not r:
        raise HTTPException(404, "Region not found.")
    page, project = page_for(db, r.page_id, session)
    if active(db, project.id):
        raise HTTPException(409, "Wait for processing to finish.")
    options = dict(r.render or {})
    if stage in ("mask", "clean"):
        options["mask_revision"] = int(options.get("mask_revision", 0)) + 1
    options["pending_retry_stage"] = stage
    r.render = options
    db.add(Job(page_id=page.id, kind="render"))
    page.status = "queued"
    page.error = ""
    project.cancelled = False
    db.commit()
    return {"queued": True, "stage": stage, "region_id": r.id}


@app.put("/api/regions/{region_id}")
def edit(
    region_id: str, body: RegionEdit, session=Depends(owner), db=Depends(database)
):
    r = db.get(Region, region_id)
    if not r:
        raise HTTPException(404, "Region not found.")
    page, p = page_for(db, r.page_id, session)
    if active(db, p.id):
        raise HTTPException(409, "Wait for processing before editing.")
    if body.box:
        if (
            len(body.box) != 4
            or min(body.box) < 0
            or body.box[2] < 8
            or body.box[3] < 8
            or body.box[0] + body.box[2] > page.width
            or body.box[1] + body.box[3] > page.height
        ):
            raise HTTPException(422, "Region box is outside the page.")
    before = serialize_region(r)
    for box in (
        ([body.source_box] if body.source_box else [])
        + body.mask_include
        + body.mask_exclude
    ):
        check_box(box, page)
    r.source_text = body.source_text
    r.translation = body.translation
    r.language = body.language
    r.restored = body.restored
    if body.box:
        r.box = body.box
    if not (
        0 <= r.box[0] + body.offset_x <= page.width - r.box[2]
        and 0 <= r.box[1] + body.offset_y <= page.height - r.box[3]
    ):
        raise HTTPException(422, "Text position is outside the page.")
    r.render = {
        **r.render,
        **body.model_dump(
            include={
                "font_size",
                "align",
                "offset_x",
                "offset_y",
                "mask_include",
                "mask_exclude",
                "mask_dilation",
                "source_verified",
            }
        ),
        "manual": True,
        "translation_target": p.target_lang,
        "translation_error": "",
        "translation_quality": [],
        "source_is_target": body.language == p.target_lang and body.translation == body.source_text,
        "source_box": body.source_box or r.render.get("source_box", r.box),
    }
    r.warnings = [] if body.source_verified else ["Verify the recognized source text."]
    db.add(Edit(region_id=r.id, before=before, after=serialize_region(r)))
    db.add(Job(page_id=page.id, kind="render"))
    page.status = "queued"
    p.cancelled = False
    db.commit()
    return serialize_region(r)


@app.post("/api/regions/{region_id}/retranslate")
def retranslate(region_id: str, session=Depends(owner), db=Depends(database)):
    from .translation import cached_translate, quality_warnings

    r = db.get(Region, region_id)
    if not r:
        raise HTTPException(404, "Region not found.")
    page, p = page_for(db, r.page_id, session)
    if active(db, p.id):
        raise HTTPException(409, "Wait for processing to finish.")
    glossary = {
        g.source: g.target
        for g in db.scalars(select(Glossary).where(Glossary.project_id == p.id))
    }
    p.cancelled = False
    db.commit()
    try:
        neighbors = db.scalars(select(Region).where(Region.page_id == page.id)
                               .order_by(Region.position)).all()
        context = "\n".join(item.source_text for item in neighbors
                            if item.id != r.id and item.source_text.strip())[-4000:]
        source = "auto" if (p.provider == "deepl" and p.source_lang == "auto"
                            and not r.render.get("source_verified")
                            and r.render.get("language_confidence", 0) < 0.75) else r.language
        texts, provider, cached = cached_translate(
            db, session.id, [r.source_text], source, p, glossary, context,
            fallback_source=r.language, fallback_confidence=r.render.get("language_confidence", 0),
        )
    except Exception as e:
        raise HTTPException(
            422, str(e) if isinstance(e, ValueError) else "Translation provider failed."
        ) from e
    before = serialize_region(r)
    r.translation = texts[0]
    r.render = {
        **r.render,
        "manual": True,
        "translation_error": "",
        "translation_target": p.target_lang,
        "translation_provider": provider,
        "translation_cached": cached,
        "source_is_target": r.language == p.target_lang and r.translation == r.source_text,
        "translation_quality": quality_warnings(
            r.source_text, r.translation, p.target_lang
        ),
    }
    db.add(Edit(region_id=r.id, before=before, after=serialize_region(r)))
    db.add(Job(page_id=page.id, kind="render"))
    page.status = "queued"
    p.cancelled = False
    db.commit()
    return serialize_region(r)


class GlossaryItem(BaseModel):
    source: str = Field(min_length=1, max_length=200)
    target: str = Field(min_length=1, max_length=200)


@app.get("/api/projects/{project_id}/glossary")
def glossary(project_id: str, session=Depends(owner), db=Depends(database)):
    project_for(db, project_id, session)
    return [
        {"source": g.source, "target": g.target}
        for g in db.scalars(select(Glossary).where(Glossary.project_id == project_id))
    ]


@app.put("/api/projects/{project_id}/glossary")
def save_glossary(
    project_id: str,
    body: list[GlossaryItem],
    session=Depends(owner),
    db=Depends(database),
):
    project_for(db, project_id, session)
    if len(body) > 200:
        raise HTTPException(422, "Maximum 200 glossary entries.")
    if active(db, project_id):
        raise HTTPException(409, "Wait for processing before changing glossary.")
    db.execute(delete(Glossary).where(Glossary.project_id == project_id))
    for item in body:
        db.add(Glossary(project_id=project_id, **item.model_dump()))
    db.commit()
    return {"saved": True}


class Progress(BaseModel):
    page: int = Field(ge=0)


@app.put("/api/projects/{project_id}/progress")
def progress(
    project_id: str, body: Progress, session=Depends(owner), db=Depends(database)
):
    p = project_for(db, project_id, session)
    count = len(db.scalars(select(Page).where(Page.project_id == p.id)).all())
    if body.page >= count:
        raise HTTPException(422, "Page out of range.")
    p.last_page = body.page
    db.commit()
    return {"saved": True}


class Preferences(BaseModel):
    theme: Literal["dark", "light"] = "dark"
    target: str = Field(default="en", max_length=16)
    mode: Literal["single", "double", "scroll"] = "single"
    direction: Literal["rtl", "ltr"] = "rtl"
    quality: Literal["fast", "balanced", "quality"] = "quality"
    style: Literal["faithful", "natural", "literal", "concise"] = "natural"
    fallback_provider: Literal["", "argos", "openai", "ollama", "google", "azure"] = ""


@app.put("/api/preferences")
def preferences(body: Preferences, session=Depends(owner), db=Depends(database)):
    if body.fallback_provider and not capability(body.fallback_provider):
        raise HTTPException(422, "Selected fallback provider is not configured on the server.")
    session.preferences = body.model_dump()
    db.commit()
    return session.preferences


@app.delete("/api/cache")
def clear_cache(session=Depends(owner), db=Depends(database)):
    db.execute(delete(Cache).where(Cache.owner == session.id))
    db.commit()
    return {"deleted": True}


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str, session=Depends(owner), db=Depends(database)):
    p = project_for(db, project_id, session)
    if active(db, p.id):
        raise HTTPException(
            409, "Cancel processing and wait for the running page before deleting."
        )
    remove_project(p.id)
    db.delete(p)
    db.execute(delete(Cache).where(Cache.owner == session.id))
    db.commit()
    return {"deleted": True}


@app.get("/api/projects/{project_id}/metadata")
def metadata(project_id: str, session=Depends(owner), db=Depends(database)):
    p = project_for(db, project_id, session)
    result = serialize_project(db, p)
    for page in result["pages"]:
        page["regions"] = [
            serialize_region(r)
            for r in db.scalars(select(Region).where(Region.page_id == page["id"]))
        ]
    return Response(
        json.dumps(result, ensure_ascii=False),
        media_type="application/json",
        headers={
            "Content-Disposition": 'attachment; filename="mangalens-metadata.json"'
        },
    )


@app.get("/api/projects/{project_id}/export")
def export(
    project_id: str,
    format: Literal["zip", "cbz", "pdf"] = "cbz",
    image_format: Literal["png", "webp"] = "png",
    authorized: bool = False,
    session=Depends(owner),
    db=Depends(database),
):
    p = project_for(db, project_id, session)
    if not authorized:
        raise HTTPException(422, "Confirm export rights before downloading.")
    pages = list(
        db.scalars(select(Page).where(Page.project_id == p.id).order_by(Page.position))
    )
    if any(page.status not in ("completed", "needs_review") for page in pages):
        raise HTTPException(409, "Every page must finish before chapter export.")
    buffer = io.BytesIO()
    if format == "pdf":
        images = [
            Image.open(asset(p.id, page.id, "translated")).convert("RGB")
            for page in pages
        ]
        try:
            images[0].save(
                buffer, format="PDF", save_all=True, append_images=images[1:]
            )
        finally:
            for im in images:
                im.close()
    else:
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as z:
            for i, page in enumerate(pages):
                path = asset(p.id, page.id, "translated")
                if image_format == "png":
                    z.write(path, f"{i+1:04}.png")
                else:
                    encoded = io.BytesIO()
                    with Image.open(path) as im:
                        im.save(encoded, format="WEBP", lossless=True)
                    z.writestr(f"{i+1:04}.webp", encoded.getvalue())
    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="application/pdf" if format == "pdf" else "application/zip",
        headers={"Content-Disposition": f'attachment; filename="mangalens.{format}"'},
    )


class FeedbackBody(BaseModel):
    category: Literal[
        "correct",
        "incorrect_translation",
        "incorrect_ocr",
        "poor_placement",
        "damaged_artwork",
    ]


@app.post("/api/regions/{region_id}/feedback")
def feedback(
    region_id: str, body: FeedbackBody, session=Depends(owner), db=Depends(database)
):
    r = db.get(Region, region_id)
    if not r:
        raise HTTPException(404, "Region not found.")
    page_for(db, r.page_id, session)
    db.add(Feedback(region_id=region_id, category=body.category))
    db.commit()
    return {"saved": True}
