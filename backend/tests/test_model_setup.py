import importlib.util
from pathlib import Path
import zipfile
import pytest

spec = importlib.util.spec_from_file_location(
    "setup_models", Path(__file__).resolve().parents[2] / "scripts/setup_models.py"
)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


def package(source, target, version="1.0"):
    return {
        "from_code": source,
        "to_code": target,
        "package_version": version,
        "links": [f"https://models.example/{source}_{target}.argosmodel"],
    }


def test_bulk_selection_limits_languages_and_uses_latest_version():
    candidates = [
        package("en", "ja"),
        package("en", "ja", "1.2"),
        package("es", "pt"),
        package("en", "xx"),
        package("en", "en"),
    ]
    selected = setup.select_packages(candidates, "ja", "en", True)
    assert [(p["from_code"], p["to_code"], p["package_version"]) for p in selected] == [
        ("en", "ja", "1.2"),
        ("es", "pt", "1.0"),
    ]


@pytest.mark.parametrize("tokenizer", ["sentencepiece.model", "bpe.model"])
def test_installer_does_not_publish_partial_package(monkeypatch, tmp_path, tokenizer):
    monkeypatch.setattr(setup, "ROOT", tmp_path)
    monkeypatch.setattr(setup, "fetch", lambda *args: None)
    (tmp_path / "models").mkdir()
    archive = tmp_path / "models/en_ja.argosmodel"
    with zipfile.ZipFile(archive, "w") as file:
        file.writestr("package/model/model.bin", b"test fixture")
    with pytest.raises(ValueError, match="lacks"):
        setup.install_package(package("en", "ja"))
    assert not (tmp_path / "models/argos/en_ja/provenance.json").exists()
    with zipfile.ZipFile(archive, "w") as file:
        file.writestr("package/model/model.bin", b"test fixture")
        file.writestr("package/" + tokenizer, b"test tokenizer fixture")
    assert setup.install_package(package("en", "ja"))["status"] == "installed"
    assert setup.install_package(package("en", "ja"))["status"] == "already_installed"
