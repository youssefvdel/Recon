//! Riot Client loopback reads: the local account, entitlements and presences.
//!
//! Trust boundary, unchanged from the Tauri app: `127.0.0.1` only, credentials
//! read fresh from the lockfile per call, certificate validation off (the Riot
//! Client's certificate is self-signed and not issued for 127.0.0.1), and the
//! password never leaves this module's argument list or gets logged.
//!
//! The transport is `riot_http` (native-tls/Schannel), included by path, so
//! there is no second TLS stack and no `curl.exe` child process per poll.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

use crate::riot_http::{self, Request};

/// Compressed form of the lockfile credentials.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockfileAuth {
    pub port: String,
    pub password: String,
}

/// `name:pid:port:password:protocol`. A stale lockfile (dead client) surfaces
/// later as a connect failure; this only validates the shape.
pub fn parse_lockfile(text: &str) -> Result<LockfileAuth, String> {
    let parts: Vec<&str> = text.trim().split(':').collect();
    if parts.len() < 5 {
        return Err("Unreadable Riot Client lockfile — relaunch it and retry.".to_string());
    }
    let port = parts[2].trim();
    if port.parse::<u16>().is_err() || port.is_empty() {
        return Err("Riot Client lockfile has no usable port.".to_string());
    }
    if parts[3].is_empty() {
        return Err("Riot Client lockfile has no password.".to_string());
    }
    Ok(LockfileAuth {
        port: port.to_string(),
        password: parts[3].to_string(),
    })
}

/// `%LOCALAPPDATA%\Riot Games\Riot Client\Config\lockfile`.
pub fn lockfile_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|base| {
        PathBuf::from(base)
            .join("Riot Games")
            .join("Riot Client")
            .join("Config")
            .join("lockfile")
    })
}

/// Cheap `stat` used as the "client is running" gate before any network call.
pub fn lockfile_present() -> bool {
    lockfile_path().map(|p| p.exists()).unwrap_or(false)
}

pub fn read_lockfile() -> Result<LockfileAuth, String> {
    let path = lockfile_path().ok_or_else(|| "Riot Client not found on this PC.".to_string())?;
    let text = std::fs::read_to_string(&path).map_err(|_| {
        "Riot Client lockfile missing — launch Riot Client or VALORANT first.".to_string()
    })?;
    parse_lockfile(&text)
}

/// One loopback GET, decrypted and parsed. Never logs the credentials.
fn local_get(auth: &LockfileAuth, path: &str) -> Result<Value, String> {
    let port: u16 = auth
        .port
        .parse()
        .map_err(|_| "Riot Client lockfile has no usable port.".to_string())?;
    let resp = riot_http::send(&Request {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: &[],
        body: None,
        basic_auth: Some(format!("riot:{}", auth.password)),
        accept_invalid_certs: true,
        connect_timeout: Duration::from_secs(1),
        max_time: Duration::from_secs(5),
    })
    .map_err(|_| "Riot Client not responding — launch it and retry.".to_string())?;
    serde_json::from_str(&resp.body).map_err(|_| "Unexpected local response.".to_string())
}

/// The locally signed-in account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub game_name: String,
    pub tag_line: String,
    pub puuid: String,
}

/// `/player-account/aliases/v1/active` + the PUUID from entitlements (the
/// aliases endpoint does not carry one).
pub fn fetch_identity(auth: &LockfileAuth) -> Result<Identity, String> {
    let v = local_get(auth, "/player-account/aliases/v1/active")?;
    let game_name = v
        .get("game_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if game_name.is_empty() {
        return Err("No active Riot session — log into the Riot Client first.".to_string());
    }
    let tag_line = v
        .get("tag_line")
        .or_else(|| v.get("tagline"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let puuid = v
        .get("puuid")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            local_get(auth, "/entitlements/v1/token")
                .ok()
                .and_then(|e| {
                    e.get("subject")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                })
        })
        .unwrap_or_default();
    if puuid.is_empty() {
        return Err("Riot Client answered without a PUUID — sign in again.".to_string());
    }
    Ok(Identity {
        game_name,
        tag_line,
        puuid,
    })
}

/// The entitlement triple `/mmr` needs. Never persisted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entitlements {
    pub access_token: String,
    pub token: String,
    pub subject: String,
}

pub fn fetch_entitlements(auth: &LockfileAuth) -> Result<Entitlements, String> {
    let v = local_get(auth, "/entitlements/v1/token")?;
    let read = |key: &str| v.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let ent = Entitlements {
        access_token: read("accessToken"),
        token: read("token"),
        subject: read("subject"),
    };
    if ent.access_token.is_empty() || ent.token.is_empty() {
        return Err("Riot Client session has no entitlement token — sign in again.".to_string());
    }
    Ok(ent)
}

/// Raw `/chat/v4/presences` body. Parsing/derivation stays in `live_facts`.
pub fn fetch_presences(auth: &LockfileAuth) -> Result<Value, String> {
    local_get(auth, "/chat/v4/presences")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lockfile_parses_the_name_pid_port_password_protocol_shape() {
        let auth = parse_lockfile("Riot Client:4242:54321:s3cret:https\n").unwrap();
        assert_eq!(
            auth,
            LockfileAuth {
                port: "54321".to_string(),
                password: "s3cret".to_string()
            }
        );
    }

    #[test]
    fn a_truncated_lockfile_is_a_clear_error_not_a_guess() {
        assert!(parse_lockfile("Riot Client:4242:54321").is_err());
        assert!(parse_lockfile("").is_err());
        assert!(parse_lockfile("a:b:not-a-port:secret:https").is_err());
        assert!(parse_lockfile("a:b:123::https").is_err());
    }
}
