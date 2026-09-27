//! Hidden same-origin WebView2 transport for TRN (tracker.gg) reads.
//!
//! Why this exists: `fetch(https://api.tracker.gg…)` from the main window
//! (a `tauri://` origin) always dies at CORS — a TypeError with no status.
//! Burst QA proved Edge-direct NEVER fires, so every call fell back to the
//! Rust client, which alone eats Cloudflare 1015. This module serves the
//! same JSON from a hidden window navigated to `https://tracker.gg`: the
//! in-page fetch is same-site (no CORS), with a genuine navigation chain +
//! real Edge TLS/cookies (Cloudflare clearance persists in the profile).
//!
//! Sharing: the window uses Tauri's default WebView2 environment (same user
//! data dir as main/overlay) — one process pool, no downloads, no sidecars.
//! It is created `visible(false)` + `skip_taskbar(true)` and never focused;
//! fetches pause only while Valorant is the foreground window mid-match (an
//! error, not a queue) — tabbed-out, lobby, agent-select and menus always
//! fetch, exactly when pre-fetch must run.
//!
//! Contract: TS policy (trn.ts gate/ladder/persisted cooldown, tracker.ts
//! budget/spread/caches) is untouched — transport swap only, and no retry
//! lives here. This window is the SOLE TRN transport (no Rust HTTP anywhere).
//! Error shapes are `HTTP {code}: …`; transport states are `EDGE_UNAVAILABLE …`
//! (broken proxy — surfaces to the caller) vs `EDGE_PAUSED …` (in-match
//! fullscreen / hung page / page not ready — surfaces to the caller, retried
//! next call). An `EDGE_UNAVAILABLE body too large: …` is the one refusal that
//! is not a broken proxy: the body is intact upstream and over the slot cap,
//! and it is reported rather than handed back as a truncated 200.
//!
//! Watchdog: a wedged page (proven live: window exists but its JS engine
//! answers no eval within 2s — hung challenge page or dead renderer) used to
//! kill every fetch silently pre-network: no cooldown, no errors, all dashes.
//! Every fetch therefore opens with one fast liveness ping (the passive
//! readiness probe, zero API calls); on wedge/challenge the window is
//! destroyed + recreated so a fresh navigation re-earns clearance, and the
//! readiness gate re-vets it. `trn_proxy_state` exposes the page state
//! (READY / CHALLENGED / RECREATED / PAUSED) for the DevDashboard readout.
//!
//! Lifetime: a hidden WebView2 window is still a full renderer process, so
//! this one is created on the FIRST real request — never at boot — and
//! destroyed again after `PROXY_IDLE_TTL` with nothing in flight. See
//! `arm_idle_teardown`.
//!
//! Single-flight: the shared response memo only answers COMPLETED fetches,
//! so two realms asking for the same path mid-flight both missed it and both
//! fetched it (proved live: same seasonId, +434ms, two 200s). A flight map
//! now elects one leader per path; every other caller waits (bounded) for
//! the leader's exact result instead of issuing its own fetch or billing the
//! shared ceiling. See the single-flight block above `set_proxy_state`.
//!
//! Trace: `trn_trace!` writes the same `[TRN <ms>] …` line to stderr and to
//! a bounded ring, which `trn_trace_log` serves so the DevDashboard can show
//! the transport's decisions without a terminal screenshot.

use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Hidden window label (also listed in capabilities/default.json).
pub const PROXY_LABEL: &str = "trn-proxy";
/// Origin the hidden window sits on: same-site with the API host, so the
/// in-page fetch below is NOT cross-origin (no CORS wall).
const PROXY_URL: &str = "https://tracker.gg/";
/// Same host the Rust client hits — success/fallback bodies interchangeable.
const API_BASE: &str = "https://api.tracker.gg";
/// Same 20s budget the old Rust client had.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
/// Passive readiness gate: a fresh/challenged page burns a fragile IP with an
/// instant 1015 if we fetch blindly. Park queued fetches here (bounded) until
/// the page is loaded + cleared, then EDGE_PAUSED on expiry (transient —
///
/// retried next call, never a cooldown).
const READINESS_TIMEOUT: Duration = Duration::from_secs(10);
/// Readiness poll cadence (backend-driven via eval, never page timers).
const READINESS_POLL: Duration = Duration::from_millis(200);
/// Watchdog liveness budget: proven live wedge = the page's JS engine answers
/// no eval within 2s (hung challenge page or dead renderer).
const WATCHDOG_TIMEOUT: Duration = Duration::from_secs(2);
/// Backend poll cadence for the in-page result slot. Page timers may be
/// throttled while hidden — the cadence lives HERE, not in the page.
const POLL_EVERY: Duration = Duration::from_millis(100);
/// Cap on the body echoed into the in-page slot.
///
/// The comment this replaced claimed "TRN bodies are ~100 KiB; never binds".
/// Proven false: a VALORANT competitive season segment measured 1.72 MB, and
/// the old 1.5 MB cap cut it mid-object — the slot came back
/// `ok=true status=200` carrying invalid JSON, so `trnGet` threw
/// `TRN bad JSON.` and the act silently never loaded (Previous Acts showed
/// 0.00 K/D for exactly the acts whose body overran). The transport reported
/// success while the data was corrupt, which is the one thing it must never
/// do. 8 MB is ~4.5x the largest body measured, and `map_result` now refuses
/// an overrun loudly, so the cap is a backstop rather than a routine path.
const MAX_SLOT_CHARS: usize = 8_000_000;

/// Idle teardown window for the proxy renderer.
///
/// A hidden WebView2 window is still a full renderer process (~100MB), and
/// without a deadline the window created by the very first TRN request of the
/// session lives until the app exits. Five minutes is deliberate: it matches
/// `TRN_DEAD_QUIET_MS` in `src/utils/trn.ts`, the window the TS layer already
/// treats as "TRN is idle", so teardown can never fire while a ladder/cooldown
/// is still in play. Shorter would thrash — each re-create forces a fresh
/// navigation that has to re-earn Cloudflare clearance (up to the 10s
/// `READINESS_TIMEOUT` park on the next fetch), which is strictly worse CPU
/// than simply holding the window. Longer would just extend how long an idle
/// install keeps the renderer alive, which is the cost this is here to remove.
const PROXY_IDLE_TTL: Duration = Duration::from_secs(5 * 60);

static SLOT_SEQ: AtomicU64 = AtomicU64::new(1);
/// Per window lifetime: false until the first readiness pass. Reset when a
/// fresh window is created — an existing window skips the gate.
static PROXY_READY: AtomicBool = AtomicBool::new(false);
/// Requests currently holding the proxy window. Teardown requires zero.
static PROXY_INFLIGHT: AtomicU64 = AtomicU64::new(0);
/// Bumped by every completed request. An idle sweep carries the value it
/// captured and only fires if nothing has completed since — this is what stops
/// an older sweep from destroying a window that a later request re-armed.
static PROXY_TEARDOWN_GEN: AtomicU64 = AtomicU64::new(0);
/// Serializes the check-then-build in `proxy_window` so N concurrent
/// first-requests create exactly one window instead of racing and having all
/// but one fail on a duplicate label. `proxy_window` contains no `.await`, so a
/// plain std Mutex is correct and adds no async coupling.
static PROXY_WINDOW_LOCK: Mutex<()> = Mutex::new(());

/// DEV-ONLY structured trace: `[TRN <epoch-ms>] …` on stderr (visible in the
/// `tauri dev` terminal). The codebase writes `log::*` elsewhere but
/// initializes no logger backend, so `log::debug!` would vanish even in dev.
/// Fully compiled out when `debug_assertions` are off: zero prod output, no
/// new deps. Never log a RESPONSE body (player names) — paths, phases,
/// statuses, and the page's own exception text only (see `trace_err`).
#[cfg(debug_assertions)]
macro_rules! trn_trace {
    ($($t:tt)*) => {{
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        // One capture point for every call site: stderr (what `tauri dev`
        // shows) AND the dev ring the dashboard reads. No call site had to
        // change to be visible in the UI.
        trace_emit(format!("[TRN {}] {}", ms, format!($($t)*)));
    }};
}
#[cfg(not(debug_assertions))]
macro_rules! trn_trace {
    ($($t:tt)*) => {
        ()
    };
}

/* ---- Dev trace ring: the same lines, readable in the dashboard ---- *
 * The trace used to live only in the `tauri dev` terminal. `trn_trace!`
 * now routes every line through `trace_emit` into a bounded ring that
 * `trn_trace_log` serves, so a TRN bug report no longer needs a
 * screenshot of a scrollback buffer. Written ONLY by the macro, which
 * is compiled out of release — the release ring therefore stays empty
 * forever (one never-allocated `VecDeque`), and the command answers
 * "no lines" instead of erroring. */
/// Recent trace lines held for the DevDashboard readout.
///
/// A full lobby fill is ~25 requests × ~5 lines ≈ 125 lines inside a few
/// seconds, and the dashboard polls once a second. 512 keeps several
/// fills of history (enough to read a whole duplicate-request incident
/// start to finish) while staying far below the per-poll DOM cost of an
/// unbounded list, and the ring is bounded so a long session can never
/// grow it. Same shape as `PERF_RING_CAP` in perf.rs.
// `#[allow(dead_code)]` is RELEASE-only load-bearing: the sole reader is
// `trace_push`, which is `#[cfg(debug_assertions)]`, so a release build
// (tracer compiled out) has no consumer for the number and `dead_code`
// fires. The other three trace items needed no allow — the command being in
// `invoke_handler` is what makes those live, in both profiles.
#[allow(dead_code)]
pub const TRACE_RING_CAP: usize = 512;

/// One captured line plus its process-lifetime sequence, so the dashboard
/// can poll incrementally instead of refetching the whole ring.
#[derive(Clone, serde::Serialize)]
pub struct TraceLine {
    /// Monotonic from 1; never reset, never reused.
    pub seq: u64,
    /// The `[TRN <ms>] …` line exactly as stderr shows it.
    pub text: String,
}

/// One incremental read of the ring.
#[derive(serde::Serialize)]
pub struct TrnTraceLog {
    /// Newest sequence held; pass back as `after` on the next poll.
    pub head: u64,
    /// Lines newer than `after`, oldest-first.
    pub lines: Vec<TraceLine>,
    /// The ring evicted lines the poller never saw (its view has a gap).
    pub missed: bool,
}

/// Never written in release (the macro is compiled out), so it allocates
/// nothing there — an empty `VecDeque` behind one mutex.
static TRACE_RING: Mutex<VecDeque<TraceLine>> = Mutex::new(VecDeque::new());
#[cfg(debug_assertions)]
static TRACE_SEQ: AtomicU64 = AtomicU64::new(0);

/// The single capture point `trn_trace!` funnels into: stderr + the ring.
/// Dev-only because its only caller is the dev-only macro.
#[cfg(debug_assertions)]
fn trace_emit(line: String) {
    eprintln!("{line}");
    let seq = TRACE_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let Ok(mut r) = TRACE_RING.lock() else { return };
    trace_push(&mut r, TraceLine { seq, text: line }, TRACE_RING_CAP);
}

/// Push one line, evicting the oldest past `cap`. Pure — unit-tested.
/// Same idiom as `perf::push_sample`. Dev-only (its only caller is the
/// dev-only capture point).
#[cfg(debug_assertions)]
fn trace_push(buf: &mut VecDeque<TraceLine>, line: TraceLine, cap: usize) {
    if cap == 0 {
        return;
    }
    while buf.len() >= cap {
        buf.pop_front();
    }
    buf.push_back(line);
}

/// Everything newer than `after`: (head, lines, missed). Pure — unit-tested.
/// `missed` is true when the oldest returned line is not exactly `after + 1`,
/// i.e. the poller was too slow and the ring dropped lines in between.
fn trace_since(buf: &VecDeque<TraceLine>, after: u64) -> (u64, Vec<TraceLine>, bool) {
    let head = buf.back().map(|l| l.seq).unwrap_or(after);
    let lines: Vec<TraceLine> = buf.iter().filter(|l| l.seq > after).cloned().collect();
    let missed = lines.first().is_some_and(|l| l.seq > after + 1);
    (head, lines, missed)
}

/// Dev trace log for the DevDashboard, polled incrementally: pass the
/// `head` from the previous read as `after` and only newer lines come
/// back. Release builds return an empty log (the macro is compiled out),
/// so the panel says "no lines" rather than breaking.
#[tauri::command]
pub fn trn_trace_log(after: Option<u64>) -> Result<TrnTraceLog, String> {
    let buf = TRACE_RING.lock().map_err(|e| format!("trace lock: {e}"))?;
    let (head, lines, missed) = trace_since(&buf, after.unwrap_or(0));
    Ok(TrnTraceLog {
        head,
        lines,
        missed,
    })
}

/// Proxy page state for the `trn_proxy_state` command + DevDashboard readout
/// (Rust-owned — TS never guesses). Unknown until the first fetch.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ProxyState {
    Ready = 0,
    Challenged = 1,
    Recreated = 2,
    Paused = 3,
}

/// `u8::MAX` = never observed yet → "UNKNOWN".
static PROXY_STATE: AtomicU64 = AtomicU64::new(u8::MAX as u64);

/// Shared request ceiling. The `main` and `overlay` WebView2 windows each
/// load `trn.ts` SEPARATELY, so their `trnNextSlot` gate, `trnSpreadSpent`
/// lobby budget and `trnInFlightLive` dedup are per-realm: nothing above
/// this module can bound the app's request volume, because a second realm is
/// a full second budget. This one process is the only place both realms meet,
/// so the ceiling lives here — a check-then-spend under a single mutex, which
/// is what makes "at most N" a guarantee rather than a hope.
struct TrnCeiling {
    /// Lobby (matchId) `lobby_spent` was counted against. "" = no lobby.
    lobby: String,
    lobby_spent: u32,
    /// Start of the rolling per-hour window (epoch ms).
    window_start_ms: u64,
    window_spent: u32,
}

/// Per-lobby ceiling: one full lobby fill, with headroom.
///
/// A fill costs at most 2 requests per player (root profile, then the
/// current-season segment when the profile does not already carry it), so a
/// 12-player deathmatch lobby is 24. 30 leaves room for one retry without
/// ever starving a legitimate player. The response memo below means the
/// second realm's duplicate of the same fill costs 0 wire requests, so both
/// realms together still fit inside one ceiling. Requests with no lobby key
/// (Tracker tab, modals) are NOT billed here — they are user-driven and the
/// per-hour window is their bound.
const TRN_LOBBY_MAX_REQUESTS: u32 = 30;

/// Per-hour ceiling, over a rolling window.
///
/// The serial gate alone caps one realm at 1 request / 6s = 600/hour; two
/// realms can therefore reach 1200/hour, which is not a number anyone wants
/// pointed at tracker.gg. 900 sits above every observed demand (a full fill
/// is ~20 wire requests per ~35-minute match, so ~35/hour; view-driven tabs
/// add tens) and below the two-realm gate maximum, so it only ever bites on
/// a genuine runaway. Exceeding it is a quiet failure: callers already treat
/// any TRN_* throw as "fall back to Riot-direct".
const TRN_HOURLY_MAX_REQUESTS: u32 = 900;
const TRN_WINDOW_MS: u64 = 60 * 60 * 1000;

static TRN_CEILING: Mutex<TrnCeiling> = Mutex::new(TrnCeiling {
    lobby: String::new(),
    lobby_spent: 0,
    window_start_ms: 0,
    window_spent: 0,
});

/// Ceiling decision for one request. Pure — unit-tested.
#[derive(Debug, PartialEq, Eq)]
enum Ceiling {
    Allow,
    /// `lobby` or `hour`: which ceiling is spent. The string never contains
    /// 429/403/1015, so it can never trip the TS cooldown ladder.
    Deny(&'static str),
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Check (and spend) the shared budget for one request. `lobby` is the
/// current matchId or empty. Pure apart from the caller-supplied clock —
/// unit-tested. A stale lobby key and a new match both roll the counter, so
/// the budget is per lobby and can never be carried into the next one.
fn ceiling_allows(c: &mut TrnCeiling, lobby: &str, now: u64) -> Ceiling {
    if now.saturating_sub(c.window_start_ms) >= TRN_WINDOW_MS {
        c.window_start_ms = now;
        c.window_spent = 0;
    }
    if c.window_spent >= TRN_HOURLY_MAX_REQUESTS {
        return Ceiling::Deny("hour");
    }
    if !lobby.is_empty() {
        if c.lobby != lobby {
            c.lobby = lobby.to_string();
            c.lobby_spent = 0;
        }
        if c.lobby_spent >= TRN_LOBBY_MAX_REQUESTS {
            return Ceiling::Deny("lobby");
        }
        c.lobby_spent += 1;
    }
    c.window_spent += 1;
    Ceiling::Allow
}

/// Spend against the shared ceiling. Returns the reason on refusal.
fn spend_ceiling(lobby: &str) -> Ceiling {
    let Ok(mut c) = TRN_CEILING.lock() else {
        // Poisoned lock must not become an outage: allow, the TS gate above
        // still paces every request.
        return Ceiling::Allow;
    };
    ceiling_allows(&mut c, lobby, now_ms())
}

/* ---- Shared response memo: the cross-realm duplicate costs no wire ---- *
 * `main` and `overlay` both run the same fill at the same time, and the
 * in-realm `trnInFlightLive` dedup cannot see the other realm, so EVERY
 * lobby fill was fetched twice — 2x the volume for identical bytes. TS
 * caches (`profileCache`, `seasonSegCache`) are per-realm for the same
 * reason. This is the shared copy: an identical path answered within
 * `TRN_MEMO_TTL_MS` is replayed from memory, touching neither the network
 * nor the page (so it also skips the pause gate — strictly better for FPS).
 * TRN stats only move when a match ends, so a short replay is invisible;
 * only 2xx bodies are memoized, so a 429/451/404 never short-circuits the
 * ladder or the negative registry. */
const TRN_MEMO_TTL_MS: u64 = 10 * 1000;
/// Distinct paths a single 10s window can hold. Two realms interleave the
/// same fill, so a live window sees one entry per in-flight player — 64 is
/// ~5 full 12-player lobbies of slack, and it keeps this map bounded too.
const TRN_MEMO_MAX: usize = 64;

struct MemoEntry {
    at_ms: u64,
    body: String,
}

static TRN_MEMO: Mutex<Vec<(String, MemoEntry)>> = Mutex::new(Vec::new());

/// A memoized body for this exact path, if it is still fresh. `now` is
/// injected so the TTL is testable.
fn memo_get(path: &str, now: u64) -> Option<String> {
    let mut m = TRN_MEMO.lock().ok()?;
    if let Some(i) = m.iter().position(|(p, _)| p == path) {
        if now.saturating_sub(m[i].1.at_ms) < TRN_MEMO_TTL_MS {
            return Some(m[i].1.body.clone());
        }
        m.remove(i);
    }
    None
}

/// Remember a 2xx body, oldest-first eviction past `TRN_MEMO_MAX`.
fn memo_put(path: &str, body: String, now: u64) {
    let Ok(mut m) = TRN_MEMO.lock() else { return };
    m.retain(|(p, _)| p != path);
    m.push((path.to_string(), MemoEntry { at_ms: now, body }));
    while m.len() > TRN_MEMO_MAX {
        let oldest = m
            .iter()
            .enumerate()
            .min_by_key(|(_, (_, e))| e.at_ms)
            .map(|(i, _)| i)
            .unwrap_or(0);
        m.remove(oldest);
    }
}

/* ---- Single-flight: one wire request per path, whoever asks ---- *
 * The memo above only answers COMPLETED fetches, so two realms asking
 * for the same path while the first is still on the wire both missed it
 * and both fetched (proved live: same seasonId, +434ms, two 200s). The
 * flight map below closes that window: the first caller for a path
 * becomes the LEADER and does the work, every other caller for that
 * path becomes a FOLLOWER that waits for the leader's exact result.
 *
 * Key = the path alone, same as the memo. The lobby/phase facts are
 * per-caller policy (`should_pause`, `spend_ceiling`), evaluated by the
 * caller before it joins and never shared, so adding them to the key
 * would only let two realms with different hints fetch the same bytes
 * twice — exactly what this exists to prevent. */
/// The leader's outcome, shared verbatim with every follower. A failure is
/// shared but NEVER memoized (the 2xx-only `memo_put` rule above stands), so
/// a later caller is a fresh leader rather than a replay of the error.
type FlightResult = Result<String, String>;
/// `None` = the leader has not published yet. Followers clone, never take.
type FlightSlot = Arc<Mutex<Option<FlightResult>>>;

/// path → its in-flight slot. Bounded by construction: every entry is
/// inserted by exactly one leader and removed by that leader's guard, so
/// the map only ever holds genuinely concurrent paths (itself bounded by
/// `TRN_HOURLY_MAX_REQUESTS`).
static TRN_FLIGHTS: Mutex<Vec<(String, FlightSlot)>> = Mutex::new(Vec::new());

/// Bounded follow wait. A leader's own worst case is the 10s readiness park
/// plus the 20s fetch timeout plus poll granularity (~32s), so 35s always
/// outlasts a live leader while still surfacing a stranded one instead of
/// hanging. Never contains a ladder substring, so the shared cooldown
/// ladder is untouched.
const FOLLOWER_WAIT: Duration = Duration::from_secs(35);
/// Follower gave up (budget above). Same transient family as EDGE_PAUSED.
const FOLLOWER_TIMEOUT: &str = "EDGE_PAUSED follower gave up waiting for the in-flight request";
/// Leader vanished (cancelled/panicked) before publishing — the guard's
/// safety net. Never a session pin: the next call is a fresh leader.
const FOLLOWER_ABANDONED: &str = "EDGE_PAUSED in-flight leader abandoned";

/// Join the flight for `path`, or open one. Leader/follower is decided
/// under a single lock, which is what makes "at most one on the wire" a
/// guarantee. Pure over the injected map — unit-tested.
fn flight_acquire(flights: &mut Vec<(String, FlightSlot)>, path: &str) -> (FlightSlot, bool) {
    if let Some(slot) = flights
        .iter()
        .find(|(p, _)| p == path)
        .map(|(_, s)| Arc::clone(s))
    {
        return (slot, false);
    }
    let slot: FlightSlot = Arc::new(Mutex::new(None));
    flights.push((path.to_string(), Arc::clone(&slot)));
    (slot, true)
}

/// Drop the entry for `path`, but only if it is still `slot` — a later
/// leader's slot must survive an earlier leader's guard running late.
/// Pure — unit-tested.
fn flight_remove(flights: &mut Vec<(String, FlightSlot)>, path: &str, slot: &FlightSlot) {
    flights.retain(|(p, s)| !(p == path && Arc::ptr_eq(s, slot)));
}

/// Leader-side guard: publishes the outcome and always removes the entry.
///
/// `Drop` runs on every exit — success, `HTTP {code}`, `TRN_BUDGET`,
/// `EDGE_PAUSED`, cancellation, panic — so followers can never be left
/// waiting on a slot nobody will fill and the map can never leak. Same
/// idiom as `InflightGuard` above.
struct FlightGuard {
    path: String,
    slot: FlightSlot,
    published: bool,
}

impl FlightGuard {
    fn new(path: &str, slot: &FlightSlot) -> Self {
        Self {
            path: path.to_string(),
            slot: Arc::clone(slot),
            published: false,
        }
    }

    /// Hand the outcome to every follower. First call wins, so the success
    /// arm can publish before the early returns without racing the guard.
    fn publish(&mut self, out: FlightResult) {
        if let Ok(mut g) = self.slot.lock() {
            if g.is_none() {
                *g = Some(out);
            }
        }
        self.published = true;
    }
}

impl Drop for FlightGuard {
    fn drop(&mut self) {
        if !self.published {
            if let Ok(mut g) = self.slot.lock() {
                if g.is_none() {
                    *g = Some(Err(FOLLOWER_ABANDONED.to_string()));
                }
            }
        }
        if let Ok(mut f) = TRN_FLIGHTS.lock() {
            flight_remove(&mut f, &self.path, &self.slot);
        }
    }
}

/// Wait for the leader (bounded). No lock is held while waiting, so a
/// leader can always take the slot back and make progress — the follower
/// sleeps, never blocks. Each wake re-reads the slot (the leader may have
/// published in between) and re-checks the memo, so a leader that
/// finished and was removed between this follower joining and the publish
/// is still served from cache rather than reported as a timeout.
async fn wait_flight(path: &str, slot: &FlightSlot, budget: Duration) -> FlightResult {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        if let Ok(g) = slot.lock() {
            if let Some(out) = g.as_ref() {
                return out.clone();
            }
        }
        if let Some(body) = memo_get(path, now_ms()) {
            return Ok(body);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(FOLLOWER_TIMEOUT.to_string());
        }
        tokio::time::sleep(POLL_EVERY).await;
    }
}

fn set_proxy_state(s: ProxyState) {
    PROXY_STATE.store(s as u64, Ordering::Relaxed);
}

/// State string for the command surface. Pure — unit-tested.
fn proxy_state_str(raw: u64) -> &'static str {
    match raw as u8 {
        x if x == ProxyState::Ready as u8 => "READY",
        x if x == ProxyState::Challenged as u8 => "CHALLENGED",
        x if x == ProxyState::Recreated as u8 => "RECREATED",
        x if x == ProxyState::Paused as u8 => "PAUSED",
        _ => "UNKNOWN",
    }
}

/// Watchdog verdict: true = destroy + recreate. A healthy page always answers
/// the passive probe with valid ready JSON, so anything else (silence past
/// the budget, challenge mid-life, garbage) means wedged or challenged.
/// Pure — unit-tested.
fn watchdog_should_recreate(ping: Option<&ProxyReadiness>) -> bool {
    match ping {
        Some(r) => !is_proxy_ready(r),
        None => true,
    }
}

/// Which of the two watchdog failures fired, for the trace line. `silent` = the
/// renderer never answered inside the budget (proven live wedge: hung
/// challenge page or dead renderer); `not-ready` = it answered, but the page
/// is no longer loaded/cleared/tracker.gg. Pure — unit-tested.
fn watchdog_reason(ping: Option<&ProxyReadiness>) -> &'static str {
    match ping {
        None => "silent",
        Some(_) => "not-ready",
    }
}

/// A sweep that captured `gen` may destroy the window only when no request has
/// completed since it armed (`gen == current_gen`) and nothing is in flight
/// right now. Pure — unit-tested.
fn teardown_still_valid(gen: u64, current_gen: u64, in_flight: u64) -> bool {
    gen == current_gen && in_flight == 0
}

/// Back to "never observed against a live window": the next fetch re-runs the
/// readiness gate on a fresh navigation, so leaving the pre-teardown state in
/// place would report a page that no longer exists.
fn reset_proxy_lifecycle() {
    PROXY_READY.store(false, Ordering::Relaxed);
    PROXY_STATE.store(u8::MAX as u64, Ordering::Relaxed);
}

/// In-flight request guard, entered before the window is acquired.
///
/// `Drop` runs on every exit path — 2xx, `HTTP {code}`, `EDGE_PAUSED`,
/// `EDGE_UNAVAILABLE`, early return — so the in-flight count can never be
/// stranded above zero (which would disable teardown for the rest of the
/// session) and can never hit zero while an eval is still outstanding.
struct InflightGuard(AppHandle);

impl InflightGuard {
    fn enter(app: &AppHandle) -> Self {
        PROXY_INFLIGHT.fetch_add(1, Ordering::AcqRel);
        Self(app.clone())
    }
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        PROXY_INFLIGHT.fetch_sub(1, Ordering::AcqRel);
        arm_idle_teardown(&self.0);
    }
}

/// Arm the idle sweep for the window this request just used.
///
/// Only the request that takes the in-flight count to zero arms one, and it
/// invalidates every sweep armed before it. The sweep sleeps, re-checks under
/// the same lock `proxy_window` takes, and only then destroys — so a create
/// racing the deadline either wins the lock (and arms its own sweep when it
/// completes) or loses it and leaves a window that is genuinely still idle.
fn arm_idle_teardown(app: &AppHandle) {
    if PROXY_INFLIGHT.load(Ordering::Acquire) != 0 {
        return;
    }
    let gen = PROXY_TEARDOWN_GEN.fetch_add(1, Ordering::AcqRel) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PROXY_IDLE_TTL).await;
        if PROXY_INFLIGHT.load(Ordering::Acquire) != 0 {
            return;
        }
        let Ok(_guard) = PROXY_WINDOW_LOCK.lock() else {
            return;
        };
        let valid = teardown_still_valid(
            gen,
            PROXY_TEARDOWN_GEN.load(Ordering::Acquire),
            PROXY_INFLIGHT.load(Ordering::Acquire),
        );
        if !valid {
            return;
        }
        // Reuse the watchdog teardown: `destroy`, never `close` — CloseRequested
        // is intercepted app-wide into hide(), which would leave a dead window
        // registered forever and accumulate orphans across cycles.
        trn_trace!("IDLE teardown (no TRN request for {PROXY_IDLE_TTL:?})");
        destroy_proxy_window(&app);
        reset_proxy_lifecycle();
    });
}

#[derive(serde::Deserialize)]
struct SlotResult {
    ok: bool,
    status: u16,
    body: String,
    /// Untruncated body length in UTF-16 units — the same unit the in-page
    /// `.slice()` counts, so `len > MAX_SLOT_CHARS` means "the slice cut this".
    /// Defaults to 0 so a slot written by an older build still decodes.
    #[serde(default)]
    len: usize,
}

/// Strict path allowlist (/api/ only, no whitespace, ≤300 chars).
/// Pure — unit-tested.
fn validate_path(path: &str) -> Result<(), String> {
    if path.contains([' ', '\n', '\r']) || !path.starts_with("/api/") {
        return Err("Invalid path.".to_string());
    }
    if path.len() > 300 {
        return Err("Path too long.".to_string());
    }
    Ok(())
}

/// Pause iff Valorant is the FOREGROUND window AND the match is live
/// (coregame/ingame/unknown) — the only real FPS risk is the user watching
/// live gameplay. Fetch freely when pregame/lobby/menus is detected, or when
/// the game is not foreground (tabbed out looking at Recon: zero FPS risk).
/// Rect checks are deliberately excluded: a tabbed-out borderless window
/// keeps its size, so rect-only detection over-blocks forever.
/// Exclusive-fullscreen always holds focus while visible, so it stays
/// covered. `phase` is TS's best-known match phase (Riot-local gives it
/// free); unknown/blank + foreground still pauses. `drain` exempts an
/// already-budgeted lobby fill: dispatched pre-flip, it runs to completion
/// across the phase flip (bounded ≤10, ladder-guarded) instead of abandoning
/// the batch. Pure (all facts injected) — unit-tested.
fn should_pause(game_present: bool, game_foreground: bool, phase: &str, drain: bool) -> bool {
    // Dispatched drain: the budget was claimed while unpaused — finishing a
    // bounded batch of light JSON fetches is harmless (loading screens don't
    // need FPS) and dash-abandonment is worse.
    if drain {
        return false;
    }
    if !game_present || !game_foreground {
        return false;
    }
    match phase.trim().to_lowercase().as_str() {
        // Menus, lobby, agent-select, queue: always fetch (hidden window +
        // budgeted + ladder-guarded costs ~zero FPS — and this is the only
        // window where pre-fetch can run).
        "pregame" | "lobby" | "menu" | "menus" | "idle" => false,
        // Foreground live gameplay / unknown: a hidden fetch would steal
        // GPU/scheduler time mid-match for data nobody reads until tab-out.
        _ => true,
    }
}

/// True iff the Valorant window currently owns user focus. Focus-only by
/// design (see `should_pause`): never a rect check.
fn game_has_focus() -> bool {
    if crate::window_manager::find_valorant_game_window().is_none() {
        return false;
    }
    crate::window_manager::is_valorant_foreground()
}

/// Kick script: starts the same-site fetch, parks the outcome on a per-call
/// window slot. Slot + URL are JSON-encoded so exotic paths (quotes,
/// unicode) can't break out of the string. Pure — unit-tested.
fn kick_script(slot: &str, url: &str) -> String {
    let slot = serde_json::to_string(slot).unwrap_or_else(|_| "\"__trn\"".to_string());
    let url = serde_json::to_string(url).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "window[{slot}]=null;\
        fetch({url},{{credentials:'include'}}).then(async r=>{{\
        let b='';try{{b=await r.text()}}catch(e){{}}\
        window[{slot}]=JSON.stringify({{ok:r.ok,status:r.status,len:b.length,body:(b||'').slice(0,{MAX_SLOT_CHARS})}})\
        }}).catch(e=>{{\
        window[{slot}]=JSON.stringify({{ok:false,status:0,len:0,body:String((e&&e.message)||e||'fetch failed').slice(0,500)}})\
        }})"
    )
}

/// Poll expression: `''` while pending, the result JSON once resolved.
/// Pure — unit-tested.
fn poll_expr(slot: &str) -> String {
    let slot = serde_json::to_string(slot).unwrap_or_else(|_| "\"__trn\"".to_string());
    format!("String(window[{slot}]??'')")
}

/// Decode one `eval_with_callback` envelope: None = still pending (or
/// garbage — never poison the wait). Pure — unit-tested.
fn parse_poll(envelope: &str) -> Option<SlotResult> {
    let inner: String = serde_json::from_str(envelope).ok()?;
    if inner.is_empty() {
        return None;
    }
    serde_json::from_str(&inner).ok()
}

fn snippet(body: &str) -> String {
    body.chars().take(300).collect()
}

/// Chars of an in-page rejection message that reach a trace line.
///
/// 200 is room for a real WebView message (`Failed to fetch`, `NetworkError
/// when attempting to fetch resource.`) and short enough that a pathological
/// message cannot push the 512-line ring's worth of history out of the panel.
const TRACE_ERR_CHARS: usize = 200;

/// ` err=…` for a `status=0` line, `""` for everything else.
///
/// A 2xx and an HTTP error both carry their fact in `status`. A REJECTED
/// in-page fetch carries nothing: `outcome ok=false status=0 elapsed_ms=101`
/// was the whole line, and the one thing that explains it — the page's own
/// exception, already formatted into the command error by `map_result` and
/// then dropped on the floor — never reached the ring. That is why a live
/// season-segment incident was unreadable without a terminal screenshot.
///
/// Deliberately limited to `status == 0`. That body is the page's JS error
/// string, never a response body, so the "no response bodies in the trace"
/// rule (player data; asserted by scripts/devqa-check.ts) still holds. A
/// `HTTP {code}` keeps its status and nothing more.
///
/// Flattened to one line: the ring is line-oriented and the panel renders one
/// row per line. Pure — unit-tested.
fn trace_err(r: &SlotResult) -> String {
    if r.status != 0 {
        return String::new();
    }
    let flat = r
        .body
        .chars()
        .take(TRACE_ERR_CHARS)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    // A bare `err=` would read as "no detail" when the truth is "there was no
    // message to begin with", so name the absence.
    if flat.is_empty() {
        return " err=<empty>".to_string();
    }
    format!(" err={flat}")
}

/// Map a resolved slot to the command surface. Pure — unit-tested.
fn map_result(r: SlotResult) -> Result<String, String> {
    if r.ok && (200..300).contains(&r.status) {
        // The in-page slice cut this body. Returning the remainder would hand
        // back invalid JSON with a 200 on it, and every caller would report a
        // transport success over corrupt data. Refuse loudly instead — and
        // never memoize a refusal, so a later call re-attempts it.
        if r.len > MAX_SLOT_CHARS {
            return Err(format!(
                "EDGE_UNAVAILABLE body too large: {} chars > MAX_SLOT_CHARS {}",
                r.len, MAX_SLOT_CHARS
            ));
        }
        return Ok(r.body);
    }
    if r.status == 0 {
        return Err(format!("EDGE_PAUSED in-page fetch failed: {}", snippet(&r.body)));
    }
    Err(format!("HTTP {}: {}", r.status, snippet(&r.body)))
}

/// Passive readiness probe: load state + page origin + cookie jar + challenge
/// markers in one string. NO fetch(), NO /api/, NO network — pure DOM reads
/// so the check itself can never burn the IP. Pure — unit-tested.
///
/// The cookie jar is read WHOLE, never sliced. It used to be
/// `document.cookie.slice(0,500)`, which can cut `cf_clearance` clean off the
/// end of a long jar and make `has_cf_cookie` answer "no clearance" on a
/// perfectly cleared page — a latent trap that only passed because
/// `is_proxy_ready` also accepts "no challenge markers". A fixed slice can
/// never be made safe by picking a bigger number; searching the whole string
/// can. `host`/`title` keep their slices: they are labels shown to a human,
/// not needles that must be found.
fn readiness_probe() -> String {
    "JSON.stringify({loaded:document.readyState==='complete',host:(location.hostname||'').slice(0,80),title:(document.title||'').slice(0,120),cookies:document.cookie||'',challenge:!!(document.querySelector('iframe[src*=\"challenges.cloudflare.com\"],#cf-challenge,#challenge-form,.cf-challenge'))})".to_string()
}

#[derive(serde::Deserialize)]
struct ProxyReadiness {
    loaded: bool,
    /// `location.hostname` of the document answering the probe. Empty for the
    /// initial blank document a fresh window serves before the navigation
    /// commits — see `is_trn_origin`.
    #[serde(default)]
    host: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    cookies: String,
    #[serde(default)]
    challenge: bool,
}

/// Decode one readiness envelope (double JSON like parse_poll): None = still
/// pending or garbage — never poison the wait. Pure — unit-tested.
fn parse_readiness(envelope: &str) -> Option<ProxyReadiness> {
    let inner: String = serde_json::from_str(envelope).ok()?;
    if inner.is_empty() {
        return None;
    }
    serde_json::from_str(&inner).ok()
}

/// Cloudflare challenge page titles (case-insensitive). Pure — unit-tested.
fn is_challenge_title(title: &str) -> bool {
    let t = title.to_lowercase();
    t.contains("just a moment") || t.contains("attention required") || t.contains("verifying you are human") || t.contains("security verification")
}

/// Clearance cookies visible to JS (HttpOnly ones never appear — absence never
/// blocks, presence is a bonus signal). Pure — unit-tested.
fn has_cf_cookie(cookies: &str) -> bool {
    cookies.contains("cf_clearance") || cookies.contains("__cf_bm")
}

/// The document answering the probe must actually BE tracker.gg.
///
/// Proven live: a freshly created window serves its initial blank document
/// first, and that document is `readyState === 'complete'` with no challenge
/// markers and no visible cookies — so the old readiness gate passed it and
/// the fetch went out cross-origin from `about:blank`, dying with no HTTP
/// status at all (`ok=false status=0` in ~100ms) and forcing a retry. Any
/// `tracker.gg` host counts so a www redirect still passes. Pure — unit-tested.
fn is_trn_origin(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    h == "tracker.gg" || h.ends_with(".tracker.gg")
}

/// Ready = load complete + on the tracker.gg origin + clearance (cookie jar
/// OR no challenge markers). Pure — unit-tested.
fn is_proxy_ready(r: &ProxyReadiness) -> bool {
    r.loaded
        && is_trn_origin(&r.host)
        && (has_cf_cookie(&r.cookies) || (!r.challenge && !is_challenge_title(&r.title)))
}

/// Park queued fetches until the page is ready (bounded). Once per window
/// lifetime — after the first pass PROXY_READY sticks until a fresh window
/// resets it. EDGE_PAUSED on expiry (transient, retried next call). `path`
/// rides along so a park is attributable: a four-way season-segment fan-out
/// otherwise produces one anonymous `NOT READY`.
async fn wait_proxy_ready(window: &WebviewWindow, path: &str) -> Result<(), String> {
    if PROXY_READY.load(Ordering::Relaxed) {
        return Ok(());
    }
    let deadline = tokio::time::Instant::now() + READINESS_TIMEOUT;
    let probe = readiness_probe();
    loop {
        let Some(env) = eval_roundtrip(window, probe.clone()).await else {
            trn_trace!("LOST path={path} err=proxy lost during readiness probe");
            return Err("EDGE_UNAVAILABLE proxy lost".to_string());
        };
        if let Some(r) = parse_readiness(&env) {
            if is_proxy_ready(&r) {
                PROXY_READY.store(true, Ordering::Relaxed);
                set_proxy_state(ProxyState::Ready);
                trn_trace!("READY (clearance ok)");
                return Ok(());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            set_proxy_state(ProxyState::Challenged);
            trn_trace!("NOT READY path={path} (still loading/challenged after budget)");
            return Err("EDGE_PAUSED proxy not ready: page still loading or challenged".to_string());
        }
        tokio::time::sleep(READINESS_POLL).await;
    }
}

fn eval_fire(window: &WebviewWindow, js: String) -> Result<(), String> {
    window.eval(js).map_err(|e| format!("EDGE_UNAVAILABLE proxy eval: {e}"))
}

/// One eval-with-result round trip. The callback fires on WebView2's
/// completion thread and wakes us via Notify — the webview thread is never
/// blocked. None when the webview is gone.
async fn eval_roundtrip(window: &WebviewWindow, js: String) -> Option<String> {
    eval_roundtrip_timeout(window, js, Duration::from_secs(5)).await
}

/// Same, with a caller-chosen budget. The watchdog passes 2s (proven wedge
/// threshold); everything else keeps the patient 5s. Pure plumbing — the
/// wedge decision itself lives in `watchdog_should_recreate`.
async fn eval_roundtrip_timeout(
    window: &WebviewWindow,
    js: String,
    timeout: Duration,
) -> Option<String> {
    let out: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let wake = Arc::new(tokio::sync::Notify::new());
    let out2 = Arc::clone(&out);
    let wake2 = Arc::clone(&wake);
    // Fn (not FnOnce): the Mutex makes the single send shareable.
    if window
        .eval_with_callback(js, move |v| {
            if let Ok(mut g) = out2.lock() {
                *g = Some(v);
            }
            wake2.notify_one();
        })
        .is_err()
    {
        return None;
    }
    if tokio::time::timeout(timeout, wake.notified())
        .await
        .is_err()
    {
        return None;
    }
    let x = out.lock().ok()?.take();
    x
}

/// Destroy a wedged/challenged window so the next build starts clean.
/// `destroy`, not `close` — CloseRequested is intercepted app-wide into
/// hide(), which would leave the dead page in place.
fn destroy_proxy_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PROXY_LABEL) {
        let _ = w.destroy();
    }
}

/// Recreate the proxy window after the watchdog fires: a fresh navigation
/// re-earns clearance, and the readiness gate below re-vets it before any
/// fetch. Makes no API calls itself. `reason` is the watchdog's own verdict
/// and `path` the request it interrupted, so the line names both failures
/// instead of a generic "wedge/challenge".
fn recreate_proxy(
    app: &AppHandle,
    window: &mut WebviewWindow,
    reason: &str,
    path: &str,
) -> Result<(), String> {
    destroy_proxy_window(app);
    PROXY_READY.store(false, Ordering::Relaxed);
    set_proxy_state(ProxyState::Recreated);
    trn_trace!("RECREATED reason={reason} path={path} (fresh navigation re-earns clearance)");
    *window = proxy_window(app)?;
    Ok(())
}

/// Watchdog: one fast liveness ping per fetch on windows that previously
/// passed readiness (fresh windows skip — the gate below vets them). The
/// ping is the passive readiness probe (DOM reads only, zero API calls):
/// silence past the budget or a mid-life challenge recreates the window.
/// Healthy pages answer in ms, so the steady-state cost is one eval.
async fn ensure_proxy_alive(
    app: &AppHandle,
    window: &mut WebviewWindow,
    path: &str,
) -> Result<(), String> {
    if !PROXY_READY.load(Ordering::Relaxed) {
        return Ok(());
    }
    let ping = eval_roundtrip_timeout(window, readiness_probe(), WATCHDOG_TIMEOUT)
        .await
        .and_then(|env| parse_readiness(&env));
    if !watchdog_should_recreate(ping.as_ref()) {
        set_proxy_state(ProxyState::Ready);
        return Ok(());
    }
    recreate_proxy(app, window, watchdog_reason(ping.as_ref()), path)
}

/// Existing hidden window, or a fresh one. Shared WebView2 pool (default
/// environment — no separate data dir), stays hidden + off-taskbar, never
/// focused. Idempotent: safe to call per fetch, and the lock makes it
/// idempotent under concurrency too — racing callers can never build a second
/// window under the same label, so cycles cannot accumulate or orphan one.
fn proxy_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let _guard = PROXY_WINDOW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(w) = app.get_webview_window(PROXY_LABEL) {
        let _ = w.hide();
        return Ok(w);
    }
    // Fresh window lifetime: readiness must re-pass before the first fetch.
    PROXY_READY.store(false, Ordering::Relaxed);
    let w = WebviewWindowBuilder::new(
        app,
        PROXY_LABEL,
        WebviewUrl::External(
            PROXY_URL
                .parse()
                .map_err(|e| format!("EDGE_UNAVAILABLE bad proxy url: {e}"))?,
        ),
    )
    .title("Recon TRN proxy")
    .inner_size(16.0, 16.0)
    .decorations(false)
    .transparent(true)
    .focused(false)
    .visible(false)
    .skip_taskbar(true)
    .always_on_top(false)
    .build()
    .map_err(|e| format!("EDGE_UNAVAILABLE proxy window: {e}"))?;
    let _ = w.hide();
    Ok(w)
}

/// GET `path` through the hidden tracker.gg window (same-site fetch, real
/// Edge). Ok(body) on 2xx; `HTTP {code}: …` otherwise (feeds the shared
/// ladder); `EDGE_UNAVAILABLE …` pins the session to Rust;
/// `EDGE_PAUSED …` falls back this call only. Never shows, never focuses.
/// `phase` is TS's best-known match phase (pregame = agent-select → always
/// allowed); omitted/unknown keeps the fullscreen-facts fallback. `drain`
/// marks an already-budgeted lobby fill draining across the phase flip —
/// pause is skipped for it (bounded, ladder-guarded); every new fill stays
/// gated. `lobby` is the current matchId (empty when there is none) and
/// bills the SHARED per-lobby ceiling below, so both WebView realms bill
/// one lobby together instead of one budget each.
///
/// Single-flight: concurrent callers for the same path collapse onto one
/// request — the first is the leader, the rest wait (bounded) for its exact
/// result instead of issuing their own fetch or billing the ceiling.
#[tauri::command]
pub async fn trn_proxy_fetch(
    app: AppHandle,
    path: String,
    phase: Option<String>,
    drain: Option<bool>,
    lobby: Option<String>,
) -> Result<String, String> {
    if let Err(e) = validate_path(&path) {
        trn_trace!("REJECTED path={path} err={e}");
        return Err(e);
    }
    let phase_str = phase.as_deref().unwrap_or("");
    let drain = drain.unwrap_or(false);
    let lobby_key = lobby.as_deref().unwrap_or("");
    // Nothing below this point opens the window, so all three gates are free
    // to refuse a call for the price of a lookup. Order matters: the memo is
    // the only one that may serve a request, the pause check must not spend
    // budget, and the ceiling must not open a page it will never use.
    if let Some(body) = memo_get(&path, now_ms()) {
        trn_trace!("MEMO hit path={}", path);
        return Ok(body);
    }
    if should_pause(
        crate::window_manager::find_valorant_game_window().is_some(),
        game_has_focus(),
        phase_str,
        drain,
    ) {
        set_proxy_state(ProxyState::Paused);
        trn_trace!(
            "PAUSED path={} phase={} (in-match fullscreen)",
            path,
            phase_str
        );
        return Err("EDGE_PAUSED game fullscreen".to_string());
    }
    // Single-flight, BETWEEN the pause check and the ceiling. After pause:
    // that verdict is a per-caller fact (its own phase hint, its own game
    // focus) and costs nothing, so each caller keeps deciding it. Before the
    // ceiling: a follower must never be billed for a request it did not make.
    let (slot, leader) = match TRN_FLIGHTS.lock() {
        Ok(mut f) => flight_acquire(&mut f, &path),
        // Poisoned lock must not strand callers: fall back to today's
        // behaviour (each caller fetches) rather than refusing service.
        Err(_) => (Arc::new(Mutex::new(None)), true),
    };
    if !leader {
        // Follower: the leader's exact answer, success or failure, bounded.
        trn_trace!("JOIN in-flight path={}", path);
        return wait_flight(&path, &slot, FOLLOWER_WAIT).await;
    }
    let mut flight = FlightGuard::new(&path, &slot);
    // Every exit of the leader below is published verbatim to the followers,
    // so the whole body is one expression: no `?` arm can return without the
    // followers hearing about it (the guard's Drop is the backstop for a
    // cancelled or panicked leader, which never reaches this line).
    let out: FlightResult = async {
        // Shared ceiling, before the window exists: past it this call must do
        // nothing at all. It sits AFTER the pause check on purpose — a paused
        // call fetches nothing, so it must cost nothing, same rule the TS
        // pre-check follows for the serial-gate slot.
        if let Ceiling::Deny(which) = spend_ceiling(lobby_key) {
            set_proxy_state(ProxyState::Paused);
            trn_trace!("CEILING spent={} path={}", which, path);
            return Err(format!("TRN_BUDGET {which} spent"));
        }
        // Logged HERE, not at the top of the command: the three gates above
        // (memo, pause, ceiling) plus the follower join all answer without
        // touching the wire, and a `fetch start` above them made every one of
        // those read as a request that went out. The panel counts these lines
        // as "wire", so it has to mean it. By here the caller is the leader
        // and the budget is spent, so this line really is the wire.
        trn_trace!(
            "fetch start path={} phase={} drain={} lobby={}",
            path,
            phase_str,
            drain,
            lobby_key
        );
        // Entered before the window is acquired, so no window can exist without
        // a sweep that will eventually reclaim it. Lives to the end of this
        // block and `Drop` covers every return below — including the timeout and
        // error arms — so the in-flight count is never stranded or decremented
        // early. A follower never reaches here, so it never counts as a user
        // of the window.
        let _inflight = InflightGuard::enter(&app);
        let mut window = proxy_window(&app)?;
        // Watchdog first: a wedged page dies silently pre-network without this.
        // Recreates + re-gates; healthy pages cost one ms-scale eval.
        ensure_proxy_alive(&app, &mut window, &path).await?;
        // Passive gate: never fetch blind from a fresh/challenged page. Queued
        // callers park here together until ready (bounded), then EDGE_PAUSED.
        // A request that arrives while the window is still initialising waits
        // here (up to READINESS_TIMEOUT) instead of firing into a document
        // that is not tracker.gg yet and dying with no HTTP status.
        wait_proxy_ready(&window, &path).await?;
        let slot = format!("__trn_{}", SLOT_SEQ.fetch_add(1, Ordering::Relaxed));
        let url = format!("{API_BASE}{path}");
        eval_fire(&window, kick_script(&slot, &url))?;
        #[cfg(debug_assertions)]
        let t0 = std::time::Instant::now();
        let deadline = tokio::time::Instant::now() + FETCH_TIMEOUT;
        let expr = poll_expr(&slot);
        loop {
            // ponytail: webhook-style invoke-back from the remote page would need
            // a `remote` capability (remote origins can never touch custom
            // commands otherwise). Backend polling needs no extra ACL surface.
            let Some(env) = eval_roundtrip(&window, expr.clone()).await else {
                trn_trace!("LOST path={path} err=proxy lost mid-poll");
                return Err("EDGE_UNAVAILABLE proxy lost".to_string());
            };
            if let Some(r) = parse_poll(&env) {
                // The page answered — transport healthy whatever the status
                // (even a 429 is an answer, and feeds the ladder unchanged).
                set_proxy_state(ProxyState::Ready);
                trn_trace!(
                    "outcome ok={} status={} elapsed_ms={}{}",
                    r.ok,
                    r.status,
                    t0.elapsed().as_millis(),
                    trace_err(&r)
                );
                let out = map_result(r);
                // Only a 2xx body is memoized: a replayed 429 would feed the
                // ladder twice and a replayed 451/404 would double-count the
                // negative registry. The flight slot is NOT the memo — a
                // follower's shared error is per-attempt, never replayed to a
                // later caller (the guard removes the entry on every exit).
                if let Ok(body) = &out {
                    memo_put(&path, body.clone(), now_ms());
                }
                return out;
            }
            if tokio::time::Instant::now() >= deadline {
                trn_trace!(
                    "fetch timeout path={} elapsed_ms={} (hung page)",
                    path,
                    t0.elapsed().as_millis()
                );
                return Err("EDGE_PAUSED proxy timeout".to_string());
            }
            tokio::time::sleep(POLL_EVERY).await;
        }
    }
    .await;
    // The one failure class with no line of its own. Every other exit above
    // traces itself (`outcome`, `PAUSED`, `CEILING`, `NOT READY`, `LOST`,
    // `fetch timeout`), and the infra arms that return through `?` — window
    // build, eval send, recreate — are exactly the EDGE_UNAVAILABLE family,
    // which is a pure infrastructure string and never carries a response body.
    // Without this they were invisible in the panel: the caller got an error and
    // the transport log said nothing at all.
    if let Err(e) = &out {
        if e.starts_with("EDGE_UNAVAILABLE") {
            trn_trace!("FAILED path={} err={}", path, e);
        }
    }
    flight.publish(out.clone());
    out
}

/// Cheap pause pre-check for TS: same predicate as the in-fetch gate, but no
/// window, no eval, no network — just Win32 reads. Lets `trnGet` fail fast
/// BEFORE claiming a serial-gate slot (live proof: paused fills burned
/// 2.6s→25s+ waits plus full lobby budget with zero data). The in-fetch
/// check stays as backstop for races. Fail-open by convention: TS treats any
/// invoke error as "not paused".
#[tauri::command]
pub fn trn_proxy_paused(phase: Option<String>) -> bool {
    should_pause(
        crate::window_manager::find_valorant_game_window().is_some(),
        game_has_focus(),
        phase.as_deref().unwrap_or(""),
        false,
    )
}

/// Proxy page state for the DevDashboard Tracker QA readout (Rust-owned —
/// TS never guesses): READY / CHALLENGED / RECREATED / PAUSED, UNKNOWN
/// before the first fetch. Reads one atomic — no eval, no network.
#[tauri::command]
pub fn trn_proxy_state() -> String {
    proxy_state_str(PROXY_STATE.load(Ordering::Relaxed)).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_rules_allowlist() {
        assert!(validate_path("/api/v2/valorant/standard/profile/riot/x%23y").is_ok());
        assert_eq!(validate_path("https://api.tracker.gg/api/x").unwrap_err(), "Invalid path.");
        assert_eq!(validate_path("/api/has space").unwrap_err(), "Invalid path.");
        assert_eq!(validate_path("/api/has\nnewline").unwrap_err(), "Invalid path.");
        assert_eq!(validate_path("/other/root").unwrap_err(), "Invalid path.");
        assert_eq!(validate_path(&format!("/api/{}", "x".repeat(300))).unwrap_err(), "Path too long.");
    }

    #[test]
    fn pause_truth_table() {
        // No game, or game not owning the screen: never pause, any phase.
        assert!(!should_pause(false, false, "", false));
        assert!(!should_pause(false, true, "coregame", false));
        assert!(!should_pause(true, false, "coregame", false));
        // Fullscreen lobby/agent-select/menus: ALWAYS fetch (pre-fetch window).
        for phase in ["pregame", "lobby", "menu", "menus", "idle", "PREGAME", " Pregame "] {
            assert!(!should_pause(true, true, phase, false), "phase: {phase}");
        }
        // Fullscreen in-match: pause (EDGE_PAUSED, retried next call).
        for phase in ["coregame", "ingame", "INGAME"] {
            assert!(should_pause(true, true, phase, false), "phase: {phase}");
        }
        // Unknown/blank hint + foreground: fullscreen facts decide (protects
        // mid-match FPS when the hint never arrived).
        assert!(should_pause(true, true, "", false));
        assert!(should_pause(true, true, "bogus", false));
        // Tabbed out (present, not foreground): ALWAYS fetch, even mid-match
        // or unknown — the user is looking at Recon, zero FPS risk. (Live
        // proof: rect-only borderless detection kept a tabbed-out window
        // "fullscreen" forever.)
        for phase in ["coregame", "ingame", "", "bogus", "pregame", "idle"] {
            assert!(!should_pause(true, false, phase, false), "tabbed-out phase: {phase}");
        }
        // Foreground pregame lobby fetches even while the game owns the screen.
        assert!(!should_pause(true, true, "pregame", false));
        // Drain split: an already-budgeted fill drains across the flip even
        // fullscreen in-match; only NEW fills gate.
        for phase in ["coregame", "ingame", "", "bogus", "pregame"] {
            assert!(!should_pause(true, true, phase, true), "drain phase: {phase}");
        }
        assert!(!should_pause(false, false, "coregame", true));
    }

    #[test]
    fn kick_embeds_json_escaped() {
        let s = kick_script("__trn_7", "https://api.tracker.gg/api/a\"b/بطيوس%23x");
        assert!(s.contains("\"__trn_7\""));
        assert!(s.contains("credentials:'include'"));
        // The quote is JSON-escaped — the page sees one string, no breakout.
        assert!(s.contains("\\\""));
        assert!(s.contains("بطيوس%23x"));
        // Slot is nulled first so a stale result can never be misread.
        assert!(s.starts_with("window[\"__trn_7\"]=null;"));
        // The slot reports the UNtruncated length, so the backend can tell a
        // body the slice cut from one that arrived whole.
        assert!(s.contains("len:b.length"), "got: {s}");
        assert!(
            s.contains(&format!(".slice(0,{MAX_SLOT_CHARS})")),
            "got: {s}"
        );
    }

    #[test]
    fn poll_expr_reads_slot() {
        assert_eq!(poll_expr("__trn_3"), "String(window[\"__trn_3\"]??'')");
    }

    #[test]
    fn parse_poll_pending_and_garbage() {
        assert!(parse_poll("\"\"").is_none()); // pending: empty string envelope
        assert!(parse_poll("null").is_none());
        assert!(parse_poll("garbage").is_none());
        assert!(parse_poll("\"not json\"").is_none());
        let env = serde_json::to_string(
            &serde_json::to_string(&serde_json::json!({ "ok": true, "status": 200, "body": "{}" })).unwrap(),
        )
        .unwrap();
        let r = parse_poll(&env).expect("resolves");
        assert!(r.ok && r.status == 200 && r.body == "{}");
    }

    #[test]
    fn result_shapes_are_http() {
        let ok = |body: &str| SlotResult {
            ok: true,
            status: 200,
            body: body.into(),
            len: body.chars().count(),
        };
        assert_eq!(map_result(ok("{}")).unwrap(), "{}");
        let e = map_result(SlotResult { ok: true, status: 429, body: "limited".into(), len: 0 }).unwrap_err();
        assert_eq!(e, "HTTP 429: limited");
        let e = map_result(SlotResult { ok: false, status: 403, body: "bot".into(), len: 0 }).unwrap_err();
        assert_eq!(e, "HTTP 403: bot");
        // In-page network failure is transient (no session pin).
        let e = map_result(SlotResult { ok: false, status: 0, body: "Failed to fetch".into(), len: 0 }).unwrap_err();
        assert!(e.starts_with("EDGE_PAUSED"), "got: {e}");
        // 300-char snippet bound, unicode-safe.
        let big = "é".repeat(400);
        let e = map_result(SlotResult { ok: true, status: 451, body: big, len: 0 }).unwrap_err();
        assert_eq!(e.chars().count(), "HTTP 451: ".chars().count() + 300);
    }

    /// A 1.72 MB season segment used to be sliced to 1.5 MB in the page, so
    /// the slot came back `ok=true status=200` carrying invalid JSON: the
    /// transport called it a success and the act never loaded. An overrun must
    /// be an error, not a corrupt body.
    #[test]
    fn an_oversized_body_is_refused_not_truncated() {
        let cut = SlotResult {
            ok: true,
            status: 200,
            body: "{\"half".into(),
            len: MAX_SLOT_CHARS + 1,
        };
        let e = map_result(cut).unwrap_err();
        assert!(e.contains("body too large"), "got: {e}");
        assert!(e.contains(&(MAX_SLOT_CHARS + 1).to_string()), "got: {e}");
        // It must never read as a ladder or a proven negative, or the TS
        // cooldown/negative registries would file a transport limit as data.
        for bad in ["429", "403", "1015", "451", "404"] {
            assert!(!e.contains(bad), "leaked {bad}: {e}");
        }
        // Exactly at the cap is fine: the slice is inclusive of the last char.
        let at = SlotResult {
            ok: true,
            status: 200,
            body: "{}".into(),
            len: MAX_SLOT_CHARS,
        };
        assert_eq!(map_result(at).unwrap(), "{}");
        // A rejected fetch has no body to be too large, whatever `len` says.
        let rejected = SlotResult {
            ok: false,
            status: 0,
            body: "Failed to fetch".into(),
            len: MAX_SLOT_CHARS * 4,
        };
        assert!(map_result(rejected).unwrap_err().starts_with("EDGE_PAUSED"));
        // The cap must stay far above the largest body actually measured.
        assert!(MAX_SLOT_CHARS > 2_000_000, "cap would clip a 1.72MB season");
    }

    #[test]
    fn readiness_probe_is_passive() {
        let s = readiness_probe();
        assert!(s.contains("document.readyState==='complete'"), "got: {s}");
        assert!(s.contains("document.cookie"), "got: {s}");
        assert!(s.contains("challenges.cloudflare.com"), "got: {s}");
        // The check itself must never touch the network.
        assert!(!s.contains("fetch("), "got: {s}");
        assert!(!s.contains("/api/"), "got: {s}");
        assert!(!s.contains("api.tracker.gg"), "got: {s}");
    }

    #[test]
    fn readiness_parse_pending_and_garbage() {
        assert!(parse_readiness("\"\"").is_none());
        assert!(parse_readiness("null").is_none());
        assert!(parse_readiness("garbage").is_none());
        assert!(parse_readiness("\"not json\"").is_none());
        let env = serde_json::to_string(
            &serde_json::to_string(&serde_json::json!({ "loaded": true, "title": "Tracker", "cookies": "cf_clearance=x", "challenge": false })).unwrap(),
        )
        .unwrap();
        let r = parse_readiness(&env).expect("resolves");
        assert!(r.loaded && !r.challenge);
    }

    #[test]
    fn challenge_title_table() {
        assert!(is_challenge_title("Just a moment..."));
        assert!(is_challenge_title("Attention Required! | Cloudflare"));
        assert!(is_challenge_title("Verifying you are human"));
        assert!(!is_challenge_title("Tracker Network"));
        assert!(!is_challenge_title(""));
    }

    #[test]
    fn cookie_signal() {
        assert!(has_cf_cookie("cf_clearance=abc"));
        assert!(has_cf_cookie("__cf_bm=xyz"));
        assert!(!has_cf_cookie("session=1"));
        assert!(!has_cf_cookie(""));
    }

    #[test]
    fn readiness_gate_table() {
        let ready = |loaded: bool, title: &str, cookies: &str, challenge: bool| {
            is_proxy_ready(&ProxyReadiness {
                loaded,
                host: "tracker.gg".into(),
                title: title.into(),
                cookies: cookies.into(),
                challenge,
            })
        };
        // Fresh page still loading: park.
        assert!(!ready(false, "Tracker", "cf_clearance=x", false));
        // Challenge DOM present, no cookie: park.
        assert!(!ready(true, "Tracker", "", true));
        // Challenge title, no cookie: park.
        assert!(!ready(true, "Just a moment...", "", false));
        // Loaded + no markers: ready via absence (HttpOnly cookies invisible).
        assert!(ready(true, "Tracker", "", false));
        // Loaded + visible clearance cookie: ready.
        assert!(ready(true, "Tracker", "cf_clearance=x", false));
    }

    /// The proven `ok=false status=0` failure: a fresh window's initial
    /// blank document is `readyState === 'complete'`, no markers, no cookies
    /// — the old gate called that ready and the fetch left cross-origin.
    #[test]
    fn blank_document_is_never_ready() {
        let page = |host: &str, cookies: &str| {
            is_proxy_ready(&ProxyReadiness {
                loaded: true,
                host: host.into(),
                title: "Tracker".into(),
                cookies: cookies.into(),
                challenge: false,
            })
        };
        let not_the_page = ["", "about:blank", "localhost", "nottracker.gg"];
        for host in not_the_page {
            assert!(!is_trn_origin(host), "host: {host}");
        }
        // A lookalike suffix must not pass either.
        assert!(!is_trn_origin("tracker.gg.evil.test"));
        assert!(is_trn_origin("tracker.gg"));
        assert!(is_trn_origin("Tracker.GG"));
        assert!(is_trn_origin("api.tracker.gg"));
        assert!(is_trn_origin(" www.tracker.gg "));
        // Every blank-document shape, even with a clearance cookie visible.
        assert!(!page("", "cf_clearance=x"));
        assert!(!page("about:blank", ""));
        // The real page on the same facts is ready.
        assert!(page("tracker.gg", ""));
    }

    /// Readiness reads the origin, so the gate can park a request that
    /// arrived before the page committed instead of firing it blind.
    #[test]
    fn readiness_probe_reads_the_page_origin() {
        let s = readiness_probe();
        assert!(s.contains("location.hostname"), "got: {s}");
        // The probe still touches no network and no api path.
        assert!(!s.contains("fetch("), "got: {s}");
        assert!(!s.contains("/api/"), "got: {s}");
        assert!(!s.contains("api.tracker.gg"), "got: {s}");
    }

    #[test]
    fn proxy_state_strings() {
        assert_eq!(proxy_state_str(ProxyState::Ready as u64), "READY");
        assert_eq!(proxy_state_str(ProxyState::Challenged as u64), "CHALLENGED");
        assert_eq!(proxy_state_str(ProxyState::Recreated as u64), "RECREATED");
        assert_eq!(proxy_state_str(ProxyState::Paused as u64), "PAUSED");
        // Never observed yet (or garbage): UNKNOWN, never a blank.
        assert_eq!(proxy_state_str(u8::MAX as u64), "UNKNOWN");
        assert_eq!(proxy_state_str(99), "UNKNOWN");
    }

    #[test]
    fn idle_teardown_never_races_a_request() {
        // Fresh sweep, nothing in flight: destroy.
        assert!(teardown_still_valid(7, 7, 0));
        // A request completed after this sweep armed: it is stale, so it must
        // NOT destroy (this is the anti-thrash case — a later fetch re-armed
        // the deadline and owns the window now).
        assert!(!teardown_still_valid(7, 8, 0));
        // A request is mid-eval right now: must not destroy, however fresh.
        assert!(!teardown_still_valid(7, 7, 1));
        assert!(!teardown_still_valid(7, 8, 1));
    }

    #[test]
    fn idle_ttl_outlasts_an_active_trn_window() {
        // Matches TRN_DEAD_QUIET_MS in src/utils/trn.ts: teardown must never
        // land inside a ladder/cooldown the TS layer still considers active.
        assert_eq!(PROXY_IDLE_TTL, Duration::from_secs(5 * 60));
        // Re-create cost is a fresh navigation + Cloudflare re-clearance, so
        // a TTL below the readiness budget would guarantee thrash.
        assert!(PROXY_IDLE_TTL > READINESS_TIMEOUT);
    }

    /// Fresh ceiling state, zeroed window.
    fn ceiling() -> TrnCeiling {
        TrnCeiling {
            lobby: String::new(),
            lobby_spent: 0,
            window_start_ms: 0,
            window_spent: 0,
        }
    }

    #[test]
    fn lobby_ceiling_caps_one_fill() {
        let mut c = ceiling();
        // One full lobby fill: 12 players x 2 requests = 24, plus headroom.
        for i in 0..TRN_LOBBY_MAX_REQUESTS {
            assert_eq!(
                ceiling_allows(&mut c, "m1", 1000),
                Ceiling::Allow,
                "request {i} must fit inside one lobby"
            );
        }
        // Past it: denied, and the counter does not run away.
        assert_eq!(ceiling_allows(&mut c, "m1", 1000), Ceiling::Deny("lobby"));
        assert_eq!(c.lobby_spent, TRN_LOBBY_MAX_REQUESTS);
    }

    #[test]
    fn lobby_ceiling_never_carries_into_the_next_match() {
        let mut c = ceiling();
        for _ in 0..TRN_LOBBY_MAX_REQUESTS {
            assert_eq!(ceiling_allows(&mut c, "m1", 1000), Ceiling::Allow);
        }
        assert_eq!(ceiling_allows(&mut c, "m1", 1000), Ceiling::Deny("lobby"));
        // New match: a fresh budget, even inside the same hour.
        assert_eq!(ceiling_allows(&mut c, "m2", 1000), Ceiling::Allow);
        assert_eq!(c.lobby, "m2");
        assert_eq!(c.lobby_spent, 1);
        // And the old lobby is denied again if it somehow comes back.
        assert_eq!(ceiling_allows(&mut c, "m1", 1000), Ceiling::Allow);
    }

    #[test]
    fn unlobbied_requests_are_not_billed_to_a_lobby() {
        let mut c = ceiling();
        // Tracker tab / modals carry no lobby key: they must not consume any
        // lobby's budget, and must not reset one either.
        for _ in 0..TRN_LOBBY_MAX_REQUESTS * 2 {
            assert_eq!(ceiling_allows(&mut c, "", 1000), Ceiling::Allow);
        }
        assert_eq!(c.lobby, "");
        assert_eq!(c.lobby_spent, 0);
        assert_eq!(ceiling_allows(&mut c, "m1", 1000), Ceiling::Allow);
    }

    #[test]
    fn hour_ceiling_is_the_hard_ceiling() {
        let mut c = ceiling();
        // A distinct lobby per request, so ONLY the hour ceiling can bind —
        // the per-lobby one rolls over on every match change (see above).
        for i in 0..TRN_HOURLY_MAX_REQUESTS {
            assert_eq!(
                ceiling_allows(&mut c, &format!("m{i}"), 1000),
                Ceiling::Allow,
                "request {i}"
            );
        }
        // Spent: the hour ceiling answers, with or without a lobby key.
        assert_eq!(ceiling_allows(&mut c, "mZ", 1000), Ceiling::Deny("hour"));
        assert_eq!(ceiling_allows(&mut c, "", 1000), Ceiling::Deny("hour"));
        assert_eq!(c.window_spent, TRN_HOURLY_MAX_REQUESTS);
        // Next hour: the window rolls and the budget is back.
        let next = 1000 + TRN_WINDOW_MS;
        assert_eq!(ceiling_allows(&mut c, "m1", next), Ceiling::Allow);
        assert_eq!(c.window_spent, 1);
        assert_eq!(c.lobby, "m1");
        assert_eq!(c.lobby_spent, 1);
    }

    #[test]
    fn hour_window_never_exceeds_the_gate_maximum() {
        // The ceiling must sit BELOW what two realms can do flat out
        // (1 req / 6s each = 1200/hour) or it is not a ceiling at all.
        let two_realm_gate_max_per_hour = 2 * (3_600_000 / TRN_GAP_MIN_MS_MS);
        assert!(u64::from(TRN_HOURLY_MAX_REQUESTS) < two_realm_gate_max_per_hour);
        // ...and above one full lobby fill with room to spare, so a normal
        // match can never trip it.
        assert!(TRN_HOURLY_MAX_REQUESTS > TRN_LOBBY_MAX_REQUESTS * 4);
    }

    /// The TS serial gate's floor, mirrored so the assertion above is about
    /// real numbers rather than a literal. `trn.ts` owns the policy; this is
    /// only the shape of the guarantee.
    const TRN_GAP_MIN_MS_MS: u64 = 6_000;

    #[test]
    fn memo_replays_only_inside_the_ttl() {
        // Timestamp far ahead of the other test's entries so this entry is
        // never the oldest victim of the shared static's eviction.
        let t0 = 50_000_000u64;
        let path = "/api/v2/valorant/standard/profile/riot/a%23b";
        memo_put(path, "{}".to_string(), t0);
        assert_eq!(memo_get(path, t0).as_deref(), Some("{}"));
        assert_eq!(
            memo_get(path, t0 + TRN_MEMO_TTL_MS - 1).as_deref(),
            Some("{}")
        );
        assert_eq!(memo_get(path, t0 + TRN_MEMO_TTL_MS), None);
        // A different path never replays another path's body.
        assert_eq!(memo_get("/api/other", t0), None);
    }

    #[test]
    fn memo_is_bounded_by_dropping_the_oldest() {
        for i in 0..(TRN_MEMO_MAX * 2) {
            memo_put(&format!("/api/p{i}"), format!("{{{i}}}"), 1_000 + i as u64);
        }
        let m = TRN_MEMO.lock().expect("memo lock");
        assert!(m.len() <= TRN_MEMO_MAX, "memo grew to {}", m.len());
        // The newest survives; the oldest is gone.
        let newest = format!("/api/p{}", TRN_MEMO_MAX * 2 - 1);
        drop(m);
        assert!(memo_get(&newest, 2_000 + TRN_MEMO_MAX as u64 * 2).is_some());
        assert_eq!(memo_get("/api/p0", 2_000 + TRN_MEMO_MAX as u64 * 2), None);
    }

    #[test]
    fn watchdog_verdict_table() {
        let ping = |loaded: bool, title: &str, cookies: &str, challenge: bool| {
            Some(ProxyReadiness {
                loaded,
                host: "tracker.gg".into(),
                title: title.into(),
                cookies: cookies.into(),
                challenge,
            })
        };
        // Healthy page answers ready: proceed, no recreate.
        assert!(!watchdog_should_recreate(ping(true, "Tracker", "", false).as_ref()));
        assert!(!watchdog_should_recreate(ping(true, "Tracker", "cf_clearance=x", false).as_ref()));
        // Wedged (proven live: silent past the budget): recreate.
        assert!(watchdog_should_recreate(None));
        // Challenge mid-life (answers, but not clear): recreate so a fresh
        // navigation re-earns clearance.
        assert!(watchdog_should_recreate(ping(true, "Tracker", "", true).as_ref()));
        assert!(watchdog_should_recreate(ping(true, "Just a moment...", "", false).as_ref()));
        assert!(watchdog_should_recreate(ping(false, "Tracker", "cf_clearance=x", false).as_ref()));
        // Back on the blank document (a navigation that never committed):
        // recreate rather than fetch cross-origin and die with no status.
        assert!(watchdog_should_recreate(
            Some(ProxyReadiness {
                loaded: true,
                host: String::new(),
                title: "Tracker".into(),
                cookies: "cf_clearance=x".into(),
                challenge: false,
            })
            .as_ref()
        ));
    }

    /// A `status=0` line is the one failure the trace used to render
    /// unexplanable: `ok=false status=0 elapsed_ms=101` said nothing about
    /// why. The page's own message now rides along, and it must stay on one
    /// line and inside the ring's budget.
    #[test]
    fn trace_err_explains_a_rejected_fetch_and_nothing_else() {
        let r = |ok: bool, status: u16, body: &str| SlotResult {
            ok,
            status,
            body: body.into(),
            len: 0,
        };
        // The whole point: the in-page exception reaches the trace.
        assert_eq!(
            trace_err(&r(false, 0, "Failed to fetch")),
            " err=Failed to fetch"
        );
        assert_eq!(
            trace_err(&r(
                false,
                0,
                "NetworkError when attempting to fetch resource."
            )),
            " err=NetworkError when attempting to fetch resource."
        );
        // Success and HTTP failures keep the line exactly as it was: their
        // status is the fact, and a response body is never logged.
        assert_eq!(trace_err(&r(true, 200, "{\"a\":1}")), "");
        assert_eq!(trace_err(&r(true, 429, "slow down")), "");
        assert_eq!(trace_err(&r(false, 403, "<html>blocked</html>")), "");
        // A multi-line message would split one ring line into two rows.
        let nl = trace_err(&r(false, 0, "line one\nline\ttwo"));
        assert!(!nl.contains('\n') && !nl.contains('\t'), "got: {nl:?}");
        assert_eq!(nl, " err=line one line two");
        // Bounded, unicode-safe, and an absent message is named, not blank.
        let big = "é".repeat(TRACE_ERR_CHARS + 100);
        assert_eq!(
            trace_err(&r(false, 0, &big)).chars().count(),
            " err=".len() + TRACE_ERR_CHARS
        );
        assert_eq!(trace_err(&r(false, 0, "")), " err=<empty>");
        assert_eq!(trace_err(&r(false, 0, "   \n ")), " err=<empty>");
    }

    #[test]
    fn watchdog_reason_distinguishes_silence_from_a_changed_page() {
        let page = |loaded: bool, title: &str, cookies: &str, challenge: bool| {
            Some(ProxyReadiness {
                loaded,
                host: "tracker.gg".into(),
                title: title.into(),
                cookies: cookies.into(),
                challenge,
            })
        };
        assert_eq!(watchdog_reason(None), "silent");
        assert_eq!(
            watchdog_reason(page(true, "Tracker", "", true).as_ref()),
            "not-ready"
        );
        // The two must agree with the verdict, or the trace would name the
        // wrong failure for a recreate.
        assert!(watchdog_should_recreate(None));
        assert!(watchdog_should_recreate(
            page(true, "Just a moment...", "", false).as_ref()
        ));
        assert!(!watchdog_should_recreate(
            page(true, "Tracker", "cf_clearance=x", false).as_ref()
        ));
    }

    /// The probe reads the cookie jar WHOLE. A `.slice(0,500)` could cut
    /// `cf_clearance` off the end of a long jar and report "no clearance" on a
    /// cleared page.
    #[test]
    fn readiness_probe_never_slices_the_cookie_jar() {
        let s = readiness_probe();
        assert!(s.contains("cookies:document.cookie||''"), "got: {s}");
        // host/title are human labels, so their slices are fine and must stay.
        assert!(
            s.contains("host:(location.hostname||'').slice(0,80)"),
            "got: {s}"
        );
        // And the clearance search is proven on a jar too long for any slice.
        let long_jar = format!("{} cf_clearance=tok", "x=1; ".repeat(200));
        assert!(has_cf_cookie(&long_jar));
    }

    /* ---- single-flight ---- *
     * What these prove: the leader/follower decision, the follower's
     * bounded wait, and the guard's leak/deadlock safety — over a real tokio
     * runtime and a real (hand-published) slot. What they do NOT prove: the
     * real webview path in `trn_proxy_fetch`, which needs an AppHandle and
     * a live tracker.gg page. The wire count is asserted with a counter that
     * only the leader arm increments. */

    fn slot() -> FlightSlot {
        Arc::new(Mutex::new(None))
    }

    #[test]
    fn one_leader_per_path() {
        let mut f: Vec<(String, FlightSlot)> = Vec::new();
        let (a, lead_a) = flight_acquire(&mut f, "/api/v2/players/abc");
        assert!(lead_a, "first caller must lead");
        // A second realm asking for the same path while the first is on the
        // wire joins it instead of opening a second flight.
        let (b, lead_b) = flight_acquire(&mut f, "/api/v2/players/abc");
        assert!(!lead_b, "second caller must follow");
        assert!(Arc::ptr_eq(&a, &b), "follower must share the leader's slot");
        // A different path is a different request, so it leads its own.
        let (c, lead_c) = flight_acquire(&mut f, "/api/v2/players/xyz");
        assert!(lead_c);
        assert!(!Arc::ptr_eq(&a, &c));
        assert_eq!(f.len(), 2);
    }

    #[test]
    fn follower_is_never_billed_and_removal_is_identity_safe() {
        let mut f: Vec<(String, FlightSlot)> = Vec::new();
        let (a, _) = flight_acquire(&mut f, "/api/p");
        flight_remove(&mut f, "/api/p", &a);
        assert!(f.is_empty(), "leader's guard must remove its own entry");
        // A new leader for the same path, then a LATE guard from the old one:
        // the new entry must survive, or a live flight would lose its waiters.
        let (b, lead_b) = flight_acquire(&mut f, "/api/p");
        assert!(lead_b);
        flight_remove(&mut f, "/api/p", &a);
        assert_eq!(f.len(), 1, "a stale guard must not remove a live flight");
        flight_remove(&mut f, "/api/p", &b);
        assert!(f.is_empty());
    }

    #[tokio::test]
    async fn two_callers_one_wire_request() {
        let mut f: Vec<(String, FlightSlot)> = Vec::new();
        let (leader, is_leader) = flight_acquire(&mut f, "/api/season");
        let (follower, is_follower) = flight_acquire(&mut f, "/api/season");
        assert!(is_leader && !is_follower);
        let wire = Arc::new(AtomicU64::new(0));
        // Leader: exactly one "fetch", published 120ms later.
        let w = Arc::clone(&wire);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(120)).await;
            w.fetch_add(1, Ordering::AcqRel);
            *leader.lock().expect("slot") = Some(Ok("{\"seg\":1}".to_string()));
        });
        let body = wait_flight("/api/season", &follower, Duration::from_secs(5))
            .await
            .expect("follower must receive the leader body");
        assert_eq!(body, "{\"seg\":1}");
        assert_eq!(
            wire.load(Ordering::Acquire),
            1,
            "exactly one underlying fetch"
        );
    }

    #[tokio::test]
    async fn follower_times_out_instead_of_hanging() {
        let s = slot();
        // Nothing ever publishes (a wedged leader): the follower must surface
        // the bounded shape, never wait forever.
        let out = wait_flight("/api/never", &s, Duration::from_millis(60)).await;
        assert_eq!(out.unwrap_err(), FOLLOWER_TIMEOUT);
        assert!(!FOLLOWER_TIMEOUT.contains("429") && !FOLLOWER_TIMEOUT.contains("403"));
    }

    #[tokio::test]
    async fn leader_failure_does_not_strand_a_follower_or_poison_the_memo() {
        let path = "/api/leader-fails";
        let s = slot();
        let s2 = Arc::clone(&s);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(60)).await;
            *s2.lock().expect("slot") = Some(Err("HTTP 429: slow down".to_string()));
        });
        let out = wait_flight(path, &s, Duration::from_secs(5)).await;
        // Verbatim: the follower feeds the same ladder with the same answer.
        assert_eq!(out.unwrap_err(), "HTTP 429: slow down");
        // ...and nothing was memoized, so a later caller is a fresh leader
        // rather than a replay of the leader's error.
        assert!(memo_get(path, now_ms()).is_none());
    }

    #[tokio::test]
    async fn abandoned_leader_unblocks_followers_and_leaves_no_entry() {
        // The real static, so the guard's Drop — the thing under test — runs
        // for real. Unique path: the tests share it.
        let path = "/api/abandoned-leader";
        let (leader, is_leader) = flight_acquire(&mut TRN_FLIGHTS.lock().expect("flights"), path);
        assert!(is_leader);
        // The leader leaves without publishing (cancelled or panicked).
        drop(FlightGuard::new(path, &leader));
        // A follower already holding the slot is released at once instead of
        // burning its budget, and the entry is gone — the next caller leads
        // afresh rather than joining a dead flight.
        let out = wait_flight(path, &leader, Duration::from_millis(60)).await;
        assert_eq!(out.unwrap_err(), FOLLOWER_ABANDONED);
        let (again, leads_again) = flight_acquire(&mut TRN_FLIGHTS.lock().expect("flights"), path);
        assert!(leads_again, "an abandoned entry must not be reused");
        drop(FlightGuard::new(path, &again));
        // Not memoized, and not a ladder string.
        assert!(memo_get(path, now_ms()).is_none());
        assert!(!FOLLOWER_ABANDONED.contains("429"));
    }

    #[tokio::test]
    async fn in_flight_path_survives_the_memo_expiring() {
        let path = "/api/slow-season";
        // Nothing memoized yet: the flight alone has to carry the request.
        assert!(memo_get(path, now_ms()).is_none());
        let s = slot();
        let s2 = Arc::clone(&s);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            *s2.lock().expect("slot") = Some(Ok("{\"late\":true}".to_string()));
        });
        // The wait outlives any memo TTL that could be written mid-flight, so
        // an expired (or never written) entry cannot strand the follower.
        let out = wait_flight(path, &s, Duration::from_secs(5)).await;
        assert_eq!(out.unwrap(), "{\"late\":true}");
        assert!(FOLLOWER_WAIT > Duration::from_millis(TRN_MEMO_TTL_MS));
    }

    /* ---- dev trace ring ---- */

    fn line(seq: u64) -> TraceLine {
        TraceLine {
            seq,
            text: format!("[TRN {seq}] x"),
        }
    }

    #[test]
    fn trace_ring_evicts_oldest_and_reads_incrementally() {
        let mut r: VecDeque<TraceLine> = VecDeque::new();
        for seq in 1..=(TRACE_RING_CAP as u64 + 10) {
            trace_push(&mut r, line(seq), TRACE_RING_CAP);
        }
        assert_eq!(r.len(), TRACE_RING_CAP);
        assert_eq!(r.front().unwrap().seq, 11, "oldest must be evicted");
        assert_eq!(r.back().unwrap().seq, TRACE_RING_CAP as u64 + 10);
        // Incremental read: only what the poller has not seen.
        let head = r.back().unwrap().seq;
        let (h, fresh, missed) = trace_since(&r, head - 3);
        assert_eq!(h, head);
        let seqs: Vec<u64> = fresh.iter().map(|l| l.seq).collect();
        assert_eq!(seqs, vec![head - 2, head - 1, head]);
        assert!(!missed);
        // A slow poller is told it missed lines instead of silently losing them.
        let (_, fresh, missed) = trace_since(&r, 2);
        assert!(missed);
        assert_eq!(fresh.first().unwrap().seq, 11);
        // Zero cap never stores, exactly like perf::push_sample.
        let mut z: VecDeque<TraceLine> = VecDeque::new();
        trace_push(&mut z, line(1), 0);
        assert!(z.is_empty());
        // An empty ring answers with the poller's own cursor, never a reset.
        let (h, fresh, missed) = trace_since(&VecDeque::new(), 42);
        assert_eq!((h, fresh.len(), missed), (42, 0, false));
    }
}
