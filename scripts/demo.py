"""Run the real HTTP → database worker → rendered output demonstration."""

import argparse
import json
from pathlib import Path
import time
import urllib.request
import httpx

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    output = ROOT / "data/demo"
    output.mkdir(parents=True, exist_ok=True)
    with httpx.Client(
        base_url=args.api, headers={"X-MangaLens-Client": "web"}, timeout=90
    ) as client:
        client.post("/api/session").raise_for_status()
        with (ROOT / "samples/japanese-page.png").open("rb") as f:
            response = client.post(
                "/api/projects/upload",
                data={
                    "title": "The weather today · real CPU demo",
                    "authorized": "true",
                },
                files={"files": ("japanese-page.png", f, "image/png")},
            )
        response.raise_for_status()
        project = response.json()
        pid = project["id"]
        client.post(
            "/api/projects/" + pid + "/start",
            json={"source_lang": "ja", "provider": "argos"},
        ).raise_for_status()
        started = time.monotonic()
        while time.monotonic() - started < 180:
            project = client.get("/api/projects/" + pid).json()
            page = project["pages"][0]
            if page["status"] in ("completed", "needs_review", "failed"):
                break
            time.sleep(1)
        if page["status"] not in ("completed", "needs_review"):
            raise RuntimeError(page)
        regions = client.get("/api/pages/" + page["id"] + "/regions").json()
        for kind in ["original", "translated", "clean", "mask"]:
            response = client.get("/api/pages/" + page["id"] + "/image/" + kind)
            response.raise_for_status()
            (output / (kind + ".png")).write_bytes(response.content)
        report = {
            "project": project,
            "regions": regions,
            "total_seconds": round(time.monotonic() - started, 2),
        }
        (output / "report.json").write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(
            json.dumps(
                {
                    "result": page["status"],
                    "regions": len(regions),
                    "seconds": report["total_seconds"],
                    "output": str(output),
                },
                indent=2,
            )
        )


if __name__ == "__main__":
    main()
