// Unit tests for the Dev QA surface: tracker kill-switch toggle (src/utils/trn.ts)
// + server-chip fixture parsing (src/utils/matchServer.ts).
//
//   bun scripts/devqa-check.ts
export {};

// Deterministic localStorage BEFORE the modules under test load.
const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string): void => {
    store.set(k, String(v));
  },
  removeItem: (k: string): void => {
    store.delete(k);
  },
  clear: (): void => {
    store.clear();
  },
};
(globalThis as Record<string, unknown>).localStorage = fakeStorage;

const {
  parseTrackerEnabledFlag,
  isTrackerEnabled,
  setTrackerEnabled,
  resetTrackerEnabledCache,
  trnCooldownRemainingMs,
  trnCooldownStepCount,
  resetTrnCooldown,
  trnCooldownDelayMs,
  TRN_UA_MAJOR,
  trnGet,
  trnProfilePath,
  QA_BURST_TARGETS,
  burstQaVerdict,
  TRN_PROXY_NOT_READY,
  isTrnProxyNotReady,
  setTrnMatchPhase,
  getTrnMatchPhase,
  parseTrnProxyState,
  TRN_PROXY_PAUSED,
  trnProxyPaused,
  openTrnDrainJob,
  closeTrnDrainJob,
  trnDrainFor,
  isTrnNetDead,
  isTrnPrivateError,
  trnNoteNegative,
  trnNegativeBlocked,
  trnNegativeKind,
  trnPlayerFromPath,
  noteNegativeFromPath,
  noteTrnPathFailed,
  trnPathCooling,
  trnPlayerKey,
  TRN_NEGATIVE_BACKOFF,
  TRN_NEG_PRIVATE_MS,
  TRN_NEG_MISSING_MS,
  isTrnDeadQuiet,
  TRN_NET_DEAD_MARK,
  TRN_DEAD_STREAK_MAX,
  TRN_DEAD_QUIET_MS,
  TRN_DEAD_QUIET,
} = await import('../src/utils/trn.ts');
const { parseGamePodId, extractGamePodId } = await import('../src/utils/matchServer.ts');

const TRN_ENABLED_KEY = 'recon_tracker_enabled_v1';

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

// --- toggle flag parsing (pure) ---
check('flag absent → ON (default)', parseTrackerEnabledFlag(null), true);
check('flag undefined → ON', parseTrackerEnabledFlag(undefined), true);
check("flag '0' → OFF", parseTrackerEnabledFlag('0'), false);
check("flag '1' → ON", parseTrackerEnabledFlag('1'), true);
check("flag '' → ON", parseTrackerEnabledFlag(''), true);
check("flag garbage → ON", parseTrackerEnabledFlag('yes'), true);

// --- toggle get/set/persist round-trip ---
check('default ON with empty store', isTrackerEnabled(), true);
setTrackerEnabled(false);
check('OFF after setTrackerEnabled(false)', isTrackerEnabled(), false);
check('OFF persisted as 0', store.get(TRN_ENABLED_KEY), '0');
resetTrackerEnabledCache();
check('OFF survives cache reset (persisted)', isTrackerEnabled(), false);
setTrackerEnabled(true);
check('ON after setTrackerEnabled(true)', isTrackerEnabled(), true);
check('ON clears the key (absent = default ON)', store.has(TRN_ENABLED_KEY), false);
resetTrackerEnabledCache();
check('ON survives cache reset (default)', isTrackerEnabled(), true);

// --- gate + ladder untouched when ON ---
check('no cooldown pending initially', trnCooldownRemainingMs(), 0);
check('cooldown step 0 initially', trnCooldownStepCount(), 0);
check('UA major display constant', TRN_UA_MAJOR, 153);

// --- fixture parser (same fixtures as the Dev QA page) ---
check(
  'frankfurt fixture',
  parseGamePodId(extractGamePodId({ GamePodID: 'aresriot.aws-rclusterprod-eu2-1.eu-gp-frankfurt-1' })),
  'Frankfurt · EU2'
);
check(
  'oregon fixture',
  parseGamePodId(extractGamePodId({ GamePodID: 'aresriot.aws-rclusterprod-us2-1.na-gp-oregon-1' })),
  'Oregon · US2'
);
check(
  'unknown fixture falls back to raw pod segment',
  parseGamePodId(extractGamePodId({ GamePodID: 'aresriot.custom-cluster-9.custompod-xyz' })),
  'custompod-xyz'
);
check('absent payload → null (hidden chip)', parseGamePodId(extractGamePodId({})), null);
check('null payload → null (hidden chip)', parseGamePodId(extractGamePodId(null)), null);
check('null pod → null (hidden chip)', parseGamePodId(null), null);

// --- cooldown remaining: stored-key paths (cross-tab cooldown) ---
const TRN_COOLDOWN_KEY = 'recon_trn_cooldown_until_v1';
store.set(TRN_COOLDOWN_KEY, String(Date.now() + 25000));
check('stored future cooldown → remaining > 0', trnCooldownRemainingMs() > 0, true);
store.set(TRN_COOLDOWN_KEY, String(Date.now() - 1000));
check('stored expired cooldown → 0', trnCooldownRemainingMs(), 0);
store.set(TRN_COOLDOWN_KEY, 'garbage');
check('stored garbage cooldown → 0', trnCooldownRemainingMs(), 0);
store.delete(TRN_COOLDOWN_KEY);

// --- resetTrnCooldown ---
store.set(TRN_COOLDOWN_KEY, String(Date.now() + 25000));
resetTrnCooldown();
check('reset clears remaining', trnCooldownRemainingMs(), 0);
check('reset removes stored key', store.has(TRN_COOLDOWN_KEY), false);
check('reset clears step', trnCooldownStepCount(), 0);

// --- ladder math (pure; trnGet calls this verbatim) ---
check('ladder step 1 → 25s', trnCooldownDelayMs(1), 25000);
check('ladder step 2 → 50s', trnCooldownDelayMs(2), 50000);
check('ladder step 3 → capped 60s', trnCooldownDelayMs(3), 60000);
check('ladder step 4 → capped 60s', trnCooldownDelayMs(4), 60000);
check('ladder step 9 → capped 60s', trnCooldownDelayMs(9), 60000);
check('ladder step 0 → floored 25s', trnCooldownDelayMs(0), 25000);

// --- toggle storage-throw paths (fail-open, memory still correct) ---
const throwingStorage = {
  getItem: (_k: string): string => {
    throw new Error('denied');
  },
  setItem: (_k: string, _v: string): void => {
    throw new Error('denied');
  },
  removeItem: (_k: string): void => {
    throw new Error('denied');
  },
};
(globalThis as Record<string, unknown>).localStorage = throwingStorage;
resetTrackerEnabledCache();
check('throwing storage → default ON', isTrackerEnabled(), true);
setTrackerEnabled(false);
check('throwing storage → in-memory OFF', isTrackerEnabled(), false);
setTrackerEnabled(true);
check('throwing storage → in-memory ON', isTrackerEnabled(), true);
(globalThis as Record<string, unknown>).localStorage = fakeStorage;
resetTrackerEnabledCache();
check('numeric 0 flag → OFF', parseTrackerEnabledFlag(0), false);
check('restored storage → default ON', isTrackerEnabled(), true);

// --- Burst QA button logic (DevDashboard "Burst QA (12×)" → trn.ts) ---
check('trnGet exported (burst goes through the single egress)', typeof trnGet, 'function');
check('burst path: BOT#staff', trnProfilePath('BOT', 'staff'), '/api/v2/valorant/standard/profile/riot/BOT%23staff');
check(
  'burst path: arabic name encoded',
  trnProfilePath('بطيوس', 'Sora'),
  `/api/v2/valorant/standard/profile/riot/${encodeURIComponent('بطيوس')}%23Sora`
);
check(
  'burst path: space name encoded',
  trnProfilePath('lil ga7ed', 'zngr'),
  '/api/v2/valorant/standard/profile/riot/lil%20ga7ed%23zngr'
);
check('burst fires 12 fetches', QA_BURST_TARGETS.length, 12);
check(
  'burst covers 12 distinct players',
  new Set(QA_BURST_TARGETS.map((p) => `${p.name}#${p.tag}`)).size,
  12
);
for (const [name, tag] of [
  ['lil ga7ed', 'zngr'],
  ['AboHaMaDa', '6611'],
  ['curko', '2002'],
  ['Mr Kayz', '000'],
  ['chosen one', 'kebab'],
  ['brad git', 'korea'],
  ['wolverine', 'ssss'],
  ['daijun', 'aim'],
  ['BUBBLLY', '666'],
  ['ledr pa lesyk', '57017'],
  ['SoliDeo', '2222'],
  ['nadjq', 'meow'],
] as const) {
  check(
    `burst covers 1x ${name}#${tag}`,
    QA_BURST_TARGETS.filter((p) => p.name === name && p.tag === tag).length,
    1
  );
}
check('verdict clean → NO WALL', burstQaVerdict(['#1 BOT#staff: OK · 800ms']), 'NO WALL');
check('verdict empty → NO WALL', burstQaVerdict([]), 'NO WALL');
check('verdict 429 → WALL', burstQaVerdict(['HTTP 429: too many']), 'WALL');
check('verdict 403 → WALL', burstQaVerdict(['HTTP 403: forbidden']), 'WALL');
check('verdict 1015 → WALL', burstQaVerdict(['Error 1015 rate limited']), 'WALL');
check('verdict RATE_LIMITED → WALL', burstQaVerdict(['TRN_RATE_LIMITED 25s']), 'WALL');
check(
  'verdict mixed → WALL',
  burstQaVerdict(['#1 BOT#staff: OK · 800ms', '#2 x#y: HTTP 403: blocked']),
  'WALL'
);
// Per-line transport tags (DevDashboard burst → trnGet onTransport; display-only).
check('verdict tagged EDGE clean → NO WALL', burstQaVerdict(['#1 BOT#staff: [EDGE] OK · 800ms']), 'NO WALL');
check('verdict tagged RUST clean → NO WALL', burstQaVerdict(['#1 BOT#staff: [RUST] OK · 800ms']), 'NO WALL');
check('verdict tagged EDGE 429 → WALL', burstQaVerdict(['#2 x#y: [EDGE] HTTP 429: too many']), 'WALL');
check('verdict tagged RUST cooldown → WALL', burstQaVerdict(['#3 x#y: [RUST] TRN_RATE_LIMITED 25s']), 'WALL');
// onTransport fires even on pre-transport throws (bun: no Tauri → would-be EDGE, pin cleared).
setTrackerEnabled(true);
resetTrnCooldown();
let seenTransport: string | undefined;
await trnGet('/api/v2/valorant/standard/profile/riot/x%23y', {
  onTransport: (t: string) => {
    seenTransport = t;
  },
}).catch(() => {});
check('pre-transport throw still reports would-be EDGE', seenTransport, 'EDGE');
check('no-callback call still throws the same way', await trnGet('/x').then(() => 'no-throw').catch((e: Error) => String(e.message)), 'TRN needs the desktop app.');
// Button wiring (source text, same style as trn-spread-check.ts).
const dashboard = await Bun.file('src/components/DevDashboard.tsx').text();
check('burst button exists', dashboard.includes('Burst QA (12×)'), true);
check('burst fans out concurrently', dashboard.includes('Promise.all('), true);
check('burst goes through trnGet', dashboard.includes('trnGet(trnProfilePath('), true);
check('burst passes onTransport', dashboard.includes('onTransport'), true);
check('burst tags each line with transport', dashboard.includes('[${transport}]'), true);
check('burst renders an EDGE-fired summary', dashboard.includes('transport: EDGE fired'), true);
check('burst renders an all-fallback summary', dashboard.includes('transport: everything fell back to RUST'), true);
check('burst renders a VERDICT line', dashboard.includes('VERDICT: ${burstQaVerdict(lines)}'), true);
// Transport plumbing is display-only: trn.ts still funnels through the one gate.
const trnSrc = await Bun.file('src/utils/trn.ts').text();
check('trnGet accepts onTransport', trnSrc.includes('onTransport'), true);
check(
  'single transport tagged EDGE',
  trnSrc.includes("report('EDGE')") && !trnSrc.includes("report('RUST')"),
  true
);
check('no rust fallback invoke left', !trnSrc.includes("invoke<string>('trn_get'"), true);
check('no session pin left (single transport)', !trnSrc.includes('edgeDirectBlocked'), true);
check(
  'no pin/transient shim left',
  !trnSrc.includes('isEdgePinnedFailure') && !trnSrc.includes('isEdgeTransientFailure'),
  true
);

// --- hidden same-origin proxy: the SOLE TRN transport (no Rust HTTP) ---
check('edgeGet goes through the hidden proxy', trnSrc.includes("invoke<string>('trn_proxy_fetch'"), true);
check('no direct api fetch left in trn.ts', trnSrc.includes('https://api.tracker.gg'), false);
const proxySrc = await Bun.file('src-tauri/src/trn_proxy.rs').text();
check('proxy window hidden', proxySrc.includes('.visible(false)'), true);
check('proxy window off taskbar', proxySrc.includes('.skip_taskbar(true)'), true);
check('proxy window never focused', proxySrc.includes('.focused(false)'), true);
check('proxy sits on tracker.gg origin', proxySrc.includes('https://tracker.gg/'), true);
check('proxy fetch sends page cookies', proxySrc.includes("credentials:'include'"), true);
check('proxy pauses on game fullscreen', proxySrc.includes('EDGE_PAUSED game fullscreen'), true);
check('proxy timeout surfaces (no silent fallback)', proxySrc.includes('EDGE_PAUSED proxy timeout'), true);
check('proxy HTTP error shapes (`HTTP {code}`)', proxySrc.includes('HTTP {}: {}'), true);
check('proxy path rules accept /api/ only', proxySrc.includes('!path.starts_with("/api/")'), true);
const trackerRs = await Bun.file('src-tauri/src/tracker.rs').text();
check('rust trn_get command deleted', !trackerRs.includes('pub async fn trn_get'), true);
check('no trn_client users left in tracker', !trackerRs.includes('trn_client'), true);
const libSrc = await Bun.file('src-tauri/src/lib.rs').text();
check('proxy module wired', libSrc.includes('mod trn_proxy'), true);
check('proxy command registered', libSrc.includes('trn_proxy::trn_proxy_fetch'), true);
check('rust trn_get unwired', !libSrc.includes('tracker::trn_get'), true);
check('trn_client module deleted', !libSrc.includes('mod trn_client'), true);
const capSrc = await Bun.file('src-tauri/capabilities/default.json').text();
check('proxy window in capability', capSrc.includes('trn-proxy'), true);

// --- readiness gate: passive, per window lifetime, bounded, EDGE_PAUSED ---
// No live tracker.gg calls here — pure helpers + source text only.
check('readiness timeout shape exported', TRN_PROXY_NOT_READY, 'EDGE_PAUSED proxy not ready');
check('readiness helper detects the shape', isTrnProxyNotReady(new Error('EDGE_PAUSED proxy not ready: page still loading or challenged')), true);
check('readiness helper ignores other errors', isTrnProxyNotReady(new Error('HTTP 429: limited')), false);
check('readiness helper handles strings', isTrnProxyNotReady('EDGE_PAUSED proxy not ready: x'), true);
check('readiness shape never trips the ladder', !TRN_PROXY_NOT_READY.includes('429') && !TRN_PROXY_NOT_READY.includes('403') && !TRN_PROXY_NOT_READY.includes('1015'), true);
check('readiness helper wired in trn.ts', trnSrc.includes('isTrnProxyNotReady'), true);
check('readiness gate waits before first fetch', proxySrc.includes('wait_proxy_ready(&window).await?'), true);
check('readiness is per window lifetime', proxySrc.includes('PROXY_READY.store(false'), true);
check('ready window skips the gate', proxySrc.includes('PROXY_READY.load('), true);
check('readiness expiry is EDGE_PAUSED', proxySrc.includes('EDGE_PAUSED proxy not ready'), true);
check('readiness probe reads load state', proxySrc.includes("document.readyState==='complete'"), true);
check('readiness probe reads the cookie jar', proxySrc.includes('document.cookie'), true);
check('readiness probe checks challenge markers', proxySrc.includes('challenges.cloudflare.com'), true);
check('readiness probe fires no fetch', !proxySrc.split('fn readiness_probe')[1].split('fn parse_readiness')[0].includes('fetch('), true);
check('readiness probe hits no api path', !proxySrc.split('fn readiness_probe')[1].split('fn parse_readiness')[0].includes('/api/'), true);

// --- pause gate: in-match fullscreen only, never lobby/agent-select/menus ---
// Behavioral: the TS phase hint round-trips (tracker poll loop stamps it;
// edgeGet sends it — source-text below proves both ends).
setTrnMatchPhase('pregame');
check('phase hint round-trips pregame', getTrnMatchPhase(), 'pregame');
setTrnMatchPhase('coregame');
check('phase hint round-trips coregame', getTrnMatchPhase(), 'coregame');
setTrnMatchPhase('idle');
check('phase hint round-trips idle', getTrnMatchPhase(), 'idle');
setTrnMatchPhase('');
const trackerSrc = await Bun.file('src/utils/tracker.ts').text();
check('edgeGet sends the phase hint', trnSrc.includes("{ path, phase: trnMatchPhase, drain }"), true);
check('poll loop stamps live phase', trackerSrc.includes('setTrnMatchPhase(phase)'), true);
check('idle path stamps idle (no stale coregame pause)', trackerSrc.includes("setTrnMatchPhase('idle')"), true);
check('pause gate reads the phase', proxySrc.includes('game_foreground: bool, phase: &str'), true);
check('pause is foreground-only (no rect check)', proxySrc.includes('fn game_has_focus') && !proxySrc.includes('is_window_borderless_fullscreen'), true);
check('tabbed-out never pauses (sees Recon, zero FPS risk)', proxySrc.includes('"tabbed-out phase: {phase}"'), true);
check('pregame never pauses', proxySrc.includes('"pregame" | "lobby" | "menu" | "menus" | "idle" => false'), true);
check('in-match pause keeps EDGE_PAUSED shape', proxySrc.includes('EDGE_PAUSED game fullscreen'), true);

// --- watchdog: liveness ping + destroy/recreate + visible state ---
// Proven live wedge: window exists but answers no eval within 2s. The ping
// reuses the passive readiness probe (DOM reads only) — zero API calls.
// Behavioral: the TS state allowlist; the wedge verdict lives in Rust cargo
// tests (needs no window); wiring below is source text.
check('proxy state READY parses', parseTrnProxyState('READY'), 'READY');
check('proxy state CHALLENGED parses', parseTrnProxyState('CHALLENGED'), 'CHALLENGED');
check('proxy state RECREATED parses', parseTrnProxyState('RECREATED'), 'RECREATED');
check('proxy state PAUSED parses', parseTrnProxyState('PAUSED'), 'PAUSED');
check('proxy state UNKNOWN parses', parseTrnProxyState('UNKNOWN'), 'UNKNOWN');
check('proxy state garbage → UNKNOWN', parseTrnProxyState('wedged??'), 'UNKNOWN');
check('proxy state empty → UNKNOWN', parseTrnProxyState(''), 'UNKNOWN');
check('proxy state null → UNKNOWN', parseTrnProxyState(null), 'UNKNOWN');
check('proxy state undefined → UNKNOWN', parseTrnProxyState(undefined), 'UNKNOWN');
check('watchdog budget is 2s', proxySrc.includes('WATCHDOG_TIMEOUT: Duration = Duration::from_secs(2)'), true);
check('watchdog ping reuses the passive probe', proxySrc.includes('readiness_probe(), WATCHDOG_TIMEOUT'), true);
check('watchdog pings every fetch on vetted windows', proxySrc.includes('ensure_proxy_alive(&app, &mut window).await?'), true);
check('fresh windows skip the ping (gate vets them)', proxySrc.includes('if !PROXY_READY.load(Ordering::Relaxed)'), true);
check('wedge destroys (not close — close is hide-trapped)', proxySrc.includes('w.destroy()'), true);
check('recreate resets readiness + marks RECREATED', proxySrc.includes('set_proxy_state(ProxyState::Recreated)'), true);
check('answered fetch marks READY', proxySrc.includes('set_proxy_state(ProxyState::Ready)'), true);
check('readiness expiry marks CHALLENGED', proxySrc.includes('set_proxy_state(ProxyState::Challenged)'), true);
check('pause marks PAUSED', proxySrc.includes('set_proxy_state(ProxyState::Paused)'), true);
check('state command registered', libSrc.includes('trn_proxy::trn_proxy_state'), true);
check('dashboard reads proxy state', dashboard.includes('trnProxyState'), true);
check('dashboard renders the proxy line', dashboard.includes('qaProxyOut'), true);
check('no rust trn http in watchdog path', !proxySrc.includes('reqwest') && !proxySrc.includes('ureq') && !proxySrc.includes('hyper'), true);

// --- dev-only TRN logging: [TRN] prefix + timestamps, zero prod output ---
// Shapes only (no runtime log capture): helper exists, call sites are gated,
// Rust compiles out in release. Lines flow to console (dev) + the buffered
// log export — no new dashboard surface per ponytail.
check('trnLog helper exported', trnSrc.includes('export function trnLog(event: string'), true);
check('trnGet start logged (path)', trnSrc.includes("if (import.meta.env.DEV) trnLog('trnGet start'"), true);
check('gate wait logged (ms)', trnSrc.includes("trnLog('gate waited'"), true);
check('cooldown fail-fast logged', trnSrc.includes("trnLog('cooldown fail-fast'"), true);
check('transport + outcome logged', trnSrc.includes('transport=EDGE status=ok elapsed='), true);
check('fallback reason logged', trnSrc.includes("trnLog('fallback'"), true);
check('fill start logged (count, budget)', trackerSrc.includes("if (import.meta.env.DEV) trnLog('fill start'"), true);
check('fill dispatched logged (budget)', trackerSrc.includes("trnLog('fill dispatched'"), true);
check('rust trace macro exists', proxySrc.includes('macro_rules! trn_trace'), true);
check('rust trace compiled out in release', proxySrc.includes('#[cfg(not(debug_assertions))]'), true);
check('rust fetch start logged', proxySrc.includes('trn_trace!("fetch start'), true);
check('rust transitions logged', proxySrc.includes('trn_trace!("RECREATED') && proxySrc.includes('trn_trace!("READY') && proxySrc.includes('trn_trace!("NOT READY'), true);
check('rust outcome logged (status, ms)', proxySrc.includes('trn_trace!("outcome ok='), true);
check('rust never logs bodies', !proxySrc.includes('trn_trace!("outcome ok={} status={} body'), true);

// --- pause costs zero: pre-check before gate claim AND budget spend ---
// Live proof: paused fills burned 2.6s→25s+ gate waits + full lobby budget.
// Behavioral: fail-open false with no Tauri (bun). Ordering: source text.
check('paused shape const', TRN_PROXY_PAUSED, 'EDGE_PAUSED game fullscreen');
check('pre-check fail-open with no Tauri', await trnProxyPaused(), false);
check(
  'pause pre-check runs before gate claim',
  trnSrc.indexOf('await trnProxyPaused()') !== -1 &&
    trnSrc.indexOf('await trnProxyPaused()') < trnSrc.indexOf('const gap = trnJitterGapMs()'),
  true
);
check('pre-check throws the paused shape', trnSrc.includes('throw new Error(TRN_PROXY_PAUSED)'), true);
check('race refund frees the slot', trnSrc.includes('msg.includes(TRN_PROXY_PAUSED) && trnNextSlot === slot + gap'), true);
check('pre-check invoke is windowless (no eval)', trnSrc.includes("invoke<boolean>('trn_proxy_paused'"), true);
check('rust pre-check command exists', proxySrc.includes('pub fn trn_proxy_paused'), true);
check('pre-check command registered', libSrc.includes('trn_proxy::trn_proxy_paused'), true);

// --- drain split: dispatched fill finishes across the flip, new fills gate ---
// Drained players carry drain:true (fill → act stats → trnGet → edgeGet →
// Rust skips pause); everything else stays gated. Ladder/cooldown/caches/
// dedup/budget untouched.
check(
  'drain skips only the pause pre-check',
  trnSrc.includes('opts?.drain !== true && (await trnProxyPaused())'),
  true
);
check('drain reaches the transport', trnSrc.includes('{ path, phase: trnMatchPhase, drain }'), true);
check('drain flows through act stats', trnSrc.includes('{ drain: true }'), true);
check('QA burst bypasses pause (tests transport, not policy)', dashboard.includes('drain: true });'), true);
check('rust fetch takes the drain token', proxySrc.includes('drain: Option<bool>'), true);
check('rust skips pause on drain', proxySrc.includes('if drain {'), true);
check(
  'new fills gate at enqueue (nothing fresh while paused)',
  trackerSrc.indexOf('if (await trnProxyPaused())') !== -1 &&
    trackerSrc.indexOf('if (await trnProxyPaused())') < trackerSrc.indexOf('const budgeted = orderSpreadQueue'),
  true
);
check('dispatched firings carry drain', trackerSrc.includes('fetchTrnStatsNow(puuid, name, tag, true)'), true);

// --- atomic fill job: descendants inherit drain until settle, then re-gate ---
// Behavioral (pure module state, no Tauri): open → inherit (case-insensitive)
// → stale settle no-ops → owner settle re-engages pause.
const jobGen = openTrnDrainJob(['Alice#1', 'Bob#2']);
check('job open returns a generation', jobGen > 0, true);
check('job member inherits drain', trnDrainFor('Alice', '1'), true);
check('job match is case-insensitive', trnDrainFor('alice', '1'), true);
check('job outsider stays gated', trnDrainFor('Zed', '9'), false);
check('explicit token wins without a job', trnDrainFor('Zed', '9', true), true);
closeTrnDrainJob(jobGen + 999);
check('stale settle never kills the job', trnDrainFor('Alice', '1'), true);
closeTrnDrainJob(jobGen);
check('owner settle re-engages pause', trnDrainFor('Alice', '1'), false);
check('explicit token still wins after settle', trnDrainFor('Alice', '1', true), true);
check('detail fns take the drain token', trnSrc.split('opts?: { drain?: boolean }').length - 1 >= 4, true);
check('fill opens one job per dispatching lobby', trackerSrc.includes('openTrnDrainJob(players.map'), true);
check('quiesced lobby settles its own job', trackerSrc.includes('closeTrnDrainJob(trnDrainGen)'), true);
check('stale polls settle nothing', trackerSrc.includes('matchId === trnDrainMatchId'), true);

// --- dead-network breaker: consecutive status-0 deaths go quiet ---
// Live proof: every proxy fetch died pre-status ("in-page fetch failed",
// zero HTTP codes) and retried forever with 2s→13s+ gate waits. The breaker
// fails quiet for 5 min after 5 straight deaths — no network, no gate wait,
// no budget spend. Ladder (429/403/1015) untouched and separate.
check('net-dead marker const', TRN_NET_DEAD_MARK, 'in-page fetch failed');
check('net-dead detects the status-0 shape', isTrnNetDead('Error: EDGE_PAUSED in-page fetch failed: Failed to fetch'), true);
check('net-dead ignores the pause shape', isTrnNetDead(new Error('EDGE_PAUSED game fullscreen')), false);
check('quiet starts closed', isTrnDeadQuiet(), false);
check('quiet shape carries no ladder substring', !/429|403|1015/.test(TRN_DEAD_QUIET), true);
check('streak trips at 5', TRN_DEAD_STREAK_MAX, 5);
check('quiet lasts 5 minutes', TRN_DEAD_QUIET_MS, 5 * 60 * 1000);
check(
  'quiet check runs before pause pre-check',
  trnSrc.indexOf('isTrnDeadQuiet()') !== -1 &&
    trnSrc.indexOf('if (isTrnDeadQuiet())') < trnSrc.indexOf('await trnProxyPaused()'),
  true
);
check('success resets the streak', trnSrc.includes('An answered request proves the path is alive — reset the dead breaker.'), true);
check('streak engages quiet', trnSrc.includes('trnDeadQuietUntil = Date.now() + TRN_DEAD_QUIET_MS'), true);
check('fill spends no budget while quiet', trackerSrc.includes('trnCooldownRemainingMs() > 0 || isTrnDeadQuiet()'), true);

// --- both 451 flavors count as private (root + segments) ---
// Live proof: CollectorResultStatus (profile) was swallowed by `.catch(() => null)`
// so segments fired anyway, and StandardApiV2 (segments) never matched the
// detector — privates retried every lobby. Both now back off 7d flagged.
check(
  'private detector matches the profile flavor',
  isTrnPrivateError('HTTP 451: {"errors":[{"code":"CollectorResultStatus::Private","message":"This profile is still private."}]}'),
  true
);
check(
  'private detector matches the segment flavor',
  isTrnPrivateError('HTTP 451: {"errors":[{"code":"StandardApiV2::Private","message":"Profile stats are private."}]}'),
  true
);
check('private detector ignores 429s', isTrnPrivateError('HTTP 429: limited'), false);
check('private root skips segments', trnSrc.includes('if (isTrnPrivateError(e)) throw e;'), true);

// --- central negative registry: no path refires a proven private/missing ---
// Live proof: only the lobby fill consulted backoff — Overview, modals,
// maps/agents tabs, and the enrichment hook refired 451/404s on every open.
check('player key lowercases', trnPlayerKey('  Lil Ga7ed ', 'ZNGR'), 'lil ga7ed#zngr');
check('unknown player not blocked', trnNegativeBlocked('Nobody', '0000'), false);
check('negative shape carries no ladder substring', !/429|403|1015/.test(TRN_NEGATIVE_BACKOFF), true);
check('private window is 7d', TRN_NEG_PRIVATE_MS === 7 * 24 * 60 * 60 * 1000, true);
check('missing window is 24h', TRN_NEG_MISSING_MS === 24 * 60 * 60 * 1000, true);
trnNoteNegative('NegAudit', '0001', 'private');
check('noted private blocks', trnNegativeBlocked('NegAudit', '0001'), true);
check('block is case-insensitive', trnNegativeBlocked('negaudit', '0001'), true);
check('kind reports private for noted private', trnNegativeKind('NegAudit', '0001') === 'private', true);
check('kind reports null for unknown', trnNegativeKind('Nobody', '0000'), null);
check(
  'every player fetch consults the registry first',
  trnSrc.split('trnNegativeBlocked(name, tag)').length - 1 >= 6,
  true
);
check('fill writer notes privates centrally', trackerSrc.includes("trnNoteNegative(realName, realTag, 'private')"), true);
check('fill writer notes missing centrally', trackerSrc.includes("trnNoteNegative(realName, realTag, 'missing')"), true);

// --- central writer: any path's outcome records, parsed from the path ---
// Live proof: 451s kept arriving minutes apart because only the fill catch
// wrote negatives — views/modals/tabs/enrichment never did.
const priv451 = 'HTTP 451: {"errors":[{"code":"CollectorResultStatus::Private"}]}';
check('path parse extracts the player', JSON.stringify(trnPlayerFromPath('/api/v2/valorant/standard/profile/riot/Lil%20Ga7ed%23zngr')), JSON.stringify({ name: 'Lil Ga7ed', tag: 'zngr' }));
check('path parse skips match-detail paths', trnPlayerFromPath('/api/v2/valorant/standard/matches/abc-123'), null);
check('central writer notes private from any path', noteNegativeFromPath('/api/v2/valorant/standard/profile/riot/Priv%23A1', priv451), 'private');
check('noted-via-path blocks fetches', trnNegativeBlocked('Priv', 'A1'), true);
check(
  'central writer notes missing from 404',
  noteNegativeFromPath('/api/v2/valorant/standard/profile/riot/Gone%23B2', 'HTTP 404: nope'),
  'missing'
);
check('central writer ignores 429s', noteNegativeFromPath('/api/v2/valorant/standard/profile/riot/Ok%23C3', 'HTTP 429: limited'), null);
check('trnGet catch records centrally', trnSrc.includes('noteNegativeFromPath(path, msg)'), true);

// --- pinned previous acts: frozen history never revalidates ---
// Live complaint: every app open refetched all previous acts though they
// never change. Only the current season keeps 24h (Tracker Score is live).
check('pinned TTL is 365d', trnSrc.includes('TRN_SEASON_PINNED_TTL_MS = 365 * 24 * 60 * 60 * 1000'), true);
check('season fetch takes the pin', trnSrc.includes('seasonId: string, drain = false, pinned = false'), true);
check('reads honor the pin', trnSrc.includes('const ttl = pinned ? TRN_SEASON_PINNED_TTL_MS : SEASON_SEG_TTL_MS;'), true);
check(
  'act stats auto-pin non-current seasons',
  trnSrc.includes('seasonId.toLowerCase() !== defaultSeason.toLowerCase()'),
  true
);

// --- per-path failure backoff: one dead URL burns once per 30s ---
// Live proof: five views chased one player (profile/matches/segments),
// refiring the same dead paths every 1-4s with zero HTTP. Gate/budget/
// cooldown can't stop DIFFERENT callers — the choke is path-keyed here.
noteTrnPathFailed('/api/x-test-path');
check('failed path cools', trnPathCooling('/api/x-test-path'), true);
check('other paths unaffected', trnPathCooling('/api/other-path'), false);
check(
  'path check runs before pause pre-check',
  trnSrc.indexOf('trnPathCooling(path)') !== -1 &&
    trnSrc.indexOf('trnPathCooling(path)') < trnSrc.indexOf('await trnProxyPaused()'),
  true
);
check(
  'failures stamp the path (HTTP or status-0 only)',
  trnSrc.includes("if (msg.includes('HTTP ') || isTrnNetDead(msg)) noteTrnPathFailed(path);"),
  true
);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All Dev QA tests passed.');
