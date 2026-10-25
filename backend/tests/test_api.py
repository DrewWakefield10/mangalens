import io
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
import pytest
from PIL import Image
from fastapi.testclient import TestClient
from sqlalchemy import select
from app.config import ROOT, settings
from app.db import DB, Cache, Job, Page, Region
from app.main import app
from app.process import run
from app.storage import unpack, asset
from app.ocr import identify, recognize
from app.rendering import build_text_mask, render_page
from app.sources import validate_url, download
from app.translation import cached_translate, translate
from app.worker import claim


def picture():
    out = io.BytesIO()
    Image.new("RGB", (100, 120), "white").save(out, "PNG")
    return out.getvalue()


def upload(client, files=None):
    response = client.post(
        "/api/projects/upload",
        data={"title": "Test chapter", "authorized": "true"},
        files=files or [("files", ("page.png", picture(), "image/png"))],
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_upload_ownership_and_deletion(client):
    p = upload(client)
    page = p["pages"][0]
    assert client.get(page["original"]).status_code == 200
    other = TestClient(app, headers={"X-MangaLens-Client": "web"})
    other.post("/api/session")
    assert other.get("/api/projects/" + p["id"]).status_code == 404
    assert other.get(page["original"]).status_code == 404
    assert other.delete("/api/projects/" + p["id"]).status_code == 404
    assert client.delete("/api/projects/" + p["id"]).status_code == 200
    assert client.get(page["original"]).status_code == 404
    assert not (settings.data_dir / "projects" / p["id"]).exists()


@pytest.mark.parametrize(
    "name,data",
    [("x.exe", b"MZbad"), ("x.png", b"not an image"), ("x.zip", b"not a zip")],
)
def test_reject_bad_upload(client, name, data):
    assert (
        client.post(
            "/api/projects/upload",
            data={"authorized": "true"},
            files={"files": (name, data)},
        ).status_code
        == 422
    )


def test_permission_and_csrf(client):
    assert (
        client.post(
            "/api/projects/upload", files={"files": ("x.png", picture())}
        ).status_code
        == 422
    )
    assert TestClient(app).post("/api/session").status_code == 403
    assert (
        client.post(
            "/api/session", headers={"Origin": "https://evil.example"}
        ).status_code
        == 403
    )


def test_archive_order_and_traversal():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as z:
        for name in ["10.png", "2.png", "1.png"]:
            z.writestr(name, picture())
    assert [name for name, _ in unpack("chapter.cbz", stream.getvalue())] == [
        "1.png",
        "2.png",
        "10.png",
    ]
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as z:
        z.writestr("../page.png", picture())
    with pytest.raises(ValueError, match="Unsafe"):
        unpack("chapter.zip", stream.getvalue())


def test_zip_bomb():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("page.png", b"0" * 1000000)
    with pytest.raises(ValueError, match="compression"):
        unpack("chapter.zip", stream.getvalue())


def test_pdf():
    out = io.BytesIO()
    Image.new("RGB", (100, 150), "white").save(out, format="PDF")
    pages = unpack("chapter.pdf", out.getvalue())
    assert len(pages) == 1
    assert pages[0][1].size == (200, 300)


def test_pixel_limit(monkeypatch):
    monkeypatch.setattr(settings, "max_pixels", 10)
    with pytest.raises(ValueError, match="pixel"):
        unpack("image.png", picture())


def test_blocked_source(client):
    for url in [
        "http://127.0.0.1/a",
        "https://evil.example/a",
        "file:///etc/passwd",
        "https://localhost/x",
    ]:
        assert (
            client.post(
                "/api/projects/import", json={"url": url, "authorized": True}
            ).status_code
            == 422
        )


def test_private_dns_and_redirect(monkeypatch):
    monkeypatch.setattr(settings, "authorized_source_hosts", "allowed.example")
    with patch(
        "app.sources.socket.getaddrinfo",
        return_value=[(2, 1, 6, "", ("127.0.0.1", 443))],
    ):
        with pytest.raises(ValueError, match="Private"):
            validate_url("https://allowed.example/chapter.json")
    response = SimpleNamespace(
        status=302, getheader=lambda name, default="": "https://127.0.0.1/private"
    )
    connection = SimpleNamespace(
        request=lambda *a, **kw: None, getresponse=lambda: response, close=lambda: None
    )
    with patch(
        "app.sources.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("8.8.8.8", 443))]
    ), patch("app.sources.PinnedHTTPS", return_value=connection):
        with pytest.raises(ValueError, match="not authorized"):
            download("https://allowed.example/x", 100, {"application/json"})


def test_missing_manifest_page(monkeypatch):
    from app.sources import import_manifest

    with patch(
        "app.sources.download",
        side_effect=[
            b'{"pages":["https://allowed.example/1.png","https://allowed.example/2.png"]}',
            picture(),
            ValueError("Source returned HTTP 404"),
        ],
    ):
        with pytest.raises(ValueError, match="404"):
            import_manifest("https://allowed.example/chapter.json")


def test_languages():
    assert identify("こんにちは")[0] == "ja"
    assert identify("안녕하세요")[0] == "ko"
    assert identify("Привет")[0] == "ru"
    assert identify("你好")[0] == "zh-CN"
    assert identify("hello")[0] == "en"


def test_provider_unconfigured(monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "")
    with pytest.raises(ValueError, match="unconfigured"):
        translate(["hello"], "en", "ja", "openai", "natural", {})


def test_start_order_and_cancellation(client):
    p = upload(
        client, [("files", ("2.png", picture())), ("files", ("1.png", picture()))]
    )
    assert p["pages"][0]["name"] == "1.png"
    with patch("app.main.capability", return_value=True):
        assert (
            client.post(
                "/api/projects/" + p["id"] + "/start",
                json={"order": [p["pages"][0]["id"]] * 2},
            ).status_code
            == 422
        )
        assert (
            client.post("/api/projects/" + p["id"] + "/start", json={}).status_code
            == 200
        )
    assert (
        client.post("/api/projects/" + p["id"] + "/start", json={}).status_code == 409
    )
    assert client.delete("/api/projects/" + p["id"]).status_code == 409
    assert client.post("/api/projects/" + p["id"] + "/cancel").status_code == 200
    assert all(
        page["status"] == "cancelled"
        for page in client.get("/api/projects/" + p["id"]).json()["pages"]
    )


def test_failed_ocr_and_retry(client):
    p = upload(client)
    with patch("app.main.capability", return_value=True):
        client.post("/api/projects/" + p["id"] + "/start", json={})
    job = claim()
    assert job
    with patch("app.process.recognize", side_effect=ValueError("OCR unavailable")):
        run(job)
    assert (
        client.get("/api/projects/" + p["id"]).json()["pages"][0]["status"] == "failed"
    )
    assert (
        client.post("/api/pages/" + p["pages"][0]["id"] + "/retry").status_code == 200
    )
    assert claim() is not None


def test_cache_avoids_duplicate_provider_calls(client):
    p = upload(client)
    from app.db import Project

    with DB() as db:
        project = db.get(Project, p["id"])
        project.target_lang = "en"
        with patch("app.translation.translate", return_value=["Hello"]) as model:
            a = cached_translate(db, project.owner, ["こんにちは"], "ja", project, {})
            b = cached_translate(db, project.owner, ["こんにちは"], "ja", project, {})
            assert a[0] == b[0] and b[2] and model.call_count == 1
            cached_translate(
                db, project.owner, ["こんにちは"], "ja", project, {"new": "term"}
            )
            assert model.call_count == 2


def test_overflow_and_missing_glyphs_preserve_original():
    original = Image.new("RGB", (100, 100), "white")
    from PIL import ImageDraw

    ImageDraw.Draw(original).rectangle((14, 14, 22, 25), fill="black")
    for text in ["much too much text " * 100, "\U0001f9d1"]:
        region = SimpleNamespace(
            id="one",
            box=[10, 10, 20, 20],
            words=[[10, 10, 20, 20]],
            render={},
            translation=text,
            restored=False,
        )
        result, clean, mask, notices = render_page(original, [region])
        assert notices["one"]
        assert np.array_equal(np.asarray(result), np.asarray(original))
        assert not np.any(np.asarray(mask))


def test_lease_recovery_and_unique_active_job(client):
    from sqlalchemy.exc import IntegrityError

    p = upload(client)
    page_id = p["pages"][0]["id"]
    with DB() as db:
        job = Job(page_id=page_id, status="running", lease_until=1, attempts=1)
        db.add(job)
        db.commit()
        job_id = job.id
        db.add(Job(page_id=page_id))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
    assert claim() == job_id
    assert claim() is None


@pytest.mark.parametrize("stage", ["translation", "inpainting"])
def test_pipeline_errors_are_explicit(client, stage):
    p = upload(client)
    with patch("app.main.capability", return_value=True):
        client.post("/api/projects/" + p["id"] + "/start", json={})
    job = claim()
    region = {
        "box": [10, 10, 80, 60],
        "words": [[10, 10, 60, 30]],
        "source_text": "hello",
        "language": "en",
        "confidence": 0.9,
        "render": {},
        "warnings": [],
        "orientation": "horizontal",
    }
    with patch("app.process.recognize", return_value=[region]):
        if stage == "translation":
            with patch(
                "app.process.cached_translate",
                side_effect=ValueError("Provider unavailable"),
            ):
                run(job)
        else:
            with patch(
                "app.process.cached_translate", return_value=(["hello"], "argos", False)
            ), patch(
                "app.process.render_page",
                side_effect=RuntimeError("Inpainting failure"),
            ):
                run(job)
    result = client.get("/api/projects/" + p["id"]).json()["pages"][0]
    assert result["status"] == "failed" and result["error"]
    assert client.get(result["translated"]).status_code == 404


def test_streaming_request_limit():
    from app.limits import BodyLimitMiddleware
    from starlette.responses import Response

    async def endpoint(scope, receive, send):
        await Response("ok")(scope, receive, send)

    limited = TestClient(BodyLimitMiddleware(endpoint, max_bytes=10))
    assert limited.post("/", content=(b"123456" for _ in range(3))).status_code == 413


def test_rate_limit(client):
    statuses = [client.post("/api/session").status_code for _ in range(91)]
    assert 429 in statuses


def test_real_japanese_pipeline(client):
    if not (ROOT / "models/argos/ja_en/model/model.bin").exists():
        pytest.skip("Install CPU models with scripts/setup_models.py")
    sample = (ROOT / "samples/japanese-page.png").read_bytes()
    p = upload(client, [("files", ("japanese.png", sample, "image/png"))])
    page = p["pages"][0]
    assert client.get(f"/api/pages/{page['id']}/image/clean?v=0").status_code == 404
    assert (
        client.post(
            "/api/projects/" + p["id"] + "/start",
            json={"source_lang": "ja", "provider": "argos"},
        ).status_code
        == 200
    )
    job = claim()
    run(job)
    p = client.get("/api/projects/" + p["id"]).json()
    page = p["pages"][0]
    assert page["status"] in ("completed", "needs_review"), page["error"]
    assert client.get(f"/api/pages/{page['id']}/image/clean?v={page['revision'] + 1}").status_code == 409
    regions = client.get("/api/pages/" + page["id"] + "/regions").json()
    assert any("天気" in r["source_text"] for r in regions), regions
    assert any("weather" in r["translation"].lower() for r in regions), regions
    original = Image.open(io.BytesIO(client.get(page["original"]).content)).convert(
        "RGB"
    )
    candidate_url = f"/api/regions/{regions[0]['id']}/mask-candidate?v={page['revision']}"
    assert client.get(candidate_url + "1").status_code == 409
    other = TestClient(app, headers={"X-MangaLens-Client": "web"})
    other.post("/api/session")
    assert other.get(candidate_url).status_code == 404
    preview_response = client.get(candidate_url)
    assert preview_response.status_code == 200
    assert preview_response.headers["cache-control"] == "no-store"
    with DB() as db:
        proposed, _ = build_text_mask(np.asarray(original), db.get(Region, regions[0]["id"]))
    assert proposed is not None
    candidate_pixels = proposed["mask"] > 0
    assert int(preview_response.headers["x-mask-candidate-pixels"]) == int(candidate_pixels.sum())
    preview = np.asarray(Image.open(io.BytesIO(preview_response.content)).convert("RGB"))
    assert np.array_equal(preview[~candidate_pixels], np.asarray(original)[~candidate_pixels])
    assert np.any(preview[candidate_pixels] != np.asarray(original)[candidate_pixels])
    result = Image.open(io.BytesIO(client.get(page["translated"]).content)).convert(
        "RGB"
    )
    clean_response = client.get(f"/api/pages/{page['id']}/image/clean?v={page['revision']}")
    mask_response = client.get(f"/api/pages/{page['id']}/image/mask?v={page['revision']}")
    assert clean_response.status_code == mask_response.status_code == 200
    assert clean_response.headers["cache-control"] == "no-store"
    clean = np.asarray(Image.open(io.BytesIO(clean_response.content)).convert("RGB"))
    mask = np.asarray(Image.open(io.BytesIO(mask_response.content)).convert("L"))
    assert np.count_nonzero(mask) > 0
    assert np.array_equal(clean[mask == 0], np.asarray(original)[mask == 0])
    assert result.size == original.size
    assert not np.array_equal(np.asarray(result), np.asarray(original))
    assert np.array_equal(
        np.asarray(result)[340:, :, :], np.asarray(original)[340:, :, :]
    ), "Artwork below the speech bubble must remain exactly unchanged"
    assert (
        client.get("/api/projects/" + p["id"] + "/export?authorized=true").status_code
        == 200
    )
    assert client.get("/api/projects/" + p["id"] + "/export").status_code == 422
    r = regions[0]
    with patch(
        "app.process.recognize", side_effect=AssertionError("Edits must not rerun OCR")
    ), patch(
        "app.process.cached_translate",
        side_effect=AssertionError("Edits must not retranslate"),
    ):
        response = client.put(
            "/api/regions/" + r["id"],
            json={
                "source_text": r["source_text"],
                "translation": "A lovely day.",
                "language": "ja",
            },
        )
        assert response.status_code == 200, response.text
        run(claim())
    assert (
        client.get("/api/pages/" + page["id"] + "/regions").json()[0]["translation"]
        == "A lovely day."
    )
