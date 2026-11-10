#![allow(dead_code)]
//! (moved verbatim from `trn_cache.rs`; split only.)
#[cfg(debug_assertions)]
use super::trace::cache_emit;
use super::constants::{ENTRY_EXT, MAX_AGE_MS, MAX_ENTRIES, MAX_TOTAL_BYTES};
use super::model::{now_ms};
use super::paths::{read_header};

use std::fs;
use std::path::{Path};

/// Which files to drop to get back to `cap`, oldest-first by the stored
/// `fetched_at`. Pure over the scan — unit-tested without touching a disk.
pub(super) fn victims(entries: &[(String, u64)], cap: usize) -> Vec<String> {
    let mut sorted: Vec<&(String, u64)> = entries.iter().collect();
    sorted.sort_by_key(|(_, at)| *at);
    let over = entries.len().saturating_sub(cap);
    sorted
        .into_iter()
        .take(over)
        .map(|(n, _)| n.clone())
        .collect()
}

/// Every committed entry in the directory as `(filename, fetched_at)`, plus a
/// sweep of any `.tmp` a crash left behind (a rename that never ran). The temp
/// files are never read, so without this a hard kill would leak 1.7 MB per
/// interrupted write.
pub(super) fn scan(dir: &Path) -> Vec<(String, u64)> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<(String, u64)> = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with(".tmp") {
            // A deletion must never be silent in a store whose whole point is
            // "fetch once, keep it": an interrupted write is a fact the trace
            // has to show, and this is the only place a file is ever removed
            // outside eviction.
            let _ = fs::remove_file(e.path());
            cache_trace!("CACHE swept path=? name={name} (temp from an interrupted write)");
            continue;
        }
        if !name.ends_with(&format!(".{ENTRY_EXT}")) {
            continue;
        }
        out.push((
            name,
            read_header(&e.path()).map(|h| h.fetched_at).unwrap_or(0),
        ));
    }
    out
}

/// Which entries the age/total sweep removes: everything past `max_age_ms`,
/// then oldest-first until the survivors fit `max_total_bytes`. Newest data
/// wins; the returned names are all deleted. Pure over the scan — unit-tested.
pub(super) fn over_age_or_total_victims(
    entries: &[(String, u64, u64)], // (filename, fetched_at, bytes)
    now: u64,
    max_age_ms: u64,
    max_total_bytes: u64,
) -> Vec<String> {
    let fresh = |at: &u64| now.saturating_sub(*at) <= max_age_ms;
    let mut victims: Vec<String> = entries
        .iter()
        .filter(|(_, at, _)| !fresh(at))
        .map(|(n, _, _)| n.clone())
        .collect();
    let mut kept: Vec<&(String, u64, u64)> = entries.iter().filter(|(_, at, _)| fresh(at)).collect();
    kept.sort_by_key(|(_, at, _)| *at); // oldest first
    let mut total: u64 = kept.iter().map(|(_, _, b)| *b).sum();
    for (name, _, bytes) in kept {
        if total <= max_total_bytes {
            break;
        }
        victims.push(name.clone());
        total = total.saturating_sub(*bytes);
    }
    victims
}

/// Scan with each entry's byte size, for the age/total sweep.
pub(super) fn scan_sized(dir: &Path) -> Vec<(String, u64, u64)> {
    scan(dir)
        .into_iter()
        .map(|(name, at)| {
            let bytes = fs::metadata(dir.join(&name)).map(|m| m.len()).unwrap_or(0);
            (name, at, bytes)
        })
        .collect()
}

/// Apply the age and total-bytes bounds, tracing every victim.
pub(super) fn enforce_age_and_total(dir: &Path) {
    for name in over_age_or_total_victims(&scan_sized(dir), now_ms(), MAX_AGE_MS, MAX_TOTAL_BYTES)
    {
        let victim = dir.join(&name);
        match read_header(&victim) {
            Some(h) => cache_trace!("CACHE swept path={} reason=age-or-total", h.path),
            None => cache_trace!("CACHE swept path=? reason=age-or-total (unreadable header)"),
        }
        let _ = fs::remove_file(&victim);
    }
}

/// Run the age/total sweep once per process on the first cache read.
///
/// This is the fix for the audit's dead-cache finding: eviction ran only on
/// write, so a cold TRN left tens of MB untouched forever. Reads are the one
/// thing that still happens on every refresh, so the reclaim hangs off the first
/// one and costs a single directory scan per session.
pub(super) static AGE_TOTAL_SWEEP: std::sync::Once = std::sync::Once::new();

/// Drop the oldest entries until the directory holds at most `MAX_ENTRIES`.
/// Run after a commit, so the file just written is part of the count and a
/// same-path rewrite never inflates it. Every victim is reported by the path
/// stored inside it, which is why the scan reads headers at all.
pub(super) fn enforce_bound(dir: &Path) {
    for name in victims(&scan(dir), MAX_ENTRIES) {
        let victim = dir.join(&name);
        match read_header(&victim) {
            Some(h) => cache_trace!("CACHE evicted path={}", h.path),
            None => cache_trace!("CACHE evicted path=? (unreadable header)"),
        }
        let _ = fs::remove_file(&victim);
    }
}
