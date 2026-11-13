#!/bin/sh
# Container entrypoint. The server always runs as uid/gid 1000 (the image's `node` user).
#
# Started as root (e.g. Fly.io, which mounts its volumes root-owned and empty): make sure DATA_DIR
# itself is owned by 1000:1000 (top directory only, and only when it is not), then drop to 1000:1000
# with setpriv. Started as any other user (Docker Compose sets `user: "1000:1000"`): run the command
# unchanged.
set -eu

if [ "$(id -u)" = "0" ]; then
  data_dir="${DATA_DIR:-/data}"
  mkdir -p "$data_dir"
  if [ "$(stat -c %u:%g "$data_dir")" != "1000:1000" ]; then
    chown 1000:1000 "$data_dir"
  fi
  exec setpriv --reuid=1000 --regid=1000 --clear-groups -- "$@"
fi

exec "$@"
