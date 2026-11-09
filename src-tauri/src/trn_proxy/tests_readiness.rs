#![allow(dead_code)]
//! Tests moved verbatim from the former inline `mod tests`.
use super::ceiling::{TRN_HOURLY_MAX_REQUESTS, TRN_LOBBY_MAX_REQUESTS, TRN_WINDOW_MS, TrnCeiling, ceiling_allows};
use super::constants::{PROXY_IDLE_TTL, READINESS_TIMEOUT};
use super::memo::{TRN_MEMO, TRN_MEMO_MAX, TRN_MEMO_TTL_MS};
use super::readiness::{ProxyReadiness, has_cf_cookie, is_challenge_title, is_proxy_ready, is_trn_origin, parse_readiness, readiness_probe};
use super::result::{TRACE_ERR_CHARS, trace_err};
use super::script::{SlotResult};
use super::state::{teardown_still_valid, watchdog_reason, watchdog_should_recreate};

use super::*;
use std::time::Duration;

#[test]
pub(super) fn readiness_probe_is_passive() {
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
pub(super) fn readiness_parse_pending_and_garbage() {
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
pub(super) fn challenge_title_table() {
    assert!(is_challenge_title("Just a moment..."));
    assert!(is_challenge_title("Attention Required! | Cloudflare"));
    assert!(is_challenge_title("Verifying you are human"));
    assert!(!is_challenge_title("Tracker Network"));
    assert!(!is_challenge_title(""));
}

#[test]
pub(super) fn cookie_signal() {
    assert!(has_cf_cookie("cf_clearance=abc"));
    assert!(has_cf_cookie("__cf_bm=xyz"));
    assert!(!has_cf_cookie("session=1"));
    assert!(!has_cf_cookie(""));
}

#[test]
pub(super) fn readiness_gate_table() {
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
pub(super) fn blank_document_is_never_ready() {
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
pub(super) fn readiness_probe_reads_the_page_origin() {
    let s = readiness_probe();
    assert!(s.contains("location.hostname"), "got: {s}");
    // The probe still touches no network and no api path.
    assert!(!s.contains("fetch("), "got: {s}");
    assert!(!s.contains("/api/"), "got: {s}");
    assert!(!s.contains("api.tracker.gg"), "got: {s}");
}

#[test]
pub(super) fn proxy_state_strings() {
    assert_eq!(proxy_state_str(ProxyState::Ready as u64), "READY");
    assert_eq!(proxy_state_str(ProxyState::Challenged as u64), "CHALLENGED");
    assert_eq!(proxy_state_str(ProxyState::Recreated as u64), "RECREATED");
    assert_eq!(proxy_state_str(ProxyState::Paused as u64), "PAUSED");
    // Never observed yet (or garbage): UNKNOWN, never a blank.
    assert_eq!(proxy_state_str(u8::MAX as u64), "UNKNOWN");
    assert_eq!(proxy_state_str(99), "UNKNOWN");
}

#[test]
pub(super) fn idle_teardown_never_races_a_request() {
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
pub(super) fn idle_ttl_outlasts_an_active_trn_window() {
    // Wave-1 audit perf #5: the proxy is a cold fallback now (local Riot
    // answers the common case), so the idle renderer is reclaimed after a
    // minute instead of five. It must still outlast one readiness park, or
    // every fetch would recreate a renderer it is about to use.
    assert_eq!(PROXY_IDLE_TTL, Duration::from_secs(60));
    assert!(PROXY_IDLE_TTL > READINESS_TIMEOUT);
}

/// Fresh ceiling state, zeroed window.
pub(super) fn ceiling() -> TrnCeiling {
    TrnCeiling {
        lobby: String::new(),
        lobby_spent: 0,
        window_start_ms: 0,
        window_spent: 0,
    }
}

#[test]
pub(super) fn lobby_ceiling_caps_one_fill() {
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
pub(super) fn lobby_ceiling_never_carries_into_the_next_match() {
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
pub(super) fn unlobbied_requests_are_not_billed_to_a_lobby() {
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
pub(super) fn hour_ceiling_is_the_hard_ceiling() {
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
pub(super) fn hour_window_never_exceeds_the_gate_maximum() {
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
pub(super) fn memo_replays_only_inside_the_ttl() {
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
pub(super) fn memo_is_bounded_by_dropping_the_oldest() {
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
pub(super) fn watchdog_verdict_table() {
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
pub(super) fn trace_err_explains_a_rejected_fetch_and_nothing_else() {
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
pub(super) fn watchdog_reason_distinguishes_silence_from_a_changed_page() {
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
