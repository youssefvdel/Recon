// Fetch Microsoft's OFFICIAL WebView2 fixed-version runtime and verify it.
//
// Why this exists: the NuGet package `webview2.runtime.x64` that we tried first
// is a third-party repack with 56 files instead of 257 — it ships
// `msedge.dll.sig` but NOT `msedge.dll` (357 MB), so WebView2 cannot start and
// the app dies at window creation with "Could not find the WebView2 Runtime".
// The official CAB from Microsoft is the only supported source.
//
// Usage: bun scripts/fetch-webview2.mjs [version]
// Env:   WEBVIEW2_CAB_PATH  reuse an already-downloaded .cab
//
// Writes src-tauri/webview2-runtime/ (flat; msedgewebview2.exe directly inside).
// Idempotent: skips when the folder already holds the pinned version.
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  writeFileSync, copyFileSync, statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = process.argv[2] || process.env.WEBVIEW2_VERSION || '157.0.4341.42';
const CAB_URL =
  `https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/` +
  `b7b22a57-b321-483e-9855-d260b076f1a7/Microsoft.WebView2.FixedVersionRuntime.${VERSION}.x64.cab`;
// SHA-256 of that exact CAB, published alongside this pin. A mismatch means a
// different (or corrupted) artifact and the build must stop.
const CAB_SHA256 =
  'cedaf8f3d12202c8803bdbae727b01c1be34540b78e8f0a10c6b401c2a8be97d';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'src-tauri', 'webview2-runtime');
const work = join(root, '.webview2-cache');
const cab = join(work, `webview2-${VERSION}.cab`);

// The real fixed runtime is ~257 files / 679 MB. These are the ones whose
// absence reproduces the shipped failure; assert them, not a file count.
const REQUIRED = [
  ['msedge.dll', 300_000_000],
  ['msedgewebview2.exe', 1_000_000],
  ['msedge_elf.dll', 1_000_000],
  ['icudtl.dat', 5_000_000],
  ['resources.pak', 20_000_000],
  ['v8_context_snapshot.bin', 100_000],
  ['Locales/en-US.pak', 100_000],
];

const fail = (m) => { console.error(`fetch-webview2: ${m}`); process.exit(1); };
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function haveRuntime() {
  const marker = join(target, '.version');
  if (!existsSync(marker)) return false;
  return readFileSync(marker, 'utf8').trim() === VERSION && existsSync(join(target, 'msedge.dll'));
}

function download() {
  mkdirSync(work, { recursive: true });
  if (existsSync(cab) && sha256(cab) === CAB_SHA256) {
    console.log(`fetch-webview2: using cached cab ${cab}`);
    return;
  }
  const reuse = process.env.WEBVIEW2_CAB_PATH;
  if (reuse && existsSync(reuse)) {
    copyFileSync(reuse, cab);
  } else {
    console.log(`fetch-webview2: downloading ${CAB_URL}`);
    const r = spawnSync('curl', ['-sSL', '--fail', '-o', cab, CAB_URL], { stdio: 'inherit' });
    if (r.status !== 0) fail('curl failed');
  }
  const got = sha256(cab);
  if (got !== CAB_SHA256) fail(`cab sha256 mismatch: ${got}`);
  console.log('fetch-webview2: cab sha256 verified');
}

function extract() {
  const out = join(work, 'x');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // `expand` ships with Windows; `7z`/`cabextract` cover the Linux dev box.
  const attempts = [
    ['expand', [cab, '-F:*', out]],
    ['7z', ['x', '-y', `-o${out}`, cab]],
    ['cabextract', ['-q', '-d', out, cab]],
  ];
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    if (r.status === 0 && readdirSync(out).length) return out;
  }
  fail('could not extract the cab (expand/7z/cabextract all failed)');
}

function install() {
  const out = extract();
  const inner = readdirSync(out).map((n) => join(out, n))
    .find((p) => statSync(p).isDirectory() && existsSync(join(p, 'msedgewebview2.exe')));
  if (!inner) fail('cab did not contain a runtime folder with msedgewebview2.exe');
  rmSync(target, { recursive: true, force: true });
  renameSync(inner, target);
  writeFileSync(join(target, '.version'), `${VERSION}\n`);
}

if (haveRuntime()) {
  console.log(`fetch-webview2: ${VERSION} already present — nothing to do`);
  process.exit(0);
}

download();
install();

for (const [name, min] of REQUIRED) {
  const p = join(target, name);
  if (!existsSync(p)) fail(`missing from the runtime: ${name}`);
  const size = statSync(p).size;
  if (size < min) fail(`${name} is only ${size} bytes (expected >= ${min}) — wrong or trimmed package`);
}
const files = readdirSync(target, { recursive: true }).length;
console.log(`fetch-webview2: ${VERSION} ready at src-tauri/webview2-runtime (${files} entries, msedge.dll ${statSync(join(target, 'msedge.dll')).size} B)`);
