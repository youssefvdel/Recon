#![allow(dead_code)]
//! (moved verbatim from `trn_proxy.rs`; split only.)
use super::readiness::{ProxyReadiness, is_proxy_ready};

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
pub(super) static SLOT_SEQ: AtomicU64 = AtomicU64::new(1);

/// Per window lifetime: false until the first readiness pass. Reset when a
/// fresh window is created — an existing window skips the gate.
pub(super) static PROXY_READY: AtomicBool = AtomicBool::new(false);

/// Requests currently holding the proxy window. Teardown requires zero.
pub(super) static PROXY_INFLIGHT: AtomicU64 = AtomicU64::new(0);

/// Bumped by every completed request. An idle sweep carries the value it
/// captured and only fires if nothing has completed since — this is what stops
/// an older sweep from destroying a window that a later request re-armed.
pub(super) static PROXY_TEARDOWN_GEN: AtomicU64 = AtomicU64::new(0);

/// Serializes the check-then-build in `proxy_window` so N concurrent
/// first-requests create exactly one window instead of racing and having all
/// but one fail on a duplicate label. `proxy_window` contains no `.await`, so a
/// plain std Mutex is correct and adds no async coupling.
pub(super) static PROXY_WINDOW_LOCK: Mutex<()> = Mutex::new(());

/// Consecutive failed readiness passes on the CURRENT hidden window.
///
/// The watchdog below used to run only once a window had been READY, so a
/// window wedged before its first READY (challenge page, dead renderer, hung
/// navigation) was never rebuilt: every fetch paid the full 10s gate and
/// returned `EDGE_PAUSED` for the rest of the session. A streak is the evidence
/// that the PAGE, not the moment, is broken.
pub(super) static PROXY_FAIL_STREAK: AtomicU64 = AtomicU64::new(0);

/// Failed gates needed before that window is rebuilt (`self_heal_due`).
pub(super) const PROXY_SELF_HEAL_AFTER: u64 = 2;

/// Minimum gap between self-heal rebuilds, so a page that is permanently
/// challenged costs at most one renderer rebuild per minute — never a loop.
pub(super) const PROXY_RECREATE_BACKOFF: Duration = Duration::from_secs(60);

/// Last self-heal rebuild (epoch ms; 0 = never), read by `self_heal_due`.
pub(super) static PROXY_LAST_RECREATE_MS: AtomicU64 = AtomicU64::new(0);

/// Proxy page state for the `trn_proxy_state` command + DevDashboard readout
/// (Rust-owned — TS never guesses). Unknown until the first fetch.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ProxyState {
    Ready = 0,
    Challenged = 1,
    Recreated = 2,
    Paused = 3,
}

/// `u8::MAX` = never observed yet → "UNKNOWN".
pub(super) static PROXY_STATE: AtomicU64 = AtomicU64::new(u8::MAX as u64);

pub(super) fn set_proxy_state(s: ProxyState) {
    PROXY_STATE.store(s as u64, Ordering::Relaxed);
}

/// State string for the command surface. Pure — unit-tested.
pub(super) fn proxy_state_str(raw: u64) -> &'static str {
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
pub(super) fn watchdog_should_recreate(ping: Option<&ProxyReadiness>) -> bool {
    match ping {
        Some(r) => !is_proxy_ready(r),
        None => true,
    }
}

/// Which of the two watchdog failures fired, for the trace line. `silent` = the
/// renderer never answered inside the budget (proven live wedge: hung
/// challenge page or dead renderer); `not-ready` = it answered, but the page
/// is no longer loaded/cleared/tracker.gg. Pure — unit-tested.
pub(super) fn watchdog_reason(ping: Option<&ProxyReadiness>) -> &'static str {
    match ping {
        None => "silent",
        Some(_) => "not-ready",
    }
}

/// A sweep that captured `gen` may destroy the window only when no request has
/// completed since it armed (`gen == current_gen`) and nothing is in flight
/// right now. Pure — unit-tested.
pub(super) fn teardown_still_valid(gen: u64, current_gen: u64, in_flight: u64) -> bool {
    gen == current_gen && in_flight == 0
}

/// Backoff gate for any self-heal rebuild: never twice inside the window.
/// Pure — unit-tested.
pub(super) fn recreate_backoff_elapsed(last_recreate_ms: u64, now: u64) -> bool {
    // 0 = never rebuilt. Without this the "never" case only looks elapsed
    // because the wall clock is huge; a small injected `now` (unit tests, a
    // mocked clock) would wrongly hold the first heal back by a full backoff.
    if last_recreate_ms == 0 {
        return true;
    }
    now.saturating_sub(last_recreate_ms) >= PROXY_RECREATE_BACKOFF.as_millis() as u64
}

/// Rebuild verdict for a window that never reached READY: the gate must have
/// failed `PROXY_SELF_HEAL_AFTER` times AND the backoff must have elapsed.
/// Pure — unit-tested.
pub(super) fn self_heal_due(fail_streak: u64, last_recreate_ms: u64, now: u64) -> bool {
    fail_streak >= PROXY_SELF_HEAL_AFTER && recreate_backoff_elapsed(last_recreate_ms, now)
}

/// Back to "never observed against a live window": the next fetch re-runs the
/// readiness gate on a fresh navigation, so leaving the pre-teardown state in
/// place would report a page that no longer exists. The self-heal streak and
/// its backoff belong to the destroyed window too — a fresh lifetime starts
/// with a clean slate (and a user `trn_proxy_reset` may rebuild immediately).
pub(super) fn reset_proxy_lifecycle() {
    PROXY_READY.store(false, Ordering::Relaxed);
    PROXY_STATE.store(u8::MAX as u64, Ordering::Relaxed);
    PROXY_FAIL_STREAK.store(0, Ordering::Release);
    PROXY_LAST_RECREATE_MS.store(0, Ordering::Release);
}
