// Assemble latest.json for the Tauri updater from the signed release artifacts.
// Node port of scripts/make-latest-json.sh (python is not installed on this box).
// The Windows payload is the NSIS setup.exe (Tauri signs it directly).
// Usage: node scripts/make-latest-json.mjs <version> [notes-file] [out-file]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const v = process.argv[2];
if (!v) {
  console.error('usage: make-latest-json.mjs <version> [notes-file] [out-file]');
  process.exit(1);
}
const notesFile = process.argv[3];
const out = process.argv[4] || join(tmpdir(), 'latest.json');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nsis = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const exeName = `Recon_${v}_x64-setup.exe`;
const sigFile = join(nsis, `${exeName}.sig`);

if (!existsSync(join(nsis, exeName))) {
  console.error(`missing ${join(nsis, exeName)}`);
  process.exit(1);
}
if (!existsSync(sigFile)) {
  console.error(`missing signature ${sigFile} — was the build signed?`);
  process.exit(1);
}

// Signature must be the file CONTENTS, not a path.
const signature = readFileSync(sigFile, 'utf8').trim();
const notes =
  notesFile && existsSync(notesFile)
    ? readFileSync(notesFile, 'utf8')
    : 'See the release page for details.';

const manifest = {
  version: v,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/youssefvdel/Recon/releases/download/v${v}/${exeName}`,
    },
  },
};

writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log('wrote', out);
console.log(JSON.stringify(manifest, null, 2));
