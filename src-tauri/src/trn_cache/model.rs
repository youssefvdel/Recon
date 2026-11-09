#![allow(dead_code)]
//! (moved verbatim from `trn_cache.rs`; split only.)

#[cfg(test)]
use std::fs;
#[cfg(test)]
use std::path::{Path, PathBuf};

use super::constants::{ENTRY_EXT};
use super::paths::{entry_path};




use std::time::{SystemTime, UNIX_EPOCH};

/// One committed entry, as handed to `trn.ts`. The body is the raw response
/// text; the TS layer parses it exactly as it parses a wire body.
#[derive(Clone, Debug, serde::Serialize)]
pub struct TrnCacheEntry {
    /// Echoed back from the stored header. The caller already knows the path
    /// it asked for; the round trip is what proves the record is its own.
    pub path: String,
    pub body: String,
    /// Epoch ms the body was fetched, from the stored header. TS owns the TTL
    /// decision — this is the only clock fact Rust supplies.
    pub fetched_at: u64,
}

/// Outcome of a put. `stored:false` carries a human-readable `reason`: a
/// refusal is a documented result, not an error, so the caller's data path
/// continues either way.
#[derive(serde::Serialize)]
pub struct TrnCachePut {
    pub stored: bool,
    pub bytes: usize,
    pub cap: usize,
    /// Empty on success; on refusal this is the line the user sees.
    pub reason: String,
}

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The resolved on-disk file for a path, for the escape test: the key is a
/// fixed-alphabet hash, so it can never walk out of `dir` no matter what the
/// path contains.
#[cfg(test)]
/// One dashboard row: how many entries the directory holds and their bytes.
/// Committed `.trn` files only — `.tmp` files are uncommitted crash residue
/// (swept on the next put) and never counted.
#[derive(Clone, Debug, serde::Serialize)]
pub struct TrnCacheStats {
    pub files: u64,
    pub bytes: u64,
}

#[cfg(test)]
/// Sum one directory. Pure over the scan inputs — unit-tested via `scan`.
pub(super) fn stats_for(dir: &Path) -> TrnCacheStats {
    let Ok(rd) = fs::read_dir(dir) else {
        return TrnCacheStats { files: 0, bytes: 0 };
    };
    let mut files: u64 = 0;
    let mut bytes: u64 = 0;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(&format!(".{ENTRY_EXT}")) {
            continue;
        }
        files += 1;
        bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
    }
    TrnCacheStats { files, bytes }
}

#[cfg(test)]
pub(super) fn resolved_entry_path(dir: &Path, path: &str) -> PathBuf {
    entry_path(dir, path)
}
