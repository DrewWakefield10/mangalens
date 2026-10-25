# MangaLens browser processing contract

The existing English workbench and dark/light themes remain canonical. Browser
processing is an approved hosted variant; local FastAPI routing remains available.

## Canonical UI Map

| Capability     | Canonical owner                          | Source of truth         | Allowed variants                       | Verification          |
| -------------- | ---------------------------------------- | ----------------------- | -------------------------------------- | --------------------- |
| Select/Listbox | Native labeled select                    | DESIGN.md               | Platform popup                         | Browser keyboard      |
| Form           | Existing field/check-field patterns      | Owning route            | Import/edit                            | Browser failure paths |
| Scrollbar      | app/globals.css                          | Runtime CSS tokens      | Global baseline                        | Browser/static audit  |
| Toast          | Inline error/note and alert/status roles | Owning workflow         | Error/status                           | Status assertions     |
| CRUD           | lib/api.ts and API routes                | Session/document checks | Import/preview/chapter; delete/library | API integration       |

- An open tab coordinates processing. Closing it stops coordination. Saved stages
  persist; a five-minute server lease prevents concurrent processing of a page.
  Retried provider requests can consume quota again after uncertain completion.
- Originals stay separate from derived output. Cloud OCR supplies no confidence
  score, so generated pages remain needs_review until inspected.
- Unsafe cleanup preserves artwork and reports a review reason. No mask candidate
  or region-level OCR is offered in the hosted variant.
- Source corrections, masks, and drafts survive failed saves. Document versions
  reject stale editor writes; conflicts require reload.
- Private storage and HttpOnly opaque session cookies protect each library.
  Clearing cookies loses access. No account registration is provided.
- Projects expire after seven days. Expired files are deleted on the owner's next
  library use, not by a scheduled seven-day physical deletion.
- Provider credentials stay server-side. Shared atomic usage reservations include
  failed/uncertain calls and survive project deletion.
- Hosted import: PNG/JPG/WebP, image ZIP/CBZ, PDF; 20 pages, 64 MB compressed input,
  128 MB expanded data, 12 MP/8 MB normalized PNG per page. SQL also caps global
  stored pages. Remote imports and offline models are unavailable in this mode.
