#!/bin/sh
# Runs the server as an unprivileged user that owns the data folder. The container starts as root
# only to fix that folder's ownership, so a host folder (./data:/app/data, a NAS share) works as
# well as a named volume. PUID and PGID pick the user (default 1000, the image's "node" user).
set -e

DATA="${LOCALROCK_DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  mkdir -p "$DATA"
  # The folder holds a few small files, so this is cheap; it fails quietly where the host forbids it.
  chown -R "$PUID:$PGID" "$DATA" 2>/dev/null || true
  if ! su-exec "$PUID:$PGID" sh -c "touch '$DATA/.write-test' && rm -f '$DATA/.write-test'" 2>/dev/null; then
    echo "LocalRock Web can't write to $DATA as user $PUID:$PGID." >&2
    echo "Make that folder writable for that user on the host (for example: chown -R $PUID:$PGID <folder>)," >&2
    echo "or set PUID and PGID to the owner of the folder." >&2
    exit 1
  fi
  exec su-exec "$PUID:$PGID" "$@"
fi

# Started with --user: run as that user and rely on the folder being writable.
exec "$@"
