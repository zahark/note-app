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
- Single server test file: `npm test -w apps/server -- test/move.test.ts`

## Server layout

`routes/` (HTTP + zod validation only) → `services/` (share, tree, attachments, auth, rate limits)
→ `repos/` (SQL) → `db/` (connection, migrations). CLIs in `src/cli/`.

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
- Images are stored in content as `attachment://<aid>`; never store a real URL. Attachments belong to
  the user; `note_attachments` is rebuilt from the content on every save (foreign ids ignored), and
  only the sweep deletes files (7 days after the last reference is gone).
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
