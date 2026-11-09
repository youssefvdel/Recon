#![allow(dead_code)]
//! (moved verbatim from `trn_proxy.rs`; split only.)

use std::sync::Mutex;
/// Shared request ceiling. The `main` and `overlay` WebView2 windows each
/// load `trn.ts` SEPARATELY, so their `trnNextSlot` gate, `trnSpreadSpent`
/// lobby budget and `trnInFlightLive` dedup are per-realm: nothing above
/// this module can bound the app's request volume, because a second realm is
/// a full second budget. This one process is the only place both realms meet,
/// so the ceiling lives here — a check-then-spend under a single mutex, which
/// is what makes "at most N" a guarantee rather than a hope.
pub(super) struct TrnCeiling {
    /// Lobby (matchId) `lobby_spent` was counted against. "" = no lobby.
    pub(super) lobby: String,
    pub(super) lobby_spent: u32,
    /// Start of the rolling per-hour window (epoch ms).
    pub(super) window_start_ms: u64,
    pub(super) window_spent: u32,
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
pub(super) const TRN_LOBBY_MAX_REQUESTS: u32 = 30;

/// Per-hour ceiling, over a rolling window.
///
/// The serial gate alone caps one realm at 1 request / 6s = 600/hour; two
/// realms can therefore reach 1200/hour, which is not a number anyone wants
/// pointed at tracker.gg. 900 sits above every observed demand (a full fill
/// is ~20 wire requests per ~35-minute match, so ~35/hour; view-driven tabs
/// add tens) and below the two-realm gate maximum, so it only ever bites on
/// a genuine runaway. Exceeding it is a quiet failure: callers already treat
/// any TRN_* throw as "fall back to Riot-direct".
pub(super) const TRN_HOURLY_MAX_REQUESTS: u32 = 900;

pub(super) const TRN_WINDOW_MS: u64 = 60 * 60 * 1000;

pub(super) static TRN_CEILING: Mutex<TrnCeiling> = Mutex::new(TrnCeiling {
    lobby: String::new(),
    lobby_spent: 0,
    window_start_ms: 0,
    window_spent: 0,
});

/// Ceiling decision for one request. Pure — unit-tested.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Ceiling {
    Allow,
    /// `lobby` or `hour`: which ceiling is spent. The string never contains
    /// 429/403/1015, so it can never trip the TS cooldown ladder.
    Deny(&'static str),
}

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Check (and spend) the shared budget for one request. `lobby` is the
/// current matchId or empty. Pure apart from the caller-supplied clock —
/// unit-tested. A stale lobby key and a new match both roll the counter, so
/// the budget is per lobby and can never be carried into the next one.
pub(super) fn ceiling_allows(c: &mut TrnCeiling, lobby: &str, now: u64) -> Ceiling {
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
pub(super) fn spend_ceiling(lobby: &str) -> Ceiling {
    let Ok(mut c) = TRN_CEILING.lock() else {
        // Poisoned lock must not become an outage: allow, the TS gate above
        // still paces every request.
        return Ceiling::Allow;
    };
    ceiling_allows(&mut c, lobby, now_ms())
}

/// Undo one `ceiling_allows` spend. Only the counters that request actually
/// incremented are touched: a lobby counter that has since rolled to a new
/// match is left alone (that match never spent this slot), and both counters
/// saturate so a refund can never wrap below zero. Pure — unit-tested.
pub(super) fn ceiling_refund(c: &mut TrnCeiling, lobby: &str) {
    c.window_spent = c.window_spent.saturating_sub(1);
    if !lobby.is_empty() && c.lobby == lobby {
        c.lobby_spent = c.lobby_spent.saturating_sub(1);
    }
}

/// Refund the shared ceiling for an attempt that never became load.
///
/// The ceiling now bills only attempts that actually reached tracker.gg: any
/// 2xx/HTTP answer counts (the server did work). A transport failure
/// (`EDGE_UNAVAILABLE` / `EDGE_PAUSED` — no HTTP answer at all) and the Warden
/// captcha refusal refund their slot, so a failure storm can never exhaust the
/// hour budget and lock TRN out for the rest of it. Poisoned lock → no-op,
/// matching the spend path (which never billed).
pub(super) fn refund_ceiling(lobby: &str) {
    if let Ok(mut c) = TRN_CEILING.lock() {
        ceiling_refund(&mut c, lobby);
    }
}

/// True when this outcome must not stay billed (see `refund_ceiling`): the
/// captcha and no-wire transport failures. `TRN_BUDGET` was never billed and
/// an `HTTP {code}` was answered — both stay as they are. Pure — unit-tested.
pub(super) fn ceiling_refundable(out: &Result<String, String>) -> bool {
    match out {
        Ok(_) => false,
        Err(e) => {
            e == "TRN_CAPTCHA_REQUIRED"
                || e.starts_with("EDGE_UNAVAILABLE")
                || e.starts_with("EDGE_PAUSED")
        }
    }
}
