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
npm run lint           # ESLint + TypeScript type checks
npm run build          # production build of both apps
```

## Password reset

There is no email reset. Signed-in users change their password in the app; an operator with shell
access to the server resets any account with:

```sh
npm run build -w apps/server                # once, if dist/ is not built yet
npm run reset-password -- you@example.com   # prompts twice for the new password, without echo
```

It uses `DATA_DIR` (relative paths resolve against `apps/server`, like the server itself) and needs no
secrets. Both the reset and an in-app change revoke the account's other sessions and known devices.
