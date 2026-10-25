# API guide

Interactive OpenAPI docs are at `http://localhost:8000/docs`; schema at `/openapi.json`.

Call `POST /api/session` with `X-MangaLens-Client: web`, retain the returned HttpOnly cookie and send it on later calls. All mutations require the same custom header. Browser Origin must match `ALLOWED_ORIGIN`. Private resource IDs alone never grant access. Temporary browser sessions expire after 30 days by default; content retention is seven days.

| Method/path | Purpose |
| --- | --- |
| `GET /api/health` | Database, OCR model, font and provider configuration status (no credentials) |
| `GET /api/usage` | Current session's translation counts, server-wide OCR.space request counts and local budgets, and DeepL account character totals; no credentials |
| `POST /api/projects/upload` | Multipart `files`, `title`, `authorized=true`; transactional chapter import |
| `POST /api/projects/import` | `{url, authorized:true}` for an allowed source manifest |
| `GET /api/projects` | Current session's library/history |
| `GET /api/projects/{id}` | Project, page states and asset URLs |
| `POST /api/projects/{id}/start` | Source/target, provider, quality/style/direction, optional exact page ID order |
| `GET /api/projects/{id}/events` | SSE project snapshots and heartbeat comments |
| `POST /api/projects/{id}/cancel` | Cancel queued work; stop running work at its next boundary |
| `POST /api/pages/{id}/retry` | Queue a page again when the chapter has no active jobs |
| `GET /api/pages/{id}/image/{kind}` | Private original, thumbnail, clean, mask or translated PNG |
| `GET /api/pages/{id}/regions` | Editable OCR and translation metadata |
| `POST /api/pages/{id}/regions` | Add `{box:[x,y,width,height],language,run_ocr:true}`; validates ownership/bounds and queues selected-crop OCR |
| `POST /api/pages/{id}/ocr` | Retry page detection; optional `{source_lang}` override; preserve saved manual regions |
| `POST /api/regions/{id}/ocr` | Queue selected-region OCR; preserve saved source text and return the new result as `render.ocr_suggestion` |
| `PUT /api/regions/{id}` | Save source, translation, language, box, font size, alignment/offsets, restored; queue render-only job |
| `POST /api/regions/{id}/retranslate` | Translate the saved source of a single region, then queue rendering |
| `POST /api/regions/{id}/feedback` | Record a supported quality category |
| `GET/PUT /api/projects/{id}/glossary` | Chapter terminology as `[{source,target}]` |
| `PUT /api/projects/{id}/progress` | Save `{page: zeroBasedIndex}` |
| `PUT /api/preferences` | Save validated reader/general preferences and an explicit configured translation fallback |
| `GET /api/projects/{id}/metadata` | Export project and region metadata JSON |
| `GET /api/projects/{id}/export` | `authorized=true&format=cbz|zip|pdf&image_format=png|webp` |
| `DELETE /api/projects/{id}` | Delete images/regions/jobs/edits/feedback and clear owner's OCR/translation cache |
| `DELETE /api/cache` | Clear this session's processing cache only |

Example start request:

```json
{"source_lang":"ja","target_lang":"en","provider":"deepl","style":"natural","quality":"quality","direction":"rtl"}
```

Authorized source manifest, hosted on a configured HTTPS host:

```json
{"title":"My original comic · Chapter 1","pages":["https://comics.example/01.png","https://comics.example/02.png"]}
```

Set `AUTHORIZED_SOURCE_HOSTS=comics.example`. Relative image URLs are supported, order is retained, and redirected/image hosts must also be allowed. There is no commercial hosting adapter enabled by default.

Errors use HTTP status and `detail` (validation errors contain a standard FastAPI validation array). Some middleware rejections use plain text. Failed jobs expose `page.error` and remain retryable. Completed pages can be `needs_review`; this is not a processing failure, and is not a claim of translation accuracy.
