#![allow(dead_code)]
//! (moved verbatim from `trn_cache.rs`; split only.)
use super::constants::{ENTRY_EXT, HEADER_PROBE, MAGIC};

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Strict path allowlist: the same rule `trn_proxy::validate_path` enforces
/// (`/api/` prefix, no whitespace, ≤300 chars). This module must never become
/// an arbitrary file read/write primitive: every command validates first, and
/// the key derivation below hashes the path (so `../../` and absolute paths
/// cannot address anything outside the cache dir — asserted by test).
pub(super) fn validate_cache_path(path: &str) -> Result<(), String> {
    if path.contains([' ', '\n', '\r']) || !path.starts_with("/api/") {
        return Err("Invalid path.".to_string());
    }
    if path.len() > 300 {
        return Err("Path too long.".to_string());
    }
    Ok(())
}

/// FNV-1a 64 over the request path, hex.
///
/// Stable across runs and platforms (no dependency — `Cargo.toml` is not this
/// change's to edit, and a hash that could change with a toolchain update
/// would silently orphan every cached body), and 64 bits is far more than a
/// 100-entry key space needs: the odds of a collision are ~3e-16. A collision
/// could not serve wrong data anyway, because every read compares the stored
/// path against the requested one and a mismatch is a miss.
pub(super) fn fnv1a64(bytes: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut h = OFFSET;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(PRIME);
    }
    h
}

/// The on-disk key for a request path: 16 lowercase hex chars, so it is a
/// legal filename on every filesystem this app can land on.
pub(super) fn cache_key(path: &str) -> String {
    format!("{:016x}", fnv1a64(path.as_bytes()))
}

pub(super) fn entry_path(dir: &Path, path: &str) -> PathBuf {
    dir.join(format!("{}.{}", cache_key(path), ENTRY_EXT))
}

pub(super) struct Header {
    pub(super) fetched_at: u64,
    pub(super) path: String,
}

pub(super) fn header_line(fetched_at: u64, path: &str) -> String {
    // `splitn(3, ' ')` below keeps the path verbatim, spaces included, so a
    // path that ever did contain one still round-trips.
    format!("{MAGIC} {fetched_at} {path}\n")
}

pub(super) fn parse_header(line: &str) -> Option<Header> {
    let mut it = line.splitn(3, ' ');
    if it.next()? != MAGIC {
        return None;
    }
    let fetched_at = it.next()?.parse::<u64>().ok()?;
    let path = it.next()?;
    if path.is_empty() {
        return None;
    }
    Some(Header {
        fetched_at,
        path: path.to_string(),
    })
}

/// The header of one entry, read without touching the body. `None` = missing,
/// unreadable, or a header that does not parse — all three are worthless to
/// the scan, which treats them as the oldest thing on disk.
pub(super) fn read_header(file: &Path) -> Option<Header> {
    let mut f = fs::File::open(file).ok()?;
    let mut buf = vec![0u8; HEADER_PROBE];
    let n = f.read(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);
    parse_header(text.split('\n').next()?)
}
