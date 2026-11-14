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
pub(crate) fn status_error(status: u16) -> Option<String> {
    match status {
        200..=299 => None,
        451 => Some("TRN_PRIVATE".to_string()),
        404 => Some("TRN_NO_DATA".to_string()),
        429 => Some("TRN_RATE_LIMITED".to_string()),
        other => Some(format!("HTTP {other}")),
    }
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
    fn every_trn_http_code_in_the_contract_is_still_emitted() {
        let v = contract();
        for e in v["codes"].as_array().expect("codes[]") {
            let Some(rust) = e["rust"].as_str().filter(|r| r.starts_with("trn_http::")) else {
                continue;
            };
            let code = e["code"].as_str().expect("code");
            let token = e["match"].as_str().unwrap_or(code);
            assert!(
                HTTP_SRC.contains(token) || RULES_SRC.contains(token),
                "contract says {rust} emits {code}, but neither trn_http.rs nor trn_http_rules.rs contains {token}"
            );
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
