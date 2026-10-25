from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import httpx
import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.config import settings
from app.db import DB, Project, Session, UsageEvent, uid
from app.deepl_client import DeepLError
from app.ocr import identify, recognize_selection, _crop_attempt
from app.ocr_space import OCRSpaceError, reserve_request
from app.rendering import render_page
from app.geometry import rect_mask
from app.translation import cached_translate, deepl_attempt_guard, quality_warnings, used_this_month
from test_cloud_api import _deepl_transport
from test_pipeline_recovery import fixture_page, region


def test_corrected_layout_recovers_rejected_cleanup_from_cache(tmp_path):
    original = fixture_page()
    r = region()
    layer = Image.new("L", original.size)
    ImageDraw.Draw(layer).rectangle((20, 165, 25, 175), fill=255)
    cache = tmp_path / "cleanup"
    with patch("app.rendering.fit_text", return_value=(layer, 12)):
        rejected, _, mask, _ = render_page(original, [r], cache)
    assert not np.asarray(mask).any()
    assert np.array_equal(np.asarray(rejected), np.asarray(original))
    corrected, clean, mask, notes = render_page(original, [r], cache)
    assert not notes[r.id], notes
    assert r.render["diagnostic_status"] == "COMPLETED"
    assert np.asarray(mask).any()
    assert not np.array_equal(np.asarray(corrected), np.asarray(clean))


def test_detected_empty_text_is_ocr_failure_not_cleanup_failure():
    r = region()
    r.source_text = ""
    r.translation = ""
    original = fixture_page()
    output, _, mask, _ = render_page(original, [r])
    assert r.render["diagnostic_status"] == "OCR_FAILED"
    assert r.render["stage_statuses"]["ocr"]["status"] == "OCR_FAILED"
    assert not np.asarray(mask).any()
    assert np.array_equal(np.asarray(output), np.asarray(original))


@pytest.mark.parametrize("target", ["en", "es"])
@pytest.mark.parametrize("text", ["안녕하세요", "你好世界", "こんにちは"])
def test_latin_target_rejects_untranslated_cjk(target, text):
    assert any("source-language" in w for w in quality_warnings(text, text, target))


def test_spanish_punctuation_and_accents_are_valid():
    assert not quality_warnings("こんにちは", "¡Hola! ¿Cómo estás?", "es")


def test_small_script_samples_are_uncertain():
    assert identify("じゃ")[1] < 0.75
    assert identify("네")[1] < 0.75
    assert identify("白鳥")[1] < 0.75
    assert identify("안녕하세요") == ("ko", 0.9)


def test_crop_clamps_padding_and_maps_coordinates():
    image = Image.new("RGB", (100, 80), "white")
    seen = []

    def attempt(crop, lang, psm, name, diagnostics, offset, scale):
        seen.append((crop.size, offset, scale))
        return [{"source_text": "Hello there", "confidence": 0.95,
                 "words": [[offset[0], offset[1], 10, 10]],
                 "box": [offset[0], offset[1], 10, 10]}]

    with patch("app.ocr._languages", return_value=("eng", ["eng"])), patch("app.ocr._attempt", side_effect=attempt):
        result = recognize_selection(image, [-4, -3, 110, 90], "en", manga=False)
    assert seen == [((300, 240), (0, 0), 3)]
    assert result["box"] == [0, 0, 10, 10]


def test_selected_bubble_keeps_all_ocr_blocks_in_reading_order():
    blocks = [
        {"source_text": "second", "confidence": 0.9, "box": [10, 10, 10, 50], "words": [[10, 10, 10, 50]]},
        {"source_text": "first", "confidence": 0.9, "box": [40, 10, 10, 50], "words": [[40, 10, 10, 50]]},
    ]
    with patch("app.ocr._attempt", return_value=blocks):
        result = _crop_attempt(Image.new("RGB", (100, 100)), "jpn_vert", 5, "test", [], (0, 0), 1)
    assert result[0]["source_text"] == "first\nsecond"
    assert len(result[0]["words"]) == 2


def test_negative_outside_mask_never_wraps_to_other_side_of_page():
    assert not rect_mask((100, 100), [-30, 10, 10, 20]).any()
    clipped = rect_mask((100, 100), [-5, -5, 10, 10])
    assert np.count_nonzero(clipped) == 25


def test_auto_korean_crop_is_not_overruled_by_japanese_vertical_model():
    def attempt(image, lang, psm, *args):
        return [{"source_text": "こんにちは" if psm == 5 else "안녕하세요",
                 "confidence": 0.95 if psm == 5 else 0.9,
                 "box": [0, 0, 50, 50], "words": [[0, 0, 50, 50]]}]
    with patch("app.ocr._languages", return_value=("jpn+kor", ["jpn", "jpn_vert", "kor"])), patch("app.ocr._attempt", side_effect=attempt):
        result = recognize_selection(Image.new("RGB", (100, 100), "white"), [0, 0, 100, 100], "auto", manga=False)
    assert result["source_text"] == "안녕하세요"


def create_project(db, provider="deepl"):
    owner = Session(id=uid())
    db.add(owner)
    db.flush()
    project = Project(owner=owner.id, title="Limits", provider=provider, target_lang="en")
    db.add(project)
    db.commit()
    return owner, project


def test_timeout_reservation_stops_next_attempt_at_budget(monkeypatch):
    monkeypatch.setattr(settings, "deepl_api_key", "test:fx")
    monkeypatch.setattr(settings, "deepl_monthly_character_budget", 5)
    monkeypatch.setattr(settings, "fallback_provider", "")
    monkeypatch.setattr("app.translation.account_usage", lambda: {"character_count": 0, "character_limit": 100})
    calls = []

    def timeout(request):
        calls.append(request)
        raise httpx.ReadTimeout("provider did not respond")

    _deepl_transport(monkeypatch, timeout)
    with DB() as db, patch("app.deepl_client.time.sleep"):
        owner, project = create_project(db)
        with pytest.raises(DeepLError, match="budget"):
            cached_translate(db, owner.id, ["こんにちは"], "ja", project, {})
        assert len(calls) == 1
        assert used_this_month(db) == 5
        assert db.query(UsageEvent).filter_by(status="uncertain").count() == 1


def test_deepl_fallback_obeys_same_hard_limit(monkeypatch):
    monkeypatch.setattr(settings, "fallback_provider", "deepl")
    monkeypatch.setattr(settings, "deepl_monthly_character_budget", 0)
    monkeypatch.setattr("app.translation.capability", lambda _: True)
    with DB() as db, patch("app.translation.translate", side_effect=ValueError("offline unavailable")) as model:
        owner, project = create_project(db, "argos")
        with pytest.raises(DeepLError, match="budget"):
            cached_translate(db, owner.id, ["こんにちは"], "ja", project, {})
        assert model.call_count == 1


def test_successful_translation_cache_does_not_reserve_or_send_again(monkeypatch):
    monkeypatch.setattr(settings, "deepl_api_key", "test:fx")
    monkeypatch.setattr(settings, "deepl_monthly_character_budget", 5)
    monkeypatch.setattr("app.translation.account_usage", lambda: {"character_count": 0, "character_limit": 100})
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(200, json={"translations": [{"text": "Hello", "billed_characters": 5}]})
    _deepl_transport(monkeypatch, respond)
    with DB() as db:
        owner, project = create_project(db)
        first = cached_translate(db, owner.id, ["こんにちは"], "ja", project, {})
        second = cached_translate(db, owner.id, ["こんにちは"], "ja", project, {})
        assert first == (["Hello"], "deepl", False)
        assert second == (["Hello"], "deepl", True)
        assert len(calls) == 1 and used_this_month(db) == 5


def test_cancellation_stops_deepl_retry(monkeypatch):
    monkeypatch.setattr(settings, "deepl_api_key", "test:fx")
    monkeypatch.setattr(settings, "deepl_monthly_character_budget", 100)
    monkeypatch.setattr("app.translation.account_usage", lambda: {"character_count": 0, "character_limit": 100})
    calls = []
    with DB() as db:
        owner, project = create_project(db)
        def respond(request):
            calls.append(request)
            with DB() as other:
                other.get(Project, project.id).cancelled = True
                other.commit()
            return httpx.Response(429)
        _deepl_transport(monkeypatch, respond)
        with patch("app.deepl_client.time.sleep"), pytest.raises(InterruptedError):
            cached_translate(db, owner.id, ["こんにちは"], "ja", project, {})
        assert len(calls) == 1 and used_this_month(db) == 0


@pytest.mark.parametrize("provider", ["deepl", "ocr_space"])
def test_simultaneous_reservations_cannot_exceed_shared_budget(monkeypatch, provider):
    monkeypatch.setattr(settings, "deepl_monthly_character_budget", 5)
    monkeypatch.setattr(settings, "ocr_space_daily_request_budget", 1)
    with DB() as db:
        owner, _ = create_project(db)
        owner_id = owner.id

    def reserve(_):
        with DB() as db:
            try:
                if provider == "deepl":
                    deepl_attempt_guard(db, owner_id, ["こんにちは"])[0]()
                else:
                    reserve_request(db, owner_id, 3, 0)
                return True
            except (DeepLError, OCRSpaceError):
                return False

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(reserve, range(2))) == [False, True]
