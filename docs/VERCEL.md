# Root Vercel deployment

MangaLens now uses one root Next.js package, one lockfile and one Vercel project. `vercel.json` selects Next.js, `npm ci`, `npm run build` and `.next`. Existing frontend routes and UI were moved without a framework rewrite. `scripts/dev.py` still starts the API, worker and web app together; `--production` serves an existing production build for verification. Docker Compose still runs the complete stack using the root web Dockerfile.

A fresh install also exposed an incomplete optional WASM dependency graph in the old lockfile. The lockfile was regenerated from the pinned manifest in an empty directory so that `npm ci` can reproduce installation rather than rely on pre-existing node_modules.

## Architecture and exact remaining dependency

```text
Browser → one Vercel domain
            ├─ /, /translate, /projects, /editor, /read, /settings → Next.js
            └─ /api/* → direct rewrite → existing persistent FastAPI host
                                             ├─ database + stored page images
                                             └─ durable worker
                                                  ├─ Tesseract / Manga OCR
                                                  ├─ Argos or configured translation API
                                                  └─ OpenCV cleaning / Pillow typesetting
```

The former split was a packaging issue for the frontend (`frontend/package.json` and subdirectory-only instructions) plus real backend runtime requirements. One root import is now supported. **A fully self-contained Vercel deployment is not provided.** No second Vercel import is needed; the existing backend host is still required. No external host is provisioned by this repository. A deployment without a reachable `API_INTERNAL_URL` has no working upload/processing API and is not considered complete.

Provider calls remain server-side on that backend: DeepL, OCR.space, optional Google/Azure/OpenAI-compatible services, or local Ollama as configured. External OCR/translation calls do not replace local detection, image processing, export, storage or background execution. Existing fallbacks, quotas, models and language options are preserved.

## Vercel compatibility review (2026-10-25)

Official documentation checked during implementation:

| Constraint | Actual pipeline consequence |
| --- | --- |
| [Function limits](https://vercel.com/docs/functions/limitations): 4.5 MB request/response payload; Fluid duration defaults/max 300 seconds on Hobby, up to 800 seconds on Pro/Enterprise, extended beta beyond that | Uploads allow 64 MB by default; page processing can approach 30 minutes. The API/worker is not wrapped in a Vercel Function. Increasing duration does not provide a durable worker. |
| [Python runtime](https://vercel.com/docs/functions/runtimes/python): Python 3.12–3.14; dependency bundling, 500 MB standard bundle and 5 GB large-function beta | Backend needs native Tesseract language binaries, OpenCV, CTranslate2, fonts and optional Torch/Manga OCR, plus several GB of downloaded models. A larger bundle alone does not resolve execution/storage lifecycle. No claim that all native modules are categorically unsupported is made. |
| [Function filesystem](https://github.com/vercel/vercel/discussions/5320), Vercel maintainer answer: temporary `/tmp` storage | Current backend writes durable originals, cleaned/translated images, masks, caches and possibly SQLite under `DATA_DIR`. Temporary function disk is unsuitable for shared API/worker state and retention. Keep persistent database/storage on the backend. |
| [External proxy limits](https://vercel.com/docs/limits): 120-second request timeout | Normal upload/start/poll/image requests are proxied; page computation continues independently in the worker. Synchronous region OCR/retranslation, URL import or large export can exceed the proxy timeout. Those endpoints are preserved, but worst-case requests need live validation. A timeout must not be interpreted as successful processing. |
| [External rewrites](https://vercel.com/docs/routing/rewrites) can serve an existing backend under the frontend origin | The direct rewrite avoids adding a Node Function between the browser and backend. The 4.5 MB Function limit is not presented as the external-rewrite upload limit. A >5 MB upload passed through the local production rewrite; real Vercel gateway/hosting limits remain unverified. |
| [Build configuration](https://vercel.com/docs/builds/configure-a-build) supports project-root framework, install, build and output settings | The app now follows the root Next.js layout. Only Node dependencies are installed for Vercel; Python/native dependencies remain in the separate backend image. |

Private API responses are `no-store`, with external-rewrite CDN caching explicitly disabled. Session cookies remain HttpOnly and same-origin. Only explicitly listed production/preview origins are accepted for mutations. Use secure cookies on HTTPS. No new storage, queue, paid provider or beta platform service is introduced.

## Configuration and migration

Use the exact [README settings and migration procedure](../README.md#one-repository-import-one-vercel-project). The only Vercel application setting is server-side/build-time `API_INTERNAL_URL`. All other server variables, including `DEEPL_API_KEY`, `OCR_SPACE_API_KEY`, `DATABASE_URL`, `DATA_DIR`, `MODEL_DIR`, `FONT_PATH`, `COOKIE_SECURE`, `ALLOWED_ORIGIN` and budgets, belong on the backend/worker host. No browser environment variables are required. Root `.env.example` documents required versus optional settings; `.env`, `.env.*`, `.vercel`, images, databases and models remain excluded from Git/deployment source uploads.

Keep the existing backend and old frontend until a real preview has passed session, upload, processing, editor and export checks. No hosted project or production setting was modified automatically. Moving to an entirely new frontend hostname starts a new temporary session library; retain the old domain for access/rollback or use the existing domain after verification.

## Verification evidence

- Clean `npm ci`, production Next.js builds in local and Vercel modes, and explicit TypeScript checks passed from the root.
- Three Node deployment regressions passed: local routing, hosted routing/private caching, and rejected invalid backend origins.
- Five browser tests passed against the production root build and real local API/worker. They cover nested route refresh, cookie/session continuity, >5 MB multipart upload, image delivery, corrupt upload errors, real Japanese OCR + Argos processing, manual recovery, comparisons, editor save/retry and CBZ export.
- Full backend suite: 97 tests passed, including the added exact production/preview-origin regression. One upstream Starlette/httpx deprecation warning remains.
- `docker compose config --quiet` passed; no Docker runtime/build claim is made.
- Browser static output scanned against three locally configured secret values: zero matches. No live provider charges were incurred; OCR/translation integrations were exercised through local inference and existing controlled provider tests.
- Vercel CLI 65.2.0 `vercel build` was attempted and stopped with `project_settings_required`: no linked project settings are available in this workspace. No Vercel project was created or modified. A cloud build, real backend TLS/origin routing, gateway upload limits and production provider calls still require the configured preview deployment.
- No standalone lint configuration exists in the repository; TypeScript and production compilation are the available code checks.
