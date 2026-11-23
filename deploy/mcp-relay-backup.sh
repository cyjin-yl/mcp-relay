#!/bin/sh
set -eu

DB=/var/lib/mcp-relay/relay.sqlite
DEST=/var/backups/mcp-relay

install -d -m 700 -o root -g root "$DEST"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DEST/relay-$STAMP.sqlite"

python3 - "$DB" "$OUT" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
dst = sqlite3.connect(sys.argv[2])
try:
    src.backup(dst)
finally:
    dst.close()
    src.close()
PY
chmod 600 "$OUT"

python3 - "$OUT" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
try:
    result = db.execute("PRAGMA integrity_check").fetchone()[0]
finally:
    db.close()
if result != "ok":
    raise SystemExit(f"integrity_check failed: {result}")
PY

find "$DEST" -type f -name 'relay-*.sqlite' -mtime +14 -delete
echo "backup ok: $OUT"
