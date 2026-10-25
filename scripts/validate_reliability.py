"""Deterministic CJK fixtures: real local OCR, separate authored rendering checks.

Does not call translation/OCR APIs. Authored translations are test inputs, never
reported as model translation output. Real manga checks use verify_samples.py.
"""
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.config import settings
from app.ocr import recognize, recognize_selection
from app.rendering import render_page, usable_area


def normalized(text):
    return re.sub(r"\W", "", text)


def main():
    folder = ROOT / "data/qa/reliability-fixtures"
    folder.mkdir(parents=True, exist_ok=True)
    report = []
    cases = [
        ("vertical-japanese", "ja", "今日はいい天気ですね", "It is a lovely day.", True, 28),
        ("korean", "ko", "오늘 날씨가 좋아요", "Hace buen tiempo hoy.", False, 28),
        ("chinese", "zh-CN", "今天天气很好", "It is a lovely day.", False, 28),
        ("small-chinese", "zh-CN", "今天天气很好", "Hace buen tiempo hoy.", False, 13),
    ]
    for name, language, source, translation, vertical, size in cases:
        original = Image.new("RGB", (600, 500), "#bcbcbc")
        draw = ImageDraw.Draw(original)
        box = [40, 25, 230, 450] if vertical else [40, 60, 510, 170]
        x, y, w, h = box
        draw.rectangle((x, y, x + w, y + h), fill="white", outline="black", width=3)
        font = ImageFont.truetype(str(settings.font_path), size)
        text_box = [110, 60, size + 8, len(source) * (size + 3)] if vertical else [75, 115, int(draw.textlength(source, font=font)) + 8, size + 10]
        if vertical:
            for i, char in enumerate(source):
                draw.text((text_box[0], text_box[1] + i * (size + 3)), char, font=font, fill="black", anchor="lt")
        else:
            draw.text(text_box[:2], source, font=font, fill="black", anchor="lt")
        diagnostics = []
        recognized = recognize_selection(original, text_box, language, diagnostics, manga=False)
        r = SimpleNamespace(id=name, box=box, words=[text_box], source_text=source,
                            language=language, confidence=1, restored=False,
                            translation=translation, render={"source_box": text_box,
                            "source_verified": True, "manual": True,
                            "bubble_polygon": [[x+3,y+3],[x+w-3,y+3],[x+w-3,y+h-3],[x+3,y+h-3]]})
        translated, clean, mask, notes = render_page(original, [r])
        pixels = np.asarray(mask) > 0
        assert np.array_equal(np.asarray(original)[~pixels], np.asarray(clean)[~pixels])
        changed_text = np.any(np.asarray(translated) != np.asarray(clean), axis=2)
        assert not np.any(changed_text & (usable_area(original, r) == 0))
        for kind, image in (("original", original), ("clean", clean), ("mask", mask), ("translated", translated)):
            image.save(folder / f"{name}-{kind}.png")
        report.append({"case": name, "source": source, "ocr": recognized["source_text"],
                       "ocr_exact_normalized": normalized(source) == normalized(recognized["source_text"]),
                       "ocr_confidence": recognized["confidence"], "attempts": diagnostics,
                       "rendering_input": "Authored source and translation, isolated from OCR",
                       "rendered": bool(r.render.get("actual_font_size")), "warnings": notes[r.id],
                       "preservation_checks": "passed"})
    blank = Image.new("RGB", (600, 500), "white")
    found = recognize(blank, "ja", quality="fast", diagnostics=[])
    blank.save(folder / "no-text-original.png")
    assert not found
    report.append({"case": "no-text", "detected_regions": len(found)})
    (folder / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"cases": len(report), "ocr_exact": sum(r.get("ocr_exact_normalized", False) for r in report),
                      "rendered": sum(r.get("rendered", False) for r in report), "report": str(folder / "report.json")}))


if __name__ == "__main__":
    main()
