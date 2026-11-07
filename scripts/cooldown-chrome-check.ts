// Cooldown chrome check: the TRN mechanism (serial gate, jitter, ladder,
// fail-fast) runs silently — prod UI shows no countdowns, seconds, or
// rate-limit jargon. The stats on/off setting pill and all dev-only
// readouts stay. (TRN is a cold fallback: no countdown chrome.)
//
//   bun scripts/cooldown-chrome-check.ts
export {};

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

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All cooldown chrome tests passed.');
