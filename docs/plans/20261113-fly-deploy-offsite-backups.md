# Fly.io deployment with daily off-site backups to Cloudflare R2

## Overview
- Run the notes app on Fly.io for personal use at `https://<app>.fly.dev` (free `fly.dev` subdomain with
  HTTPS), on one always-on `shared-cpu-1x` machine with 512 MB and a 1 GB Fly volume at `/data`, for
  about $3.3/month.
- 512 MB is the floor: argon2id hashing uses 64 MiB per hash and up to 5 run at once (4 general + 1
  owner-reserved slot), on top of ~50 MB for the server, so a 256 MB machine would run out of memory.
- On Fly the per-IP rate limits take the client address from Fly's `Fly-Client-IP` header (new
  `CLIENT_IP_HEADER` setting) instead of trusting a hop count in `X-Forwarded-For`, whose layout on Fly
  is not something the plan can assume.
- Add automatic **daily off-site backups**: the server makes the existing consistent snapshot
  (`notes.db` + `uploads.tar.gz`) and uploads it to a **Cloudflare R2** bucket (free 10 GB tier, no
  download fees). The backups are **not encrypted** by the app (user decision): their privacy rests on
  the R2 API token staying private. Old backups are pruned by the app only after a newer backup has
  uploaded successfully, so a broken upload never eats the existing ones.
- Add a restore path that works on Fly (where there is no `docker run -v` against the volume): a
  command downloads, verifies and unpacks a backup into `DATA_DIR/restore/` while the app keeps
  running; the next start swaps it in with renames only, keeping the previous data until the swap is
  complete, and re-running after an interruption finishes the same swap.
- Fly's own daily volume snapshots stay on as the quick, same-provider rollback; R2 is the copy that
  survives losing the Fly app or account.

## Context (from discovery)
- Files/components involved:
  - `Dockerfile` (multi-stage `node:22-slim`; runtime stage creates `/data` owned by 1000:1000 and runs
    as `USER 1000:1000`; `HEALTHCHECK` on `/api/health`)
  - `docker-compose.yml` (named volume `notes-data`, initialised by Docker from the image's `/data`)
  - `apps/server/src/config.ts` (zod env schema, `ConfigError`, `optional()` helper, `TrustProxy`)
  - `apps/server/src/app.ts` (`buildApp`; `fastifyTrustProxy`; `attachmentSweep` option →
    `scheduleAttachmentSweep(app)`; debug `client address` log at line ~134 using `request.ip`)
  - `apps/server/src/routes/auth.ts` (~lines 43, 55) and `apps/server/src/routes/shared.ts` (~line 73):
    pass `request.ip` to the login/signup/unlock limits; `apps/server/src/services/ipKey.ts`
  - `apps/server/src/index.ts` (entry point: `loadConfig`, `openDataDb`, SIGINT/SIGTERM → `app.close()`)
  - `apps/server/src/cli/backup.ts`: exports `runBackup({ dataDir, outDir, now })` → `{ dir, dbPath,
    archivePath, files, missing }` (SQLite online backup into a `.partial` dir, renamed at the end;
    ustar/gzip of referenced uploads; module-private `BLOCK`, `SAFE_STORAGE_NAME`, tar header writer;
    exported `UPLOADS_ARCHIVE_NAME`; throws `CliError` when there is no database)
  - `apps/server/src/cli/common.ts` (`cliDataDir`, `CliError`, `runIfInvokedDirectly`)
  - server tests live in `apps/server/test/*.test.ts` (kebab-case, e.g. `test/backup.test.ts`,
    `test/config.test.ts`, `test/client-address.test.ts`), helpers in `apps/server/test/helpers/`
  - `README.md` (Docker section already lists a Fly.io row claiming `TRUST_PROXY=1`; Backup and restore)
- Related patterns found:
  - periodic background work is scheduled from `buildApp` behind an option that only `index.ts` turns on
    (`attachmentSweep: true`), so tests build the app without timers
  - operator CLIs in `apps/server/src/cli/` read only `DATA_DIR` (and now `BACKUP_*`) from the
    environment and run via `runIfInvokedDirectly`; nothing under `src/` outside `cli/` imports `cli/`
  - config: every variable is parsed in `envSchema`; bad config refuses to boot with a clear message
  - the server owns its files as uid 1000; restores must never mix a restored db with an old WAL
- Dependencies identified:
  - new runtime dependency `aws4fetch` (single file, no dependencies of its own) for AWS SigV4 signing
  - `flyctl` on the Mac for deploys (Post-Completion)
  - Fly volumes are mounted **root-owned** (ext4 with `lost+found`; the image's `/data` is not copied into
    them) and the image runs as uid 1000, so the server could not write to a fresh Fly volume today
  - a Fly machine's root filesystem is reset on every start, so anything that must survive a restart
    (a staged restore) lives on the volume

## Development Approach
- **testing approach**: TDD (tests first): write the failing tests of each task, then the code
- complete each task fully before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
  - tests are not optional - they are a required part of the checklist
  - write unit tests for new functions/methods
  - write unit tests for modified functions/methods
  - add new test cases for new code paths
  - update existing test cases if behavior changes
  - tests cover both success and error scenarios
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- run tests after each change
- maintain backward compatibility: existing Docker Compose deployments (and the user's local volume
  `notes-app_notes-data`) must behave exactly as before; with no `BACKUP_S3_*` and no
  `CLIENT_IP_HEADER` set nothing new runs
- never touch the user's running Compose project `notes-app` or its volume `notes-app_notes-data`;
  Docker checks use their own project name, image tag and throwaway volumes

## Testing Strategy
- **unit tests**: required for every task (vitest, `npm test`); new server tests go in
  `apps/server/test/` with kebab-case names, like the existing ones
- **S3 tests** run against a local in-process **HTTP** server that plays the S3 API (records method,
  path, headers and body; can answer errors or hang) - never against real R2. The client therefore
  supports `http:` endpoints for tests; config only accepts `https:` (see Task 4), so production never
  uses plain HTTP
- **Docker check**: a script that builds the image under a separate tag and runs it with throwaway
  volumes: a truly root-owned empty volume like Fly's (`volume-nocopy`), and the Compose-style
  `--user 1000:1000`; Docker via Colima is available on the dev machine
- **e2e tests**: no UI changes in this plan; the existing Playwright smoke test must still pass
  (`npm run test:e2e`)
- lint and type checks: `npm run lint`

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope
- keep plan in sync with actual work done

## Solution Overview
- **Image on a Fly volume.** The image keeps uid 1000 as the only user the server ever runs as, but no
  longer bakes `USER` in: a small entrypoint, only when started as root (Fly), makes sure `DATA_DIR` is
  owned by 1000:1000 (top directory only, and only when it is not), then `exec`s the server through
  `setpriv` as 1000:1000. When started as 1000 it just `exec`s. Compose keeps today's behaviour by
  setting `user: "1000:1000"` explicitly, so `docker compose exec` also stays 1000.
- **Client address on Fly.** New optional `CLIENT_IP_HEADER` (e.g. `Fly-Client-IP`): when set, the
  per-IP limits and the `client address` debug log use that header's value (a valid IPv4/IPv6 literal)
  instead of `request.ip`; a missing or invalid value falls back to the socket address, logged at
  debug level only (Fly's own health checks reach the machine without that header, so a warning would
  fire every few seconds). It is mutually exclusive with `TRUST_PROXY` (config error when both are set) and follows the same
  rule: set it only when the app is reachable solely through the proxy that sets the header. Fly's
  edge sets `Fly-Client-IP` on every request; that it overwrites a client-supplied value is verified in
  Post-Completion before relying on it.
- **`fly.toml`** checked into the repo: one always-on machine (`auto_stop_machines = "off"`,
  `min_machines_running = 1`), `[http_service]` with `internal_port = 3000` and `force_https = true`
  (no `[[services]]` port mapping of our own, so Fly's proxy is the only client), health check on
  `/api/health`, `[mounts]` volume `notes_data` → `/data`, `[[vm]]` `shared-cpu-1x` / `512mb`,
  `CLIENT_IP_HEADER = "Fly-Client-IP"`, no `TRUST_PROXY`, and `UPLOAD_QUOTA_MB = "400"`: a restore
  needs room for the old and the new uploads side by side, so the quota stays at most ~40% of the
  volume. Secrets (`SESSION_SECRET`, `SHARE_HMAC_KEY`, `PUBLIC_ORIGIN`, `BACKUP_S3_*`) go in with
  `fly secrets set`, so the file holds no app-specific values beyond the app name.
- **Backup core moves to a service.** `runBackup`, the tar writer and its constants move from
  `cli/backup.ts` to `services/backup.ts` (which throws its own `BackupError`), with a matching ustar
  reader beside the writer so both share `BLOCK` and `SAFE_STORAGE_NAME`. `cli/backup.ts` becomes a thin
  `main` that maps `BackupError` to `CliError`. Server code never imports `cli/`.
- **Off-site backup job** (server-side, opt-in): when `BACKUP_S3_*` is configured, `index.ts` turns on a
  scheduler in `buildApp` (same pattern as the attachment sweep). It checks one minute after start and
  then hourly whether the last successful upload is older than `BACKUP_INTERVAL_HOURS` (default 24). If
  so, `runOffsiteBackup` calls `runBackup` with `outDir` in a temp directory on the machine's root
  filesystem (never the volume), computes each file's size and SHA-256, uploads `uploads.tar.gz`, then
  `notes.db`, then `manifest.json` last (the "complete" marker), deletes the temp directory and returns
  `{ name, files }`. The **scheduler** (not `runOffsiteBackup`) then records the success in
  `DATA_DIR/offsite-backup.json` and prunes old backups. One run at a time; failures are logged and
  retried at the next hourly check; `app.close()` cancels the timer and aborts an in-flight upload.
- **Retention in the app, driven by success.** After a successful upload the scheduler lists the
  prefix and deletes backups older than `BACKUP_KEEP_DAYS` (default 30), but always keeps the newest 7
  complete backups; incomplete backups (no manifest) older than 1 day are deleted too. No bucket
  lifecycle rule is used: an age-only rule would delete every backup once uploads had been failing for
  that many days.
- **Uploads are streamed**: each file is signed with `aws4fetch`'s `AwsV4Signer` using
  `UNSIGNED-PAYLOAD` and sent with `node:https` (or `node:http` for an `http:` test endpoint) and an
  explicit `Content-Length` from `fs.stat`, so a large `uploads.tar.gz` never sits in the 512 MB of
  memory. Single PUT (R2/S3 allow up to 5 GiB).
- **Restore, phase 1 (CLI, app keeps running)**: `npm run restore:offsite -- <notes-backup-…>`, run as
  uid 1000, downloads `manifest.json`, checks free space on the volume, downloads `notes.db` into
  `DATA_DIR/restore-staging/` (verifying size and SHA-256, then `PRAGMA integrity_check`), and streams
  `uploads.tar.gz` straight from R2 through SHA-256 + gunzip + the ustar reader into
  `restore-staging/uploads/` (the tarball itself is never stored). Only when every check passes it
  writes `restore-staging/READY` and renames `restore-staging/` to `restore/`.
- **Restore, phase 2 (next start, before the database opens)**: if `restore/READY` exists, a swap
  driven by what is still staged: for each staged item still in `restore/`, the live counterpart (if
  any; plus the old WAL/SHM for the database) is renamed into `DATA_DIR/restore-previous/` and the staged
  item is renamed into place. When nothing is left staged, `restore/READY` is removed, then `restore/`,
  then `restore-previous/`. Every step is a same-filesystem rename or a delete of something superseded,
  so it needs no free space; because each move is keyed on the staged copy still being in `restore/`, a
  start after an interruption at any point finishes the same swap and never moves a restored item
  aside. `restore-previous/` existing while `READY` exists means "swap in progress"; without `READY` it
  is a leftover of a finished swap and is deleted. A swap only starts on a complete stage (both
  `notes.db`, sized as `READY` records, and an `uploads/` directory, empty for a backup without
  attachments). `RESTORE_ABORT=1` is the escape hatch: mid-swap it first **rolls back** (restored items
  go back into `restore/`, old ones come back from `restore-previous/`), then it **discards** the staged
  restore, so the server only ever opens either the complete old data or the complete restored data,
  and nothing stays armed to apply on a later start. So a restore on Fly is: run the command over
  `fly ssh console`, then `fly machine restart`; to cancel one: `fly secrets set RESTORE_ABORT=1`
  (restarts the machine), then `fly secrets unset RESTORE_ABORT`.

## Technical Details
- **New environment variables** (all optional):
  - `CLIENT_IP_HEADER`: a header name (`[A-Za-z0-9-]{1,64}`, case-insensitive); config error when set
    together with a non-empty `TRUST_PROXY`
  - `RESTORE_ABORT`: `1`/`true`: cancel a staged restore at startup instead of applying it: roll back a
    swap already in progress, then delete the staged restore (see Startup apply); logged as a warning,
    and a warning at every start while it is set with nothing staged, reminding to unset it
  - backups are on only when the first four of these are all set; some but not all → `ConfigError`
    naming the missing ones:
    - `BACKUP_S3_ENDPOINT`: `https://<account-id>.r2.cloudflarestorage.com` (must be `https:`; no path,
      query or credentials)
    - `BACKUP_S3_BUCKET`: bucket name (3-63 chars, lowercase letters, digits, `-`, `.`)
    - `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`: R2 API token credentials
    - `BACKUP_S3_REGION`: default `auto` (what R2 expects)
    - `BACKUP_S3_PREFIX`: default `notes-backups/`; normalised to end with `/`; no leading `/`, no `..`
    - `BACKUP_INTERVAL_HOURS`: default `24`, integer 1-168
    - `BACKUP_KEEP_DAYS`: default `30`, integer 1-3650
- **Config shape**: `config.clientIpHeader: string | null`; `config.restoreAbort: boolean`;
  `config.offsiteBackup: null | { endpoint: URL; bucket; accessKeyId; secretAccessKey; region; prefix;
  intervalMs; keepDays }`. The secret is never logged (no config dump includes it; log lines name only
  endpoint host, bucket and prefix).
- **Object layout** (path-style URLs, `<endpoint>/<bucket>/<key>`; backup name
  `notes-backup-<YYYYMMDD-HHMMSS>` from `runBackup`'s directory name):
  - `<prefix><name>/uploads.tar.gz` (`application/gzip`)
  - `<prefix><name>/notes.db` (`application/vnd.sqlite3`)
  - `<prefix><name>/manifest.json` (last):
    `{ "version": 1, "name": "<name>", "createdAt": ISO, "files": { "notes.db": { "size": n, "sha256": hex }, "uploads.tar.gz": { "size": n, "sha256": hex } }, "uploads": { "count": n, "bytes": n }, "missing": [storageName...] }`
    (`uploads.bytes` is the sum of the packed files' sizes, needed for the restore space check)
- **State file** `DATA_DIR/offsite-backup.json`: `{ "lastSuccessAt": ISO, "lastBackup": "<name>" }`,
  written atomically (temp file + rename) by the scheduler only; a missing or unreadable file means
  "overdue" (back up now). The manual `backup:offsite` CLI never writes it.
- **S3 client** (`apps/server/src/services/s3.ts`, `S3Target = { endpoint, bucket, accessKeyId,
  secretAccessKey, region }`):
  - `putObjectFromFile(target, key, filePath, contentType, signal)`: stat → sign PUT (headers
    `content-type`, `content-length`, `x-amz-content-sha256: UNSIGNED-PAYLOAD`) → stream the file →
    2xx resolves, else `S3Error(status, code, message)` parsed from the XML error body (first 2 KB);
    connect/idle timeout 60 s; files > 5 GiB refused before any request
  - `getObjectStream(target, key, signal)`: signed GET via `aws4fetch`'s `AwsClient.fetch`, returns the
    body as a Node `Readable` plus `content-length`; 404 → `S3Error` code `NoSuchKey`
  - `listObjects(target, prefix, signal)`: ListObjectsV2 with continuation tokens; returns
    `{ key, size, lastModified }[]` (parse `<Contents>`, `<IsTruncated>`, `<NextContinuationToken>`;
    keys are XML-unescaped)
  - `deleteObject(target, key, signal)`: signed DELETE; 204/200/404 all count as deleted
  - keys are built only from the validated prefix, backup names matching
    `^notes-backup-\d{8}-\d{6}$` and fixed file names - never user input
- **Scheduler** (in `apps/server/src/app.ts` next to `scheduleAttachmentSweep`, following its pattern:
  Fastify hooks and timers stay in `app.ts`, `services/` stays framework-free):
  `scheduleOffsiteBackup(app, { dataDir, cfg, now? }, run = runOffsiteBackup, prune =
  pruneOffsiteBackups)`: first check 1 minute after start (never blocks `listen`), then every hour
  (`setTimeout` chain, `unref`), single-flight flag, `AbortController` aborted in `onClose`. On success:
  write the state file, then `pruneOffsiteBackups(cfg, now)` (a prune failure is logged and does not
  undo the success). Logs `offsite backup uploaded` (name, sizes, duration) or `offsite backup failed`
  (S3 code/message or error message only - never credentials or signed URLs).
- **Restore CLI** (`apps/server/src/cli/restoreOffsite.ts`):
  1. refuse when running as root (`process.getuid?.() === 0`) with the `setpriv` command to use instead
  2. validate the name; refuse when `DATA_DIR/restore/` exists (a restore is already staged or a swap
     is in progress); remove a leftover `restore-staging/` and, since `restore/` is absent, a leftover
     `restore-previous/` (a finished swap's cleanup that was interrupted) before the space check
  3. download `manifest.json` (≤ 64 KB), validate its shape and name
  4. free space (`fs.statfs(DATA_DIR)`, `bavail * bsize`) must be ≥ `notes.db.size + uploads.bytes` plus
     10% margin, else refuse with a message to `fly volumes extend` (and raise `UPLOAD_QUOTA_MB` only
     with the volume)
  5. download `notes.db` to `restore-staging/notes.db`, verifying size and SHA-256; open it read-only
     and require `PRAGMA integrity_check` = `ok`
  6. create `restore-staging/uploads/` (always, so a backup without attachments stages an empty
     directory), then stream `uploads.tar.gz` through SHA-256, gunzip and the ustar reader into
     `restore-staging/uploads/<name>` (entries must be `uploads/<SAFE_STORAGE_NAME>`, regular files
     only, no duplicates); afterwards the stream's size and SHA-256 must match the manifest and
     count/bytes must match `uploads`
  7. fsync `notes.db`, every extracted file, `uploads/` and `restore-staging/`; write
     `restore-staging/READY` as JSON `{ "name": "<name>", "notesDbSize": n, "uploadsCount": n }`, fsync
     it and `restore-staging/`; rename `restore-staging/` → `restore/`; fsync `DATA_DIR`; print the
     next step (restart the app)
  - any failure removes `restore-staging/` and leaves `restore/` absent; the live data is never touched
- **Startup apply** (`apps/server/src/services/restore.ts`, `applyStagedRestore(dataDir, { abort, log })`,
  called in `index.ts` before `openDataDb`). Names: `S` = `restore/`, `P` = `restore-previous/`,
  `L` = `DATA_DIR`. Every rule checks its own precondition, so re-running after a crash at any point
  converges:
  - **no `S/READY`** (covers "no `S`" and "`S` without `READY`", i.e. a finished swap whose cleanup was
    interrupted, since `READY` is only removed after every item is in place): delete `S` and `P` if
    present (log when anything was removed), start normally
  - **`S/READY` and `abort`**: if `P` exists (swap in progress), roll back first: for `X` in `uploads`,
    `notes.db`: if `S/X` is absent and `L/X` exists, rename `L/X` → `S/X` (it is the restored copy: a
    swap only starts when both `S/notes.db` and `S/uploads` exist, so an absent `S/X` means it was
    swapped in); then if `P/X` exists and `L/X` is absent, rename `P/X` → `L/X`; likewise move
    `P/notes.db-wal` and `P/notes.db-shm` back when `L` has none; then remove the (now empty) `P`.
    Then delete `S/READY`, then `S` (discard); log a warning naming the discarded backup; start normally
  - **`S/READY`, no `abort`, no `P`** (swap not started): check the stage first and stop with an error
    (no change) unless `S/notes.db` is a file whose size equals `READY.notesDbSize` and `S/uploads` is
    a directory; then continue with the swap below
  - **`S/READY`, no `abort`** → swap: create `P` if missing; for `X` in `notes.db`, `uploads`, only while
    `S/X` exists: (for `notes.db` first move `L/notes.db-wal` and `L/notes.db-shm` into `P` if present)
    if `L/X` exists, rename it to `P/X` (if `P/X` already exists too, stop with an error: never
    overwrite a kept copy); then rename `S/X` → `L/X`. When neither staged item is left: delete
    `S/READY`, then `S`, then `P`; log the restored backup name
  - any error stops startup with the message and the `RESTORE_ABORT` hint; the server never opens the
    database while `S/READY` exists (unless `abort` just discarded it)
- **Entrypoint** (`docker-entrypoint.sh`, POSIX sh): `set -eu`; if `id -u` is 0: `mkdir -p "$DATA_DIR"`,
  `chown 1000:1000 "$DATA_DIR"` when `stat -c %u:%g` is not `1000:1000`, then
  `exec setpriv --reuid=1000 --regid=1000 --clear-groups -- "$@"`; else `exec "$@"`. `setpriv` ships in
  `util-linux` in `node:22-slim` (verify; install it in the runtime stage otherwise). The Dockerfile keeps
  creating `/data` owned by 1000 (Compose named volumes still inherit it).
- **Running CLIs on Fly**: `fly ssh console` is root, so documented commands run as the app user:
  `fly ssh console -C "setpriv --reuid=1000 --regid=1000 --clear-groups npm run restore:offsite -- <name>"`
  (the same prefix for `backup:offsite` and `backup`), so every file stays owned by 1000.

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): image/entrypoint, client IP header, `fly.toml`, config,
  backup service refactor, S3 client, backup job and retention, CLIs, startup restore, tests, docs
- **Post-Completion** (no checkboxes): creating the Fly app/volume/secrets, the R2 bucket and token, the
  first deploy and sign-up, the client-IP spoofing check, and a real restore drill

## Implementation Steps

### Task 1: Let the image start on a root-owned empty volume (Fly) and keep Compose unchanged

**Files:**
- Create: `docker-entrypoint.sh`
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Create: `scripts/check-docker-image.sh`
- Modify: `package.json` (script `test:docker`)

- [x] write `scripts/check-docker-image.sh` first (it fails against the current image): builds the image
      as `notes-app:docker-check` (never `notes-app:latest`), then with throwaway volumes and container
      names prefixed `notes-app-check-` (always removed on exit via `trap`):
      (a) Fly-like: create the volume, mount it with `--mount type=volume,src=…,dst=/data,volume-nocopy`
      (so Docker does not copy the image's 1000-owned `/data` into it), assert `stat -c %u:%g /data` is
      `0:0` from a throwaway root container first, then run the image as root (`--user 0:0`) → `/data`
      becomes `1000:1000`, the server process (`ps -o uid=` of PID 1's exec'd child or `/proc/1/status`)
      runs as uid 1000, `/api/health` answers;
      (b) Compose-like: `--user 1000:1000` on a normal named volume → starts, `/data` stays 1000:1000;
      (c) a file created through `docker exec` in case (b) is owned by 1000
- [x] add `docker-entrypoint.sh` (see Technical Details), copy it into the runtime stage (executable),
      `ENTRYPOINT ["/app/docker-entrypoint.sh"]`, keep `CMD`, remove `USER 1000:1000` (keep the
      `mkdir -p /data && chown 1000:1000 /data` line); confirm `setpriv` exists in `node:22-slim`
      (install `util-linux` if not)
- [x] set `user: "1000:1000"` on the `app` service in `docker-compose.yml` with a comment (Compose keeps
      running as 1000; the root path is for platforms like Fly that mount root-owned volumes)
- [x] add `"test:docker": "bash scripts/check-docker-image.sh"` to the root `package.json`
- [x] run `npm run test:docker` - must pass; run `npm test` and `npm run lint` - must pass before task 2

### Task 2: Take the client address from a trusted platform header (`CLIENT_IP_HEADER`)

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/routes/auth.ts`
- Modify: `apps/server/src/routes/shared.ts`
- Modify: `docker-compose.yml`
- Modify: `apps/server/test/config.test.ts`
- Modify: `apps/server/test/client-address.test.ts`

- [x] write config tests first: unset → `clientIpHeader: null`; valid name accepted (stored lowercase);
      invalid characters rejected; set together with a non-empty `TRUST_PROXY` → `ConfigError`
- [x] write client-address tests first: with `CLIENT_IP_HEADER=Fly-Client-IP` the debug `client address`
      line and the per-IP limit key use the header (IPv4, IPv6, IPv4-mapped IPv6 normalised by
      `ipKey`); a spoofed `X-Forwarded-For` is ignored; a missing or non-IP header value falls back to
      the socket address with a debug-level line only (at `LOG_LEVEL=info`, filtering by `msg` like the
      existing test: no fallback or `client address` entry and no entry at `warn` or above; Fastify's own
      request lines stay as they are); without the setting nothing changes (existing tests)
- [x] write a route-level test that two different `Fly-Client-IP` values get separate login limits while
      the same value shares one
- [x] pin `CLIENT_IP_HEADER: ""` in `docker-compose.yml`'s `environment` next to `TRUST_PROXY: ""` (with
      the same comment: the deployment override decides it), so a value in `.env` can never make a
      directly exposed Compose app trust a client-supplied header; add a check to
      `scripts/check-docker-image.sh` or a config-level test that `docker compose config` resolves it empty
- [x] add `clientIpHeader` to the config, decorate the request with `clientIp` (computed once per
      request in an `onRequest` hook in `buildApp`), and replace `request.ip` in `app.ts`'s debug log,
      `routes/auth.ts` and `routes/shared.ts` with `request.clientIp`
- [x] run tests - must pass before task 3

### Task 3: Add `fly.toml` and guard its security invariants

**Files:**
- Create: `fly.toml`
- Create: `apps/server/test/fly-config.test.ts`

- [x] write `apps/server/test/fly-config.test.ts` first: reads the repo's `fly.toml` as text and asserts
      `internal_port = 3000` under `[http_service]`, `force_https = true`, no `[[services]]` section and
      no `ports` entries, `CLIENT_IP_HEADER = "Fly-Client-IP"` and no `TRUST_PROXY` in `[env]`, `[mounts]`
      destination `/data`, `[[vm]]` memory `512mb`, `auto_stop_machines = "off"`,
      `min_machines_running = 1`, a health check on `/api/health`, `UPLOAD_QUOTA_MB` ≤ 40% of the
      `initial_size` noted in the file's comment (1 GB → ≤ 409), and no secret-looking keys
      (`SESSION_SECRET`, `SHARE_HMAC_KEY`, `PUBLIC_ORIGIN`, `BACKUP_S3_`)
- [x] write `fly.toml`: `app = "notes-app-CHANGE-ME"` (comment: set by `fly launch --copy-config
      --name …`), `primary_region` placeholder with comment, `[build] dockerfile = "Dockerfile"`,
      `[env]` `CLIENT_IP_HEADER = "Fly-Client-IP"`, `UPLOAD_QUOTA_MB = "400"`, `LOG_LEVEL = "info"`;
      `[http_service]`, `[[http_service.checks]]`, `[mounts] source = "notes_data"` with
      `initial_size = "1gb"`, `[[vm]] size = "shared-cpu-1x"`, `memory = "512mb"`; header comments on why
      512 MB, why no `[[services]]`, and why the quota is ≤ 40% of the volume (restore room)
- [x] run tests - must pass before task 4

### Task 4: Parse the off-site backup and restore settings

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/test/config.test.ts`
- Modify: `.env.example`

- [x] write tests first: none set → `offsiteBackup: null`; all four required set → parsed object with
      defaults (`region: 'auto'`, `prefix: 'notes-backups/'`, 24 h interval, 30 keep days); some but not
      all set → `ConfigError` naming the missing variables; blank strings count as unset; endpoint must be
      an `https:` URL without path, query or credentials; bucket name rules; prefix normalised (trailing
      `/` added) and rejected with a leading `/` or `..`; `BACKUP_INTERVAL_HOURS` 1-168 and
      `BACKUP_KEEP_DAYS` 1-3650 integers; `RESTORE_ABORT` parsing
- [x] export `parseOffsiteBackupConfig(env)` from `config.ts` (the `BACKUP_*` rules only, throwing
      `ConfigError`), used by `loadConfig` and by the Task 8 CLIs, so the CLIs need no server secrets;
      test it directly with an env that has no `SESSION_SECRET`/`SHARE_HMAC_KEY`/`PUBLIC_ORIGIN`
- [x] add the variables to `envSchema` and `Config`, following the existing `optional()` pattern and
      error style; no error message or log line includes `BACKUP_S3_SECRET_ACCESS_KEY`'s value (test it)
- [x] document the variables (commented out) in `.env.example`
- [x] run tests - must pass before task 5

### Task 5: Move the backup core into a service and add the tar reader

**Files:**
- Create: `apps/server/src/services/backup.ts`
- Modify: `apps/server/src/cli/backup.ts`
- Modify: `apps/server/test/backup.test.ts`
- Create: `apps/server/test/backup-archive.test.ts`

- [x] write tests first for the ustar reader (`readUploadsArchive(stream, onEntry)`): round-trips what the
      writer produces (several files, empty archive, file sizes on and off the 512-byte boundary); rejects
      entries outside `uploads/`, with `..`, absolute paths, names failing `SAFE_STORAGE_NAME`,
      non-regular entries (directory, symlink, hardlink), duplicate names, truncated archives and bad
      gzip
- [x] move `runBackup`, the tar writer, `BLOCK`, `SAFE_STORAGE_NAME` and `UPLOADS_ARCHIVE_NAME` into
      `services/backup.ts`, replacing `CliError` with an exported `BackupError`; make `runBackup` also
      return `uploadBytes` (sum of packed file sizes); `cli/backup.ts` keeps its `main` and maps
      `BackupError` to `CliError`
- [x] update `apps/server/test/backup.test.ts`: imports, the no-database assertion
      (`rejects.toThrow(CliError)` → `BackupError`) and a new assertion on `uploadBytes`; add a test that
      the backup CLI's `main` turns a `BackupError` into a `CliError` with the same message
- [x] implement the reader next to the writer
- [x] run tests - must pass before task 6

### Task 6: S3 client for R2 (streamed PUT, streamed GET, list, delete)

**Files:**
- Modify: `apps/server/package.json` (dependency `aws4fetch`, exact version)
- Create: `apps/server/src/services/s3.ts`
- Create: `apps/server/test/s3.test.ts`

- [ ] write tests first against a local HTTP server playing S3: PUT sends path-style
      `/<bucket>/<encoded key>`, `content-length` equal to the file size, `x-amz-content-sha256:
      UNSIGNED-PAYLOAD`, an `AWS4-HMAC-SHA256` `authorization` with the access key id and region, and the
      exact file bytes (including a multi-MB file); GET streams the body; list follows continuation
      tokens and unescapes keys; delete treats 204/404 as success
- [ ] write error tests: 403 with an S3 XML error → `S3Error` with status, code and message (no
      credentials or signature in the message); 404 on GET → `NoSuchKey`; connection refused; a server
      that hangs → timeout; `AbortSignal` aborts each call; a file > 5 GiB refused before any request
      (stat mocked)
- [ ] add `aws4fetch` and implement `putObjectFromFile`, `getObjectStream`, `listObjects`,
      `deleteObject` (see Technical Details)
- [ ] run tests - must pass before task 7

### Task 7: Daily off-site backup job, state file and retention

**Files:**
- Create: `apps/server/src/services/offsiteBackup.ts`
- Create: `apps/server/test/offsite-backup.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`

- [ ] write tests first for `runOffsiteBackup(dataDir, cfg, { now, tmpRoot, signal })` with a fake S3
      server: uploads `uploads.tar.gz`, then `notes.db`, then `manifest.json` (order checked) under
      `<prefix><name>/`; manifest sizes and SHA-256 match the uploaded bytes and `uploads.bytes` matches;
      returns `{ name, files }`; never touches `offsite-backup.json`; the temp directory is gone afterwards
      on success and on failure; a failed upload leaves no manifest
- [ ] write tests first for `pruneOffsiteBackups`: deletes complete backups older than `keepDays` but
      always keeps the newest 7 complete ones; deletes incomplete ones older than 1 day; leaves unknown
      keys under the prefix alone; never deletes anything when listing fails
- [ ] write tests first for `scheduleOffsiteBackup` (in `app.ts`) with fake timers and injected fake
      `run`/`prune`: runs when the state file is missing,
      unreadable or older than the interval, skips when fresh; writes the state file only after a
      successful run (atomically); prunes only after success; never runs two at once; retries at the
      next hourly check after a failure; `app.close()` stops the timer and aborts an in-flight upload;
      the first check does not delay `listen`
- [ ] implement `runOffsiteBackup` (on `runBackup` from `services/backup.ts` with `outDir` under
      `os.tmpdir()`) and `pruneOffsiteBackups` as plain functions in `services/offsiteBackup.ts`, and
      `scheduleOffsiteBackup(app, …)` in `app.ts` next to `scheduleAttachmentSweep`; logging per
      Technical Details
- [ ] add the `offsiteBackup` option to `BuildAppOptions` (off by default, like `attachmentSweep`) and
      turn it on in `index.ts` when `config.offsiteBackup` is set; log once at startup whether off-site
      backups are on (endpoint host, bucket and prefix, never keys)
- [ ] run tests - must pass before task 8

### Task 8: Operator commands: back up now, stage a restore from the bucket

**Files:**
- Create: `apps/server/src/cli/backupOffsite.ts`
- Create: `apps/server/test/backup-offsite-cli.test.ts`
- Create: `apps/server/src/cli/restoreOffsite.ts`
- Create: `apps/server/test/restore-offsite-cli.test.ts`
- Modify: `apps/server/package.json` (scripts `backup:offsite`, `restore:offsite`)
- Modify: `package.json` (root passthrough scripts, like `backup`)

- [ ] write tests first for `backup:offsite`: reads its settings with `parseOffsiteBackupConfig` and
      `cliDataDir` only (works with no `SESSION_SECRET`/`SHARE_HMAC_KEY`/`PUBLIC_ORIGIN` set), refuses with a
      `CliError` when `BACKUP_S3_*` is not configured, runs one `runOffsiteBackup`, prints the backup
      name, and never writes `offsite-backup.json` and never prunes
- [ ] write tests first for `restore:offsite <name>` (fake S3 server with backups made by
      `runOffsiteBackup` from a seeded data dir, env without the server secrets): refuses as root (getuid mocked); rejects a malformed
      name; refuses when `restore/` exists; removes a leftover `restore-staging/`; refuses with the
      extend-the-volume message when free space is short (statfs mocked); a size or SHA-256 mismatch of
      either file, a failing `integrity_check`, an unsafe tar entry or a count/bytes mismatch removes
      `restore-staging/`, leaves no `restore/` and leaves the live `notes.db`, WAL and `uploads/`
      untouched; success leaves `restore/READY` (JSON with name, `notesDbSize`, `uploadsCount`),
      `restore/notes.db` and `restore/uploads/` with exactly the backup's files, and no tarball on disk;
      a zero-attachment backup stages an empty `restore/uploads/` directory; the staged files and
      directories are fsynced before `READY` is written (spy on `fs.fsync`/`FileHandle.sync`)
- [ ] implement both CLIs with `runIfInvokedDirectly` and the existing `CliError` conventions (see
      Technical Details for the restore steps)
- [ ] run tests - must pass before task 9

### Task 9: Apply a staged restore at startup

**Files:**
- Create: `apps/server/src/services/restore.ts`
- Create: `apps/server/test/restore.test.ts`
- Modify: `apps/server/src/index.ts`

- [ ] write tests first: no `restore/` → nothing happens; a staged restore (built by the Task 8 CLI)
      replaces `notes.db` and `uploads/`, moves the old `notes.db`, WAL, SHM and `uploads/` aside and
      deletes them only at the end, removes `restore/`, and the database then opens with the backed-up
      notes (no old WAL replayed); `restore/` without `READY` is deleted together with a leftover
      `restore-previous/` and startup continues; a leftover `restore-previous/` alone is deleted;
      `abort: true` before the swap started deletes `restore/` and changes no live data; a stage with
      `READY` but no `uploads/` directory, or a `notes.db` whose size differs from `READY`, stops startup
      with an error and changes nothing; a zero-attachment backup (empty `uploads/` stage) restores over
      live data that has uploads, leaving an empty live `uploads/`
- [ ] write crash-recovery tests first, each in three starting layouts (old data with `uploads/` and a
      WAL; old data without `uploads/`; no old data at all, the fresh-app disaster case): for each step
      of the swap and of the cleanup, simulate an interruption after it (inject a failure via a test
      hook), then call `applyStagedRestore` again → the same end state as an uninterrupted run, every
      restored file present, and never a state where neither the old nor the restored database exists
- [ ] write abort tests first: interrupt the swap at each step (including with a zero-attachment stage
      over live uploads), then apply with `abort: true` → the original data (db, WAL, uploads) is live
      and intact, `restore-previous/` and `restore/` are gone; a following start without `abort` changes
      nothing
- [ ] write a two-restores test: interrupt the first restore during the `restore-previous/` delete,
      start, stage a second restore with the CLI, apply → the second backup is live and nothing from the
      first run's leftovers is mixed in
- [ ] implement `applyStagedRestore(dataDir, { abort, log })` per Technical Details
- [ ] call it in `index.ts` before `openDataDb` with `config.restoreAbort`; an error stops startup with
      the message and the `RESTORE_ABORT` hint
- [ ] run tests - must pass before task 10

### Task 10: Verify acceptance criteria
- [ ] verify all requirements from Overview are implemented (Fly config, root-owned volume start, client
      IP header, daily off-site upload with success-driven retention, restore path, Compose unchanged,
      features off without their settings)
- [ ] verify edge cases are handled (partial config, failed/aborted uploads, prune after failures,
      short disk on restore, corrupt downloads, unsafe tarball entries, interrupted swap)
- [ ] run full test suite: `npm test`
- [ ] run lint and type checks: `npm run lint`
- [ ] run the Docker check: `npm run test:docker`
- [ ] run e2e tests: `npm run test:e2e`
- [ ] verify test coverage of the new modules (config parsing, client IP, s3, backup archive,
      offsiteBackup, CLIs, restore)

### Task 11: [Final] Update documentation
- [ ] README: a "Deploying to Fly.io" section: install `flyctl`; `fly launch --copy-config --no-deploy
      --name <app>`; `fly volumes create notes_data --size 1 --region <region>`; `fly secrets set
      SESSION_SECRET=… SHARE_HMAC_KEY=… PUBLIC_ORIGIN=https://<app>.fly.dev`; `fly deploy`; **sign up
      right away** (first user becomes the only account); keep only the shared IPv4 (no paid dedicated
      IPv4); cost (~$3.3/month: 512 MB machine + 1 GB volume); growing the volume
      (`fly volumes extend`) together with `UPLOAD_QUOTA_MB` (quota ≤ 40% of the volume); the
      `CLIENT_IP_HEADER` check below; fix the Docker table's Fly row (`CLIENT_IP_HEADER=Fly-Client-IP`,
      not `TRUST_PROXY=1`) and document `CLIENT_IP_HEADER` and `RESTORE_ABORT` in the Configuration table; also rewrite the
      `**Fly.io**` bullet in the Docker section (README ~lines 210-212, "set `TRUST_PROXY=1`") to say
      `CLIENT_IP_HEADER=Fly-Client-IP` and never set `TRUST_PROXY` on Fly (the two together are a
      config error)
- [ ] README: "Off-site backups to Cloudflare R2": create the bucket, an R2 API token with Object Read &
      Write on that bucket only, the endpoint URL, `fly secrets set BACKUP_S3_…`, **no bucket lifecycle
      rule** (the app prunes after successful uploads; `BACKUP_KEEP_DAYS`), `backup:offsite` to test it
      now, where to see results (`fly logs`, the bucket), that backups are not encrypted and the token
      must stay private, and keeping `SESSION_SECRET`/`SHARE_HMAC_KEY` in a password manager (needed
      after a restore for expiring share links)
- [ ] README: "Restore on Fly.io" (`restore:offsite` over `fly ssh console` with the `setpriv` prefix,
      then `fly machine restart`; free-space rule; cancelling a staged or stuck restore with
      `fly secrets set RESTORE_ABORT=1` then `fly secrets unset RESTORE_ABORT`), Fly volume snapshots (`fly volumes snapshots list`, retention); moving local notes
      to Fly (`docker compose exec -e BACKUP_S3_…=… app npm run backup:offsite` locally, then
      `restore:offsite` on Fly); and the entrypoint/`user: "1000:1000"` note in the Docker section
- [ ] update CLAUDE.md (entrypoint/uid rule, `CLIENT_IP_HEADER`, `fly.toml` invariants test, backup
      service/reader, off-site job and retention, restore staging and startup swap, never test against
      the user's Compose project)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Fly.io setup (the user's account)**:
- install `flyctl` (`brew install flyctl`), `fly auth login`, pick the app name (it becomes
  `<name>.fly.dev`) and region, then follow the README section; Fly requires a payment method
- after the first deploy: open `https://<name>.fly.dev` and create the account immediately
- **blocking before relying on the rate limits**: with `LOG_LEVEL=debug`, send
  `curl -H 'Fly-Client-IP: 203.0.113.9' -H 'X-Forwarded-For: 203.0.113.9' https://<name>.fly.dev/api/health`
  and confirm the `client address` log line shows your real IP, not `203.0.113.9` and not a Fly-internal
  address; then set `LOG_LEVEL` back to `info`. If Fly passes the spoofed value through, stop and
  revisit the client-IP design before going further
- confirm `fly ips list` shows only a shared IPv4 and an IPv6 (no billed dedicated IPv4)
- check `fly volumes snapshots list` shows daily snapshots; set retention if wanted

**Cloudflare R2 setup**:
- create the bucket and a bucket-scoped API token (no lifecycle rule), set the `BACKUP_S3_*` secrets on
  Fly
- run `backup:offsite` once and confirm the three objects appear in the bucket

**Restore drill (once, before relying on it)**:
- restore a backup into a scratch Fly app or a local Docker container with a throwaway volume (never
  the real `notes-app_notes-data`), and confirm notes, images, PDFs and GPX files are back

**Moving existing local notes to Fly (optional)**:
- with the R2 settings passed only to that one command (`docker compose exec -e …`), run
  `backup:offsite` in the local container, then `restore:offsite <name>` on Fly and restart; use the
  same `SESSION_SECRET`/`SHARE_HMAC_KEY` as locally if existing expiring share links should keep working
