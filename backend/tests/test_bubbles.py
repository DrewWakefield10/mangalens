import io
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from app.bubbles import detect_speech_bubbles
from app.config import settings
from app.db import Cache, DB, Job, Project, Region
from app.process import run
from app.worker import claim
from test_api import EMPTY_OCR, scan_and_confirm, upload


def scan_control(with_gap=False):
    image = Image.new("RGB", (620, 460), "#d4d4d4")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(settings.font_path), 23)
    draw.ellipse((65, 36, 241, 224), fill="white", outline="black", width=3)
    if with_gap:
        draw.rectangle((148, 32, 150, 41), fill="#d4d4d4")
    draw.text((102, 102), "こんにちは", font=font, fill="black")
    draw.rectangle((300, 42, 580, 114), fill="white", outline="black", width=3)
    draw.text((336, 62), "NARRATION", font=font, fill="black")
    draw.text((242, 280), "OUTSIDE SOUND EFFECT", font=font, fill="black")
    draw.ellipse((78, 280, 192, 409), fill="white")
    return image


def test_small_outline_gap_and_no_non_speech_candidates():
    for has_gap in (False, True):
        image = scan_control(has_gap)
        bubbles = detect_speech_bubbles(image)
        assert len(bubbles) == 1
        assert bubbles[0]["decision"] == "approved"
        assert bubbles[0]["box"][0] < 110
        ImageDraw.Draw(image).rectangle((58, 26, 248, 236), fill="#d4d4d4")
        assert detect_speech_bubbles(image) == []


def test_confirmation_deselection_and_all_ocr_paths_receive_only_masked_pixels(client, monkeypatch):
    image = scan_control()
    draw = ImageDraw.Draw(image)
    # Mark corners of the crop rectangle, outside its approved diamond.
    draw.rectangle((325, 244, 345, 264), fill="red")
    draw.rectangle((545, 244, 565, 264), fill="red")
    diamond = [[445, 239], [570, 314], [445, 411], [320, 314]]
    draw.rectangle((400, 294, 492, 336), fill="white")
    draw.rectangle((350, 265, 540, 392), fill="white")
    draw.text((405, 308), "話し声", font=ImageFont.truetype(str(settings.font_path), 20), fill="black")
    # Remove the large test sound effect in the diamond area.
    image.paste("#d4d4d4", (243, 280, 350, 308))
    # This test exercises the mask independently of the detector score.
    stream = io.BytesIO()
    image.save(stream, "PNG")
    p = upload(client, [("files", ("test.png", stream.getvalue(), "image/png"))])
    base = "/api/projects/" + p["id"]
    page_url = "/api/pages/" + p["pages"][0]["id"]
    url = page_url + "/bubbles"
    monkeypatch.setattr(settings, "ocr_space_api_key", "test-only")
    n_calls = []

    def assert_masked(crop, *_args, **_kwargs):
        pixels = np.asarray(crop)
        assert tuple(pixels[8, 8]) == (255, 255, 255)
        assert not np.any(np.all(pixels == [255, 0, 0], axis=2))
        n_calls.append(crop.size)
        return EMPTY_OCR

    def cloud(crop, *args, **kwargs):
        assert_masked(crop, *args, **kwargs)
        return [{"box": [85, 65, 60, 30], "source_text": "話し声"}]

    # Use a clean diamond background so the boundary crossing guard does not
    # reject the selected bubble before either recognizer sees it.
    with patch("app.bubble_ocr.recognize_selection", side_effect=assert_masked), patch(
        "app.bubble_ocr.space_recognize", side_effect=cloud
    ), patch("app.process.cached_translate", side_effect=AssertionError("Unverified cloud suggestion")):
        assert client.post(base + "/start", json={}).status_code == 409
        assert client.post(base + "/bubble-scans", json={}).status_code == 200
        run(claim())
        scan = client.get(url).json()
        choices = [{**item, "decision": "dismissed"} for item in scan["bubbles"]]
        assert choices
        choice = {"polygon": diamond, "decision": "approved"}
        assert client.put(url, json={"revision": scan["revision"], "bubbles": choices + [choice]}).status_code == 422
        saved = client.put(url, json={"revision": scan["revision"], "bubbles": choices}).json()
        assert saved["reviewed"] is False
        assert client.post(base + "/start", json={}).status_code == 409
        saved = client.put(url, json={"revision": saved["revision"],
            "bubbles": choices + [{**choice, "confirmed": True}]}).json()
        assert saved["reviewed"] and n_calls == []
        assert client.post(base + "/start", json={"source_lang": "ja"}).status_code == 200
        run(claim())
        regions = client.get(page_url + "/regions").json()
        assert len(regions) == 1 and regions[0]["render"]["ocr_cloud_suggestion"] == "話し声"
        assert len(n_calls) == 2
        assert client.post(f"/api/regions/{regions[0]['id']}/ocr").status_code == 200
        run(claim())
        assert client.post(page_url + "/ocr", json={}).status_code == 200
        run(claim())
        assert len(n_calls) == 6


def test_boundary_edit_reuses_other_bubble_and_blocks_legacy_context(client):
    left = [[5, 5], [42, 5], [42, 110], [5, 110]]
    right = [[55, 5], [95, 5], [95, 110], [55, 110]]
    p = upload(client)
    page_id = p["pages"][0]["id"]
    with DB() as db:
        old = Region(page_id=page_id, position=10, source_text="OLD OUTSIDE TEXT",
                     language="en", confidence=1, box=[1, 1, 90, 110])
        project = db.get(Project, p["id"])
        db.add(old)
        db.add(Cache(owner=project.owner, key="manga-ocr-v4", value={"regions": [{"source_text": old.source_text}]}))
        db.commit()
        old_id = old.id
    assert client.post(f"/api/regions/{old_id}/retranslate").status_code == 409
    assert client.post(f"/api/pages/{page_id}/retry").status_code == 409
    with DB() as db:
        job = Job(page_id=page_id, kind="translate")
        db.add(job)
        db.commit()
        job_id = job.id
    with patch("app.bubble_ocr.recognize_selection", side_effect=AssertionError("Unapproved legacy OCR")) as ocr:
        run(job_id)
        ocr.assert_not_called()
    scan_and_confirm(client, p, [left, right])
    base = "/api/projects/" + p["id"]
    page_url = f"/api/pages/{page_id}"
    url = page_url + "/bubbles"
    ocr_result = {"source_text": "今日は", "confidence": 0.9,
                  "box": [4, 10, 25, 20], "words": [[4, 10, 25, 20]]}
    def translate(_db, _owner, texts, _source, _project, _glossary, context, **kwargs):
        assert texts == ["今日は"]
        assert "OUTSIDE" not in context
        assert kwargs["bubble_scope"][2]
        return ["Hello."], "argos", False

    with patch("app.bubble_ocr.recognize_selection", return_value=ocr_result) as ocr, patch(
        "app.process.cached_translate", side_effect=translate
    ) as translation:
        assert client.post(base + "/start", json={"source_lang": "ja"}).status_code == 200
        run(claim())
        assert ocr.call_count == translation.call_count == 2
        regions = client.get(page_url + "/regions").json()
        assert {r["id"] for r in regions}.isdisjoint({old_id})
        scan = client.get(url).json()
        changed = {**scan["bubbles"][0], "polygon": [[6, 6], [42, 6], [42, 111], [6, 111]], "confirmed": True}
        assert client.put(url, json={"revision": scan["revision"], "bubbles": [changed, scan["bubbles"][1]]}).status_code == 200
        assert client.put(url, json={"revision": scan["revision"], "bubbles": scan["bubbles"]}).status_code == 409
        assert client.post(page_url + "/retry?changed_only=true").status_code == 200
        run(claim())
        updated = client.get(page_url + "/regions").json()
        assert [r["id"] for r in updated] == [r["id"] for r in regions]
        assert ocr.call_count == translation.call_count == 3
        assert updated[0]["render"]["bubble_polygon"] == regions[0]["render"]["bubble_polygon"]


def test_cut_lettering_is_kept_and_ocr_is_skipped(client):
    image = Image.new("RGB", (100, 120), "white")
    ImageDraw.Draw(image).line((5, 37, 58, 37), fill="black", width=4)
    stream = io.BytesIO()
    image.save(stream, "PNG")
    project = upload(client, [("files", ("crossing.png", stream.getvalue(), "image/png"))])
    polygon = [[12, 12], [87, 12], [87, 108], [12, 108]]
    scan_and_confirm(client, project, [polygon])
    base = "/api/projects/" + project["id"]
    with patch("app.bubble_ocr.recognize_selection") as ocr, patch("app.process.cached_translate") as translate:
        assert client.post(base + "/start", json={"source_lang": "ja"}).status_code == 200
        run(claim())
        ocr.assert_not_called()
        translate.assert_not_called()
    page = client.get(base).json()["pages"][0]
    assert page["status"] == "needs_review"
    assert page["metrics"]["detection_outcome"] == "BUBBLE_BOUNDARY_REVIEW"
    assert client.get(page["translated"]).content == client.get(page["original"]).content
