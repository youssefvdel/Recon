// Assemble latest.json for the Tauri updater from the signed release artifacts.
// Node port of scripts/make-latest-json.sh (python is not installed on this box).
// The Windows payload is the NSIS setup.exe (Tauri signs it directly).
// Usage: node scripts/make-latest-json.mjs <version> [notes-file] [out-file]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export const DEFAULT_BASE_URL = 'https://github.com/youssefvdel/Outpeek';
export const DEFAULT_NOTES = 'See the release page for details.';

/** NSIS setup.exe name Tauri produces for a version. */
export function setupExeName(version) {
  return `Outpeek_${version}_x64-setup.exe`;
}

/**
 * Build the updater manifest. Pure — no filesystem, no ambient clock (pubDate
 * is injectable) — so the shape is testable without a signed bundle on disk.
 * `signature` is the .sig file CONTENTS, not a path: the updater verifies the
 * bytes it downloads.
 */
export function buildManifest({
  version,
  notes,
  signature,
  exeName,
  baseUrl = DEFAULT_BASE_URL,
  pubDate = new Date(),
}) {
  if (!version) throw new Error('buildManifest: version is required');
  if (!signature) throw new Error('buildManifest: signature is required (file contents, not a path)');
  return {
    version,
    notes: notes ?? DEFAULT_NOTES,
    pub_date: pubDate.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms: {
      'windows-x86_64': {
        signature,
        url: `${baseUrl.replace(/\/+$/, '')}/releases/download/v${version}/${exeName ?? setupExeName(version)}`,
      },
    },
  };
}

function writeManifest(argv) {
  const v = argv[2];
  if (!v) {
    console.error('usage: make-latest-json.mjs <version> [notes-file] [out-file]');
    process.exit(1);
  }
  const notesFile = argv[3];
  const out = argv[4] || join(tmpdir(), 'latest.json');

  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const nsis = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const exeName = setupExeName(v);
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
  // Absent notes file falls back inside buildManifest; an empty one stays empty.
  const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : undefined;

  const manifest = buildManifest({ version: v, notes, signature, exeName });

  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('wrote', out);
  console.log(JSON.stringify(manifest, null, 2));
}

// Only act when run as a script: importing for tests must not touch the disk.
const invokedDirectly =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) writeManifest(process.argv);
