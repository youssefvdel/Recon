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
