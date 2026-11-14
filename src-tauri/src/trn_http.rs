//! Direct TRN v2 transport: `https://api.tracker.network`, no API key.
//!
//! Why this exists: the hidden-WebView2 proxy needs Cloudflare clearance and can
//! be captcha-gated (Warden) at any moment. TRN's own Overwolf client talks to
//! `api.tracker.network` directly, and that origin accepts the same requests
//! from a plain HTTPS client when it presents the client's User-Agent. Probed
//! 2026-11-08 with no key and no cookies: `OverwolfClient` UA -> 200 full v2
//! profile (~880 kB); a Chrome UA or no UA -> 403. The API key is NOT needed and
//! is deliberately absent from this codebase — with and without the embedded key
//! the responses were byte-identical; the richer payload comes from the
//! `?source=overwolf-2` query, not from a key. Only `User-Agent` and `Accept`
//! are sent. The bulk route (`/api/v1/valorant/overwolf/ow-bulk-lookup`) answers
//! 405 to every method and is deliberately not implemented here.
//!
//! The WebView2 proxy stays as the fallback path; this module is additive and
//! owns no window, no cookie jar, and no retry policy.
//!
//! Error shapes (TS keys off them): `TRN_HTTP_DISABLED`, `TRN_PRIVATE` (451),
//! `TRN_NO_DATA` (404), `TRN_RATE_LIMITED` (429), `HTTP {code}` for anything
//! else, and `TRN_HTTP_*` for transport failures. Never logs a body (player
//! data).

use std::sync::OnceLock;
use std::time::Duration;

// Pure rules live in their own module so `src-tauri/pure` can test them on any
// host (see docs/architecture/host-agnostic-tests.md). `pub(crate)` because the
// Warden classifier is SHARED with the edge transport
// (`trn_proxy::result::map_result` calls it through here) — one marker list.
#[path = "trn_http_rules.rs"]
pub(crate) mod rules;
use rules::{captcha_error, host_allowed, status_error, validate_path};

/// TRN's allowlist for its Overwolf client.
///
/// This is an UNOFFICIAL COMPATIBILITY HEADER, not an identity claim: it says
/// "this request speaks the Overwolf client's protocol", nothing about who is
/// asking. TRN controls it server-side and can revoke it at any time (UA check
/// changed or dropped); when that happens this transport answers 403 and the
/// WebView2 proxy is the fallback. Keep it in ONE constant so that day is a
/// one-line change.
pub const TRN_UA: &str = "OverwolfClient";

const TRN_BASE: &str = "https://api.tracker.network";
/// Same 15 s budget the WebView2 transport uses.
const TIMEOUT: Duration = Duration::from_secs(15);
/// Body ceiling: the largest TRN body measured is ~1.7 MB (a season segment);
/// 8 MB is the proxy's cap too. Anything over is refused, never truncated.
const MAX_BODY: usize = 8 * 1024 * 1024;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Shared client: one connection pool, one TLS config, built once.
///
/// rustls needs a process-default crypto provider. The updater installs the
/// same ring provider (`tauri-plugin-updater`), so installing it here too is
/// idempotent and makes this transport independent of plugin init order.
fn client() -> Result<&'static reqwest::Client, String> {
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let built = reqwest::Client::builder()
        .timeout(TIMEOUT)
        // At most 2 redirects, and every hop must stay on the allowlisted host.
        // A cross-host hop is an error, never a silently followed request.
        // (The host is resolved to a bool BEFORE `attempt` is consumed:
        // `attempt.url()` borrows, `follow`/`stop`/`error` move.)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 2 {
                return attempt.stop();
            }
            let host_ok = attempt.url().host_str().map(host_allowed).unwrap_or(false);
            if host_ok {
                attempt.follow()
            } else {
                attempt.error("TRN_HTTP_REDIRECT_HOST")
            }
        }))
        .build()
        .map_err(|e| format!("TRN_HTTP_CLIENT: {e}"))?;
    let _ = CLIENT.set(built);
    CLIENT.get().ok_or_else(|| "TRN_HTTP_CLIENT".to_string())
}

/// Read the body with a hard ceiling.
///
/// `Response::chunk()` streams without reqwest's `stream` feature, so the cap
/// is enforced while reading, not after: an oversized or lying Content-Length
/// can never balloon memory.
async fn read_capped(mut resp: reqwest::Response) -> Result<String, String> {
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_BODY {
            return Err(format!("TRN_HTTP_BODY_TOO_LARGE: {len} bytes > {MAX_BODY}"));
        }
    }
    let mut out: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("TRN_HTTP_ERROR: {e}"))?
    {
        if out.len().saturating_add(chunk.len()) > MAX_BODY {
            return Err(format!("TRN_HTTP_BODY_TOO_LARGE: > {MAX_BODY} bytes"));
        }
        out.extend_from_slice(&chunk);
    }
    String::from_utf8(out).map_err(|_| "TRN_HTTP_BAD_BODY".to_string())
}

/// GET one `/api/...` path from `api.tracker.network`.
///
/// `enabled` is the TS kill-switch: `false` short-circuits before any client is
/// built, so the fallback ladder can disable this transport without a rebuild.
pub async fn fetch(path: String, enabled: bool) -> Result<String, String> {
    if !enabled {
        return Err("TRN_HTTP_DISABLED".to_string());
    }
    validate_path(&path)?;
    let client = client()?;
    let parsed = reqwest::Url::parse(&format!("{TRN_BASE}{path}"))
        .map_err(|_| "TRN_HTTP_BAD_PATH".to_string())?;
    // Belt and suspenders: the base is a constant and validate_path forbids a
    // scheme, but the parsed host is the only thing that decides where bytes go.
    match parsed.host_str() {
        Some(host) if host_allowed(host) => {}
        _ => return Err("TRN_HTTP_BAD_HOST".to_string()),
    }
    let resp = client
        .get(parsed)
        .header(reqwest::header::USER_AGENT, TRN_UA)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| format!("TRN_HTTP_ERROR: {e}"))?;
    let status = resp.status().as_u16();
    if let Some(err) = status_error(status) {
        // A 403 is the ONE non-2xx whose code depends on the body: Tracker
        // Network's "You've Been Blocked" page and Cloudflare's challenge are
        // 403s on this origin, and both are the human-only Warden wall. Fed to
        // the TS 25s→60s ladder as `HTTP 403` they retried a gate no timer can
        // clear. The body is read bounded (32 KB scanned) and never logged; a
        // read failure keeps the plain `HTTP 403` shape, which is already the
        // answer for a body we could not inspect.
        //
        // A direct 429 needs no body read: it already has its own code
        // (`TRN_RATE_LIMITED`), and the API's 429 captcha JSON is a tracker.gg
        // edge shape, not one this origin was probed to return.
        if status == 403 {
            let body = read_capped(resp).await.unwrap_or_default();
            if let Some(wall) = captcha_error(status, &body) {
                return Err(wall);
            }
        }
        return Err(err);
    }
    read_capped(resp).await
}

/// Tauri command surface. Same shape as the proxy's command: `Result<String,
/// String>`, never panics, never logs a body.
#[tauri::command]
pub async fn trn_http_get(path: String, enabled: bool) -> Result<String, String> {
    fetch(path, enabled).await
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::rules::MAX_PATH;

    #[test]
    fn path_validation_rejects_anything_but_a_root_relative_path() {
        assert!(validate_path("/api/v2/valorant/standard/profile/riot/Ginger%20Tofu%231312").is_ok());
        assert!(validate_path("/api/v2/valorant/standard/matches/riot/x").is_ok());
        // Absolute URL / scheme smuggling.
        assert_eq!(
            validate_path("https://evil.example/api/x").unwrap_err(),
            "TRN_HTTP_BAD_PATH"
        );
        assert_eq!(
            validate_path("//evil.example/api/x").unwrap_err(),
            "TRN_HTTP_BAD_PATH"
        );
        // Traversal, in any position.
        assert!(validate_path("/api/../secrets").is_err());
        assert!(validate_path("/api/v2/..").is_err());
        assert!(validate_path("/api/./x").is_err());
        // The query string is allowed and passed through untouched: the profile
        // routes need ?source=overwolf-2 for the full payload.
        assert!(validate_path(
            "/api/v2/valorant/standard/profile/riot/Ginger%20Tofu%231312?source=overwolf-2"
        )
        .is_ok());
        assert!(validate_path(
            "/api/v2/valorant/standard/profile/riot/x?source=overwolf-2&extra=1"
        )
        .is_ok());
        // ...but a query cannot smuggle a scheme or traversal.
        assert!(validate_path("/api/x?next=https://evil.example").is_err());
        assert!(validate_path("/api/x?x=..").is_err());
        // Whitespace, empty and oversized paths.
        assert!(validate_path(" /api/x").is_err());
        assert!(validate_path("/api/x y").is_err());
        assert!(validate_path("/api/x\ny").is_err());
        assert!(validate_path("").is_err());
        assert!(validate_path(&format!("/api/{}", "a".repeat(MAX_PATH))).is_err());
        // Exactly at the cap is fine.
        assert!(validate_path(&format!("/api/{}", "a".repeat(MAX_PATH - 5))).is_ok());
    }

    #[test]
    fn status_mapping_is_the_contract_ts_keys_on() {
        assert_eq!(status_error(200), None);
        assert_eq!(status_error(204), None);
        assert_eq!(status_error(299), None);
        assert_eq!(status_error(451).as_deref(), Some("TRN_PRIVATE"));
        assert_eq!(status_error(404).as_deref(), Some("TRN_NO_DATA"));
        assert_eq!(status_error(429).as_deref(), Some("TRN_RATE_LIMITED"));
        assert_eq!(status_error(403).as_deref(), Some("HTTP 403"));
        assert_eq!(status_error(500).as_deref(), Some("HTTP 500"));
        assert_eq!(status_error(302).as_deref(), Some("HTTP 302"));
    }

    #[test]
    fn only_the_trn_api_host_is_allowed() {
        assert!(host_allowed("api.tracker.network"));
        assert!(host_allowed("API.TRACKER.NETWORK"));
        assert!(!host_allowed("tracker.network"));
        assert!(!host_allowed("api.tracker.network.evil.example"));
        assert!(!host_allowed("evilapi.tracker.network"));
        assert!(!host_allowed(""));
    }
}
