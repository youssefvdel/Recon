#!/usr/bin/env bash
# Assemble latest.json for the Tauri updater from the signed release artifacts.
# The Windows payload is the NSIS setup.exe (Tauri signs it directly).
set -euo pipefail

V="${1:?usage: make-latest-json.sh <version> [notes-file]}"
NOTES_FILE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NSIS="$ROOT/src-tauri/target/release/bundle/nsis"
EXE_NAME="Outpeek_${V}_x64-setup.exe"
SIG_FILE="$NSIS/${EXE_NAME}.sig"

[ -f "$NSIS/$EXE_NAME" ] || { echo "missing $NSIS/$EXE_NAME" >&2; exit 1; }
[ -f "$SIG_FILE" ] || { echo "missing signature $SIG_FILE — was the build signed?" >&2; exit 1; }

OUT="${TMPDIR:-/tmp}/latest.json"
NOTES="$(cat "$NOTES_FILE" 2>/dev/null || echo "See the release page for details.")"

# Signature must be the file CONTENTS, not a path. Pass it through the
# environment: native Python on Windows cannot open MSYS-style /c/... paths.
RECON_SIG="$(cat "$SIG_FILE")" \
python - "$V" "$EXE_NAME" "$NOTES" "$(cygpath -w "$OUT" 2>/dev/null || echo "$OUT")" <<'PY'
import json, sys, os, datetime
version, exe_name, notes, out = sys.argv[1:5]
sig = os.environ["RECON_SIG"].strip()
manifest = {
    "version": version,
    "notes": notes,
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {
        "windows-x86_64": {
            "signature": sig,
            "url": f"https://github.com/youssefvdel/Recon/releases/download/v{version}/{exe_name}",
        }
    },
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)
print("wrote", out)
PY

cat "$OUT"
