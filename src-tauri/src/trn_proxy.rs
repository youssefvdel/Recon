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
//! budget/spread/caches) is untouched — transport swap only. This window is
//! the SOLE TRN transport (no Rust HTTP anywhere). Error shapes are
//! `HTTP {code}: …`; transport states are `EDGE_UNAVAILABLE …` (broken proxy
//! — surfaces to the caller) vs `EDGE_PAUSED …` (in-match fullscreen / hung
//! page / page not ready — surfaces to the caller, retried next call).
//!
//! Watchdog: a wedged page (proven live: window exists but its JS engine
//! answers no eval within 2s — hung challenge page or dead renderer) used to
//! kill every fetch silently pre-network: no cooldown, no errors, all dashes.
//! Every fetch therefore opens with one fast liveness ping (the passive
//! readiness probe, zero API calls); on wedge/challenge the window is
//! destroyed + recreated so a fresh navigation re-earns clearance, and the
//! readiness gate re-vets it. `trn_proxy_state` exposes the page state
//! (READY / CHALLENGED / RECREATED / PAUSED) for the DevDashboard readout.

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
/// Cap echoed into the in-page slot (TRN bodies are ~100 KiB; never binds).
const MAX_SLOT_CHARS: usize = 1_500_000;

static SLOT_SEQ: AtomicU64 = AtomicU64::new(1);
/// Per window lifetime: false until the first readiness pass. Reset when a
/// fresh window is created — an existing window skips the gate.
static PROXY_READY: AtomicBool = AtomicBool::new(false);

/// DEV-ONLY structured trace: `[TRN <epoch-ms>] …` on stderr (visible in the
/// `tauri dev` terminal). The codebase writes `log::*` elsewhere but
/// initializes no logger backend, so `log::debug!` would vanish even in dev.
/// Fully compiled out when `debug_assertions` are off: zero prod output, no
/// new deps. Never log response bodies (player names) — paths, phases and
/// statuses only.
#[cfg(debug_assertions)]
macro_rules! trn_trace {
    ($($t:tt)*) => {{
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        eprintln!("[TRN {}] {}", ms, format!($($t)*));
    }};
}
#[cfg(not(debug_assertions))]
macro_rules! trn_trace {
    ($($t:tt)*) => {
        ()
    };
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

#[derive(serde::Deserialize)]
struct SlotResult {
    ok: bool,
    status: u16,
    body: String,
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
        window[{slot}]=JSON.stringify({{ok:r.ok,status:r.status,body:(b||'').slice(0,{MAX_SLOT_CHARS})}})\
        }}).catch(e=>{{\
        window[{slot}]=JSON.stringify({{ok:false,status:0,body:String((e&&e.message)||e||'fetch failed').slice(0,500)}})\
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

/// Map a resolved slot to the command surface. Pure — unit-tested.
fn map_result(r: SlotResult) -> Result<String, String> {
    if r.ok && (200..300).contains(&r.status) {
        return Ok(r.body);
    }
    if r.status == 0 {
        return Err(format!("EDGE_PAUSED in-page fetch failed: {}", snippet(&r.body)));
    }
    Err(format!("HTTP {}: {}", r.status, snippet(&r.body)))
}

/// Passive readiness probe: load state + cookie jar + challenge markers in one
/// string. NO fetch(), NO /api/, NO network — pure DOM reads so the check
/// itself can never burn the IP. Pure — unit-tested.
fn readiness_probe() -> String {
    "JSON.stringify({loaded:document.readyState==='complete',title:(document.title||'').slice(0,120),cookies:(document.cookie||'').slice(0,500),challenge:!!(document.querySelector('iframe[src*=\"challenges.cloudflare.com\"],#cf-challenge,#challenge-form,.cf-challenge'))})".to_string()
}

#[derive(serde::Deserialize)]
struct ProxyReadiness {
    loaded: bool,
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

/// Ready = load complete + clearance (cookie jar OR no challenge markers).
/// Pure — unit-tested.
fn is_proxy_ready(r: &ProxyReadiness) -> bool {
    r.loaded && (has_cf_cookie(&r.cookies) || (!r.challenge && !is_challenge_title(&r.title)))
}

/// Park queued fetches until the page is ready (bounded). Once per window
/// lifetime — after the first pass PROXY_READY sticks until a fresh window
/// resets it. EDGE_PAUSED on expiry (transient, retried next call).
async fn wait_proxy_ready(window: &WebviewWindow) -> Result<(), String> {
    if PROXY_READY.load(Ordering::Relaxed) {
        return Ok(());
    }
    let deadline = tokio::time::Instant::now() + READINESS_TIMEOUT;
    let probe = readiness_probe();
    loop {
        let Some(env) = eval_roundtrip(window, probe.clone()).await else {
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
            trn_trace!("NOT READY (still loading/challenged after budget)");
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
/// fetch. Makes no API calls itself.
fn recreate_proxy(app: &AppHandle, window: &mut WebviewWindow) -> Result<(), String> {
    destroy_proxy_window(app);
    PROXY_READY.store(false, Ordering::Relaxed);
    set_proxy_state(ProxyState::Recreated);
    trn_trace!("RECREATED (wedge/challenge — fresh navigation re-earns clearance)");
    *window = proxy_window(app)?;
    Ok(())
}

/// Watchdog: one fast liveness ping per fetch on windows that previously
/// passed readiness (fresh windows skip — the gate below vets them). The
/// ping is the passive readiness probe (DOM reads only, zero API calls):
/// silence past the budget or a mid-life challenge recreates the window.
/// Healthy pages answer in ms, so the steady-state cost is one eval.
async fn ensure_proxy_alive(app: &AppHandle, window: &mut WebviewWindow) -> Result<(), String> {
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
    recreate_proxy(app, window)
}

/// Existing hidden window, or a fresh one. Shared WebView2 pool (default
/// environment — no separate data dir), stays hidden + off-taskbar, never
/// focused. Idempotent: safe to call per fetch.
fn proxy_window(app: &AppHandle) -> Result<WebviewWindow, String> {
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
/// gated.
#[tauri::command]
pub async fn trn_proxy_fetch(app: AppHandle, path: String, phase: Option<String>, drain: Option<bool>) -> Result<String, String> {
    validate_path(&path)?;
    let phase_str = phase.as_deref().unwrap_or("");
    let drain = drain.unwrap_or(false);
    trn_trace!("fetch start path={} phase={} drain={}", path, phase_str, drain);
    if should_pause(
        crate::window_manager::find_valorant_game_window().is_some(),
        game_has_focus(),
        phase_str,
        drain,
    ) {
        set_proxy_state(ProxyState::Paused);
        trn_trace!("PAUSED phase={} (in-match fullscreen)", phase_str);
        return Err("EDGE_PAUSED game fullscreen".to_string());
    }
    let mut window = proxy_window(&app)?;
    // Watchdog first: a wedged page dies silently pre-network without this.
    // Recreates + re-gates; healthy pages cost one ms-scale eval.
    ensure_proxy_alive(&app, &mut window).await?;
    // Passive gate: never fetch blind from a fresh/challenged page. Queued
    // callers park here together until ready (bounded), then EDGE_PAUSED.
    wait_proxy_ready(&window).await?;
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
            return Err("EDGE_UNAVAILABLE proxy lost".to_string());
        };
        if let Some(r) = parse_poll(&env) {
            // The page answered — transport healthy whatever the status
            // (even a 429 is an answer, and feeds the ladder unchanged).
            set_proxy_state(ProxyState::Ready);
            trn_trace!("outcome ok={} status={} elapsed_ms={}", r.ok, r.status, t0.elapsed().as_millis());
            return map_result(r);
        }
        if tokio::time::Instant::now() >= deadline {
            trn_trace!("fetch timeout (hung page)");
            return Err("EDGE_PAUSED proxy timeout".to_string());
        }
        tokio::time::sleep(POLL_EVERY).await;
    }
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
        assert_eq!(
            map_result(SlotResult { ok: true, status: 200, body: "{}".into() }).unwrap(),
            "{}"
        );
        let e = map_result(SlotResult { ok: true, status: 429, body: "limited".into() }).unwrap_err();
        assert_eq!(e, "HTTP 429: limited");
        let e = map_result(SlotResult { ok: false, status: 403, body: "bot".into() }).unwrap_err();
        assert_eq!(e, "HTTP 403: bot");
        // In-page network failure is transient (no session pin).
        let e = map_result(SlotResult { ok: false, status: 0, body: "Failed to fetch".into() }).unwrap_err();
        assert!(e.starts_with("EDGE_PAUSED"), "got: {e}");
        // 300-char snippet bound, unicode-safe.
        let big = "é".repeat(400);
        let e = map_result(SlotResult { ok: true, status: 451, body: big }).unwrap_err();
        assert_eq!(e.chars().count(), "HTTP 451: ".chars().count() + 300);
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
            is_proxy_ready(&ProxyReadiness { loaded, title: title.into(), cookies: cookies.into(), challenge })
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
    fn watchdog_verdict_table() {
        let ping = |loaded: bool, title: &str, cookies: &str, challenge: bool| {
            Some(ProxyReadiness { loaded, title: title.into(), cookies: cookies.into(), challenge })
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
    }
}
