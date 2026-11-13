#!/usr/bin/env bash
# Docker image check (`npm run test:docker`): builds the image under its own tag and runs it with
# throwaway containers and volumes, never touching the Compose project `notes-app`, its image
# `notes-app:latest` or its volume `notes-app_notes-data`.
#
#   (a) Fly-like: a truly root-owned empty volume (`volume-nocopy`, so Docker does not copy the image's
#       1000-owned /data into it), container started as root -> the entrypoint chowns /data to
#       1000:1000 and the server runs as uid 1000 and answers /api/health
#   (b) Compose-like: `--user 1000:1000` on a normal named volume -> starts, /data stays 1000:1000
#   (c) a file created through `docker exec` in (b) is owned by 1000
#
# Set KEEP_IMAGE=1 to keep the `notes-app:docker-check` image afterwards (it is removed by default;
# the build cache keeps rebuilds fast either way).
set -euo pipefail

IMAGE="notes-app:docker-check"
PREFIX="notes-app-check-$$"
FLY_VOLUME="$PREFIX-fly"
FLY_CONTAINER="$PREFIX-fly"
COMPOSE_VOLUME="$PREFIX-compose"
COMPOSE_CONTAINER="$PREFIX-compose"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# throwaway values: the server refuses to boot without them (secrets must be >= 32 characters)
APP_ENV=(
  -e "SESSION_SECRET=docker-check-session-secret-0123456789abcdef"
  -e "SHARE_HMAC_KEY=docker-check-share-hmac-key-0123456789abcdef"
  -e "PUBLIC_ORIGIN=http://localhost:3000"
)

cleanup() {
  docker rm -f "$FLY_CONTAINER" "$COMPOSE_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm -f "$FLY_VOLUME" "$COMPOSE_VOLUME" >/dev/null 2>&1 || true
  if [ "${KEEP_IMAGE:-}" != "1" ]; then
    docker image rm "$IMAGE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "ok: $*"
}

# assert_eq <actual> <expected> <what>
assert_eq() {
  if [ "$1" != "$2" ]; then
    fail "$3: expected '$2', got '$1'"
  fi
  pass "$3 = $2"
}

# wait_healthy <container>: polls /api/health from inside the container for up to 60 s
wait_healthy() {
  local container="$1" i
  for i in $(seq 1 60); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]; then
      docker logs "$container" >&2 || true
      fail "$container exited before answering /api/health"
    fi
    if docker exec "$container" node -e \
      "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
      >/dev/null 2>&1; then
      pass "$container answers /api/health"
      return 0
    fi
    sleep 1
  done
  docker logs "$container" >&2 || true
  fail "$container did not answer /api/health within 60 s"
}

# server_uid <container>: real uid of PID 1 (the server, after the entrypoint's exec chain)
server_uid() {
  docker exec "$1" awk '/^Uid:/ { print $2 }' /proc/1/status
}

echo "== building $IMAGE"
docker build -q -t "$IMAGE" "$REPO_ROOT" >/dev/null

echo "== (a) Fly-like: root-owned empty volume, started as root"
docker volume create "$FLY_VOLUME" >/dev/null
FLY_MOUNT="type=volume,src=$FLY_VOLUME,dst=/data,volume-nocopy"
assert_eq "$(docker run --rm --user 0:0 --entrypoint stat --mount "$FLY_MOUNT" "$IMAGE" -c %u:%g /data)" \
  "0:0" "fresh volume owner before start"
docker run -d --name "$FLY_CONTAINER" --user 0:0 --mount "$FLY_MOUNT" "${APP_ENV[@]}" "$IMAGE" >/dev/null
wait_healthy "$FLY_CONTAINER"
assert_eq "$(docker exec "$FLY_CONTAINER" stat -c %u:%g /data)" "1000:1000" "(a) /data owner"
assert_eq "$(server_uid "$FLY_CONTAINER")" "1000" "(a) server process uid"
assert_eq "$(docker exec "$FLY_CONTAINER" stat -c %u:%g /data/notes.db)" "1000:1000" "(a) notes.db owner"

echo "== (b) Compose-like: --user 1000:1000 on a normal named volume"
docker volume create "$COMPOSE_VOLUME" >/dev/null
docker run -d --name "$COMPOSE_CONTAINER" --user 1000:1000 -v "$COMPOSE_VOLUME:/data" "${APP_ENV[@]}" "$IMAGE" >/dev/null
wait_healthy "$COMPOSE_CONTAINER"
assert_eq "$(docker exec "$COMPOSE_CONTAINER" stat -c %u:%g /data)" "1000:1000" "(b) /data owner"
assert_eq "$(server_uid "$COMPOSE_CONTAINER")" "1000" "(b) server process uid"

echo "== (c) a file created through docker exec in (b)"
docker exec "$COMPOSE_CONTAINER" touch /data/exec-check
assert_eq "$(docker exec "$COMPOSE_CONTAINER" stat -c %u /data/exec-check)" "1000" "(c) docker exec file owner"

echo "docker image check passed"
