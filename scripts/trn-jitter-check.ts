// Unit tests for the TRN human-pacing jitter (src/utils/trn.ts).
//
//   bun scripts/trn-jitter-check.ts
export {};

const { trnJitterGapMs, TRN_GAP_MIN_MS, TRN_GAP_MAX_MS } = await import('../src/utils/trn.ts');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${detail !== undefined ? `\n  detail: ${JSON.stringify(detail)}` : ''}`);
  }
}

check('gap bounds exported', TRN_GAP_MIN_MS === 1500 && TRN_GAP_MAX_MS === 3000, {
  TRN_GAP_MIN_MS,
  TRN_GAP_MAX_MS,
});

const N = 5000;
let min = Infinity;
let max = -Infinity;
let sum = 0;
let outOfBounds = 0;
const seen = new Set<number>();
for (let i = 0; i < N; i++) {
  const g = trnJitterGapMs();
  if (typeof g !== 'number' || !Number.isFinite(g)) outOfBounds++;
  else if (g < TRN_GAP_MIN_MS || g > TRN_GAP_MAX_MS) outOfBounds++;
  if (g < min) min = g;
  if (g > max) max = g;
  sum += g;
  seen.add(Math.round(g));
}

check(`all ${N} samples within [1500, 3000]`, outOfBounds === 0, { outOfBounds });
check('jitter actually varies (not a fixed slot)', seen.size > 100, { distinct: seen.size });
check('spread covers the low end', min < 1700, { min });
check('spread covers the high end', max > 2800, { max });
// Uniform mean ≈ 2250; generous ±250 tolerance so this never flakes.
const mean = sum / N;
check('mean near uniform midpoint (~2250)', mean > 2000 && mean < 2500, { mean });

// Distribution: uniform-ish means every quartile earns real share.
// 15% floor at n=2000 is ~10sd below the 25% mean — never flakes.
const N2 = 2000;
const quart = [0, 0, 0, 0];
for (let i = 0; i < N2; i++) {
  const g = trnJitterGapMs();
  const q = Math.min(3, Math.floor(((g - TRN_GAP_MIN_MS) / (TRN_GAP_MAX_MS - TRN_GAP_MIN_MS)) * 4));
  quart[q]++;
}
check('quartiles all earn >15% share', quart.every((c) => c > 0.15 * N2), { quart });

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All TRN jitter tests passed.');
