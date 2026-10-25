import os
from pathlib import Path
import sys
import tempfile
import pytest

temp = tempfile.TemporaryDirectory(prefix="mangalens-tests-")
os.environ["DATABASE_URL"] = "sqlite:///" + (Path(temp.name) / "tests.db").as_posix()
os.environ["DATA_DIR"] = temp.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.db import Base, engine
from app.main import app, rates
from app.config import settings
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def database(monkeypatch):
    # Unit tests never spend the locally configured OCR.space free quota.
    monkeypatch.setattr(settings, "ocr_space_api_key", "")
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    rates.clear()
    yield


@pytest.fixture
def client():
    with TestClient(app, headers={"X-MangaLens-Client": "web"}) as c:
        assert c.post("/api/session").status_code == 200
        yield c


def pytest_sessionfinish(session, exitstatus):
    engine.dispose()
    temp.cleanup()
