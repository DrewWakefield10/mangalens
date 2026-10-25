from fastapi.testclient import TestClient
from app.config import settings
from app.main import app


def test_exact_preview_origins_are_allowed_without_wildcards(monkeypatch):
    monkeypatch.setattr(settings, "allowed_origin", "https://mangalens.example.com, https://trusted-preview.vercel.app/")
    with TestClient(app) as client:
        for origin in ("https://mangalens.example.com", "https://trusted-preview.vercel.app"):
            response = client.post("/api/session", headers={"X-MangaLens-Client": "web", "Origin": origin})
            assert response.status_code == 200
            assert "mangalens_session" in response.cookies
        for origin in ("https://untrusted.vercel.app", "https://trusted-preview.vercel.app.attacker.com"):
            response = client.post("/api/session", headers={"X-MangaLens-Client": "web", "Origin": origin})
            assert response.status_code == 403
