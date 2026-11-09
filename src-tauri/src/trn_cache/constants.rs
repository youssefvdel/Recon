#![allow(dead_code)]
//! (moved verbatim from `trn_cache.rs`; split only.)



/// Header magic + version. Bumping it makes every existing entry a miss
/// (the header no longer parses) instead of a silent misread.
pub(super) const MAGIC: &str = "trn-cache-v1";

/// Extension of a committed entry. A `.tmp` file is never read back.
pub(super) const ENTRY_EXT: &str = "trn";

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
pub(super) const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// Hard cap on entry count: 100 files.
///
/// The realistic worst moment is a full 12-player lobby: 12 root profiles plus
/// up to 4 season segments each (current act + 3 pinned previous acts) is 60,
/// the local account adds 1 + 4, and the match-detail entries add ~13 — about
/// 78 held at once on a launch that does both a lobby fill and the local
/// account's enrichment. 100 leaves real headroom over that while still
/// bounding the directory, and eviction is oldest-first by the stored
/// `fetched_at`, so what leaves is the most stale thing on disk.
pub(super) const MAX_ENTRIES: usize = 100;

/// Hard cap on the WHOLE directory: 8 MiB.
///
/// The entry cap alone bounds count, not bytes: 100 x 4 MiB is a 400 MB worst
/// case, and the wave-1 audit measured an install holding ~67 MB after TRN went
/// cold. Eviction used to run only on write, and with TRN dead there are no
/// writes, so those bytes stayed forever. 8 MiB is ~3.5x the largest real body
/// measured, i.e. ample for a live session, and the rest is reclaimed.
pub(super) const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024;

/// Entries older than a week are dead weight. tracker.gg payloads only describe
/// the current act/mode window and the TS layer applies its own short TTLs on
/// top; a week keeps a vacation gap warm without pinning dead matches forever.
pub(super) const MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// Bytes read per file when scanning for eviction. The header line is
/// `<magic> <13-digit ms> <path>` and a TRN request path tops out around 160
/// chars, so 1 KB holds any of them whole; a header that does not fit is
/// treated as corrupt, which is the correct verdict anyway.
pub(super) const HEADER_PROBE: usize = 1024;

/// Ceiling on what a read will even load: one body cap plus header slack.
/// Anything bigger on disk was not written by `write_entry` (which refuses
/// over `MAX_BODY_BYTES`) — hand-placed, pre-cap, or a runaway — and is
/// corrupt by definition, so it is deleted instead of parsed.
pub(super) const MAX_READ_BYTES: usize = MAX_BODY_BYTES + HEADER_PROBE;
