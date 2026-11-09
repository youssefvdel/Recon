#![allow(dead_code)]
//! (moved verbatim from `trn_proxy.rs`; split only.)
use super::constants::{MAX_SLOT_CHARS};
use super::script::{SlotResult, snippet};

/// Chars of an in-page rejection message that reach a trace line.
///
/// 200 is room for a real WebView message (`Failed to fetch`, `NetworkError
/// when attempting to fetch resource.`) and short enough that a pathological
/// message cannot push the 512-line ring's worth of history out of the panel.
pub(super) const TRACE_ERR_CHARS: usize = 200;

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
pub(super) fn trace_err(r: &SlotResult) -> String {
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

/// True when the response is tracker.gg's human-gate wall rather than a plain
/// rate limit or permission error.
///
/// Two shapes, one wall:
/// - 429 JSON: `{"errors":[{"code":"Warden::Challenge","message":"…captcha…"}]}`
///   — the API's captcha gate;
/// - 403 HTML: Tracker Network's own "You've Been Blocked" page or a Cloudflare
///   "Attention Required" block page (both probed live 2026-11-06). The hidden
///   window can no more clear this than it can solve the captcha.
///
/// Deliberately conservative: only 403/429, only body markers, case-insensitive.
/// A normal 403 API error (`{"errors":[…]}` JSON) carries none of the block-page
/// prose, so it keeps its `HTTP 403` shape and the TS ladder. Pure — unit-tested.
pub(super) fn is_warden_captcha(status: u16, body: &str) -> bool {
    let b = body.to_ascii_lowercase();
    match status {
        429 => b.contains("warden::challenge") || b.contains("captcha"),
        403 => {
            b.contains("you've been blocked")
                || b.contains("attention required")
                || b.contains("cf-mitigated")
                || b.contains("just a moment")
        }
        _ => false,
    }
}

/// Map a resolved slot to the command surface. Pure — unit-tested.
pub(super) fn map_result(r: SlotResult) -> Result<String, String> {
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
    // Warden wall: a human-only gate (429 captcha JSON, or a 403 block page).
    // It must NOT look like a rate limit, or every caller retries it on a timer
    // that can never clear it (that was the shipped bug: a plain `HTTP 429` fed
    // the TS cooldown ladder forever, and a bare 403 did the same).
    if is_warden_captcha(r.status, &r.body) {
        return Err("TRN_CAPTCHA_REQUIRED".to_string());
    }
    if r.status == 0 {
        return Err(format!("EDGE_PAUSED in-page fetch failed: {}", snippet(&r.body)));
    }
    Err(format!("HTTP {}: {}", r.status, snippet(&r.body)))
}
