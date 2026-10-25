"""Contract tests for optional cloud services; no test contacts a paid API."""

from unittest.mock import patch
import httpx
import pytest
from app.config import settings
from app.db import DB, Project, Session, UsageEvent, uid
from app.deepl_client import DeepLError, account_usage, translate_texts
from app.cloud_ocr import parse_vision
from app.translation import cached_translate, check_deepl_budget, translate, capability

REAL_CLIENT = httpx.Client


def _deepl_transport(monkeypatch, handler):
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "app.deepl_client.httpx.Client",
        lambda **kwargs: REAL_CLIENT(transport=transport, **kwargs),
    )


def test_deepl_free_endpoint_auto_detection_context_and_rate_retry(monkeypatch):
    monkeypatch.setattr(settings, "deepl_api_key", "test-key:fx")
    requests = []

    def respond(request):
        requests.append(request)
        assert request.url.host == "api-free.deepl.com"
        assert request.headers["Authorization"] == "DeepL-Auth-Key test-key:fx"
        body = __import__("json").loads(request.content)
        assert "source_lang" not in body
        assert body["target_lang"] == "EN-US"
        assert body["context"] == "Earlier dialogue."
        if len(requests) == 1:
            return httpx.Response(429, json={"message": "too many"})
        return httpx.Response(200, json={"translations": [{"text": "Hello.", "detected_source_language": "JA", "billed_characters": 5}]})

    _deepl_transport(monkeypatch, respond)
    with patch("app.deepl_client.time.sleep"):
        output, meta = translate_texts(["test"], "auto", "en", "Earlier dialogue.")
    assert output == ["Hello."]
    assert meta["detected_languages"] == ["JA"]
    assert meta["rate_limit_responses"] == 1
    assert len(requests) == 2


def test_deepl_auth_and_quota_errors_do_not_echo_credentials(monkeypatch):
    monkeypatch.setattr(settings, "deepl_api_key", "secret-test:fx")
    for status, expected in [(403, "key"), (456, "quota")]:
        _deepl_transport(monkeypatch, lambda request: httpx.Response(status, json={"message": "secret-test:fx"}))
        with pytest.raises(DeepLError, match=expected) as exc:
            translate_texts(["Hello"], "en", "ja")
        assert "secret-test" not in str(exc.value)


def test_deepl_usage_and_budget(monkeypatch):
    monkeypatch.setattr(settings, "deepl_api_key", "test-key:fx")
    _deepl_transport(monkeypatch, lambda request: httpx.Response(200, json={"character_count": 13, "character_limit": 1000}))
    assert account_usage() == {"character_count": 13, "character_limit": 1000}
    monkeypatch.setattr(settings, "deepl_monthly_character_budget", 5)
    with DB() as db:
        with pytest.raises(DeepLError, match="budget"):
            check_deepl_budget(db, ["six123"])


def test_explicit_fallback_is_used_and_cached_after_deepl_quota_failure(monkeypatch):
    monkeypatch.setattr(settings, "fallback_provider", "")
    monkeypatch.setattr(settings, "deepl_monthly_character_budget", 1000)
    monkeypatch.setattr("app.translation.account_usage", lambda: {"character_count": 100, "character_limit": 100})
    monkeypatch.setattr("app.translation.capability", lambda provider: provider in {"deepl", "argos"})
    with DB() as db:
        owner = Session(id=uid(), preferences={"fallback_provider": "argos"})
        db.add(owner)
        db.flush()
        project = Project(owner=owner.id, title="Fallback", provider="deepl", target_lang="en")
        db.add(project)
        db.commit()
        with patch("app.translation.translate", return_value=["Thank you."]) as model:
            first = cached_translate(db, owner.id, ["ありがとう"], "ja", project, {})
            second = cached_translate(db, owner.id, ["ありがとう"], "ja", project, {})
        assert first == (["Thank you."], "argos", False)
        assert second == (["Thank you."], "argos", True)
        assert model.call_count == 1
        assert db.query(UsageEvent).filter_by(provider="deepl", status="failed").count() == 2


def test_cloud_ocr_paragraphs_keep_geometry_and_language():
    document = {"fullTextAnnotation": {"pages": [{"blocks": [{"paragraphs": [{
        "boundingBox": {"vertices": [{"x": 10, "y": 20}, {"x": 70, "y": 20}, {"x": 70, "y": 90}, {"x": 10, "y": 90}]},
        "confidence": 0.91,
        "property": {"detectedLanguages": [{"languageCode": "ja", "confidence": 0.96}]},
        "words": [{"symbols": [{"text": "あ"}, {"text": "り"}], "boundingBox": {"vertices": [{"x": 20, "y": 30}, {"x": 30, "y": 30}, {"x": 30, "y": 60}, {"x": 20, "y": 60}]}}],
    }]}]}]}}
    regions = parse_vision(document)
    assert len(regions) == 1
    assert regions[0]["source_text"] == "あり"
    assert regions[0]["box"] == [10, 20, 60, 70]
    assert regions[0]["cloud_language"] == "ja"


def test_usage_api_reports_counts_without_secrets(client, monkeypatch):
    monkeypatch.setattr("app.main.account_usage", lambda: {"character_count": 29, "character_limit": 1000})
    response = client.get("/api/usage")
    assert response.status_code == 200
    assert response.json()["deepl"]["account"]["character_count"] == 29
    assert "api_key" not in response.text.lower()
    assert "auth" not in response.text.lower()


def test_fallback_preference_rejects_unconfigured_provider(client, monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "")
    response = client.put("/api/preferences", json={"fallback_provider": "openai"})
    assert response.status_code == 422


def test_cloud_ocr_rejects_missing_key_before_network(monkeypatch):
    from PIL import Image
    from app.cloud_ocr import recognize, CloudOCRError

    monkeypatch.setattr(settings, "google_vision_api_key", "")
    with patch("app.cloud_ocr.httpx.Client", side_effect=AssertionError("network called")):
        with pytest.raises(CloudOCRError, match="not configured"):
            recognize(Image.new("RGB", (100, 100), "white"))


def test_azure_fallback_uses_official_api_only_when_configured(monkeypatch):
    monkeypatch.setattr(settings, "azure_translator_key", "")
    assert not capability("azure")
    monkeypatch.setattr(settings, "azure_translator_key", "test-key")
    monkeypatch.setattr(settings, "azure_translator_endpoint", "https://api.cognitive.microsofttranslator.com")

    def respond(request):
        assert request.url.host == "api.cognitive.microsofttranslator.com"
        assert request.url.params["api-version"] == "3.0"
        assert request.url.params["to"] == "ja"
        assert request.headers["Ocp-Apim-Subscription-Key"] == "test-key"
        return httpx.Response(200, json=[{"translations": [{"text": "こんにちは"}]}])

    transport = httpx.MockTransport(respond)
    monkeypatch.setattr("app.translation.httpx.Client", lambda **kwargs: REAL_CLIENT(transport=transport, **kwargs))
    assert translate(["Hello"], "en", "ja", "azure", "natural", {}) == ["こんにちは"]
