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
- Unsafe cleanup preserves artwork and reports a review reason. Hosted region
  retries read only the saved bubble mask.
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

## Dialogue layout and cleanup

Both processing modes show bubble outlines before OCR starts. The user saves
each page selection and explicitly confirms manually drawn boundaries.
The hosted API reads the stored original and builds the masked OCR crop.
The renderer applies only validated glyphs and cleanup. The API checks decoded
pixels outside approved polygons before accepting browser-rendered outputs.
Vertical CJK dialogue uses provider reading order
when available, with geometric right-to-left column ordering as a fallback.
The editor fits actual glyphs to the padded bubble interior at 12px or larger.
It preserves manual line breaks and uses the full confirmed shape for automatic
placement. Cleanup can reach closer to the outline. The inspector overlays the
boundary, proposed source mask, placement area and failed pixels. A replacement
appears only when its cleanup and translation both pass validation.

Auto-Fit Text resets the layout controls for the selected bubble. A saved
layout edit or Retry Cleanup reuses the bubble's OCR and translation. The
editor offers Edit Bubble Boundary when source ink crosses the selection and
Edit Translation when the full text needs a shorter wording.

The editor's Rebuild page translation action reuses completed OCR. Retry page OCR
explicitly recognizes the page again. Both preserve saved manual corrections;
unsaved drafts must be saved first. Retry budgets are cumulative. Original files
remain unchanged. Each region reports applied mask pixels or the reason its
original lettering was preserved. Decorative lettering over complex artwork
remains a manual-review case. Existing pages need a saved bubble selection and
an explicit restart before receiving new OCR or translations.
