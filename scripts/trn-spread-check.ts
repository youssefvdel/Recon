// Lobby TRN fill: ONE concurrent fetch of budgeted players (own team first,
// 200-400ms jitter, NOT 6s) instead of bursting. Checks the pure helpers
// behaviorally and the poll-loop wiring by source text (same style as
// live-poll-check.ts).
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
  getCachedLivePlayerStats,
  trnFillJitterMs,
  TRN_FILL_JITTER_MIN_MS,
  TRN_FILL_JITTER_MAX_MS,
  TRN_SPREAD_MAX_PLAYERS,
  TRN_SPREAD_MAX_PLAYERS_DM,
  trnSpreadBudget,
  presenceLoopToPhase,
  TRN_PRIVATE_RETRY_MS,
  TRN_MISSING_RETRY_MS,
} = await import('../src/utils/tracker.ts');

// --- Fill jitter bounds (NOT 6s) ---
check('fill jitter floor is 200ms', TRN_FILL_JITTER_MIN_MS === 200, { TRN_FILL_JITTER_MIN_MS });
check('fill jitter ceiling is 400ms', TRN_FILL_JITTER_MAX_MS === 400, { TRN_FILL_JITTER_MAX_MS });
// Hard per-lobby budget covers a full 10-player lobby, no more.
check('lobby budget is 10 players', TRN_SPREAD_MAX_PLAYERS === 10, { TRN_SPREAD_MAX_PLAYERS });
check('deathmatch budget is 12 players', TRN_SPREAD_MAX_PLAYERS_DM === 12, { TRN_SPREAD_MAX_PLAYERS_DM });
check('budget helper: normal → 10', trnSpreadBudget(false) === 10, {});
check('budget helper: deathmatch → 12', trnSpreadBudget(true) === 12, {});
// Permanent negatives: privates/missing pages must not burn a request every lobby.
check('451-private backs off 7d', TRN_PRIVATE_RETRY_MS === 7 * 24 * 60 * 60 * 1000, { TRN_PRIVATE_RETRY_MS });
check('404-missing backs off 24h', TRN_MISSING_RETRY_MS === 24 * 60 * 60 * 1000, { TRN_MISSING_RETRY_MS });
// Deliberate negatives survive the self-heal (it used to wipe any backoff
// over 2 minutes, re-fetching privates every session).
const negPid = 'neg-test-0000-0000-0000-000000000000';
setCachedLivePlayerStats(negPid, { fetchedAt: Date.now(), retryAfter: Date.now() + TRN_PRIVATE_RETRY_MS, negative: 'private', isTrnPrivate: true });
check('flagged 7d backoff means no fetch needed', playerNeedsTrnStats(negPid) === false, {});
check('negative flag persists on the entry', getCachedLivePlayerStats(negPid)?.negative === 'private', {});

// --- Jitter behavior: within bounds, varies, never lockstep, never 6s ---
const N = 2000;
let outOfBounds = 0;
let min = Infinity;
let max = -Infinity;
let sum = 0;
const seen = new Set<number>();
for (let i = 0; i < N; i++) {
  const g = trnFillJitterMs();
  if (typeof g !== 'number' || !Number.isFinite(g) || g < 200 || g > 400) outOfBounds++;
  if (g < min) min = g;
  if (g > max) max = g;
  sum += g;
  seen.add(Math.round(g));
}
check(`all ${N} jitter samples within [200, 400]`, outOfBounds === 0, { outOfBounds });
check('jitter actually varies (not lockstep)', seen.size > 50, { distinct: seen.size });
check('jitter covers the low end', min < 230, { min });
check('jitter covers the high end', max > 370, { max });
const mean = sum / N;
check('jitter mean near ~300ms', mean > 250 && mean < 350, { mean });
check('jitter ceiling is NOT 6s', TRN_FILL_JITTER_MAX_MS < 1000, { TRN_FILL_JITTER_MAX_MS });

// --- Ordering: own team first, stable, non-mutating ---
const mk = (id: string, mine: boolean) => ({ puuid: id, name: `N${id}`, tag: 'T1', mine });
const lobby = [mk('e1', false), mk('m1', true), mk('e2', false), mk('m2', true), mk('m3', true)];
const ordered = orderSpreadQueue(lobby);
check(
  'own team fires before enemies',
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

// --- Wiring (source text): concurrent fill on top of the untouched gate ---
const tracker = await Bun.file('src/utils/tracker.ts').text();
const trn = await Bun.file('src/utils/trn.ts').text();

check('concurrent fill fans out per player', tracker.includes('}, trnFillJitterMs());'), true);
check('no 6s serialization left', !tracker.includes('TRN_SPREAD_MS') && !tracker.includes('TRN_SPREAD_FIRST_MS') && !tracker.includes('pumpTrnSpread'), true);
check('no setInterval overlap in tracker', !tracker.includes('setInterval'));
check('fill keyed per lobby (match survives the flip)', tracker.includes('const key = matchId;'), true);
check('no per-phase key (budget is per lobby ≤10)', !tracker.includes('`${matchId}:${phase}`'), true);
check('stale firing never fetches old lobby', tracker.includes('stale firings must never fetch for the old lobby'), true);
check('fill stops when polls go stale', tracker.includes('TRN_SPREAD_STALE_MS'), true);
check('heal skips flagged deliberate negatives', tracker.includes('!entry.negative &&'), true);
check('hidden tab pauses enqueue', tracker.includes("document.hidden) return;"), true);
check('cooldown fail-fast touches no network', tracker.includes('touch no network during cooldown'), true);
check('manual refresh bypasses the fill', tracker.includes('fetchTrnStatsNow(p.puuid, realName, realTag)'), true);
check('manual immediate respects the mode budget', tracker.includes('forceRefresh && trnSpreadSpent < trnSpreadBudget(isDeathmatch)'), true);
check('budget spent counted on fire', tracker.includes('trnSpreadSpent++'), true);
check('budget resets on match change (per-lobby budget)', tracker.includes('trnSpreadSpent = 0'), true);
check('budget caps the fill (own-team-first drops enemies)', tracker.includes('budget - trnSpreadSpent'), true);
check('fill re-checks need at fire time', tracker.includes('!playerNeedsTrnStats(puuid)'), true);
check('dedup floor still guards immediate path', tracker.includes('trnInFlightLive.has(inFlightKey)'), true);
check('fill skips in-flight players without spending', tracker.includes('trnInFlightLive.has(puuid.toLowerCase())'), true);

// --- Drain split: dispatched fill finishes across the flip, new fills gate ---
check('new fills gate at enqueue while paused', tracker.includes('if (await trnProxyPaused())'), true);
check('dispatched firings skip the pause check by design', tracker.includes('No paused check by'), true);
check('dispatched firings carry drain', tracker.includes('fetchTrnStatsNow(puuid, name, tag, true)'), true);
check('drain reaches act stats', trn.includes('trnDrainFor(name, tag, drain) ? { drain: true } : undefined'), true);
check('drain skips only the pause pre-check', trn.includes('opts?.drain !== true && (await trnProxyPaused())'), true);

// --- Atomic job: descendants inherit drain until settle, then re-gate ---
check('dispatching fill opens one job', tracker.includes('openTrnDrainJob(players.map'), true);
check('quiesced lobby settles its job', tracker.includes('closeTrnDrainJob(trnDrainGen)'), true);
check('settle is owner- and match-scoped', tracker.includes('matchId === trnDrainMatchId'), true);
check('agents inherit the job token', trn.includes('trnDrainFor(name, tag, opts?.drain === true)'), true);

// --- Phase warming: Riot-local presences correct the hint before dispatch ---
// The full poll can arrive already in coregame; presences answer in ms, so
// pregame wins the race. Positive signals only — missing data never
// downgrades the hint, true coregame-fullscreen still pauses.
check('PREGAME warms pregame', presenceLoopToPhase('PREGAME') === 'pregame', { got: presenceLoopToPhase('PREGAME') });
check('INGAME warms coregame', presenceLoopToPhase('INGAME') === 'coregame', { got: presenceLoopToPhase('INGAME') });
check('loop match is case-insensitive', presenceLoopToPhase('pregame') === 'pregame', { got: presenceLoopToPhase('pregame') });
check('loop trims whitespace', presenceLoopToPhase('  INGAME ') === 'coregame', { got: presenceLoopToPhase('  INGAME ') });
check('menus warms nothing', presenceLoopToPhase('MENUS') === null, { got: presenceLoopToPhase('MENUS') });
check('empty warms nothing', presenceLoopToPhase('') === null, { got: presenceLoopToPhase('') });
check('garbage warms nothing', presenceLoopToPhase('bogus') === null, { got: presenceLoopToPhase('bogus') });
check('warm helper exists', tracker.includes('async function warmTrnPhaseFromPresence'), true);
check('warm reads Riot-local presences', tracker.includes("invoke<string>('local_presences')"), true);
check('first fill awaits the warm before dispatch', tracker.includes('await warmTrnPhaseFromPresence()'), true);
check('warm stamps positive signals only', tracker.includes('if (warmed)'), true);
check('enqueue awaits the warm (async fill)', tracker.includes('async function enqueueTrnSpread'), true);

// --- Untouched floors: serial gate, cooldown ladder, caches ---
check('TRN gap floor still 6000ms', trn.includes('TRN_GAP_MIN_MS = 6000'), true);
check('TRN gap ceiling still 8000ms', trn.includes('TRN_GAP_MAX_MS = 8000'), true);
check('TRN cooldown base still 25s', trn.includes('TRN_COOLDOWN_BASE_MS = 25 * 1000'), true);
check('TRN cooldown cap still 60s', trn.includes('TRN_COOLDOWN_MAX_MS = 60 * 1000'), true);

// --- Longer TTLs for slow stats (never shorter) ---
check('profile TTL 24h', trn.includes('const PROFILE_TTL_MS = 24 * 60 * 60 * 1000'), true);
check('season-segment TTL 24h', trn.includes('const SEASON_SEG_TTL_MS = 24 * 60 * 60 * 1000'), true);
check('TRN matches TTL 6h', trn.includes('readPersisted<Record<string, number>>(key, 6 * 3600 * 1000)'), true);

// --- WebView2 transport seam (mock/source-text only — no live calls) ---
// Single choke point: every TRN request funnels through one invoke site, so
// no transport can bypass the gate above it. No Rust HTTP remains anywhere
// in the TRN path: the hidden same-origin window is the sole transport.
check(
  'single trn_proxy_fetch egress site',
  trn.split("invoke<string>('trn_proxy_fetch'").length - 1 === 1,
  { sites: trn.split("invoke<string>('trn_proxy_fetch'").length - 1 }
);
check('no rust trn_get egress left', !trn.includes("invoke<string>('trn_get'"), true);
const proxyRs = await Bun.file('src-tauri/src/trn_proxy.rs').text();
check('proxy hits the api origin', proxyRs.includes('const API_BASE: &str = "https://api.tracker.gg"'), true);
const trackerRs = await Bun.file('src-tauri/src/tracker.rs').text();
check('rust trn_get command deleted', !trackerRs.includes('pub async fn trn_get'), true);
check('no trn_client references left', !trackerRs.includes('trn_client'), true);
check('HTTP error shape (`HTTP {code}`)', proxyRs.includes('HTTP {}: {}'), true);
check('hung page surfaces, no silent fallback', proxyRs.includes('EDGE_PAUSED proxy timeout'), true);
check('readiness gate parks fresh pages', proxyRs.includes('EDGE_PAUSED proxy not ready'), true);
check('no session pin (single transport)', !trn.includes('edgeDirectBlocked'), true);
check('explicit retry still resets pacing', trn.includes('trnNextSlot = 0'), true);
check(
  'fullscreen pause surfaces, no shim',
  !trn.includes('isEdgeTransientFailure') && proxyRs.includes('EDGE_PAUSED game fullscreen'),
  true
);
check('same-origin proxy sends page cookies', proxyRs.includes("credentials:'include'"), true);
// App side must not forbid the egress: no page CSP anywhere in the chain.
const tauriConf = await Bun.file('src-tauri/tauri.conf.json').text();
const indexHtml = await Bun.file('index.html').text();
check('tauri CSP disabled (no connect-src block)', tauriConf.includes('"csp": null'), true);
check('no meta CSP in index.html', !indexHtml.includes('Content-Security-Policy'), true);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All TRN spread tests passed.');
