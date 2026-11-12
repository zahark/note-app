# PDF and GPX Attachments

## Overview
- Notes can currently embed only images (PNG/JPEG/WebP/GIF). Add two file kinds:
  - **PDF**: shown in a small in-note viewer (page canvas, previous/next page, "page i of n") plus a download button.
  - **GPX**: shown as a file chip (name, size) with a download button; no preview.
- Works for the owner and in shared notes (PIN token or signed link), with the same zero-public-access rules as images.
- Builds on the existing attachment machinery: user-owned `attachments` rows, `attachment://<aid>` references in content, `note_attachments` sync on save, the 7-day sweep, the per-account quota and upload rate limit, backups. No schema change: the existing `mime` and `original_name` columns are enough.

## Context (from discovery)
- Server: `apps/server/src/services/attachments.ts` (`detectImageMime`, `storeUpload`, `MAX_ATTACHMENT_BYTES`, quota), `apps/server/src/routes/attachments.ts` (owner upload/fetch), `apps/server/src/routes/shared.ts` (shared fetch), `apps/server/src/app.ts` (CSP for HTML pages).
- `extractAttachmentIds` already matches any JSON string that is exactly `attachment://<uuid>`, so new node types are linked/swept with no server change to reference handling.
- Web: `apps/web/src/features/editor/AttachmentImage.ts` (image node, resolver, clipboard rules), `extensions.ts`, `NotePane.tsx` (upload loop, file input, paste/drop), `api.ts` (`ACCEPTED_IMAGE_TYPES`, `imageFileProblem`, `uploadAttachment`, `imageFilesFrom`), `Toolbar.tsx`; shared view `features/share/SharedView.tsx` and `features/share/api.ts` (`createSharedAttachmentResolver`, blob URLs, credential in header).
- E2E: `e2e/smoke.spec.ts`, generated fixtures in `e2e/png.ts`.
- Conventions: see `CLAUDE.md` (owner-scoped repos, `{error:{code,message}}`, helpers in `.ts` not `.tsx`, units in `units.ts`, RateLimiter API).

## Development Approach
- **testing approach**: TDD (tests first), as in the original plan
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task** (`npm run lint`, `npm test`; E2E in the E2E task and at the end)
- **CRITICAL: update this plan file when scope changes during implementation**
- keep existing image behaviour unchanged

## Testing Strategy
- **server**: Vitest with `app.inject` (existing pattern): type detection, size limits per kind, quota/rate limit still applied, download headers on owner and shared routes, cross-user/cross-note isolation for the new kinds.
- **web**: Vitest + Testing Library: file node schema/clipboard round-trip, node views (chip, viewer states), upload routing by kind, shared view download/preview with the credential never in a URL.
- **e2e**: Playwright: attach a PDF and a GPX, PDF viewer renders page 1, GPX downloads with the right name and bytes, both work in a shared note in a fresh context.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; document blockers with ⚠️ prefix

## Solution Overview
- **Server accepts three kinds**, detected from content, never from the client's declared type or extension:
  - image: unchanged (PNG/JPEG/WebP/GIF magic bytes), 10 MB limit, served inline as today.
  - PDF: bytes start with `%PDF-`; stored mime `application/pdf`; limit 25 MB.
  - GPX: UTF-8 text (optional BOM) whose first element, after an optional XML declaration, comments and whitespace, is `<gpx` (any namespace prefix not allowed; root must be literally `gpx`); reject any `<!DOCTYPE` or `<!ENTITY` anywhere in the first 64 KB; stored mime `application/gpx+xml`; limit 25 MB.
  - Everything else is still 415 `UNSUPPORTED_MEDIA_TYPE`. The quota and upload rate limit apply to all kinds.
- **Non-image files are always served as downloads** on both the owner route and the shared route: `Content-Disposition: attachment; filename*=UTF-8''<encoded original_name>` (with a safe ASCII `filename=` fallback), `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: sandbox` on the file response itself, so opening a file URL directly can never render it on the app's origin. Images keep today's headers.
  - ➕ (review) images get `Content-Disposition: inline` with a server-derived name ending in the detected image extension, and the web client saves only a response typed PDF/GPX under the server's name (never the node's `name`; otherwise an error toast), so a file node pointing at an image named `x.js` cannot be saved as `x.js`.
  - ➕ (review) a PDF/GPX name is forced to end in `.pdf` / `.gpx` (appended when missing, `setup.exe` → `setup.exe.pdf`) at upload and in `Content-Disposition`, so a saved download always opens as the checked kind; the `%PDF-` header must be at offset 0 (an executable whose stub carries `%PDF-` is 415).
- **Editor**: a new `AttachmentFile` TipTap block node (atom) with attrs `src` (`attachment://<aid>`), `name`, `size`, `kind` (`pdf` | `gpx`). It uses the same resolver idea as images and the same clipboard rules (`data-attachment-id`, only `attachment://` references survive a paste). `name`/`size`/`kind` are display-only text, rendered as text nodes (never HTML).
  - `kind: 'gpx'`: chip with icon, name, human-readable size, Download button.
  - `kind: 'pdf'`: the same chip plus a small viewer: fixed max height (about 480 px), fit-to-width canvas for the current page, previous/next buttons, "page i of n", loading and "Preview unavailable, download instead" states.
- **PDF viewer** uses `pdfjs-dist`, lazy-loaded (dynamic import) only when a PDF node is shown, so the main bundle does not grow. The worker is bundled by Vite and loaded from the same origin; `isEvalSupported: false`; no PDF scripting, annotation forms or external links are enabled. Bytes come from the existing fetch paths (owner: `GET /api/attachments/:aid` with the session cookie; shared: the credential in a header, as for images), passed to PDF.js as an `ArrayBuffer`, never as a URL.
- **Downloads** on the client: owner chips link to `/api/attachments/:aid` (the server's `Content-Disposition` names the file). Shared chips fetch with the credential, create a blob URL and trigger a download with the stored file name; the token never appears in a URL.
- **Upload entry points**: toolbar "Attach file" button (accepts `.pdf,.gpx`), plus drag-and-drop and paste. Files are routed by extension and type on the client (browsers often report GPX as an empty or generic type); the server re-checks content. The existing batch behaviour (stop at the first 429 / quota error, one toast) covers all kinds.
- **CSP**: confirm the HTML page CSP allows the bundled PDF.js worker (`worker-src` falls back to `script-src 'self'`) and canvas rendering; adjust only if a real test shows a need, and never add `unsafe-eval`.

## Technical Details
- Size limits: `MAX_IMAGE_BYTES` = 10 MiB (today's `MAX_ATTACHMENT_BYTES`), `MAX_FILE_BYTES` = 25 MiB for PDF/GPX. The multipart `fileSize` limit becomes the largest of the two; the per-kind check happens after detection. Error messages are built from the constants.
- `displayName` fallback becomes per kind (`image`, `document.pdf`, `track.gpx`).
- Shared payload is unchanged (`attachment_ids`); the file node's own attrs carry name/size/kind for display, while the download file name comes from the server's `original_name`.
- Web constants mirror the server (`ACCEPTED_FILE_EXTENSIONS`, per-kind limits) in `features/editor/api.ts`.

## What Goes Where
- **Implementation Steps**: code, tests, docs in this repo.
- **Post-Completion**: manual checks in real browsers (Safari, a phone), large real-world PDFs and GPX exports.

## Implementation Steps

### Task 1: Server file-type detection and per-kind limits

**Files:**
- Modify: `apps/server/src/services/attachments.ts`
- Modify: `apps/server/test/attachments.test.ts`

- [x] write tests: PDF bytes (`%PDF-1.7…`) stored as `application/pdf`; GPX with and without BOM / XML declaration / leading comments stored as `application/gpx+xml`; a declared type or file extension that disagrees is ignored; generic XML (`<kml>`, `<svg>`), a GPX with `<!DOCTYPE`/`<!ENTITY`, an HTML file, and random bytes → 415
- [x] write tests: images over 10 MiB → 413; PDF/GPX up to 25 MiB accepted, over 25 MiB → 413; quota and upload rate limit apply to PDF/GPX exactly as to images
- [x] implement `detectAttachmentKind(buf)` (image kinds via existing `detectImageMime`, `%PDF-`, the GPX sniff from Solution Overview) and per-kind limits in `storeUpload`; raise the multipart `fileSize` limit to the larger limit
- [x] update error messages and `displayName` fallback per kind
- [x] run tests — must pass before task 2

### Task 2: Download headers on owner and shared routes

**Files:**
- Modify: `apps/server/src/routes/attachments.ts`, `apps/server/src/routes/shared.ts`
- Modify: `apps/server/test/attachments.test.ts`, `apps/server/test/shared.test.ts`, `apps/server/test/isolation.test.ts` (if new rows are needed)

- [x] write tests: owner and shared GET of a PDF/GPX return `Content-Disposition: attachment` with the stored name (incl. a non-ASCII name and a name containing quotes/semicolons, safely encoded), `nosniff`, and `Content-Security-Policy: sandbox`; images keep today's headers (no disposition)
- [x] write tests: user B gets 404 for A's PDF/GPX; a shared note's credential cannot fetch a PDF linked only to another note (identical UNAVAILABLE)
- [x] implement one shared header helper used by both routes (`attachmentResponseHeaders` + `contentDisposition` in `services/attachments.ts`)
- [x] run tests — must pass before task 3

### Task 3: AttachmentFile editor node (chip + download)

**Files:**
- Create: `apps/web/src/features/editor/AttachmentFile.ts`, `apps/web/src/features/editor/AttachmentFile.test.ts`
- Modify: `apps/web/src/features/editor/extensions.ts`, `apps/web/src/features/editor/AttachmentImage.ts` (share the scheme/parse helpers if needed, without changing image behaviour)

- [x] write tests: `getJSON()` keeps `attachment://<aid>` and the name/size/kind attrs; `renderHTML` (clipboard) has `data-attachment-id` and never a resolved URL; copy/paste within and across editors keeps the node; a pasted file block without an `attachment://` reference is dropped; name/size are rendered as text, not HTML
- [x] write tests: GPX chip shows name and size and a Download control that uses the supplied download handler; PDF chip shows the same plus a viewer slot
- [x] implement the node (block, atom, draggable) with a node view and options `{ resolveAttachment, downloadAttachment }`
- [x] run tests — must pass before task 4

### Task 4: PDF viewer

**Files:**
- Create: `apps/web/src/features/editor/PdfViewer.tsx`, `apps/web/src/features/editor/pdf.ts` (lazy PDF.js loader), `apps/web/src/features/editor/PdfViewer.test.tsx`
- ➕ Create: `apps/web/src/features/editor/pdfViewerMount.ts` (`mountPdfViewer`: own React root per mount, used by the plain-DOM node view), `apps/web/src/features/editor/pdf.test.ts` (the `pdf.ts` wiring against a fake `pdfjs-dist`)
- Modify: `apps/web/package.json` (add `pdfjs-dist`), `apps/web/src/features/editor/AttachmentFile.ts`

- [x] write tests (PDF.js mocked at the `pdf.ts` boundary): loading state, renders page 1, previous/next and "page i of n" (buttons disabled at the ends), error state shows "Preview unavailable" with the download button still working, the viewer is not created for GPX
- [x] implement `pdf.ts`: dynamic import of `pdfjs-dist`, same-origin bundled worker, `isEvalSupported: false`, bytes passed as `ArrayBuffer`, document destroyed on unmount
  - note: `pdfjs-dist` 6.4.299 no longer has the `isEvalSupported` option (no eval code path left), so it is not passed; `enableXfa: false` and canvas-only rendering (no annotation layer) are set instead
- [x] implement `PdfViewer` (fit-to-width canvas, max height about 480 px, keyboard-accessible buttons) and mount it from the PDF node view
- [x] verify `npm run build -w apps/web` keeps PDF.js out of the main chunk (separate lazy chunk) and record chunk sizes in the plan
  - main `index-*.js`: 1,034.50 kB (327.67 kB gzip) before → 1,039.75 kB (329.57 kB gzip) after (+5 kB: viewer + loader only)
  - lazy `pdf-*.js` (PDF.js): 430.16 kB (129.27 kB gzip); worker asset `pdf.worker.min-*.mjs`: 1,264.34 kB, same origin, loaded only when a PDF is shown
  - after switching to the legacy build (user decision during review, for older iOS/Android browsers): main `index-*.js` unchanged at 1,042.69 kB (330.67 kB gzip, same with the modern build at that point); lazy `pdf-*.js`: 430.16 kB (129.27 kB gzip) → 487.47 kB (148.09 kB gzip); worker `pdf.worker.min-*.mjs`: 1,264.34 kB → 1,321.30 kB
- [x] run tests — must pass before task 5

### Task 5: Upload entry points and routing

**Files:**
- Modify: `apps/web/src/features/editor/api.ts`, `apps/web/src/features/editor/NotePane.tsx`, `apps/web/src/features/editor/Toolbar.tsx`
- Modify: `apps/web/src/features/editor/NotePane.test.ts`

- [x] write tests: toolbar "Attach file" opens a file input accepting `.pdf,.gpx`; a PDF inserts a `pdf` file node, a GPX (type `''` or `application/octet-stream`, `.gpx` name) inserts a `gpx` file node, an image still inserts an image node; drag-and-drop and paste route the same way; an unsupported file shows a clear toast; per-kind size limits checked client-side; batch stops at the first 429/quota error with one toast (existing behaviour) for mixed batches
- [x] implement per-kind client checks and routing; keep `uploadAttachment` as the single upload call; owner `downloadAttachment` = navigate an anchor to `/api/attachments/:aid`
- [x] run tests — must pass before task 6

### Task 6: Shared view support

**Files:**
- Modify: `apps/web/src/features/share/api.ts`, `apps/web/src/features/share/SharedView.tsx`
- Modify: `apps/web/src/features/share/SharedView.test.tsx`

- [x] write tests: a shared note with a PDF shows the viewer, its bytes are fetched from `/api/shared/:id/attachments/:aid` with the token in a header (PIN mode) or `exp`/`sig` (signed mode); a GPX chip downloads via a credentialed fetch and a blob URL named after the file; the token never appears in any URL; blob URLs are revoked on unmount; a failed fetch shows the error state, not the "unavailable" page
- [x] implement the shared resolver/downloader for file nodes (reuse the existing credentialed fetch)
  - `createSharedAttachmentResolver` gained `download(aid, name)`: it shares the resolver's cache (one credentialed fetch per attachment), saves the blob URL under the server's `Content-Disposition` name (`fileNameFromDisposition`), else the chip name; the blob URL stays cached until unmount; a failed download shows a toast
- [x] run tests — must pass before task 7

### Task 7: E2E coverage and CSP check

**Files:**
- Modify: `e2e/smoke.spec.ts`
- Create: `e2e/files.ts` (generate a small multi-page PDF and a GPX in code, no binary fixtures)
- Modify (only if needed): `apps/server/src/app.ts` (CSP)

- [x] write E2E: in the owner view attach a 2-page PDF and a GPX; the PDF viewer shows "page 1 of 2", next shows page 2 and the canvas has non-zero size; the GPX Download triggers a download whose name and bytes match
  - the generated PDF has a red page 1 and a blue page 2, so the test also checks the canvas center pixel per page
- [x] in the existing fresh-context shared step, the PDF viewer renders and the GPX downloads with the PIN token
- [x] confirm no CSP violations in the browser console for the PDF viewer (worker load, canvas); if one appears, adjust the CSP minimally (never `unsafe-eval`) and add a server test for the header
  - owner view: none. Shared view: the viewer's `fetch` of its blob URL was blocked (`connect-src` fell back to `default-src 'self'`), so the shared PDF showed "Preview unavailable". Fixed by adding `connect-src 'self' blob:` to the page CSP (`apps/server/src/app.ts`), with a test in `apps/server/test/static.test.ts`; the worker loads under `default-src 'self'`, no eval needed
- ➕ [x] fix: an attachment inserted at the cursor replaced the previously inserted one (the inserted block stays node-selected at the end of a note); `insertAttachments` now inserts after a selected node (`NotePane.tsx`, test in `NotePane.test.ts`)
- [x] run E2E — must pass before task 8

### Task 8: Verify acceptance criteria
- [x] verify all requirements from Overview are implemented
  - PDF viewer (page canvas, previous/next, "page i of n", download), GPX chip with download, owner and shared (PIN) paths: covered by the E2E smoke and the unit tests; no schema change
- [x] verify edge cases: renamed extensions, BOM GPX, DOCTYPE GPX rejected, oversized files, quota, copy/paste of file nodes across notes, deleting the source note keeps a copied PDF (sweep rules)
  - all already covered (`attachments.test.ts`, `AttachmentFile.test.ts`) except the last one for file nodes: ➕ added `attachment-lifecycle.test.ts` "a PDF/GPX file node copied into B survives deleting note A and the sweep; dropped from both, it is swept"
- [x] run full test suite: `npm test`
- [x] run lint: `npm run lint`
- [x] run e2e tests: `npx playwright test`
- [x] build the Docker image and confirm a PDF upload and preview work in the container (Colima is installed)
  - built under a separate compose project (`-p notesverify`, own image tag, port 127.0.0.1:3300, own volume/network); curl: PDF and GPX uploads 201, `GET /api/attachments/:aid` → `Content-Disposition: attachment; filename=…; filename*=UTF-8''…`, `nosniff`, `Content-Security-Policy: sandbox`, bytes identical; HTML named .pdf → 415; the built SPA serves the lazy `pdf-*.js` chunk and the `pdf.worker.min-*.mjs` worker same-origin; the full Playwright smoke spec passed against the container (PDF viewer pages, GPX download, shared PIN view, no CSP violations); everything torn down afterwards

### Task 9: [Final] Update documentation
- [x] update README.md (Features: PDF viewer and GPX downloads; limits per kind; security note that non-image files are always served as downloads)
  - also: nginx `client_max_body_size 27m`, quota/upload rate-limit wording covers all kinds (README, `.env.example`, `config.ts` comment), GPX must be UTF-8, lazy PDF.js chunk; the start/stop, backup/restore and moving sections are unchanged
- [x] update CLAUDE.md (AttachmentFile node, per-kind detection and limits, download header helper, PDF.js lazy loading)
- [x] move this plan to `docs/plans/completed/` (skipped - the plan is moved by the exec harness after all phases finish)

## Post-Completion
*Informational only*

**Manual verification:**
- open a real route-guide PDF (multi-page, images, embedded fonts) in Chrome, Safari and on a phone
- download a GPX exported from a real app and import it back into that app
- check the PDF viewer on a slow connection (loading state) and with a corrupted PDF (error state)
- on a real iPhone: the "Attach file" picker offers `.gpx` files (the input accepts `application/gpx+xml` as well as `.gpx`; if GPX files are still greyed out, drop the GPX part of the `accept` filter, since client and server re-check the kind)
- on the phones and browsers you actually use, including an older iPhone/Android: the PDF viewer renders (the PDF.js legacy build targets older browsers; one that still fails shows "Preview unavailable", see README "Browser support")
- a PDF with non-embedded standard fonts and one with CJK text render their text (standard-font data and CMaps are served from `/pdfjs/`); a JPEG 2000 / JBIG2 scan is expected to show blank images
