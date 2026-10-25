# Vercel and Supabase deployment

The root Next.js app includes a hosted processing mode. On Vercel, leave
`API_INTERNAL_URL` unset to select it. This mode requires no Python service or
background worker. The owner's computer can be off. A visitor's browser tab
coordinates processing and must stay open until it finishes.

## Request and storage flow

Browser â†’ Vercel Next.js API â†’ authenticated Supabase Edge gateway â†’ private
Postgres tables and Storage. Provider calls run on Vercel; DeepL and OCR.space
keys never reach the browser. The gateway uses Supabase's built-in service-role
credential internally and accepts a separate random bearer token from Vercel.
Only the SHA-256 of that token is embedded in its deployed source.

Images upload directly to signed Supabase URLs, avoiding Vercel's function
payload limit. The browser decodes imports, creates overlapping JPEG OCR tiles,
renders conservative white-background cleanup and translated text, and generates
ZIP/CBZ/PDF exports. Original PNG files remain separate.

The browser saves progress after each recognized tile and each translated page.
A five-minute page lease and optimistic document versions reject competing tabs
and stale editor saves. Resume keeps saved text and translations. Failed or
uncertain external requests count against the budget. An interrupted provider
request can be repeated after resuming; exactly-once provider billing is not
promised.

## Setup

1. Import the GitHub repository root into one Vercel project. Use Next.js,
   Node 24.x, `npm ci`, `npm run build`, and default output.
2. Inspect the target Supabase schema and buckets. Apply the checked-in
   `browser_processing` migration to a new project. Its private tables enable RLS
   and revoke access from anonymous and authenticated public roles. Only the
   service role may call its budget and capacity functions.
3. Generate a cryptographically random gateway token of at least 32 bytes.
   Substitute its SHA-256 hex digest for `__MANGALENS_GATEWAY_HASH__` when deploying
   `mangalens-gateway`. Keep `verify_jwt=false` because the function authenticates
   its own bearer token. Do not put the actual token in the function source.
4. Set encrypted, server-only Vercel variables `SUPABASE_URL`,
   `MANGALENS_GATEWAY_SECRET`, `DEEPL_API_KEY` and `OCR_SPACE_API_KEY` for Production
   and Preview. Use a DeepL API Free key and OCR.space free key. No browser
   environment variables or Supabase service-role key are required.
5. Deploy and verify health, session creation, upload, real OCR/translation,
   images, editor save, exports and private session isolation.

To test this mode locally, use ignored `.env.local` with `MANGALENS_CLOUD=1` and
the same four server values. Local development otherwise uses the Python API.

## Free-mode limits

- At most 20 stored pages across all browser sessions, 10 chapters per session,
  20 pages per import, 64 MiB input and 128 MiB expanded archive.
- At most 12 megapixels per page and 8 MiB per normalized PNG.
- Global OCR budget: 50 attempted tiles/day, 400/month, including at most
  300 Engine 3 attempts/month. Every retry counts; no automatic paid fallback.
- Global DeepL budget: 100,000 submitted characters/month. The provider's own
  quota and rate limits also apply, including usage outside MangaLens.
- Every output is marked for manual review. OCR.space supplies no confidence
  scores. Complex backgrounds are preserved unless the user verifies an
  explicit mask. Text that cannot fit at 12px preserves original lettering.
- Projects expire after seven days. Library access removes expired files and
  documents. This is lazy cleanup, not an exact deletion deadline. Download
  important results before expiry.
- Temporary libraries belong to an HttpOnly browser cookie. Clearing cookies or
  switching hostname/browser starts another library; there is no account
  recovery or public sharing feature.
- Provider limits, Vercel Hobby limits, and Supabase Free quotas can pause
  processing. Supabase may pause inactive free projects. This setup does not
  enable a paid plan, metered upgrade, always-on worker or billing fallback.

The Python deployment retains local OCR/models, OpenCV and broader provider
features. For that mode, supply an HTTPS `API_INTERNAL_URL` and keep the API and
worker running on a persistent host. Hosted browser libraries do not migrate
existing Python database files.

## Local verification

`npm run typecheck`, `npm run test:deployment`, `npm run test:cloud`,
`npm run build`, and `npm run test:cloud-browser` cover routing, real PostgreSQL
migration/budget/access rules (PGlite), ownership and optimistic conflicts, OCR
coordinate parsing, browser import/render/edit/export/deletion and mobile
overflow. Browser fixture tests use fake storage and pre-recognized text; they
do not prove live provider connectivity. Live verification must be recorded
separately after configuration.
