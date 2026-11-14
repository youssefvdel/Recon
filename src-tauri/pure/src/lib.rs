//! Host-agnostic slice of the Recon backend.
//!
//! The production files are included **by path** — this crate never forks or
//! copies logic. It exists so the pure modules can be compiled and tested on a
//! machine without Windows, Tauri or a Riot client. Anything that imports
//! `windows`/`tauri` stays out (see `docs/architecture/host-agnostic-tests.md`).
#![allow(dead_code)]

#[path = "../../src/perf/model.rs"]
pub mod perf_model;

#[path = "../../src/trn_proxy/ceiling.rs"]
pub mod ceiling;

// `cache_paths` uses `super::constants`, so the two stay siblings here exactly
// as they are siblings in `src/trn_cache/`.
#[path = "../../src/trn_cache/constants.rs"]
pub mod constants;
#[path = "../../src/trn_cache/paths.rs"]
pub mod cache_paths;

#[path = "../../src/trn_proxy/trace.rs"]
pub mod trace;

#[path = "../../src/trn_http_rules.rs"]
pub mod trn_http_rules;

#[path = "../../src/updater_version.rs"]
pub mod updater_version;

// Copy-only directory handoff: pure `std`, so the rename-migration tests run on
// a Linux host without Tauri or Windows.
#[path = "../../src/fs_migrate.rs"]
pub mod fs_migrate;

// The app-data path rules depend only on `std`, `log` and `fs_migrate`, so the
// real `paths` module (and its migration/fallback tests) compile here too.
#[path = "../../src/paths.rs"]
pub mod app_paths;

#[cfg(test)]
mod tests {
    use crate::cache_paths::{
        cache_key, entry_path, fnv1a64, header_line, parse_header, read_header, validate_cache_path,
    };
    use crate::ceiling::{
        ceiling_allows, ceiling_refund, ceiling_refundable, Ceiling, TrnCeiling, TRN_HOURLY_MAX_REQUESTS,
        TRN_LOBBY_MAX_REQUESTS, TRN_WINDOW_MS,
    };
    use crate::perf_model::{
        cpu_delta_100ns, cpu_pct_from_deltas, mem_basis, push_sample, rollup, rollup_cpu,
        rss_mb_from_bytes, should_pause_sampling, summarize, CpuTimes, MemBasis, PerfSample, ProcMem,
        TreeMem,
    };
    use crate::trace::{trace_push, trace_since, TraceLine, TRACE_RING_CAP};
    use std::collections::VecDeque;
    use std::path::PathBuf;

    fn mem_sample(t: u64, rss: f64, cpu: f64) -> PerfSample {
        PerfSample {
            t,
            rss_mb: rss,
            webview_mb: 0.0,
            total_mb: rss,
            cpu_pct: cpu,
            cpu_processes: 1,
            cpu_omitted: 0,
            basis: MemBasis::ResidentWorkingSet,
            omitted: 0,
        }
    }

    // ---- trn_http_rules.rs: the security-relevant transport rules ----------

    use crate::trn_http_rules::{host_allowed, status_error, validate_path, MAX_PATH};

    #[test]
    fn only_the_trn_api_host_is_allowed() {
        assert!(host_allowed("api.tracker.network"));
        assert!(host_allowed("API.TRACKER.NETWORK"));
        // Suffix/prefix tricks and userinfo are not the allowlisted host.
        assert!(!host_allowed("api.tracker.network.evil.example"));
        assert!(!host_allowed("evilapi.tracker.network"));
        assert!(!host_allowed("api.tracker.network@evil.example"));
        assert!(!host_allowed("evil.example#api.tracker.network"));
        // A port never makes it a different host, but it is also never a match
        // for the exact host string the redirect check passes.
        assert!(!host_allowed("api.tracker.network:443"));
        // Scheme-relative and absolute redirect targets.
        assert!(!host_allowed("//evil.example"));
        assert!(!host_allowed("https://evil.example"));
        // Empty host can only be a parse failure, never "allowed".
        assert!(!host_allowed(""));
    }

    #[test]
    fn path_validation_rejects_anything_but_a_root_relative_path() {
        assert!(validate_path("/api/v2/valorant/standard/profile/riot/Ginger%20Tofu%231312").is_ok());
        assert!(validate_path("/api/v2/valorant/standard/matches/riot/x").is_ok());
        // Absolute URL / scheme smuggling.
        assert_eq!(validate_path("https://evil.example/api/x").unwrap_err(), "TRN_HTTP_BAD_PATH");
        assert_eq!(validate_path("//evil.example/api/x").unwrap_err(), "TRN_HTTP_BAD_PATH");
        // Traversal, in any position.
        assert!(validate_path("/api/../secrets").is_err());
        assert!(validate_path("/api/v2/..").is_err());
        assert!(validate_path("/api/./x").is_err());
        // The query string is allowed and passed through untouched: the profile
        // routes need ?source=overwolf-2 for the full payload.
        assert!(validate_path(
            "/api/v2/valorant/standard/profile/riot/Ginger%20Tofu%231312?source=overwolf-2"
        )
        .is_ok());
        assert!(validate_path("/api/v2/valorant/standard/profile/riot/x?source=overwolf-2&extra=1").is_ok());
        // ...but a query cannot smuggle a scheme or traversal.
        assert!(validate_path("/api/x?next=https://evil.example").is_err());
        assert!(validate_path("/api/x?x=..").is_err());
        // Whitespace, empty and oversized paths.
        assert!(validate_path(" /api/x").is_err());
        assert!(validate_path("/api/x y").is_err());
        assert!(validate_path("/api/x\ny").is_err());
        assert!(validate_path("").is_err());
        assert!(validate_path(&format!("/api/{}", "a".repeat(MAX_PATH))).is_err());
        // Exactly at the cap is fine.
        assert!(validate_path(&format!("/api/{}", "a".repeat(MAX_PATH - 5))).is_ok());
    }

    #[test]
    fn status_mapping_is_the_contract_ts_keys_on() {
        assert_eq!(status_error(200), None);
        assert_eq!(status_error(204), None);
        assert_eq!(status_error(299), None);
        assert_eq!(status_error(451).as_deref(), Some("TRN_PRIVATE"));
        assert_eq!(status_error(404).as_deref(), Some("TRN_NO_DATA"));
        assert_eq!(status_error(429).as_deref(), Some("TRN_RATE_LIMITED"));
        assert_eq!(status_error(403).as_deref(), Some("HTTP 403"));
        assert_eq!(status_error(500).as_deref(), Some("HTTP 500"));
        assert_eq!(status_error(302).as_deref(), Some("HTTP 302"));
    }

    // ---- updater_version.rs: version ordering and channel maths ------------

    use crate::updater_version::{
        is_early_access_channel, is_upgrade, pick_endpoint_tag, pick_highest_manifest_tag,
        resolve_endpoint_with,
    };
    use serde_json::{json, Value};

    #[test]
    fn prerelease_is_older_than_its_release() {
        // 1.0.0-beta < 1.0.0: the release is the upgrade, never the beta.
        assert!(is_upgrade("1.0.0-beta", "1.0.0"));
        assert!(!is_upgrade("1.0.0", "1.0.0-beta"));
        // Same for this repo's alpha tags.
        assert!(is_upgrade("0.5.0-alpha14", "0.5.0"));
        assert!(!is_upgrade("0.5.0", "0.5.0-alpha14"));
    }

    #[test]
    fn alpha_numbers_compare_naturally_not_lexically() {
        // String compare says "alpha10" < "alpha9" and offers the downgrade —
        // the bug this ordering exists to prevent.
        assert!(is_upgrade("0.5.0-alpha9", "0.5.0-alpha10"));
        assert!(is_upgrade("0.5.0-alpha10", "0.5.0-alpha11"));
        assert!(is_upgrade("0.5.0-alpha11", "0.5.0-alpha12"));
        assert!(!is_upgrade("0.5.0-alpha10", "0.5.0-alpha9"));
        // leading v is tolerated on either side.
        assert!(is_upgrade("v0.5.0-alpha9", "v0.5.0-alpha10"));
        assert!(is_upgrade("v0.5.0-alpha9", "0.5.0-alpha10"));
    }

    #[test]
    fn equal_and_older_versions_are_not_upgrades() {
        assert!(!is_upgrade("0.5.0-alpha10", "0.5.0-alpha10"));
        assert!(!is_upgrade("0.5.0", "0.5.0"));
        assert!(!is_upgrade("0.6.0", "0.5.9"));
        assert!(!is_upgrade("0.5.0", "0.4.9"));
        assert!(is_upgrade("0.4.9", "0.5.0"));
        assert!(is_upgrade("1.9.9", "2.0.0"));
    }

    #[test]
    fn malformed_tags_never_count_as_newer() {
        assert!(!is_upgrade("0.5.0-alpha10", "not-a-version"));
        assert!(!is_upgrade("not-a-version", "0.5.1"));
        assert!(!is_upgrade("0.5.1", ""));
        assert!(!is_upgrade("", "0.5.1"));
    }

    fn release(tag: &str, has_manifest: bool) -> Value {
        json!({
            "tag_name": tag,
            "assets": if has_manifest {
                json!([{ "name": "latest.json" }, { "name": "Recon_0.5.0_x64-setup.exe" }])
            } else {
                json!([{ "name": "Recon_0.5.0_x64-setup.exe" }])
            }
        })
    }

    #[test]
    fn picker_takes_the_highest_manifest_not_the_first() {
        let releases = vec![
            release("v0.5.0-alpha9", true),
            release("v0.5.0-alpha11", false), // no manifest: must not win
            release("v0.5.0-alpha8", true),
            release("v0.5.0-alpha10", true),
            release("not-a-version", true),
        ];
        assert_eq!(pick_highest_manifest_tag(&releases), Some("v0.5.0-alpha10"));
        assert_eq!(pick_highest_manifest_tag(&[]), None);
    }

    #[test]
    fn picker_unions_a_stale_list_with_releases_latest() {
        let latest = release("v0.5.0-alpha10", true);
        assert_eq!(pick_endpoint_tag(&[release("v0.5.0-alpha9", true)], Some(&latest)), Some("v0.5.0-alpha10"));
        assert_eq!(pick_endpoint_tag(&[], Some(&latest)), Some("v0.5.0-alpha10"));
        assert_eq!(pick_endpoint_tag(&[release("v0.5.0-alpha11", false)], Some(&latest)), Some("v0.5.0-alpha10"));
        assert_eq!(pick_endpoint_tag(&[], None), None);
        // A newer list entry beats an older latest.
        let older_latest = release("v0.5.0-alpha10", true);
        assert_eq!(
            pick_endpoint_tag(&[release("v0.5.0-alpha11", true)], Some(&older_latest)),
            Some("v0.5.0-alpha11")
        );
    }

    #[test]
    fn channel_names_are_classified_case_insensitively() {
        assert!(!is_early_access_channel("stable"));
        assert!(!is_early_access_channel("nightly"));
        for ch in ["early-access", "early_access", "alpha", "beta", "ALPHA", "Early-Access"] {
            assert!(is_early_access_channel(ch), "{ch}");
        }
    }

    #[test]
    fn stable_channel_never_touches_the_network() {
        let endpoint = resolve_endpoint_with("stable", |_| -> Option<Value> {
            panic!("stable resolution must not fetch releases");
        });
        assert_eq!(
            endpoint,
            "https://github.com/youssefvdel/Outpeek/releases/latest/download/latest.json"
        );
    }

    #[test]
    fn alpha_channel_picks_the_highest_usable_tag() {
        let endpoint = resolve_endpoint_with("alpha", |url| {
            if url.ends_with("releases?per_page=10") {
                Some(json!([
                    release("v0.5.0-alpha9", true),
                    release("v0.5.0-alpha11", false),
                    release("v0.5.0-alpha10", true)
                ]))
            } else if url.ends_with("releases/latest") {
                Some(release("v0.5.0-alpha9", true))
            } else {
                None
            }
        });
        assert_eq!(
            endpoint,
            "https://github.com/youssefvdel/Outpeek/releases/download/v0.5.0-alpha10/latest.json"
        );
    }

    #[test]
    fn alpha_channel_falls_back_when_nothing_is_usable() {
        let endpoint = resolve_endpoint_with("beta", |_| None);
        assert_eq!(
            endpoint,
            "https://github.com/youssefvdel/Outpeek/releases/download/alpha/latest.json"
        );
        // Malformed tags only: same fallback, no panic.
        let endpoint = resolve_endpoint_with("early-access", |url| {
            if url.ends_with("per_page=10") {
                Some(json!([release("garbage", true)]))
            } else {
                Some(release("also-garbage", true))
            }
        });
        assert!(endpoint.ends_with("/releases/download/alpha/latest.json"));
    }

    // ---- perf/model.rs: the numbers the dashboard renders ------------------

    #[test]
    fn cpu_percentage_is_machine_wide_and_clamped() {
        // 3_359 ms of CPU over a 5 s window on 12 cores = 5.5983…%.
        let pct = cpu_pct_from_deltas(33_590_000, 5.0, 12);
        assert!((pct - 5.598_333).abs() < 1e-4, "got {pct}");
        // A full core-second per core is 100%, never above it.
        assert_eq!(cpu_pct_from_deltas(u64::MAX, 1.0, 1), 100.0);
        // Degenerate inputs are 0, not NaN/∞.
        assert_eq!(cpu_pct_from_deltas(1_000, 0.0, 4), 0.0);
        assert_eq!(cpu_pct_from_deltas(1_000, 5.0, 0), 0.0);
    }

    #[test]
    fn cpu_delta_only_counts_pids_present_in_both_samples() {
        let mut prev = CpuTimes::new();
        prev.insert(1, 100);
        prev.insert(2, 200);
        let mut now = CpuTimes::new();
        now.insert(1, 150); // +50
        now.insert(3, 9_999); // new renderer: no baseline, contributes 0
        now.insert(2, 260); // +60
        assert_eq!(cpu_delta_100ns(&prev, &now), 110);
        // A PID that exited stops contributing; a reset counter cannot wrap.
        let mut now2 = CpuTimes::new();
        now2.insert(1, 50); // lower than before -> saturating 0
        assert_eq!(cpu_delta_100ns(&prev, &now2), 0);
    }

    #[test]
    fn cpu_census_reports_processes_and_omitted() {
        let c = rollup_cpu(Some(10), &[Some(1), None, None]);
        assert_eq!(c.processes, 4);
        assert_eq!(c.omitted, 2);
        let c = rollup_cpu(None, &[]);
        assert_eq!(c.processes, 1);
        assert_eq!(c.omitted, 1);
    }

    #[test]
    fn rss_bytes_to_mib() {
        assert_eq!(rss_mb_from_bytes(0), 0.0);
        assert_eq!(rss_mb_from_bytes(105 * 1_048_576), 105.0);
        assert!((rss_mb_from_bytes(1_500_000) - 1.430_511).abs() < 1e-5);
    }

    #[test]
    fn memory_basis_names_only_clean_reads() {
        assert_eq!(mem_basis(1, 0, 0), MemBasis::PrivateWorkingSet);
        assert_eq!(mem_basis(0, 1, 0), MemBasis::ResidentWorkingSet);
        // Any gap or mixture is Mixed: no degraded total is ever labelled clean.
        assert_eq!(mem_basis(5, 3, 0), MemBasis::Mixed);
        assert_eq!(mem_basis(1, 0, 1), MemBasis::Mixed);
        assert_eq!(mem_basis(0, 1, 1), MemBasis::Mixed);
        assert_eq!(mem_basis(0, 0, 5), MemBasis::Mixed);
        assert_eq!(mem_basis(0, 0, 0), MemBasis::Mixed);
    }

    #[test]
    fn memory_rollup_splits_own_and_webview_bytes() {
        let m = rollup(
            ProcMem::Private(10 * 1_048_576),
            &[ProcMem::ResidentFallback(5 * 1_048_576), ProcMem::Unavailable, ProcMem::Private(2 * 1_048_576)],
        );
        assert_eq!(m.own_bytes, 10 * 1_048_576);
        assert_eq!(m.webview_bytes, 7 * 1_048_576);
        assert_eq!(m.total_bytes(), 17 * 1_048_576);
        assert_eq!((m.private, m.fallback, m.omitted), (2, 1, 1));
        assert_eq!(m.basis(), MemBasis::Mixed);
    }

    #[test]
    fn memory_rollup_all_private_is_the_clean_basis() {
        let m = rollup(ProcMem::Private(1), &[ProcMem::Private(2), ProcMem::Private(3)]);
        assert_eq!(m.total_bytes(), 6);
        assert_eq!(m.basis(), MemBasis::PrivateWorkingSet);
        assert_eq!(TreeMem::default().basis(), MemBasis::Mixed);
    }

    #[test]
    fn summarize_reports_current_min_max_avg() {
        let s = summarize(&[1.0, 3.0, 2.0]);
        assert_eq!(s.current, 2.0);
        assert_eq!(s.min, 1.0);
        assert_eq!(s.max, 3.0);
        assert_eq!(s.avg, 2.0);
        let e = summarize(&[]);
        assert_eq!((e.current, e.min, e.max, e.avg), (0.0, 0.0, 0.0, 0.0));
    }

    #[test]
    fn sample_ring_evicts_oldest_and_respects_zero_cap() {
        let mut buf = VecDeque::new();
        push_sample(&mut buf, mem_sample(1, 1.0, 1.0), 2);
        push_sample(&mut buf, mem_sample(2, 2.0, 2.0), 2);
        push_sample(&mut buf, mem_sample(3, 3.0, 3.0), 2);
        assert_eq!(buf.len(), 2);
        assert_eq!(buf.front().unwrap().t, 2);
        assert_eq!(buf.back().unwrap().t, 3);
        let mut keep = VecDeque::new();
        push_sample(&mut keep, mem_sample(9, 9.0, 9.0), 0);
        assert!(keep.is_empty());
    }

    #[test]
    fn sampling_pauses_only_for_a_foreground_game() {
        assert!(should_pause_sampling(true, true));
        assert!(!should_pause_sampling(true, false));
        assert!(!should_pause_sampling(false, true));
        assert!(!should_pause_sampling(false, false));
    }

    // ---- trn_proxy/ceiling.rs: the request budget --------------------------

    fn fresh_ceiling() -> TrnCeiling {
        TrnCeiling {
            lobby: String::new(),
            lobby_spent: 0,
            window_start_ms: 0,
            window_spent: 0,
        }
    }

    #[test]
    fn lobby_ceiling_caps_one_fill_and_resets_for_a_new_match() {
        let mut c = fresh_ceiling();
        for i in 0..TRN_LOBBY_MAX_REQUESTS {
            assert_eq!(ceiling_allows(&mut c, "match-1", 1_000), Ceiling::Allow, "request {i}");
        }
        assert_eq!(ceiling_allows(&mut c, "match-1", 1_000), Ceiling::Deny("lobby"));
        // A new match id rolls the lobby counter; the window counter keeps going.
        assert_eq!(ceiling_allows(&mut c, "match-2", 1_000), Ceiling::Allow);
        assert_eq!(c.lobby_spent, 1);
        assert_eq!(c.window_spent, TRN_LOBBY_MAX_REQUESTS + 1);
    }

    #[test]
    fn hour_ceiling_is_the_hard_ceiling() {
        let mut c = fresh_ceiling();
        for _ in 0..TRN_HOURLY_MAX_REQUESTS {
            assert_eq!(ceiling_allows(&mut c, "", 1_000), Ceiling::Allow);
        }
        assert_eq!(ceiling_allows(&mut c, "", 1_000), Ceiling::Deny("hour"));
        assert_eq!(c.window_spent, TRN_HOURLY_MAX_REQUESTS);
    }

    #[test]
    fn hour_window_rolls_and_resets_the_counter() {
        let mut c = fresh_ceiling();
        for _ in 0..TRN_HOURLY_MAX_REQUESTS {
            let _ = ceiling_allows(&mut c, "", 1_000);
        }
        assert_eq!(ceiling_allows(&mut c, "", 1_000 + TRN_WINDOW_MS), Ceiling::Allow);
        assert_eq!(c.window_spent, 1);
        assert_eq!(c.window_start_ms, 1_000 + TRN_WINDOW_MS);
    }

    #[test]
    fn unkeyed_requests_are_bounded_by_the_hour_only() {
        let mut c = fresh_ceiling();
        for _ in 0..100 {
            assert_eq!(ceiling_allows(&mut c, "", 1_000), Ceiling::Allow);
        }
        assert_eq!(c.lobby_spent, 0);
        assert_eq!(c.window_spent, 100);
    }

    #[test]
    fn refunds_saturate_and_never_touch_another_lobbys_count() {
        let mut c = fresh_ceiling();
        let _ = ceiling_allows(&mut c, "m1", 1_000);
        ceiling_refund(&mut c, "m1");
        assert_eq!((c.lobby_spent, c.window_spent), (0, 0));
        ceiling_refund(&mut c, "m1"); // nothing left: must not wrap
        assert_eq!((c.lobby_spent, c.window_spent), (0, 0));
        let _ = ceiling_allows(&mut c, "m1", 1_000);
        ceiling_refund(&mut c, "m2"); // wrong lobby: window only
        assert_eq!((c.lobby_spent, c.window_spent), (1, 0));
    }

    #[test]
    fn refundable_is_one_failure_storm_allowlist() {
        assert!(!ceiling_refundable(&Ok("body".to_string())));
        assert!(ceiling_refundable(&Err("TRN_CAPTCHA_REQUIRED".to_string())));
        assert!(ceiling_refundable(&Err("EDGE_UNAVAILABLE proxy lost".to_string())));
        assert!(ceiling_refundable(&Err("EDGE_PAUSED follower gave up".to_string())));
        // Answered requests and a budget refusal were billed on purpose.
        assert!(!ceiling_refundable(&Err("HTTP 429".to_string())));
        assert!(!ceiling_refundable(&Err("TRN_BUDGET".to_string())));
    }

    // ---- trn_cache: path allowlist + on-disk header -------------------------

    #[test]
    fn cache_path_allowlist_rejects_what_cannot_be_a_request_path() {
        assert!(validate_cache_path("/api/v2/valorant/standard/profile/riot/x%23y").is_ok());
        assert_eq!(validate_cache_path("https://api/x").unwrap_err(), "Invalid path.");
        assert_eq!(validate_cache_path("/api/has space").unwrap_err(), "Invalid path.");
        assert_eq!(validate_cache_path("/api/has\nnewline").unwrap_err(), "Invalid path.");
        assert_eq!(validate_cache_path("/api/has\rcr").unwrap_err(), "Invalid path.");
        // The allowlist cap is 300 chars: exactly 300 passes, 301 does not.
        assert!(validate_cache_path(&format!("/api/{}", "x".repeat(295))).is_ok());
        assert_eq!(validate_cache_path(&format!("/api/{}", "x".repeat(296))).unwrap_err(), "Path too long.");
    }

    #[test]
    fn fnv1a64_matches_the_published_vector() {
        assert_eq!(fnv1a64(b"hello"), 0xa430_d846_80aa_bd0b);
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        let key = cache_key("/api/v2/x");
        assert_eq!(key.len(), 16);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(cache_key("/api/v2/x"), key, "stable across calls");
        assert_ne!(cache_key("/api/v2/x"), cache_key("/api/v2/y"));
    }

    #[test]
    fn entry_path_stays_inside_the_cache_dir() {
        let dir = PathBuf::from("/tmp/cache-root");
        let p = entry_path(&dir, "/api/../../etc/passwd");
        assert_eq!(p.parent().unwrap(), dir);
        assert!(p.file_name().unwrap().to_string_lossy().ends_with(".trn"));
    }

    #[test]
    fn header_round_trips_a_path_with_spaces() {
        let line = header_line(1_700_000_000_123, "/api/v2/a b");
        let h = parse_header(line.trim_end_matches('\n')).expect("header");
        assert_eq!(h.fetched_at, 1_700_000_000_123);
        assert_eq!(h.path, "/api/v2/a b");
    }

    #[test]
    fn parse_header_rejects_garbage() {
        assert!(parse_header("").is_none());
        assert!(parse_header("trn-cache-v2 1 /api/x").is_none(), "wrong magic");
        assert!(parse_header("trn-cache-v1 notanumber /api/x").is_none());
        assert!(parse_header("trn-cache-v1 1").is_none(), "missing path");
        assert!(parse_header("trn-cache-v1 1 ").is_none(), "empty path");
    }

    #[test]
    fn read_header_reads_only_the_first_line_and_treats_bad_files_as_none() {
        let dir = std::env::temp_dir().join(format!("recon-pure-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let good = dir.join("good.trn");
        std::fs::write(&good, format!("{}body bytes", header_line(42, "/api/v2/good"))).unwrap();
        let h = read_header(&good).expect("header");
        assert_eq!((h.fetched_at, h.path.as_str()), (42, "/api/v2/good"));
        let bad = dir.join("bad.trn");
        std::fs::write(&bad, "not a header\n").unwrap();
        assert!(read_header(&bad).is_none());
        assert!(read_header(&dir.join("missing.trn")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- trn_proxy/trace.rs: bounded dev ring ------------------------------

    #[test]
    fn trace_ring_evicts_oldest_and_reads_incrementally() {
        let mut buf = VecDeque::new();
        let cap = 3;
        for seq in 1..=5u64 {
            trace_push(&mut buf, TraceLine { seq, text: format!("line {seq}") }, cap);
        }
        assert_eq!(buf.len(), 3);
        let (head, lines, missed) = trace_since(&buf, 0);
        assert_eq!(head, 5);
        assert_eq!(lines.iter().map(|l| l.seq).collect::<Vec<_>>(), vec![3, 4, 5]);
        assert!(missed, "1 and 2 were evicted before the poller saw them");

        let (head, lines, missed) = trace_since(&buf, 4);
        assert_eq!(head, 5);
        assert_eq!(lines.iter().map(|l| l.seq).collect::<Vec<_>>(), vec![5]);
        assert!(!missed, "no gap after a line the poller already saw");

        let empty: VecDeque<TraceLine> = VecDeque::new();
        let (head, lines, missed) = trace_since(&empty, 7);
        assert_eq!((head, lines.len(), missed), (7, 0, false));
    }

    #[test]
    fn trace_push_respects_a_zero_cap() {
        let mut buf = VecDeque::new();
        trace_push(&mut buf, TraceLine { seq: 1, text: "x".to_string() }, 0);
        assert!(buf.is_empty());
        assert_eq!(TRACE_RING_CAP, 512);
    }
}
