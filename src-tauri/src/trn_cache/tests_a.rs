#![allow(dead_code)]
//! Tests moved verbatim from the former inline `mod tests`.
use super::constants::{MAX_AGE_MS, MAX_ENTRIES, MAX_TOTAL_BYTES};
use super::paths::{cache_key, entry_path, header_line};
use super::store::{read_entry};
use super::sweep::{over_age_or_total_victims, scan, victims};

use super::*;
use std::fs;
use std::path::PathBuf;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};


pub(super) static SEQ: AtomicUsize = AtomicUsize::new(0);

/// A throwaway directory under TEMP, named per test so they cannot collide.
pub(super) fn tmp_dir(tag: &str) -> PathBuf {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir =
        std::env::temp_dir().join(format!("recon-trn-cache-{tag}-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

pub(super) const P: &str = "/api/v2/valorant/standard/profile/riot/lil%20ga7ed%23zngr";

// --- key derivation ---

#[test]
pub(super) fn key_is_stable_and_lowercase_hex() {
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
pub(super) fn filename_is_legal_though_the_path_is_not() {
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
pub(super) fn keys_do_not_collide_across_a_realistic_key_space() {
    let mut seen = std::collections::HashSet::new();
    for i in 0..200 {
        let p = format!("/api/v2/valorant/standard/profile/riot/player{i}%23tag{i}/segments/season?playlist=competitive&seasonId=8102cd81-{i}&source=web");
        assert!(seen.insert(cache_key(&p)), "collision at {i}");
    }
}

// --- atomic write path ---

#[test]
pub(super) fn write_then_read_roundtrips() {
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
pub(super) fn commit_leaves_no_temp_file_behind() {
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
pub(super) fn a_crash_mid_write_leaves_the_previous_entry_intact() {
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
pub(super) fn size_guard_refuses_loudly_and_stores_nothing() {
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
pub(super) fn size_guard_admits_the_largest_body_ever_measured() {
    let dir = tmp_dir("cap-ok");
    // 2,176,778 chars — the largest real TRN body observed on this install.
    let body = format!("{{\"pad\":\"{}\"}}", "x".repeat(2_176_778 - 10));
    assert!(body.len() < MAX_BODY_BYTES);
    assert!(write_entry(&dir, P, &body, 1).expect("write").stored);
}

// --- eviction ---

#[test]
pub(super) fn victims_drops_the_oldest_first_and_only_when_over_cap() {
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
pub(super) fn age_and_total_sweep_keeps_the_newest_data() {
    let e = |v: Vec<(&str, u64, u64)>| -> Vec<(String, u64, u64)> {
        v.into_iter()
            .map(|(n, at, b)| (n.to_string(), at, b))
            .collect()
    };
    let now = 10 * MAX_AGE_MS;
    // Expired entries go regardless of how small the directory is.
    assert_eq!(
        over_age_or_total_victims(
            &e(vec![("old", 1, 10), ("new", now, 10)]),
            now,
            MAX_AGE_MS,
            MAX_TOTAL_BYTES
        ),
        vec!["old".to_string()]
    );
    // Fresh entries over the byte cap: oldest goes first, newest survives.
    assert_eq!(
        over_age_or_total_victims(
            &e(vec![("a", now - 3, 6), ("b", now - 2, 6), ("c", now - 1, 6)]),
            now,
            MAX_AGE_MS,
            12
        ),
        vec!["a".to_string()]
    );
    // Everything fits (and a zero-byte directory never trips the age line).
    assert!(over_age_or_total_victims(&e(vec![("a", now, 1)]), now, MAX_AGE_MS, 8).is_empty());
}

#[test]
pub(super) fn directory_stays_bounded_and_keeps_the_newest() {
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
pub(super) fn rewriting_an_existing_key_does_not_grow_the_directory() {
    let dir = tmp_dir("rewrite");
    for _ in 0..10 {
        write_entry(&dir, P, r#"{"v":1}"#, 2).expect("write");
    }
    assert_eq!(scan(&dir).len(), 1);
}

#[test]
pub(super) fn an_unreadable_entry_evicts_before_a_usable_one() {
    // No parsable header sorts as fetched_at 0, so junk is always dropped
    // before real data.
    let entries = vec![("junk".to_string(), 0u64), ("real".to_string(), 9)];
    assert_eq!(victims(&entries, 1), vec!["junk".to_string()]);
}

// --- corrupt-file detection (a miss, never data) ---

#[test]
pub(super) fn truncated_body_is_a_miss() {
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
pub(super) fn a_header_with_no_body_is_a_miss() {
    // A write that died between the header and the body leaves exactly
    // this: the header parses, the payload does not.
    let dir = tmp_dir("headeronly");
    write_entry(&dir, P, "{}", 1).expect("write");
    fs::write(entry_path(&dir, P), header_line(5, P)).expect("header only");
    assert_eq!(read_entry(&dir, P).unwrap_err(), "corrupt: bad json");
}
