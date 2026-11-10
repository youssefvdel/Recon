#![allow(dead_code)]
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
//! Warden: tracker.gg now answers a captcha challenge (`HTTP 429
//! {"code":"Warden::Challenge"}`, or a body saying "captcha"). `map_result`
//! classifies that as `TRN_CAPTCHA_REQUIRED` — a shape no timer can clear, so
//! callers must not retry it on the cooldown ladder. `trn_verify_open` shows the
//! one window a human can solve it in; `trn_proxy_reset` then drops the hidden
//! window so its next navigation inherits the cookies that earned the pass.
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
#[cfg(debug_assertions)]
use self::result::trace_err;
#[cfg(debug_assertions)]
use self::trace::trace_emit;
use self::ceiling::{Ceiling, ceiling_refundable, now_ms, refund_ceiling, spend_ceiling};
use self::constants::{API_BASE, FETCH_TIMEOUT, POLL_EVERY};
use self::flight::{FOLLOWER_WAIT, FlightGuard, FlightResult, TRN_FLIGHTS, flight_acquire, wait_flight};
use self::memo::{memo_get, memo_put};
use self::readiness::{wait_proxy_ready};
use self::result::{map_result};
use self::script::{kick_script, parse_poll, poll_expr, validate_path};
use self::state::{ProxyState, SLOT_SEQ, set_proxy_state};
use self::window::{InflightGuard, ensure_proxy_alive, eval_fire, proxy_window};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use self::constants::{VERIFY_URL};
use self::script::{WARDEN_HOOK_JS, WARDEN_PROBE_JS, game_has_focus, should_pause};
use self::state::{PROXY_STATE, PROXY_TEARDOWN_GEN, proxy_state_str, reset_proxy_lifecycle};
use self::trace::{TRACE_RING, trace_since};
use self::window::{destroy_proxy_window, eval_roundtrip};

#[macro_use]
mod trace;
mod constants;
mod state;
mod ceiling;
mod memo;
mod flight;
mod window;
mod script;
mod result;
mod readiness;

pub use constants::{PROXY_LABEL, VERIFY_LABEL};
pub use trace::{TraceLine, TrnTraceLog};
#[cfg(debug_assertions)]
pub use trace::TRACE_RING_CAP;



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
/// Open the ONE visible window where a human clears tracker.gg's Warden
/// captcha; the hidden proxy can never solve one.
///
/// Same WebView2 profile as every other window (no custom `data_directory`), so
/// the clearance cookies it earns are exactly what the next `trn_proxy_fetch`
/// presents after `trn_proxy_reset`. Labeled `trn-verify`, decorated, focused,
/// never hidden: if it already exists it is re-shown instead of duplicated.
///
/// Async on purpose: `WebviewWindowBuilder::new` is documented to deadlock on
/// Windows when called from a synchronous command.
#[tauri::command]
pub async fn trn_verify_open(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(VERIFY_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let url = VERIFY_URL
        .parse()
        .map_err(|e| format!("EDGE_UNAVAILABLE bad verify url: {e}"))?;
    WebviewWindowBuilder::new(&app, VERIFY_LABEL, WebviewUrl::External(url))
        .title("Recon — tracker.gg verification")
        .inner_size(1100.0, 800.0)
        .center()
        .decorations(true)
        .focused(true)
        .visible(true)
        // Same observation-only Warden recorder as the proxy window: this is
        // where the human pass actually happens.
        .initialization_script(WARDEN_HOOK_JS)
        .build()
        .map_err(|e| format!("EDGE_UNAVAILABLE verify window: {e}"))?;
    trn_trace!("VERIFY window opened (human captcha pass)");
    Ok(())
}
/// Throw the hidden proxy away so its next fetch is a fresh navigation in the
/// profile the user just verified. Safe with no window (every step is a no-op):
/// destroy, clear READY/lifecycle, and invalidate any armed idle sweep.
#[tauri::command]
pub fn trn_proxy_reset(app: AppHandle) -> Result<(), String> {
    destroy_proxy_window(&app);
    reset_proxy_lifecycle();
    PROXY_TEARDOWN_GEN.fetch_add(1, Ordering::AcqRel);
    trn_trace!("RESET hidden proxy destroyed (next fetch re-navigates)");
    Ok(())
}
/// Read the Warden pass token recorded by `WARDEN_HOOK_JS` (empty when the page
/// never sent/received one). Read-only QA surface — no replay, no fetch.
///
/// Checks the visible verify window first (a human pass happens there), then the
/// hidden proxy. Missing window, dead eval and garbage all answer `""`: this is
/// a probe, never a failure.
#[tauri::command]
pub async fn trn_warden_token(app: AppHandle) -> Result<String, String> {
    for label in [VERIFY_LABEL, PROXY_LABEL] {
        let Some(w) = app.get_webview_window(label) else {
            continue;
        };
        let Some(env) = eval_roundtrip(&w, WARDEN_PROBE_JS.to_string()).await else {
            continue;
        };
        // ExecuteScript answers a JSON string literal: decode it once.
        if let Ok(token) = serde_json::from_str::<String>(&env) {
            if !token.is_empty() {
                trn_trace!("WARDEN token_seen label={label}");
                return Ok(token);
            }
        }
    }
    Ok(String::new())
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
    // The ceiling bills only attempts that reached tracker.gg. A Warden
    // captcha refusal and every no-wire transport failure refund their slot
    // here, so a failure storm can never spend the hour budget; an answered
    // `HTTP {code}` and the success path stay billed (see `ceiling_refundable`).
    if ceiling_refundable(&out) {
        refund_ceiling(lobby_key);
    }
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

#[cfg(test)]
mod tests_script;
#[cfg(test)]
mod tests_readiness;
#[cfg(test)]
mod tests_flight;
