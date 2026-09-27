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

use std::collections::VecDeque;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

use crate::trn_proxy::{TraceLine, TrnTraceLog, TRACE_RING_CAP};

/* ---- Dev trace ring: the same line shape, this module's own ring ---- *
 * See the header note: `trn_proxy`'s ring and its `trn_trace!` macro are
 * private to that file, so this is a second ring with the same
 * `[TRN <ms>] …` prefix and the same `TraceLine` payload. The dashboard polls
 * both and merges by timestamp. Defined before the call sites because a
 * `macro_rules!` is only in scope after its own definition. */
#[cfg(debug_assertions)]
macro_rules! cache_trace {
    ($($t:tt)*) => {{
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        cache_emit(format!("[TRN {}] {}", ms, format!($($t)*)));
    }};
}
#[cfg(not(debug_assertions))]
macro_rules! cache_trace {
    ($($t:tt)*) => {
        ()
    };
}

/// Never written in release (the macro is compiled out), so it allocates
/// nothing there — same shape as `trn_proxy`'s ring.
static CACHE_RING: Mutex<VecDeque<TraceLine>> = Mutex::new(VecDeque::new());
#[cfg(debug_assertions)]
static CACHE_SEQ: AtomicU64 = AtomicU64::new(0);

#[cfg(debug_assertions)]
fn cache_emit(line: String) {
    eprintln!("{line}");
    let seq = CACHE_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let Ok(mut r) = CACHE_RING.lock() else { return };
    while r.len() >= TRACE_RING_CAP {
        r.pop_front();
    }
    r.push_back(TraceLine { seq, text: line });
}

/// Header magic + version. Bumping it makes every existing entry a miss
/// (the header no longer parses) instead of a silent misread.
const MAGIC: &str = "trn-cache-v1";
/// Extension of a committed entry. A `.tmp` file is never read back.
const ENTRY_EXT: &str = "trn";

/// Hard cap on one stored body: 4 MiB.
///
/// The largest body ever measured on this install is 2,176,778 chars (a
/// competitive season segment); the root profile measured 1.27 MB. 4 MiB is
/// ~1.9x the largest observation, so no real payload ever trips it, while
/// anything that does — a proxy error page, a redirect loop, a runaway
/// response — is refused instead of pinned to disk forever. The refusal is
/// REPORTED (`CACHE refused` in the trace ring, `stored:false` + `reason` in
/// the command result): the failure mode being replaced was a swallowed
/// `QuotaExceededError`, so this one must never be silent either.
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// Hard cap on entry count: 100 files.
///
/// The realistic worst moment is a full 12-player lobby: 12 root profiles plus
/// up to 4 season segments each (current act + 3 pinned previous acts) is 60,
/// the local account adds 1 + 4, and the match-detail entries add ~13 — about
/// 78 held at once on a launch that does both a lobby fill and the local
/// account's enrichment. 100 leaves real headroom over that while still
/// bounding the directory, and eviction is oldest-first by the stored
/// `fetched_at`, so what leaves is the most stale thing on disk.
const MAX_ENTRIES: usize = 100;

/// Bytes read per file when scanning for eviction. The header line is
/// `<magic> <13-digit ms> <path>` and a TRN request path tops out around 160
/// chars, so 1 KB holds any of them whole; a header that does not fit is
/// treated as corrupt, which is the correct verdict anyway.
const HEADER_PROBE: usize = 1024;

/// Ceiling on what a read will even load: one body cap plus header slack.
/// Anything bigger on disk was not written by `write_entry` (which refuses
/// over `MAX_BODY_BYTES`) — hand-placed, pre-cap, or a runaway — and is
/// corrupt by definition, so it is deleted instead of parsed.
const MAX_READ_BYTES: usize = MAX_BODY_BYTES + HEADER_PROBE;

/// Strict path allowlist: the same rule `trn_proxy::validate_path` enforces
/// (`/api/` prefix, no whitespace, ≤300 chars). This module must never become
/// an arbitrary file read/write primitive: every command validates first, and
/// the key derivation below hashes the path (so `../../` and absolute paths
/// cannot address anything outside the cache dir — asserted by test).
fn validate_cache_path(path: &str) -> Result<(), String> {
    if path.contains([' ', '\n', '\r']) || !path.starts_with("/api/") {
        return Err("Invalid path.".to_string());
    }
    if path.len() > 300 {
        return Err("Path too long.".to_string());
    }
    Ok(())
}

/// Serialises the whole put (scan → write → evict) AND the read-modify
/// (read, maybe delete) so eviction can never race a concurrent read/write,
/// and so two puts cannot collide on a temp name. Reads hold it too: the
/// critical section is one file load, so concurrent readers still both
/// succeed — they serialise briefly, each observing one complete file or a
/// clean miss — while an eviction can never delete between a read and its
/// corrupt-file sweep.
static CACHE_LOCK: Mutex<()> = Mutex::new(());

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

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// FNV-1a 64 over the request path, hex.
///
/// Stable across runs and platforms (no dependency — `Cargo.toml` is not this
/// change's to edit, and a hash that could change with a toolchain update
/// would silently orphan every cached body), and 64 bits is far more than a
/// 100-entry key space needs: the odds of a collision are ~3e-16. A collision
/// could not serve wrong data anyway, because every read compares the stored
/// path against the requested one and a mismatch is a miss.
fn fnv1a64(bytes: &[u8]) -> u64 {
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
fn cache_key(path: &str) -> String {
    format!("{:016x}", fnv1a64(path.as_bytes()))
}

fn entry_path(dir: &Path, path: &str) -> PathBuf {
    dir.join(format!("{}.{}", cache_key(path), ENTRY_EXT))
}

struct Header {
    fetched_at: u64,
    path: String,
}

fn header_line(fetched_at: u64, path: &str) -> String {
    // `splitn(3, ' ')` below keeps the path verbatim, spaces included, so a
    // path that ever did contain one still round-trips.
    format!("{MAGIC} {fetched_at} {path}\n")
}

fn parse_header(line: &str) -> Option<Header> {
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
fn read_header(file: &Path) -> Option<Header> {
    let mut f = fs::File::open(file).ok()?;
    let mut buf = vec![0u8; HEADER_PROBE];
    let n = f.read(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);
    parse_header(text.split('\n').next()?)
}

/// Read one committed entry. `Err(reason)` is always a miss and the reason is
/// written straight into the trace line, so a corrupt cache is visible instead
/// of being quietly re-fetched forever. `MAX_READ_BYTES` bounds the load: an
/// absurd-size file is corrupt by definition (no writer of ours could have
/// produced it) and is deleted by the caller, never parsed.
fn read_entry(dir: &Path, path: &str) -> Result<TrnCacheEntry, String> {
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
fn delete_entry_file(dir: &Path, path: &str) {
    let _ = fs::remove_file(entry_path(dir, path));
}

/// The resolved on-disk file for a path, for the escape test: the key is a
/// fixed-alphabet hash, so it can never walk out of `dir` no matter what the
/// path contains.
#[cfg(test)]
fn resolved_entry_path(dir: &Path, path: &str) -> PathBuf {
    entry_path(dir, path)
}

/// Which files to drop to get back to `cap`, oldest-first by the stored
/// `fetched_at`. Pure over the scan — unit-tested without touching a disk.
fn victims(entries: &[(String, u64)], cap: usize) -> Vec<String> {
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
fn scan(dir: &Path) -> Vec<(String, u64)> {
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

/// Commit one body. Temp file in the SAME directory, then a rename over the
/// target: on Windows that is `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`, which
/// is atomic, so a crash or a power loss can only leave the previous complete
/// file or the new complete file — never a half-written body that later parses
/// as valid-but-truncated JSON. Same idiom as `accounts::store_vault`.
fn write_entry(dir: &Path, path: &str, body: &str, at: u64) -> Result<TrnCachePut, String> {
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

/// The cache's home, resolved the way every other app-scoped path in this
/// codebase resolves it (`accounts::vault_root`): `app_data_dir()` plus a
/// dedicated subdirectory.
fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "App data dir unavailable.".to_string())?
        .join("trn-cache");
    fs::create_dir_all(&dir).map_err(|e| format!("TRN cache dir unavailable: {e}"))?;
    Ok(dir)
}

/// One dashboard row: how many entries the directory holds and their bytes.
/// Committed `.trn` files only — `.tmp` files are uncommitted crash residue
/// (swept on the next put) and never counted.
#[derive(Clone, Debug, serde::Serialize)]
pub struct TrnCacheStats {
    pub files: u64,
    pub bytes: u64,
}

/// Sum one directory. Pure over the scan inputs — unit-tested via `scan`.
fn stats_for(dir: &Path) -> TrnCacheStats {
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

/// Read a cached body: `trn_cache_read { path } -> Ok(Some|None)`.
///
/// `Ok(None)` is a miss and is NOT an error: absent files, rejected paths,
/// and corrupt files (unparseable header, path mismatch, bad JSON, absurd
/// size) all answer `None` and the caller falls through to the wire. Corrupt
/// files are DELETED on the way out — re-reading the same poison on every
/// lookup would turn one bad write into a permanent miss — and the deletion
/// is traced, never silent. No TTL here: a stale entry still returns with its
/// timestamp, and `trn.ts` decides freshness.
#[tauri::command]
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
fn read_and_sweep(dir: &Path, path: &str) -> (Option<TrnCacheEntry>, Option<String>) {
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

/// Drop the oldest entries until the directory holds at most `MAX_ENTRIES`.
/// Run after a commit, so the file just written is part of the count and a
/// same-path rewrite never inflates it. Every victim is reported by the path
/// stored inside it, which is why the scan reads headers at all.
fn enforce_bound(dir: &Path) {
    for name in victims(&scan(dir), MAX_ENTRIES) {
        let victim = dir.join(&name);
        match read_header(&victim) {
            Some(h) => cache_trace!("CACHE evicted path={}", h.path),
            None => cache_trace!("CACHE evicted path=? (unreadable header)"),
        }
        let _ = fs::remove_file(&victim);
    }
}

/// Store a body: `trn_cache_write { path, body } -> Ok(())`.
///
/// LOUD refusal, never silent: a body over `MAX_BODY_BYTES` returns `Err`
/// naming the cap (the failure mode being replaced was a swallowed
/// `QuotaExceededError`), and the refusal is traced. Rejected paths are also
/// `Err` — a write must never look like it succeeded when nothing was stored.
#[tauri::command]
pub async fn trn_cache_write(
    app: tauri::AppHandle,
    path: String,
    body: String,
) -> Result<(), String> {
    validate_cache_path(&path).map_err(|e| format!("cache write rejected path: {e}"))?;
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
        return Err(out.reason);
    }
    cache_trace!("CACHE write path={} bytes={}", path, out.bytes);
    enforce_bound(&dir);
    Ok(())
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
    Ok(out)
}

/// Dashboard readout: entry count + bytes. Missing dir = zeros, never an
/// error — a cold start with no cache is the normal case.
#[tauri::command]
pub async fn trn_cache_stats(app: tauri::AppHandle) -> Result<TrnCacheStats, String> {
    let _guard = CACHE_LOCK
        .lock()
        .map_err(|_| "cache lock poisoned".to_string())?;
    let dir = match app.path().app_data_dir() {
        Ok(d) => d.join("trn-cache"),
        Err(_) => return Ok(TrnCacheStats { files: 0, bytes: 0 }),
    };
    Ok(stats_for(&dir))
}

/* ---- Dev trace log: cache lines, same cursor shape as the proxy ring ---- *
 * Release builds return an empty log (the macro is compiled out), so the panel
 * says "no lines" rather than breaking. */
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
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    /// A throwaway directory under TEMP, named per test so they cannot collide.
    fn tmp_dir(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("recon-trn-cache-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    const P: &str = "/api/v2/valorant/standard/profile/riot/lil%20ga7ed%23zngr";

    // --- key derivation ---

    #[test]
    fn key_is_stable_and_lowercase_hex() {
        assert_eq!(cache_key(P), cache_key(P));
        assert_eq!(cache_key(P).len(), 16);
        assert!(cache_key(P)
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(
            cache_key(P),
            cache_key("/api/v2/valorant/standard/profile/riot/x%23y")
        );
    }

    #[test]
    fn filename_is_legal_though_the_path_is_not() {
        let name = entry_path(Path::new("/cache"), P)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        for bad in [
            '/', '\\', '?', '&', '#', '%', ':', '*', '?', '"', '<', '>', '|',
        ] {
            assert!(!name.contains(bad), "filename {name} contains {bad}");
        }
        assert!(!name.contains(".."));
        assert!(name.ends_with(".trn"));
    }

    #[test]
    fn keys_do_not_collide_across_a_realistic_key_space() {
        let mut seen = std::collections::HashSet::new();
        for i in 0..200 {
            let p = format!("/api/v2/valorant/standard/profile/riot/player{i}%23tag{i}/segments/season?playlist=competitive&seasonId=8102cd81-{i}&source=web");
            assert!(seen.insert(cache_key(&p)), "collision at {i}");
        }
    }

    // --- atomic write path ---

    #[test]
    fn write_then_read_roundtrips() {
        let dir = tmp_dir("roundtrip");
        let body = r#"{"data":{"platformInfo":{"avatarUrl":"x"}}}"#;
        let out = write_entry(&dir, P, body, 1_700_000_000_000).expect("write");
        assert!(out.stored);
        assert_eq!(out.bytes, body.len());
        let back = read_entry(&dir, P).expect("hit");
        assert_eq!(back.path, P);
        assert_eq!(back.body, body);
        assert_eq!(back.fetched_at, 1_700_000_000_000);
    }

    #[test]
    fn commit_leaves_no_temp_file_behind() {
        let dir = tmp_dir("atomic");
        write_entry(&dir, P, "{}", 1).expect("write");
        write_entry(&dir, P, "{\"a\":1}", 2).expect("rewrite");
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec![format!("{}.trn", cache_key(P))]);
    }

    #[test]
    fn a_crash_mid_write_leaves_the_previous_entry_intact() {
        // The rename is the commit: while the temp file exists the old entry is
        // still whole, and the temp file is unreadable by name.
        let dir = tmp_dir("crash");
        write_entry(&dir, P, r#"{"v":1}"#, 1).expect("write");
        fs::write(dir.join(format!("{}.9999.tmp", cache_key(P))), r#"{"v":2}"#).expect("temp");
        assert_eq!(read_entry(&dir, P).expect("hit").body, r#"{"v":1}"#);
        // ...and the next write sweeps the orphan.
        write_entry(&dir, "/other", "{}", 2).expect("write");
        assert!(scan(&dir).iter().all(|(n, _)| !n.ends_with(".tmp")));
    }

    // --- size guard ---

    #[test]
    fn size_guard_refuses_loudly_and_stores_nothing() {
        let dir = tmp_dir("cap");
        let body = "x".repeat(MAX_BODY_BYTES + 1);
        let out = write_entry(&dir, P, &body, 1).expect("write returns a verdict, not an error");
        assert!(!out.stored);
        assert_eq!(out.bytes, MAX_BODY_BYTES + 1);
        assert_eq!(out.cap, MAX_BODY_BYTES);
        assert!(out.reason.contains("refused"), "reason was {}", out.reason);
        assert_eq!(read_entry(&dir, P).unwrap_err(), "absent");
        assert!(scan(&dir).is_empty());
    }

    #[test]
    fn size_guard_admits_the_largest_body_ever_measured() {
        let dir = tmp_dir("cap-ok");
        // 2,176,778 chars — the largest real TRN body observed on this install.
        let body = format!("{{\"pad\":\"{}\"}}", "x".repeat(2_176_778 - 10));
        assert!(body.len() < MAX_BODY_BYTES);
        assert!(write_entry(&dir, P, &body, 1).expect("write").stored);
    }

    // --- eviction ---

    #[test]
    fn victims_drops_the_oldest_first_and_only_when_over_cap() {
        let e = |v: Vec<(&str, u64)>| -> Vec<(String, u64)> {
            v.into_iter().map(|(n, at)| (n.to_string(), at)).collect()
        };
        assert!(victims(&e(vec![("a", 1), ("b", 2)]), 2).is_empty());
        assert_eq!(
            victims(&e(vec![("a", 1), ("b", 2), ("c", 3)]), 2),
            vec!["a".to_string()]
        );
        // Out-of-order stamps evict by age, not by name or scan order.
        assert_eq!(
            victims(&e(vec![("new", 30), ("old", 10), ("mid", 20)]), 1),
            vec!["old".to_string(), "mid".to_string()]
        );
        assert_eq!(victims(&[], 3).len(), 0);
    }

    #[test]
    fn directory_stays_bounded_and_keeps_the_newest() {
        let dir = tmp_dir("bound");
        for i in 0..(MAX_ENTRIES + 5) {
            write_entry(&dir, &format!("{P}#{i}"), r#"{"i":1}"#, 1_000 + i as u64).expect("write");
            enforce_bound(&dir);
        }
        let left = scan(&dir);
        assert_eq!(left.len(), MAX_ENTRIES);
        // The five oldest paths are gone; the newest is present.
        assert_eq!(read_entry(&dir, &format!("{P}#0")).unwrap_err(), "absent");
        assert!(read_entry(&dir, &format!("{P}#{}", MAX_ENTRIES + 4)).is_ok());
    }

    #[test]
    fn rewriting_an_existing_key_does_not_grow_the_directory() {
        let dir = tmp_dir("rewrite");
        for _ in 0..10 {
            write_entry(&dir, P, r#"{"v":1}"#, 2).expect("write");
        }
        assert_eq!(scan(&dir).len(), 1);
    }

    #[test]
    fn an_unreadable_entry_evicts_before_a_usable_one() {
        // No parsable header sorts as fetched_at 0, so junk is always dropped
        // before real data.
        let entries = vec![("junk".to_string(), 0u64), ("real".to_string(), 9)];
        assert_eq!(victims(&entries, 1), vec!["junk".to_string()]);
    }

    // --- corrupt-file detection (a miss, never data) ---

    #[test]
    fn truncated_body_is_a_miss() {
        let dir = tmp_dir("trunc");
        let full = r#"{"data":{"segments":[{"type":"season"}]}}"#;
        write_entry(&dir, P, full, 1).expect("write");
        // A power loss mid-body leaves the header intact and the JSON short.
        let file = entry_path(&dir, P);
        let raw = fs::read_to_string(&file).expect("read");
        fs::write(&file, &raw[..raw.len() - 12]).expect("truncate");
        let err = read_entry(&dir, P).unwrap_err();
        assert!(err.starts_with("corrupt"), "got {err}");
    }

    #[test]
    fn a_header_with_no_body_is_a_miss() {
        // A write that died between the header and the body leaves exactly
        // this: the header parses, the payload does not.
        let dir = tmp_dir("headeronly");
        write_entry(&dir, P, "{}", 1).expect("write");
        fs::write(entry_path(&dir, P), header_line(5, P)).expect("header only");
        assert_eq!(read_entry(&dir, P).unwrap_err(), "corrupt: bad json");
    }

    #[test]
    fn a_file_with_no_header_line_is_a_miss() {
        let dir = tmp_dir("nohdr");
        fs::write(entry_path(&dir, P), "{\"a\":1}").expect("write");
        assert_eq!(read_entry(&dir, P).unwrap_err(), "corrupt: no header");
    }

    #[test]
    fn a_foreign_magic_is_a_miss() {
        let dir = tmp_dir("magic");
        fs::write(entry_path(&dir, P), "trn-cache-v0 5 /api/v2/x\n{\"a\":1}").expect("write");
        assert_eq!(read_entry(&dir, P).unwrap_err(), "corrupt: header");
    }

    #[test]
    fn a_stored_path_that_does_not_match_the_key_is_a_miss() {
        // The hash is only an index; the path inside the entry is the proof.
        let dir = tmp_dir("mismatch");
        let other = "/api/v2/valorant/standard/profile/riot/someone%23else";
        write_entry(&dir, P, r#"{"a":1}"#, 1).expect("write");
        // Move someone else's body under this key.
        fs::write(
            entry_path(&dir, P),
            format!("{}{{}}", header_line(1, other)),
        )
        .expect("overwrite");
        assert_eq!(read_entry(&dir, P).unwrap_err(), "corrupt: path mismatch");
    }

    #[test]
    fn an_absent_entry_is_a_miss_not_an_error() {
        let dir = tmp_dir("absent");
        assert_eq!(read_entry(&dir, P).unwrap_err(), "absent");
    }

    // --- spec: allowlist, escape, deletion, loud refusal, stats, no-TTL ---

    #[test]
    fn cache_path_allowlist_mirrors_the_proxy_rule() {
        assert!(validate_cache_path(P).is_ok());
        assert!(validate_cache_path("/api/v2/valorant/standard/profile/riot/x%23y").is_ok());
        assert_eq!(
            validate_cache_path("https://api.tracker.gg/api/x").unwrap_err(),
            "Invalid path."
        );
        assert_eq!(
            validate_cache_path("/other/root").unwrap_err(),
            "Invalid path."
        );
        assert_eq!(
            validate_cache_path("/api/has space").unwrap_err(),
            "Invalid path."
        );
        assert_eq!(
            validate_cache_path("/api/has\nnewline").unwrap_err(),
            "Invalid path."
        );
        assert_eq!(
            validate_cache_path(&format!("/api/{}", "x".repeat(300))).unwrap_err(),
            "Path too long."
        );
    }

    #[test]
    fn traversal_and_absolute_paths_cannot_escape_the_cache_dir() {
        let dir = tmp_dir("escape");
        for evil in [
            "../../x",
            "../../../etc/passwd",
            "/abs/path",
            "C:\\Windows\\System32\\x",
            "/api/../../etc/passwd",
            "..\\..\\x",
        ] {
            let resolved = resolved_entry_path(&dir, evil);
            assert!(
                resolved.starts_with(&dir),
                "{evil} resolved to {resolved:?}, outside {dir:?}"
            );
            assert!(
                resolved.extension().is_some_and(|e| e == ENTRY_EXT),
                "{evil} resolved to {resolved:?} without the entry extension"
            );
        }
        // The resolved name is the hash, never the path text: no `..`, no
        // separator, no drive letter can survive it.
        let name = resolved_entry_path(&dir, "../../x")
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(
            !name.contains("..")
                && !name.contains('/')
                && !name.contains('\\')
                && !name.contains(':')
        );
    }

    #[test]
    fn corrupt_files_are_deleted_on_read_and_reported() {
        for (tag, poison) in [
            ("trunc", None),
            ("garbage", Some("not json at all {{{".to_string())),
        ] {
            let dir = tmp_dir(&format!("sweep-{tag}"));
            if tag == "trunc" {
                write_entry(&dir, P, r#"{"data":{"segments":[]}}"#, 1).expect("write");
                let file = entry_path(&dir, P);
                let raw = fs::read_to_string(&file).expect("read");
                fs::write(&file, &raw[..raw.len() - 8]).expect("truncate");
            } else {
                fs::write(entry_path(&dir, P), poison.clone().unwrap()).expect("poison");
            }
            assert!(entry_path(&dir, P).exists());
            let (entry, corrupt) = read_and_sweep(&dir, P);
            assert!(entry.is_none(), "corrupt file must never return data");
            assert!(corrupt.is_some(), "corrupt file must be deleted");
            assert!(!entry_path(&dir, P).exists(), "bad file left behind");
            // A second read is a plain absent miss, not a second corruption.
            let (entry2, corrupt2) = read_and_sweep(&dir, P);
            assert!(entry2.is_none() && corrupt2.is_none());
        }
        // Wrong path inside: same verdict, same deletion.
        let dir = tmp_dir("sweep-mismatch");
        write_entry(&dir, P, r#"{"a":1}"#, 1).expect("write");
        fs::write(
            entry_path(&dir, P),
            format!("{}{{}}", header_line(1, "/api/v2/other")),
        )
        .expect("overwrite");
        let (entry, corrupt) = read_and_sweep(&dir, P);
        assert!(entry.is_none() && corrupt.is_some());
        assert!(!entry_path(&dir, P).exists());
    }

    #[test]
    fn absurd_size_is_corrupt_and_deleted_without_parsing() {
        let dir = tmp_dir("absurd");
        // Hand-placed, bigger than anything `write_entry` could produce.
        let big = format!("{}{}", header_line(1, P), "x".repeat(MAX_READ_BYTES + 1));
        fs::write(entry_path(&dir, P), big).expect("plant");
        let err = read_entry(&dir, P).unwrap_err();
        assert_eq!(err, "corrupt: absurd size");
        let (entry, corrupt) = read_and_sweep(&dir, P);
        assert!(entry.is_none() && corrupt.is_some());
        assert!(!entry_path(&dir, P).exists());
    }

    #[test]
    fn oversize_refusal_names_the_cap_loudly() {
        let dir = tmp_dir("loud");
        let body = "x".repeat(MAX_BODY_BYTES + 1);
        let out = write_entry(&dir, P, &body, 1).expect("verdict, not error");
        assert!(!out.stored);
        assert!(
            out.reason.contains("MAX_BODY_BYTES"),
            "reason was {}",
            out.reason
        );
        assert!(
            out.reason.contains(&MAX_BODY_BYTES.to_string()),
            "reason was {}",
            out.reason
        );
        assert!(out.reason.contains("refused"), "reason was {}", out.reason);
        // Nothing stored, no temp file left behind (atomic: no partial file).
        assert_eq!(read_entry(&dir, P).unwrap_err(), "absent");
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(names.is_empty(), "leftovers: {names:?}");
    }

    #[test]
    fn roundtrip_preserves_exact_body_and_timestamp() {
        let dir = tmp_dir("exact");
        let body = "{\"data\":{\"segments\":[{\"type\":\"season\",\"stats\":{\"kills\":{\"value\":42}}}]}}";
        write_entry(&dir, P, body, 1_234_567_890_123).expect("write");
        let back = read_entry(&dir, P).expect("hit");
        assert_eq!(back.body, body);
        assert_eq!(back.body.len(), body.len());
        assert_eq!(back.fetched_at, 1_234_567_890_123);
        assert_eq!(back.path, P);
    }

    #[test]
    fn stale_entries_still_return_with_their_timestamp() {
        // TTL lives in TS: Rust returns even an ancient entry verbatim, and
        // the caller decides. A 400-day-old stamp is still a hit here.
        let dir = tmp_dir("stale");
        let ancient = 1_000_000_000_000u64;
        write_entry(&dir, P, r#"{"a":1}"#, ancient).expect("write");
        let back = read_entry(&dir, P).expect("stale must still return");
        assert_eq!(back.fetched_at, ancient);
        assert_eq!(back.body, r#"{"a":1}"#);
    }

    #[test]
    fn concurrent_reads_of_the_same_key_both_succeed() {
        let dir = tmp_dir("sameread");
        let body = r#"{"data":{"v":7}}"#;
        write_entry(&dir, P, body, 9_999).expect("write");
        std::thread::scope(|s| {
            let mut handles = Vec::new();
            for _ in 0..16 {
                let dir = dir.clone();
                handles.push(s.spawn(move || {
                    for _ in 0..50 {
                        let e = read_entry(&dir, P).expect("concurrent read must succeed");
                        assert_eq!(e.body, body);
                        assert_eq!(e.fetched_at, 9_999);
                    }
                }));
            }
            for h in handles {
                h.join().expect("thread");
            }
        });
    }

    #[test]
    fn stats_counts_only_committed_entries() {
        let dir = tmp_dir("stats");
        assert_eq!(stats_for(&dir).files, 0);
        assert_eq!(stats_for(&dir).bytes, 0);
        write_entry(&dir, P, r#"{"a":1}"#, 1).expect("write");
        write_entry(&dir, "/api/v2/second", r#"{"b":2}"#, 2).expect("write");
        // Uncommitted crash residue is never counted.
        fs::write(dir.join("orphan.9999.tmp"), "junk").expect("temp");
        fs::write(dir.join("notes.txt"), "junk").expect("foreign");
        let s = stats_for(&dir);
        assert_eq!(s.files, 2, "only .{ENTRY_EXT} files count");
        let expect: u64 = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .ends_with(&format!(".{ENTRY_EXT}"))
            })
            .map(|e| e.metadata().map(|m| m.len()).unwrap_or(0))
            .sum();
        assert_eq!(s.bytes, expect);
        // Missing dir = zeros, never an error.
        let gone = tmp_dir("stats-gone");
        fs::remove_dir_all(&gone).expect("remove");
        assert_eq!(stats_for(&gone).files, 0);
        assert_eq!(stats_for(&gone).bytes, 0);
    }

    // --- concurrency ---

    #[test]
    fn concurrent_readers_and_writers_never_see_a_partial_entry() {
        let dir = tmp_dir("concurrent");
        let body = format!("{{\"pad\":\"{}\"}}", "x".repeat(200_000));
        std::thread::scope(|s| {
            for w in 0..8 {
                let dir = dir.clone();
                let body = body.clone();
                s.spawn(move || {
                    for i in 0..6 {
                        write_entry(&dir, &format!("{P}#w{w}-{i}"), &body, 1_000 + i)
                            .expect("write under contention");
                    }
                });
            }
            for _ in 0..4 {
                let dir = dir.clone();
                let want = body.clone();
                s.spawn(move || {
                    for _ in 0..40 {
                        for w in 0..8 {
                            if let Ok(e) = read_entry(&dir, &format!("{P}#w{w}-0")) {
                                // Whatever is read must be the WHOLE body, and
                                // the only whole body there is.
                                assert_eq!(e.body, want);
                            }
                        }
                    }
                });
            }
        });
        assert_eq!(scan(&dir).len(), 48);
    }

    // --- trace ring ---

    #[test]
    fn trace_log_answers_incrementally_and_never_throws() {
        cache_emit_line_for_test("[TRN 1] CACHE hit path=/x");
        let first = trn_cache_trace_log(None).expect("log");
        assert!(!first.lines.is_empty());
        let head = first.head;
        assert_eq!(trn_cache_trace_log(Some(head)).expect("log").lines.len(), 0);
        assert!(!trn_cache_trace_log(None).expect("log").missed);
    }

    #[cfg(debug_assertions)]
    fn cache_emit_line_for_test(line: &str) {
        cache_emit(line.to_string());
    }
    #[cfg(not(debug_assertions))]
    fn cache_emit_line_for_test(_line: &str) {}
}
