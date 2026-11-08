// Fetch the pinned WebView2 Fixed Runtime from NuGet and verify it is Microsoft's.
//
// Usage: bun scripts/fetch-webview2.mjs [version]
// Env:   WEBVIEW2_NUPKG_PATH  reuse an already-downloaded .nupkg (offline/CI cache)
//
// Writes src-tauri/webview2-runtime/ (flat: msedgewebview2.exe is directly inside).
// Idempotent: exits early when that folder already holds the requested version.
// Fails loudly (exit 1) when the payload is missing or not Microsoft-signed.
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_VERSION = '157.0.4341.42';
const version = process.argv[2] || process.env.WEBVIEW2_VERSION || DEFAULT_VERSION;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'src-tauri', 'webview2-runtime');
const marker = join(target, '.version');
const exeName = 'msedgewebview2.exe';

function fail(message) {
  console.error(`fetch-webview2: ${message}`);
  process.exit(1);
}

function hubUrl(v) {
  return `https://api.nuget.org/v3-flatcontainer/webview2.runtime.x64/${v}/webview2.runtime.x64.${v}.nupkg`;
}

if (
  existsSync(join(target, exeName))
  && existsSync(marker)
  && readFileSync(marker, 'utf8').trim() === version
) {
  console.log(`fetch-webview2: ${version} already present — nothing to do`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'recon-webview2-'));
const nupkg = resolve(process.env.WEBVIEW2_NUPKG_PATH || join(tmp, `${version}.nupkg`));

if (!existsSync(nupkg)) {
  console.log(`fetch-webview2: downloading ${version} (~100 MB)`);
  const res = await fetch(hubUrl(version));
  if (!res.ok) fail(`download failed: HTTP ${res.status} ${hubUrl(version)}`);
  writeFileSync(nupkg, Buffer.from(await res.arrayBuffer()));
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) fail(`${cmd} could not run: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} exited ${r.status}\n${(r.stderr || r.stdout || '').trim()}`);
  return r;
}

const extractDir = join(tmp, 'extract');
mkdirSync(extractDir, { recursive: true });
if (process.platform === 'win32') {
  run('tar', ['-xf', nupkg, '-C', extractDir]);
} else {
  run('unzip', ['-q', '-o', nupkg, '-d', extractDir]);
}

function findExe(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findExe(path);
      if (found) return found;
    } else if (entry.name.toLowerCase() === exeName) {
      return path;
    }
  }
  return null;
}

const exe = findExe(extractDir);
if (!exe) fail(`no ${exeName} inside ${nupkg}`);

// The build must fail loudly when the payload is not Microsoft's. Windows (the
// CI path) checks the full Authenticode chain; Linux has no Microsoft roots in
// its local store, so there we prove the signature cryptographically and check
// the signer/issuer names, and say so in the output.
function verifyMicrosoft(exePath) {
  if (process.platform === 'win32') {
    const quote = (p) => `'${p.replace(/'/g, "''")}'`;
    const script = [
      '$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\\Windows Kits\\10\\bin\\*\\x64\\signtool.exe" | Sort-Object FullName -Descending | Select-Object -First 1',
      "if (-not $signtool) { Write-Output 'NO_SIGNTOOL'; exit 2 }",
      `& $signtool.FullName verify /pa /v ${quote(exePath)} 2>&1 | Out-String -Width 200 | Write-Output`,
      'exit $LASTEXITCODE',
    ].join('; ');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    if (r.error) fail(`powershell.exe could not run: ${r.error.message}`);
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (out.includes('NO_SIGNTOOL')) fail('signtool.exe not found in the Windows SDK');
    if (r.status !== 0) fail(`signtool verify /pa failed (exit ${r.status}):\n${out.trim().slice(0, 800)}`);
    if (!/Issued to:\s*Microsoft Corporation/.test(out)) fail('signer is not Microsoft Corporation');
    return 'Microsoft Corporation (signtool verify /pa)';
  }

  const r = spawnSync('osslsigncode', ['verify', '-in', exePath], { encoding: 'utf8' });
  if (r.error) {
    fail(`osslsigncode could not run (${r.error.message}); install it (apt install osslsigncode) — CI verifies on Windows instead`);
  }
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  // osslsigncode exits 1 offline because it has no Microsoft root; the digest
  // comparison below is what proves the bytes match the signature.
  const current = (out.match(/Current message digest\s*:\s*([0-9A-F]+)/i) || [])[1];
  const calculated = (out.match(/Calculated message digest\s*:\s*([0-9A-F]+)/i) || [])[1];
  if (!current || !calculated || current !== calculated) {
    fail('signature does not match the payload (digest mismatch) — do not trust this download');
  }
  if (!/Subject:\s*CN=Microsoft Corporation/.test(out)) fail('signer is not CN=Microsoft Corporation');
  if (!/Issuer\s*:\s*CN=Microsoft Code Signing PCA/.test(out)) fail('signer was not issued by Microsoft Code Signing PCA');
  if (!/Timestamp time:/i.test(out)) fail('payload is not timestamped');
  console.log('fetch-webview2: Linux check proves the signature + signer names; full chain trust is verified on Windows CI');
  return 'Microsoft Corporation (digest verified; chain trust checked on Windows CI)';
}

const signer = verifyMicrosoft(exe);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const sourceDir = dirname(exe);
for (const entry of readdirSync(sourceDir)) {
  cpSync(join(sourceDir, entry), join(target, entry), { recursive: true });
}
writeFileSync(marker, `${version}\n`);
rmSync(tmp, { recursive: true, force: true });

function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return n;
}

if (!existsSync(join(target, exeName))) fail(`copy produced no ${target}/${exeName} — extraction nested unexpectedly`);
console.log(`fetch-webview2: ${version} ready at src-tauri/webview2-runtime (${countFiles(target)} files; ${signer})`);
