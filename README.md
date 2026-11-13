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
  overwriting) and image upload by button, drag or paste (PNG/JPEG/WebP/GIF, 10 MB max). To add a
  link, type or paste a URL (it becomes a link on its own), or select text and press the toolbar's
  **Link** button; with nothing selected, **Link** inserts the address you type. Clicking a link places the cursor and shows a small popup with its URL and **Open** (new tab), **Edit** and
  **Remove**; Cmd+click (macOS) / Ctrl+click opens it directly. Only http, https and mailto links are
  ever opened. In shared notes a plain click opens a link in a new tab.
  Hebrew (or any right-to-left) text: each paragraph, heading, list item and quote runs and aligns
  by its first letter, so a line that starts in Hebrew sits on the right and one that starts in
  English on the left; code blocks stay left-to-right. When the first letter guesses wrong (a Hebrew
  sentence that starts with an English word), the toolbar's **Right-to-left** / **Left-to-right**
  buttons force the direction of the paragraph or list item; press the lit button again to go back
  to automatic.
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
  one command, and optionally uploaded every day to a Cloudflare R2 bucket
  ([off-site backups](#off-site-backups-to-cloudflare-r2)).

## Quick start (Docker)

```sh
cp .env.example .env
# set SESSION_SECRET and SHARE_HMAC_KEY (openssl rand -hex 32 each) and PUBLIC_ORIGIN
docker compose -f docker-compose.yml -f compose.direct.yml up -d --build
```

Open `PUBLIC_ORIGIN` (e.g. `http://<host>:3000`) and sign up ("Create one" on the sign-in page); that
first account becomes the owner, and signup then closes (see `ALLOW_SIGNUP`).
`compose.direct.yml` is for a LAN or testing; see [Docker](#docker) for public deployments, or
[Deploying to Fly.io](#deploying-to-flyio) to run it in the cloud with a free `https://<app>.fly.dev`
address.

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
| `CLIENT_IP_HEADER` | unset | Name of a header the platform's proxy sets to the client address on every request (`Fly-Client-IP` on Fly.io; `fly.toml` sets it). The per-IP rate limits then use its value; a missing or invalid value falls back to the socket address. Same rule as `TRUST_PROXY`: set it only when the app is reachable solely through that proxy. Setting both is a config error. Docker Compose pins it empty. |
| `ALLOW_SIGNUP` | unset (first account only) | Who can sign up. Unset: only while no account exists, so the owner can create theirs on first run; after that signup is closed. `true`/`1`: anyone, any time (more accounts). `false`/`0`: nobody, not even on an empty database (the owner must already exist, e.g. restored from a backup). Any other value refuses to boot. The sign-in page offers "Create one" only while signup is open. |
| `DATA_DIR` | `./data` | Holds `notes.db` and `uploads/` (plus `offsite-backup.json` with off-site backups on, and `restore*` folders while a restore is staged or applied). A relative path resolves against the server's working directory (`apps/server` when run through npm). Docker always uses `/data`. |
| `HOST` | `0.0.0.0` | Listen address. |
| `PORT` | `3000` | Listen port. |
| `LOG_LEVEL` | `info` | `fatal` … `trace`; `debug` logs each request's client address and rate-limit IP key. |
| `UPLOAD_QUOTA_MB` | `1024` | Most attachment storage (images, PDF and GPX files together) one account may use, in MB (integer; `0` = no limit). Uploads past it get 413 `QUOTA_EXCEEDED`. Removed attachments still count until the sweep deletes them, 7 days after removal. |
| `BACKUP_S3_ENDPOINT` | unset | Off-site backups: the bucket's S3 endpoint, an `https` origin with no path (R2: `https://<account-id>.r2.cloudflarestorage.com`). Off-site backups run only when this and the next three are all set; setting only some of them refuses to boot. See [Off-site backups](#off-site-backups-to-cloudflare-r2). |
| `BACKUP_S3_BUCKET` | unset | Bucket name (3-63 lowercase letters, digits, `-` and `.`, starting and ending with a letter or digit). |
| `BACKUP_S3_ACCESS_KEY_ID` | unset | Access Key ID of the R2 API token. |
| `BACKUP_S3_SECRET_ACCESS_KEY` | unset | Secret Access Key of the R2 API token. Never logged. |
| `BACKUP_S3_REGION` | `auto` | Signing region (`auto` is what R2 expects; lowercase letters, digits and `-`). |
| `BACKUP_S3_PREFIX` | `notes-backups/` | Folder (key prefix) in the bucket: letters, digits, `.`, `_`, `-` and `/`; a trailing `/` is added; no leading `/`, no `//` and no `..`. |
| `BACKUP_INTERVAL_HOURS` | `24` | Back up when the last successful scheduled upload is at least this many hours old (1-168). |
| `BACKUP_KEEP_DAYS` | `30` | Delete backups older than this many days (1-3650), but always keep the newest 7. |
| `RESTORE_ABORT` | unset | `1`/`true`: at the next start, discard a restore staged by `npm run restore:offsite` instead of applying it (a swap already in progress is rolled back first). Unset it again afterwards; while it is set with nothing staged, every start logs a reminder. `0`/`false` is the same as unset. Any other value (e.g. `yes`, `TRUE`) refuses to boot. |
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
npm run test:docker    # builds the image as notes-app:docker-check and checks it with throwaway volumes and
                       # containers (Fly-like root start, Compose-like uid 1000); needs Docker
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

The npm scripts `start`, `reset-password`, `backup`, `backup:offsite` and `restore:offsite` all run the
compiled `apps/server/dist` files with plain `node`.

## Docker

The image is multi-stage (build web + compile server, production dependencies only, then
`node:22-slim`). The server always runs as the non-root user **uid/gid 1000**, keeps all state in
`/data`, and has a `HEALTHCHECK` on `/api/health`.

The image does not set `USER`; its entrypoint (`docker-entrypoint.sh`) decides. Started as root, as on
Fly.io (whose volumes are mounted empty and owned by root), it makes `/data` owned by 1000:1000 and then
starts the server as 1000:1000 (with `setpriv`). Started as any other user, it just runs the server.
`docker-compose.yml` sets `user: "1000:1000"`, so with Compose the container starts as uid 1000 and
`docker compose exec` commands also run as uid 1000, as before. If you start the image some other way
as root (plain `docker run` without `--user`), run commands inside it as the app user
(`docker exec --user 1000:1000 …`), or files they create belong to root and the server cannot touch them.

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
| Fly.io | `fly deploy` with `fly.toml` (see [Deploying to Fly.io](#deploying-to-flyio)) | internal port only, behind Fly's proxy | unset (`CLIENT_IP_HEADER=Fly-Client-IP` instead) |

**The rule: whenever `TRUST_PROXY` (or `CLIENT_IP_HEADER`) is set, the app port must be reachable only
through that proxy.** Otherwise anyone who reaches the port directly can forge `X-Forwarded-For` (or
the header) and get a fresh rate-limit key per request. Every override above follows it; keep it if you
write your own.

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
- **Fly.io**: the repository's `fly.toml` defines only an internal port (`internal_port = 3000` under
  `[http_service]`, no public port mapping of its own), so every request comes through Fly's proxy, and
  sets `CLIENT_IP_HEADER=Fly-Client-IP`: the rate limits take the client address from the
  `Fly-Client-IP` header that Fly's proxy sets. **Never set `TRUST_PROXY` on Fly** (together with
  `CLIENT_IP_HEADER` it is a config error and the app does not start). A Fly volume is mounted at
  `/data`. The whole setup is in [Deploying to Fly.io](#deploying-to-flyio).

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
docker compose -f docker-compose.yml -f compose.direct.yml exec app npm run backup:offsite    # with BACKUP_S3_* in .env
docker compose -f docker-compose.yml -f compose.direct.yml exec app npm run restore:offsite -- notes-backup-YYYYMMDD-HHMMSS
```

(See [Off-site backups](#off-site-backups-to-cloudflare-r2) and
[Restore from R2 with Docker Compose](#restore-from-r2-with-docker-compose-or-without-docker) for the last two.)

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

## Deploying to Fly.io

Runs the app on [Fly.io](https://fly.io) for personal use at `https://<app>.fly.dev` (a free `fly.dev`
address with HTTPS): one always-on machine (`shared-cpu-1x`, 512 MB) and a 1 GB volume mounted at
`/data`, which together cost about **$3.3 a month** (check [fly.io/pricing](https://fly.io/pricing) for
current prices; Fly asks for a payment method). Everything is set in the repository's `fly.toml`; you
only add your app name, region and secrets. 512 MB is the minimum: password hashing alone can use
over 300 MB at peak.

In the commands below, replace `<app>` with the name you pick (it becomes `<app>.fly.dev`, so it must be
unique on Fly) and `<region>` with the Fly region closest to you (`fly platform regions` lists them,
e.g. `fra` Frankfurt, `ams` Amsterdam, `iad` Virginia).

1. **Install flyctl and log in** (on a Mac):

   ```sh
   brew install flyctl
   fly auth login            # or `fly auth signup` for a new account
   ```

2. **Create the app** from the repository directory, without deploying yet. This writes your app name
   and region into `fly.toml`; answer "no" if it asks whether to tweak the settings:

   ```sh
   fly launch --copy-config --no-deploy --name <app> --region <region>
   git commit -am "fly.toml: my app name and region"   # only the app name and region changed, no secrets
   ```

   Committing keeps your `fly.toml` through later `git pull`s (see **Update** below).

3. **Create the volume** (1 GB, same region). Fly warns that a single volume has no redundancy: answer
   yes. The data's safety net is the volume snapshots Fly takes daily plus the
   [off-site backups](#off-site-backups-to-cloudflare-r2).

   ```sh
   fly volumes create notes_data --size 1 --region <region>
   ```

4. **Set the secrets.** Generate them, **save both values in your password manager** (you need the same
   values again to restore a backup into a new app: a different `SHARE_HMAC_KEY` breaks every expiring
   share link already sent), then hand them to Fly:

   ```sh
   SESSION_SECRET=$(openssl rand -hex 32)
   SHARE_HMAC_KEY=$(openssl rand -hex 32)
   echo "SESSION_SECRET=$SESSION_SECRET"; echo "SHARE_HMAC_KEY=$SHARE_HMAC_KEY"   # copy into your password manager
   fly secrets set SESSION_SECRET="$SESSION_SECRET" SHARE_HMAC_KEY="$SHARE_HMAC_KEY" PUBLIC_ORIGIN=https://<app>.fly.dev
   ```

   Moving an existing local install? Use its values from `.env` instead (`set -a; . ./.env; set +a`, then
   the `fly secrets set` line above), so expiring share links stay valid; see
   [Moving local notes to Fly.io](#moving-local-notes-to-flyio). Links already sent still point at the
   old address (the old `PUBLIC_ORIGIN`, not `https://<app>.fly.dev`), so share new ones.

5. **Deploy** (Fly builds the image on its own builders; no local Docker needed):

   ```sh
   fly deploy
   ```

6. **Sign up right away**: open `https://<app>.fly.dev` and create your account ("Create one" on the
   sign-in page). The first account becomes the owner and signup then closes; until you do this, anyone
   who finds the address can claim it.

7. **Check the IP addresses**: `fly ips list` should show a **shared** IPv4 and an IPv6 address only. A
   dedicated IPv4 costs extra and is not needed; if one is listed, remove it with
   `fly ips release <address>`.

8. **Check that the rate limits see your real address** (once, before relying on them). Deploy once with
   debug logging, send a request with forged headers, and look at the `client address` log line:

   ```sh
   fly deploy --env LOG_LEVEL=debug
   curl -s -H 'Fly-Client-IP: 203.0.113.9' -H 'X-Forwarded-For: 203.0.113.9' https://<app>.fly.dev/api/health
   fly logs --no-tail | grep 'client address'
   fly deploy                # back to LOG_LEVEL=info from fly.toml
   ```

   The `ip` in the line for your request must be your own public address (IPv4 or IPv6), never
   `203.0.113.9` and never a Fly-internal address (`fdaa:…`). If it shows `203.0.113.9`, Fly passed the
   forged header through: the per-IP rate limits could then be dodged, so do not rely on them (and do
   not open signup) until that is solved.

Day to day:

- **Update** to newer code: `git pull`, then `fly deploy`. Keep your changes to `fly.toml` (app name,
  region, a raised quota) committed, so `git pull` merges them with upstream changes to the file.
- **Logs**: `fly logs` (follows; `--no-tail` prints the recent lines and exits). **Status**: `fly status`.
- **Commands inside the machine** run over `fly ssh console`, which logs in as **root**. Always put
  `setpriv --reuid=1000 --regid=1000 --clear-groups` in front, so the command runs as the app user and
  every file it writes stays owned by uid 1000 (`backup:offsite` and `restore:offsite` refuse to run as root). The
  `--prefix /app/apps/server` makes npm find the app wherever the session starts. For example, to reset
  a password (`--pty` because it prompts for the new password):

  ```sh
  fly ssh console --pty -C "setpriv --reuid=1000 --regid=1000 --clear-groups npm --prefix /app/apps/server run reset-password -- you@example.com"
  ```

- **Growing the volume**: attachments may use at most `UPLOAD_QUOTA_MB` (400 MB in `fly.toml`) per
  account. The quota stays at most **40% of the volume**, because restoring a backup needs room for the
  old and the restored files side by side. The quota is per account, so this assumes one account: with
  more (`ALLOW_SIGNUP=true`), keep quota × accounts under 40%. To allow more, extend the volume first,
  then raise the quota (2 GB → at most 819, 3 GB → at most 1228), and set `initial_size` in `fly.toml`
  to the new size too so the file (and its test) stay consistent. The daily off-site backup builds its
  snapshot (database + gzipped attachments) in the machine's temporary directory, outside the volume,
  so a much larger quota also has to fit there:

  ```sh
  fly volumes list                                   # shows the volume's id (vol_…)
  fly volumes extend <volume-id> --size 2            # new size in GB; it can only grow
  # in fly.toml: UPLOAD_QUOTA_MB = "819" under [env], initial_size = "2gb" under [mounts]
  fly deploy
  ```

- **Fly volume snapshots**: Fly takes a snapshot of the volume every day and keeps it for 5 days by
  default. List them with `fly volumes snapshots list <volume-id>`; keep them longer with
  `fly volumes update <volume-id> --snapshot-retention 14` (days). A snapshot is restored into a new
  volume (`fly volumes create notes_data --snapshot-id <snapshot-id> --region <region>`; see Fly's
  documentation on volume snapshots for attaching it). They are the quick same-provider rollback; they
  disappear with the Fly app or account, which is what the off-site backups below are for.

## Off-site backups to Cloudflare R2

When the `BACKUP_S3_*` settings are set, the server uploads a backup of all notes and attachments to a
[Cloudflare R2](https://developers.cloudflare.com/r2/) bucket once a day: the same consistent snapshot as
`npm run backup` (`notes.db` + `uploads.tar.gz`) plus a `manifest.json` with each file's size and
SHA-256. R2's free tier includes 10 GB of storage and no download fees. This works on Fly.io and with
Docker Compose alike.

**The backups are not encrypted by the app.** Anyone holding the R2 API token (or access to your
Cloudflare account) can read every note. Keep the token private, give it access to this one bucket
only, and keep `SESSION_SECRET` and `SHARE_HMAC_KEY` in your password manager (a restore into a new app
needs the same `SHARE_HMAC_KEY` for expiring share links to keep working).

### Set it up

1. **Create the bucket**: Cloudflare dashboard → **R2 Object Storage** → **Create bucket**. Pick a name
   (3-63 lowercase letters, digits, `-` and `.`, e.g. `notes-backups-jane`) and keep the default
   location. **Do not add a lifecycle rule** that deletes old objects: the app prunes old backups itself,
   and only after a newer backup uploaded successfully (an age-only rule would delete every backup once
   uploads had been failing long enough).
2. **Create an API token**: on the R2 overview page, **Manage API tokens** → **Create API token** →
   permission **Object Read & Write**, **Apply to specific buckets only** → your bucket → **Create**.
   Copy the **Access Key ID** and the **Secret Access Key** (shown only once) and the S3 endpoint
   `https://<account-id>.r2.cloudflarestorage.com` (the account id is also on the R2 overview page). Use
   the endpoint without any `/<bucket>` path after it.
3. **Hand the settings to the app.** On Fly.io (this restarts the machine):

   ```sh
   fly secrets set BACKUP_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
     BACKUP_S3_BUCKET=<bucket> BACKUP_S3_ACCESS_KEY_ID=<access-key-id> BACKUP_S3_SECRET_ACCESS_KEY=<secret-access-key>
   ```

   With Docker Compose, put the same four lines into `.env` and restart the app (`up -d`). Use a separate
   bucket, or a different `BACKUP_S3_PREFIX`, for each installation: two apps writing to the same folder
   would prune each other's backups.

   All four must be set (only some of them → the app refuses to start and names the missing ones). The
   optional settings `BACKUP_KEEP_DAYS`, `BACKUP_INTERVAL_HOURS`, `BACKUP_S3_PREFIX` and
   `BACKUP_S3_REGION` are in the [Configuration](#configuration) table; on Fly set them the same way
   (e.g. `fly secrets set BACKUP_KEEP_DAYS=60`).

4. **Test it now** instead of waiting for the first scheduled run. On Fly.io:

   ```sh
   fly ssh console -C "setpriv --reuid=1000 --regid=1000 --clear-groups npm --prefix /app/apps/server run backup:offsite"
   ```

   With Docker Compose: `docker compose -f docker-compose.yml -f compose.direct.yml exec app npm run backup:offsite`.
   It prints `Off-site backup notes-backup-<timestamp> uploaded to <bucket>/notes-backups/notes-backup-<timestamp>/ (…)`.
   A manual run neither moves the daily schedule nor prunes anything.

### How it runs and where to look

- At startup the log says `off-site backups on` (endpoint host, bucket, folder) or
  `off-site backups off (BACKUP_S3_* not set)`.
- One minute after start and then every hour, the server checks whether the last successful scheduled
  upload is at least `BACKUP_INTERVAL_HOURS` (24) old, and if so makes one. The time of the last success
  is kept in `/data/offsite-backup.json`, so a restart does not cause an extra backup. A failed upload is
  logged and retried at the next hourly check; what that run had already uploaded is deleted again
  (its `manifest.json` first, so a failed run never leaves a folder that looks complete).
- While the app holds no notes, folders or attachments yet (a fresh install, e.g. one you are about to
  restore into), no backup is made (`offsite backup skipped: no notes, folders or attachments yet`, logged
  once): empty backups would push real ones out of the newest 7 that are always kept.
- Log lines (`fly logs` on Fly): `offsite backup uploaded` (with the backup name and sizes),
  `offsite backup failed` (with the error), `old offsite backups pruned` (with the deleted names).
- In the bucket (Cloudflare dashboard → R2 → your bucket), each backup is a folder
  `notes-backups/notes-backup-YYYYMMDD-HHMMSS/` (the time is UTC) holding `uploads.tar.gz`, `notes.db`
  and `manifest.json`. `manifest.json` is uploaded last: a folder without it is an unfinished upload and
  cannot be restored.
- **Retention**: after each successful scheduled upload, backups older than `BACKUP_KEEP_DAYS` (30) are
  deleted, but the newest 7 complete backups are always kept, however old; unfinished uploads older
  than a day are deleted too. Every backup is a full copy, so the bucket holds about
  `BACKUP_KEEP_DAYS` × the size of one backup: keep that under 10 GB to stay in R2's free tier.

## Restore on Fly.io

A restore replaces **all** notes, attachments and accounts with the backup's. It runs in two steps: a
command downloads and verifies the backup while the app keeps running, and the next restart swaps it in.

1. **Pick the backup**: in the Cloudflare dashboard, open the bucket's `notes-backups/` folder and choose
   a `notes-backup-YYYYMMDD-HHMMSS` folder that contains `manifest.json` (usually the newest; the names
   are UTC times).
2. **Stage it** (the `BACKUP_S3_*` secrets must be set on the app):

   ```sh
   fly ssh console -C "setpriv --reuid=1000 --regid=1000 --clear-groups npm --prefix /app/apps/server run restore:offsite -- notes-backup-YYYYMMDD-HHMMSS"
   ```

   It downloads the backup into `/data/restore-staging/`, checks every file's size and SHA-256 against
   the manifest and the database's integrity, unpacks the attachments, and only when everything checks
   out moves it to `/data/restore/` and prints `Backup … is verified and staged`. On any problem it
   prints why, removes what it downloaded, and the live data is untouched. Changes made in the app
   after this step are lost once the restore is applied. Only one `restore:offsite` runs at a time; if
   the ssh session drops mid-download, just run it again (a half-finished `/data/restore-staging/` is
   also removed at the next start; if it cannot be, for example because another user owns it, the app
   still starts and logs `restore: could not remove …`: delete that directory by hand).

   **Free space**: the volume must have room for the backup's database and attachments next to the live
   data, plus 10%. If not, the command refuses and says how much is needed: extend the volume
   (`fly volumes extend <volume-id> --size <GB>`, see [Growing the volume](#deploying-to-flyio)) and run
   it again.

3. **Restart the app** to apply it:

   ```sh
   fly machine list                      # shows the machine's id
   fly machine restart <machine-id>
   fly logs --no-tail | grep restore     # "restore: backup notes-backup-… is now the live data (…)"
   ```

   At startup, before the database opens, the server moves the current `notes.db` (with its WAL files)
   and `uploads/` aside into `/data/restore-previous/`, moves the restored ones into place, and deletes
   the old data only once everything is in place. If the machine stops in the middle, the next start
   finishes the same swap. Sign in again if the app asks you to.

**Cancelling a restore** (staged but not applied yet, or a restart that fails with
`Applying the staged restore failed …`, in which case the app does not start):

```sh
fly secrets set RESTORE_ABORT=1    # restarts the machine: a swap in progress is rolled back, the staged restore is deleted
fly logs --no-tail | grep RESTORE_ABORT   # "RESTORE_ABORT: discarded the staged restore of notes-backup-…; the previous data stays live"
fly secrets unset RESTORE_ABORT    # restarts again, normally
```

Do not leave `RESTORE_ABORT` set: while it is set, any restore you stage is thrown away at the next start
(and every start logs a reminder to unset it). Only one restore can be staged at a time: staging another
one is refused until the first is applied or cancelled.

**Restoring into a new Fly app** (the old app or account is gone): follow
[Deploying to Fly.io](#deploying-to-flyio) with the `SESSION_SECRET` and `SHARE_HMAC_KEY` from your
password manager, sign up (the restore replaces that account), set the `BACKUP_S3_*` secrets as in
[Set it up](#set-it-up), then stage and apply the backup as above. Do not create notes or folders in
the new app before the restore: an empty app uploads no backups, so the bucket's newest backups stay
the old app's until the restored data takes over. Expiring share links keep working with the same
`SHARE_HMAC_KEY`, but links already sent point at the old app's address; share new ones.

### Restore from R2 with Docker Compose or without Docker

The same two steps work wherever the app runs. With Docker Compose (the `BACKUP_S3_*` settings in
`.env`, the app running; use the `-f` override of your deployment in place of `compose.direct.yml`):

```sh
docker compose -f docker-compose.yml -f compose.direct.yml exec app npm run restore:offsite -- notes-backup-YYYYMMDD-HHMMSS
docker compose -f docker-compose.yml -f compose.direct.yml restart app
docker compose -f docker-compose.yml -f compose.direct.yml logs app | grep restore   # "restore: backup … is now the live data"
```

To cancel, add `RESTORE_ABORT=1` to `.env` and run `docker compose … up -d`; check the logs for
`RESTORE_ABORT: discarded the staged restore`, then remove the line and run `up -d` again.

Without Docker, run the command with the server's environment (`set -a; . ./.env; set +a`, after
`npm run build -w apps/server` once) as the user the server runs as, then restart the server:
`npm run restore:offsite -- notes-backup-YYYYMMDD-HHMMSS`. Cancel by starting the server once with
`RESTORE_ABORT=1`. The free-space rule above applies to the disk holding `DATA_DIR`.

### Moving local notes to Fly.io

To move notes from a local Docker Compose install into a new Fly app, upload one off-site backup from the
local container, then restore it on Fly. The R2 settings go only to that one command (not into `.env`),
so the local app does not start its own daily backups into the same folder:

```sh
# on the machine running Docker Compose, in the repository directory
export BACKUP_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com BACKUP_S3_BUCKET=<bucket>
read -rs BACKUP_S3_ACCESS_KEY_ID        # paste the Access Key ID, press Enter (not shown, not in history)
read -rs BACKUP_S3_SECRET_ACCESS_KEY    # paste the Secret Access Key, press Enter
export BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
# `-e NAME` without a value passes the exported value, so the secret never appears on a command line
docker compose -f docker-compose.yml -f compose.direct.yml exec \
  -e BACKUP_S3_ENDPOINT -e BACKUP_S3_BUCKET -e BACKUP_S3_ACCESS_KEY_ID -e BACKUP_S3_SECRET_ACCESS_KEY \
  app npm run backup:offsite
```

It prints the backup's name. Then, with the Fly app deployed using the **same** `SESSION_SECRET` and
`SHARE_HMAC_KEY` as the local `.env` (so expiring share links stay valid) and the `BACKUP_S3_*`
secrets set, run steps 2 and 3 of [Restore on Fly.io](#restore-on-flyio) with that name. Use the `-f`
override of your local deployment in place of `compose.direct.yml`. Share links already sent point at
the local install's address (its `PUBLIC_ORIGIN`), not `https://<app>.fly.dev`: share new ones.

## Backup and restore

All state is the data directory (`/data` in the container: the SQLite database `notes.db` and the
`uploads/` folder) plus the secrets in `.env`. Keep a copy of `.env` with your backups: without the same
`SHARE_HMAC_KEY`, restored expiring share links stop working (see [Moving to another server](#moving-to-another-server)).
Backups stay on the machine that made them, so copy them elsewhere too (another disk, cloud storage),
or let the app upload one every day ([off-site backups](#off-site-backups-to-cloudflare-r2)).

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
