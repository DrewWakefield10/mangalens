"""Download public CPU models and licensed fonts; no API credentials required."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
APP_CODES = {
    "en",
    "ja",
    "ko",
    "zh",
    "zt",
    "ru",
    "es",
    "fr",
    "de",
    "pt",
    "id",
    "vi",
    "th",
    "tl",
}
ALIASES = {"zh-CN": "zh", "zh-TW": "zt"}
INDEX_URL = (
    "https://raw.githubusercontent.com/argosopentech/argospm-index/main/index.json"
)


def fetch(url, path):
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    print("Downloading", path.name, flush=True)
    temporary = path.with_suffix(path.suffix + ".download")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as response, temporary.open(
                "wb"
            ) as output:
                shutil.copyfileobj(response, output)
            temporary.replace(path)
            return
        except (OSError, urllib.error.URLError) as exc:
            if (
                attempt == 2
                or isinstance(exc, urllib.error.HTTPError)
                and 400 <= exc.code < 500
                and exc.code != 429
            ):
                raise
            print("Download interrupted; retrying", path.name, flush=True)
            time.sleep(1)


def install_assets():
    for language in ["eng", "jpn", "jpn_vert", "kor", "chi_sim", "chi_tra", "rus"]:
        fetch(
            f"https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/{language}.traineddata",
            ROOT / "models/tessdata" / f"{language}.traineddata",
        )
    fetch(
        "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf",
        ROOT / "assets/fonts/NotoSansCJKjp-Regular.otf",
    )
    fetch(
        "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE",
        ROOT / "assets/fonts/OFL.txt",
    )


def select_packages(packages, source, target, all_app_languages=False):
    selected = {}
    for package in packages:
        pair = (package["from_code"], package["to_code"])
        matches = (
            (pair[0] in APP_CODES and pair[1] in APP_CODES and pair[0] != pair[1])
            if all_app_languages
            else pair == (source, target)
        )
        if matches:
            previous = selected.get(pair)
            version = lambda p: tuple(int(n) for n in p["package_version"].split("."))
            if previous is None or version(package) > version(previous):
                selected[pair] = package
    return [selected[pair] for pair in sorted(selected)]


def install_package(package):
    pair = f'{package["from_code"]}_{package["to_code"]}'
    target = ROOT / "models/argos" / pair

    def complete(folder):
        return (folder / "model/model.bin").is_file() and any(
            (folder / name).is_file() for name in ("sentencepiece.model", "bpe.model")
        )

    if complete(target) and (target / "provenance.json").is_file():
        return {"pair": pair, "status": "already_installed"}
    archive = ROOT / "models" / f"{pair}.argosmodel"
    urls = [url for url in package["links"] if url.startswith("https://")]
    if not urls:
        raise ValueError("Package has no public HTTPS download.")
    # Official alternate endpoint is preferable when the primary host returns 403.
    filename = urls[0].rsplit("/", 1)[-1]
    urls.insert(0, "https://data.argosopentech.com/argospm/v1/" + filename)
    used_url = None
    for url in dict.fromkeys(urls):
        try:
            fetch(url, archive)
            used_url = url
            break
        except (OSError, urllib.error.URLError) as exc:
            print(
                f"{pair}: download endpoint failed ({type(exc).__name__}); trying next.",
                flush=True,
            )
    if used_url is None:
        raise ValueError("All public download endpoints failed; rerun to retry.")
    staging_root = ROOT / "models/.staging"
    staging_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=pair + "-", dir=staging_root) as folder:
        staging = Path(folder).resolve()
        if not staging.is_relative_to(staging_root.resolve()):
            raise ValueError("Invalid staging path")
        with zipfile.ZipFile(archive) as zipped:
            for info in zipped.infolist():
                relative = Path(*Path(info.filename).parts[1:])
                if info.is_dir() or not relative.parts:
                    continue
                destination = (staging / relative).resolve()
                if not destination.is_relative_to(staging):
                    raise ValueError("Unsafe model archive")
                destination.parent.mkdir(parents=True, exist_ok=True)
                with zipped.open(info) as source, destination.open("wb") as output:
                    shutil.copyfileobj(source, output)
        if not complete(staging):
            raise ValueError(
                "Package lacks the CTranslate2 model or a supported tokenizer."
            )
        target.mkdir(parents=True, exist_ok=True)
        for file in staging.rglob("*"):
            if file.is_file():
                destination = target / file.relative_to(staging)
                destination.parent.mkdir(parents=True, exist_ok=True)
                file.replace(destination)
        # Publish the completion marker last: incomplete downloads stay unavailable.
        with archive.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        (target / "provenance.json").write_text(
            json.dumps(
                {"index": package, "download_url": used_url, "sha256": digest}, indent=2
            ),
            encoding="utf-8",
        )
    return {"pair": pair, "status": "installed", "sha256": digest}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="ja")
    parser.add_argument("--target", default="en")
    parser.add_argument("--no-translation", action="store_true")
    parser.add_argument(
        "--all-app-languages",
        action="store_true",
        help="Install every published direct pair among the app's 14 languages.",
    )
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=2)
    args = parser.parse_args()
    install_assets()
    if args.no_translation:
        return
    with urllib.request.urlopen(INDEX_URL, timeout=30) as response:
        packages = json.load(response)
    selected = select_packages(
        packages,
        ALIASES.get(args.source, args.source),
        ALIASES.get(args.target, args.target),
        args.all_app_languages,
    )
    if not selected:
        raise SystemExit("No direct Argos model exists for this language pair.")
    print(
        f"Installing {len(selected)} direct language pair(s); completed installations are skipped.",
        flush=True,
    )
    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        pending = {
            pool.submit(install_package, package): package for package in selected
        }
        for future in as_completed(pending):
            package = pending[future]
            try:
                result = future.result()
            except Exception as exc:
                result = {
                    "pair": f'{package["from_code"]}_{package["to_code"]}',
                    "status": "failed",
                    "error": str(exc),
                }
            results.append(result)
            print(
                f'[{len(results)}/{len(selected)}] {result["pair"]}: {result["status"]}'
                + (" - " + result["error"] if "error" in result else ""),
                flush=True,
            )
    report = ROOT / "models/install-report.json"
    report.write_text(
        json.dumps(
            {
                "index_url": INDEX_URL,
                "all_app_languages": args.all_app_languages,
                "results": sorted(results, key=lambda r: r["pair"]),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print("Installation report:", report, flush=True)
    if any(result["status"] == "failed" for result in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
