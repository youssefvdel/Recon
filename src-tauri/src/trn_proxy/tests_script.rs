#![allow(dead_code)]
//! Tests moved verbatim from the former inline `mod tests`.
use super::ceiling::{ceiling_allows, ceiling_refund};
use super::constants::{MAX_SLOT_CHARS};
use super::script::{SlotResult, snippet};
use super::state::{PROXY_SELF_HEAL_AFTER, recreate_backoff_elapsed, self_heal_due};
use super::tests_readiness::{ceiling};

use super::*;


#[test]
pub(super) fn path_rules_allowlist() {
    assert!(validate_path("/api/v2/valorant/standard/profile/riot/x%23y").is_ok());
    assert_eq!(validate_path("https://api.tracker.gg/api/x").unwrap_err(), "Invalid path.");
    assert_eq!(validate_path("/api/has space").unwrap_err(), "Invalid path.");
    assert_eq!(validate_path("/api/has\nnewline").unwrap_err(), "Invalid path.");
    assert_eq!(validate_path("/other/root").unwrap_err(), "Invalid path.");
    assert_eq!(validate_path(&format!("/api/{}", "x".repeat(300))).unwrap_err(), "Path too long.");
}

#[test]
pub(super) fn pause_truth_table() {
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
pub(super) fn kick_embeds_json_escaped() {
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
pub(super) fn poll_expr_reads_slot() {
    assert_eq!(poll_expr("__trn_3"), "String(window[\"__trn_3\"]??'')");
}

#[test]
pub(super) fn parse_poll_pending_and_garbage() {
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
pub(super) fn result_shapes_are_http() {
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

/// The shipped bug: tracker.gg answers its Warden wall as a plain 429 (or a
/// 403 block page), and the transport called it `HTTP 429`/`HTTP 403` so the
/// TS ladder retried a human-only gate every 60s forever, with no verify
/// affordance. Both shapes must be the same exact string; a real rate limit
/// and a normal 403 API error must keep their old shape.
#[test]
pub(super) fn warden_captcha_is_not_a_rate_limit() {
    let err = |status: u16, body: &str| {
        map_result(SlotResult {
            ok: false,
            status,
            body: body.into(),
            len: 0,
        })
        .unwrap_err()
    };
    // The real 429 body, probed 2026-11-06.
    let warden = r#"{"errors":[{"code":"Warden::Challenge","message":"You are making too many requests and must solve a captcha to continue."}]}"#;
    assert_eq!(err(429, warden), "TRN_CAPTCHA_REQUIRED");
    // Either marker is enough, matched case-insensitively.
    assert_eq!(err(429, "Warden::Challenge"), "TRN_CAPTCHA_REQUIRED");
    assert_eq!(err(429, "please solve a CAPTCHA"), "TRN_CAPTCHA_REQUIRED");
    // A plain rate limit still feeds the TS ladder byte-for-byte.
    assert_eq!(err(429, "rate limited"), "HTTP 429: rate limited");
    // Same wall as a 403 HTML block page: Tracker Network's own page (the
    // title probed live), plus the Cloudflare variants of it.
    let blocked = "<!doctype html><title>You've Been Blocked - Tracker Network</title>";
    assert_eq!(err(403, blocked), "TRN_CAPTCHA_REQUIRED");
    assert_eq!(
        err(403, "<title>Attention Required! | Cloudflare</title>"),
        "TRN_CAPTCHA_REQUIRED"
    );
    assert_eq!(err(403, "<p>Just a moment...</p>"), "TRN_CAPTCHA_REQUIRED");
    assert_eq!(err(403, "cf-mitigated: challenge"), "TRN_CAPTCHA_REQUIRED");
    // Conservative: a normal JSON 403 API error is not the wall, and the
    // 429-only markers never leak into a 403.
    let api403 = r#"{"errors":[{"code":"Forbidden","message":"Access denied"}]}"#;
    assert_eq!(err(403, api403), format!("HTTP 403: {}", snippet(api403)));
    assert_eq!(err(403, warden), format!("HTTP 403: {}", snippet(warden)));
    assert_eq!(err(403, "captcha"), "HTTP 403: captcha");
    // Only the wall statuses participate: a 500 keeps its shape even with
    // block-page prose in the body.
    assert_eq!(err(500, "captcha"), "HTTP 500: captcha");
    assert_eq!(err(500, blocked), format!("HTTP 500: {}", snippet(blocked)));
    // Contract with TS: no HTTP code, no body.
    assert!(!err(429, "captcha").contains("HTTP"));
    assert!(!err(403, blocked).contains("HTTP"));
}

/// H3: a window wedged before its first READY used to be immortal. Two
/// failed gates rebuild it, but never twice inside the backoff, so a
/// permanently challenged page cannot become a recreate loop.
#[test]
pub(super) fn self_heal_needs_a_streak_and_a_backoff() {
    // One failed gate is not evidence the page itself is broken.
    assert!(!self_heal_due(0, 0, 10_000));
    assert!(!self_heal_due(PROXY_SELF_HEAL_AFTER - 1, 0, 10_000));
    // Streak reached and never rebuilt -> rebuild on this fetch.
    assert!(self_heal_due(PROXY_SELF_HEAL_AFTER, 0, 10_000));
    // Rebuilt just now -> held off.
    let t = 10_000_000;
    assert!(!recreate_backoff_elapsed(t, t + 59_999));
    assert!(recreate_backoff_elapsed(t, t + 60_000));
    assert!(!self_heal_due(PROXY_SELF_HEAL_AFTER, t, t + 1));
    assert!(self_heal_due(PROXY_SELF_HEAL_AFTER, t, t + 60_000));
    // The streak still binds even when the backoff has elapsed.
    assert!(!self_heal_due(PROXY_SELF_HEAL_AFTER - 1, t, t + 60_000));
}

/// A captcha refusal and a no-wire transport failure must not eat the hour
/// ceiling: a failure storm used to lock TRN out for an hour silently.
#[test]
pub(super) fn captcha_and_no_wire_failures_refund_the_ceiling() {
    assert!(!ceiling_refundable(&Ok("{}".to_string())));
    assert!(ceiling_refundable(&Err("TRN_CAPTCHA_REQUIRED".to_string())));
    assert!(ceiling_refundable(&Err(
        "EDGE_UNAVAILABLE proxy lost".to_string()
    )));
    assert!(ceiling_refundable(&Err(
        "EDGE_PAUSED proxy timeout".to_string()
    )));
    // An answered HTTP error and a refusal that was never billed stay put.
    assert!(!ceiling_refundable(&Err("HTTP 429: limited".to_string())));
    assert!(!ceiling_refundable(&Err(
        "TRN_BUDGET hour spent".to_string()
    )));
}

/// Refund arithmetic: only the counters this request spent are touched,
/// and saturating subtraction can never wrap a counter below zero.
#[test]
pub(super) fn a_refused_attempt_does_not_count_as_load() {
    let mut c = ceiling();
    for _ in 0..3 {
        assert_eq!(ceiling_allows(&mut c, "m1", 1000), Ceiling::Allow);
    }
    ceiling_refund(&mut c, "m1");
    assert_eq!((c.window_spent, c.lobby_spent), (2, 2));
    // The lobby counter rolled to a new match: an old request's refund
    // must not steal from it, and unlobbied refunds never touch a lobby.
    assert_eq!(ceiling_allows(&mut c, "m2", 1000), Ceiling::Allow);
    ceiling_refund(&mut c, "m1");
    assert_eq!((c.window_spent, c.lobby_spent), (2, 1));
    ceiling_refund(&mut c, "");
    assert_eq!((c.window_spent, c.lobby_spent), (1, 1));
    // Saturating: a refund with nothing left cannot wrap.
    for _ in 0..3 {
        ceiling_refund(&mut c, "m2");
    }
    assert_eq!((c.window_spent, c.lobby_spent), (0, 0));
}

/// A 1.72 MB season segment used to be sliced to 1.5 MB in the page, so
/// the slot came back `ok=true status=200` carrying invalid JSON: the
/// transport called it a success and the act never loaded. An overrun must
/// be an error, not a corrupt body.
#[test]
pub(super) fn an_oversized_body_is_refused_not_truncated() {
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
