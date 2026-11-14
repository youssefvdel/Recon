// Single entry point for the app version.
// Usage: npm run bump -- 0.3.0
// Syncs package.json (frontend + Tauri bundle via "../package.json") and
// src-tauri/Cargo.toml (Rust updater reads it via env!("CARGO_PKG_VERSION")).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const v = process.argv[2];

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v ?? '')) {
  console.error('Usage: npm run bump -- <semver>   e.g. npm run bump -- 0.3.0');
  process.exit(1);
}

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = v;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const cargoPaths = [join(root, 'src-tauri', 'Cargo.toml'), join(root, 'recon-overlay', 'Cargo.toml')];
for (const cargoPath of cargoPaths) {
  const cargoOrig = readFileSync(cargoPath, 'utf8');
  if (!/^version = ".*"$/m.test(cargoOrig)) {
    console.error(`${cargoPath}: no version line matched, left untouched`);
    process.exit(1);
  }
  writeFileSync(cargoPath, cargoOrig.replace(/^version = ".*"$/m, `version = "${v}"`));
}

console.log(`Bumped to ${v}: package.json + src-tauri/Cargo.toml + recon-overlay/Cargo.toml (tauri.conf follows package.json)`);
