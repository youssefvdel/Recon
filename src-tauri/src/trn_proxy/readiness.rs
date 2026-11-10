#![allow(dead_code)]
//! (moved verbatim from `trn_proxy.rs`; split only.)
#[cfg(debug_assertions)]
use super::trace::trace_emit;
use super::constants::{READINESS_POLL, READINESS_TIMEOUT};
use super::state::{PROXY_FAIL_STREAK, PROXY_READY, ProxyState, set_proxy_state};
use super::window::{eval_roundtrip};

use std::sync::atomic::{Ordering};

use tauri::WebviewWindow;
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
pub(super) fn readiness_probe() -> String {
    "JSON.stringify({loaded:document.readyState==='complete',host:(location.hostname||'').slice(0,80),title:(document.title||'').slice(0,120),cookies:document.cookie||'',challenge:!!(document.querySelector('iframe[src*=\"challenges.cloudflare.com\"],#cf-challenge,#challenge-form,.cf-challenge'))})".to_string()
}

#[derive(serde::Deserialize)]
pub(super) struct ProxyReadiness {
    pub(super) loaded: bool,
    /// `location.hostname` of the document answering the probe. Empty for the
    /// initial blank document a fresh window serves before the navigation
    /// commits — see `is_trn_origin`.
    #[serde(default)]
    pub(super) host: String,
    #[serde(default)]
    pub(super) title: String,
    #[serde(default)]
    pub(super) cookies: String,
    #[serde(default)]
    pub(super) challenge: bool,
}

/// Decode one readiness envelope (double JSON like parse_poll): None = still
/// pending or garbage — never poison the wait. Pure — unit-tested.
pub(super) fn parse_readiness(envelope: &str) -> Option<ProxyReadiness> {
    let inner: String = serde_json::from_str(envelope).ok()?;
    if inner.is_empty() {
        return None;
    }
    serde_json::from_str(&inner).ok()
}

/// Cloudflare challenge page titles (case-insensitive). Pure — unit-tested.
pub(super) fn is_challenge_title(title: &str) -> bool {
    let t = title.to_lowercase();
    t.contains("just a moment") || t.contains("attention required") || t.contains("verifying you are human") || t.contains("security verification")
}

/// Clearance cookies visible to JS (HttpOnly ones never appear — absence never
/// blocks, presence is a bonus signal). Pure — unit-tested.
pub(super) fn has_cf_cookie(cookies: &str) -> bool {
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
pub(super) fn is_trn_origin(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    h == "tracker.gg" || h.ends_with(".tracker.gg")
}

/// Ready = load complete + on the tracker.gg origin + clearance (cookie jar
/// OR no challenge markers). Pure — unit-tested.
pub(super) fn is_proxy_ready(r: &ProxyReadiness) -> bool {
    r.loaded
        && is_trn_origin(&r.host)
        && (has_cf_cookie(&r.cookies) || (!r.challenge && !is_challenge_title(&r.title)))
}

/// Park queued fetches until the page is ready (bounded). Once per window
/// lifetime — after the first pass PROXY_READY sticks until a fresh window
/// resets it. EDGE_PAUSED on expiry (transient, retried next call). `path`
/// rides along so a park is attributable: a four-way season-segment fan-out
/// otherwise produces one anonymous `NOT READY`.
pub(super) async fn wait_proxy_ready(window: &WebviewWindow, path: &str) -> Result<(), String> {
    if PROXY_READY.load(Ordering::Relaxed) {
        return Ok(());
    }
    let deadline = tokio::time::Instant::now() + READINESS_TIMEOUT;
    let probe = readiness_probe();
    loop {
        let Some(env) = eval_roundtrip(window, probe.clone()).await else {
            // No answer inside the eval budget: a dead renderer or a frozen
            // page. Count it for the self-heal streak — the next fetch may
            // rebuild this window (`ensure_proxy_alive`).
            PROXY_FAIL_STREAK.fetch_add(1, Ordering::AcqRel);
            trn_trace!("LOST path={path} err=proxy lost during readiness probe");
            return Err("EDGE_UNAVAILABLE proxy lost".to_string());
        };
        if let Some(r) = parse_readiness(&env) {
            if is_proxy_ready(&r) {
                PROXY_READY.store(true, Ordering::Relaxed);
                PROXY_FAIL_STREAK.store(0, Ordering::Release);
                set_proxy_state(ProxyState::Ready);
                trn_trace!("READY (clearance ok)");
                return Ok(());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            PROXY_FAIL_STREAK.fetch_add(1, Ordering::AcqRel);
            set_proxy_state(ProxyState::Challenged);
            trn_trace!("NOT READY path={path} (still loading/challenged after budget)");
            return Err("EDGE_PAUSED proxy not ready: page still loading or challenged".to_string());
        }
        tokio::time::sleep(READINESS_POLL).await;
    }
}
