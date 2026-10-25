# MangaLens

For vertical Japanese OCR, bubble cleanup, and manual recovery, see [OCR recovery](docs/OCR-RECOVERY.md).

**Read Beyond Language Barriers.** A full-stack manga translation application: Next.js App Router, FastAPI, PostgreSQL (Docker) or SQLite (native), a durable database-backed worker, local and optional cloud OCR, DeepL-first translation with offline Argos available, targeted OpenCV cleanup and editable Pillow typesetting.

This release delivers the working CPU MVP and selected reader/editor/import features. It is **not** an implementation of every advanced feature in the master brief. See [the support matrix](docs/SUPPORT.md) for exact limitations.

## Quick start on this Windows workspace

Dependencies, fonts, all 28 published direct offline pairs among the app's languages, and the optional Japanese manga crop recognizer have been installed locally. Docker is not needed for the native setup:

```powershell
.\.venv\Scripts\python.exe scripts/dev.py
```

Open **http://localhost:3000**. Upload `samples/japanese-page.png`, confirm permission, choose Japanese → English and DeepL, and translate. Read the result, toggle the original, and edit a region. API documentation: **http://localhost:8000/docs**.

`Ctrl+C` stops the API, worker and frontend started by the launcher. Temporary project access is tied to the browser's HttpOnly session cookie. Use the same browser profile to return to your library.

## Fresh installation

Requirements: Python 3.12, Node.js 24 LTS, and Tesseract 5. Windows requires the Microsoft Visual C++ runtime for CTranslate2 and a Tesseract installation. Linux: `apt install tesseract-ocr libgomp1 libraqm0`. Set `TESSERACT_CMD` in `.env` if Tesseract is not on PATH. The Windows default installation location is detected automatically.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
npm.cmd ci
Copy-Item .env.example .env
.\.venv\Scripts\python.exe scripts/setup_models.py
.\.venv\Scripts\python.exe scripts/make_samples.py
.\.venv\Scripts\python.exe scripts/dev.py
```

On Linux/macOS use `.venv/bin/python` and `npm` instead. Model setup needs Internet access once. Subsequent OCR and Argos translation work offline. `setup_models.py` obtains public language data, the OFL Noto CJK font and a direct Argos model; the official alternate download host is tried if the primary host fails. Model metadata and SHA-256 provenance are retained locally. Model archives are never executed or loaded as Python pickles.

For another **directly supported** offline pair:

```sh
python scripts/setup_models.py --source ko --target en
```

Models are directional: Japanese → English does not include English → Japanese. To install the reverse direction, run `python scripts/setup_models.py --source en --target ja`. All 28 available direct pairs are installed in this workspace and passed short inference checks. Settings lists complete installed pairs; the import dialog labels missing pairs, and the API rejects explicitly selected missing pairs before queueing a chapter. With automatic source detection, the pair can only be checked after OCR. Restart an already-running backend once after updating the application code; later model downloads are discovered without a restart.

To install **every published direct pair** among the app's 14 languages:

```powershell
.\.venv\Scripts\python.exe scripts/setup_models.py --all-app-languages --workers 3
```

The current official index contains 28 matching pairs: English in both directions with the other 13 languages, plus Spanish ↔ Portuguese. This does not imply every possible combination has a model, and there is no automatic translation through an intermediate language. The command skips completed installations, retries interrupted downloads, validates package contents and writes `models/install-report.json`. Re-run it to retry failed downloads. Downloads can require several GB of disk space; the source OCR languages remain those listed in the support matrix.

Both SentencePiece and Moses/BPE Argos packages are supported. To run a real short CPU inference through every installed pair and save `models/inference-report.json`, run `python scripts/check_models.py`. This verifies model execution, not translation accuracy.

Argos codes use `zh` for Simplified Chinese and `zt` for Traditional Chinese. The app maps these to `zh-CN` / `zh-TW`. A missing pair fails explicitly; it never fabricates a translation or silently switches to another service.

## Docker Desktop / WSL2 / Linux

Start Docker Desktop's Linux engine. Copy `.env.example` to `.env` and change `POSTGRES_PASSWORD` to an alphanumeric development password. Run model setup above (Python standard library only), then:

```sh
docker compose up --build
```

This starts PostgreSQL, runs Alembic migrations, then starts the API, worker and Next.js production server. Only loopback ports 3000 and 8000 are exposed. Image storage and the database use named volumes. The worker is limited to 2 GB and processes one page at a time. Scale workers only when sufficient memory is available; native SQLite is intended for one worker.

The Docker definition has been statically validated. The host's Docker daemon was stopped during delivery, so a container build and PostgreSQL runtime verification were not performed.

## One repository import, one Vercel project

Import the repository root into Vercel with the Next.js preset, Node 24.x,
`npm ci`, `npm run build` and the default `.next` output. Without an explicit
`API_INTERNAL_URL`, Vercel uses the included browser processing API.

The free hosted configuration uses Vercel + Supabase + DeepL API Free +
OCR.space's free endpoint. No Python host, worker or running owner PC is needed.
Visitors must keep a browser tab open while translating. Interrupted work can be
resumed from the chapter page. This is a smaller pipeline than the Python mode:
cloud OCR, DeepL translation, conservative white-background cleanup, browser
rendering and exports. Every page requires manual review.

Server-only Vercel variables (Production and Preview):

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Project API origin |
| `MANGALENS_GATEWAY_SECRET` | Random bearer token shared with the private gateway |
| `DEEPL_API_KEY` | DeepL API Free credential |
| `OCR_SPACE_API_KEY` | OCR.space free credential |

Apply `supabase/migrations/202610260001_browser_processing.sql` to an empty
Supabase project. Deploy `supabase/functions/mangalens-gateway/index.ts` after
substituting its hash marker with the SHA-256 of the gateway token; keep the
actual token only in Vercel. Deploy with `verify_jwt=false`: this gateway verifies
its own bearer token before every operation. Supabase's service-role credential
remains inside the Edge Function runtime. Never use `NEXT_PUBLIC_*` for secrets.
See [hosted setup, limits and verification](docs/VERCEL.md).

For the existing Python deployment, set `API_INTERNAL_URL` to the backend HTTPS
origin, with no path or credentials, and retain the separate API and worker.
Local development defaults to the Python API on port 8000. To develop the hosted
path locally, set `MANGALENS_CLOUD=1` and the four server variables in ignored
`.env.local`.

Hosted libraries are temporary browser sessions, separate from Python libraries.
Clearing cookies loses access. Projects expire after seven days; expired files
are removed when the library is accessed. Download results you want to keep.

## Python mode: DeepL and optional cloud OCR

DeepL is the default provider in this workspace. Its API Free key is stored only in the ignored server `.env`; the app chooses `api-free.deepl.com` for keys ending in `:fx` and `api.deepl.com` for paid API keys. Never place a key in frontend code. `GET /api/usage` and Settings show near-real-time DeepL account characters and this session's request counters without exposing credentials. `DEEPL_MONTHLY_CHARACTER_BUDGET` defaults to 100,000 app-submitted characters; the account's own quota is also checked before a new request. DeepL receives recognized dialogue and nearby chapter context, not page images.

OCR.space is the primary cloud OCR provider in Maximum Quality mode. Put a free key in the server-only `OCR_SPACE_API_KEY` variable and leave `CLOUD_OCR_PROVIDER=ocr_space`; this workspace is configured. The app uses only the official free HTTPS endpoint, keeps each upload under 1 MB by preserving resolution with overlapping tiles, and counts every tile and retry. Engine 3 is selected for Japanese, Korean and automatic multi-language OCR; Engine 2 is selected for Chinese and Latin text, with Engine 3 as a configurable free-quota fallback. The current [OCR.space documentation](https://ocr.space/ocrapi) lists 500 free requests/day per IP, 25,000 Engine 1/2 requests/month, and a separate 1,000 Engine 3 conversions/month. Local defaults are deliberately lower: 50/day, 400/month total, 300/month for Engine 3, and 12 requests/page. Change the `OCR_SPACE_*_BUDGET` variables in `.env` to fit your shared-IP usage; the app cannot observe requests made outside MangaLens. When the free endpoint is throttled or the local budget is reached, local Tesseract/Manga OCR continues. OCR.space receives the page image; DeepL receives recognized text, not the image.

DeepL translation and OCR.space use separate credentials. Existing Argos models remain available for offline translation or an explicitly selected fallback. Maximum Quality is the default profile; Fast uses fewer OCR retries, while Balanced keeps the enhanced local pass. OCR.space does not return recognition confidence, so cloud-only regions remain review-only until confirmed in the editor. The optional Google Vision adapter is inactive unless `CLOUD_OCR_PROVIDER=google_vision` is explicitly set; it is outside this strict-zero-cost configuration and was not live-tested.

On a fresh installation without a DeepL key, the app selects Argos after its model is installed. A DeepL key is not required to use the offline path. Without an OCR.space key, local OCR remains available.

## Python mode: translation providers

Choose a provider in the import dialog. All credentials remain server-side in `.env`:

| Provider | Required configuration | Behavior |
| --- | --- | --- |
| DeepL (default) | `DEEPL_API_KEY` | Official Free/Pro API; per-region source detection where uncertain; neighboring dialogue context, retry/backoff, quota checks |
| Argos | Installed `models/argos/<source>_<target>` | CPU int8 neural translation; no API key; region-based |
| OpenAI-compatible | `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` | Page batches, previous dialogue, glossary, style and Quality review prompt |
| Ollama | `OLLAMA_URL`, `OLLAMA_MODEL` | Same contextual prompt through local `/api/chat`; model must be pulled separately |
| Google Cloud Translation | `GOOGLE_API_KEY` | v2 batch translation |
| Azure Translator | `AZURE_TRANSLATOR_KEY`, optional region and custom endpoint | Official v3 API; disabled until configured; selectable as a fallback |

DeepL was called live with this workspace's server-side credential. Other external providers remain unverified without their own credentials. Costs are not estimated. `MAX_TRANSLATION_CHARS` caps each page's submitted source characters; provider account budgets should also be set at the provider. `FALLBACK_PROVIDER` is opt-in and recorded in page metrics when used. LLM Quality mode requests a self-review within the translation call, not an independent second reviewer.

## Security and data

- Authenticated opaque temporary sessions; project, image, edit and export ownership checks.
- Original images are canonical lossless PNGs at original dimensions after EXIF orientation. Original pixel content stays separate; original compressed file bytes/EXIF are not retained.
- Content and pixel validation; bounded request bodies including chunked uploads; decoded chapter memory limits; archive traversal, compression bomb and encryption checks.
- URL imports require explicit HTTPS hostname allowlisting. DNS addresses are checked and pinned to the TLS connection. Every redirect and image host is independently checked. No arbitrary HTML scraping, cookies, browser automation or access-control bypass.
- Non-GET requests require `X-MangaLens-Client: web` and trusted browser Origin. HttpOnly SameSite cookies. Enable `COOKIE_SECURE=true` and configure `ALLOWED_ORIGIN` behind HTTPS before any remote deployment.
- Default retention: 7 days. The worker removes expired inactive projects and caches hourly. Active jobs are excluded. Deleting a project also clears the session's processing cache to remove retained OCR text. Clearing cache alone preserves projects.
- The API uses a per-process request limiter; deployments with multiple API replicas need a shared gateway limiter. No account registration or public sharing is exposed.

This is local-first software, not a hardened multi-tenant hosted service. Review [architecture and limits](docs/ARCHITECTURE.md) before deploying beyond loopback.

## Verification

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests -q
npm.cmd run typecheck
npm.cmd run test:deployment
npm.cmd run build
# With scripts/dev.py running:
npm.cmd test
.\.venv\Scripts\python.exe scripts/demo.py
```

Playwright uses installed Microsoft Edge by default. On Linux, install Chromium with `npx playwright install chromium` from the repository root, and set `PLAYWRIGHT_CHANNEL=chromium`.

The real-model test is skipped only if model files are missing. Other tests explicitly mock failures or providers; mocked outputs are not presented as real inference. `scripts/demo.py` uses HTTP and the actual worker, then saves original/translated/clean/mask images and OCR/translation/timing metadata under `data/demo/`. It uses its own private session, so its project is not automatically visible in a different browser's library.

## Repository map

```text
app/, components/, lib/  Next.js routes, reader/editor and shared frontend code
public/, tests/         Browser assets and browser/deployment regression tests
backend/app/          API, database, imports, providers, OCR, renderer and durable worker
backend/migrations/   Alembic schema migration
backend/tests/        Security, pipeline and real CPU integration tests
scripts/              Native launcher, model setup, original fixtures and HTTP demo
samples/              CC0 Japanese fixture and user-provided manga test pages
assets/fonts/         Noto Sans CJK and its SIL Open Font License
docs/                 Support matrix, architecture and API guide
```

Upstream references: [Tesseract documentation](https://tesseract-ocr.github.io/tessdoc/), [Argos model package format](https://argos-translate.readthedocs.io/en/latest/source/argostranslate.html), [Next.js installation](https://nextjs.org/docs/app/getting-started/installation). The generated Japanese sample page is CC0; locally supplied manga pages are excluded from the repository. Third-party models, libraries and fonts retain their own licenses; see [third-party notices](docs/THIRD_PARTY.md).
