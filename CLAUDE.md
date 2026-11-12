# Notes App — project conventions

Self-hosted notes app: npm workspaces monorepo, `apps/server` (Fastify + TypeScript + better-sqlite3 +
zod) serves `/api/*` and the built `apps/web` SPA (React + Vite + Tailwind + shadcn/ui + TipTap +
TanStack Query) from one origin. All state lives in `DATA_DIR` (`notes.db` + `uploads/`). README.md
covers setup, env vars, Docker, backup and password reset.

## Commands (repo root, Node 22+)

- `npm test` — Vitest in both apps (server tests use in-memory SQLite + `app.inject`)
- `npm run lint` — ESLint + type checks of server, web and `e2e/`
- `npm run test:e2e` — Playwright smoke test (builds, runs the compiled server on :3100, temp DATA_DIR)
- `npm run build` / `npm run dev`
- Single test file: `npm test -w apps/server -- test/move.test.ts`,
  `npm test -w apps/web -- src/features/tree/dnd.test.ts`

## Toolchain facts

- TypeScript is pinned to `~6.0.3` because typescript-eslint 8.x supports only `<6.1`; do not bump to
  TS 7 until typescript-eslint does.
- Nothing loads `.env` automatically (no dotenv, no `--env-file`); `loadConfig` reads only
  `process.env`. Export it first: `set -a; . ./.env; set +a`.
- `npm run reset-password` and `npm run backup` run the compiled `dist/cli/*.js`, so run
  `npm run build -w apps/server` first after changing them.

## Server layout

`routes/` (HTTP + zod validation only) → `services/` (share, tree, attachments, auth, rate limits)
→ `repos/` (SQL) → `db/` (connection, migrations). CLIs in `src/cli/` (expected operator errors throw
`CliError` from `cli/common.ts`). Durations and sizes use the units in `src/units.ts` (`MINUTE_MS`,
`DAY_SEC`, `MIB`, …). Rate limits use `RateLimiter` (`services/rateLimiter.ts`): `check`/`enforce` throw
the 429; an outcome known only after an await (a password check) is `reserve`d first and `release`d after.

`buildApp(opts)` seams: `auth: {hasher, hashLimiter, now}` (fake hasher, hash limiter and clock; the
share service shares them), `webDir` (serve a built SPA), `attachmentSweep` (the daily stray-upload
sweep). **`attachmentSweep` is off by default and only `src/index.ts` turns it on; tests must never
enable it against the default `./data`** — an in-memory test DB has no attachment rows, so the sweep
would delete real uploads as strays. `test/helpers/auth.ts` `makeApp` also takes `onRoute` (hook
installed before ready, used by the isolation coverage check) and `hashWaitMs`.

## Web

- `react-refresh/only-export-components` is on: a component module exports only components, so pure
  helpers and hooks live in `.ts` modules (`features/tree/treeOps.ts`, `buildTree.ts`,
  `useTreeRowDnd.ts`, `features/*/api.ts`). Wire types live in their feature's `api.ts` (the tree's
  `TreeFolder`/`TreeNote`/`TreeData` in `features/tree/api.ts`). The rule is off only for `components/ui/**` (shadcn) and tests.
- Every request goes through `apiFetch` in `lib/api.ts`: errors become `ApiError` built from
  `{error:{code,message}}`; the `credentials` option exists so the shared API can use `'omit'`.
- The global 401 handling (clear cached user, go to `/login`) triggers only for code `UNAUTHORIZED`,
  never for `INVALID_CREDENTIALS` (a wrong password on the login form).
- Tree mutations are optimistic (`features/tree/mutations.ts`): snapshot the tree cache, patch it,
  on error roll back + toast + refetch; on success copy back only the field the mutation changed. The
  tree query has a 5-minute `staleTime`, so opening a note does not refetch it.
- `useOpenNote()` (`features/tree/useOpenNote.ts`) owns the `?note=` search param; `errorMessage`
  lives in `lib/api.ts`.
- `Layout` keeps `children` at one stable position in the element tree on every breakpoint (sidebar
  panel on desktop, drawer on mobile); never return different trees per breakpoint, or the editor
  remounts mid-edit.
- Radix menu actions run in `onCloseAutoFocus`, not `onSelect`: the menu's focus trap would otherwise
  steal focus from the rename input it opens.
- An editor's `Autosaver` outlives the editor: it stays in the saver registry (`features/editor/api.ts`:
  unsaved-changes prompt, tab-hide flush, `flushAllSaves()`) until it settles (nothing pending or in
  flight, or stopped by a 409 / non-retryable error), so a failed save of a closed note keeps being
  retried. The note query uses `gcTime: 0` and waits for that note's savers to settle before
  fetching, so a reopened note never loads pre-save content (which would 409 on the next autosave).
  `useAutosave({noteId, version})` returns `{status, schedule, error}`; signing out awaits
  `flushAllSaves()` before calling `/api/auth/logout`.
- Images in the editor are only ever `attachment://<aid>`: the parse rule drops any other `<img>`, and
  the node view never loads a non-attachment src.
- PDF/GPX attachments are the `AttachmentFile` block node (`features/editor/AttachmentFile.ts`, atom,
  attrs `src` = `attachment://<aid>`, `name`, `size`, `kind` `pdf|gpx`) with the same clipboard rules as
  images (`data-attachment-id`; a pasted file block without an `attachment://` reference is dropped).
  `name`/`size`/`kind` are untrusted display text, set with `textContent` only. Node options
  `{resolveAttachment, downloadAttachment}`: the owner downloads via an anchor to
  `/api/attachments/:aid` (`downloadOwnerAttachment`), the shared view via
  `createSharedAttachmentResolver(...).download` (credentialed fetch + blob URL, token never in a URL).
- Uploads are routed by kind on the client (`uploadKindOf`/`checkUploadFile` in `features/editor/api.ts`:
  image types first, then `.pdf`/`.gpx` by type or extension, since browsers often report GPX as `''`);
  the per-kind limits there mirror the server's. `uploadAttachment` is the single upload call.
- PDF.js is touched only by `features/editor/pdf.ts` (`loadPdf(ArrayBuffer)`): `pdfjs-dist` and its
  worker (`?url`, same origin) are dynamic imports, so they stay in a lazy chunk out of the main bundle;
  bytes are passed as an `ArrayBuffer`, never a URL; canvas-only rendering, `enableXfa: false` (PDF.js 6
  has no `isEvalSupported`). Tests mock `pdf.ts`. The plain-DOM node view mounts the React `PdfViewer`
  through `mountPdfViewer` (`pdfViewerMount.ts`, own React root per mount).

## Authorization: owner-scoped repos (security-critical)

- Every function in `repos/folders.ts`, `notes.ts`, `attachments.ts`, `access.ts` takes
  `(db, userId, ...)`, calls `requireUserId(userId)` first (`repos/scope.ts`) and filters every query
  by `user_id`. `test/repos.test.ts` enumerates these modules' exports, so a new function is covered
  automatically and must follow the rule.
- `repos/publicShare.ts` is the **only** module allowed to query without a `userId` (public shared API
  and the attachment sweep). It is read-only apart from the sweep's deletes, and every function there
  documents why it is unscoped. Do not add unscoped queries anywhere else.
- `users.ts`, `sessions.ts`, `knownDevices.ts` are auth lookups (by email/token hash, before an
  identity exists) and are outside the rule.
- Ownership applies to every id the caller supplies, in path params **and** body fields
  (`parent_folder_id`, `folder_id`, move targets). Check a body-supplied folder inside the same
  statement (`INSERT … SELECT … WHERE user_id = ?`), not with a separate read.
- Repos signal not-found with `undefined`/`false`; routes map that to **404, never 403**, so other
  users' resources are indistinguishable from missing ones.
- **Every new private endpoint gets a row in `apps/server/test/isolation.test.ts`** (user B with user
  A's ids, in path and body → 404, nothing changed). Its coverage check fails on any registered private
  route missing from the table.
- `resolveAccess(userId, noteId)` returns `owner | none`; it is the seam for future multi-user access.
  Routes do not call it yet (each checks ownership in its own `user_id`-filtered query); route note
  access through it when a second access level is added.

## Error format

- Every error response is `{error:{code,message}}`. Throw the helpers from `src/errors.ts`
  (`notFound`, `conflict`, `badRequest`, `tooManyRequests(msg, retryAfterMs)`, …, or `new AppError`);
  the global error handler formats them, turns a `ZodError` into a 400 and anything else into a generic
  500. Never `reply.send` an ad-hoc error shape.
- Request bodies use `z.strictObject` (unknown fields → 400), e.g. the content-save endpoint rejects
  `title`.

## Other invariants

- Ids are UUIDv4 generated server-side. Timestamps used by the attachment sweep are unix seconds.
- Schema changes: add a new numbered `src/db/migrations/NNN_name.sql` (run at boot, copied to `dist/`
  on build); never edit an applied migration.
- `notes.version` guards **content only**: `PUT /api/notes/:id/content {content, version}` increments
  it, stale → 409. Renames and moves use separate endpoints that neither send nor change `version`.
- Images and files are stored in content as `attachment://<aid>`; never store a real URL. Attachments
  belong to the user; `note_attachments` is rebuilt from the content on every save (foreign ids
  ignored), and only the sweep deletes files (7 days after the last reference is gone).
- Attachment kinds are detected from content only (`detectAttachmentKind` in
  `services/attachments.ts`): image magic bytes (`MAX_IMAGE_BYTES` 10 MiB), `%PDF-` (`MAX_FILE_BYTES`
  25 MiB), GPX = UTF-8 (optional BOM) whose root element is literally `gpx`, rejected on any
  `<!DOCTYPE`/`<!ENTITY` in the first 64 KiB (25 MiB); anything else is 415. The multipart limit is
  `MAX_UPLOAD_BYTES` (the larger); the per-kind check runs after detection. Quota and `UPLOAD_LIMIT`
  cover every kind; no schema change (`mime` + `original_name`).
- File responses (owner and shared routes) get their headers only from `attachmentResponseHeaders`
  (`services/attachments.ts`): images inline + `nosniff`; every non-image kind is always a download
  (`contentDisposition(original_name)`: ASCII `filename=` fallback + `filename*=UTF-8''…`) with
  `nosniff` and `Content-Security-Policy: sandbox`. The page CSP (`app.ts`) has
  `connect-src 'self' blob:` for the shared PDF viewer; never add `unsafe-eval`.
- Signup (`ALLOW_SIGNUP` → `config.signupMode`) defaults to `first-user`: open only while `users` is
  empty. `createUser(..., {onlyIfFirst})` re-checks emptiness inside the IMMEDIATE insert transaction, so
  of simultaneous first signups exactly one succeeds. Tests that sign up more than one account via the
  API pass `makeApp({ env: { ALLOW_SIGNUP: 'true' } })`; `seedUser` bypasses signup entirely.
- Note creation and content saves are rate-limited per account (`NOTE_LIMITS` in `routes/notes.ts`,
  route-level `onRequest` hooks, so a limited save is refused before its body is parsed).
- Rate limits are checked **before** any argon2 work, and all argon2 work goes through `hashLimiter`
  (one slot reserved for the owner account on a known device).
- The public shared API (`/api/shared/*`) never reads the session cookie; every failure other than 429
  returns the byte-identical "unavailable" response. The web client calls it with
  `credentials: 'omit'` and keeps unlock tokens out of URLs.

## Tests

- TDD; every code change ships with tests. Server helpers: `test/helpers/auth.ts` (`makeApp`,
  `FakeClock`, `FakeHasher`, `seedUser`) and `test/helpers/api.ts` (`loginAs`, `api`). Mutating
  requests must carry the exact `Origin` (`api` does this).
- Time-dependent code takes an injectable clock/`now`; tests advance it instead of sleeping.
- Web: Vitest + Testing Library, colocated `*.test.ts(x)` under `apps/web/src/features/{auth,tree,editor,share}`.
  Helpers in `apps/web/src/test/utils.tsx`: `mockFetch({"METHOD /path": response | handler})` stubs
  `fetch` and returns the recorded requests (a handler may return a promise to hold a response back
  until the test releases it), plus render helpers and `LocationProbe` for asserting navigation.
  Handlers may also throw, to simulate a network error. `src/test/setup.ts` adds jsdom shims
  (ResizeObserver, matchMedia, Range rects and `elementFromPoint` for ProseMirror) and calls
  `resetSavers()` after each test. Never leave an autosaver behind with a mock that fails
  forever: it keeps retrying and leaks PUTs into later tests.
- E2E (`e2e/`, `npm run test:e2e`) builds both apps and runs the compiled server with Node on
  `127.0.0.1:3100` (`E2E_PORT` overrides) with a fresh temp `DATA_DIR`; run
  `npx playwright install chromium` once.

## Deployment

See the README "Docker" section. Invariants that keep the rate-limit IP keys correct:

- `TRUST_PROXY` is set explicitly in the base `docker-compose.yml` and in every override, so a value in
  `.env` never leaks into a deployment it does not fit.
- The tunnel override trusts only `cloudflared`'s fixed address `172.30.0.10`, never the subnet; the
  network's dynamic `ip_range` is `172.30.0.128/25` so nothing else can get `.10`.
- Whenever `TRUST_PROXY` is set, the app port must be reachable only through that proxy.
