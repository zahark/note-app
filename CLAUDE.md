# Notes App — project conventions

Self-hosted notes app: npm workspaces monorepo, `apps/server` (Fastify + TypeScript + better-sqlite3 +
zod) serves `/api/*` and the built `apps/web` SPA (React + Vite + Tailwind + shadcn/ui + TipTap +
TanStack Query) from one origin. All state lives in `DATA_DIR`: `notes.db` + `uploads/`, the off-site
scheduler's `offsite-backup.json`, and during a restore `restore-staging/`, `restore/`,
`restore-previous/` (+ `restore-staging.lock`). README.md covers setup, env vars, Docker, Fly.io,
backups (local and off-site to R2), restore and password reset.

## Commands (repo root, Node 22+)

- `npm test` — Vitest in both apps (server tests use in-memory SQLite + `app.inject`)
- `npm run lint` — ESLint + type checks of server, web and `e2e/`
- `npm run test:e2e` — Playwright smoke test (builds, runs the compiled server on :3100, temp DATA_DIR)
- `npm run test:docker` — `scripts/check-docker-image.sh`: builds the image as `notes-app:docker-check`
  and checks it with throwaway `notes-app-check-*` volumes/containers (Fly-like root start on a
  root-owned `volume-nocopy` volume, Compose-like `--user 1000:1000`, `docker exec` file ownership,
  `docker compose config` pins `CLIENT_IP_HEADER` empty, the README's Fly operator commands
  `setpriv … npm --prefix /app/apps/server run backup:offsite|restore:offsite` and their root refusal,
  a restart on the chowned volume); removes everything on exit (`KEEP_IMAGE=1` keeps the image)
- `npm run build` / `npm run dev`
- Single test file: `npm test -w apps/server -- test/move.test.ts`,
  `npm test -w apps/web -- src/features/tree/dnd.test.ts`

## Toolchain facts

- TypeScript is pinned to `~6.0.3` because typescript-eslint 8.x supports only `<6.1`; do not bump to
  TS 7 until typescript-eslint does.
- Nothing loads `.env` automatically (no dotenv, no `--env-file`); `loadConfig` reads only
  `process.env`. Export it first: `set -a; . ./.env; set +a`.
- `npm run reset-password`, `backup`, `backup:offsite` and `restore:offsite` run the compiled
  `dist/cli/*.js`, so run `npm run build -w apps/server` first after changing them.
- **Never touch the user's running Compose project `notes-app`** (container `notes-app-app-1`, image
  `notes-app:latest`, volume `notes-app_notes-data`, which holds real notes). Docker checks use their own
  project name, image tag and throwaway volumes. S3 tests run against the in-process fake
  (`test/helpers/fakeS3.ts`), never real R2.

## Server layout

`routes/` (HTTP + zod validation only) → `services/` (share, tree, attachments, auth, rate limits)
→ `repos/` (SQL) → `db/` (connection, migrations). CLIs in `src/cli/` (expected operator errors throw
`CliError` from `cli/common.ts`). Durations and sizes use the units in `src/units.ts` (`MINUTE_MS`,
`DAY_SEC`, `MIB`, …). Rate limits use `RateLimiter` (`services/rateLimiter.ts`): `check`/`enforce` throw
the 429; an outcome known only after an await (a password check) is `reserve`d first and `release`d after.

`buildApp(opts)` seams: `auth: {hasher, hashLimiter, now}` (fake hasher, hash limiter and clock; the
share service shares them), `webDir` (serve a built SPA), `attachmentSweep` (the daily stray-upload
sweep), `offsiteBackup` (the off-site backup scheduler, needs `config.offsiteBackup`). **Both are off
by default and only `prepareServer` (`src/startup.ts`, run by `src/index.ts`) turns them on; tests must
never enable `attachmentSweep` against the default `./data`** — an in-memory test DB has no attachment rows, so the sweep would delete real uploads
as strays. Timers and Fastify hooks stay in `app.ts` (`scheduleAttachmentSweep`,
`scheduleOffsiteBackup`); `services/` stays framework-free. Server code never imports `cli/`. `test/helpers/auth.ts` `makeApp` also takes `onRoute` (hook
installed before ready, used by the isolation coverage check) and `hashWaitMs`.

## Web

- `react-refresh/only-export-components` is on: a component module exports only components, so pure
  helpers and hooks live in `.ts` modules (`features/tree/treeOps.ts`, `buildTree.ts`,
  `useTreeRowDnd.ts`, `features/*/api.ts`). Wire types live in their feature's `api.ts` (the tree's
  `TreeFolder`/`TreeNote`/`TreeData` in `features/tree/api.ts`). The rule is off only for `components/ui/**` (shadcn) and tests.
- Every request goes through `apiFetch` in `lib/api.ts`: errors become `ApiError` built from
  `{error:{code,message}}`; the `credentials` option exists so the shared API can use `'omit'`. A
  caller reading a non-JSON body (a file download, the PDF viewer's bytes) uses `apiFetchResponse`,
  which sends no `accept` header of its own (`apiFetch` adds `accept: application/json`).
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
- Links: StarterKit's link keeps `openOnClick: false` (a click edits). The owner's `LinkPopover`
  (TipTap `BubbleMenu` from `@tiptap/react/menus`, `shouldShowLinkPopover`) offers Open/Edit/Remove;
  its helpers and the `LinkShortcuts` extension (Cmd/Ctrl+click opens, Escape dismisses) live in
  `features/editor/links.ts`. Every open goes through `openLink` (`window.open(…, '_blank',
  'noopener,noreferrer')`, only `http:`/`https:`/`mailto:` via `openableUrl`); the toolbar's Link button
  and the popover's Edit share `applyLinkHref` (bare host → `https://`, empty → unlink). The read-only
  shared view has no popover: a plain click follows the anchor's own `target="_blank"`.
- Images in the editor are only ever `attachment://<aid>`: the parse rule drops any other `<img>`, and
  the node view never loads a non-attachment src. The reference helpers (`attachmentSrc`,
  `parseAttachmentSrc`, `elementAttachmentId`, `AttachmentResolver`) live in
  `features/editor/attachmentRef.ts`, shared by both nodes, the PDF viewer and the shared view.
- PDF/GPX attachments are the `AttachmentFile` block node (`features/editor/AttachmentFile.ts`, atom,
  attrs `src` = `attachment://<aid>`, `name`, `size`, `kind` `pdf|gpx`; the kinds, their MIME types and
  extensions are the `FILE_TYPES` table in `lib/fileTypes.ts`) with the same clipboard rules as
  images (`data-attachment-id`; a pasted file block without an `attachment://` reference is dropped).
  `name`/`size`/`kind` are untrusted display text, set with `textContent` only. Node options
  `{resolveAttachment, downloadAttachment}` (both required by `editorExtensions`): the owner downloads
  with `downloadOwnerAttachment` (`apiFetchResponse` of `/api/attachments/:aid`, then `saveBlob`; an
  error status is toasted, never saved as the file), the shared view via
  `createSharedAttachmentResolver(...).download` (credentialed fetch + blob URL, token never in a URL).
  The saved name comes only from the server: `fileDownloadName` (`Content-Type` PDF/GPX and a
  `Content-Disposition` name ending in its extension), else both paths throw `DownloadRefusedError` and
  toast; the node's `name` attr is never a download name (a file node may point at an image) and is
  passed to the downloader only for error messages. Download helpers (`clickDownload`, `saveBlob`,
  `fileNameFromDisposition`, `fileDownloadName`) live in `lib/download.ts`; blob URLs of non-image
  files are typed `application/octet-stream`. The node view never changes
  `src`/`kind` in place (`update` returns false, so ProseMirror rebuilds it).
- Uploads are checked on the client by a guessed kind (`uploadKindOf`/`checkUploadFile` in
  `features/editor/api.ts`: image types first, then `.pdf`/`.gpx` by type or extension, since browsers
  often report GPX as `''`); the per-kind limits there mirror the server's. `uploadAttachment` is the
  single upload call; `POST /api/attachments` returns `{id, kind, mime, size, name}` and the inserted
  node is built from that server-detected `kind`, never from the guess (a renamed file still gets the
  right node).
- PDF.js is touched only by `features/editor/pdf.ts` (`loadPdf(ArrayBuffer)`): `pdfjs-dist` (pinned
  exactly; the LEGACY build `pdfjs-dist/legacy/build/pdf.mjs` for older iOS/Android browsers, see README
  "Browser support"; tests mock that path) and its legacy worker (`?url`, same origin) are dynamic
  imports, so they stay in a lazy chunk out of the main bundle; bytes are passed as an `ArrayBuffer`,
  never a URL; canvas-only rendering, `enableXfa: false` (PDF.js 6 has no `isEvalSupported`), canvas
  backing store capped (`MAX_CANVAS_PIXELS`/`MAX_CANVAS_SIDE`). The standard-font data and CMaps are
  copied from `pdfjs-dist` into `dist/pdfjs/` by the `pdfjsAssets` plugin in `apps/web/vite.config.ts`
  and served by the static route; no WebAssembly decoders (they would need `wasm-unsafe-eval`). Tests
  mock `pdf.ts`. The plain-DOM node view mounts the React `PdfViewer` once through `mountPdfViewer`
  (`pdfViewerMount.ts`, own React root per mount); the viewer fetches (abortable, through
  `apiFetchResponse`) and opens the PDF only once an `IntersectionObserver` sees it; a failed preview
  calls the `onPreviewError` editor option (the owner passes it to `handleUnauthorized`, so an expired
  session goes to login), and fits the page to its scroll box, whose
  `scrollbar-gutter: stable` keeps a scrollbar from changing that width.

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
  `services/attachments.ts`): image magic bytes (`MAX_IMAGE_BYTES` 10 MiB), `%PDF-` at offset 0 only (a
  header after leading junk would let an executable whose stub carries `%PDF-` pass; `MAX_FILE_BYTES`
  25 MiB), GPX = UTF-8 (optional BOM, leading whitespace tolerated) whose root element is literally
  `gpx`, rejected on any
  `<!DOCTYPE`/`<!ENTITY` in the first 64 KiB (25 MiB); anything else is 415. The multipart limit is
  `MAX_UPLOAD_BYTES` (the larger); the per-kind check runs after detection. Quota and `UPLOAD_LIMIT`
  cover every kind; no schema change (`mime` + `original_name`).
- File responses (owner and shared routes) get their headers only from `attachmentResponseHeaders`
  (`services/attachments.ts`): images inline + `nosniff` + `Content-Disposition: inline` named after
  `original_name` with the detected type's extension forced (`IMAGE_EXTENSIONS`, `x.js` → `x.js.png`);
  every non-image kind is always a download (`contentDisposition(original_name)`: ASCII `filename=`
  fallback with `"\%;*='` and non-printables replaced, + `filename*=UTF-8''…`) with
  `nosniff` and `Content-Security-Policy: sandbox`. A PDF/GPX name always ends in `.pdf`/`.gpx`
  (`withExtension` appends it when missing, case-insensitive: `setup.exe` → `setup.exe.pdf`): at upload
  (`displayName`, so the stored name, the upload response's `name` and the editor node's `name` attr
  agree) and again in `attachmentResponseHeaders` (idempotent, covers older rows). The page CSP (`app.ts`) has
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
  `FakeClock`, `FakeHasher`, `seedUser`), `test/helpers/api.ts` (`loginAs`, `api`) and
  `test/helpers/fakeS3.ts` (stateful in-process S3: PUT/GET/ListObjectsV2/DELETE, an `intercept` hook
  for errors and hangs; used with the off-site CLIs' `endpoint` test override). Mutating
  requests must carry the exact `Origin` (`api` does this). Tests of the operator CLIs mock
  `process.getuid` to 1000 (they refuse to run as root).
- Time-dependent code takes an injectable clock/`now`; tests advance it instead of sleeping.
- Web: Vitest + Testing Library, colocated `*.test.ts(x)` under `apps/web/src/features/{auth,tree,editor,share}`.
  Helpers in `apps/web/src/test/utils.tsx`: `mockFetch({"METHOD /path": response | handler})` stubs
  `fetch` and returns the recorded requests (a handler may return a promise to hold a response back
  until the test releases it), plus render helpers and `LocationProbe` for asserting navigation.
  Handlers may also throw, to simulate a network error. `src/test/setup.ts` adds jsdom shims
  (ResizeObserver, an IntersectionObserver that reports everything in view at once, matchMedia, Range
  rects and `elementFromPoint` for ProseMirror; a test needing other behaviour stubs its own with
  `vi.stubGlobal`) and calls `resetSavers()` after each test. Never leave an autosaver behind with a
  mock that fails forever: it keeps retrying and leaks PUTs into later tests. Clipboard round-trip
  helpers for editor nodes (`fakeClipboard`, `copyNodeAt`, `pasteAtEnd`, `firstNodePos`) live in
  `src/test/clipboard.ts`; editor builders (`makeEditor`/`destroyEditors`, `doc`, `fileNode`,
  `fileNodes`, `ownerResolver`) in `src/test/editor.ts`.
- E2E (`e2e/`, `npm run test:e2e`) builds both apps and runs the compiled server with Node on
  `127.0.0.1:3100` (`E2E_PORT` overrides) with a fresh temp `DATA_DIR`; run
  `npx playwright install chromium` once. Fixtures are generated in code (`e2e/png.ts`, `e2e/files.ts`:
  the 2-page red/blue PDF and the GPX), never binary files. The smoke spec fails on any CSP violation
  (`securitypolicyviolation` events + console), so a CSP change must keep it green.

## Deployment

See the README "Docker", "Deploying to Fly.io", "Off-site backups" and "Restore on Fly.io" sections.

- **The server only ever runs as uid/gid 1000.** The image has no `USER`; `docker-entrypoint.sh`, when
  started as root (Fly mounts root-owned empty volumes), chowns the top of `DATA_DIR` to 1000:1000 if
  needed and `exec`s the command through `setpriv --reuid=1000 --regid=1000 --clear-groups`; started as
  anyone else it just `exec`s. `docker-compose.yml` sets `user: "1000:1000"` (so `compose exec` is 1000
  too). Operator commands over `fly ssh console` (root) must use the same `setpriv` prefix (plus
  `npm --prefix /app/apps/server`); `restore:offsite` and `backup:offsite` refuse to run as root
  (`refuseRoot` in `cli/common.ts`).
- Client address for the per-IP limits: `request.clientIp` (set once per request in an `onRequest` hook
  by `clientIpOf`), never `request.ip`. The `incoming request` log lines take `remoteAddress` the same
  way (a `req` serializer added in `buildApp` when the logger is an options object). With `CLIENT_IP_HEADER` (e.g. `Fly-Client-IP`) it is that
  header's value when it is a single valid IP, else the socket address (fallback logged at debug only).
  `CLIENT_IP_HEADER` and a trusting `TRUST_PROXY` together are a `ConfigError`.
- `TRUST_PROXY` and `CLIENT_IP_HEADER` are set explicitly (pinned empty) in the base `docker-compose.yml`
  and every override sets `TRUST_PROXY`, so a value in `.env` never leaks into a deployment it does not fit.
- The tunnel override trusts only `cloudflared`'s fixed address `172.30.0.10`, never the subnet; the
  network's dynamic `ip_range` is `172.30.0.128/25` so nothing else can get `.10`.
- Whenever `TRUST_PROXY` or `CLIENT_IP_HEADER` is set, the app port must be reachable only through that
  proxy.
- `fly.toml` invariants are guarded by `test/fly-config.test.ts` (own minimal TOML reader): only
  `[http_service]` on internal port 3000 with `force_https` (no `[[services]]`/`ports`), always on
  (`auto_stop_machines = "off"`, `min_machines_running = 1`), `/api/health` check, volume at `/data`,
  `512mb` (argon2: 5 × 64 MiB at peak), `CLIENT_IP_HEADER = "Fly-Client-IP"` and no `TRUST_PROXY`,
  `UPLOAD_QUOTA_MB` ≤ 40% of `[mounts] initial_size` (restore room; per account, so it assumes one),
  and no secrets or `RESTORE_ABORT`.

## Backups (local and off-site) and restore

- `services/backup.ts` holds the backup core: `runBackup` (SQLite online backup + ustar/gzip of the
  referenced uploads, throws `BackupError`), `writeUploadsArchive` and the streaming reader
  `readUploadsArchive` (regular files `uploads/<SAFE_STORAGE_NAME>` only, no duplicates, checksums and
  end marker checked). `cli/backup.ts` is a thin `main` mapping `BackupError` → `CliError`.
- `services/s3.ts`: minimal S3 client on `aws4fetch`'s `AwsV4Signer` + `node:http(s)` (streamed
  `UNSIGNED-PAYLOAD` PUT with explicit length, streamed GET, ListObjectsV2, DELETE), 60 s
  connect/idle timeout, `AbortSignal` everywhere, errors are `S3Error(status, code, message)` and never
  contain credentials. Config accepts only `https:` endpoints; `http:` exists for the test fake.
- `config.offsiteBackup` comes from `parseOffsiteBackupConfig(env)` (the `BACKUP_*` rules only; all four
  required variables or none). The off-site CLIs use it via `cliOffsiteConfig` and need no server secrets.
- `services/offsiteBackup.ts`: `runOffsiteBackup` snapshots into a temp dir `notes-offsite-*` under
  `os.tmpdir()` (never the volume) and uploads `uploads.tar.gz`, `notes.db`, then `manifest.json` last
  (= complete); on a failed upload (not on abort) it deletes every key whose PUT it started, best effort,
  the manifest first (a PUT that failed client-side may still have been stored) and nothing else if that
  delete fails, so a failed run never leaves a manifest without its data.
  `pruneOffsiteBackups` runs only after a successful scheduled upload: deletes complete backups older
  than `keepDays` but always keeps the newest 7, deletes incomplete ones older than a day, ages from the
  backup name, ignores unknown keys, returns the deleted names. The scheduler skips a database without
  notes, folders or attachments (`holdsUserData`: a fresh install must not push real backups out of the
  newest 7), sweeps stale `notes-offsite-*` temp dirs at start, and redacts the key id/secret from logged
  error messages. Only the scheduler writes `DATA_DIR/offsite-backup.json` (`lastSuccessAt` = snapshot
  time); the `backup:offsite` CLI never writes it and never prunes.
- Restore is two-phase, all inside `DATA_DIR` (layout names in `services/restore.ts`):
  `restore:offsite <name>` (app running; holds `restore-staging.lock` with its pid, a dead holder's lock
  is taken over) verifies manifest, free space (+10%), sizes, SHA-256 and `integrity_check` into
  `restore-staging/`, fsyncs, writes `READY` last and renames to `restore/`; `applyStagedRestore` (called
  by `prepareServer` in `startup.ts` before `openDataDb`, guarded by `test/startup.test.ts`; it also removes
  a leftover `restore-staging/` unless a live CLI holds the lock) swaps with renames only, keeping the old
  `notes.db` + WAL/SHM + `uploads/` in `restore-previous/` until done. Every step is keyed on what is
  still staged, so a re-run after a crash converges; `RESTORE_ABORT` rolls a swap back, then discards
  the stage. With `READY` present any error stops startup (`RestoreError` with the `RESTORE_ABORT` hint);
  without it (nothing armed, live data complete) removing the leftovers is best effort: a failure only
  logs a warning and the app starts (the CLI clears `restore-previous/`/`restore-staging/` before
  staging). Tests simulate crashes through the `afterStep` seam; keep the crash-at-every-step tests green
  when touching it.
