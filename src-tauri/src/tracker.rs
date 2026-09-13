use serde::{Deserialize, Serialize};
use std::process::Command;

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

fn curl_args() -> Command {
    let mut cmd = Command::new("curl");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.arg("--ssl-no-revoke");
    }
    cmd
}

/// GET against the local client (self-signed cert). Password lives only in
/// the curl argument for one local call — never logged or stored.
/// `pub(crate)`: the accounts module reads the live Riot ID through it.
pub(crate) fn local_get(port: &str, password: &str, path: &str) -> Result<serde_json::Value, String> {
    let url = format!("https://127.0.0.1:{}{}", port, path);
    let output = curl_args()
        .args([
            "-s",
            "-k",
            "--connect-timeout",
            "1",
            "--max-time",
            "2",
            "-u",
            &format!("riot:{}", password),
            &url,
        ])
        .output()
        .map_err(|e| format!("Local query failed: {}", e))?;
    if !output.status.success() {
        return Err("Riot Client not responding — launch it and retry.".to_string());
    }
    serde_json::from_str(&String::from_utf8_lossy(&output.stdout))
        .map_err(|_| "Unexpected local response.".to_string())
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
    if host.contains(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-')) {
        return Err("Invalid host.".to_string());
    }
    if path.contains([' ', '\n', '\r']) {
        return Err("Invalid path.".to_string());
    }
    let url = format!("https://{}{}", host, path);
    let ua = format!("ShooterGame/{} Windows/10.0.19042.1.256.64bit", client_version);
    let output = curl_args()
        .args([
            "-s",
            "--connect-timeout",
            "2",
            "--max-time",
            "10",
            "-X",
            "PUT",
            "-H",
            "Content-Type: application/json",
            "-H",
            &format!("Authorization: Bearer {}", access_token),
            "-H",
            &format!("X-Riot-Entitlements-JWT: {}", entitlements),
            "-H",
            &format!("X-Riot-ClientPlatform: {}", client_platform),
            "-H",
            &format!("X-Riot-ClientVersion: {}", client_version),
            "-H",
            &format!("User-Agent: {}", ua),
            "-d",
            &body_arg,
            &url,
        ])
        .output()
        .map_err(|e| format!("Riot query failed: {}", e))?;
    let body = String::from_utf8_lossy(&output.stdout).to_string();
    if body.contains("\"statusCode\":401")
        || body.contains("\"httpStatus\":401")
        || body.contains("\"statusCode\": 401")
        || body.contains("\"httpStatus\": 401")
        || body.contains("BAD_AUTH")
        || body.contains("EXPIRED_AUTH")
        || body.contains("FORBIDDEN")
    {
        return Err("RIOT_EXPIRED".to_string());
    }
    if !output.status.success() {
        return Err(format!("Riot error: {}", body.chars().take(160).collect::<String>()));
    }
    Ok(body)
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
fn local_post(port: &str, password: &str, path: &str, body: &str) -> Result<serde_json::Value, String> {
    let url = format!("https://127.0.0.1:{}{}", port, path);
    let output = curl_args()
        .args([
            "-s",
            "-k",
            "--connect-timeout",
            "1",
            "--max-time",
            "3",
            "-u",
            &format!("riot:{}", password),
            "-H",
            "Content-Type: application/json",
            "-X",
            "POST",
            "-d",
            body,
            &url,
        ])
        .output()
        .map_err(|e| format!("Local query failed: {}", e))?;
    if !output.status.success() {
        return Err("Riot Client not responding — launch it and retry.".to_string());
    }
    serde_json::from_str(&String::from_utf8_lossy(&output.stdout))
        .map_err(|_| "Unexpected local response.".to_string())
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

/// Async so the spawn_blocking curl never freezes the UI thread.
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

/// Chrome-impersonated GET for tracker.gg's Cloudflare wall, via the bundled
/// trnfetch sidecar (Go + uTLS Chrome fingerprint — pure-Rust TLS spoofing has
/// no Windows-ready crate; BoringSSL won't compile under MSVC toolchains).
/// Read-only profile/segment calls, no key, no browser session. If TRN ever
/// gates them, callers fall back to Riot-direct data.
#[tauri::command]
pub async fn trn_get(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || trn_get_blocking(path))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

fn trn_get_blocking(path: String) -> Result<String, String> {
    if path.contains([' ', '\n', '\r']) || !path.starts_with("/api/") {
        return Err("Invalid path.".to_string());
    }
    if path.len() > 300 {
        return Err("Path too long.".to_string());
    }
    let url = format!("https://api.tracker.gg{}", path);
    // Prod: sidecar sits beside the app binary (either trnfetch.exe or trnfetch-x86_64-pc-windows-msvc.exe).
    // Dev: src-tauri/binaries/.
    let bin_triple = "trnfetch-x86_64-pc-windows-msvc.exe";
    let bin_short = "trnfetch.exe";
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));

    let bin = exe_dir
        .as_ref()
        .map(|d| d.join(bin_short))
        .filter(|p| p.exists())
        .or_else(|| {
            exe_dir
                .as_ref()
                .map(|d| d.join(bin_triple))
                .filter(|p| p.exists())
        })
        .unwrap_or_else(|| {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(bin_triple)
        });
    let mut cmd = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd
        .arg(&url)
        .arg("--max-time")
        .arg("20")
        .output()
        .map_err(|e| format!("sidecar failed: {}", e))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "TRN_{}",
            err.trim().chars().take(140).collect::<String>()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Generic authed GET against Riot's servers. Tokens stay in arguments;
/// the raw body returns so the frontend parses defensively.
///
/// Async + spawn_blocking: a synchronous command runs on Tauri's main thread,
/// so every curl would stall the webview. The 24h tracker fires dozens of these
/// per lobby — on the main thread that froze the whole UI.
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
    if host.contains(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-')) {
        return Err("Invalid host.".to_string());
    }
    if path.contains([' ', '\n', '\r']) {
        return Err("Invalid path.".to_string());
    }
    let url = format!("https://{}{}", host, path);
    let ua = format!("ShooterGame/{} Windows/10.0.19042.1.256.64bit", client_version);
    let output = curl_args()
        .args([
            "-s",
            "--connect-timeout",
            "2",
            "--max-time",
            "6",
            "-H",
            &format!("Authorization: Bearer {}", access_token),
            "-H",
            &format!("X-Riot-Entitlements-JWT: {}", entitlements),
            "-H",
            &format!("X-Riot-ClientPlatform: {}", client_platform),
            "-H",
            &format!("X-Riot-ClientVersion: {}", client_version),
            "-H",
            &format!("User-Agent: {}", ua),
            &url,
        ])
        .output()
        .map_err(|e| format!("Riot query failed: {}", e))?;
    let body = String::from_utf8_lossy(&output.stdout).to_string();
    if body.contains("\"statusCode\":401")
        || body.contains("\"httpStatus\":401")
        || body.contains("\"statusCode\": 401")
        || body.contains("\"httpStatus\": 401")
        || body.contains("BAD_AUTH")
        || body.contains("EXPIRED_AUTH")
        || body.contains("FORBIDDEN")
    {
        return Err("RIOT_EXPIRED".to_string());
    }
    if !output.status.success() {
        return Err(format!("Riot error: {}", body.chars().take(160).collect::<String>()));
    }
    Ok(body)
}

fn riot_direct_post_blocking(
    host: String,
    path: String,
    access_token: String,
    entitlements: String,
    client_platform: String,
    client_version: String,
) -> Result<String, String> {
    if host.contains(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-')) {
        return Err("Invalid host.".to_string());
    }
    if path.contains([' ', '\n', '\r']) {
        return Err("Invalid path.".to_string());
    }
    let url = format!("https://{}{}", host, path);
    let ua = format!("ShooterGame/{} Windows/10.0.19042.1.256.64bit", client_version);
    let output = curl_args()
        .args([
            "-s",
            "--connect-timeout",
            "2",
            "--max-time",
            "6",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "-H",
            &format!("Authorization: Bearer {}", access_token),
            "-H",
            &format!("X-Riot-Entitlements-JWT: {}", entitlements),
            "-H",
            &format!("X-Riot-ClientPlatform: {}", client_platform),
            "-H",
            &format!("X-Riot-ClientVersion: {}", client_version),
            "-H",
            &format!("User-Agent: {}", ua),
            "-d",
            "{}",
            &url,
        ])
        .output()
        .map_err(|e| format!("Riot query failed: {}", e))?;
    let body = String::from_utf8_lossy(&output.stdout).to_string();
    if body.contains("\"statusCode\":401")
        || body.contains("\"httpStatus\":401")
        || body.contains("\"statusCode\": 401")
        || body.contains("\"httpStatus\": 401")
        || body.contains("BAD_AUTH")
        || body.contains("EXPIRED_AUTH")
        || body.contains("FORBIDDEN")
    {
        return Err("RIOT_EXPIRED".to_string());
    }
    if !output.status.success() {
        return Err(format!("Riot error: {}", body.chars().take(160).collect::<String>()));
    }
    Ok(body)
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
    let url = format!("https://pd.{}.a.pvp.net/name-service/v2/players", clean_shard);
    let body = serde_json::to_string(&puuids).map_err(|e| e.to_string())?;

    let output = curl_args()
        .args([
            "-s",
            "-X",
            "PUT",
            "--max-time",
            "10",
            "-H",
            &format!("Authorization: Bearer {}", access_token),
            "-H",
            &format!("X-Riot-Entitlements-JWT: {}", token),
            "-H",
            "X-Riot-ClientPlatform: ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9",
            "-H",
            &format!("X-Riot-ClientVersion: {}", client_version),
            "-H",
            "Content-Type: application/json",
            "-d",
            &body,
            &url,
        ])
        .output()
        .map_err(|e| format!("Name service failed: {}", e))?;

    let res = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        return Err(format!("Name service error: {}", res));
    }
    Ok(res)
}

#[tauri::command]
pub async fn riot_resolve_names(shard: String, puuids: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || riot_resolve_names_blocking(shard, puuids))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}
