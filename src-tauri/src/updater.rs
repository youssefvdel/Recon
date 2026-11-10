use serde::{Deserialize, Serialize};
use std::process::Command;

// Pure version/channel maths lives in its own module so `src-tauri/pure` can
// test it on any host (see docs/architecture/host-agnostic-tests.md).
#[path = "updater_version.rs"]
mod version;
pub use version::{is_upgrade, DEFAULT_REPO};

pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub rid: u32,
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
    pub raw_json: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Version ordering
//
// Two rules, both load-bearing for the early-access channel:
//   1. Only a STRICTLY newer version is an update. `!=` offered downgrades.
//   2. Prerelease identifiers compare naturally: this repo tags
//      `0.5.0-alpha9`, `0.5.0-alpha10`, `0.5.0-alpha14`. Plain semver compares
//      those identifiers lexically ("alpha10" < "alpha9"), which inverts the
//      channel and is exactly how alpha9 was offered while running alpha10.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Release picking
// ---------------------------------------------------------------------------

/// `curl` a GitHub API URL and parse JSON. Unauthenticated and time-boxed; any
/// failure is a `None`, never a panic or a hang.
fn github_json(url: &str) -> Option<serde_json::Value> {
    let user_agent = format!("User-Agent: Recon/{}", CURRENT_VERSION);
    let mut cmd = Command::new("curl");
    cmd.args([
        "-s",
        "--max-time",
        "4",
        "-H",
        &user_agent,
        "-H",
        "Accept: application/vnd.github.v3+json",
        url,
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

/// Resolves the signed `latest.json` manifest endpoint for a given channel.
/// - "stable": Official release endpoint from GitHub releases/latest
/// - "early-access" / "alpha": highest version across the release list and
///   `releases/latest`, so a stale list cannot pin an older manifest.
pub fn resolve_channel_endpoint(channel: &str) -> String {
    version::resolve_endpoint_with(channel, github_json)
}

/// Checks for updates on a specific channel ("stable" or "early-access")
/// using Tauri's official updater plugin with cryptographic signature verification.
pub async fn check_channel_update_internal(
    webview: tauri::Webview,
    channel: String,
) -> Result<Option<UpdateMetadata>, String> {
    use tauri::Url;
    use tauri_plugin_updater::UpdaterExt;

    let endpoint_str = resolve_channel_endpoint(&channel);
    let endpoint_url = Url::parse(&endpoint_str)
        .map_err(|e| format!("Invalid update URL {}: {}", endpoint_str, e))?;

    let mut builder = webview.updater_builder();
    builder = builder
        .endpoints(vec![endpoint_url])
        .map_err(|e| format!("Failed to configure updater endpoints: {}", e))?;

    let is_early_access = channel.eq_ignore_ascii_case("early-access")
        || channel.eq_ignore_ascii_case("early_access")
        || channel.eq_ignore_ascii_case("alpha");

    if is_early_access {
        // Strictly newer only. The old `!=` offered any different version,
        // including older ones, which shipped a downgrade button.
        builder = builder.version_comparator(|current, update| {
            is_upgrade(&current.to_string(), &update.version.to_string())
        });
    }

    let updater = builder
        .build()
        .map_err(|e| format!("Failed to build updater: {}", e))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("Update check failed: {}", e))?;

    if let Some(update) = update {
        use tauri::Manager;
        let rid = webview.resources_table().add(update.clone());
        Ok(Some(UpdateMetadata {
            rid,
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            date: update.date.map(|d| d.to_string()),
            body: update.body.clone(),
            raw_json: update.raw_json.clone(),
        }))
    } else {
        Ok(None)
    }
}

/// Opens an external URL in the user's default browser.
pub fn open_url(url: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let url_h = HSTRING::from(url);
    let open_h = HSTRING::from("open");
    unsafe {
        ShellExecuteW(None, windows::core::PCWSTR(open_h.as_ptr()), windows::core::PCWSTR(url_h.as_ptr()), None, None, SW_SHOWNORMAL);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::version::{cmp_versions, pick_endpoint_tag, pick_highest_manifest_tag};
    use serde_json::json;
    use std::cmp::Ordering;

    fn first(a: &str, b: &str) -> bool {
        cmp_versions(a, b) == Some(Ordering::Less)
    }

    #[test]
    fn lower_version_is_never_an_upgrade() {
        // The bug: alpha9 was offered while running alpha10.
        assert!(!is_upgrade("0.5.0-alpha10", "0.5.0-alpha9"));
        assert!(!is_upgrade("0.5.0", "0.4.9"));
        assert!(!is_upgrade("0.5.0-alpha10", "0.5.0-alpha10"));
        // ...and the real upgrade is still offered.
        assert!(is_upgrade("0.5.0-alpha10", "0.5.0-alpha11"));
        assert!(is_upgrade("0.4.9", "0.5.0"));
    }

    #[test]
    fn prerelease_ordering_is_natural() {
        assert!(first("0.5.0-alpha9", "0.5.0-alpha10"));
        assert!(first("0.5.0-alpha10", "0.5.0-alpha11"));
        assert!(first("0.5.0-alpha11", "0.5.0-alpha12"));
        // A release outranks its own prereleases.
        assert!(first("0.5.0-alpha14", "0.5.0"));
        // Lexical ordering would put alpha below its numeric siblings; beta
        // still outranks alpha.
        assert!(first("0.5.0-alpha10", "0.5.0-beta1"));
        assert!(first("0.9.9", "0.10.0"));
        // Tag prefixes are tolerated.
        assert!(is_upgrade("v0.5.0-alpha9", "v0.5.0-alpha10"));
        // Garbage never counts as newer.
        assert!(!is_upgrade("0.5.0-alpha10", "not-a-version"));
    }

    fn release(tag: &str, has_manifest: bool) -> serde_json::Value {
        json!({
            "tag_name": tag,
            "assets": if has_manifest {
                json!([{ "name": "latest.json" }, { "name": "Recon_0.5.0_x64-setup.exe" }])
            } else {
                json!([{ "name": "Recon_0.5.0_x64-setup.exe" }])
            }
        })
    }

    #[test]
    fn picker_takes_the_highest_not_the_first() {
        let releases = vec![
            release("v0.5.0-alpha9", true),
            release("v0.5.0-alpha11", false), // no manifest: must not win
            release("v0.5.0-alpha8", true),
            release("v0.5.0-alpha10", true),
        ];
        assert_eq!(pick_highest_manifest_tag(&releases), Some("v0.5.0-alpha10"));
    }

    #[test]
    fn picker_uses_latest_when_the_list_is_stale_or_empty() {
        let latest = release("v0.5.0-alpha10", true);
        // QA's exact shape: the list lags one build behind.
        let stale = vec![release("v0.5.0-alpha9", true)];
        assert_eq!(
            pick_endpoint_tag(&stale, Some(&latest)),
            Some("v0.5.0-alpha10")
        );
        // Empty list: fall back to releases/latest.
        assert_eq!(pick_endpoint_tag(&[], Some(&latest)), Some("v0.5.0-alpha10"));
        // List has a manifest-less newer tag only: latest still wins.
        let no_manifest = vec![release("v0.5.0-alpha11", false)];
        assert_eq!(
            pick_endpoint_tag(&no_manifest, Some(&latest)),
            Some("v0.5.0-alpha10")
        );
        // Nothing at all: caller keeps the floating-ref fallback.
        assert_eq!(pick_endpoint_tag(&[], None), None);
    }

    #[test]
    fn newer_list_entry_beats_older_latest() {
        let releases = vec![release("v0.5.0-alpha11", true)];
        let latest = release("v0.5.0-alpha10", true);
        assert_eq!(
            pick_endpoint_tag(&releases, Some(&latest)),
            Some("v0.5.0-alpha11")
        );
    }
}
