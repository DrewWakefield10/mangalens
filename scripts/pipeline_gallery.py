"""Build a local, shareable HTML index of actual verification outputs."""

import argparse
import html
import json
from pathlib import Path


def build(folder):
    report = json.loads((folder / "report.json").read_text(encoding="utf8"))
    cards = []
    for page in report:
        name = html.escape(page["name"])
        stem = html.escape(Path(page["name"]).stem, quote=True)
        rendered = sum(
            bool(r["render"].get("actual_font_size")) for r in page["regions"]
        )
        rows = "".join(
            "<tr><td>"
            + html.escape(r["source_text"])
            + "</td><td>"
            + html.escape(r["translation"])
            + "</td><td>"
            + html.escape("; ".join(r["warnings"]))
            + "</td></tr>"
            for r in page["regions"]
        )
        cards.append(
            f'<section><h2>{name} — {page["status"]}</h2><p>{rendered} rendered / {len(page["regions"])} proposed regions · {page["seconds"]}s</p><div class="images">'
            + "".join(
                f'<figure><figcaption>{kind}</figcaption><a href="{stem}/{kind}.png"><img loading="lazy" src="{stem}/{kind}.png" alt="{name} {kind}"></a></figure>'
                for kind in ["original", "clean", "translated"]
            )
            + f'</div><p><a href="{stem}/mask.png">Text mask</a> · <a href="{stem}/comparison.png">Full comparison</a></p><details><summary>OCR, translation and review notes</summary><table><thead><tr><th>Source OCR</th><th>Model translation</th><th>Review</th></tr></thead><tbody>{rows}</tbody></table></details></section>'
        )
    body = (
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>MangaLens real-page verification</title><style>body{font:16px system-ui;background:#111116;color:#e9e8ed;margin:24px}h1{font-size:28px}section{margin:36px 0;border-top:1px solid #555;padding-top:18px}.images{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}figure{margin:0}figcaption{padding:10px}img{width:100%;height:auto}a{color:#c3b0ff}table{border-collapse:collapse;width:100%;margin-top:12px}td,th{border:1px solid #555;padding:10px;text-align:left;vertical-align:top}td{white-space:pre-wrap}summary{cursor:pointer}p{color:#bdbbc8}@media(max-width:650px){.images{grid-template-columns:1fr}}</style><h1>MangaLens: real-page verification</h1><p>Actual local OCR → Argos translation → cleanup → typesetting. Uncertain regions remain original. This is a functional inspection, not a translation accuracy certification. Click an image for full resolution.</p>'
        + "".join(cards)
        + "</html>"
    )
    (folder / "index.html").write_text(body, encoding="utf8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", type=Path)
    build(parser.parse_args().folder)
