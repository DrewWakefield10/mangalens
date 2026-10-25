"""OCR.space free-tier contracts and local quota guards; no live API calls."""

import httpx
import numpy as np
from PIL import Image
import pytest

from app.config import settings
from app.db import DB, Session, UsageEvent, uid
from app.ocr import identify
from app.ocr_space import (
    MAX_UPLOAD_BYTES, OCRSpaceError, Tile, deduplicate, engine_for,
    language_for, parse_response, prepare_tiles, recognize, recognize_tile,
    reserve_request, finish_request,
)
from app.translation import usage_summary


def test_engine_selection_and_documented_codes():
    assert engine_for("ja") == 3
    assert engine_for("ko") == 3
    assert engine_for("auto") == 3
    assert engine_for("zh-CN") == 2
    assert engine_for("zh-TW") == 2
    assert language_for("zh-TW", 2) == "cht"
    assert language_for("ja", 3) == "jpn"
    assert language_for("auto", 3) == "auto"
    assert identify("今天天氣很好")[0] == "zh-TW"
    assert identify("今天天气很好")[0] == "zh-CN"
    assert identify("你好")[1] < 0.5


def test_overlay_geometry_and_no_fabricated_confidence():
    response = {"OCRExitCode": 1, "IsErroredOnProcessing": False, "ParsedResults": [{
        "FileParseExitCode": 1,
        "TextOverlay": {"Lines": [{"LineText": "いよいよ", "Words": [
            {"WordText": "いよいよ", "Left": 12, "Top": 25, "Width": 15, "Height": 58},
        ]}]},
    }]}
    region = parse_response(response, Tile(b"image", 100, 200, 400, 500), "ja", 3)[0]
    assert region["box"] == [112, 225, 15, 58]
    assert region["source_text"] == "いよいよ"
    assert region["confidence"] == 0
    assert region["ocr_confidence_available"] is False


def test_tiles_respect_free_file_limit_and_preserve_coordinates():
    random = np.random.default_rng(14).integers(0, 256, (1800, 1800, 3), dtype=np.uint8)
    tiles = prepare_tiles(Image.fromarray(random))
    assert len(tiles) > 1
    assert all(len(tile.image) <= MAX_UPLOAD_BYTES for tile in tiles)
    assert any(tile.x or tile.y for tile in tiles)


def test_tile_overlap_deduplicates_matching_text():
    a = {"box": [100, 200, 30, 50], "source_text": "ありがとう"}
    b = {"box": [102, 202, 30, 50], "source_text": "ありがとう"}
    c = {"box": [300, 200, 30, 50], "source_text": "ありがとう"}
    assert deduplicate([a, b, c]) == [a, c]


def test_free_endpoint_uses_server_header_and_records_attempt(monkeypatch):
    monkeypatch.setattr(settings, "ocr_space_api_key", "secret-test")
    seen = []

    def handler(request):
        assert request.url == httpx.URL("https://api.ocr.space/parse/image")
        assert request.headers["apikey"] == "secret-test"
        assert b'name="OCREngine"' in request.content
        return httpx.Response(200, json={"OCRExitCode": 1, "IsErroredOnProcessing": False, "ParsedResults": [{
            "FileParseExitCode": 1,
            "TextOverlay": {"Lines": [{"LineText": "你好", "Words": [
                {"WordText": "你好", "Left": 1, "Top": 2, "Width": 20, "Height": 10},
            ]}]},
        }]})

    real_client = httpx.Client
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr("app.ocr_space.httpx.Client", lambda **kwargs: real_client(transport=transport, **kwargs))
    result = recognize_tile(Tile(b"jpeg", 0, 0, 50, 50), "zh-CN", 2,
                            lambda engine: seen.append(engine) or "event",
                            lambda event, status: seen.append((event, status)))
    assert result[0]["source_text"] == "你好"
    assert seen == [2, ("event", "completed")]


def test_throttle_does_not_echo_key_or_retry(monkeypatch):
    monkeypatch.setattr(settings, "ocr_space_api_key", "secret-test")
    real_client = httpx.Client
    transport = httpx.MockTransport(lambda request: httpx.Response(503, json={"error": "secret-test throttled"}))
    monkeypatch.setattr("app.ocr_space.httpx.Client", lambda **kwargs: real_client(transport=transport, **kwargs))
    statuses = []
    with pytest.raises(OCRSpaceError, match="throttled") as caught:
        recognize_tile(Tile(b"jpeg", 0, 0, 50, 50), "ja", 3,
                       lambda engine: "event",
                       lambda event, status: statuses.append(status))
    assert "secret-test" not in str(caught.value)
    assert statuses == ["rate_limited"]


def test_engine_2_overload_uses_free_engine_3_fallback(monkeypatch):
    monkeypatch.setattr(settings, "ocr_space_api_key", "secret-test")
    monkeypatch.setattr(settings, "ocr_space_engine3_fallback", True)
    real_client = httpx.Client
    engines = []

    def handler(request):
        engine = 2 if b'name="OCREngine"\r\n\r\n2' in request.content else 3
        engines.append(engine)
        if engine == 2:
            return httpx.Response(503, json={"error": "free server overloaded"})
        return httpx.Response(200, json={"OCRExitCode": 1, "IsErroredOnProcessing": False,
            "ParsedResults": [{"FileParseExitCode": 1, "TextOverlay": {"Lines": [{
                "LineText": "你好", "Words": [{"WordText": "你好", "Left": 1, "Top": 2,
                                              "Width": 20, "Height": 10}],
            }]}}]})

    monkeypatch.setattr("app.ocr_space.httpx.Client", lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr("app.ocr_space.prepare_tiles", lambda image: [Tile(b"jpeg", 0, 0, 50, 50)])
    statuses = []
    regions = recognize(Image.new("RGB", (50, 50)), "zh-CN",
                        lambda engine: str(engine),
                        lambda event, status: statuses.append((event, status)))
    assert engines == [2, 3]
    assert statuses == [("2", "rate_limited"), ("3", "completed")]
    assert regions[0]["source_text"] == "你好"


def test_reservations_count_failures_and_stop_at_local_budget(monkeypatch):
    monkeypatch.setattr(settings, "ocr_space_page_request_budget", 2)
    monkeypatch.setattr(settings, "ocr_space_daily_request_budget", 2)
    monkeypatch.setattr(settings, "ocr_space_monthly_request_budget", 2)
    monkeypatch.setattr(settings, "ocr_space_engine3_monthly_budget", 1)
    with DB() as db:
        owner = Session(id=uid())
        db.add(owner)
        db.commit()
        first = reserve_request(db, owner.id, 3, 0)
        finish_request(db, first, "rate_limited")
        with pytest.raises(OCRSpaceError, match="budget"):
            reserve_request(db, owner.id, 3, 1)
        second = reserve_request(db, owner.id, 2, 1)
        finish_request(db, second, "completed")
        with pytest.raises(OCRSpaceError, match="budget"):
            reserve_request(db, owner.id, 2, 2)
        assert db.query(UsageEvent).filter(UsageEvent.provider.like("ocr_space_%")).count() == 2


def test_usage_reports_server_wide_ocr_budget_across_sessions():
    with DB() as db:
        first, second = Session(id=uid()), Session(id=uid())
        db.add_all([first, second])
        db.commit()
        db.add(UsageEvent(owner=second.id, provider="ocr_space_3", kind="ocr", status="completed"))
        db.commit()
        summary = usage_summary(db, first.id)["ocr_space"]
        assert summary["requests_month"] == 1
        assert summary["engine_3_requests"] == 1

