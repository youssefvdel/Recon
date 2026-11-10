#![allow(dead_code)]
//! (moved verbatim from `trn_cache.rs`; split only.)
#[cfg(debug_assertions)]
use super::trace::cache_emit;
use tauri::Manager;
use super::model::{TrnCacheEntry, now_ms};
use super::paths::{validate_cache_path};
use super::store::{CACHE_LOCK, delete_entry_file, read_entry};
use super::sweep::{AGE_TOTAL_SWEEP, enforce_age_and_total};

use std::fs;
use std::path::{Path, PathBuf};

/// The cache's home, resolved the way every other app-scoped path in this
/// codebase resolves it (`accounts::vault_root`): `app_data_dir()` plus a
/// dedicated subdirectory.
pub(super) fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "App data dir unavailable.".to_string())?
        .join("trn-cache");
    fs::create_dir_all(&dir).map_err(|e| format!("TRN cache dir unavailable: {e}"))?;
    Ok(dir)
}

/// Read a cached body: `trn_cache_read { path } -> Ok(Some|None)`.
///
/// `Ok(None)` is a miss and is NOT an error: absent files, rejected paths,
/// and corrupt files (unparseable header, path mismatch, bad JSON, absurd
/// size) all answer `None` and the caller falls through to the wire. Corrupt
/// files are DELETED on the way out — re-reading the same poison on every
/// lookup would turn one bad write into a permanent miss — and the deletion
/// is traced, never silent. No TTL here: a stale entry still returns with its
/// timestamp, and `trn.ts` decides freshness.
pub async fn trn_cache_read(
    app: tauri::AppHandle,
    path: String,
) -> Result<Option<TrnCacheEntry>, String> {
    // The key derivation makes escape impossible (hash, not the path), but a
    // rejected path is still a miss at the gate: belt and suspenders, and it
    // keeps this from ever reading as an arbitrary-file primitive.
    if validate_cache_path(&path).is_err() {
        cache_trace!("CACHE miss path=? reason=rejected-path (rejected)");
        return Ok(None);
    }
    let dir = cache_dir(&app)?;
    // The whole read-modify (read, maybe delete) holds the module lock: an
    // eviction running concurrently must never delete the file between our
    // read and our delete, and must never delete a file a concurrent write is
    // committing. Reads of the same key still both succeed — the commit is a
    // rename, so they each observe one complete file or a clean miss.
    let _guard = CACHE_LOCK
        .lock()
        .map_err(|_| "cache lock poisoned".to_string())?;
    // Audit perf#1: reclaim dead bytes once per process, on the first read.
    // This used to be write-only, and a cold TRN writes nothing.
    AGE_TOTAL_SWEEP.call_once(|| enforce_age_and_total(&dir));
    // Corrupt (unparseable, path mismatch, bad JSON, absurd size): miss AND
    // delete the bad file, traced — never silent, never partial data.
    match read_and_sweep(&dir, &path) {
        (Some(e), None) => {
            let age = now_ms().saturating_sub(e.fetched_at);
            cache_trace!(
                "CACHE hit path={} age_ms={} bytes={}",
                path,
                age,
                e.body.len()
            );
            Ok(Some(e))
        }
        (None, None) => {
            cache_trace!("CACHE miss path={path} reason=absent");
            Ok(None)
        }
        (None, Some(reason)) => {
            cache_trace!("CACHE miss path={path} reason={reason} (deleted)");
            Ok(None)
        }
        (Some(_), Some(_)) => Ok(None),
    }
}

/// Read-half core shared by the command and the unit tests: read, and on
/// corrupt delete the bad file. Returns `(entry, corrupt_reason)` — `None,
/// None` is a plain absent miss, `(None, Some(reason))` is a corrupt file
/// that was just deleted, `(Some(e), None)` is a hit. The command traces
/// each arm; the tests assert the deletion.
pub(super) fn read_and_sweep(dir: &Path, path: &str) -> (Option<TrnCacheEntry>, Option<String>) {
    match read_entry(dir, path) {
        Ok(e) => (Some(e), None),
        Err(reason) => {
            if reason == "absent" {
                (None, None)
            } else {
                delete_entry_file(dir, path);
                (None, Some(reason))
            }
        }
    }
}
