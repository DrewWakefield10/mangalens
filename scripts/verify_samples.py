"""Run real OCR/translation/reconstruction and keep local comparison artifacts.

Uses a separate verification database, never edits an existing user's chapter.
No predetermined OCR or translation is substituted for model output.
"""

import argparse
import os
from pathlib import Path
import sys
import json
import time
import hashlib
from types import SimpleNamespace
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--samples", type=Path, default=ROOT / "samples/sora-wo-matotte-chapter-34"
    )
    parser.add_argument(
        "--pages", nargs="*", help="File stems, for example 001 004 013"
    )
    parser.add_argument(
        "--output", type=Path, default=ROOT / "data/qa/pipeline/real-pages"
    )
    parser.add_argument("--provider", choices=("argos", "deepl"), default="argos")
    parser.add_argument('--render-only',action='store_true',help='Reuse the last verification project OCR/translation and validate updated rendering.')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    os.environ["DATABASE_URL"] = (
        "sqlite:///" + (args.output / "verification.sqlite").resolve().as_posix()
    )
    os.environ["DATA_DIR"] = str((args.output / "work").resolve())
    from app.db import Base, engine, DB, Session, Project, Page, Region, Job, uid
    from app.storage import save_original, asset
    from app.process import run
    from app.rendering import usable_area
    from sqlalchemy import select

    Base.metadata.create_all(engine)
    report = []
    with DB() as db:
        if args.render_only:
            project=db.scalar(select(Project).order_by(Project.created.desc()).limit(1))
            if not project:raise ValueError('No existing verification project to render.')
        else:
            owner = Session(id=uid())
            db.add(owner)
            db.flush()
            project = Project(
                owner=owner.id,
                title="Local pipeline verification",
                source_lang="ja",
                target_lang="en",
                provider=args.provider,
                quality="quality" if args.provider == "deepl" else "balanced",
            )
            db.add(project)
            db.commit()
        project_id = project.id
    files = [
        p
        for p in sorted(args.samples.iterdir())
        if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")
        and (not args.pages or p.stem in args.pages)
    ]
    for index, path in enumerate(files):
        started = time.monotonic()
        original = Image.open(path).convert("RGB")
        checksum = hashlib.sha256(path.read_bytes()).hexdigest()
        with DB() as db:
            if args.render_only:
                page=db.scalar(select(Page).where(Page.project_id==project_id,Page.name==path.name))
                if not page:continue
            else:
                page = Page(
                    id=uid(),
                    project_id=project_id,
                    position=index,
                    name=path.name,
                    width=original.width,
                    height=original.height,
                    digest="",
                )
                page.digest = save_original(project_id, page.id, original)
                db.add(page)
                db.flush()
            job = Job(page_id=page.id, status="running",kind='render' if args.render_only else 'translate')
            db.add(job)
            db.commit()
            page_id = page.id
            job_id = job.id
        run(job_id)
        folder = args.output / path.stem
        folder.mkdir(exist_ok=True)
        with DB() as db:
            page = db.get(Page, page_id)
            regions = list(
                db.scalars(
                    select(Region)
                    .where(Region.page_id == page_id)
                    .order_by(Region.position)
                )
            )
            images = []
            for kind in ("original", "clean", "translated", "mask"):
                location = asset(project_id, page_id, kind)
                if location.exists():
                    im = Image.open(location).convert("RGB")
                    im.save(folder / (kind + ".png"))
                    images.append((kind, im))
            item = {
                "name": path.name,
                "status": page.status,
                "error": page.error,
                "metrics": page.metrics,
                "seconds": round(time.monotonic() - started, 2),
                "regions": [
                    {
                        "id": r.id,
                        "box": r.box,
                        "source_text": r.source_text,
                        "translation": r.translation,
                        "confidence": r.confidence,
                        "warnings": r.warnings,
                        "render": r.render,
                    }
                    for r in regions
                ],
            }
            assert (
                hashlib.sha256(path.read_bytes()).hexdigest() == checksum
            ), "Original sample was modified"
            if len(images) == 4:
                a, clean, out, mask = [np.asarray(im) for _, im in images]
                cleanup = mask[:, :, 0] > 0
                safe_text_area = np.zeros(cleanup.shape, dtype=bool)
                for region in regions:
                    if region.render.get("actual_font_size") is not None:
                        safe_text_area |= usable_area(original, region) > 0
                item["unchanged_outside_cleanup_mask"] = bool(
                    np.array_equal(
                        a[~cleanup], clean[~cleanup]
                    )
                )
                item["typography_inside_safe_regions"] = bool(
                    not np.any(np.any(out != clean, axis=2) & ~safe_text_area)
                )
                item["artwork_outside_changed_regions_unchanged"] = bool(
                    np.array_equal(
                        a[~(cleanup | safe_text_area)],
                        out[~(cleanup | safe_text_area)],
                    )
                )
                item["dimensions_preserved"] = all(
                    im.size == original.size for _, im in images
                )
                assert (
                    item["unchanged_outside_cleanup_mask"]
                    and item["typography_inside_safe_regions"]
                    and item["artwork_outside_changed_regions_unchanged"]
                    and item["dimensions_preserved"]
                )
                comparison = Image.new(
                    "RGB", (original.width * 3, original.height + 36), "#222222"
                )
                draw = ImageDraw.Draw(comparison)
                for column, (label, im) in enumerate(images[:3]):
                    comparison.paste(im, (column * original.width, 36))
                    draw.text((column * original.width + 10, 10), label, fill="white")
                comparison.save(folder / "comparison.png")
            (folder / "report.json").write_text(
                json.dumps(item, ensure_ascii=False, indent=2), encoding="utf8"
            )
            report.append(item)
            (args.output / "report.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2), encoding="utf8"
            )
            print(
                json.dumps(
                    {
                        "page": path.name,
                        "status": page.status,
                        "regions": len(regions),
                        "rendered": sum(
                            r.render.get("actual_font_size") is not None
                            for r in regions
                        ),
                        "seconds": item["seconds"],
                    },
                    ensure_ascii=True,
                ),
                flush=True,
            )
    engine.dispose()
    from pipeline_gallery import build

    build(args.output)


if __name__ == "__main__":
    main()
