// Guards the non-negotiable safety rule (AGENTS.md): hovering an agent is fine,
// locking one is not. The Pre-Picker must NEVER call the Riot lock route or read
// CharacterSelectionState. Catches regressions of the hover-only guarantee.
//
//   bun scripts/prepick-hover-only-check.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dir, '..', 'src', 'utils', 'prepick.ts'), 'utf8');

const failures: string[] = [];
// Match the Riot route shape only — a bare `lock` (or `/lockfile`) must not trip this.
if (/pregame\/v1\/matches\/[^'"`]*\/lock\//.test(src)) {
  failures.push('calls the Riot pregame lock route (pregame/v1/matches/.../lock/)');
}
if (/CharacterSelectionState/.test(src)) {
  failures.push('reads CharacterSelectionState (lock-guard remnant)');
}

if (failures.length) {
  console.error('PREPICK_HOVER_ONLY_FAIL: ' + failures.join('; '));
  process.exit(1);
}
console.log('PREPICK_HOVER_ONLY_PASS: pre-pick hovers only — no lock route, no CharacterSelectionState');
