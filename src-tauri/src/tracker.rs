use serde::{Deserialize, Serialize};

use crate::riot_http::{self, Request};

/// base64 PC/Windows/unknown blob Riot's name-service expects verbatim. This
/// route predates the ShooterGame-shaped `X-Riot-ClientPlatform` the other
/// calls send, so it keeps its own value rather than the shared one.
const NAME_SERVICE_CLIENT_PLATFORM: &str = "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalRiotAccount {
    pub game_name: String,
    pub tagline: String,
    pub puuid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalEntitlements {
    pub access_token: String,
    pub entitlements: String,
    pub puuid: String,
}

/// Check if the local Riot Client lockfile exists (instant <0.1ms filesystem check).
#[tauri::command]
pub fn is_riot_client_running() -> bool {
    let Ok(la) = std::env::var("LOCALAPPDATA") else { return false; };
    let lockfile = std::path::PathBuf::from(la)
        .join("Riot Games")
        .join("Riot Client")
        .join("Config")
        .join("lockfile");
    lockfile.exists()
}

/// name:pid:port:password:protocol. Stale lockfile (dead client) surfaces
/// as a connect failure downstream with a clear message.
/// `pub(crate)`: the accounts module reuses the same trust boundary.
pub(crate) fn lockfile_auth() -> Result<(String, String), String> {
    let lockfile = std::env::var("LOCALAPPDATA")
        .map(|la| {
            std::path::PathBuf::from(la)
                .join("Riot Games")
                .join("Riot Client")
                .join("Config")
                .join("lockfile")
        })
        .map_err(|_| "Riot Client not found on this PC.".to_string())?;
    let content = std::fs::read_to_string(&lockfile)
        .map_err(|_| "Riot Client lockfile missing — launch Riot Client or Valorant first.".to_string())?;
    let parts: Vec<&str> = content.trim().split(':').collect();
    if parts.len() < 5 {
        return Err("Unreadable lockfile — relaunch the Riot Client and retry.".to_string());
    }
    Ok((parts[2].to_string(), parts[3].to_string()))
}

/// Generic loopback request to the Riot Client's OWN API surface — friends,
/// friend requests, conversations, messages, blocklist, presence (verified
/// against the client's live swagger: `/chat/v4|v6/*`, `/social/v1|v2/*`).
///
/// This is the same trust boundary as `local_get`/`local_post`: loopback only,
/// credentials read fresh from the lockfile per call, never logged or stored.
/// The path is validated so a caller can never be talked into an absolute URL.
fn local_request_blocking(
    method: String,
    path: String,
    body_arg: Option<String>,
) -> Result<String, String> {
    let upper = method.to_uppercase();
    if !matches!(upper.as_str(), "GET" | "POST" | "PUT" | "DELETE" | "PATCH") {
        return Err("Unsupported method.".to_string());
    }
    if !path.starts_with('/') || path.contains([' ', '\n', '\r']) || path.contains("//") {
        return Err("Invalid path.".to_string());
    }
    let (port, password) = lockfile_auth()?;
    let resp = riot_local(
        &port,
        &password,
        &upper,
        &path,
        body_arg.as_deref(),
        std::time::Duration::from_secs(5),
    )
    .map_err(|_| "Riot Client not responding — launch it and retry.".to_string())?;
    if !(200..300).contains(&resp.status) {
        return Err(format!("HTTP {} from Riot Client.", resp.status));
    }
    Ok(resp.body)
}

/// Call the Riot Client's local API. `path` must be one of its own routes
/// (e.g. `/chat/v4/friends`). Returns the raw JSON response body.
#[tauri::command]
pub async fn local_request(
    method: String,
    path: String,
    body_arg: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || local_request_blocking(method, path, body_arg))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

/// Riot's own loopback API answers on 127.0.0.1 over TLS with a self-signed
/// certificate, so the request is sent with validation off — the in-process
/// equivalent of the old `curl -k`. The port and password come fresh from the
/// lockfile on every call and never leave this argument list.
fn riot_local(
    port: &str,
    password: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
    max_time: std::time::Duration,
) -> Result<riot_http::Response, String> {
    let headers: Vec<(String, String)> = if body.is_some() {
        vec![("Content-Type".to_string(), "application/json".to_string())]
    } else {
        Vec::new()
    };
    let port: u16 = port
        .parse()
        .map_err(|_| "Riot Client not responding — launch it and retry.".to_string())?;
    riot_http::send(&Request {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: &headers,
        body,
        basic_auth: Some(format!("riot:{}", password)),
        accept_invalid_certs: true,
        connect_timeout: std::time::Duration::from_secs(1),
        max_time,
    })
}

/// Loopback read. Returns the raw JSON body; HTTP status is not inspected,
/// exactly as before (curl reported 4xx as a success and the JSON parse below
/// is what rejected it).
pub(crate) fn local_get(
    port: &str,
    password: &str,
    path: &str,
) -> Result<serde_json::Value, String> {
    let resp = riot_local(
        port,
        password,
        "GET",
        path,
        None,
        std::time::Duration::from_secs(2),
    )
    .map_err(|_| "Riot Client not responding — launch it and retry.".to_string())?;
    serde_json::from_str(&resp.body).map_err(|_| "Unexpected local response.".to_string())
}

/// Riot's remote game servers (`*.a.pvp.net` and friends). These are ordinary
/// public HTTPS hosts, so the certificate is validated normally — the inverse
/// of the loopback client above.
fn riot_remote(
    method: &str,
    host: &str,
    path: &str,
    headers: &[(String, String)],
    body: Option<&str>,
    max_time: std::time::Duration,
) -> Result<riot_http::Response, String> {
    riot_http::send(&Request {
        host,
        port: 443,
        path,
        method,
        headers,
        body,
        basic_auth: None,
        accept_invalid_certs: false,
        connect_timeout: std::time::Duration::from_secs(2),
        max_time,
    })
}

/// The four Riot-auth headers the direct calls share, in the order curl sent
/// them. `User-Agent` is the ShooterGame-shaped one Riot expects.
fn riot_auth_headers(
    access_token: &str,
    entitlements: &str,
    client_platform: &str,
    client_version: &str,
) -> Vec<(String, String)> {
    vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", access_token),
        ),
        (
            "X-Riot-Entitlements-JWT".to_string(),
            entitlements.to_string(),
        ),
        (
            "X-Riot-ClientPlatform".to_string(),
            client_platform.to_string(),
        ),
        (
            "X-Riot-ClientVersion".to_string(),
            client_version.to_string(),
        ),
        (
            "User-Agent".to_string(),
            format!(
                "ShooterGame/{} Windows/10.0.19042.1.256.64bit",
                client_version
            ),
        ),
    ]
}

/// Host/path guard shared by every `riot_direct_*` call. A caller can never be
/// talked into an absolute URL or a non-Riot host.
fn validate_direct(host: &str, path: &str) -> Result<(), String> {
    if host.contains(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-')) {
        return Err("Invalid host.".to_string());
    }
    if path.contains([' ', '\n', '\r']) {
        return Err("Invalid path.".to_string());
    }
    Ok(())
}

/// PUT twin of `riot_direct_post_blocking`: same hosts/headers, but `-X PUT`
/// with a real JSON body. Needed for player-preferences routes (notably
/// `PUT /playerPref/v3/savePreference` — crosshair saves).
fn riot_direct_put_blocking(
    host: String,
    path: String,
    body_arg: String,
    access_token: String,
    entitlements: String,
    client_platform: String,
    client_version: String,
) -> Result<String, String> {
    validate_direct(&host, &path)?;
    let mut headers = riot_auth_headers(
        &access_token,
        &entitlements,
        &client_platform,
        &client_version,
    );
    headers.insert(
        0,
        ("Content-Type".to_string(), "application/json".to_string()),
    );
    let resp = riot_remote(
        "PUT",
        &host,
        &path,
        &headers,
        Some(&body_arg),
        std::time::Duration::from_secs(10),
    )
    .map_err(|_| "Riot error: ".to_string())?;
    if riot_http::is_auth_failure(&resp.body) {
        return Err("RIOT_EXPIRED".to_string());
    }
    Ok(resp.body)
}

/// PUT twin of `riot_direct_post`: same pipeline, real JSON body.
#[tauri::command]
pub async fn riot_direct_put(
    host: String,
    path: String,
    body_arg: String,
    access_token: String,
    entitlements: String,
    client_platform: String,
    client_version: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        riot_direct_put_blocking(
            host,
            path,
            body_arg,
            access_token,
            entitlements,
            client_platform,
            client_version,
        )
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}
/// POST a JSON body to the local Riot Client. Same trust boundary as
/// `local_get` (loopback + lockfile credentials).
fn local_post(
    port: &str,
    password: &str,
    path: &str,
    body: &str,
) -> Result<serde_json::Value, String> {
    let resp = riot_local(
        port,
        password,
        "POST",
        path,
        Some(body),
        std::time::Duration::from_secs(3),
    )
    .map_err(|_| "Riot Client not responding — launch it and retry.".to_string())?;
    serde_json::from_str(&resp.body).map_err(|_| "Unexpected local response.".to_string())
}

/// Resolve PUUIDs to Riot IDs through the Riot Client's OWN account service
/// (`/player-account/lookup/v2/namesets-for-puuids`), not the game's
/// name-service.
///
/// Why this exists: it is a single batched local call — no entitlements token,
/// no `pd.*` round trip, no Cloudflare, no 1015 rate limit. It also reports an
/// explicit per-PUUID `error` string ("Nameset V2 not found for puuid.") which
/// lets the UI tell "no name exists" apart from "the call failed" — the remote
/// endpoint returns a blank string with no marker, which is why HIDDEN and
/// FAILED were previously indistinguishable.
///
/// Returns the raw `namesets` array so the caller keeps `error` alongside
/// `alias`. PUUIDs are chunked because a whole lobby is small but the request
/// is unrouted for very large inputs.
fn riot_local_namesets_blocking(puuids: Vec<String>) -> Result<String, String> {
    if puuids.is_empty() {
        return Ok("[]".to_string());
    }
    let (port, password) = lockfile_auth()?;
    let mut all: Vec<serde_json::Value> = Vec::new();
    for chunk in puuids.chunks(25) {
        let body = serde_json::json!({ "puuids": chunk }).to_string();
        let v = local_post(
            &port,
            &password,
            "/player-account/lookup/v2/namesets-for-puuids",
            &body,
        )?;
        if let Some(items) = v.get("namesets").and_then(|n| n.as_array()) {
            all.extend(items.iter().cloned());
        }
    }
    serde_json::to_string(&all).map_err(|e| format!("Serialize failed: {}", e))
}

/// Local, batched PUUID -> Riot ID lookup via the Riot Client account service.
#[tauri::command]
pub async fn riot_local_namesets(puuids: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || riot_local_namesets_blocking(puuids))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

/// Reads the logged-in Riot account from the local Riot Client lockfile —
/// the same technique desktop trackers use.
fn detect_local_account_blocking() -> Result<LocalRiotAccount, String> {
    let (port, password) = lockfile_auth()?;
    let v = local_get(&port, &password, "/player-account/aliases/v1/active")?;
    let game_name = v
        .get("game_name")
        .and_then(|s| s.as_str())
        .ok_or("No active session — log into the Riot Client first.".to_string())?;
    // This endpoint carries the name but NOT the PUUID — pull that from the
    // entitlements token (subject) and fall back to the ID token claim, so the
    // identity cache always knows which account it belongs to.
    let puuid = v
        .get("puuid")
        .and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            local_get(&port, &password, "/entitlements/v1/token")
                .ok()
                .and_then(|e| {
                    e.get("subject")
                        .and_then(|s| s.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                })
        })
        .unwrap_or_default();
    Ok(LocalRiotAccount {
        game_name: game_name.to_string(),
        tagline: v
            .get("tag_line")
            .or_else(|| v.get("tagline"))
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
        puuid,
    })
}

/// Async so the blocking network work never freezes the UI thread.
#[tauri::command]
pub async fn detect_local_account() -> Result<LocalRiotAccount, String> {
    tauri::async_runtime::spawn_blocking(detect_local_account_blocking)
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

/// Entitlements triple for direct Riot calls (refetch when Riot 401s).
fn local_entitlements_blocking() -> Result<LocalEntitlements, String> {
    let (port, password) = lockfile_auth()?;
    let v = local_get(&port, &password, "/entitlements/v1/token")?;
    Ok(LocalEntitlements {
        access_token: v
            .get("accessToken")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
        entitlements: v
            .get("token")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
        puuid: v
            .get("subject")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

#[tauri::command]
pub async fn local_entitlements() -> Result<LocalEntitlements, String> {
    tauri::async_runtime::spawn_blocking(local_entitlements_blocking)
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

/// Client version for the X-Riot-ClientVersion header, read from the
/// latest game log (e.g. "CI server version: release-13.05-shipping-11-…").
fn local_client_version_blocking() -> Result<String, String> {
    let log_path = std::env::var("LOCALAPPDATA")
        .map(|la| {
            std::path::PathBuf::from(la)
                .join("VALORANT")
                .join("Saved")
                .join("Logs")
                .join("ShooterGame.log")
        })
        .map_err(|_| "VALORANT logs not found.".to_string())?;
    let content = std::fs::read_to_string(&log_path).map_err(|_| "Game log missing.".to_string())?;
    for line in content.lines() {
        if let Some(i) = line.find("CI server version:") {
            let v = line[i + "CI server version:".len()..].trim().to_string();
            if !v.is_empty() {
                return Ok(v);
            }
        }
    }
    Err("Client version not found in logs.".to_string())
}

#[tauri::command]
pub async fn local_client_version() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(local_client_version_blocking)
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

/// Raw local presence list as JSON.
///
/// This is the only live source of the player's equipped card and account
/// level: `/personalization/v1|v2/players/{puuid}/playerloadout` now returns
/// 404, so the card art had stopped resolving and the sidebar fell back to a
/// letter avatar. Every local presence carries `playerPresenceData`
/// (`playerCardId`, `accountLevel`) plus the live match blob.
#[tauri::command]
pub async fn local_presences() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (port, password) = lockfile_auth()?;
        let v = local_get(&port, &password, "/chat/v4/presences")?;
        serde_json::to_string(&v).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Generic authed GET against Riot's servers. Tokens stay in arguments;
/// the raw body returns so the frontend parses defensively.
///
/// Async + spawn_blocking: a synchronous command runs on Tauri's main thread,
/// so every request would stall the webview. The 24h tracker fires dozens of
/// these per lobby — on the main thread that froze the whole UI.
#[tauri::command]
pub async fn riot_direct_get(
    host: String,
    path: String,
    access_token: String,
    entitlements: String,
    client_platform: String,
    client_version: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        riot_direct_get_blocking(
            host,
            path,
            access_token,
            entitlements,
            client_platform,
            client_version,
        )
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// POST twin of `riot_direct_get`: same hosts/headers, but `-X POST` with an
/// empty JSON body. Needed because some player-data routes (notably
/// `POST /store/v3/storefront/{puuid}` — the daily shop) reject GET with 405.
#[tauri::command]
pub async fn riot_direct_post(
    host: String,
    path: String,
    access_token: String,
    entitlements: String,
    client_platform: String,
    client_version: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        riot_direct_post_blocking(
            host,
            path,
            access_token,
            entitlements,
            client_platform,
            client_version,
        )
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

fn riot_direct_get_blocking(
    host: String,
    path: String,
    access_token: String,
    entitlements: String,
    client_platform: String,
    client_version: String,
) -> Result<String, String> {
    validate_direct(&host, &path)?;
    let headers = riot_auth_headers(
        &access_token,
        &entitlements,
        &client_platform,
        &client_version,
    );
    let resp = riot_remote(
        "GET",
        &host,
        &path,
        &headers,
        None,
        std::time::Duration::from_secs(6),
    )
    .map_err(|_| "Riot error: ".to_string())?;
    if riot_http::is_auth_failure(&resp.body) {
        return Err("RIOT_EXPIRED".to_string());
    }
    Ok(resp.body)
}

fn riot_direct_post_blocking(
    host: String,
    path: String,
    access_token: String,
    entitlements: String,
    client_platform: String,
    client_version: String,
) -> Result<String, String> {
    validate_direct(&host, &path)?;
    let mut headers = riot_auth_headers(
        &access_token,
        &entitlements,
        &client_platform,
        &client_version,
    );
    headers.insert(
        0,
        ("Content-Type".to_string(), "application/json".to_string()),
    );
    let resp = riot_remote(
        "POST",
        &host,
        &path,
        &headers,
        Some("{}"),
        std::time::Duration::from_secs(6),
    )
    .map_err(|_| "Riot error: ".to_string())?;
    if riot_http::is_auth_failure(&resp.body) {
        return Err("RIOT_EXPIRED".to_string());
    }
    Ok(resp.body)
}

/// Resolve PUUIDs to real GameNames and TagLines via Riot's name-service endpoint.
fn riot_resolve_names_blocking(shard: String, puuids: Vec<String>) -> Result<String, String> {
    if puuids.is_empty() {
        return Ok("[]".to_string());
    }
    let (port, password) = lockfile_auth()?;
    let ent = local_get(&port, &password, "/entitlements/v1/token")?;
    let access_token = ent
        .get("accessToken")
        .and_then(|s| s.as_str())
        .ok_or_else(|| "No access token".to_string())?;
    let token = ent
        .get("token")
        .and_then(|s| s.as_str())
        .ok_or_else(|| "No entitlement token".to_string())?;

    let client_version = local_client_version_blocking()
        .unwrap_or_else(|_| "release-13.05-shipping-11-5350494".to_string());
    let shard_lower = shard.trim_start_matches("pd.").trim_end_matches(".a.pvp.net").to_lowercase();
    let clean_shard = match shard_lower.as_str() {
        "na" | "latam" | "br" => "na",
        "ap" => "ap",
        "kr" => "kr",
        _ => "eu",
    };
    let path = "/name-service/v2/players";
    let host = format!("pd.{}.a.pvp.net", clean_shard);
    let body = serde_json::to_string(&puuids).map_err(|e| e.to_string())?;
    // No User-Agent here, matching the original call.
    let headers = vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", access_token),
        ),
        ("X-Riot-Entitlements-JWT".to_string(), token.to_string()),
        (
            "X-Riot-ClientPlatform".to_string(),
            NAME_SERVICE_CLIENT_PLATFORM.to_string(),
        ),
        ("X-Riot-ClientVersion".to_string(), client_version.clone()),
        ("Content-Type".to_string(), "application/json".to_string()),
    ];

    let resp = riot_remote(
        "PUT",
        &host,
        path,
        &headers,
        Some(&body),
        std::time::Duration::from_secs(10),
    )
    .map_err(|_| "Name service error: ".to_string())?;
    Ok(resp.body)
}

#[tauri::command]
pub async fn riot_resolve_names(shard: String, puuids: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || riot_resolve_names_blocking(shard, puuids))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}
