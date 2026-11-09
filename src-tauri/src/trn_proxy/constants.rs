#![allow(dead_code)]
//! (moved verbatim from `trn_proxy.rs`; split only.)

use std::time::Duration;
pub const PROXY_LABEL: &str = "trn-proxy";

/// Origin the hidden window sits on: same-site with the API host, so the
/// in-page fetch below is NOT cross-origin (no CORS wall).
pub(super) const PROXY_URL: &str = "https://tracker.gg/";

/// Same host the Rust client hits — success/fallback bodies interchangeable.
pub(super) const API_BASE: &str = "https://api.tracker.gg";

/// Same 20s budget the old Rust client had.
pub(super) const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

/// Passive readiness gate: a fresh/challenged page burns a fragile IP with an
/// instant 1015 if we fetch blindly. Park queued fetches here (bounded) until
/// the page is loaded + cleared, then EDGE_PAUSED on expiry (transient —
///
/// retried next call, never a cooldown).
pub(super) const READINESS_TIMEOUT: Duration = Duration::from_secs(10);

/// Readiness poll cadence (backend-driven via eval, never page timers).
pub(super) const READINESS_POLL: Duration = Duration::from_millis(200);

/// Watchdog liveness budget: proven live wedge = the page's JS engine answers
/// no eval within 2s (hung challenge page or dead renderer).
pub(super) const WATCHDOG_TIMEOUT: Duration = Duration::from_secs(2);

/// Backend poll cadence for the in-page result slot. Page timers may be
/// throttled while hidden — the cadence lives HERE, not in the page.
pub(super) const POLL_EVERY: Duration = Duration::from_millis(100);

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
pub(super) const MAX_SLOT_CHARS: usize = 8_000_000;

/// Idle teardown window for the proxy renderer.
///
/// A hidden WebView2 window is still a full renderer process (~100 MB, and the
/// repo's own perf sample measured that class at ~5.6% CPU while alive). With
/// the local-Riot path shipped, this window is a COLD fallback: it exists only
/// for the rare TRN request that the local path could not answer. Holding a
/// resident renderer for minutes after one such attempt is the overhead the
/// audit named; 60 s is long enough to serve a burst of retries and short
/// enough that a cold session reclaims the renderer quickly. Re-creating costs
/// one navigation plus the readiness park (≤10 s) on a call that would
/// otherwise be cold anyway.
pub(super) const PROXY_IDLE_TTL: Duration = Duration::from_secs(60);

/// Visible verification window: the one place a human can clear tracker.gg's
/// Warden captcha (the hidden window can never solve one). Created with the
/// default WebView2 profile — never a custom `data_directory` — so the
/// clearance cookies it earns are exactly the ones the hidden proxy inherits.
pub const VERIFY_LABEL: &str = "trn-verify";

pub(super) const VERIFY_URL: &str = "https://tracker.gg/valorant";
