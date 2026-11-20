import io
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from app.bubble_render import BOUNDARY, CLEANUP, TOO_LONG, inset
from app.config import settings
from app.db import DB, Job, Region
from app.geometry import polygon_mask
from app.process import run
from app.rendering import render_page, usable_area
from app.worker import claim
from test_api import scan_and_confirm, upload


def bubble_page():
    image = Image.new("RGB", (520, 290), "#aaa6a1")
    draw = ImageDraw.Draw(image)
    first = [[38, 40], [214, 40], [251, 78], [244, 206],
             [185, 231], [120, 231], [86, 252], [75, 222], [38, 198]]
    second = [[300, 50], [469, 50], [469, 232], [300, 232]]
    font = ImageFont.truetype(str(settings.font_path), 24)
    for polygon in (first, second):
        draw.polygon(polygon, fill="white", outline="#202024")
    draw.text((41, 100), "じゃ！", fill="#222", font=font)
    draw.point((42, 99), fill="#ddd")
    draw.text((349, 111), "またね", fill="#222", font=font)
    draw.text((264, 250), "ドン！", fill="#8c1224", font=font)

    def region(id, polygon, source_box, translation):
        return SimpleNamespace(
            id=id, box=source_box, source_text="またね", translation=translation,
            confidence=1, language="ja", restored=False, words=[source_box],
            render={
                "bubble_version": "speech-bubbles-v1",
                "bubble_polygon": polygon,
                "source_verified": True,
                "source_box": source_box,
            },
        )

    a = region("a", first, [41, 99, 70, 34], "Ça y est!\nI’ll see you tomorrow, then.")
    b = region("b", second, [347, 111, 79, 38], "W" * 160)
    return image, a, b


def test_edge_ink_is_cleaned_and_long_irregular_bubble_fits_with_hard_break():
    image, a, b = bubble_page()
    translated, clean, mask, notices = render_page(image, [a, b])
    original = np.asarray(image)
    cleared = np.asarray(clean)
    output = np.asarray(translated)
    first = polygon_mask(original.shape, a.render["bubble_polygon"])
    placement = usable_area(image, a)
    text_ink = np.zeros(original.shape[:2], bool)
    text_ink[99:136, 41:111] = original[99:136, 41:111, 0] < 255
    assert np.any(text_ink & (placement == 0))
    assert np.all(cleared[text_ink] == 255)
    assert np.all(np.asarray(mask)[text_ink] > 0)
    assert np.array_equal(output[first == 0], original[first == 0])
    assert np.array_equal(cleared[inset(first, 1) == 0], original[inset(first, 1) == 0])
    changed = np.any(output != cleared, axis=2)
    assert np.any(changed) and not np.any(changed & (placement == 0))
    bands = np.count_nonzero(np.diff(np.pad(np.any(changed, axis=1), 1))) // 2
    assert bands >= 2
    assert 12 <= a.render["actual_font_size"] < 100
    assert notices[a.id] == []
    assert notices[b.id] == [TOO_LONG]
    assert translated.size == clean.size == mask.size == image.size
    assert a.render["layout_debug"]["source"]
    assert a.render["layout_debug"]["placement"]


def test_crossing_and_uncertain_cleanup_preserve_original_independently():
    image, a, b = bubble_page()
    draw = ImageDraw.Draw(image)
    draw.line((32, 117, 53, 117), fill="black", width=4)
    draw.rectangle((360, 124, 370, 141), fill="#202024")
    b.render["mask_exclude"] = [[360, 124, 11, 18]]
    b.translation = "See you"
    translated, clean, mask, notices = render_page(image, [a, b])
    assert notices[a.id] == [BOUNDARY]
    assert notices[b.id] == [CLEANUP]
    assert a.render["layout_debug"]["rejected"]
    assert b.render["layout_debug"]["rejected"]
    assert translated.tobytes() == clean.tobytes() == image.tobytes()
    assert not mask.getbbox()


def test_thai_target_uses_visible_glyphs_and_wraps_without_spaces():
    image, a, _ = bubble_page()
    a.translation = "พรุ่งนี้เราจะกลับมาเจอกันที่ห้องเรียน!"
    translated, clean, _, notices = render_page(image, [a])
    glyphs = np.any(np.asarray(translated) != np.asarray(clean), axis=2)
    assert notices[a.id] == []
    assert a.render["actual_font_size"] >= 12
    assert glyphs.any() and not np.any(glyphs & (usable_area(image, a) == 0))


def test_saved_layout_edit_renders_one_bubble_without_ocr_or_translation(client):
    image, a, b = bubble_page()
    b.translation = "See you!"
    upload_image = io.BytesIO()
    image.save(upload_image, "PNG")
    project = upload(client, [("files", ("lettering.png", upload_image.getvalue(), "image/png"))])
    page_id = project["pages"][0]["id"]
    page_url = f"/api/pages/{page_id}"
    with patch("app.process.detect_speech_bubbles", return_value=[]):
        scan_and_confirm(client, project, [a.render["bubble_polygon"], b.render["bubble_polygon"]])
    bubbles = client.get(page_url + "/bubbles").json()["bubbles"]
    with DB() as db:
        for position, (fixture, bubble) in enumerate(zip((a, b), bubbles)):
            db.add(Region(page_id=page_id, position=position, box=fixture.box,
                          words=fixture.words, source_text=fixture.source_text,
                          translation=fixture.translation, language="ja", confidence=1,
                          render={**fixture.render, "bubble_id": bubble["id"]}))
        job = Job(page_id=page_id, kind="render")
        db.add(job)
        db.commit()
        job_id = job.id
    run(job_id)
    regions = client.get(page_url + "/regions").json()
    first = regions[0]
    assert all(r["render"].get("actual_font_size") for r in regions)

    def snapshot():
        return [np.array(Image.open(io.BytesIO(client.get(page_url + "/image/" + kind).content)))
                for kind in ("translated", "clean", "mask")]

    saved = snapshot()
    with patch("app.process.bubble_ocr") as ocr, patch("app.process.cached_translate") as translator, patch(
        "app.process.render_page", wraps=render_page
    ) as render:
        response = client.put(f"/api/regions/{first['id']}", json={
            "source_text": first["source_text"], "source_verified": True, "language": "ja",
            "font_size": 18, "translation": "Ça y est!\nI’ll see you\ntomorrow, then.",
        })
        assert response.status_code == 200, response.text
        run(claim())
        ocr.assert_not_called()
        translator.assert_not_called()
        assert [r.id for r in render.call_args.args[1]] == [first["id"]]
        response = client.post(f"/api/regions/{first['id']}/retry/clean")
        assert response.status_code == 200
        run(claim())
        assert [r.id for r in render.call_args.args[1]] == [first["id"]]
        ocr.assert_not_called()
        translator.assert_not_called()
    updated = snapshot()
    outside = polygon_mask((image.height, image.width), a.render["bubble_polygon"]) == 0
    for before, after in zip(saved, updated):
        assert np.array_equal(before[outside], after[outside])
    assert not np.array_equal(saved[0], updated[0])
    assert client.get(page_url + "/regions").json()[1]["render"] == regions[1]["render"]

    # An explicit wording edit can approve a short replacement. Its layout
    # still has to pass the same cleanup and glyph checks.
    assert client.put(f"/api/regions/{first['id']}", json={
        "source_text": "今度こそすぐに教室で会いましょう",
        "source_verified": True, "language": "ja", "translation": "Later!",
    }).status_code == 200
    run(claim())
    shortened = client.get(page_url + "/regions").json()[0]
    assert shortened["render"]["actual_font_size"] >= 12
    assert shortened["render"]["translation_verified"] is True
