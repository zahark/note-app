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
