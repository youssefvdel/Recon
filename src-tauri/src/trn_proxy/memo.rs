#![allow(dead_code)]
//! (moved verbatim from `trn_proxy.rs`; split only.)

use std::sync::Mutex;
/* ---- Shared response memo: the cross-realm duplicate costs no wire ---- *
 * `main` and `overlay` both run the same fill at the same time, and the
 * in-realm `trnInFlightLive` dedup cannot see the other realm, so EVERY
 * lobby fill was fetched twice — 2x the volume for identical bytes. TS
 * caches (`profileCache`, `seasonSegCache`) are per-realm for the same
 * reason. This is the shared copy: an identical path answered within
 * `TRN_MEMO_TTL_MS` is replayed from memory, touching neither the network
 * nor the page (so it also skips the pause gate — strictly better for FPS).
 * TRN stats only move when a match ends, so a short replay is invisible;
 * only 2xx bodies are memoized, so a 429/451/404 never short-circuits the
 * ladder or the negative registry. */
pub(super) const TRN_MEMO_TTL_MS: u64 = 10 * 1000;

/// Distinct paths a single 10s window can hold. Two realms interleave the
/// same fill, so a live window sees one entry per in-flight player — 64 is
/// ~5 full 12-player lobbies of slack, and it keeps this map bounded too.
pub(super) const TRN_MEMO_MAX: usize = 64;

pub(super) struct MemoEntry {
    at_ms: u64,
    body: String,
}

pub(super) static TRN_MEMO: Mutex<Vec<(String, MemoEntry)>> = Mutex::new(Vec::new());

/// A memoized body for this exact path, if it is still fresh. `now` is
/// injected so the TTL is testable.
pub(super) fn memo_get(path: &str, now: u64) -> Option<String> {
    let mut m = TRN_MEMO.lock().ok()?;
    if let Some(i) = m.iter().position(|(p, _)| p == path) {
        if now.saturating_sub(m[i].1.at_ms) < TRN_MEMO_TTL_MS {
            return Some(m[i].1.body.clone());
        }
        m.remove(i);
    }
    None
}

/// Remember a 2xx body, oldest-first eviction past `TRN_MEMO_MAX`.
pub(super) fn memo_put(path: &str, body: String, now: u64) {
    let Ok(mut m) = TRN_MEMO.lock() else { return };
    m.retain(|(p, _)| p != path);
    m.push((path.to_string(), MemoEntry { at_ms: now, body }));
    while m.len() > TRN_MEMO_MAX {
        let oldest = m
            .iter()
            .enumerate()
            .min_by_key(|(_, (_, e))| e.at_ms)
            .map(|(i, _)| i)
            .unwrap_or(0);
        m.remove(oldest);
    }
}
