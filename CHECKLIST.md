# MangaLens implementation

- [x] Working CPU MVP: upload → real Japanese OCR → real translation → masked cleanup → typesetting → reader
- [x] Durable chapter jobs, cancellation, retries, private assets and ownership
- [x] Selected milestone 2 features: glossary, provider interfaces, editable regions and rendering checks
- [x] Selected milestone 3 features: reader modes, comparison, persisted reading progress
- [x] Selected milestone 4 features: authorized manifest adapter, archive/PDF import and export
- [x] 64 backend tests and 4 browser tests; actual HTTP/worker CPU demonstration
- [x] All 28 published direct offline pairs installed and exercised with short inference checks
- [x] 24 user-provided manga pages run through real OCR, offline translation, cleanup and rendering; review gallery and pixel invariants saved
- [x] DeepL Free key configured server-side and verified live; three real manga pages processed end to end with measured coverage and review flags; mixed Japanese/Korean/Chinese/Russian translation detected in a live API request
- [x] OCR.space free key configured server-side; Engine 3 live-tested on Japanese manga and synthetic Japanese/Korean/Chinese/English text, Engine 2 live-tested on simplified Chinese; one real page measured with cloud OCR and DeepL
- [x] Maximum Quality default, OCR.space free API key configured server-side, conservative daily/monthly/per-page request budgets, local OCR recovery, account and local DeepL counters
- [x] Production frontend build; fresh migration upgrade/downgrade/upgrade; Compose configuration validation
- [x] Deployment files, native launcher, setup and [precise support matrix](docs/SUPPORT.md)
- [ ] Docker/PostgreSQL runtime verification (local Docker engine is stopped)
- [ ] Optional external-provider live verification (Google Vision, Google Translate, Azure and LLM credentials not supplied)
- [ ] Advanced models and remaining optional capabilities listed in the support matrix

Operational features are distinguished from unsupported model-dependent quality features. Native verification uses SQLite with the same SQLAlchemy schema and durable worker as PostgreSQL. This is a working MVP with selected later-milestone features, not a claim that the entire advanced master brief is complete.
