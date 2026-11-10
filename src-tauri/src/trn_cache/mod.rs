#![allow(dead_code)]
//! File-backed TRN response cache.
//!
//! Why this exists: TRN bodies are megabyte-scale — the root profile measured
//! 1.27 MB and a competitive season segment 1.72 MB (largest observed
//! 2,176,778 chars) — and they were persisted into localStorage from
//! `src/utils/trn.ts`. Measured on this install, localStorage already held
//! 4.76 MB of a ~5 MB origin quota: a 256 KiB write succeeded, a 512 KiB
//! write threw `QuotaExceededError`. Every real payload therefore threw, the
//! error was swallowed, and the persistence layer was silently dead — after
//! 40+ successful season fetches no `recon_trn_cache_v1:profile:*` or
//! `season:*` key existed, so every cold start re-fetched everything.
//! Four season segments plus a profile plus matches is ~9 MB against a ~5 MB
//! ceiling: no amount of eviction makes localStorage the right store for the
//! bodies. Files can.
//!
//! What this module owns, and what it deliberately does not:
//! - It stores RAW BODIES keyed by REQUEST PATH. The path is not a legal
//!   filename (`/ ? & # %` all appear), so it is hashed; the original path is
//!   stored inside the entry, and a read re-checks it.
//! - It knows NOTHING about freshness. The per-class TTLs (24h profile and
//!   season, 365d pinned history, 6h matches, 7d match details) are policy and
//!   stay in `trn.ts`, which reads the `fetched_at` returned with each body
//!   and decides. A line here says an entry was READ, never that it was
//!   fresh — the next `fetch start` on the same path is what says "stale".
//! - The negative registry and the cooldown ladder are KB-scale and stay in
//!   localStorage, where they already work. Only the bodies moved.
//!
//! File format: one `trn-cache-v1 <fetched_at_ms> <path>` header line, a
//! newline, then the body verbatim. A header rather than a JSON envelope is
//! what keeps eviction cheap — the bounded scan reads 1 KB per file instead of
//! 1.7 MB — and it leaves the body unescaped, so a write costs one copy.
//!
//! A read re-derives the hash, matches the stored path, and parses the body as
//! JSON; any failure is a MISS, never data. That is the whole point: a
//! silently corrupt cache is worse than no cache, which is exactly how the old
//! `MAX_SLOT_CHARS` cap in `trn_proxy.rs` served truncated JSON as a 200.
//!
//! Trace: `cache_trace!` writes the same `[TRN <ms>] …` shape as
//! `trn_proxy::trn_trace!` into a second ring of its own, served by
//! `trn_cache_trace_log`. Two rings, not one: `trn_trace!` and its ring are
//! private to `trn_proxy`, and that file is not this change's to touch. The
//! DevDashboard polls both and merges them by timestamp. The line types and
//! the push helper can collapse into `trn_proxy`'s ring the moment that file is
//! in scope.
#[cfg(debug_assertions)]
use self::trace::cache_emit;
use self::constants::{MAX_BODY_BYTES};
use self::model::{now_ms};
use self::paths::{validate_cache_path};
use self::read::{cache_dir};
use self::store::{CACHE_LOCK, write_entry};
use self::sweep::{enforce_age_and_total, enforce_bound};
use self::trace::{CACHE_RING};

use std::collections::VecDeque;



use crate::trn_proxy::{TraceLine, TrnTraceLog};

#[macro_use]
mod trace;
mod constants;
mod model;
mod paths;
mod store;
mod sweep;
mod read;

pub use model::{TrnCacheEntry, TrnCachePut};
pub use read::trn_cache_read;

/// Legacy alias for `trn_cache_read`, kept so the existing TS wiring
/// (`invoke('trn_cache_get')`) keeps working. Same contract: miss = None,
/// corrupt = None + the bad file deleted + a traced line.
#[tauri::command]
pub async fn trn_cache_get(
    app: tauri::AppHandle,
    path: String,
) -> Result<Option<TrnCacheEntry>, String> {
    trn_cache_read(app, path).await
}

/// Store a body, then bring the directory back under `MAX_ENTRIES`. The scan
/// runs after the write so the just-written file is part of the count and a
/// same-path overwrite never inflates it. Legacy shape returning the verdict;
/// `trn_cache_write` above is the loud variant the spec requires.
#[tauri::command]
pub async fn trn_cache_put(
    app: tauri::AppHandle,
    path: String,
    body: String,
) -> Result<TrnCachePut, String> {
    if validate_cache_path(&path).is_err() {
        cache_trace!("CACHE refused path=? reason=rejected-path (rejected)");
        return Ok(TrnCachePut {
            stored: false,
            bytes: body.len(),
            cap: MAX_BODY_BYTES,
            reason: format!(
                "cache write rejected path: Invalid path. (cap MAX_BODY_BYTES={MAX_BODY_BYTES})"
            ),
        });
    }
    let dir = cache_dir(&app)?;
    let _guard = CACHE_LOCK
        .lock()
        .map_err(|_| "cache lock poisoned".to_string())?;
    let out = write_entry(&dir, &path, &body, now_ms())?;
    if !out.stored {
        cache_trace!(
            "CACHE refused path={} bytes={} cap={} reason={}",
            path,
            out.bytes,
            out.cap,
            out.reason
        );
        return Ok(out);
    }
    cache_trace!("CACHE write path={} bytes={}", path, out.bytes);
    enforce_bound(&dir);
    enforce_age_and_total(&dir);
    Ok(out)
}

#[tauri::command]
pub fn trn_cache_trace_log(after: Option<u64>) -> Result<TrnTraceLog, String> {
    let buf = CACHE_RING
        .lock()
        .map_err(|e| format!("cache trace lock: {e}"))?;
    let after = after.unwrap_or(0);
    let head = buf.back().map(|l| l.seq).unwrap_or(after);
    let lines: Vec<TraceLine> = buf.iter().filter(|l| l.seq > after).cloned().collect();
    let missed = lines.first().is_some_and(|l| l.seq > after + 1);
    Ok(TrnTraceLog {
        head,
        lines,
        missed,
    })
}

#[cfg(test)]
mod tests_a;
#[cfg(test)]
mod tests_b;
