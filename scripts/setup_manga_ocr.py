"""Install pinned optional Japanese manga OCR weights, with resumable ranges."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import time
import requests

ROOT = Path(__file__).resolve().parents[1]
REVISION = "aa6573bd10b0d446cbf622e29c3e084914df9741"
BASE = f"https://huggingface.co/kha-white/manga-ocr-base/resolve/{REVISION}/"
SHA256 = "c63e0bb5b3ff798c5991de18a8e0956c7ee6d1563aca6729029815eda6f5c2eb"
SIZE = 444135475
CHUNK = 1024 * 1024


def main():
    folder = ROOT / "models/manga-ocr"
    folder.mkdir(parents=True, exist_ok=True)
    for name in [
        "config.json",
        "preprocessor_config.json",
        "special_tokens_map.json",
        "tokenizer_config.json",
        "vocab.txt",
        "README.md",
    ]:
        if not (folder / name).exists():
            r = requests.get(BASE + name, timeout=30)
            r.raise_for_status()
            (folder / name).write_bytes(r.content)
    target = folder / "pytorch_model.bin"
    if not target.exists():
        parts = folder / ".parts"
        parts.mkdir(exist_ok=True)

        def download(start):
            end = min(SIZE, start + CHUNK) - 1
            part = parts / str(start)
            if part.exists() and part.stat().st_size == end - start + 1:
                return part
            for attempt in range(3):
                try:
                    r = requests.get(
                        BASE + f"pytorch_model.bin?download=true&range={start}",
                        headers={"Range": f"bytes={start}-{end}"},
                        timeout=(15, 40),
                    )
                    r.raise_for_status()
                    if r.status_code != 206 or len(r.content) != end - start + 1:
                        raise ValueError("Invalid range response")
                    part.write_bytes(r.content)
                    return part
                except (requests.RequestException, ValueError):
                    if attempt == 2:
                        raise
                    time.sleep(1)

        with ThreadPoolExecutor(max_workers=12) as pool:
            pieces = []
            for piece in pool.map(download, range(0, SIZE, CHUNK)):
                pieces.append(piece)
                if len(pieces) % 20 == 0:
                    print(
                        f"{len(pieces)} / {(SIZE+CHUNK-1)//CHUNK} model chunks ready",
                        flush=True,
                    )
        temporary = folder / "manga-ocr.assembled"
        with temporary.open("wb") as output:
            for piece in pieces:
                output.write(piece.read_bytes())
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != SHA256:
            raise ValueError("Model checksum mismatch")
        temporary.replace(target)
        for piece in pieces:
            piece.unlink()
    if hashlib.sha256(target.read_bytes()).hexdigest() != SHA256:
        raise ValueError("Installed model checksum mismatch")
    (folder / "provenance.json").write_text(
        json.dumps(
            {
                "repository": "kha-white/manga-ocr-base",
                "revision": REVISION,
                "sha256": SHA256,
            }
        )
    )
    print("Manga OCR installed and checksum verified.", flush=True)


if __name__ == "__main__":
    main()
