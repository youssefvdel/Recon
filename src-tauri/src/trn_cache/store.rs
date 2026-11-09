#![allow(dead_code)]
//! (moved verbatim from `trn_cache.rs`; split only.)
use super::constants::{MAX_BODY_BYTES, MAX_READ_BYTES};
use super::model::{TrnCacheEntry, TrnCachePut};
use super::paths::{cache_key, entry_path, header_line, parse_header};

use std::fs;
use std::path::{Path};
use std::sync::Mutex;

/// Serialises the whole put (scan → write → evict) AND the read-modify
/// (read, maybe delete) so eviction can never race a concurrent read/write,
/// and so two puts cannot collide on a temp name. Reads hold it too: the
/// critical section is one file load, so concurrent readers still both
/// succeed — they serialise briefly, each observing one complete file or a
/// clean miss — while an eviction can never delete between a read and its
/// corrupt-file sweep.
pub(super) static CACHE_LOCK: Mutex<()> = Mutex::new(());

/// Read one committed entry. `Err(reason)` is always a miss and the reason is
/// written straight into the trace line, so a corrupt cache is visible instead
/// of being quietly re-fetched forever. `MAX_READ_BYTES` bounds the load: an
/// absurd-size file is corrupt by definition (no writer of ours could have
/// produced it) and is deleted by the caller, never parsed.
pub(super) fn read_entry(dir: &Path, path: &str) -> Result<TrnCacheEntry, String> {
    let file = entry_path(dir, path);
    let meta = fs::metadata(&file).map_err(|_| "absent".to_string())?;
    if meta.len() as usize > MAX_READ_BYTES {
        return Err("corrupt: absurd size".to_string());
    }
    let raw = fs::read_to_string(&file).map_err(|_| "absent".to_string())?;
    let (head, body) = raw
        .split_once('\n')
        .ok_or_else(|| "corrupt: no header".to_string())?;
    let h = parse_header(head).ok_or_else(|| "corrupt: header".to_string())?;
    if h.path != path {
        return Err("corrupt: path mismatch".to_string());
    }
    if serde_json::from_str::<serde_json::Value>(body).is_err() {
        return Err("corrupt: bad json".to_string());
    }
    Ok(TrnCacheEntry {
        path: h.path,
        body: body.to_string(),
        fetched_at: h.fetched_at,
    })
}

/// Delete one committed entry. Called for corrupt files (unparseable header,
/// path mismatch, bad JSON, absurd size): a corrupt cache is worse than no
/// cache, and re-reading the same poison on every lookup would turn a miss
/// into a permanent one. Never silent — the caller traces the deletion.
pub(super) fn delete_entry_file(dir: &Path, path: &str) {
    let _ = fs::remove_file(entry_path(dir, path));
}

/// Commit one body. Temp file in the SAME directory, then a rename over the
/// target: on Windows that is `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`, which
/// is atomic, so a crash or a power loss can only leave the previous complete
/// file or the new complete file — never a half-written body that later parses
/// as valid-but-truncated JSON. Same idiom as `accounts::store_vault`.
pub(super) fn write_entry(dir: &Path, path: &str, body: &str, at: u64) -> Result<TrnCachePut, String> {
    let bytes = body.len();
    if bytes > MAX_BODY_BYTES {
        return Ok(TrnCachePut {
            stored: false,
            bytes,
            cap: MAX_BODY_BYTES,
            reason: format!("CACHE REFUSED: body {bytes} bytes is over the MAX_BODY_BYTES cap ({MAX_BODY_BYTES} bytes) — refused, nothing stored"),
        });
    }
    let target = entry_path(dir, path);
    let tmp = dir.join(format!("{}.{}.tmp", cache_key(path), std::process::id()));
    let blob = format!("{}{}", header_line(at, path), body);
    let file = fs::File::create(&tmp).map_err(|e| format!("cache write failed: {e}"))?;
    let write_out: Result<(), String> = (|| {
        use std::io::Write;
        let mut f = file;
        f.write_all(blob.as_bytes())
            .map_err(|e| format!("cache write failed: {e}"))?;
        // Durability: a crash between write and rename must not lose the
        // bytes the OS still holds in its buffers — fsync before the commit.
        f.sync_all()
            .map_err(|e| format!("cache write failed: {e}"))?;
        Ok(())
    })();
    if let Err(e) = write_out {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("cache rename failed: {e}"));
    }
    Ok(TrnCachePut {
        stored: true,
        bytes,
        cap: MAX_BODY_BYTES,
        reason: String::new(),
    })
}
