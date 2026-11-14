// Pure source-grep guards that must never regress. No runtime, no Tauri, no
// network: each block reads the source it protects and asserts on the text.
//
//   1. Cooldown chrome: the TRN mechanism (serial gate, jitter, ladder,
//      fail-fast) runs silently — prod UI shows no countdowns, seconds, or
//      rate-limit jargon. The stats on/off setting pill and all dev-only
//      readouts stay. (TRN is a cold fallback: no countdown chrome.)
//   2. Pre-pick hover-only: hovering an agent is fine, locking one is not
//      (AGENTS.md safety rule). The Pre-Picker must NEVER call the Riot lock
//      route or read CharacterSelectionState.
//
//   bun scripts/guards-check.ts
//
// Merged from cooldown-chrome-check.ts and prepick-hover-only-check.ts — same
// assertions, one process. Bun is not the target; this is a text guard.
export {};

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (ok) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

/* ===================== cooldown chrome ===================== */

const topbar = await Bun.file('src/components/TopBar.tsx').text();
const overview = await Bun.file('src/components/Overview.tsx').text();

// --- removed chrome stays removed ---
check('no TRN Cooling pill', topbar.includes('TRN Cooling'), false);
check('no cooling-seconds state', topbar.includes('trnCoolingSec'), false);
check('no rate-limited message', overview.includes('rate-limited us'), false);
check('no retrying-in countdown', overview.includes('retrying'), false);

// --- kept surfaces stay ---
check('stats setting pill kept', topbar.includes('Stats off') || topbar.includes('Stats on'), true);
check('past-act Retry kept', overview.includes('Retry'), true);

/* ===================== pre-pick hover-only ===================== */

const prepickSrc = readFileSync(join(import.meta.dir, '..', 'src', 'utils', 'prepick.ts'), 'utf8');

// Match the Riot route shape only — a bare `lock` (or `/lockfile`) must not trip this.
check(
  'prepick never calls the Riot pregame lock route',
  /pregame\/v1\/matches\/[^'"`]*\/lock\//.test(prepickSrc),
  false
);
check(
  'prepick never reads CharacterSelectionState (lock-guard remnant)',
  /CharacterSelectionState/.test(prepickSrc),
  false
);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All guard checks passed.');
