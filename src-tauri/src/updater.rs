use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
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

fn parse_version(tag: &str) -> Option<semver::Version> {
    semver::Version::parse(tag.trim().trim_start_matches('v')).ok()
}

/// Compare two release tags. `None` when either side is not a version — callers
/// treat that as "not an upgrade", never as a match.
fn cmp_versions(a: &str, b: &str) -> Option<Ordering> {
    let a = parse_version(a)?;
    let b = parse_version(b)?;
    Some(
        a.major
            .cmp(&b.major)
            .then(a.minor.cmp(&b.minor))
            .then(a.patch.cmp(&b.patch))
            .then_with(|| cmp_prerelease(&a.pre, &b.pre)),
    )
}

/// The only question that matters: is `update` strictly newer than `current`?
pub fn is_upgrade(current: &str, update: &str) -> bool {
    matches!(cmp_versions(current, update), Some(Ordering::Less))
}

fn cmp_prerelease(a: &semver::Prerelease, b: &semver::Prerelease) -> Ordering {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => Ordering::Equal,
        // A release outranks its own prereleases: 0.5.0 > 0.5.0-alpha14.
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            let mut lhs = a.as_str().split('.');
            let mut rhs = b.as_str().split('.');
            loop {
                match (lhs.next(), rhs.next()) {
                    (None, None) => return Ordering::Equal,
                    (None, Some(_)) => return Ordering::Less,
                    (Some(_), None) => return Ordering::Greater,
                    (Some(x), Some(y)) => match cmp_identifier(x, y) {
                        Ordering::Equal => {}
                        other => return other,
                    },
                }
            }
        }
    }
}

/// One prerelease identifier. All-digit identifiers rank below alphanumeric
/// ones (semver); mixed ones compare naturally, so `alpha9 < alpha10`.
fn cmp_identifier(x: &str, y: &str) -> Ordering {
    let x_numeric = !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    let y_numeric = !y.is_empty() && y.bytes().all(|b| b.is_ascii_digit());
    match (x_numeric, y_numeric) {
        (true, true) => cmp_numeric(x, y),
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => cmp_natural(x, y),
    }
}

/// Non-negative decimal strings without leading zeros: shorter is smaller.
fn cmp_numeric(x: &str, y: &str) -> Ordering {
    x.len().cmp(&y.len()).then_with(|| x.cmp(y))
}

/// Lexical comparison with digit runs treated as numbers ("alpha9" < "alpha10").
fn cmp_natural(x: &str, y: &str) -> Ordering {
    let mut lhs = x.chars().peekable();
    let mut rhs = y.chars().peekable();
    loop {
        match (lhs.peek().copied(), rhs.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(cx), Some(cy)) => {
                if cx.is_ascii_digit() && cy.is_ascii_digit() {
                    let dx = take_digits(&mut lhs);
                    let dy = take_digits(&mut rhs);
                    match cmp_numeric(&dx, &dy) {
                        Ordering::Equal => {}
                        other => return other,
                    }
                } else {
                    if cx != cy {
                        return cx.cmp(&cy);
                    }
                    lhs.next();
                    rhs.next();
                }
            }
        }
    }
}

fn take_digits(it: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut out = String::new();
    while let Some(c) = it.peek().copied() {
        if !c.is_ascii_digit() {
            break;
        }
        out.push(c);
        it.next();
    }
    out
}

// ---------------------------------------------------------------------------
// Release picking
// ---------------------------------------------------------------------------

/// Does this release ship a signed `latest.json` asset?
fn has_latest_manifest(rel: &serde_json::Value) -> bool {
    rel.get("assets")
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
        .unwrap_or(false)
}

/// Highest tag among releases carrying a manifest. Order-independent on
/// purpose: the unauthenticated list comes back stale and shuffled (alpha9 led
/// it while alpha10 was missing entirely).
fn pick_highest_manifest_tag(releases: &[serde_json::Value]) -> Option<&str> {
    releases
        .iter()
        .filter(|rel| has_latest_manifest(rel))
        .filter_map(|rel| rel.get("tag_name").and_then(|t| t.as_str()))
        .filter(|tag| parse_version(tag).is_some())
        .max_by(|a, b| cmp_versions(a, b).unwrap_or(Ordering::Equal))
}

/// Candidate set: manifest listings ∪ `releases/latest`, max by version.
///
/// Either source alone is unsafe. The list can lag (measured: alpha10 absent,
/// alpha9 leading), and `releases/latest` skips anything flagged prerelease —
/// so the day an alpha is marked as one, it would disappear from that endpoint.
fn pick_endpoint_tag<'a>(
    releases: &'a [serde_json::Value],
    latest: Option<&'a serde_json::Value>,
) -> Option<&'a str> {
    let latest_tag = latest
        .and_then(|rel| rel.get("tag_name"))
        .and_then(|t| t.as_str())
        .filter(|tag| parse_version(tag).is_some());
    match (pick_highest_manifest_tag(releases), latest_tag) {
        (Some(from_list), Some(from_latest)) => {
            if cmp_versions(from_list, from_latest) == Some(Ordering::Less) {
                Some(from_latest)
            } else {
                Some(from_list)
            }
        }
        (Some(from_list), None) => Some(from_list),
        (None, from_latest) => from_latest,
    }
}

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
    let ch = channel.to_lowercase();
    let is_early_access =
        ch == "early-access" || ch == "early_access" || ch == "alpha" || ch == "beta";

    if is_early_access {
        // 10 per page: wide enough that a stale head still leaves the real
        // newest in the window on channels that ship several builds a day.
        let list_url = format!(
            "https://api.github.com/repos/{}/releases?per_page=10",
            DEFAULT_REPO
        );
        let latest_url = format!(
            "https://api.github.com/repos/{}/releases/latest",
            DEFAULT_REPO
        );

        let releases = github_json(&list_url)
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        let latest = github_json(&latest_url);

        if let Some(tag) = pick_endpoint_tag(&releases, latest.as_ref()) {
            return format!(
                "https://github.com/{}/releases/download/{}/latest.json",
                DEFAULT_REPO, tag
            );
        }
        // Nothing usable from the API: keep the floating ref as last resort.
        format!(
            "https://github.com/{}/releases/download/alpha/latest.json",
            DEFAULT_REPO
        )
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
    use serde_json::json;

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
