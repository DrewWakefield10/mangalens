# Speech bubble scanning and review

Open **Preview Detected Bubbles** after uploading or importing a chapter. The worker scans the original page for outlines. Solid outlines show proposed selections. Dashed outlines and **Needs Review** show boundaries that need a decision. Use **Deselect bubble** to exclude a detection. Use **Edit Bubble Boundary** or **Outline missed bubble** to place points just inside a speech bubble, then close and confirm the outline. Save each page selection before starting the chapter.

From an existing chapter or the editor, open the preview and use **Translate selected bubbles** after correcting a page. OCR and translation run for the new or changed outlines. Existing approved regions keep their IDs and saved translations. A region's **Retry region OCR** uses its approved crop. Manual text and mask edits are limited to approved regions.

- **No Speech Bubbles Found** means the detector completed with zero candidates. The page can be carried through unchanged.
- **No Bubbles Selected** leaves the preview open. Deselecting every candidate does not start processing. **Skip this page** records a deliberate decision after all candidates are dismissed.
- **Bubble Scan Failed** includes a detector reason and a scan retry. The native worker caps each scan at 30 seconds. Hosted scans time out while reading an original that does not respond.
- **Needs Review** covers pending boundaries and approved bubbles that failed OCR, translation, cleanup or typesetting. The original bubble remains visible when replacement fails.

The API stores explicit selections against the original image digest and scan version. A stale preview revision cannot overwrite a newer review. The worker fills everything outside each approved polygon with white before passing the crop to Tesseract, Manga OCR or a cloud fallback. It skips OCR when dark strokes reach the selected boundary. DeepL receives approved dialogue and context from the approved page regions. Legacy full-page OCR and translation entries use separate cache keys. Reprocessing an old project starts from its saved originals after preview. No database migration is required.

The renderer checks the lettering mask and glyph placement before applying the edit. It preserves the approved bubble when recognition or replacement cannot be validated. The worker checks the decoded output and cleanup mask against the original outside the approved polygons and saves lossless PNGs.

## Validation on 2026-11-20

The two user-provided manga pages have one hand-marked interior point per speech or thought bubble in `samples/bubble-marks.json`. Joined balloons with dialogue from one speaker were marked as one region. A point inside a proposed polygon counts as a match. The real pages and output images stay in local storage.

| Page | Marked | Found and accepted | Missed | Incorrectly accepted | Extra uncertain | Rendered with DeepL | Rendered with Argos |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 001 | 4 | 4 | 0 | 0 | 1 | 2 | 2 |
| 003 | 8 | 8 | 0 | 0 | 0 | 3 | 1 |

Page 001 includes dialogue beside large sound effects, credits and a title. The annotated bubble regions rendered over the dialogue and the decoded pixels outside all approved polygons matched the original. The extra candidate was a face patch marked uncertain and dismissed before OCR. Page 003 includes vertical Japanese, fuzzy thought bubbles and a joined jagged bubble. A live DeepL run also completed the CC0 Japanese fixture and rendered its single bubble.

A live OCR.space Engine 3 request received one masked crop of the CC0 fixture and returned four text segments. Local OCR and live DeepL completed with the existing credentials and models.

The hosted detector also proposed all 12 marked bubbles. It selected five automatically and presented the other seven for confirmation. It proposed ten extra uncertain areas and accepted zero incorrect regions on these pages. The hosted flow was exercised with the repository's Supabase fixture and controlled OCR and DeepL responses.

The regression tests capture the crops supplied to OCR and the translations requested during initial processing, page retries, region retries and a boundary correction. They check that exterior sentinel pixels are white at the recognizer, that legacy text never supplies translation context, and that unchanged bubbles keep their saved work. The synthetic controls exercise a small border gap, narration and floating lettering, an undecided selection, a scan failure, and continuation after a bubble fails.

The detector is geometric. Pale art can appear as an uncertain candidate. Dark fills, large gaps and unusual outlines may need manual tracing. The small marked set measures these pages only. Several accepted bubbles on the real pages still need review because recognizers disagree, an output omits dialogue or the renderer cannot safely replace the lettering.

Reproduce local results with the saved manga samples:

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests -q
.\.venv\Scripts\python.exe scripts/verify_samples.py --pages 001 003 --marks samples/bubble-marks.json
```

The native pipeline changes are in `backend/app/bubbles.py`, `bubble_ocr.py`, `process.py`, `main.py` and `rendering.py`. The hosted changes are in `lib/cloud-bubbles.ts`, `lib/bubble-geometry.ts`, the Next.js API route and the browser processor and renderer. The shared `components/bubble-preview.tsx` appears in import, chapter and editor flows.

The Vercel and Supabase mode uses its existing gateway and schema. A deployment configured to call the native API needs the updated Python API and worker as well as the Next.js release. Restart the native launcher to pick up both.
