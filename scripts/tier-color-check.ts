// Tracker Score stat colours: the underline + grade letter must be tinted by
// the tier the stat's grade maps to (SCORE_TIERS palette), never by a
// per-stat hardcoded hex. The reported bug: B rendered cyan, C red, C yellow.
//
//   bun scripts/tier-color-check.ts
export {};

const { SCORE_TIERS, gradeFor, tierColor } = await import('../src/components/ScoreBadge.tsx');

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

// --- documented palette (mirrors SCORE_TIERS; catches a silent hex change) ---
const EXPECTED: Record<string, string> = {
  '1K': '#fedc45',
  S: '#40c4ff',
  A: '#3ddc84',
  B: '#e8b73a',
  C: '#9fb2c8',
  D: '#c98a94',
};
for (const t of ['1K', 'S', 'A', 'B', 'C', 'D'] as const) {
  check(`tierColor(${t}) = documented hex`, tierColor(t), EXPECTED[t]);
  check(`tierColor(${t}) = SCORE_TIERS entry`, tierColor(t), SCORE_TIERS.find((x) => x.tier === t)?.color);
}

// --- gradeFor → tierColor composition on real percentile inputs ---
const CASES: [number, string, string][] = [
  [99, '1K', '#fedc45'],
  [90, 'S', '#40c4ff'],
  [70, 'A', '#3ddc84'],
  [60, 'B', '#e8b73a'], // reported bug: B was rendered cyan
  [35, 'C', '#9fb2c8'], // reported bug: C was rendered red / another C yellow
  [10, 'D', '#c98a94'],
];
for (const [pct, tier, hex] of CASES) {
  check(`pctile ${pct} → ${tier} → ${hex}`, tierColor(gradeFor(pct)), hex);
}
check('pctile 30 and 35 both grade C (same tone)', tierColor(gradeFor(30)) === tierColor(gradeFor(35)), true);

// --- wiring: Overview uses the tier tone at both sites, hardcoded hexes gone ---
const overview = await Bun.file('src/components/Overview.tsx').text();
check('Overview imports tierColor', overview.includes("import { ScoreBadge, gradeFor, scoreTier, tierColor } from './ScoreBadge'"), true);
check('Overview derives tone from the grade', overview.includes('const g = gradeFor(s.p);') && overview.includes('const tone = tierColor(g);'), true);
check('underline tinted by tone', overview.includes('borderBottomColor: tone'), true);
check('grade letter tinted by tone', overview.includes('style={{ color: tone }}'), true);
check('old per-stat hexes gone', !/#2cd5f6|#3ae374|#ff7675|#f5b041/.test(overview), true);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All tier-color tests passed.');
