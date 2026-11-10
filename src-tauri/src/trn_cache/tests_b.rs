#![allow(dead_code)]
//! Tests moved verbatim from the former inline `mod tests`.
#[cfg(debug_assertions)]
use super::trace::cache_emit;
use super::constants::{ENTRY_EXT, MAX_READ_BYTES};
use super::model::{resolved_entry_path, stats_for};
use super::paths::{entry_path, header_line};
use super::read::{read_and_sweep};
use super::store::{read_entry};
use super::sweep::{scan};
use super::tests_a::{P, tmp_dir};

use super::*;
use std::fs;
use std::path::Path;

#[test]
pub(super) fn a_file_with_no_header_line_is_a_miss() {
    let dir = tmp_dir("nohdr");
    fs::write(entry_path(&dir, P), "{\"a\":1}").expect("write");
    assert_eq!(read_entry(&dir, P).unwrap_err(), "corrupt: no header");
}

#[test]
pub(super) fn a_foreign_magic_is_a_miss() {
    let dir = tmp_dir("magic");
    fs::write(entry_path(&dir, P), "trn-cache-v0 5 /api/v2/x\n{\"a\":1}").expect("write");
    assert_eq!(read_entry(&dir, P).unwrap_err(), "corrupt: header");
}

#[test]
pub(super) fn a_stored_path_that_does_not_match_the_key_is_a_miss() {
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
pub(super) fn an_absent_entry_is_a_miss_not_an_error() {
    let dir = tmp_dir("absent");
    assert_eq!(read_entry(&dir, P).unwrap_err(), "absent");
}

// --- spec: allowlist, escape, deletion, loud refusal, stats, no-TTL ---

#[test]
pub(super) fn cache_path_allowlist_mirrors_the_proxy_rule() {
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
pub(super) fn traversal_and_absolute_paths_cannot_escape_the_cache_dir() {
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
pub(super) fn corrupt_files_are_deleted_on_read_and_reported() {
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
pub(super) fn absurd_size_is_corrupt_and_deleted_without_parsing() {
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
pub(super) fn oversize_refusal_names_the_cap_loudly() {
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
pub(super) fn roundtrip_preserves_exact_body_and_timestamp() {
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
pub(super) fn stale_entries_still_return_with_their_timestamp() {
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
pub(super) fn concurrent_reads_of_the_same_key_both_succeed() {
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
pub(super) fn stats_counts_only_committed_entries() {
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
pub(super) fn concurrent_readers_and_writers_never_see_a_partial_entry() {
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
pub(super) fn trace_log_answers_incrementally_and_never_throws() {
    cache_emit_line_for_test("[TRN 1] CACHE hit path=/x");
    let first = trn_cache_trace_log(None).expect("log");
    assert!(!first.lines.is_empty());
    let head = first.head;
    assert_eq!(trn_cache_trace_log(Some(head)).expect("log").lines.len(), 0);
    assert!(!trn_cache_trace_log(None).expect("log").missed);
}

#[cfg(debug_assertions)]
pub(super) fn cache_emit_line_for_test(line: &str) {
    cache_emit(line.to_string());
}
#[cfg(not(debug_assertions))]
pub(super) fn cache_emit_line_for_test(_line: &str) {}
