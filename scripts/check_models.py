"""Run actual short CPU inference for each installed offline pair (not an accuracy benchmark)."""

import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.translation import offline_pairs, local_model, translate

SAMPLES = {
    "en": "Hello.",
    "ja": "こんにちは。",
    "ko": "안녕하세요.",
    "zh-CN": "你好。",
    "zh-TW": "你好。",
    "ru": "Привет.",
    "es": "Hola.",
    "fr": "Bonjour.",
    "de": "Hallo.",
    "pt": "Olá.",
    "id": "Halo.",
    "vi": "Xin chào.",
    "th": "สวัสดี",
    "tl": "Kumusta.",
}


def main():
    results = []
    for pair in offline_pairs():
        started = time.monotonic()
        item = {**pair, "input": SAMPLES[pair["source"]]}
        try:
            output = translate(
                [item["input"]], pair["source"], pair["target"], "argos", "natural", {}
            )
            if len(output) != 1 or not output[0].strip():
                raise ValueError("Model returned no translation")
            if "\u2581" in output[0] or "@@" in output[0]:
                raise ValueError("Unresolved tokenizer markers in translation")
            if len(output[0]) > 200:
                raise ValueError("Unexpectedly long output for a short greeting")
            item.update(status="passed", output=output[0])
        except Exception as exc:
            item.update(status="failed", error=str(exc))
        item["seconds"] = round(time.monotonic() - started, 2)
        results.append(item)
        print(json.dumps(item, ensure_ascii=True), flush=True)
        local_model.cache_clear()
    report = ROOT / "models/inference-report.json"
    report.write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        f'{sum(r["status"]=="passed" for r in results)}/{len(results)} installed pairs passed actual inference.',
        flush=True,
    )
    if not results or any(r["status"] == "failed" for r in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
