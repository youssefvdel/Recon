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
check('overlay idle backoff every 12th tick (~30s)', overlay.includes(') % 12;'), true);
check('overlay keeps document.hidden skip', overlay.includes('document.hidden) return;'), true);
check('live dedup throttle 1s (memory)', tracker.includes('now - lastLiveMatchFetchTime < 1000'), true);
check('live dedup throttle 1s (persisted)', tracker.includes('now - item.at < 1000'), true);

// --- Tracker.gg pacing: EXACTLY as-is ---
check('TRN gap floor still 6000ms', trn.includes('TRN_GAP_MIN_MS = 6000'), true);
check('TRN gap ceiling still 8000ms', trn.includes('TRN_GAP_MAX_MS = 8000'), true);
check('TRN cooldown base still 25s', trn.includes('TRN_COOLDOWN_BASE_MS = 25 * 1000'), true);
check('TRN cooldown cap still 60s', trn.includes('TRN_COOLDOWN_MAX_MS = 60 * 1000'), true);

// --- monotonic MMR latch: placeholders never erase shown ranks ---
// A present-but-empty fresh entry (unrevealed teammate, degraded payload)
// must not revert rank/rr/peak to Unrated — that cycle reshuffles rows.
const { mergeMmrRow } = await import('../src/utils/tracker.ts');
const realMmr = { tier: 15, rr: 45, peakTier: 18, peakSeasonId: 's1', actWins: 5, actGames: 9 };
const emptyMmr = { tier: 0, rr: 0, peakTier: 0 };
check('empty fresh keeps latched rank', mergeMmrRow(emptyMmr, realMmr).tier, 15);
check('empty fresh keeps latched rr', mergeMmrRow(emptyMmr, realMmr).rr, 45);
check('empty fresh keeps latched peak', mergeMmrRow(emptyMmr, realMmr).peakTier, 18);
check('real fresh wins over latch', mergeMmrRow({ tier: 16, rr: 60, peakTier: 18 }, realMmr).tier, 16);
check('first sight of real rank shows', mergeMmrRow(realMmr, null).tier, 15);
check('nothing known stays zero', mergeMmrRow(emptyMmr, null).tier, 0);
check(
  'hidden flag latches true',
  mergeMmrRow({ tier: 0, rr: 0, peakTier: 0 }, { tier: 12, rr: 10, peakTier: 12, isRankHidden: true }).isRankHidden,
  true
);
check('row assembly uses the latch', tracker.includes('mergeMmrRow(freshMmr, prevMmr)'), true);

// --- per-player cache bounds: every puuid-keyed map is capped, and the
// CURRENT lobby is never the eviction victim (evicting a live player would
// strip the enrichment mergeLiveMatchStateNonRegressing latches, and that
// flicker is exactly what this file exists to prevent) ---
for (const cap of [
  'LIVE_STATS_CACHE_MAX',
  'RECENT24H_CACHE_MAX',
  'RECENT_MATCHES_CACHE_MAX',
  'MMR_CACHE_MAX_PLAYERS',
  'MMR_CACHE_MAX_ENTRIES',
  'LIVE_STATS_STORE_MAX',
  'LIVE_STATS_STORE_PRUNE',
]) {
  check(`${cap} is a named constant (no magic number)`, tracker.includes(`const ${cap} =`), true);
}
check('mmr cache cap is 2 keys per player', tracker.includes('const MMR_CACHE_MAX_ENTRIES = MMR_CACHE_MAX_PLAYERS * 2'), true);
for (const map of [
  'livePlayerStatsCache',
  'recent24hCache',
  'livePlayerRecentMatchesCache',
  'liveMmrCache',
]) {
  check(`${map} evicts oldest-first`, tracker.includes(`evictOldest(\n          ${map},`) || tracker.includes(`evictOldest(${map},`), true);
}
check('lobby-aware protect predicate exists', tracker.includes('const inCurrentLobby = (key: string): boolean'), true);
check('live stats eviction spares the lobby (flicker fix)', /evictOldest\(livePlayerStatsCache,[^;]*inCurrentLobby\)/.test(tracker), true);
check('mmr eviction spares the lobby', /evictOldest\(liveMmrCache,[^;]*inCurrentLobby\)/.test(tracker), true);
check('current lobby captured once per poll', tracker.includes('currentLobbyPuuids = lobbyPuuids;'), true);
check('persisted store prune spares the lobby too', tracker.includes('if (inCurrentLobby(k)) continue;'), true);

// --- cross-realm TRN latch: a poorer poll must never revert enrichment ---
// The main and overlay windows each load tracker.ts separately, so each has
// its own TRN cache and both broadcast. A realm behind on enrichment must not
// strip stats the other realm already resolved.
const { mergeLiveMatchStateNonRegressing } = await import('../src/utils/tracker.ts');
const mkPlayer = (o: Record<string, unknown>) =>
  ({ puuid: 'p1', name: 'A', tag: 'B', team: 'Blue', ...o }) as never;
const state = (blue: unknown[], over: Partial<Record<string, unknown>> = {}) =>
  ({
    phase: 'coregame',
    matchId: 'm1',
    mapId: 'map',
    mapName: 'Map',
    mode: 'Competitive',
    isDeathmatch: false,
    blueTeam: blue,
    redTeam: [],
    updatedAt: 1,
    ...over,
  }) as never;
const rich = state([mkPlayer({ kd: 1.4, acs: 250, hsPct: 30, winPct: 55, trnScore: 120, rr: 42, tier: 15 })]);
const poor = state([mkPlayer({ rr: 7, tier: 3, selectionState: 'SELECTING' })]);
const merged = mergeLiveMatchStateNonRegressing(rich, poor);
check('poor poll keeps acs', merged.blueTeam[0].acs, 250);
check('poor poll keeps kd', merged.blueTeam[0].kd, 1.4);
check('poor poll keeps hsPct', merged.blueTeam[0].hsPct, 30);
check('poor poll keeps winPct', merged.blueTeam[0].winPct, 55);
check('poor poll keeps trnScore', merged.blueTeam[0].trnScore, 120);
check('live rr is NOT latched', merged.blueTeam[0].rr, 7);
check('live tier is NOT latched', merged.blueTeam[0].tier, 3);
check('live selectionState is NOT latched', merged.blueTeam[0].selectionState, 'SELECTING');
check('top-level fields come from incoming', mergeLiveMatchStateNonRegressing(rich, poor).matchId, 'm1');
check(
  'real fresh enrichment wins over the latch',
  mergeLiveMatchStateNonRegressing(rich, state([mkPlayer({ acs: 260 })])).blueTeam[0].acs,
  260
);
check('unknown player passes through', mergeLiveMatchStateNonRegressing(rich, state([mkPlayer({ puuid: 'p2' })])).blueTeam[0].puuid, 'p2');
check('no previous state = pure passthrough', mergeLiveMatchStateNonRegressing(null, poor), poor);
check(
  'teams merge independently',
  mergeLiveMatchStateNonRegressing(
    { ...(rich as object), redTeam: [mkPlayer({ puuid: 'r1', acs: 300 })] } as never,
    { ...(poor as object), redTeam: [mkPlayer({ puuid: 'r1' })] } as never
  ).redTeam[0].acs,
  300
);
check('lobby view merges before committing', live.includes('mergeLiveMatchStateNonRegressing(prevStateRef.current, s)'), true);
check('overlay view merges before committing', overlay.includes('mergeLiveMatchStateNonRegressing(prevStateRef.current, s)'), true);
check(
  'trnState is compared, so pending→unavailable repaints',
  tracker.includes('p1.trnState === p2.trnState'),
  true
);

// --- isTrnPrivate is sticky-true, not a `??` latch ---
// The row build resolves it as `?? false`, so it is NEVER nullish here. A realm
// that has not fetched the player emits that `false`, which clobbered the other
// realm's correct `true` and made the private-lock badge ping-pong for the whole
// match. No `kd` on the incoming player means "this realm hasn't fetched", not
// "the profile is public", so the lock sticks. Real data un-latches.
const privPrev = state([mkPlayer({ kd: 1.4, acs: 250, trnScore: 120, isTrnPrivate: true })]);
check(
  'unfetched realm false does not clear the lock',
  mergeLiveMatchStateNonRegressing(privPrev, state([mkPlayer({ isTrnPrivate: false })])).blueTeam[0].isTrnPrivate,
  true
);
check(
  'real incoming data un-latches a published profile',
  mergeLiveMatchStateNonRegressing(privPrev, state([mkPlayer({ kd: 1.1, isTrnPrivate: false })])).blueTeam[0]
    .isTrnPrivate,
  false
);
check(
  'incoming true always wins over a public latch',
  mergeLiveMatchStateNonRegressing(
    state([mkPlayer({ kd: 1.4, isTrnPrivate: false })]),
    state([mkPlayer({ isTrnPrivate: true })])
  ).blueTeam[0].isTrnPrivate,
  true
);
check(
  'a normal player with kd is unaffected by the sticky rule',
  mergeLiveMatchStateNonRegressing(rich, poor).blueTeam[0].isTrnPrivate,
  undefined
);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All live-poll cadence tests passed.');
