/* Honesty checks: a stat with no denominator must be absent, not invented.
 *
 *   bun scripts/honesty-check.ts
 *
 * Two layers:
 *   - behavioural: the helpers that replaced every fabricated fallback return
 *     null for a zero/absent denominator and "—" when rendered;
 *   - source: the exact fallback expressions that produced believable lies are
 *     gone. A regression that reintroduces one fails here even if it compiles.
 */
export {};

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { perRound, safeRatio, pctOf } from '../src/utils/absent.ts';
import { formatKd, formatPct } from '../src/utils/format.ts';
import { displayUnread } from '../src/utils/displayFacts.ts';

let failures = 0;
function check<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

/* ---- behavioural: the helpers refuse to divide by an absent denominator ---- */
check('perRound: no rounds is null, not /1', perRound(2300, 0), null);
check('perRound: absent total is null', perRound(undefined, 23), null);
check('perRound: normal case still divides', perRound(2300, 23), 100);

check('safeRatio: zero deaths is null, not the numerator', safeRatio(21, 0), null);
check('safeRatio: absent deaths is null', safeRatio(21, null), null);
check('safeRatio: normal case still divides', safeRatio(10, 4), 2.5);

check('pctOf: zero matches is null, not 0%', pctOf(0, 0), null);
check('pctOf: absent wins is null', pctOf(undefined, 10), null);
check('pctOf: normal case still multiplies', pctOf(1, 4), 25);

check('formatKd: null renders a dash', formatKd(null), '—');
check('formatKd: NaN renders a dash', formatKd(Number.NaN), '—');
check('formatPct: null renders a dash', formatPct(null), '—');

/* ---- display facts: an unread display is not 1440p@260 ---- */
check('displayUnread: null info is unread', displayUnread(null), true);
check('displayUnread: empty info is unread', displayUnread({}), true);
check('displayUnread: partial info is unread', displayUnread({ native_width: 2560 }), true);
check('displayUnread: full info is read', displayUnread({ native_width: 2560, native_height: 1440, current_hz: 260 }), false);

/* ---- source: the exact fallback expressions must not come back ---- */
const ROOT = join(import.meta.dir, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

function absent(rel: string, needle: string): void {
  check(`${rel} does not contain: ${needle}`, read(rel).includes(needle), false);
}

// 6. Unknown account level is not level 1.
absent('src/components/LoadoutViewer.tsx', 'player.accountLevel || 1');
// 5. A failed display read must not name 2560x1440@260 as this monitor.
for (const f of [
  'src/components/Settings.tsx',
  'src/components/UnifiedStretch.tsx',
  'src/components/CustomResolution.tsx',
  'src/components/ResolutionVisualizer.tsx',
]) {
  absent(f, '|| 2560');
  absent(f, '|| 1440');
  absent(f, '|| 260');
}
// 1b. The same Math.max(1, rounds) inflation in the Prep fallbacks.
absent('src/components/prep/usePrepData.ts', 'Math.max(1, d.rounds)');
absent('src/components/prep/usePrepData.ts', 'winPct: m > 0 ? (d.won / m) * 100 : 0');
absent('src/components/prep/usePrepData.ts', 'winPct: played > 0 ? (d.won / played) * 100 : 0');
absent('src/components/prep/usePrepData.ts', 'hsPct: d.hits > 0 ? (d.headshots / d.hits) * 100 : 0');
// 2. Unknown rank must not become tier 22 and name a rank the player lacks.
absent('src/components/hud/HudCanvas.tsx', 'userTier || 22');
// 1. Math.max(1, rounds) inflating ACS/ADR 10-30x.
absent('src/components/matches/MatchDetailBody.tsx', 'Math.max(1, teamBlueScore');
absent('src/components/matches/MatchDetailBody.tsx', 'roundsCount * 105');
// 3. K/D degrading to the kill count.
absent('src/components/matches/MatchDetailBody.tsx', 'deaths > 0 ? Number((p.kills / p.deaths).toFixed(2))');
absent('src/components/MatchHistory.tsx', 'e.d > 0 ? e.k / e.d : e.k');
absent('src/utils/trn.ts', 'kd: deaths > 0 ? kills / deaths : kills');
// 7. A win rate with no matches must be absent, not 0%.
absent('src/utils/trn.ts', 'winPct: (wins / matches) * 100');
absent('src/utils/trn.ts', 'winPct: (matchesWon / matchesPlayed) * 100');
absent('src/utils/trn.ts', 'winPct: m > 0 ? (w / m) * 100 : 0');

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All honesty checks passed.');
