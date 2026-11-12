# syntax=docker/dockerfile:1
# Notes App: one container serving the API and the built SPA; all state lives in the /data volume.
#
#   build      — full install, builds the web app (Vite) and compiles the server (tsc) to JavaScript
#   prod-deps  — production dependencies of the server only (native modules built for this image)
#   runtime    — node:22-slim, non-root uid/gid 1000, plain `node` (no tsx or other dev tooling)

ARG NODE_IMAGE=node:22-slim

# Toolchain for native modules (better-sqlite3, argon2) in case no prebuilt binary matches.
FROM ${NODE_IMAGE} AS native-toolchain
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

FROM native-toolchain AS build
RUN npm ci
COPY tsconfig.base.json ./
COPY apps/server apps/server
COPY apps/web apps/web
RUN npm run build

FROM native-toolchain AS prod-deps
RUN npm ci --omit=dev --workspace apps/server --include-workspace-root=false \
 && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
# the image's built-in `node` user is uid/gid 1000; /data is created owned by it so a fresh named
# volume inherits that ownership (a bind mount must be chowned to 1000:1000 on the host instead)
RUN test "$(id -u node):$(id -g node)" = "1000:1000" \
 && mkdir -p /data \
 && chown 1000:1000 /data
COPY --from=prod-deps /app/node_modules node_modules
COPY package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
USER 1000:1000
WORKDIR /app/apps/server
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/index.js"]
