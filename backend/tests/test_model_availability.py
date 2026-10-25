from unittest.mock import patch
from sqlalchemy import select
from app.config import settings
from app.db import DB, Job, Page
from app.translation import offline_pairs, validate_offline_pair
from test_api import upload
import pytest


def install_fixture(root, pair):
    folder = root / "argos" / pair
    (folder / "model").mkdir(parents=True)
    for name in ("model/model.bin", "sentencepiece.model", "provenance.json"):
        (folder / name).write_bytes(b"test fixture, not a real model")
    return folder


def test_model_discovery_excludes_partial_downloads_and_maps_codes(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(settings, "model_dir", tmp_path)
    folder = install_fixture(tmp_path, "en_ja")
    install_fixture(tmp_path, "zh_en")
    incomplete = install_fixture(tmp_path, "ko_en")
    (incomplete / "sentencepiece.model").unlink()
    assert offline_pairs() == [
        {"source": "en", "target": "ja"},
        {"source": "zh-CN", "target": "en"},
    ]
    (folder / "provenance.json").unlink()
    assert len(offline_pairs()) == 1


def test_missing_pair_never_queues_pages(client, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "model_dir", tmp_path)
    monkeypatch.setattr(settings, "fallback_provider", "")
    install_fixture(tmp_path, "ja_en")
    project = upload(client)
    response = client.post(
        f"/api/projects/{project['id']}/start",
        json={"source_lang": "en", "target_lang": "ja", "provider": "argos"},
    )
    assert response.status_code == 422
    assert "--source en --target ja" in response.json()["detail"]
    with DB() as db:
        assert db.scalars(select(Job)).all() == []
        assert db.get(Page, project["pages"][0]["id"]).status == "imported"
    install_fixture(tmp_path, "en_ja")
    assert (
        client.post(
            f"/api/projects/{project['id']}/start",
            json={"source_lang": "en", "target_lang": "ja"},
        ).status_code
        == 200
    )


def test_health_reports_pairs(client, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "model_dir", tmp_path)
    install_fixture(tmp_path, "en_ja")
    health = client.get("/api/health").json()
    assert health["offline_pairs"] == [{"source": "en", "target": "ja"}]
    assert health["providers"]["argos"]


def test_same_language_auto_and_configured_fallback(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "model_dir", tmp_path)
    monkeypatch.setattr(settings, "fallback_provider", "")
    validate_offline_pair("en", "en")
    validate_offline_pair("auto", "ja")
    with pytest.raises(ValueError):
        validate_offline_pair("en", "ja")
    monkeypatch.setattr(settings, "fallback_provider", "ollama")
    monkeypatch.setattr(settings, "ollama_model", "configured-model")
    validate_offline_pair("en", "ja")


def test_sentencepiece_whitespace_markers_are_decoded():
    from app.tokenization import SentencePieceTokens
    from types import SimpleNamespace

    tokenizer = SentencePieceTokens.__new__(SentencePieceTokens)
    tokenizer.processor = SimpleNamespace(decode=lambda pieces: "▁Bonjour▁monde.")
    assert tokenizer.decode([]) == "Bonjour monde."


def test_moses_bpe_roundtrip(tmp_path):
    from app.tokenization import MosesBPE

    model = tmp_path / "bpe.model"
    model.write_text("#version: 0.2\nH e\nHe l\nHel l\nHell o</w>\n", encoding="utf-8")
    tokenizer = MosesBPE(model, "en", "en")
    assert tokenizer.decode(tokenizer.encode("Hello, world!")) == "Hello, world!"


@pytest.mark.parametrize("pair,precision", [("es_en", "float32"), ("en_ja", "int8")])
def test_local_model_precision(monkeypatch, tmp_path, pair, precision):
    from app.translation import local_model

    monkeypatch.setattr(settings, "model_dir", tmp_path)
    install_fixture(tmp_path, pair)
    local_model.cache_clear()
    try:
        with patch("app.translation.load_tokenizer"), patch(
            "ctranslate2.Translator"
        ) as factory:
            local_model(*pair.split("_"))
        assert factory.call_args.kwargs["compute_type"] == precision
    finally:
        local_model.cache_clear()


def test_offline_truncated_output_is_rejected():
    from types import SimpleNamespace
    from app.translation import translate
    from unittest.mock import Mock

    translator = Mock()
    translator.translate_batch.return_value = [
        SimpleNamespace(hypotheses=[["repeat"] * 512])
    ]
    with patch("app.translation.capability", return_value=True), patch(
        "app.translation.local_model", return_value=(Mock(), translator)
    ):
        with pytest.raises(ValueError, match="output limit"):
            translate(["Hello."], "en", "ja", "argos", "natural", {})
