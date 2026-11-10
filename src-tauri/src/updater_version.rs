//! Pure updater maths: version ordering and channel/endpoint resolution.
//!
//! Extracted from `updater.rs` by moving code only. No network, no Tauri, no
//! Windows: `resolve_endpoint_with` takes the fetcher as a closure, so tests can
//! drive the release list and `releases/latest` with fixtures. The production
//! wrapper (`updater::resolve_channel_endpoint`) passes `github_json`.

use std::cmp::Ordering;

pub(crate) fn parse_version(tag: &str) -> Option<semver::Version> {
    semver::Version::parse(tag.trim().trim_start_matches('v')).ok()
}

/// Compare two release tags. `None` when either side is not a version — callers
/// treat that as "not an upgrade", never as a match.
pub(crate) fn cmp_versions(a: &str, b: &str) -> Option<Ordering> {
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

pub(crate) fn cmp_prerelease(a: &semver::Prerelease, b: &semver::Prerelease) -> Ordering {
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
pub(crate) fn cmp_identifier(x: &str, y: &str) -> Ordering {
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
pub(crate) fn cmp_numeric(x: &str, y: &str) -> Ordering {
    x.len().cmp(&y.len()).then_with(|| x.cmp(y))
}

/// Lexical comparison with digit runs treated as numbers ("alpha9" < "alpha10").
pub(crate) fn cmp_natural(x: &str, y: &str) -> Ordering {
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

pub(crate) fn take_digits(it: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
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

/// Does this release ship a signed `latest.json` asset?
pub(crate) fn has_latest_manifest(rel: &serde_json::Value) -> bool {
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
pub(crate) fn pick_highest_manifest_tag(releases: &[serde_json::Value]) -> Option<&str> {
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
pub(crate) fn pick_endpoint_tag<'a>(
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

// ---------------------------------------------------------------------------
// Channel maths and URL shapes
// ---------------------------------------------------------------------------

pub const DEFAULT_REPO: &str = "youssefvdel/Recon";

/// Which channel name selects the early-access endpoint. Case-insensitive;
/// every other channel is stable.
pub(crate) fn is_early_access_channel(channel: &str) -> bool {
    let ch = channel.to_lowercase();
    ch == "early-access" || ch == "early_access" || ch == "alpha" || ch == "beta"
}

fn stable_endpoint() -> String {
    format!(
        "https://github.com/{}/releases/latest/download/latest.json",
        DEFAULT_REPO
    )
}

fn alpha_list_url() -> String {
    // 10 per page: wide enough that a stale head still leaves the real newest
    // in the window on channels that ship several builds a day.
    format!("https://api.github.com/repos/{}/releases?per_page=10", DEFAULT_REPO)
}

fn alpha_latest_url() -> String {
    format!("https://api.github.com/repos/{}/releases/latest", DEFAULT_REPO)
}

fn alpha_manifest_url(tag: &str) -> String {
    format!(
        "https://github.com/{}/releases/download/{}/latest.json",
        DEFAULT_REPO, tag
    )
}

fn alpha_fallback_endpoint() -> String {
    format!(
        "https://github.com/{}/releases/download/alpha/latest.json",
        DEFAULT_REPO
    )
}

/// Resolve the manifest endpoint with the network injected, so the channel
/// maths and tag picking are testable without a request.
pub(crate) fn resolve_endpoint_with<F>(channel: &str, fetch: F) -> String
where
    F: Fn(&str) -> Option<serde_json::Value>,
{
    if !is_early_access_channel(channel) {
        return stable_endpoint();
    }
    let releases = fetch(&alpha_list_url())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    let latest = fetch(&alpha_latest_url());
    if let Some(tag) = pick_endpoint_tag(&releases, latest.as_ref()) {
        return alpha_manifest_url(tag);
    }
    // Nothing usable from the API: keep the floating ref as last resort.
    alpha_fallback_endpoint()
}
