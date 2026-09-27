use serde::{Deserialize, Serialize};
use std::process::Command;

pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_REPO: &str = "youssefvdel/Recon";

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

/// Resolves the signed `latest.json` manifest endpoint for a given channel.
/// - "stable": Official release endpoint from GitHub releases/latest
/// - "early-access" / "alpha": Queries GitHub releases API to target the newest
///   release (including alpha / pre-releases).
pub fn resolve_channel_endpoint(channel: &str) -> String {
    let ch = channel.to_lowercase();
    let is_early_access = ch == "early-access" || ch == "early_access" || ch == "alpha" || ch == "beta";

    if is_early_access {
        // Probe GitHub releases for the newest release (pre-release or alpha)
        let releases_api = format!("https://api.github.com/repos/{}/releases?per_page=5", DEFAULT_REPO);
        let user_agent = format!("User-Agent: Recon/{}", CURRENT_VERSION);
        let mut cmd = Command::new("curl");
        cmd.args([
            "-s",
            "--max-time", "4",
            "-H", &user_agent,
            "-H", "Accept: application/vnd.github.v3+json",
            &releases_api,
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        if let Ok(output) = cmd.output() {
            if output.status.success() {
                if let Ok(releases) = serde_json::from_slice::<Vec<serde_json::Value>>(&output.stdout) {
                    // Check releases in order: find the newest release that has latest.json
                    for rel in &releases {
                        if let Some(tag) = rel.get("tag_name").and_then(|t| t.as_str()) {
                            let has_manifest = rel
                                .get("assets")
                                .and_then(|a| a.as_array())
                                .map(|assets| {
                                    assets.iter().any(|asset| {
                                        asset
                                            .get("name")
                                            .and_then(|n| n.as_str())
                                            .map(|n| n == "latest.json")
                                            .unwrap_or(false)
                                    })
                                })
                                .unwrap_or(false);

                            if has_manifest {
                                return format!(
                                    "https://github.com/{}/releases/download/{}/latest.json",
                                    DEFAULT_REPO, tag
                                );
                            }
                        }
                    }
                }
            }
        }
        // Fallback for early access channel if specific tag wasn't found
        format!("https://github.com/{}/releases/download/alpha/latest.json", DEFAULT_REPO)
    } else {
        // Stable channel: GitHub's /releases/latest endpoint
        format!(
            "https://github.com/{}/releases/latest/download/latest.json",
            DEFAULT_REPO
        )
    }
}

/// Checks for updates on a specific channel ("stable" or "early-access")
/// using Tauri's official updater plugin with cryptographic signature verification.
pub async fn check_channel_update_internal(
    webview: tauri::Webview,
    channel: String,
) -> Result<Option<UpdateMetadata>, String> {
    use tauri_plugin_updater::UpdaterExt;
    use tauri::Url;

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
        // Allow alpha/prerelease version transitions
        builder = builder.version_comparator(|current, update| update.version != current);
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

