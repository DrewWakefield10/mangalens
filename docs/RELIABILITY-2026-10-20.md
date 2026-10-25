# Reliability improvements — 2026-10-20

## Causes and fixes

- Rejected typography rolled back cleanup, but cached cleanup then blocked recovery after editing. Unsuccessful regions are now recomputed while successful regions remain cached.
- OCR crops could extend outside the page, introducing black padding, and cloud word coordinates could escape their tile. Coordinates now clip before mapping. Entirely off-page rectangles produce empty masks.
- Selected-region OCR retained only its strongest block. It now combines blocks in reading order. Short kana/Hangul is uncertain; horizontal Korean is not overridden by vertical Japanese. A bounded single-line retry corrected the observed Korean fixture failure.
- Translation validation missed original CJK/Hangul returned for Spanish and other Latin-script targets. These outputs now trigger review. Retranslation receives page context; merged manual regions retain stable IDs and receive ordered positions.
- DeepL retries and fallback could bypass the initial budget check. Each attempt now reserves code points under a database lock. OCR.space reservations are also serialized, and targeted crops count toward the page limit. Subsequent calls check cancellation.
- Stage results now distinguish detection, OCR, translation, masking, cleaning and rendering. The editor exposes current outcomes alongside history, and region boxes can be hidden for artwork inspection.

## Engines and cost controls

Tesseract and Japanese Manga OCR remain the local OCR engines; OCR.space remains bounded cloud recovery. DeepL and offline Argos remain the translation integrations. No new engine, paid service or heavy dependency was added: the Korean fixture justified improving existing recognition first.

DeepL uses Unicode code points for billing ([official usage documentation](https://developers.deepl.com/docs/resources/usage-limits)). Reservations cover workers/sessions sharing this database. Timeouts and malformed successes retain reservations because they may have been processed; explicit rejections can release them. Settings separates local commitments from provider-confirmed account usage. Other applications using the key cannot be atomically controlled by this database. Optional non-DeepL providers do not acquire DeepL's character budget.

## Verification

| Check | Result |
| --- | --- |
| Backend | 96 passed; one upstream Starlette/httpx warning |
| Browser | Three passed initially; manual recovery passed after correcting its request/completion timing race |
| Frontend | Production build and TypeScript passed |
| Migration | 0004 applied locally; isolated SQLite upgrade → downgrade → upgrade passed |
| Synthetic OCR | Vertical Japanese, Korean, Chinese and small Chinese: 4/4 exact after punctuation/whitespace normalization |
| Synthetic rendering | Four authored translation controls fit; outside-mask pixels preserved; blank page detected zero regions |
| Real page 001, saved inputs | 2/16 candidates safely rendered; partial |
| Real page 003, saved DeepL inputs | 8/20 rendered; no coverage regression |
| Real page 003, fresh local OCR + Argos | 2/17 rendered; partial |

The synthetic translations are authored rendering controls, not machine translation accuracy results. Different real-page inputs/providers are not a controlled comparison. Sample verification checks artwork preservation. Provider timeout, quota, concurrency, fallback, cancellation and cache behavior use controlled responses. No new paid API calls were needed. PostgreSQL locking was implemented but not runtime-tested here.

Artifacts: `data/qa/reliability-fixtures`, `data/qa/pipeline/partial-fix-v3`, `data/qa/pipeline/partial-fix-v2`, `data/qa/pipeline/reliability-local-20261020`. Reproduce synthetic checks with `.\.venv\Scripts\python.exe scripts/validate_reliability.py` and regressions with `.\.venv\Scripts\python.exe -m pytest backend/tests -q`.

## Remaining limitations

Full real-page coverage is not solved. Short ambiguous text, proper names, titles and text over artwork remain review cases. Rotated lettering and panel reading order are heuristic. Korean/Chinese checks are synthetic, not representative real comic benchmarks. Preserve original lettering is a per-region option for sound effects; no universal sound-effect classifier was added.

The strict frontend audit retains nine findings in `data/qa/premium-audit.json`: existing native-select ownership declarations, textarea resizing, the homepage form, and an actionless-button false positive for the shared wrapper forwarding props. Existing controls were preserved to avoid expanding this work into a redesign. DESIGN.md lint passed with four advisory token-reference warnings; CSS remains canonical. This is not a claim of a clean full-interface audit.

## Setup and review

Restart from the repository root:

```powershell
.\.venv\Scripts\python.exe scripts/dev.py
```

The launcher applies migrations. No new package, model or credential setup is required in this workspace. Existing pages are not silently reprocessed. Correct a region's OCR/translation, save, then Retry rendering. Use Regenerate mask when the mask needs changing, or Retry region OCR with a manual language when recognition is uncertain. Inspect applied Mask and Clean views before exporting a partially translated page.
