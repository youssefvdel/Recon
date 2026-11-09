#![allow(dead_code)]
//! (moved verbatim from `trn_proxy.rs`; split only.)
use super::ceiling::{now_ms};
use super::constants::{POLL_EVERY};
use super::memo::{memo_get};

use std::sync::{Arc, Mutex};
use std::time::{Duration};
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
pub(super) type FlightResult = Result<String, String>;

/// `None` = the leader has not published yet. Followers clone, never take.
pub(super) type FlightSlot = Arc<Mutex<Option<FlightResult>>>;

/// path → its in-flight slot. Bounded by construction: every entry is
/// inserted by exactly one leader and removed by that leader's guard, so
/// the map only ever holds genuinely concurrent paths (itself bounded by
/// `TRN_HOURLY_MAX_REQUESTS`).
pub(super) static TRN_FLIGHTS: Mutex<Vec<(String, FlightSlot)>> = Mutex::new(Vec::new());

/// Bounded follow wait. A leader's own worst case is the 10s readiness park
/// plus the 20s fetch timeout plus poll granularity (~32s), so 35s always
/// outlasts a live leader while still surfacing a stranded one instead of
/// hanging. Never contains a ladder substring, so the shared cooldown
/// ladder is untouched.
pub(super) const FOLLOWER_WAIT: Duration = Duration::from_secs(35);

/// Follower gave up (budget above). Same transient family as EDGE_PAUSED.
pub(super) const FOLLOWER_TIMEOUT: &str = "EDGE_PAUSED follower gave up waiting for the in-flight request";

/// Leader vanished (cancelled/panicked) before publishing — the guard's
/// safety net. Never a session pin: the next call is a fresh leader.
pub(super) const FOLLOWER_ABANDONED: &str = "EDGE_PAUSED in-flight leader abandoned";

/// Join the flight for `path`, or open one. Leader/follower is decided
/// under a single lock, which is what makes "at most one on the wire" a
/// guarantee. Pure over the injected map — unit-tested.
pub(super) fn flight_acquire(flights: &mut Vec<(String, FlightSlot)>, path: &str) -> (FlightSlot, bool) {
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
pub(super) fn flight_remove(flights: &mut Vec<(String, FlightSlot)>, path: &str, slot: &FlightSlot) {
    flights.retain(|(p, s)| !(p == path && Arc::ptr_eq(s, slot)));
}

/// Leader-side guard: publishes the outcome and always removes the entry.
///
/// `Drop` runs on every exit — success, `HTTP {code}`, `TRN_BUDGET`,
/// `EDGE_PAUSED`, cancellation, panic — so followers can never be left
/// waiting on a slot nobody will fill and the map can never leak. Same
/// idiom as `InflightGuard` above.
pub(super) struct FlightGuard {
    path: String,
    slot: FlightSlot,
    published: bool,
}

impl FlightGuard {
    pub(super) fn new(path: &str, slot: &FlightSlot) -> Self {
        Self {
            path: path.to_string(),
            slot: Arc::clone(slot),
            published: false,
        }
    }

    /// Hand the outcome to every follower. First call wins, so the success
    /// arm can publish before the early returns without racing the guard.
    pub(super) fn publish(&mut self, out: FlightResult) {
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
pub(super) async fn wait_flight(path: &str, slot: &FlightSlot, budget: Duration) -> FlightResult {
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
