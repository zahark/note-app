# Notes App

Self-hosted notes with nested folders, rich-text editing (TipTap) and secure sharing
(PIN-gated links or HMAC-signed expiring links). Runs as a single container: Fastify
serves the API and the built SPA, and all state lives in one data directory.

Status: under construction. See `docs/plans/20261112-notes-app.md` for the plan.

## Requirements

- Node.js 22+ (`node -v`). On macOS: `brew install node@22`.

## Layout

- `apps/server` — Fastify + TypeScript API (Vitest tests in `apps/server/test`)
- `apps/web` — React + Vite + Tailwind + shadcn/ui SPA (Vitest + Testing Library)

## Development

```sh
npm install
cp .env.example .env   # fill in the secrets
npm run dev            # server and web dev servers together (web proxies /api to :3000)
npm test               # all tests in both apps
npm run test:e2e       # Playwright smoke test (builds, then runs the compiled server on :3100 with a temp DATA_DIR;
                       # first time: npx playwright install chromium)
npm run lint           # ESLint + TypeScript type checks
npm run build          # production build of both apps
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
characters. Pick exactly one deployment override:

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
  set `client_max_body_size 12m;` for image uploads, and terminate TLS there
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
- `ALLOW_SIGNUP` defaults to `true`; on a public deployment set `ALLOW_SIGNUP=false` once the owner
  account (the first account created) exists.

Commands inside the container (from the same directory, with the same `-f` files):

```sh
docker compose -f docker-compose.yml -f compose.direct.yml exec app npm run reset-password -- you@example.com
docker compose -f docker-compose.yml -f compose.direct.yml exec app npm run backup
```

## Backup and restore

`npm run backup -- [outDir]` writes a consistent snapshot while the server keeps running:
`<outDir>/notes-backup-<UTC timestamp>/notes.db` (made with SQLite's online backup API, a standalone
file) and `uploads.tar.gz` (every uploaded image the database copy references, as `uploads/<name>`).
`outDir` defaults to `DATA_DIR/backups`; a relative `outDir` is relative to the directory you run the
command from.

```sh
npm run backup                                      # bare metal
docker compose -f docker-compose.yml -f compose.direct.yml exec app npm run backup
docker compose -f docker-compose.yml -f compose.direct.yml cp app:/data/backups ./backups
```

Backups made inside the container land in the `notes-data` volume (`/data/backups`); copy them off the
host as shown and delete old ones from time to time.

To restore, stop the app, then put the copy back into an empty data directory:

```sh
rm -f "$DATA_DIR"/notes.db-wal "$DATA_DIR"/notes.db-shm   # never mix a restored db with an old WAL
cp notes-backup-*/notes.db "$DATA_DIR/notes.db"
tar -xzf notes-backup-*/uploads.tar.gz -C "$DATA_DIR"   # recreates $DATA_DIR/uploads/
```

With Docker, do the same into the volume, e.g. with a one-off container:
`docker run --rm -v notes-app_notes-data:/data -v "$PWD/notes-backup-XXXX:/backup" --user 1000:1000 node:22-slim sh -c 'rm -f /data/notes.db-wal /data/notes.db-shm && cp /backup/notes.db /data/ && tar -xzf /backup/uploads.tar.gz -C /data'`.

## Password reset

There is no email reset. Signed-in users change their password in the app; an operator with shell
access to the server resets any account with:

```sh
npm run build -w apps/server                # once, if dist/ is not built yet
npm run reset-password -- you@example.com   # prompts twice for the new password, without echo
```

In Docker use `docker compose ... exec app npm run reset-password -- you@example.com` (see above).

It uses `DATA_DIR` (relative paths resolve against `apps/server`, like the server itself) and needs no
secrets. Both the reset and an in-app change revoke the account's other sessions and known devices.
