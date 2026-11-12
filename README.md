# Notes App

Self-hosted notes with nested folders, rich-text editing (TipTap) and secure sharing
(PIN-gated links or HMAC-signed expiring links). Runs as a single container: Fastify
serves the API and the built SPA, and all state lives in one data directory.

## Features

- Nested folders and notes in a sidebar tree: create, rename, delete (cascades), move by drag and drop
  or "Move to…", with folder cycles rejected in the UI and on the server. Drag and drop works with a
  mouse or the keyboard (Space picks an item up, arrow keys move it, Space drops, Escape cancels);
  touch screens have no drag — long-press an item or use its "…" menu → "Move to…".
- TipTap rich-text editor with debounced autosave (a stale save gets a conflict prompt instead of
  overwriting) and image upload by button, drag or paste (PNG/JPEG/WebP/GIF, 10 MB max).
- File attachments by the toolbar's **Attach file** button, drag or paste (the server checks each
  file's content, never its name or declared type):
  - **PDF** (25 MB max): a small in-note viewer (one page at a time, previous/next, "page i of n") plus
    a Download button. The viewer (PDF.js) is a separate chunk loaded only when a note shows a PDF, and
    each PDF is fetched only once its viewer scrolls into view; the worker, the standard-font data and
    the CJK CMaps are served from the app's own origin. It draws pages to a canvas only (no links,
    forms or PDF scripts). Not supported: JPEG 2000 and JBIG2 images (PDF.js decodes them with
    WebAssembly, which the page CSP does not allow); such pages show blank areas or "Preview
    unavailable".
  - **GPX** (25 MB max, UTF-8 text): a file chip with name, size and a Download button; no preview.
    The root element must be a plain `<gpx>` with only whitespace, an XML declaration and comments
    before it; GPX files with a `<!DOCTYPE>`, `<!ENTITY>` or any other `<?…?>` instruction (such as
    `<?xml-stylesheet?>`), a namespace-prefixed root (`<gpx:gpx>`) or a UTF-16 encoding are rejected.
  - Both work in shared notes too (the viewer and downloads use the share's PIN unlock or signed link,
    which never appears in a URL), and the download keeps the original file name, except that a PDF
    or GPX name always ends in `.pdf` / `.gpx`: the extension is appended when missing
    (`Route guide.exe` uploaded as a PDF is stored and downloaded as `Route guide.exe.pdf`), so a saved
    file always opens as the type the server checked.
  - **Browser support**: the viewer uses PDF.js 6's legacy build (library and worker), which is
    transpiled and polyfilled for older browsers, so previews also work on older iOS Safari and Android
    versions that the modern build (it needs brand-new JavaScript such as
    `Map.prototype.getOrInsertComputed`) would not run on. It costs a somewhat larger lazy chunk (about
    490 kB instead of 430 kB, plus a 1.3 MB worker), loaded only when a note shows a PDF. If a browser
    still cannot run it, the viewer shows "Preview unavailable" and Download still works.
- Sharing with no public access by default, per note, from the **Share** button in the open note's
  header:
  - **PIN**: an 8-character PIN shown once; visitors unlock a read-only view (5 wrong PINs per note
    in 15 minutes lock it out).
  - **Expiring link**: an HMAC-signed link valid for 1 hour, 1 day, 7 days or 30 days.
  - Regenerating or stopping a share revokes the old PIN or link immediately. Every failure (wrong PIN,
    expired, revoked, missing) shows the same "unavailable" page.
- Email + password accounts (argon2id, server-side sessions), change password in the app, reset from
  the command line. The first account created is the **owner**; by default nobody else can sign up. A session lasts 30 days and is renewed
  to a fresh 30 days while you keep using the app (once less than half of it is left); a browser stays
  a known device for 1 year after its last login.
- One container, one data directory: SQLite database plus uploaded images and files, backed up with
  one command.

## Quick start (Docker)

```sh
cp .env.example .env
# set SESSION_SECRET and SHARE_HMAC_KEY (openssl rand -hex 32 each) and PUBLIC_ORIGIN
docker compose -f docker-compose.yml -f compose.direct.yml up -d --build
```

Open `PUBLIC_ORIGIN` (e.g. `http://<host>:3000`) and sign up ("Create one" on the sign-in page); that
first account becomes the owner, and signup then closes (see `ALLOW_SIGNUP`).
`compose.direct.yml` is for a LAN or testing; see [Docker](#docker) for public deployments.

## Sharing a note

Notes are private until you share them, one note at a time.

1. **Open the note** by clicking it in the sidebar. The **Share** button exists only while a note is open
   (not on the empty start screen). On a narrow screen the sidebar is a drawer: open it with the ☰
   button (**Open sidebar**) at the top, then pick the note.
2. **Click Share** at the top right of the note, on the same row as the title and the "Saved" indicator.
   Once a note is shared the button reads **Shared**.
3. **Choose how to share** in the dialog:
   - **Password (PIN)** → **Create PIN**: you get a link plus an 8-character PIN. **The PIN is shown only
     once**: copy it right away (the copy buttons sit next to the link and the PIN). Send the link and the
     PIN to the reader, ideally through different channels (e.g. the link by email, the PIN by text). A
     PIN share does not expire.
   - **Expiring link** → pick **1 hour**, **1 day**, **7 days** (the default) or **30 days** → **Create
     link**: anyone with the link can read the note until it expires; no PIN is needed.
4. **Later**, open the dialog again to manage the share:
   - **New PIN** / **New link** replaces the current share; the old PIN or link stops working at once.
   - **Stop sharing** makes the note private again.
   - A note is shared one way at a time: creating a link turns off a PIN share and the other way round.

What the reader sees: a read-only page with no sidebar and no editing, where they can view the note
and its images, page through PDFs and download PDF and GPX files. With a PIN share they first enter the
PIN; after 5 wrong PINs within 15 minutes the note is locked for a while ("Too many attempts"). A wrong
PIN, an expired or revoked link and a missing note all show the same "unavailable" page, so a link
reveals nothing about why it does not work.

The links point at the address the app is served from: use the app through its public address
(`PUBLIC_ORIGIN`, e.g. `https://notes.example.com`), not `localhost`, so the links you send work for
other people. (The app accepts changes only from `PUBLIC_ORIGIN` anyway, so this is the address you
create shares from.)

## Requirements

- Node.js 22+ (`node -v`). On macOS: `brew install node@22`.
- Or only Docker with Compose v2, to run the image.

## Layout

- `apps/server` — Fastify + TypeScript API (Vitest tests in `apps/server/test`)
- `apps/web` — React + Vite + Tailwind + shadcn/ui SPA (Vitest + Testing Library)
- `e2e` — Playwright smoke test against the compiled server

## Configuration

All configuration comes from environment variables (`.env.example` documents each one). The server
validates them at boot and refuses to start on any problem, listing every one.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SESSION_SECRET` | required | At least 32 characters (`openssl rand -hex 32`). Session and device cookies are stored as HMACs keyed by it, so changing it signs everyone out. |
| `SHARE_HMAC_KEY` | required | At least 32 characters. Signs expiring links and PIN unlock tokens; changing it invalidates every expiring link. |
| `PUBLIC_ORIGIN` | required | Exact origin the app is served from (`scheme://host[:port]`, no path). Every mutating request must send it as `Origin` (CSRF check); `https` adds the `Secure` cookie flag. Dev: `http://localhost:5173`. |
| `TRUST_PROXY` | unset (trust nothing) | Hop count (`1`) or comma-separated proxy IPs/CIDRs; `0` is the same as unset and a bare `true` is rejected. Set it only when the app port is reachable solely through that proxy. |
| `ALLOW_SIGNUP` | unset (first account only) | Who can sign up. Unset: only while no account exists, so the owner can create theirs on first run; after that signup is closed. `true`/`1`: anyone, any time (more accounts). `false`/`0`: nobody, not even on an empty database (the owner must already exist, e.g. restored from a backup). Any other value refuses to boot. The sign-in page offers "Create one" only while signup is open. |
| `DATA_DIR` | `./data` | Holds `notes.db` and `uploads/`. A relative path resolves against the server's working directory (`apps/server` when run through npm). Docker always uses `/data`. |
| `HOST` | `0.0.0.0` | Listen address. |
| `PORT` | `3000` | Listen port. |
| `LOG_LEVEL` | `info` | `fatal` … `trace`; `debug` logs each request's client address and rate-limit IP key. |
| `UPLOAD_QUOTA_MB` | `1024` | Most attachment storage (images, PDF and GPX files together) one account may use, in MB (integer; `0` = no limit). Uploads past it get 413 `QUOTA_EXCEEDED`. Removed attachments still count until the sweep deletes them, 7 days after removal. |
| `CLOUDFLARE_TUNNEL_TOKEN` | unset | `compose.tunnel.yml` only. |

## Development

```sh
npm install
cp .env.example .env   # fill in the secrets
set -a; . ./.env; set +a   # the server reads only environment variables; .env is not loaded automatically
npm run dev            # server and web dev servers together (web proxies /api to :3000)
npm test               # all tests in both apps
npm run test:e2e       # Playwright smoke test (builds, then runs the compiled server on :3100 with a temp DATA_DIR;
                       # first time: npx playwright install chromium; E2E_PORT=3200 npm run test:e2e picks another port)
npm run lint           # ESLint + TypeScript type checks
npm run build          # production build of both apps
```

Single test files:

```sh
npm test -w apps/server -- test/move.test.ts
npm test -w apps/web -- src/features/tree/dnd.test.ts
```

## Running without Docker

```sh
npm ci && npm run build
set -a; . ./.env; set +a   # configuration comes from environment variables (see .env.example)
npm start                  # node apps/server/dist/index.js
```

The npm scripts `start`, `reset-password` and `backup` all run the compiled `apps/server/dist` files
with plain `node`.

## Docker

The image is multi-stage (build web + compile server, production dependencies only, then
`node:22-slim`). It runs as the non-root user **uid/gid 1000**, keeps all state in `/data`, and has a
`HEALTHCHECK` on `/api/health`.

```sh
cp .env.example .env   # set SESSION_SECRET, SHARE_HMAC_KEY (openssl rand -hex 32) and PUBLIC_ORIGIN
```

`docker-compose.yml` is the base: it publishes **no** port, puts the app on a network with the fixed
subnet `172.30.0.0/24`, and stores `/data` in the **named volume** `notes-data`. Compose refuses to start
without the secrets and `PUBLIC_ORIGIN`; the server refuses to boot when a secret is shorter than 32
characters. `.env` itself is optional to Compose (Docker Compose 2.24 or newer), but the optional
settings (`LOG_LEVEL`, `ALLOW_SIGNUP`, ...) reach the container only through it. Pick exactly one
deployment override:

| Deployment | Command | Port | `TRUST_PROXY` |
| --- | --- | --- | --- |
| Direct (LAN / testing only) | `docker compose -f docker-compose.yml -f compose.direct.yml up -d` | `3000:3000` | unset |
| nginx on the same host | `docker compose -f docker-compose.yml -f compose.nginx.yml up -d` | `127.0.0.1:3000:3000` | `1` |
| Cloudflare Tunnel | `docker compose -f docker-compose.yml -f compose.tunnel.yml up -d` | none | `172.30.0.10` |
| Fly.io | `fly deploy` with this Dockerfile | internal port only, behind Fly's proxy | `1` |

**The rule: whenever `TRUST_PROXY` is set, the app port must be reachable only through that proxy.**
Otherwise anyone who reaches the port directly can forge `X-Forwarded-For` and get a fresh rate-limit
key per request. Every override above follows it; keep it if you write your own.

- **Direct** is for a LAN or for testing only. Docker's userland proxy rewrites the source address of
  IPv6 clients, so all of them share one IP key for the rate limits. Public deployments should use the
  nginx or tunnel override.
- **nginx**: proxy to `http://127.0.0.1:3000` with
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` and `proxy_set_header Host $host;`,
  set `client_max_body_size 27m;` (PDF/GPX uploads are up to 25 MB, images up to 10 MB, plus the
  multipart overhead), and terminate TLS there
  (`PUBLIC_ORIGIN=https://...`).
- **Cloudflare Tunnel**: create a tunnel in the Zero Trust dashboard, point its public hostname at
  `http://app:3000`, and put the token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`. `cloudflared` runs at the
  fixed address `172.30.0.10`, and only that single address is trusted (never the subnet, so the bridge
  gateway cannot forge the header). Dynamic addresses on the network come from `172.30.0.128/25`, so
  nothing else can get `.10`.
- **Fly.io**: define only an internal port (`internal_port = 3000` under `[http_service]`, no public
  port mapping of your own), so every request comes through Fly's proxy, set `TRUST_PROXY=1`, and mount
  a Fly volume at `/data`.

To check the client address the rate limits see, set `LOG_LEVEL=debug` in `.env`, restart, and look for
the `client address` lines in `docker compose logs app`: `ip` must be the real client (from
`X-Forwarded-For` behind a proxy), never `172.30.0.10` or the gateway. `docker compose ps` must show no
published port for the tunnel deployment.

**Bind mounts.** The named volume is initialised from the image's `/data`, which is owned by uid/gid
1000. If you switch to a bind mount (`./data:/data`), create the directory and `chown -R 1000:1000` it on
the host first, or the app cannot write to it.

**Security notes.**

- Login is rate-limited per IP key, per (account, IP key) and by a per-account delay gate. Browsers that
  have logged in before (known devices) skip the delay gate, but a **brand-new device may have to wait
  out the login delay while someone is attacking the account**.
- Rate limits ("IP key" = the client IPv4 address, or its IPv6 /64):
  - failed logins: 30 per 15 minutes per IP key, 10 per 15 minutes per (account, IP key);
  - successful logins: 20 per 15 minutes per account and per IP key;
  - signups: 5 per hour per IP key; password changes: 5 per 15 minutes per account;
  - PIN unlocks: 30 attempts per 15 minutes per IP key, 5 wrong PINs per 15 minutes per note.
  - uploads (images, PDF and GPX files together): 100 per 15 minutes per account;
  - note creation: 60 per 15 minutes per account; note content saves: 600 per 15 minutes per account
    (autosave saves at most about once a second while you type, and retries a refused save).
- All rate-limit state is kept in memory: a restart clears it, and the app must run as a **single
  process** (one container/replica, no horizontal scaling) for the limits to hold.
- A session lasts 30 days; using it with less than 15 days left renews it to a fresh 30 days, so an
  unused session expires after 15 to 30 days. Known devices expire 1 year after their last login.
- Signup is open only until the first account (the owner) exists, unless `ALLOW_SIGNUP=true`. Create
  the owner account right after the first start: until then, anyone who reaches the app can claim it.
- Each account may store at most `UPLOAD_QUOTA_MB` (default 1024 MB) of attachments (images, PDF and
  GPX files together), the owner included.
  Note content has no size quota (only the write rate limits above and a 5 MB limit per save), so every
  account can grow the data volume, which also holds the database. Only allow accounts you trust:
  `ALLOW_SIGNUP=true` on a public deployment lets strangers create accounts that can fill the disk.
- Uploads are accepted by content only: PNG/JPEG/WebP/GIF images (10 MB), PDF (starting with `%PDF-`,
  25 MB) and GPX (UTF-8 XML whose root element is a plain `<gpx`, with only whitespace, an
  XML declaration and comments before it, within the first 64 KB; no `<!DOCTYPE>`/`<!ENTITY>` and no
  other `<?…?>` instruction; 25 MB); anything else gets 415.
  Images are served inline (`Content-Disposition: inline`, named after the stored name with the
  detected image extension forced, e.g. `x.js` → `x.js.png`). **Non-image files are always served as downloads**, on the owner route and
  the shared route alike: `Content-Disposition: attachment` with the stored name (ending in `.pdf` / `.gpx`),
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox` on the file response, so
  opening a file's URL directly never renders it on the app's origin. The page CSP allows `blob:` in
  `connect-src` (the shared PDF viewer reads its fetched bytes back from a blob URL) and never
  `unsafe-eval`. The app's Download button saves only a response the server typed as PDF/GPX, under
  the server's name (never the name stored in the note); anything else is refused with an error.

Commands inside the container (from the same directory, with the same `-f` files):

```sh
docker compose -f docker-compose.yml -f compose.direct.yml exec app npm run reset-password -- you@example.com
docker compose -f docker-compose.yml -f compose.direct.yml exec app npm run backup
```

### Starting and stopping

Run these from the repository directory, with the same `-f` files you started with (`compose.direct.yml`
below; use `compose.nginx.yml` or `compose.tunnel.yml` if that is your deployment).

```sh
docker compose -f docker-compose.yml -f compose.direct.yml up -d --build   # start (rebuild after updating the code)
docker compose -f docker-compose.yml -f compose.direct.yml logs -f app     # follow the logs
docker compose -f docker-compose.yml -f compose.direct.yml stop            # pause; `start` resumes the same container
docker compose -f docker-compose.yml -f compose.direct.yml down            # stop and remove the container and network
docker kill notes-app-app-1                                                # force-stop immediately
docker ps                                                                  # what is running
```

None of these delete your notes: they live in the volume `notes-app_notes-data`. Its name does not
depend on the directory you run Compose from: `docker-compose.yml` fixes the project name
(`name: notes-app`), so the volume is always `notes-app_notes-data` and the container `notes-app-app-1`.
Only `-p <name>` or `COMPOSE_PROJECT_NAME` changes that; if you set one, use `<name>-app-1` in the
`docker kill` command above and `<name>_notes-data` in the `docker run` commands below. Only `down -v`,
or pruning unused volumes after a `down` (e.g. `docker volume prune -a`), deletes the volume, and that
cannot be undone.
With Colima on a Mac, `colima start` must run first after a reboot (`brew services start colima` starts it
at login), and `colima stop` frees the VM's memory.

## Backup and restore

All state is the data directory (`/data` in the container: the SQLite database `notes.db` and the
`uploads/` folder) plus the secrets in `.env`. Keep a copy of `.env` with your backups: without the same
`SHARE_HMAC_KEY`, restored expiring share links stop working (see [Moving to another server](#moving-to-another-server)).
Backups stay on the machine that made them, so copy them elsewhere too (another disk, cloud storage).

### Option A: `npm run backup` (while the app runs)

`npm run backup -- [outDir]` writes a consistent snapshot while the server keeps running:
`<outDir>/notes-backup-<UTC timestamp>/notes.db` (made with SQLite's online backup API, a standalone
file) and `uploads.tar.gz` (every uploaded file the database copy references, as `uploads/<name>`).
`outDir` defaults to `DATA_DIR/backups`; a relative `outDir` is relative to the directory you run the
command from.

Bare metal:

```sh
npm run backup                                      # see below for DATA_DIR
```

Docker: make the backup inside the container (it prints `Backup written to /data/backups/notes-backup-…`),
then copy that one directory out (replace `XXXX` with
its timestamp). Copying one named backup into an existing `./backups` keeps the path
`./backups/notes-backup-XXXX` that the restore below uses, however many times you do it:

```sh
docker compose -f docker-compose.yml -f compose.direct.yml exec app npm run backup
mkdir -p backups
docker compose -f docker-compose.yml -f compose.direct.yml cp app:/data/backups/notes-backup-XXXX ./backups/
```

If the container is not running, start it first (`up -d`), then run the Docker commands.

Bare metal: the CLIs read `DATA_DIR` only from the environment, not from `.env`, so export the same
environment as the server first (`set -a; . ./.env; set +a`) or prefix the command with
`DATA_DIR=/path/to/data`. Otherwise they fall back to `apps/server/data`.

Backups made inside the container land in the `notes-app_notes-data` volume (`/data/backups`); copy
them off the host as shown and delete old ones from time to time.

### Option B: archive the whole volume (while the app is stopped)

An exact copy of everything in `/data` except the Option A snapshots, without starting the app. **Only while the app is stopped**
(`down` or `stop`): copying the database files while the server writes to them can give an inconsistent
copy.

```sh
mkdir -p ~/notes-backups
docker run --rm -v notes-app_notes-data:/data -v ~/notes-backups:/out node:22-slim \
  tar --exclude=./backups -czf /out/notes-data-$(date +%Y%m%d-%H%M).tar.gz -C /data .
```

The archive leaves out `/data/backups` (the Option A snapshots kept in the volume), so archives do not
grow with every earlier backup; copy those out separately if you want them.

### Restore

Stop the app first. Bare metal, from an Option A backup, into the data directory. Set `DATA_DIR` to the
**absolute** path of the directory the server uses: a relative `DATA_DIR` (such as `./data` from
`.env.example`) is resolved by the server against `apps/server`, not against your shell's directory.
The default is `apps/server/data`; replace `XXXX` with the backup's timestamp:

```sh
# from the repository root
DATA_DIR="$PWD/apps/server/data"                  # or your absolute DATA_DIR
BACKUP="$DATA_DIR/backups/notes-backup-XXXX"      # or wherever the backup is
rm -f "${DATA_DIR:?}/notes.db-wal" "${DATA_DIR:?}/notes.db-shm"   # never mix a restored db with an old WAL
cp "$BACKUP/notes.db" "${DATA_DIR:?}/notes.db"
tar -xzf "$BACKUP/uploads.tar.gz" -C "${DATA_DIR:?}"              # recreates $DATA_DIR/uploads/
```

With Docker, into the volume with a one-off container (`--user 1000:1000`: the app runs as uid 1000 and
must own its files). From an Option A backup (replace `XXXX` with the backup's timestamp):

```sh
docker run --rm -v notes-app_notes-data:/data -v "$PWD/backups/notes-backup-XXXX:/backup" --user 1000:1000 node:22-slim \
  sh -c 'rm -f /data/notes.db-wal /data/notes.db-shm && cp /backup/notes.db /data/ && tar -xzf /backup/uploads.tar.gz -C /data'
```

From an Option B archive (the old WAL files go first here too; an archive taken after a crash brings
its own):

```sh
docker run --rm -v notes-app_notes-data:/data -v ~/notes-backups:/in --user 1000:1000 node:22-slim \
  sh -c 'rm -f /data/notes.db-wal /data/notes.db-shm && tar -xzf /in/notes-data-XXXX.tar.gz -C /data'
```

Then start the app again.

### Moving to another server

Copy the data and `.env` from the old server, restore into a fresh volume on the new one.

1. **Old server**: stop the app and archive the volume (Option B):

   ```sh
   cd ~/notes-app
   docker compose -f docker-compose.yml -f compose.direct.yml down
   docker run --rm -v notes-app_notes-data:/data -v "$PWD":/out node:22-slim \
     tar --exclude=./backups -czf /out/notes-data.tar.gz -C /data .
   ```

2. **Copy** the archive and `.env` to the new server:

   ```sh
   scp notes-data.tar.gz .env user@new-server:~/
   ```

3. **New server**: check out the code, start once to create the (empty) volume, stop, restore, start.
   The archive goes into a directory of its own that uid 1000 (the app's user in the restore container)
   can read; your home directory may not be readable by it:

   ```sh
   git clone <your repo> ~/notes-app && cd ~/notes-app
   mv ~/.env .
   mkdir -p ~/notes-restore && mv ~/notes-data.tar.gz ~/notes-restore/
   chmod 755 ~/notes-restore && chmod 644 ~/notes-restore/notes-data.tar.gz
   docker compose -f docker-compose.yml -f compose.direct.yml up -d --build   # creates notes-app_notes-data
   docker compose -f docker-compose.yml -f compose.direct.yml down
   docker run --rm --user 1000:1000 -v notes-app_notes-data:/data -v ~/notes-restore:/in node:22-slim \
     sh -c 'rm -f /data/notes.db-wal /data/notes.db-shm && tar -xzf /in/notes-data.tar.gz -C /data'
   docker compose -f docker-compose.yml -f compose.direct.yml up -d
   ```

4. **Check**: sign in with your existing account; notes, folders and files are all there.

Things that matter when moving:

- **Keep the same `SHARE_HMAC_KEY` and `SESSION_SECRET`** (copy `.env` as is). A different
  `SHARE_HMAC_KEY` breaks every expiring share link already sent; a different `SESSION_SECRET` only signs
  everyone out. PIN shares keep working either way.
- **Domain change**: update `PUBLIC_ORIGIN`. Links already sent still point at the old domain, so share
  new ones.
- **Do not sign up on the new server before restoring**: with the default signup mode the first signup
  becomes the owner, and the restore overwrites it anyway.
- **Directory name** does not matter: the compose file fixes the project name (`name: notes-app`), so
  the volume is `notes-app_notes-data` wherever you clone the code. Only `-p`/`COMPOSE_PROJECT_NAME`
  changes it; if you set one, use `<that name>_notes-data` in the `docker run` commands.
- Use the `-f` override of your deployment (`compose.nginx.yml`, `compose.tunnel.yml`) in place of
  `compose.direct.yml`, and set `TRUST_PROXY` for the new server's setup (see [Docker](#docker)).

## Password reset

There is no email reset. Signed-in users change their password in the app; an operator with shell
access to the server resets any account with:

```sh
npm run build -w apps/server                # once, if dist/ is not built yet
set -a; . ./.env; set +a                    # or prefix DATA_DIR=/path/to/data (.env is not read automatically)
npm run reset-password -- you@example.com   # prompts twice for the new password, without echo
```

In Docker use `docker compose ... exec app npm run reset-password -- you@example.com` (see above).

It uses `DATA_DIR` (relative paths resolve against `apps/server`, like the server itself) and needs no
secrets. Both the reset and an in-app change revoke the account's other sessions and known devices.
