//! Pure rules for the direct TRN transport: host allowlist, path allowlist and
//! HTTP status -> error-surface mapping.
//!
//! Extracted from `trn_http.rs` by moving code only, so these security-relevant
//! rules can be tested on any host (`src-tauri/pure`). No I/O, no reqwest, no
//! statics: every function here is a function of its arguments.

/// The only host this transport may talk to.
pub(crate) const TRN_HOST: &str = "api.tracker.network";
/// Same path cap the proxy enforces.
pub(crate) const MAX_PATH: usize = 300;

/// Host allowlist: the only place a caller-supplied URL or a redirect may land.
pub(crate) fn host_allowed(host: &str) -> bool {
    host.eq_ignore_ascii_case(TRN_HOST)
}

/// Path rules, stricter than `trn_proxy::validate_path` because this transport
/// has no browser origin to constrain it: root-relative only, no scheme, no
/// protocol-relative "//", no dot segments, no whitespace, ≤300 chars.
///
/// A QUERY STRING IS ALLOWED AND PASSED THROUGH UNTOUCHED: the profile routes
/// take `?source=overwolf-2`, and that parameter is what makes TRN return the
/// full payload (3 season segments + weapon/map data). Nothing here re-encodes
/// it — the string is concatenated onto the constant base and parsed once.
pub(crate) fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > MAX_PATH {
        return Err("TRN_HTTP_BAD_PATH".to_string());
    }
    // The URL path proper, without the query. Scheme/host smuggling and
    // traversal are judged on this part; the query may contain '?'/'&'/'='.
    let path_only = path.split_once('?').map(|(p, _)| p).unwrap_or(path);
    if !path_only.starts_with('/') || path_only.starts_with("//") {
        return Err("TRN_HTTP_BAD_PATH".to_string());
    }
    if path.contains("://") {
        return Err("TRN_HTTP_BAD_PATH".to_string());
    }
    // No raw whitespace or control characters anywhere (a query with a space
    // must arrive percent-encoded).
    if path.contains([' ', '\n', '\r', '\t']) {
        return Err("TRN_HTTP_BAD_PATH".to_string());
    }
    // Literal ".." anywhere, query included: no legitimate TRN route or query
    // needs it, and it can only be an attempt to confuse a normalizer. A bare
    // "." segment is refused for the same reason.
    if path.contains("..") || path.split('/').any(|seg| seg == ".") {
        return Err("TRN_HTTP_BAD_PATH".to_string());
    }
    Ok(())
}

/// Map a status to this transport's error surface. `None` = a body to return.
///
/// Body-blind by design: a 403 with a block page is still `HTTP 403` here, and
/// only `captcha_error` below may re-classify it once the body was read.
pub(crate) fn status_error(status: u16) -> Option<String> {
    match status {
        200..=299 => None,
        451 => Some("TRN_PRIVATE".to_string()),
        404 => Some("TRN_NO_DATA".to_string()),
        429 => Some("TRN_RATE_LIMITED".to_string()),
        other => Some(format!("HTTP {other}")),
    }
}

/// Bytes of a response body inspected for the Warden wall.
///
/// Every marker is response chrome — a JSON error code or a block-page title in
/// the `<head>` — and shows up in the first few hundred bytes. 32 KB is two
/// orders of magnitude past that and still bounds the scan of a hostile 8 MB
/// body. A marker past the cap is deliberately NOT found (the plain status shape
/// is the safe answer).
pub(crate) const WARDEN_SCAN_MAX: usize = 32 * 1024;

/// 429 JSON challenge markers: the API's own captcha gate.
const WARDEN_429_MARKERS: [&str; 2] = ["warden::challenge", "captcha"];
/// 403 block-page markers: Tracker Network's "You've Been Blocked" page and the
/// Cloudflare "Attention Required" / "Just a moment…" / `cf-mitigated` variants
/// (both probed live 2026-11-06).
const WARDEN_403_MARKERS: [&str; 4] = [
    "you've been blocked",
    "attention required",
    "cf-mitigated",
    "just a moment",
];

/// First `max` bytes of `body`, cut on a char boundary. Pure.
fn head(body: &str, max: usize) -> &str {
    if body.len() <= max {
        return body;
    }
    let mut end = max;
    while end > 0 && !body.is_char_boundary(end) {
        end -= 1;
    }
    &body[..end]
}

/// True when the status+body is tracker.gg's human-gate wall rather than a plain
/// rate limit or permission error.
///
/// THE ONE MARKER LIST, called by BOTH transports: the hidden-WebView2 proxy
/// (`trn_proxy::result::map_result`) and the direct client
/// (`trn_http::fetch`). Two copies of these literals is how a block page ends up
/// classified on one path and laddered forever on the other.
///
/// Deliberately conservative: only 403/429, only body markers, case-insensitive,
/// first [`WARDEN_SCAN_MAX`] bytes. A normal 403 API error
/// (`{"errors":[…]}` JSON) carries none of the block-page prose, so it keeps its
/// `HTTP 403` shape and the TS ladder. Pure — unit-tested.
pub(crate) fn is_warden_captcha(status: u16, body: &str) -> bool {
    let head = head(body, WARDEN_SCAN_MAX).to_ascii_lowercase();
    let markers: &[&str] = match status {
        429 => &WARDEN_429_MARKERS,
        403 => &WARDEN_403_MARKERS,
        _ => return false,
    };
    markers.iter().any(|marker| head.contains(marker))
}

/// The Warden wall as the code TS branches on, when `status`+`body` is the wall.
/// `None` = not the wall: the caller keeps its plain status shape. Pure.
pub(crate) fn captcha_error(status: u16, body: &str) -> Option<String> {
    is_warden_captcha(status, body).then(|| "TRN_CAPTCHA_REQUIRED".to_string())
}

/// The shared error-surface contract, asserted on BOTH sides:
/// `src/utils/trn.ts` / `tests/trn-errors.test.ts` (TS policy ladder) and here
/// (this module compiles host-agnostically through `src-tauri/pure`, so the
/// check runs without Windows/winreg).
#[cfg(test)]
mod contract_tests {
    use super::status_error;
    use serde_json::Value;

    const CONTRACT: &str = include_str!("../../contracts/trn-errors.json");
    /// The only two files allowed to emit this transport's codes.
    const HTTP_SRC: &str = include_str!("trn_http.rs");
    const RULES_SRC: &str = include_str!("trn_http_rules.rs");
    /// The TS half of the same contract: a code the fixture says TS branches on
    /// must still exist there, so a rename on either side fails this test.
    const TS_SRC: &str = include_str!("../../src/utils/trn.ts");

    fn contract() -> Value {
        serde_json::from_str(CONTRACT).expect("contracts/trn-errors.json must parse")
    }

    /// Every Rust origin an entry names: the primary `(rust, rust_file)` plus
    /// each `(fn, file)` in `rust_also`. A code emitted by both transports must
    /// be asserted against both, or a deletion on one side goes unnoticed.
    fn rust_origins(e: &Value) -> Vec<(&str, &str)> {
        let mut out: Vec<(&str, &str)> = Vec::new();
        if let (Some(function), Some(file)) = (e["rust"].as_str(), e["rust_file"].as_str()) {
            out.push((function, file));
        }
        if let Some(also) = e["rust_also"].as_array() {
            for origin in also {
                if let (Some(function), Some(file)) =
                    (origin["fn"].as_str(), origin["file"].as_str())
                {
                    out.push((function, file));
                }
            }
        }
        out
    }

    /// Every `TRN_HTTP_*` token in `src`, found without a regex dependency.
    fn uppercase_tokens(src: &str) -> Vec<String> {
        src.split(|c: char| !(c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
            .filter(|t| t.starts_with("TRN_HTTP_") && t.ends_with(|c: char| c.is_ascii_uppercase()))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn status_mapping_matches_the_contract() {
        let v = contract();
        assert_eq!(v["version"].as_u64(), Some(1), "contract version");
        let mut mapped = 0;
        for e in v["codes"].as_array().expect("codes[]") {
            if e["rust"].as_str() != Some("trn_http::status_error") {
                continue;
            }
            // `http: null` is the `HTTP {status}` catch-all: asserted below by
            // sweeping every status.
            let Some(http) = e["http"].as_u64() else {
                continue;
            };
            let code = e["code"].as_str().expect("code");
            assert_eq!(
                status_error(http as u16).as_deref(),
                Some(code),
                "status_error({http}) must be {code}"
            );
            mapped += 1;
        }
        assert_eq!(mapped, 3, "exactly the three status-mapped codes");
    }

    #[test]
    fn status_error_has_no_arm_outside_the_contract() {
        let v = contract();
        let mapped: Vec<String> = v["codes"]
            .as_array()
            .expect("codes[]")
            .iter()
            .filter(|e| e["rust"].as_str() == Some("trn_http::status_error"))
            .filter(|e| e["http"].is_u64())
            .filter_map(|e| e["code"].as_str().map(str::to_string))
            .collect();

        for status in 0u16..=599 {
            let got = status_error(status);
            if (200..=299).contains(&status) {
                assert_eq!(got, None, "2xx {status} must be a body, not an error");
                continue;
            }
            let msg = got.expect("every non-2xx must map to an error");
            if mapped.contains(&msg) {
                assert!(
                    matches!(status, 404 | 429 | 451),
                    "{msg} surfaced at unexpected status {status}"
                );
                continue;
            }
            assert_eq!(
                msg,
                format!("HTTP {status}"),
                "status {status} has an arm the contract does not list"
            );
        }
    }

    #[test]
    fn every_declared_rust_origin_still_emits_the_code() {
        let v = contract();
        for e in v["codes"].as_array().expect("codes[]") {
            let code = e["code"].as_str().expect("code");
            let token = e["match"].as_str().unwrap_or(code);
            for (function, file) in rust_origins(e) {
                // This module can only vouch for the two files it can include.
                // Every other origin is checked against its real source by
                // tests/trn-errors.test.ts.
                let src = match file {
                    "src-tauri/src/trn_http.rs" => Some(HTTP_SRC),
                    "src-tauri/src/trn_http_rules.rs" => Some(RULES_SRC),
                    _ => None,
                };
                let Some(src) = src else { continue };
                assert!(
                    src.contains(token),
                    "contract says {function} emits {code}, but {file} does not contain {token}"
                );
            }
        }
    }

    #[test]
    fn the_transport_emits_no_trn_http_code_the_contract_lacks() {
        let v = contract();
        let listed: Vec<&str> = v["codes"]
            .as_array()
            .expect("codes[]")
            .iter()
            .filter_map(|e| e["code"].as_str())
            .collect();
        let emitted: Vec<String> = uppercase_tokens(HTTP_SRC)
            .into_iter()
            .chain(uppercase_tokens(RULES_SRC))
            .collect();
        assert!(
            !emitted.is_empty(),
            "token scanner found no TRN_HTTP_* codes"
        );
        for token in emitted {
            assert!(
                listed.contains(&token.as_str()),
                "{token} is emitted by the transport but has no contract entry"
            );
        }
    }

    #[test]
    fn every_code_the_ts_policy_branches_on_exists_in_trn_ts() {
        let v = contract();
        for e in v["codes"].as_array().expect("codes[]") {
            let Some(ts) = e["ts"].as_array() else {
                continue;
            };
            // "not-an-answer" asserts an absence, so it names nothing in trn.ts.
            if !ts.iter().any(|p| p.as_str() != Some("not-an-answer")) {
                continue;
            }
            let code = e["code"].as_str().expect("code");
            let token = e["match"].as_str().unwrap_or(code);
            // A quoted literal, not a comment mention: TS matches on strings, so
            // a rename there must break this even when prose still names the code.
            let quoted =
                TS_SRC.contains(&format!("'{token}'")) || TS_SRC.contains(&format!("\"{token}\""));
            assert!(
                quoted,
                "fixture says TS branches on {code}: no quoted literal {token:?} in src/utils/trn.ts"
            );
        }
    }
}

/// The Warden wall classifier, shared by BOTH transports. Asserted here on any
/// host (`src-tauri/pure`), which is the only place the direct 403 branch can be
/// tested without a network.
#[cfg(test)]
mod warden_tests {
    use super::{captcha_error, is_warden_captcha, status_error, WARDEN_SCAN_MAX};

    const WALL: &str = "TRN_CAPTCHA_REQUIRED";

    /// The exact composition `trn_http::fetch` uses for a non-2xx 403: the wall
    /// code wins, otherwise the body-blind status shape.
    fn code_403(body: &str) -> String {
        captcha_error(403, body).unwrap_or_else(|| status_error(403).expect("403 has an arm"))
    }

    #[test]
    fn a_block_page_403_is_the_wall_not_a_permission_error() {
        // Tracker Network's own page (title probed live) and Cloudflare's.
        for body in [
            "<!doctype html><title>You've Been Blocked - Tracker Network</title>",
            "<title>Attention Required! | Cloudflare</title>",
            "<p>Just a moment...</p>",
            "cf-mitigated: challenge",
            // Case-insensitive.
            "YOU'VE BEEN BLOCKED",
        ] {
            assert_eq!(
                code_403(body),
                WALL,
                "403 block page must classify as the wall: {body:?}"
            );
        }
        // The 429 JSON challenge (the proxy's shape) uses the same list.
        let warden = r#"{"errors":[{"code":"Warden::Challenge","message":"solve a captcha"}]}"#;
        assert_eq!(captcha_error(429, warden).as_deref(), Some(WALL));
        assert_eq!(captcha_error(429, "please solve a CAPTCHA").as_deref(), Some(WALL));
    }

    #[test]
    fn a_plain_403_keeps_its_status_shape() {
        // A normal JSON API error and an empty body are NOT the wall: both keep
        // the byte-identical `HTTP 403` the TS ladder already owns.
        assert_eq!(code_403(r#"{"errors":[{"code":"Forbidden"}]}"#), "HTTP 403");
        assert_eq!(code_403(""), "HTTP 403");
        // The 429-only markers never leak into a 403, and vice versa.
        assert_eq!(code_403("captcha"), "HTTP 403");
        assert_eq!(code_403(r#"{"code":"Warden::Challenge"}"#), "HTTP 403");
        assert_eq!(captcha_error(429, "you've been blocked"), None);
        // Only the wall statuses participate: a 200/500 body is never re-read.
        for status in [200u16, 201, 404, 451, 500, 503] {
            assert!(!is_warden_captcha(status, "you've been blocked cf-mitigated captcha"));
        }
    }

    #[test]
    fn the_body_scan_is_bounded_to_the_first_32kb() {
        // A marker at the START is found however large the body is.
        let mut leading = String::from("<title>You've Been Blocked</title>");
        leading.push_str(&"a".repeat(WARDEN_SCAN_MAX * 2));
        assert_eq!(code_403(&leading), WALL);
        // The same marker PAST the cap is not inspected: bounded work, and the
        // safe answer is the plain `HTTP 403` the ladder owns.
        let mut trailing = "a".repeat(WARDEN_SCAN_MAX);
        trailing.push_str("<title>You've Been Blocked</title>");
        assert_eq!(code_403(&trailing), "HTTP 403");
        // No panic when the 32 KB boundary splits a multi-byte char.
        let mut unicode = "é".repeat(WARDEN_SCAN_MAX / 2);
        unicode.push_str("<title>You've Been Blocked</title>");
        assert_eq!(code_403(&unicode), "HTTP 403");
    }
}
