// Live-game poll cadence: Riot-local endpoints (127.0.0.1) have no rate
// limit, so the overlay + lobby polls run fast. Tracker.gg pacing
// (1.5–3s jitter gate, cooldown ladder) lives in trn.ts and is NOT covered
// here — it must never get faster (ban risk). This locks the Riot-side
// intervals so a future edit can't silently slow the live views or speed
// up the TRN gate by confusion.
//
//   bun scripts/live-poll-check.ts
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

const live = await Bun.file('src/components/LiveMatchView.tsx').text();
const overlay = await Bun.file('src/components/OverlayView.tsx').text();
const tracker = await Bun.file('src/utils/tracker.ts').text();
const trn = await Bun.file('src/utils/trn.ts').text();

// --- Riot-local pollers: fast ---
check('lobby poll 3s', live.includes('setInterval(poll, 3000)'), true);
check('lobby poll has no 6s remnant', live.includes('setInterval(poll, 6000)'), false);
check('overlay tick 2.5s', overlay.includes('setInterval(tick, 2500)'), true);
check('overlay tick has no 4.5s remnant', overlay.includes('setInterval(tick, 4500)'), false);
check('overlay idle backoff every 5th tick (~12.5s)', overlay.includes(') % 5;'), true);
check('overlay keeps document.hidden skip', overlay.includes('document.hidden) return;'), true);
check('live dedup throttle 1s (memory)', tracker.includes('now - lastLiveMatchFetchTime < 1000'), true);
check('live dedup throttle 1s (persisted)', tracker.includes('now - item.at < 1000'), true);

// --- Tracker.gg pacing: EXACTLY as-is ---
check('TRN gap floor still 1500ms', trn.includes('TRN_GAP_MIN_MS = 1500'), true);
check('TRN gap ceiling still 3000ms', trn.includes('TRN_GAP_MAX_MS = 3000'), true);
check('TRN cooldown base still 25s', trn.includes('TRN_COOLDOWN_BASE_MS = 25 * 1000'), true);
check('TRN cooldown cap still 60s', trn.includes('TRN_COOLDOWN_MAX_MS = 60 * 1000'), true);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All live-poll cadence tests passed.');
