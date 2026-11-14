#!/usr/bin/env bash
# Build the Windows portable folder locally on Linux (no GitHub Actions).
#
# Requires: bun, rustup with the x86_64-pc-windows-msvc target, cargo-xwin,
# clang/clang-cl, lld, llvm-rc/llvm-lib on PATH (LLVM 18+ from apt is enough).
# First run compiles every crate (~10-20 min); after that it is ~1 minute.
#
# Output: dist-portable/Outpeek/ (exe only; uses the machine WebView2)
#         dist-portable/outpeek-portable-windows-x64.zip
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
TARGET=x86_64-pc-windows-msvc
OUT="$ROOT/dist-portable"
STAGE="$OUT/Outpeek"
export PATH="$HOME/.cargo/bin:/usr/local/bin:$PATH"

# 1. Frontend (tauri's generate_context! embeds dist/, so this must be current).
echo "== frontend =="
bun run build:ui

# 2. Pinned WebView2 fixed runtime (official Microsoft CAB, ~679 MB).
echo "== webview2 runtime =="
bun scripts/fetch-webview2.mjs

# 3. Rust. custom-protocol is REQUIRED: without it the binary does not embed the
#    frontend and tries to reach the dev server at runtime.
echo "== cargo xwin build =="
(cd src-tauri && cargo xwin build --release --target "$TARGET" --features tauri/custom-protocol)

EXE="$ROOT/src-tauri/target/$TARGET/release/outpeek.exe"
[ -f "$EXE" ] || { echo "missing $EXE" >&2; exit 1; }

# 4. Stage the portable layout. Tauri resolves the runtime relative to the exe,
#    so the app uses the machine WebView2.
echo "== stage =="
rm -rf "$OUT"
mkdir -p "$STAGE"
cp "$EXE" "$STAGE/outpeek.exe"
cp -r "$ROOT/src-tauri/webview2-runtime" "$STAGE/webview2-runtime"

# 5. Optional Authenticode signature (same certificate CI uses).
PFX="$HOME/backups/recon/signing/recon-local.pfx"
PASSFILE="$HOME/backups/recon/signing/pfx.pass"
if [ -f "$PFX" ] && [ -f "$PASSFILE" ] && command -v osslsigncode >/dev/null; then
  echo "== sign =="
  osslsigncode sign -pkcs12 "$PFX" -pass "$(cat "$PASSFILE")" \
    -n "Outpeek" -i "https://github.com/youssefvdel/Recon" \
    -h sha256 -ts http://timestamp.digicert.com \
    -in "$STAGE/outpeek.exe" -out "$STAGE/outpeek.signed.exe"
  mv "$STAGE/outpeek.signed.exe" "$STAGE/outpeek.exe"
  osslsigncode verify -in "$STAGE/outpeek.exe" 2>&1 | grep -m1 "Subject:" || true
else
  echo "== sign: skipped (no local pfx) =="
fi

# 6. Zip: top folder must be Outpeek/ so unzip-and-run works.
echo "== zip =="
(cd "$OUT" && rm -f outpeek-portable-windows-x64.zip && zip -qr outpeek-portable-windows-x64.zip Outpeek)

echo
echo "done:"
ls -la "$STAGE"
sha256sum "$OUT/outpeek-portable-windows-x64.zip"
