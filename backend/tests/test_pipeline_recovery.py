import io
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont
from sqlalchemy import select
from app.config import settings
from app.db import DB, Region
from app.main import app
from app.process import run
from app.worker import claim
from app.ocr import recognize
from app.rendering import render_page
from app.translation import quality_warnings
from app.geometry import polygon_mask
from app.geometry import detect_bubbles
from pathlib import Path
from test_api import upload


def fixture_page():
    image = Image.new("RGB", (500, 340), "#bcbcbc")
    draw = ImageDraw.Draw(image)
    draw.ellipse((20, 20, 240, 320), fill="white", outline="black", width=3)
    draw.rectangle((280, 20, 480, 320), fill="white", outline="black", width=3)
    font = ImageFont.truetype(str(settings.font_path), 22)
    for x, text in [(140, "今日は良い"), (110, "天気ですね")]:
        for i, char in enumerate(text):
            draw.text((x, 70 + i * 25), char, font=font, fill="black")
    draw.text((310, 100), "Hello world", font=font, fill="black")
    return image


def region(**kwargs):
    return SimpleNamespace(
        id="r",
        box=[40, 40, 180, 260],
        words=[[108, 70, 58, 140]],
        render={"source_box": [106, 65, 70, 150], **kwargs},
        translation="It is a nice day today.",
        restored=False,
    )


def test_mask_removes_vertical_letters_and_preserves_every_other_pixel():
    image = fixture_page()
    r = region()
    result, clean, mask, notices = render_page(image, [r])
    assert not notices["r"], notices
    a, b, m = np.array(image), np.array(clean), np.array(mask)
    assert m.any()
    assert r.render["mask_status"] == "applied"
    assert r.render["mask_applied_pixels"] == int(np.count_nonzero(m))
    assert r.render["mask_candidate_pixels"] > 0
    assert np.array_equal(a[m == 0], b[m == 0])
    assert np.min(b[75:200, 108:167]) > 220
    changed = np.any(np.array(result) != b, axis=2)
    assert not changed[:40].any() and not changed[:, 220:].any()
    assert np.array_equal(a[:, 250:], np.array(result)[:, 250:])


@pytest.mark.parametrize("language,source", [
    ("ja", "\u3053\u3093\u306b\u3061\u306f"),
    ("ko", "\uc548\ub155\ud558\uc138\uc694"),
    ("zh-CN", "\u4f60\u597d\u4e16\u754c"),
])
def test_verified_cjk_bubble_has_real_mask_clean_and_translation(language, source):
    image = Image.new("RGB", (260, 180), "#c0c0c0")
    draw = ImageDraw.Draw(image)
    draw.ellipse((20, 15, 240, 165), fill="white", outline="black", width=3)
    font = ImageFont.truetype(str(settings.font_path), 26)
    draw.text((70, 70), source, font=font, fill="black")
    r = SimpleNamespace(
        id=language, box=[24, 18, 212, 144], words=[[65, 65, 160, 40]],
        source_text=source, language=language, confidence=1, restored=False,
        translation="Hello there", render={
            "source_box": [64, 64, 170, 48], "source_verified": True,
            "bubble_polygon": [[130, 17], [205, 34], [238, 90], [205, 146],
                               [130, 163], [55, 146], [22, 90], [55, 34]],
        },
    )
    output, clean, mask, notices = render_page(image, [r])
    assert not notices[r.id], notices
    binary = np.asarray(mask) > 0
    assert binary.any()
    assert r.render["mask_applied_pixels"] == int(binary.sum())
    assert np.array_equal(np.asarray(clean)[~binary], np.asarray(image)[~binary])
    assert not np.array_equal(np.asarray(output), np.asarray(clean))


def test_conflicting_ocr_cannot_erase_a_face_or_unconfirmed_artwork():
    image = fixture_page()
    r = region(ocr_agreement=0.13, pipeline_version=2)
    r.confidence = 0.47
    result, clean, mask, notices = render_page(image, [r])
    assert np.array_equal(np.array(result), np.array(image))
    assert not np.array(mask).any()
    assert r.render["mask_status"] == "candidate"
    assert r.render["mask_candidate_pixels"] > 0
    assert r.render["mask_applied_pixels"] == 0
    assert "confirmation" in notices["r"][0]


def test_independent_cloud_and_manga_ocr_can_confirm_low_tesseract_score():
    image = fixture_page()
    r = region(ocr_corroborated=True, ocr_agreement=0.4, pipeline_version=2,
               bubble_polygon=[[130, 22], [210, 70], [235, 170], [210, 270],
                               [130, 320], [50, 270], [22, 170], [50, 70]])
    r.language = "ja"
    r.source_text = "\u4eca\u65e5\u306f\u826f\u3044\u5929\u6c17\u3067\u3059\u306d"
    r.confidence = 0.4
    result, _, mask, notices = render_page(image, [r])
    assert not notices["r"], notices
    assert np.array(mask).any()
    assert r.render["diagnostic_status"] == "COMPLETED"
    assert not np.array_equal(np.array(result), np.array(image))


def test_short_japanese_interjection_stays_reviewable_even_when_ocr_agrees():
    image = fixture_page()
    r = region(ocr_corroborated=True, pipeline_version=2)
    r.language = "ja"
    r.source_text = "\u3058\u3083"
    r.translation = "here"
    r.confidence = 0.9
    result, _, mask, notices = render_page(image, [r])
    assert "Short Japanese" in notices["r"][0]
    assert not np.array(mask).any()
    assert np.array_equal(np.array(result), np.array(image))


def test_extra_pronoun_in_ocr_alternative_requires_translation_review():
    image = fixture_page()
    r = region(ocr_corroborated=True, ocr_semantic_ambiguity=True)
    r.language = "ja"
    r.source_text = "\u767d\u9ce5\u5acc\u3044"
    r.translation = "I hate swans"
    r.confidence = 0.9
    result, _, mask, notices = render_page(image, [r])
    assert "referent" in notices["r"][0]
    assert not np.array(mask).any()
    assert np.array_equal(np.array(result), np.array(image))


def test_sample_short_bubble_needs_text_evidence_for_detection():
    sample = Path(__file__).resolve().parents[2] / "samples/sora-wo-matotte-chapter-34/001.jpg"
    with Image.open(sample) as opened:
        image = opened.convert("RGB")
    evidence = [{"box": [600, 80, 30, 45], "source_text": "\u3058\u3083"}]
    bubbles = detect_bubbles(image, evidence)
    assert any(x <= 610 <= x + w and y <= 100 <= y + h for x, y, w, h in (b["box"] for b in bubbles))


def test_disagreeing_ocr_and_implausibly_short_translation_need_review():
    image = fixture_page()
    r = region(ocr_agreement=0.78)
    r.language = "ja"
    r.source_text = "\u4ffa\u3093\u3061\u6c11\u5bbf\u306a\u3093\u3067"
    r.confidence = 0.96
    r.translation = "Home"
    assert quality_warnings(r.source_text, r.translation, "en")
    result, _, mask, notices = render_page(image, [r])
    assert not np.array(mask).any()
    assert np.array_equal(np.array(result), np.array(image))
    assert "confirmation" in notices["r"][0]

    r.render["ocr_agreement"] = 0.96
    r.confidence = 0.68
    result, _, mask, notices = render_page(image, [r])
    assert not np.array(mask).any()
    assert np.array_equal(np.array(result), np.array(image))
    assert "confirmation" in notices["r"][0]


def test_unassociated_page_block_is_review_only_until_confirmed():
    image = fixture_page()
    r = region(pipeline_version=2)
    r.confidence = 0.95
    result, _, mask, _ = render_page(image, [r])
    assert not np.array(mask).any()
    r.render["source_verified"] = True
    result, _, mask, notes = render_page(image, [r])
    assert np.array(mask).any(), notes


def test_polygon_layout_never_crosses_outline_with_long_translation():
    image = fixture_page()
    r = region(
        bubble_polygon=[
            [130, 24],
            [210, 75],
            [232, 170],
            [200, 280],
            [130, 315],
            [50, 280],
            [24, 170],
            [50, 75],
        ]
    )
    r.box = [20, 20, 220, 300]
    r.translation = (
        "The translated dialogue must stay within this irregular speech bubble."
    )
    result, clean, mask, notices = render_page(image, [r])
    changed = np.any(np.array(result) != np.array(clean), axis=2)
    assert changed.any(), notices
    assert not np.any(
        changed & (polygon_mask((340, 500), r.render["bubble_polygon"], 3) == 0)
    )


def test_mask_exclusion_and_cleanup_cache(tmp_path):
    image = fixture_page()
    r = region(mask_exclude=[[110, 70, 20, 30]])
    cache = tmp_path / "cleanup"
    _, clean, mask, _ = render_page(image, [r], cache)
    assert not np.array(mask)[70:100, 110:130].any()
    r.translation = "A nice day."
    with patch(
        "app.rendering.clean_region",
        side_effect=AssertionError("Font/text edits must reuse cleanup"),
    ):
        render_page(image, [r], cache)


def test_cleanup_cache_owner_mapping_survives_inserted_review_region(tmp_path):
    image = fixture_page()
    r = region()
    cache = tmp_path / "cleanup"
    render_page(image, [r], cache)
    review = SimpleNamespace(
        id="review", box=[280, 20, 180, 200], words=[], source_text="",
        render={}, translation="", restored=False,
    )
    _, clean, mask, _ = render_page(image, [review, r], cache)
    assert not r.render["cleanup_cache_hit"]
    assert r.render["mask_applied_pixels"] == int(np.count_nonzero(np.asarray(mask)))
    assert np.array_equal(np.asarray(clean)[np.asarray(mask) == 0], np.asarray(image)[np.asarray(mask) == 0])


def test_single_region_mask_retry_reuses_other_cleaned_region(tmp_path):
    image = fixture_page()
    left = region()
    right = SimpleNamespace(
        id="right", box=[280, 20, 200, 300], words=[[310, 100, 150, 30]],
        source_text="Hello world", translation="Goodbye", confidence=1,
        language="en", restored=False,
        render={"source_box": [310, 90, 160, 55], "source_verified": True},
    )
    cache = tmp_path / "cleanup"
    first, _, first_mask, first_notes = render_page(image, [left, right], cache)
    assert not first_notes["r"] and not first_notes["right"], first_notes
    assert np.count_nonzero(np.asarray(first_mask)) > 0
    left.render["mask_revision"] = 1
    second, _, second_mask, second_notes = render_page(image, [left, right], cache)
    assert not second_notes["r"] and not second_notes["right"], second_notes
    assert not left.render["cleanup_cache_hit"]
    assert right.render["cleanup_cache_hit"]
    assert np.array_equal(np.asarray(first)[:, 280:], np.asarray(second)[:, 280:])
    assert np.array_equal(np.asarray(first_mask), np.asarray(second_mask))


def test_rejected_cleanup_is_rolled_back_before_cache_write(tmp_path):
    image = fixture_page()
    r = region()
    layer = Image.new("L", image.size)
    ImageDraw.Draw(layer).rectangle((20, 165, 25, 175), fill=255)
    cache = tmp_path / "cleanup"
    with patch("app.rendering.fit_text", return_value=(layer, 12)):
        result, clean, mask, notices = render_page(image, [r], cache)
    assert any("remains" in note for note in notices[r.id])
    assert np.array_equal(np.asarray(result), np.asarray(image))
    assert np.array_equal(np.asarray(clean), np.asarray(image))
    assert not np.asarray(mask).any()
    assert np.array_equal(np.asarray(Image.open(cache.with_suffix(".clean.png"))), np.asarray(image))
    assert not np.asarray(Image.open(cache.with_suffix(".mask.png"))).any()
    with patch("app.rendering.fit_text", return_value=(layer, 12)):
        rerendered, recleaned, remask, retry_notices = render_page(image, [r], cache)
    assert any("remains" in note for note in retry_notices[r.id])
    assert np.array_equal(np.asarray(rerendered), np.asarray(image))
    assert np.array_equal(np.asarray(recleaned), np.asarray(image))
    assert not np.asarray(remask).any()


def test_all_ocr_fallbacks_are_bounded_and_logged():
    empty = {"text": []}
    diagnostics = []
    with patch("app.ocr.installed", return_value=["jpn", "jpn_vert"]), patch(
        "app.ocr.pytesseract.image_to_data", return_value=empty
    ) as engine:
        assert (
            recognize(
                Image.new("RGB", (500, 500), "white"), "ja", diagnostics=diagnostics
            )
            == []
        )
    assert 3 <= engine.call_count <= 15
    assert any("sparse fallback" in d["attempt"] for d in diagnostics)
    assert any("tile fallback" in d["attempt"] for d in diagnostics)


def test_no_recognition_is_reviewable_and_original_is_untouched(client):
    p = upload(client)
    pid = p["pages"][0]["id"]
    original = client.get(p["pages"][0]["original"]).content
    client.post("/api/projects/" + p["id"] + "/start", json={})
    with patch("app.process.recognize", return_value=[]):
        run(claim())
    page = client.get("/api/projects/" + p["id"]).json()["pages"][0]
    assert page["status"] == "needs_review"
    assert "editor" in page["error"]
    assert client.get(page["original"]).content == original
    assert client.get(page["translated"]).status_code == 200


def test_manual_region_ownership_validation_and_retry_preserves_corrections(client):
    p = upload(client)
    pid = p["pages"][0]["id"]
    assert (
        client.post(
            f"/api/pages/{pid}/regions", json={"box": [90, 100, 40, 40]}
        ).status_code
        == 422
    )
    response = client.post(
        f"/api/pages/{pid}/regions", json={"box": [10, 10, 70, 80], "run_ocr": False}
    )
    assert response.status_code == 201, response.text
    r = response.json()
    run(claim())
    saved = {
        "source_text": "手動の修正",
        "translation": "Manual correction",
        "language": "ja",
        "source_verified": True,
    }
    assert client.put("/api/regions/" + r["id"], json=saved).status_code == 200
    run(claim())
    page_after_edit = client.get("/api/projects/" + p["id"]).json()["pages"][0]
    assert page_after_edit["metrics"]["confirmed_text_regions"] == 1
    assert client.post(f"/api/regions/{r['id']}/retry/mask").status_code == 200
    with patch("app.process.recognize", side_effect=AssertionError("Mask retry must reuse OCR")), patch(
        "app.process.cached_translate", side_effect=AssertionError("Mask retry must reuse translation")
    ):
        run(claim())
    after_mask_retry = client.get(f"/api/pages/{pid}/regions").json()[0]
    assert after_mask_retry["id"] == r["id"]
    assert after_mask_retry["translation"] == saved["translation"]
    assert after_mask_retry["render"]["mask_revision"] == 1
    assert after_mask_retry["render"]["last_retry_stage"] == "mask"
    assert (
        client.post(f"/api/pages/{pid}/ocr", json={"source_lang": "ja"}).status_code
        == 200
    )
    with patch("app.process.recognize", return_value=[]):
        run(claim())
    regions = client.get(f"/api/pages/{pid}/regions").json()
    assert (
        regions[0]["id"] == r["id"]
        and regions[0]["source_text"] == saved["source_text"]
    )
    assert regions[0]["translation"] == saved["translation"]
    from fastapi.testclient import TestClient

    other = TestClient(app, headers={"X-MangaLens-Client": "web"})
    other.post("/api/session")
    assert (
        other.post(
            f"/api/pages/{pid}/regions", json={"box": [1, 1, 20, 20]}
        ).status_code
        == 404
    )
    assert other.post("/api/regions/" + r["id"] + "/ocr").status_code == 404


def test_page_ocr_retry_keeps_matching_automatic_region_id(client):
    p = upload(client)
    page_id = p["pages"][0]["id"]
    detected = [{
        "box": [40, 40, 100, 100], "words": [[60, 55, 60, 60]],
        "source_text": "\u4eca\u65e5\u306f\u826f\u3044", "language": "ja", "confidence": 0.9,
        "orientation": "vertical", "render": {"source_box": [60, 55, 60, 60], "pipeline_version": 2},
        "warnings": [],
    }]
    assert client.post("/api/projects/" + p["id"] + "/start", json={}).status_code == 200
    with patch("app.process.recognize", return_value=detected), patch(
        "app.process.cached_translate", return_value=(["Today is good"], "argos", False)
    ):
        run(claim())
        before = client.get(f"/api/pages/{page_id}/regions").json()
        assert len(before) == 1
        assert client.post(f"/api/pages/{page_id}/ocr", json={}).status_code == 200
        run(claim())
    after = client.get(f"/api/pages/{page_id}/regions").json()
    assert after[0]["id"] == before[0]["id"]
    assert after[0]["render"]["ocr_retry_count"] == 1


def test_region_retry_keeps_targeted_cloud_ocr_as_review_suggestion(client, monkeypatch):
    p = upload(client)
    page_id = p["pages"][0]["id"]
    created = client.post(f"/api/pages/{page_id}/regions", json={"box": [10, 10, 70, 80]})
    assert created.status_code == 201
    monkeypatch.setattr(settings, "ocr_space_api_key", "test-key")
    monkeypatch.setattr(settings, "cloud_ocr_provider", "ocr_space")
    local = {"source_text": "", "confidence": 0, "words": [], "box": [10, 10, 70, 80]}
    cloud = [{"box": [5, 5, 20, 30], "source_text": "\u3053\u3093\u306b\u3061\u306f"}]
    with patch("app.process.recognize_selection", return_value=local), patch(
        "app.process.ocr_space_recognize", return_value=cloud
    ) as api:
        run(claim())
    saved = client.get(f"/api/pages/{page_id}/regions").json()[0]
    assert api.call_count == 1
    assert saved["id"] == created.json()["id"]
    assert saved["render"]["ocr_cloud_suggestion"] == "\u3053\u3093\u306b\u3061\u306f"
    assert saved["source_text"] == ""
    assert saved["render"]["ocr_retry_count"] == 1


def test_partial_translation_failure_keeps_successful_region(client):
    image = fixture_page()
    stream = io.BytesIO()
    image.save(stream, "PNG")
    p = upload(client, [("files", ("test.png", stream.getvalue(), "image/png"))])
    client.post("/api/projects/" + p["id"] + "/start", json={"source_lang": "ja"})
    regions = [
        {
            "box": [40, 40, 180, 260],
            "words": [[108, 70, 58, 140]],
            "source_text": "今日は良い天気です",
            "language": "ja",
            "confidence": 0.9,
            "render": {"source_box": [106, 65, 70, 150]},
            "warnings": [],
        },
        {
            "box": [290, 40, 180, 260],
            "words": [[310, 100, 150, 30]],
            "source_text": "こんにちは",
            "language": "ja",
            "confidence": 0.9,
            "render": {},
            "warnings": [],
        },
    ]
    with patch("app.process.recognize", return_value=regions), patch(
        "app.process.cached_translate",
        side_effect=[
            (["It is a nice day."], "argos", False),
            ValueError("One region failed"),
        ],
    ):
        run(claim())
    page = client.get("/api/projects/" + p["id"]).json()["pages"][0]
    assert page["status"] == "needs_review"
    saved = client.get(f"/api/pages/{page['id']}/regions").json()
    assert saved[0]["translation"] == "It is a nice day."
    assert saved[0]["render"]["state"] == "rendering_completed"
    assert saved[1]["render"]["translation_error"] == "One region failed"
    assert saved[1]["render"]["diagnostic_status"] == "TRANSLATION_FAILED"
    assert page["metrics"]["completion"] == "PARTIALLY_COMPLETED"
    assert page["metrics"]["rendered_regions"] == 1
