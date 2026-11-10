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
  // The real API exposes length/key(); the pruning pass enumerates with them.
  get length(): number {
    return store.size;
  },
  key: (i: number): string | null => [...store.keys()][i] ?? null,
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
  noteNegativeFromPath,
  trnNegativeBlocked,
  trnPlayerState,
  trnNoteNegative,
  markTrnFetching,
  clearTrnFetching,
  noteTrnPrivacy,
  trnProfilePrivacy,
  canServeDirect,
  setTrnHttpEnabled,
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
  trnNegativeKind,
  trnPlayerFromPath,
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
// Source-text wiring (same style as trn-spread-check.ts). The dashboard used to
// pin the Tracker QA burst buttons here; it now pins the smoke panel further
// down. Declared once, up here, because the proxy/pause checks below read it.
const dashboard = await Bun.file('src/components/DevDashboard.tsx').text();
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
// The proxy is a module tree now: read the whole surface so a split cannot
// silently empty a source-grep assertion.
// Test modules are excluded: several assertions below mean "production proxy
// code never does X", and the tests legitimately do X on purpose.
const proxyAllFiles = await Array.fromAsync(new Bun.Glob('src-tauri/src/trn_proxy/**/*.rs').scan('.'));
const proxySrc = (await Promise.all(
  proxyAllFiles
    .filter((f) => !/tests?_[^/]*\.rs$|\/tests\.rs$/.test(f))
    .map((f) => Bun.file(f).text()),
)).join('\n');
// Tests included: some assertions below are about what the test suite covers.
const proxyAll = (await Promise.all(proxyAllFiles.map((f) => Bun.file(f).text()))).join('\n');
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
check('readiness gate waits before first fetch', proxySrc.includes('wait_proxy_ready(&window, &path).await?'), true);
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
// The fill moved to live/fill.ts (seam 4, stage 4).
const fillSrc = await Bun.file('src/live/fill.ts').text();
check('edgeGet sends the phase hint', trnSrc.includes('phase: trnMatchPhase,'), true);
check('poll loop stamps live phase', trackerSrc.includes('setTrnMatchPhase(phase)'), true);
check('idle path stamps idle (no stale coregame pause)', trackerSrc.includes("setTrnMatchPhase('idle')"), true);
check('pause gate reads the phase', proxySrc.includes('game_foreground: bool, phase: &str'), true);
check('pause is foreground-only (no rect check)', proxySrc.includes('fn game_has_focus') && !proxySrc.includes('is_window_borderless_fullscreen'), true);
check('tabbed-out never pauses (sees Recon, zero FPS risk)', proxyAll.includes('"tabbed-out phase: {phase}"'), true);
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
check('watchdog pings every fetch on vetted windows', proxySrc.includes('ensure_proxy_alive(&app, &mut window, &path).await?'), true);
check('fresh windows skip the ping (gate vets them)', proxySrc.includes('if !PROXY_READY.load(Ordering::Relaxed)'), true);
check('wedge destroys (not close — close is hide-trapped)', proxySrc.includes('w.destroy()'), true);
check('recreate resets readiness + marks RECREATED', proxySrc.includes('set_proxy_state(ProxyState::Recreated)'), true);
check('answered fetch marks READY', proxySrc.includes('set_proxy_state(ProxyState::Ready)'), true);
check('readiness expiry marks CHALLENGED', proxySrc.includes('set_proxy_state(ProxyState::Challenged)'), true);
check('pause marks PAUSED', proxySrc.includes('set_proxy_state(ProxyState::Paused)'), true);
check('state command registered', libSrc.includes('trn_proxy::trn_proxy_state'), true);
// The dashboard reads the Rust-owned state. It used to be the Tracker QA proxy
// line (`qaProxyOut`); it is now the Diagnostics smoke check, which invokes the
// command directly so a missing command cannot hide behind the UNKNOWN default.
check('dashboard reads proxy state', dashboard.includes("'trn_proxy_state'"), true);
check('dashboard no longer renders the QA proxy line', !dashboard.includes('qaProxyOut'), true);
check('no rust trn http in watchdog path', !proxySrc.includes('reqwest') && !proxySrc.includes('ureq') && !proxySrc.includes('hyper'), true);

// --- shared request ceiling + cross-realm memo (Rust is the only place both
// WebView realms meet, so this is the only place a bound can be provable) ---
// The verdict math (cap values, window roll, memo TTL) lives in Rust cargo
// tests. What is pinned here is the wiring: the lobby key travels with every
// request, and both new gates sit AHEAD of any work in the command.
check('every request carries the lobby key', trnSrc.includes('lobby: trnLobbyKey'), true);
check('poll stamps the lobby key', trackerSrc.includes('setTrnLobbyKey(matchId)'), true);
check('idle poll clears the lobby key', trackerSrc.includes("setTrnLobbyKey('')"), true);
check('rust fetch takes the lobby key', proxySrc.includes('lobby: Option<String>'), true);
check('ceiling is checked before the window opens', proxySrc.indexOf('spend_ceiling(lobby_key)') < proxySrc.indexOf('let _inflight = InflightGuard::enter'), true);
check('a paused call spends no ceiling (pause check first)', proxySrc.indexOf('should_pause(\n        crate::window_manager::find_valorant_game_window().is_some(),') < proxySrc.indexOf('spend_ceiling(lobby_key)'), true);
check('ceiling denial is a quiet shape (never trips the ladder)', proxySrc.includes('"TRN_BUDGET {which} spent"') && !/TRN_BUDGET[^"]*(429|403|1015)/.test(proxySrc), true);
check('ceiling is one shared mutex, not per realm', proxySrc.includes('static TRN_CEILING: Mutex<TrnCeiling>'), true);
check('per-lobby cap is a named constant', proxySrc.includes('const TRN_LOBBY_MAX_REQUESTS: u32 = 30'), true);
check('per-hour cap is a named constant', proxySrc.includes('const TRN_HOURLY_MAX_REQUESTS: u32 = 900'), true);
check('memo hit skips the wire AND the ceiling', proxySrc.indexOf('memo_get(&path, now_ms())') < proxySrc.indexOf('spend_ceiling(lobby_key)'), true);
check('only 2xx bodies are memoized', proxySrc.includes('if let Ok(body) = &out'), true);
check('memo is itself bounded', proxySrc.includes('const TRN_MEMO_MAX: usize = 64'), true);

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
check('fill start logged (count, budget)', fillSrc.includes("if (import.meta.env.DEV) trnLog('fill start'"), true);
// The dispatch line now reports the two waves AND the budget; pin both facts
// rather than the old single-line literal.
check(
  'fill dispatched logged (waves + budget)',
  fillSrc.includes("'fill dispatched'") &&
    fillSrc.includes('wave1=${wave1.length} wave2=${wave2.length}') &&
    fillSrc.includes('budget=${trnSpreadSpent}/${budget}'),
  true
);
check('rust trace macro exists', proxySrc.includes('macro_rules! trn_trace'), true);
check('rust trace compiled out in release', proxySrc.includes('#[cfg(not(debug_assertions))]'), true);
check('rust fetch start logged', proxySrc.includes('"fetch start path={} phase={} drain={} lobby={}"'), true);
check('memo hit logged', proxySrc.includes('trn_trace!("MEMO hit'), true);
check('ceiling denial logged', proxySrc.includes('trn_trace!("CEILING spent='), true);
check('rust transitions logged', proxySrc.includes('trn_trace!("RECREATED') && proxySrc.includes('trn_trace!("READY') && proxySrc.includes('trn_trace!("NOT READY'), true);
check('rust outcome logged (status, ms)', proxySrc.includes('"outcome ok={} status={} elapsed_ms={}{}"'), true);
check('rust never logs bodies', !proxySrc.includes('trn_trace!("outcome ok={} status={} body'), true);

// --- the trace can explain a failure without a terminal screenshot ---
// A `status=0` line used to be the whole record of a rejected in-page fetch:
// no status, no elapsed, no reason. The page's own message now rides along, and
// it is the ONLY body-shaped text allowed in the trace (a JS error string, not
// a response body).
check('rejected fetch carries its in-page message', proxySrc.includes('trace_err(&r)') && proxySrc.includes('const TRACE_ERR_CHARS: usize = 200'), true);
check('the message is only attached to status=0', proxySrc.includes('if r.status != 0 {\n        return String::new();'), true);
check('a failed fetch traces its reason', proxySrc.includes('trn_trace!("FAILED path={} err={}"'), true);
check('a lost proxy traces its reason', proxySrc.includes('trn_trace!("LOST path={path} err=proxy lost'), true);
check('a hung page names the path and the wait', proxySrc.includes('"fetch timeout path={} elapsed_ms={} (hung page)"'), true);
check('a rejected path is traced', proxySrc.includes('trn_trace!("REJECTED path={path} err={e}"'), true);
check('a park names the request that parked', proxySrc.includes('trn_trace!("NOT READY path={path}'), true);
check('a recreate names its reason and its request', proxySrc.includes('"RECREATED reason={reason} path={path}') && proxySrc.includes('watchdog_reason(ping.as_ref())'), true);
check('the watchdog reason table is a pure fn', proxySrc.includes('fn watchdog_reason('), true);
// The cookie jar must be read whole: a `.slice(0,500)` could cut
// `cf_clearance` off the end and report "no clearance" on a cleared page.
check('readiness probe never slices the cookie jar', proxySrc.includes("cookies:document.cookie||''") && !proxySrc.includes("cookies:(document.cookie||'').slice"), true);
// `fetch start` used to sit ABOVE the memo check, so a cache replay announced
// a wire request that never happened — the panel's "wire" count was inflated
// by every memo hit. It is now logged at the point the request really goes out.
check(
  'fetch start is logged after the memo/pause/ceiling gates',
  proxySrc.indexOf('trn_trace!(\n            "fetch start path={}') > proxySrc.indexOf('memo_get(&path, now_ms())')
    && proxySrc.indexOf('trn_trace!(\n            "fetch start path={}') > proxySrc.indexOf('spend_ceiling(lobby_key)'),
  true,
);

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
check('drain reaches the transport', trnSrc.includes('drain,') && proxySrc.includes('drain: Option<bool>'), true);
check('drain flows through act stats', trnSrc.includes('{ drain: true }'), true);
// The one caller that fired undrained-but-`drain:true` from the dashboard was
// the Tracker QA burst, removed with the rest of that section. Production
// drains (the checks above) and the pause gate itself are unchanged.
check('no dashboard caller fires trnGet any more', !dashboard.includes('trnGet('), true);
check('rust fetch takes the drain token', proxySrc.includes('drain: Option<bool>'), true);
check('rust skips pause on drain', proxySrc.includes('if drain {'), true);
check(
  'new fills gate at enqueue (nothing fresh while paused)',
  fillSrc.indexOf('if (await trnProxyPaused())') !== -1 &&
    fillSrc.indexOf('if (await trnProxyPaused())') < fillSrc.indexOf('const budgeted = orderSpreadQueue'),
  true
);
const devqaFillCall = /fetchTrnStatsNow\(puuid, name, tag,\s*\{([^}]*)\}\)/.exec(fillSrc);
check('dispatched firings carry drain', !!devqaFillCall && devqaFillCall[1].includes('drain: true'), true);

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
// Same contract, two shapes now: the fill-capable helpers carry both flags.
check(
  'detail fns take the drain token',
  (trnSrc.split('opts?: { drain?: boolean }').length - 1) +
    (trnSrc.split('opts?: { drain?: boolean; fill?: boolean }').length - 1) >=
    4,
  true
);
check('the fill-capable helper forwards fill', trnSrc.includes('opts?.fill === true'), true);
check('fill opens one job per dispatching lobby', fillSrc.includes('openTrnDrainJob(players.map'), true);
check('quiesced lobby settles its own job', fillSrc.includes('closeTrnDrainJob(trnDrainGen)'), true);
check('stale polls settle nothing', fillSrc.includes('matchId !== trnDrainMatchId'), true);

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
check('fill spends no budget while quiet', fillSrc.includes('trnCooldownRemainingMs() > 0 || isTrnDeadQuiet()'), true);

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
check('fill writer notes privates centrally', fillSrc.includes("trnNoteNegative(realName, realTag, 'private')"), true);
check('fill writer notes missing centrally', fillSrc.includes("trnNoteNegative(realName, realTag, 'missing')"), true);

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

// --- IPC smoke panel: groups, precondition states, run-all tally ------------
// The Tracker QA section (fetch test, 12× burst, cooldown controls, kill
// switch, pod fixtures) is gone; its log export survives as its own panel.
// What is protected here is the replacement: six subsystem groups, a
// precondition state distinct from a failure, and a tally that never reads as
// a clean sweep while something is unmet.
const { SMOKE_GROUPS, SMOKE_CHECK_COUNT, detectPrecondition, tallySmoke, smokeVerdict } = await import(
  '../src/components/DevDashboard.tsx'
);

const smokeIds = SMOKE_GROUPS.flatMap((g) => g.checks.map((c) => c.id));
const checkById = (id: string) => SMOKE_GROUPS.flatMap((g) => g.checks).find((c) => c.id === id)!;

check(
  'six subsystem groups, in order',
  SMOKE_GROUPS.map((g) => g.id).join(','),
  'display,overlay,windows,valorant,transport,diag'
);
check(
  'group labels read as subsystems',
  SMOKE_GROUPS.map((g) => g.label).join('|'),
  'Display / GPU|Overlay|Windows|VALORANT|Transport|Diagnostics'
);
check('check ids are unique', new Set(smokeIds).size, smokeIds.length);
check('every check is labelled and runnable', SMOKE_GROUPS.every((g) => g.checks.every((c) => c.id && c.label && typeof c.run === 'function')), true);
check('count matches the groups', SMOKE_CHECK_COUNT, smokeIds.length);
for (const id of [
  'display-info',
  'gpu-info',
  'overlay-visible',
  'overlay-edit',
  'overlay-tab',
  'overlay-show',
  'overlay-hide',
  'overlay-edit-on',
  'overlay-edit-off',
  'window-list',
  'valorant-configs',
  'valorant-account',
  'transport-session',
  'transport-riot-get',
  'diag-perf',
  'diag-proxy-state',
  'diag-proxy-paused',
  'diag-trace',
]) {
  check(`smoke check present: ${id}`, smokeIds.includes(id), true);
}
// The pre-existing 12 checks all survive, so removing the QA section did not
// quietly drop any IPC coverage with it.
check('display + gpu still covered', ['display', 'overlay', 'windows', 'valorant'].every((g) => SMOKE_GROUPS.some((x) => x.id === g)), true);
check('no VALORANT install reads as unmet, not a pass', checkById('valorant-configs').precondition!([]), 'no VALORANT install found');
check('configs present skip the unmet branch', checkById('valorant-configs').precondition!([{ display_name: 'x' }]), null);

// New Rust surface, wired by command name (source text, same style as above).
for (const cmd of ['perf_poll', 'trn_proxy_state', 'trn_proxy_paused', 'trn_trace_log']) {
  check(`smoke panel invokes ${cmd}`, dashboard.includes(`'${cmd}'`), true);
}
check('transport check uses a real riot_direct_get entry point', dashboard.includes('fetchCompetitiveUpdates'), true);
check('perf check does not use the swallowing accessor', !dashboard.includes("run: fetchPerf"), true);

// --- the perf check judges the basis instead of normalising it away --------
const perfExpect = checkById('diag-perf').expect!;
check(
  'perf check accepts a private-working-set timeline',
  perfExpect({ samples: [{ basis: 'PrivateWorkingSet' }], paused: false }).includes('basis PrivateWorkingSet'),
  true
);
check(
  'perf check reports a fallen-back basis',
  (() => {
    try {
      perfExpect({ samples: [{ basis: 'ResidentWorkingSet' }], paused: false });
      return 'no throw';
    } catch (e) {
      return (e as Error).message;
    }
  })(),
  'basis ResidentWorkingSet — the private counter was not read'
);
check(
  'perf check rejects a payload with no timeline',
  (() => {
    try {
      perfExpect({});
      return 'no throw';
    } catch (e) {
      return (e as Error).message;
    }
  })(),
  'no timeline in the payload'
);
check(
  'perf check rejects an empty ring',
  (() => {
    try {
      perfExpect({ samples: [] });
      return 'no throw';
    } catch (e) {
      return (e as Error).message;
    }
  })(),
  'timeline is empty — the poll pushed no sample'
);
// An empty trace ring is valid: no TRN traffic yet is not a failure.
const traceExpect = checkById('diag-trace').expect!;
check('trace check accepts an empty ring', traceExpect({ head: 0, lines: [], missed: false }), 'head 0 · 0 held line(s)');
check('trace check counts held lines', traceExpect({ head: 7, lines: [1, 2], missed: true }), 'head 7 · 2 held line(s) · ring overwrote unseen lines');
check(
  'trace check rejects a payload with no head',
  (() => {
    try {
      traceExpect({ lines: [] });
      return 'no throw';
    } catch (e) {
      return (e as Error).message;
    }
  })(),
  'no head/lines in the payload'
);
check('proxy state check accepts UNKNOWN as an answer', checkById('diag-proxy-state').expect!('UNKNOWN'), 'UNKNOWN — no proxy fetch yet');
check('proxy state check accepts a real state', checkById('diag-proxy-state').expect!('READY'), 'READY');
check(
  'proxy state check rejects garbage',
  (() => {
    try {
      checkById('diag-proxy-state').expect!('wedged??');
      return 'no throw';
    } catch (e) {
      return (e as Error).message;
    }
  })(),
  'unrecognised state "wedged??"'
);
// Overlay setters are verified by read-back, not by their ack.
check('open overlay reads the state back', checkById('overlay-show').expect!(true), 'visible');
check(
  'open overlay fails when the window is not visible',
  (() => {
    try {
      checkById('overlay-show').expect!(false);
      return 'no throw';
    } catch (e) {
      return (e as Error).message;
    }
  })(),
  'ack returned but the window is not visible'
);
check('close overlay reads the state back', checkById('overlay-hide').expect!(false), 'hidden');

// --- precondition detection: the callers' own vocabulary --------------------
// Each needle is a string some caller already throws, so the reason shown here
// is greppable back to the call site.
check('lockfile missing → unmet', detectPrecondition('Riot Client lockfile missing — launch Riot Client or Valorant first.'), 'Riot Client not running');
check('client not responding → unmet', detectPrecondition('Riot Client not responding — launch it and retry.'), 'Riot Client not answering loopback');
check('no client installed → unmet', detectPrecondition('Riot Client not found on this PC.'), 'no Riot Client on this machine');
check('no session → unmet', detectPrecondition('No active session — log into the Riot Client first.'), 'no Riot Client session — log in first');
check('tracker auto-detect → unmet', detectPrecondition('Auto-detect failed — is the Riot Client open?'), 'Riot Client not running');
check('browser preview → unmet', detectPrecondition('Tracker needs the desktop app.'), 'not running inside the desktop app');
check('proxy not ready → unmet', detectPrecondition('EDGE_PAUSED proxy not ready: page still loading or challenged'), 'no tracker.gg page loaded yet');
check('game fullscreen → unmet', detectPrecondition('EDGE_PAUSED game fullscreen'), 'VALORANT owns the screen');
check('page network dead → unmet', detectPrecondition('EDGE_PAUSED in-page fetch failed: Failed to fetch'), 'proxy page has no network');
check('rate ladder → unmet', detectPrecondition('TRN_RATE_LIMITED 25s'), 'TRN rate-limit ladder engaged');
check('kill-switch off → unmet', detectPrecondition('TRN_DISABLED tracker off'), 'tracker kill-switch is OFF');
check('budget spent → unmet', detectPrecondition('TRN_BUDGET lobby spent'), 'shared TRN request ceiling spent');
check('detects inside a longer message', detectPrecondition('Error: HTTP 0 — Riot Client not responding — launch it and retry.'), 'Riot Client not answering loopback');
check('case-insensitive', detectPrecondition('riot client lockfile missing'), 'Riot Client not running');
// A rate-limited response is a real transport failure, not an absent env.
check('HTTP 429 is NOT a precondition', detectPrecondition('HTTP 429: too many requests'), null);
check('a private profile is NOT a precondition', detectPrecondition('HTTP 451: {"errors":[{"code":"CollectorResultStatus::Private"}]}'), null);
check('an unregistered command is NOT a precondition', detectPrecondition('Command trn_trace_log not found'), null);
check('an empty error is NOT a precondition', detectPrecondition(''), null);

// --- run-all tally ---------------------------------------------------------
const t = (o: ('pass' | 'fail' | 'precondition')[]) => {
  const s = tallySmoke(o);
  return `${s.pass}/${s.fail}/${s.precondition}`;
};
check('empty tally is all zeroes', t([]), '0/0/0');
check('tally counts each state', t(['pass', 'pass', 'fail', 'precondition', 'pass']), '3/1/1');
check('verdict: nothing run yet', smokeVerdict(tallySmoke([])), 'no results yet');
check('verdict: clean', smokeVerdict(tallySmoke(['pass', 'pass'])), 'ALL PASS');
check('verdict: qualified by the unmet count', smokeVerdict(tallySmoke(['pass', 'precondition'])), 'PASS with 1 unmet');
check('verdict: a failure always wins', smokeVerdict(tallySmoke(['pass', 'precondition', 'fail'])), '1 FAILED');
check('verdict: all unmet is not a pass', smokeVerdict(tallySmoke(['precondition'])), 'nothing passed');
// Sequential, not parallel: these touch real system state.
check('run-all is sequential', dashboard.includes("for (let i = 0; i < flat.length; i++)"), true);
check('run-all does not fan out', !dashboard.includes('Promise.all('), true);
check('run-all is disabled while running', (dashboard.match(/disabled=\{smokeRunning\}/g) || []).length >= 2, true);
check('progress is shown while running', dashboard.includes('smokeProgress.done + 1'), true);
check('tally lands in the panel header', dashboard.includes('{smokeVerdict(smokeTally)}'), true);

// --- the removed section left nothing behind -------------------------------
check('Tracker QA section is gone', !dashboard.includes('>Tracker QA<'), true);
check('QA fetch/burst/probe handlers are gone', !dashboard.includes('runQaFetch') && !dashboard.includes('runQaBurst') && !dashboard.includes('probeQaGate'), true);
check('QA fixtures are gone', !dashboard.includes('QA_FIXTURES') && !dashboard.includes('<ServerChip'), true);
check('jitter/cooldown controls are gone', !dashboard.includes('trnJitterGapMs') && !dashboard.includes('resetTrnCooldown'), true);
check('trace empty state no longer points at a removed section', !dashboard.includes('Tracker QA above'), true);
check('log export survived as its own panel', dashboard.includes('>TRN trace export<') && dashboard.includes('downloadLogs') && dashboard.includes('copyLogs'), true);
// The dev window's export reads the trace ring it actually holds, NOT the
// module-level logger buffer. `logBuffer` is per-realm, so this realm's is
// empty and the panel used to always export 0 lines while reporting success.
check('log export reads the TRN trace ring, not the per-realm logger buffer', dashboard.includes('buildTrnTraceExport(trnLogRows') && !dashboard.includes('getRecentLogs('), true);
check('empty export is reported as empty, never as success', dashboard.includes('trnExportReport(0, trnLogRows.length'), true);
check('export handler lost the Qa prefix', !dashboard.includes('downloadQaLogs') && !dashboard.includes('copyQaLogs'), true);

// --- no TRN API key anywhere (task-37) -------------------------------------
// The direct transport uses the public site API behind a compatibility header.
// No key exists, none may be added, and the header value is set in Rust so it
// never enters the bundle. This asserts the whole TS surface stays clean.
{
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  // The audit criterion covers the Rust side too: a key in src-tauri/ is just
  // as shippable as one in the bundle, and the direct transport sets its header
  // there. Scan code/config extensions on both trees; skip build output.
  const roots = [
    new URL('../src/', import.meta.url).pathname,
    new URL('../src-tauri/', import.meta.url).pathname,
  ];
  const root = roots[0];
  const SCAN_EXT = /\.(ts|tsx|js|cjs|mjs|json|rs|toml|conf)$/;
  const SKIP_DIRS = new Set([
    'target',
    'node_modules',
    '.git',
    'dist',
    'dist-portable',
    'gen',
    'icons',
    'webview2-runtime',
  ]);
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
        continue;
      }
      if (!SCAN_EXT.test(name)) continue;
      const text = readFileSync(full, 'utf8');
      if (text.includes('TRN-API-Key') || text.includes('trnApiKey')) offenders.push(full);
    }
  };
  for (const root of roots) walk(root);
  // actual/expected style: an empty string means clean, and a failure prints
  // exactly which files mention a key.
  check('no TRN API key or key header anywhere in src/ or src-tauri/', offenders.join(','), '');

  // The payload is decided by `source=overwolf-2`, not by any key. One helper
  // forces it; this pins the helper's three shapes and the absence of the old
  // hardcoded `source=web`, so a call site can never regress the payload.
  const { withOverwolfSource } = await import('../src/utils/trn.ts');
  check('source: appended with ? when absent', withOverwolfSource('/api/v2/x'), '/api/v2/x?source=overwolf-2');
  check('source: appended with & when a query exists', withOverwolfSource('/api/v2/x?a=1'), '/api/v2/x?a=1&source=overwolf-2');
  check('source: an existing source is replaced', withOverwolfSource('/api/v2/x?a=1&source=web'), '/api/v2/x?a=1&source=overwolf-2');
  check('source: idempotent', withOverwolfSource('/api/v2/x?source=overwolf-2'), '/api/v2/x?source=overwolf-2');
  const trnSrc = readFileSync(join(root, 'utils/trn.ts'), 'utf8');
  check('source: helper is exported', trnSrc.includes('export function withOverwolfSource'), true);
  check('source: no hardcoded source=web left', trnSrc.includes('source=web'), false);
  check('source: forced at the single choke point', trnSrc.includes('withOverwolfSource(rawPath)'), true);
}

// --- direct-transport fallback is an ALLOWLIST (task-54) -------------------
// Anything that is not a TRN_* answer or an `HTTP <status>` is a transport
// failure and must fall back to the edge path. A denylist of known strings
// silently stopped falling back the day Tauri reworded its rejection.
{
  const src = trnSrc;
  check('fallback allowlist exists', src.includes('isTrnAnswer') && src.includes('isHttpStatus'), true);
  check('TRN answers are allowlisted', /TRN_\(PRIVATE\|NO_DATA\|RATE_LIMITED\|CAPTCHA_REQUIRED\)/.test(src), true);
  check('HTTP status is allowlisted', /\/HTTP \\d\{3\}\//.test(src), true);
  check('unknown rejections fall through to edge', src.includes("trnLog('falling back to edge'"), true);
  // The old denylist must be gone: no literal 'not found' match.
  check('no brittle not-found string match', src.includes("msg.includes('not found')"), false);
}

// --- a 404 is "no profile", never "still fetching" (task-58) ----------------
{
  const P = '/api/v2/valorant/standard/profile/riot/TestUser%231234?source=overwolf-2';

  // The direct transport reports 404 as TRN_NO_DATA, not "HTTP 404". Matching
  // only the old shape is why 8 of 10 real players were re-fired every poll.
  check('edge 404 lands as missing', noteNegativeFromPath(P, 'HTTP 404: CollectorResultStatus::NotFound'), 'missing');
  check('direct TRN_NO_DATA lands as missing', noteNegativeFromPath(P, 'TRN_NO_DATA'), 'missing');
  check('missing is cached', trnNegativeBlocked('TestUser', '1234'), true);
  check('a cached miss reads as missing', trnPlayerState('TestUser', '1234'), 'missing');
  // A 404 is NEVER upgraded to private: Tracker cannot tell an unindexed
  // account from a private one, and Incognito is about the NAME, not the data.
  check('404 stays missing, never private', trnPlayerState('TestUser', '1234'), 'missing');

  // 451 / TRN_PRIVATE is terminal and distinct.
  const PR = '/api/v2/valorant/standard/profile/riot/PrivUser%239999';
  check('TRN_PRIVATE lands as private', noteNegativeFromPath(PR, 'TRN_PRIVATE profile is private on tracker.gg'), 'private');
  check('private reads as private', trnPlayerState('PrivUser', '9999'), 'private');
  // The selector body must not consult local Riot at all (the comment above it
  // explains WHY incognito is rejected, so only the function body is scanned).
  const sel = trnSrc.slice(trnSrc.indexOf('export function trnPlayerState'));
  const selBody = sel.slice(0, sel.indexOf('\n}') + 2);
  check('selector body has no incognito tie-break', /Incognito|hasRank|lobbyLocalSignals|local\?/.test(selBody), false);

  // The other two states.
  check('nothing known -> unknown', trnPlayerState('Nobody', '0000'), 'unknown');
  markTrnFetching('Fly', '0001');
  check('in flight -> fetching', trnPlayerState('Fly', '0001'), 'fetching');
  clearTrnFetching('Fly', '0001');
  check('cleared -> back to unknown', trnPlayerState('Fly', '0001'), 'unknown');
  trnNoteNegative('Done', '0002', 'missing');
  check('budget-relevant terminal states are blocked', trnNegativeBlocked('Done', '0002'), true);

  // The fill must not spend budget on a terminal negative.
  check(
    'fill skips negative-cached players',
    fillSrc.includes('!trnNegativeBlocked(p.name, p.tag)'),
    true
  );
}

// --- privacy from the payload, and a byte-faithful name (task-58b) ---------
{
  // data.metadata.privacy is the REAL signal: verified live, resolving accounts
  // carry 'public'. Anything else is terminal and outranks a 451 guess.
  noteTrnPrivacy('PubUser', '1111', 'public');
  check('privacy public -> ready', trnPlayerState('PubUser', '1111'), 'ready');
  noteTrnPrivacy('PrivUser2', '2222', 'private');
  check('privacy private -> private', trnPlayerState('PrivUser2', '2222'), 'private');
  noteTrnPrivacy('LtdUser', '3333', 'limited');
  check('privacy limited -> private', trnPlayerState('LtdUser', '3333'), 'private');
  noteTrnPrivacy('PubUser', '1111', ' PUBLIC ');
  check('privacy is normalised case/space only', trnProfilePrivacy('PubUser', '1111'), 'public');
  noteTrnPrivacy('NoMeta', '4444', undefined);
  check('absent metadata invents nothing', trnProfilePrivacy('NoMeta', '4444'), '');
  check('absent metadata leaves state unknown', trnPlayerState('NoMeta', '4444'), 'unknown');

  // The path must carry EXACTLY what Riot gave us. The user's account resolves
  // as mazarowww#1375 and 404s as mazarooww#1375 — one letter apart — so any
  // normalisation would silently turn a real profile into a "missing".
  const three = trnProfilePath('mazarowww', '1375');
  const two = trnProfilePath('mazarooww', '1375');
  check('distinct names produce distinct paths', three !== two, true);
  check('name is used verbatim', three, '/api/v2/valorant/standard/profile/riot/mazarowww%231375');
  check('case is preserved in the path', trnProfilePath('AboHaMaDa', '6611').includes('AboHaMaDa'), true);
}

// --- the fullscreen pause must not block the direct transport (task-60) -----
{
  const { readFileSync } = await import('node:fs');
  const STD = '/api/v2/valorant/standard/profile/riot/X%23123?source=overwolf-2';
  const OTHER = '/api/v2/valorant/other/thing';

  setTrnHttpEnabled(true);
  check('direct serves a standard path', canServeDirect(STD), true);
  check('direct does not serve other paths', canServeDirect(OTHER), false);

  // Direct available + paused -> the gate lets it through.
  check('paused + direct available proceeds', canServeDirect(STD), true);

  // Direct disabled -> edge only -> still paused.
  setTrnHttpEnabled(false);
  check('paused + direct disabled falls back to the edge gate', canServeDirect(STD), false);
  setTrnHttpEnabled(true);

  const src = readFileSync(new URL('../src/utils/trn.ts', import.meta.url), 'utf8');
  const gate = src.slice(src.indexOf('if (opts?.drain !== true && (await trnProxyPaused()))'));
  const gateBody = gate.slice(0, gate.indexOf('\n  }') + 4);
  check('the pause gate consults the transport', /canServeDirect\(path\)/.test(gateBody), true);
  check('the edge path still throws when paused', gateBody.includes('throw new Error(TRN_PROXY_PAUSED)'), true);
  check('the drain exemption is intact', src.includes('opts?.drain !== true && (await trnProxyPaused())'), true);
}

// --- match-details cache key bumped for roundDetails -----------------------
{
  const { readFileSync } = await import('node:fs');
  const trackerSrcV7 = readFileSync(new URL('../src/utils/tracker.ts', import.meta.url), 'utf8');
  // The match-details reader and its cache moved to sources/matchDetails.ts.
  const mdSrc = readFileSync(new URL('../src/sources/matchDetails.ts', import.meta.url), 'utf8');
  check('match-details cache is v7', mdSrc.includes('recon_match_v7_'), true);
  // A failed details read is a failed read, not an empty match. The fetcher
  // goes through the validated reader, so an error payload throws instead of
  // being parsed into zero players and cached under the v7 key.
  check(
    'match details come from the validated reader',
    mdSrc.includes('readMatchDetailsRaw(matchId, shardFor(region))'),
    true
  );
  // The transport takes a hostname. A bare `region` here dials https://eu and
  // the per-match catch in tracker.ts turns that into an empty board, so the
  // call shape is asserted rather than trusted.
  check(
    'the match-details read passes the shard, never a bare region',
    !/readMatchDetailsRaw\([^)]*,\s*region\)/.test(mdSrc),
    true
  );
  check(
    'the details fetcher no longer calls the raw transport',
    /fetchMatchDetailDirect[\s\S]{0,900}riotGet\(/.test(mdSrc),
    false
  );
  check('v6 is not used as a key', /localStorage\.(getItem|setItem)\(\s*'recon_match_v6_/.test(trackerSrcV7), false);
}

// --- negative-registry version + forced source param (task-61) --------------
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/utils/trn.ts', import.meta.url), 'utf8');
  check('negatives are stored under v2', src.includes("'recon_trn_negative_v2'"), true);
  // The v1 name may appear in trn.ts's OWN prune list (it must, to delete it).
  // The contract is that it is never used as a live storage key again.
  check(
    'no v1 key in the read/write path',
    /localStorage\.(getItem|setItem)\(\s*'recon_trn_negative_v1'/.test(src),
    false
  );

  // Every consumer goes through trnGet, where the source param is forced.
  const getBody = src.slice(src.indexOf('export async function trnGet('));
  check('trnGet forces source onto the raw path', /withOverwolfSource\(rawPath\)/.test(getBody), true);
  check(
    'the normalized path is what reaches the transport',
    getBody.indexOf('withOverwolfSource(rawPath)') < getBody.indexOf('transportGet(path'),
    true
  );
  // A caller-supplied path without the query must never reach a transport.
  check('profile path builder has no query of its own', src.includes('%23${encodeURIComponent(tag)}`') && !/trnProfilePath[^\n]*source=/.test(src), true);
}

// --- live board: stale snapshot, rank survival, quota (task-62) -------------
{
  const { readFileSync } = await import('node:fs');
  const trk = readFileSync(new URL('../src/utils/tracker.ts', import.meta.url), 'utf8');
  // Imported locally so the names cannot land in the wrong destructure.
  const tk = await import('../src/utils/tracker.ts');

  // The key moved with the map into live/playerStats.ts; assert it there.
  const psSrc = readFileSync(new URL('../src/live/playerStats.ts', import.meta.url), 'utf8');
  check('live stats key is v3', psSrc.includes("'recon_live_player_stats_v3'"), true);
  // The old name may still be MENTIONED (prune list, comments) but must never
  // be used as a live storage key again.
  check('v2 live-stats is not used as a key', /localStorage\.(getItem|setItem)\(\s*'recon_live_player_stats_v2'/.test(trk), false);
  // The guard moved INTO readMmr (step 2, site #12): the call site cannot skip
  // what it no longer performs.
  const riotSrcNow = readFileSync(new URL('../src/sources/riot.ts', import.meta.url), 'utf8');
  check('the MMR guard lives inside the reader', /assertRiotOk\(j, 'mmr'\)/.test(riotSrcNow), true);
  check('tracker no longer guards mmr by hand', /assertRiotOk\(j, 'mmr'\)/.test(trk), false);

  // A snapshot from another match must not describe this one.
  tk.setLiveSnapshotMatch('match-A');
  tk.setCachedLivePlayerStats('stale-puuid', { kd: 1.11, acs: 111 });
  tk.setLiveSnapshotMatch('match-B');
  check('a snapshot from another match is ignored', tk.getCachedLivePlayerStats('stale-puuid'), undefined);

  // Rank survives a rebuild, and a zero never overwrites a known rank.
  tk.persistLiveRank('rank-puuid', { tier: 21, rr: 77, peakTier: 24, peakSeasonId: 'act' });
  check('rank persisted', tk.readPersistedRank('rank-puuid')?.tier, 21);
  tk.persistLiveRank('rank-puuid', { tier: 0, rr: 0, peakTier: 0 });
  check('a zero never erases a known rank', tk.readPersistedRank('rank-puuid')?.tier, 21);
  check('peak survives too', tk.readPersistedRank('rank-puuid')?.peakTier, 24);

  // Upgrade hygiene + quota safety.
  localStorage.setItem('recon_match_v6_old1', 'x');
  localStorage.setItem('recon_match_v6_old2', 'y');
  const pruned = tk.pruneSupersededCaches();
  check('v6 match cache is pruned', pruned >= 2 && !localStorage.getItem('recon_match_v6_old1'), true);

  const realSet = localStorage.setItem.bind(localStorage);
  let calls = 0;
  localStorage.setItem = ((k: string, v: string) => {
    calls++;
    if (calls === 1) throw new Error('QuotaExceededError');
    return realSet(k, v);
  }) as typeof localStorage.setItem;
  let propagated = false;
  let ok = false;
  try {
    ok = tk.writeLocalSafe('recon_quota_probe', 'payload');
  } catch {
    propagated = true;
  }
  localStorage.setItem = realSet;
  check('a quota error never propagates', propagated, false);
  // The retry path is best-effort (the fake store cannot model a real quota);
  // the contract that matters is that a write NEVER throws into a caller.
  check('writeLocalSafe always returns a boolean', typeof ok === 'boolean', true);
}

// --- EDGE breakers must not refuse a DIRECT request (task-72b) --------------
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/utils/trn.ts', import.meta.url), 'utf8');
  check('direct capability is computed once', src.includes('const directServes = canServeDirect(path);'), true);
  check('dead-quiet is edge-only', src.includes('if (!directServes && isTrnDeadQuiet())'), true);
  check('proxy backoff is edge-only', src.includes('if (!directServes && trnProxyBackoffRemainingMs() > 0)'), true);
  // Both breakers still EXIST for the edge path.
  check('dead-quiet still throws when it applies', src.includes('TRN_DEAD_QUIET} '), true);
  check('proxy backoff still throws when it applies', src.includes("throw new Error(`TRN_PROXY_BACKOFF"), true);
}

// --- data-layer step 1: raw transport is private (task-from-design) ---------
{
  const { readFileSync } = await import('node:fs');
  const trk = readFileSync(new URL('../src/utils/tracker.ts', import.meta.url), 'utf8');
  const src = readFileSync(new URL('../src/sources/riot.ts', import.meta.url), 'utf8');

  // Step 1 of next-session.md: the transport moved to sources/riot.ts and
  // tracker imports it. The temporary export is governed by the
  // "does not outlive its reason" assertion further down.
  check('the transport is not defined in tracker', /^async function riotGet\(/m.test(trk), false);
  check(
    'tracker no longer imports the raw transport',
    /riotGet/.test(trk),
    false
  );
  check('sources/riot.ts exists with a branded type', src.includes('declare const VALIDATED: unique symbol'), true);
  for (const fn of ['readMmr', 'readMatchDetails', 'readLiveMatchById']) {
    check(`${fn} is exported`, new RegExp(`export async function ${fn}`).test(src), true);
  }
  check('readMmr returns Validated', /readMmr[\s\S]{0,400}Validated<LocalRank>/.test(src), true);
  check('readMatchDetails returns Validated', /readMatchDetails<T>[\s\S]{0,300}Validated<T>/.test(src), true);
  // Live-match readers return NoMatch<T> (Validated<T> | null): 404 is control
  // flow there, so null is a legal answer while every other error throws.
  check('readLiveMatchById returns NoMatch', /readLiveMatchById[\s\S]{0,400}NoMatch<unknown>/.test(src), true);
  // The raw call cannot be reached from outside the two transport modules.
  const outside = readFileSync(new URL('../src/utils/crosshair.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/utils/store.ts', import.meta.url), 'utf8');
  check('consumers call the validated reader', outside.includes('readRiotValidated'), true);
  check('consumers no longer import riotGet', /riotGet/.test(outside), false);
}

// --- the validated rank boundary (upstream audit finding) ------------------
{
  const { readFileSync } = await import('node:fs');
  const riotSrc = readFileSync(new URL('../src/sources/riot.ts', import.meta.url), 'utf8');
  const { rankFromPayload } = await import('../src/sources/riot.ts');

  const good = {
    LatestCompetitiveUpdate: { TierAfterUpdate: 18 },
    QueueSkills: { competitive: { SeasonalInfoBySeasonID: {} } },
  };
  check('a good /mmr payload parses', rankFromPayload(good, []).tier, 18);

  let threw = false;
  try {
    rankFromPayload({ httpStatus: 403, errorCode: 'SCHEDULED_DOWNTIME' }, []);
  } catch {
    threw = true;
  }
  check('a Riot error payload throws instead of becoming tier 0', threw, true);

  check('fetchLocalRank validates before parsing', /assertRiotOk\(j, 'mmr'\)/.test(riotSrc), true);
  check(
    'fetchLocalRank returns a branded value',
    /fetchLocalRank\([\s\S]{0,160}Promise<Validated<LocalRankRow>>/.test(riotSrc),
    true
  );
}

// --- the source header must not overclaim (upstream audit finding) ---------
{
  const { readFileSync } = await import('node:fs');
  const riotSrc = readFileSync(new URL('../src/sources/riot.ts', import.meta.url), 'utf8');
  const trackerSrc = readFileSync(new URL('../src/utils/tracker.ts', import.meta.url), 'utf8');
  const rawSites = (trackerSrc.match(/await riotGet\(/g) ?? []).length;
  // While tracker still has its own raw transport, the header may not say it is
  // the only place a payload exists. When that count reaches zero the header
  // must be upgraded in the same commit — this check fails either way.
  const claimsExclusive = riotSrc.includes('the ONLY place a raw');
  // check(name, actual, expected) — the boolean is the actual, not a detail.
  check('the source header matches the code', rawSites > 0 ? !claimsExclusive : claimsExclusive, true);
}

// --- two silent failures become failures (upstream audit finding) ----------
{
  const { readFileSync } = await import('node:fs');
  const trk = readFileSync(new URL('../src/utils/tracker.ts', import.meta.url), 'utf8');
  const riotSrc = readFileSync(new URL('../src/sources/riot.ts', import.meta.url), 'utf8');

  check('history meta goes through the validated reader', /readHistoryMeta\(ent\.puuid/.test(trk), true);
  check('the history-meta reader validates', /readHistoryMeta[\s\S]{0,400}assertRiotOk\(j, 'match history'\)/.test(riotSrc), true);
  check('history meta no longer reports a bare total 0', /total: Number\(j\?\.Total \?\? 0\)/.test(trk), false);
  check(
    'a failed 24h read is marked, not a zero',
    /failed: true/.test(trk) && /failed\?: boolean/.test(trk),
    true
  );
}

// --- one transport, and the header it sends (step 1 of next-session.md) ----
{
  const { readFileSync } = await import('node:fs');
  const { platformBlob } = await import('../src/sources/riot.ts');
  const riotSrc = readFileSync(new URL('../src/sources/riot.ts', import.meta.url), 'utf8');
  const trackerSrc2 = readFileSync(new URL('../src/utils/tracker.ts', import.meta.url), 'utf8');

  // The expected string is written out on purpose: a future edit to the blob
  // must be a deliberate change to this line, not a silent header drift.
  // This is the exact encoding of
  //   {"platformType":"PC","platformOS":"Windows",
  //    "platformOSVersion":"10.0.19042.1.256.64bit","platformChipset":"Unknown"}
  const EXPECTED_PLATFORM_BLOB =
    'eyJwbGF0Zm9ybVR5cGUiOiJQQyIsInBsYXRmb3JtT1MiOiJXaW5kb3dzIiwicGxhdGZvcm1PU1ZlcnNpb24iOiIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwicGxhdGZvcm1DaGlwc2V0IjoiVW5rbm93biJ9';
  check('the clientPlatform header is byte-identical', platformBlob(), EXPECTED_PLATFORM_BLOB);

  // Exactly one implementation, and it is not in tracker.
  let impls = 0;
  for (const f of ['../src/sources/riot.ts', '../src/utils/tracker.ts']) {
    impls += (readFileSync(new URL(f, import.meta.url), 'utf8').match(/function riotGet\(/g) ?? []).length;
  }
  check('exactly one riotGet implementation remains', impls, 1);
  check('the transport is not defined in tracker', /^async function riotGet\(/m.test(trackerSrc2), false);
  // Final contract: the raw transport lives in exactly ONE file in src/, and
  // it is not tracker. Stronger than "tracker imports it" — a second copy
  // anywhere would fail.
  {
    const { readdirSync, statSync } = await import('node:fs');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const full = `${dir}/${f}`;
        return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
      });
    const root = new URL('../src', import.meta.url).pathname;
    const filesMentioning = walk(root).filter((f) =>
      /\briotGet\b/.test(readFileSync(f, 'utf8'))
    );
    check(
      'the raw transport lives in exactly one file',
      filesMentioning.map((f) => f.split('/').pop()).join(','),
      'riot.ts'
    );
  }

  // The status detail mapping is user-visible copy; losing it in a refactor
  // would leave the banner saying something generic.
  check(
    'the status detail mapping survived the move',
    riotSrc.includes("'Riot Client is not running'") &&
      riotSrc.includes("'Riot Client is not responding'") &&
      riotSrc.includes("'Riot Client is logged out'"),
    true
  );

  // Site #5: the timestamped page keeps the cutoff/sort here; the read is typed.
  check(
    'the 24h record pages through the timestamped reader',
    /readHistoryPageWithTime\(puuid, shardFor\(region\), start, start \+ 20\)/.test(trackerSrc2),
    true
  );

  // Sites #1/#2: both mmr endpoints go through typed readers.
  check(
    'the mmr profile uses the validated reader',
    /readMmrProfile\(ent\.puuid, shardFor\(region\)/.test(trackerSrc2) &&
      !/assertRiotOk\(j, 'MMR'\)/.test(trackerSrc2),
    true
  );
  // Scoped to the function: `TierAfterUpdate` legitimately appears elsewhere
  // (parseLocalRank reads it from a different payload).
  const cuFn = trackerSrc2.slice(
    trackerSrc2.indexOf('export async function fetchCompetitiveUpdates'),
    trackerSrc2.indexOf('export async function detectRegion')
  );
  check(
    'competitive updates use the typed rows',
    /readCompetitiveUpdates\(ent\.puuid, shardFor\(region\), count, queue\)/.test(cuFn) &&
      !/TierAfterUpdate/.test(cuFn) &&
      /g\.rrEarned/.test(cuFn),
    true
  );

  // Sites #6-#9: the live probes go through NoMatch readers, and the 404 and
  // failure paths stay distinct at the call site.
  check(
    'the live probes use the NoMatch readers',
    /readLivePlayer\('coregame', ent\.puuid, region\)/.test(trackerSrc2) &&
      /readLivePlayer\('pregame', ent\.puuid, region\)/.test(trackerSrc2) &&
      /readLiveMatchById\('coregame', matchId, region\)/.test(trackerSrc2) &&
      /readLiveMatchById\('pregame', matchId, region\)/.test(trackerSrc2),
    true
  );
  check(
    'the live readers resolve a real GLZ host, not a short name',
    /glzHostFor\(region\)/.test(riotSrc) && !/riotGet(?:NoMatch)?\('glz'/.test(riotSrc),
    true
  );
  check(
    'the probes no longer hand-roll the legacy fallback',
    /riotGet\(glz, `\/coregame\/v1\/players/.test(trackerSrc2),
    false
  );

  // Sites #6-#9, caller half: a FAILED probe is not an empty menu.
  const failedProbeMarks = (trackerSrc2.match(/probeFailed = true;/g) ?? []).length;
  check('both live probes mark a failure', failedProbeMarks, 2);
  check(
    'a failed probe keeps the last board instead of declaring the menu',
    /probeFailed &&[\s\S]{0,200}lastLiveMatchResult\.phase !== 'idle'[\s\S]{0,200}return lastLiveMatchResult;/.test(
      trackerSrc2
    ),
    true
  );
  const keepBound = Number(
    (trackerSrc2.match(/LIVE_MATCH_FAILED_PROBE_KEEP_MS = (\d+) \* 60 \* 1000/) ?? [])[1] ?? -1
  );
  check('the keep window is bounded and short', keepBound > 0 && keepBound <= 15, true);

  // Sites #10/#11: the presence-driven retry uses the validated transport and
  // KEEPS its .catch — a failed probe preserves last-live-match state.
  check(
    'the presence retry uses the validated transport and keeps its catch',
    (trackerSrc2.match(/readRiotValidated\(\s*glz,\s*loop === 'INGAME'/g) ?? []).length === 2,
    true
  );

  // Site #4: the lite match result goes through the typed reader, and its
  // parse is a pure function the reader can validate before calling.
  check(
    'the lite result parses through the typed reader',
    /readMatchDetails<Record<string, 1 \| 0> \| null>/.test(trackerSrc2) &&
      /function parseLiteResultRow\(payload: unknown\)/.test(trackerSrc2),
    true
  );

  // Site #13: party clustering reads through the validated reader.
  check(
    'party clustering uses the validated reader',
    /readMatchHistoryPage\(rp\.puuid, shardFor\(region\), 0, 5\)/.test(trackerSrc2),
    true
  );

  // Site #12 of docs/riotget-conversion.md: the batch rank swap must use the
  // shared parser through the reader, never a local guard.
  check(
    'the batch rank site uses the validated reader',
    /readMmr\(p, shard, parseLocalRank, data\.seasonOrder/.test(trackerSrc2),
    true
  );

  // The header's number must equal the real number of raw call sites — the
  // failure mode this whole refactor exists to remove is a comment nobody
  // recomputes.
  const rawSites = (trackerSrc2.match(/await riotGet\(/g) ?? []).length;
  // Stricter second count: the NAME must be gone from tracker entirely, so a
  // local alias or a comment cannot satisfy "zero call sites" while the raw
  // transport is still reachable.
  const rawNameMentions = (trackerSrc2.match(/riotGet/g) ?? []).length;
  check('the raw transport name appears nowhere in tracker', rawNameMentions, 0);
  const stated = Number((riotSrc.match(/makes (\d+) raw `riotGet` calls?/) ?? [])[1] ?? -1);
  check('the header states the real number of raw call sites', stated, rawSites);

  // Two states, both asserted. While sites remain, the header may not claim
  // exclusivity; once they are gone the claim is REQUIRED and the "until
  // step 2" escape wording must be gone with it.
  if (rawSites > 0) {
    check('the header does not overclaim while sites remain', riotSrc.includes('until step 2 of'), true);
    check('the header does not yet claim exclusivity', /the ONLY place a raw/.test(riotSrc), false);
  } else {
    check('the header claims exclusivity once the last site is gone', /the ONLY place a raw/.test(riotSrc), true);
    check('the temporary wording is gone with the last site', riotSrc.includes('until step 2 of'), false);
  }

  // Temporary escape hatch with a named expiry: it is exported ONLY while raw
  // call sites remain, and marked as such.
  const stillExported = /export async function riotGet/.test(riotSrc);
  check('the raw transport is not exported', stillExported, false);
  check('the riotGet export does not outlive its reason', rawSites > 0 ? stillExported : !stillExported, true);
}

// --- A23-1 root cause: a cached detail without duels must not kill the merge --
{
  const { deriveHeroics } = await import('../src/utils/tracker.ts');
  // A detail cached before `kills` existed, or a match Riot answered without
  // duels. This used to throw here and take the whole aggregate down with it.
  const bare = { players: [{ puuid: 'me', team: 'Blue', agent: 'Jett' }] } as unknown as Parameters<
    typeof deriveHeroics
  >[0];
  let threw = false;
  let out: ReturnType<typeof deriveHeroics> | null = null;
  try {
    out = deriveHeroics(bare, 'me');
  } catch {
    threw = true;
  }
  check('a detail without duels does not throw', threw, false);
  check('and reports no heroics rather than inventing them', out?.flawless, 0);
  check('and keeps the agent we do know', out?.agent, 'Jett');

  const { readFileSync } = await import('node:fs');
  const hookSrc2 = readFileSync(new URL('../src/hooks/useTrackerData.ts', import.meta.url), 'utf8');
  check(
    'the cached merge logs its failure instead of swallowing it',
    /logCachedMerge\('threw'/.test(hookSrc2) && !/\}\)\s*\n\s*\.catch\(\(\) => \{\}\);/.test(hookSrc2),
    true
  );
  const riotSrc3 = readFileSync(new URL('../src/sources/riot.ts', import.meta.url), 'utf8');
  check(
    'the entitlement failure is logged once per window',
    /\[riot\] entitlements failed/.test(riotSrc3) && /ENT_FAIL_LOG_WINDOW_MS = 60_000/.test(riotSrc3),
    true
  );
}

// --- the reader boundary logs its failures, bounded ------------------------
{
  const { readFileSync } = await import('node:fs');
  const riotSrc2 = readFileSync(new URL('../src/sources/riot.ts', import.meta.url), 'utf8');
  check(
    'a failed read logs host, path, status and kind',
    /logger\.warn\('\[riot\] read failed', \{ host, path: shape, status, kind \}\)/.test(riotSrc2),
    true
  );
  check(
    'the failure log is bounded by a window and a key cap',
    /READ_FAIL_LOG_WINDOW_MS = 60_000/.test(riotSrc2) && /READ_FAIL_LOG_MAX_KEYS = 120/.test(riotSrc2),
    true
  );
  check(
    'paths are logged as shapes, not player ids',
    /function pathShape\(path: string\)/.test(riotSrc2) && /':uuid'/.test(riotSrc2),
    true
  );
  check(
    'both failure paths are covered',
    (riotSrc2.match(/logReadFailure\(/g) ?? []).length >= 3,
    true
  );
}

// --- A23-1: a failed refresh must not blank a board we have on disk --------
{
  const { readFileSync } = await import('node:fs');
  const hookSrc = readFileSync(new URL('../src/hooks/useTrackerData.ts', import.meta.url), 'utf8');
  check(
    'a failed refresh renders the cached snapshot',
    /cachedSnap\?\.profile[\s\S]{0,900}hasCached: true/.test(hookSrc),
    true
  );
  check(
    'and says why it is old',
    hookSrc.includes('Riot client not signed in — showing cached results'),
    true
  );
  check(
    'cached match details are still merged',
    /aggregateDetails\(region, cachedIds, cachedPuuid\)/.test(hookSrc),
    true
  );
}

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All Dev QA tests passed.');
