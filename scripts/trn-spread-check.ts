// Lobby TRN spread: uncached lobby players drain ONE per ~6s (own team
// first) instead of bursting. Checks the pure helpers behaviorally and the
// poll-loop wiring by source text (same style as live-poll-check.ts).
//
//   bun scripts/trn-spread-check.ts
export {};

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${detail !== undefined ? `\n  detail: ${JSON.stringify(detail)}` : ''}`);
  }
}

const {
  orderSpreadQueue,
  playerNeedsTrnStats,
  setCachedLivePlayerStats,
  TRN_SPREAD_MS,
} = await import('../src/utils/tracker.ts');

// --- Spacing constant ---
check('spread gap is 6000ms', TRN_SPREAD_MS === 6000, { TRN_SPREAD_MS });

// --- Ordering: own team first, stable, non-mutating ---
const mk = (id: string, mine: boolean) => ({ puuid: id, name: `N${id}`, tag: 'T1', mine });
const lobby = [mk('e1', false), mk('m1', true), mk('e2', false), mk('m2', true), mk('m3', true)];
const ordered = orderSpreadQueue(lobby);
check(
  'own team drains before enemies',
  ordered.map((p) => p.puuid).join(',') === 'm1,m2,m3,e1,e2',
  { got: ordered.map((p) => p.puuid) }
);
check('input not mutated', lobby.map((p) => p.puuid).join(',') === 'e1,m1,e2,m2,m3');
check(
  'order stable within a side',
  orderSpreadQueue([mk('b', true), mk('a', true)]).map((p) => p.puuid).join(',') === 'b,a'
);
check('empty lobby orders empty', orderSpreadQueue([]).length === 0);
check('all-enemy lobby keeps order', orderSpreadQueue([mk('x', false), mk('y', false)]).length === 2);

// --- Need predicate: same rule the old inline block used ---
const fresh = `spread-test-${Date.now()}`;
check('unknown player needs stats', playerNeedsTrnStats(fresh) === true);
setCachedLivePlayerStats(fresh, { kd: 1.2, fetchedAt: Date.now() });
check('cached kd suppresses refetch', playerNeedsTrnStats(fresh) === false);
const failed = `${fresh}-failed`;
setCachedLivePlayerStats(failed, { fetchedAt: Date.now(), retryAfter: Date.now() + 60_000 });
check('failed lookup backs off until retryAfter', playerNeedsTrnStats(failed) === false);
const retry = `${fresh}-retry`;
setCachedLivePlayerStats(retry, { fetchedAt: Date.now() - 600_000, retryAfter: Date.now() - 1000 });
check('expired backoff needs stats again', playerNeedsTrnStats(retry) === true);
const acsOnly = `${fresh}-acs`;
setCachedLivePlayerStats(acsOnly, { acs: 200, fetchedAt: Date.now() });
check('acs alone counts as fetched', playerNeedsTrnStats(acsOnly) === false);

// --- Wiring (source text): paced spread on top of the untouched gate ---
const tracker = await Bun.file('src/utils/tracker.ts').text();
const trn = await Bun.file('src/utils/trn.ts').text();

check('chained setTimeout paces the drain', tracker.includes('setTimeout(pumpTrnSpread, TRN_SPREAD_MS)'), true);
check('no setInterval overlap in tracker', !tracker.includes('setInterval'));
check('queue keyed on match+phase', tracker.includes('`${matchId}:${phase}`'), true);
check('stale queue dropped on match/phase change', tracker.includes('stale queue must never fetch'), true);
check('drain stops when polls go stale', tracker.includes('TRN_SPREAD_STALE_MS'), true);
check('hidden tab pauses enqueue', tracker.includes("document.hidden) return;"), true);
check('hidden tab stops the drain', tracker.includes('stopTrnSpread();'), true);
check('cooldown fail-fast touches no network', tracker.includes('touch no network, retry at cooldown end'), true);
check('manual refresh bypasses the spread', tracker.includes('fetchTrnStatsNow(p.puuid, realName, realTag)'), true);
check('dedup floor still guards immediate path', tracker.includes('trnInFlightLive.has(inFlightKey)'), true);
check('spread re-checks need at tick time', tracker.includes('!playerNeedsTrnStats(head.puuid)'), true);

// --- Untouched floors: serial gate, cooldown ladder, caches ---
check('TRN gap floor still 1500ms', trn.includes('TRN_GAP_MIN_MS = 1500'), true);
check('TRN gap ceiling still 3000ms', trn.includes('TRN_GAP_MAX_MS = 3000'), true);
check('TRN cooldown base still 25s', trn.includes('TRN_COOLDOWN_BASE_MS = 25 * 1000'), true);
check('TRN cooldown cap still 60s', trn.includes('TRN_COOLDOWN_MAX_MS = 60 * 1000'), true);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All TRN spread tests passed.');
