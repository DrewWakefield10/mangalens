# OCR and text replacement recovery

Existing uploads can use the updated pipeline: restart the app and choose **Retry OCR** on a page or **Reprocess chapter**. Automatic detections from the old pipeline are regenerated. Regions with saved manual corrections or edit history are retained. A font or text edit queues rendering only; it does not repeat OCR or translation.

For Japanese manga, the optional local crop recognizer is installed in this workspace. On a fresh installation:

```powershell
.\.venv\Scripts\python.exe -m pip install -r backend/requirements-manga.txt
.\.venv\Scripts\python.exe scripts/setup_manga_ocr.py
```

The installer downloads the pinned Apache-2.0 [Manga OCR model](https://huggingface.co/kha-white/manga-ocr-base), verifies its SHA-256, and writes a completion marker. Runtime uses local files and restricted weights-only loading; it never downloads a model during a page job. `MANGA_OCR_ENABLED=false` selects the Tesseract-only path. Health reports `manga_ocr_available`.

The [Manga OCR recognizer](https://github.com/kha-white/manga-ocr) works on text crops, not whole-page detection. MangaLens proposes enclosed light bubble interiors with connected components, then compares horizontal and vertical Tesseract results and uses Manga OCR on Japanese-supported candidates. Since the recognizer can invent text on non-text images, unconfirmed proposals stay editable and cannot automatically erase artwork. Engine confidence and model agreement are diagnostics, not correctness probabilities.

## Manual recovery

1. Open Editor on any uploaded page, including a failed or unprocessed page.
2. Choose the OCR source language, click **Add Text Region**, and drag a rectangle around the missing dialogue. OCR runs on that crop.
3. Correct the source text and save. Use **Retranslate saved text**, or enter your own translation.
4. In **Text removal mask**, select the source lettering independently of the English placement box. Include additional ink or protect artwork by drawing rectangles; adjust expansion from 0–4 pixels.
5. Use **Rebuild cleanup and preview**. Inspect the original, clean, mask and translated views. Retry region OCR produces a suggestion and preserves a previously saved source correction.

Masks select ink pixels rather than filling a white rectangle. English glyphs must fit the padded detected interior, and cannot cover unremoved dark ink. Cleanup failures, missing translations and overflow preserve the original region. Textured reconstruction and OCR disagreement require review. Font size cannot fall below 12px, and dialogue is never silently truncated.

Page **Completed** means the selected regions passed the implemented checks. It does not certify that every piece of page text was detected or that the translation is faithful. **Needs Review** retains successful regions while exposing uncertain or missing work; **Failed** is reserved for technical errors preventing useful processing. Open bubbles, sound effects, dense artwork and halftones remain limitations.

## Reproducible local comparisons

```powershell
.\.venv\Scripts\python.exe scripts/verify_samples.py
# Or inspect just the screenshot example and a previously failing page:
.\.venv\Scripts\python.exe scripts/verify_samples.py --pages 001 013
```

This runs actual OCR, Argos translation, cleanup and rendering against `samples/sora-wo-matotte-chapter-34`, using a separate verification database. Output is saved under `data/qa/pipeline/real-pages`: original, cleaned image, text mask, translated image, side-by-side comparison, HTML gallery and region-level JSON diagnostics. Every input checksum is checked for preservation; clean pixels outside the recorded mask, rendered glyphs outside safe placement areas, artwork outside changed regions and image dimensions are verified. Supplied manga pages remain local and are not licensed by the CC0 notice for the generated sample.

The completed 24-page run in this workspace is at `data/qa/pipeline/verified-pages/index.html`. Each page is marked **Needs Review** because some dialogue remains unrecognized or its OCR/translation is uncertain. The gallery shows actual model output, including awkward wording, so review and manual correction are still required before treating it as a finished translation.

The DeepL-first integration was also run on real page 013 with `python scripts/verify_samples.py --provider deepl --pages 013 --output data/qa/pipeline/deepl-pages`. Its separate gallery is at `data/qa/pipeline/deepl-pages/index.html`. The actual DeepL output is more fluent on several bubbles, while uncertain OCR and a long bottom-right bubble remain for review. Only this one real manga page has been exercised end to end with DeepL; the 24-page gallery above used offline Argos translation.
