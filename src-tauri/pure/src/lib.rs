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

// Rust live service, pure half: presence JSON → facts. Only `serde_json`, so
// the fixture matrix the native overlay depends on runs on any host.
#[path = "../../src/live_facts.rs"]
pub mod live_facts;

// HUD ownership: one resolver for "which renderer may render right now", shared
// by the daemons and the settings UI. Pure, so every mode × health pair is
// host-testable.
#[path = "../../src/overlay_renderer.rs"]
pub mod overlay_renderer;

// The custom-resolution writer is the most destructive code in the app (EDID
// patching, display timings). Its pure core — range validation, CVT-RB2/CRU
// timing maths, EDID checksum and base-block patch — touches only `std`, so
// it is compiled here by path and tested without Windows or a monitor.
#[path = "../../src/custom_res/timing.rs"]
pub mod custom_res_timing;
#[path = "../../src/custom_res/edid.rs"]
pub mod custom_res_edid;

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

    // ---- live_facts.rs: presence JSON -> HUD facts (Phase 0) ----------------

    use crate::live_facts::{
        decode_base64, derive_facts, find_local_presence, map_display_name, queue_mode_label,
        LiveFacts, LIVE_FACTS_VERSION,
    };

    const ME: &str = "11111111-2222-3333-4444-555555555555";

    /// Test-only base64 encoder: production only ever decodes.
    fn b64(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
        for chunk in bytes.chunks(3) {
            let b1 = chunk[0] as u32;
            let b2 = *chunk.get(1).unwrap_or(&0) as u32;
            let b3 = *chunk.get(2).unwrap_or(&0) as u32;
            let n = (b1 << 16) | (b2 << 8) | b3;
            out.push(TABLE[((n >> 18) & 63) as usize] as char);
            out.push(TABLE[((n >> 12) & 63) as usize] as char);
            out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 63) as usize] as char } else { '=' });
            out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
        }
        out
    }

    fn presence_with_blob(puuid: &str, blob: Value) -> Value {
        json!({
            "puuid": puuid,
            "game_name": "Youssef",
            "game_tag": "EUW",
            "private": b64(blob.to_string().as_bytes()),
        })
    }

    fn presences(entries: Vec<Value>) -> Value {
        json!({ "presences": entries })
    }

    fn ingame_blob() -> Value {
        json!({
            "sessionLoopState": "INGAME",
            "queueId": "competitive",
            "matchMap": "Ascent",
            "partyOwnerMatchScoreAllyTeam": 6,
            "partyOwnerMatchScoreEnemyTeam": 4,
            "partyId": "party-1",
        })
    }

    #[test]
    fn ingame_presence_yields_score_map_queue_and_phase() {
        let root = presences(vec![presence_with_blob(ME, ingame_blob())]);
        let f = derive_facts(&root, ME, 1_700_000_000_000);
        assert_eq!(f.version, LIVE_FACTS_VERSION);
        assert_eq!(f.source, "presences");
        assert_eq!(f.confidence, "high");
        assert_eq!(f.phase, "coregame");
        assert_eq!(f.phase_label, "LIVE");
        assert_eq!(f.loop_state, "INGAME");
        assert_eq!(f.map, "Ascent");
        assert_eq!(f.queue, "competitive");
        assert_eq!(f.mode, "Competitive");
        assert_eq!((f.blue, f.red), (6, 4));
        assert_eq!(f.updated_at, 1_700_000_000_000);
        assert_eq!(f.seq, 0, "seq is the emitter's bookkeeping, not the derivation's");
    }

    #[test]
    fn nested_match_presence_data_is_the_authoritative_blob() {
        // Modern shape: the live values live under matchPresenceData, so a
        // stale flat copy must not win.
        let root = presences(vec![presence_with_blob(
            ME,
            json!({
                "matchPresenceData": {
                    "sessionLoopState": "INGAME",
                    "queueId": "unrated",
                    "matchMap": "/Game/Maps/Ascent/Ascent",
                    "partyOwnerMatchScoreAllyTeam": 12,
                    "partyOwnerMatchScoreEnemyTeam": "9",
                },
                "sessionLoopState": "MENU",
                "queueId": "competitive",
                "partyOwnerMatchScoreAllyTeam": 0,
            }),
        )]);
        let f = derive_facts(&root, ME, 0);
        assert_eq!(f.phase, "coregame");
        assert_eq!(f.map, "Ascent", "a content path renders as its map name");
        assert_eq!(f.queue, "unrated");
        assert_eq!(f.mode, "Unrated");
        assert_eq!((f.blue, f.red), (12, 9), "numeric strings count like Number()");
    }

    #[test]
    fn pregame_is_select_with_no_score() {
        let root = presences(vec![presence_with_blob(
            ME,
            json!({
                "sessionLoopState": "PREGAME",
                "queueId": "swiftplay",
                "matchMap": "Haven",
            }),
        )]);
        let f = derive_facts(&root, ME, 0);
        assert_eq!(f.phase, "pregame");
        assert_eq!(f.phase_label, "SELECT");
        assert_eq!((f.blue, f.red), (0, 0));
        assert_eq!(f.map, "Haven");
        assert_eq!(f.mode, "Swiftplay");
    }

    #[test]
    fn menu_keeps_the_last_match_out_of_the_fact_set() {
        // Presence keeps the previous match's map/queue/score while in menus;
        // an idle HUD must never show a finished score.
        let root = presences(vec![presence_with_blob(
            ME,
            json!({
                "sessionLoopState": "MENU",
                "queueId": "competitive",
                "matchMap": "Ascent",
                "partyOwnerMatchScoreAllyTeam": 13,
                "partyOwnerMatchScoreEnemyTeam": 11,
            }),
        )]);
        let f = derive_facts(&root, ME, 0);
        assert_eq!(f.phase, "idle");
        assert_eq!(f.phase_label, "");
        assert_eq!((f.map.as_str(), f.queue.as_str(), f.mode.as_str()), ("", "", ""));
        assert_eq!((f.blue, f.red), (0, 0));
        assert_eq!(f.confidence, "high", "the loop state WAS readable; the match is over");
        assert_eq!(f.loop_state, "MENU");
    }

    #[test]
    fn malformed_presence_reads_as_unknown_never_as_a_match() {
        // Not-JSON base64, non-UTF8 base64, plain garbage, empty string.
        for private in ["bm90IGpzb24=", "//79", "not base64 !!", ""] {
            let root = presences(vec![json!({ "puuid": ME, "private": private })]);
            let f = derive_facts(&root, ME, 0);
            assert_eq!(f.phase, "idle", "{private}");
            assert_eq!(f.confidence, "low", "{private}");
            assert_eq!(f.updated_at, 0);
        }
        // No private key at all.
        let root = presences(vec![json!({ "puuid": ME })]);
        assert_eq!(derive_facts(&root, ME, 0).confidence, "low");
        // Not even the expected object shape.
        assert_eq!(derive_facts(&json!([1, 2, 3]), ME, 0).phase, "idle");
        assert_eq!(derive_facts(&json!(null), ME, 0).phase, "idle");
        assert_eq!(derive_facts(&json!({ "presences": "nope" }), ME, 0).phase, "idle");
    }

    #[test]
    fn readable_blob_without_loop_state_is_medium_not_a_match() {
        let root = presences(vec![presence_with_blob(ME, json!({ "partyId": "party-1" }))]);
        let f = derive_facts(&root, ME, 0);
        assert_eq!(f.confidence, "medium");
        assert_eq!(f.phase, "idle");
        assert_eq!(f.map, "");
    }

    #[test]
    fn another_players_presence_is_never_taken_for_ours() {
        let other = "99999999-8888-7777-6666-555555555555";
        let root = presences(vec![presence_with_blob(other, ingame_blob())]);
        assert!(find_local_presence(&root, ME).is_none());
        let f = derive_facts(&root, ME, 0);
        assert_eq!(f.phase, "idle");
        assert_eq!(f.confidence, "low");
        // An empty puuid is "not found", never "first presence wins".
        assert!(find_local_presence(&root, "").is_none());
        // `pid` form: puuid@region is accepted as the id.
        let pid = format!("{ME}@eu1.pvp.net");
        let root = presences(vec![json!({ "pid": pid, "private": "" })]);
        assert!(find_local_presence(&root, ME).is_some());
    }

    #[test]
    fn base64_accepts_url_safe_and_unpadded_but_rejects_garbage() {
        assert_eq!(decode_base64("aGVsbG8=").as_deref(), Some(&b"hello"[..]));
        assert_eq!(decode_base64("aGVsbG8").as_deref(), Some(&b"hello"[..]));
        assert_eq!(decode_base64("aGVs bG8=").as_deref(), Some(&b"hello"[..]));
        assert_eq!(decode_base64("-_8=").as_deref(), Some(&[0xFBu8, 0xFF][..]));
        assert!(decode_base64("a").is_none(), "a 6-bit tail is not a byte");
        assert!(decode_base64("ab=c").is_none(), "data after padding");
        assert!(decode_base64("====").is_none());
        assert!(decode_base64("aGVs*bG8=").is_none());
    }

    #[test]
    fn same_facts_ignores_bookkeeping_and_detects_real_changes() {
        let root = presences(vec![presence_with_blob(ME, ingame_blob())]);
        let a = derive_facts(&root, ME, 1_000);
        let mut b = a.clone();
        b.seq = 7;
        b.updated_at = 9_999;
        assert!(a.same_facts(&b), "seq/updated_at alone must never re-emit");
        b.red += 1;
        assert!(!a.same_facts(&b), "a round can decide the match");
        b.red -= 1;
        b.map = "Haven".to_string();
        assert!(!a.same_facts(&b));
        b.map = "Ascent".to_string();
        b.phase = "idle".to_string();
        assert!(!a.same_facts(&b));
        assert!(LiveFacts::default().same_facts(&LiveFacts::idle(123)));
    }

    #[test]
    fn queue_labels_and_map_paths_match_the_ts_renderer() {
        assert_eq!(queue_mode_label("competitive"), "Competitive");
        assert_eq!(queue_mode_label("SWIFTPLAY"), "Swiftplay");
        assert_eq!(queue_mode_label("quickbomb"), "Swiftplay");
        assert_eq!(queue_mode_label("spikerush"), "Spike Rush");
        assert_eq!(queue_mode_label("premier"), "Premier");
        assert_eq!(queue_mode_label(""), "");
        // Unknown ids stay visible (title-cased), never hidden.
        assert_eq!(queue_mode_label("newmode"), "Newmode");
        assert_eq!(map_display_name("Ascent"), "Ascent");
        assert_eq!(map_display_name("/Game/Maps/Ascent/Ascent"), "Ascent");
        assert_eq!(map_display_name("  "), "");
        // A codename is surfaced as-is: translating it needs the game-data
        // table, which the UI owns.
        assert_eq!(map_display_name("/Game/Maps/duality/duality"), "Duality");
    }

    // ---- overlay_renderer.rs: one HUD owns the screen -----------------------

    use crate::overlay_renderer::{
        resolve_renderer, ActiveOverlayRenderer, OverlayRendererSetting,
    };

    #[test]
    fn ts_setting_never_spawns_a_native_hud() {
        // Health is irrelevant: the user asked for the in-app renderer.
        assert_eq!(
            resolve_renderer(OverlayRendererSetting::Ts, true),
            ActiveOverlayRenderer::Ts
        );
        assert_eq!(
            resolve_renderer(OverlayRendererSetting::Ts, false),
            ActiveOverlayRenderer::Ts
        );
    }

    #[test]
    fn native_setting_owns_the_screen_even_when_unhealthy() {
        // Explicit native is a request, not a suggestion: no silent fallback.
        // An empty HUD is the honest outcome and the status row says why.
        assert_eq!(
            resolve_renderer(OverlayRendererSetting::Native, true),
            ActiveOverlayRenderer::Native
        );
        assert_eq!(
            resolve_renderer(OverlayRendererSetting::Native, false),
            ActiveOverlayRenderer::Native
        );
    }

    #[test]
    fn auto_follows_sidecar_health_in_both_directions() {
        // The default: native while the probe passes...
        assert_eq!(
            resolve_renderer(OverlayRendererSetting::Auto, true),
            ActiveOverlayRenderer::Native
        );
        // ...and the in-app HUD the moment it does not (failed probe, crash,
        // missing binary) — exactly one renderer either way.
        assert_eq!(
            resolve_renderer(OverlayRendererSetting::Auto, false),
            ActiveOverlayRenderer::Ts
        );
    }

    #[test]
    fn unknown_or_damaged_settings_read_as_auto() {
        // A hand-edited settings.json must never leave the app with no HUD:
        // anything unrecognized is the default.
        for raw in ["", " ", "garbage", "AUTO ", "\u{0}ts"] {
            assert_eq!(
                OverlayRendererSetting::parse(raw),
                OverlayRendererSetting::Auto,
                "{raw:?}"
            );
        }
        assert_eq!(OverlayRendererSetting::parse("ts"), OverlayRendererSetting::Ts);
        assert_eq!(OverlayRendererSetting::parse("TS"), OverlayRendererSetting::Ts);
        assert_eq!(
            OverlayRendererSetting::parse(" native "),
            OverlayRendererSetting::Native
        );
        // Round-trip: what the settings store writes is what parses back.
        for setting in [
            OverlayRendererSetting::Ts,
            OverlayRendererSetting::Native,
            OverlayRendererSetting::Auto,
        ] {
            assert_eq!(OverlayRendererSetting::parse(setting.as_str()), setting);
        }
        assert_eq!(OverlayRendererSetting::DEFAULT, OverlayRendererSetting::Auto);
        assert_eq!(ActiveOverlayRenderer::Ts.as_str(), "ts");
        assert_eq!(ActiveOverlayRenderer::Native.as_str(), "native");
    }
}


/// The custom-resolution writer: range validation, CVT-RB2 timing maths and
/// EDID patching — the pure core of the most destructive module in the app.
///
/// Vectors: RBv2 constants are VESA CVT 1.2 Reduced Blanking v2 (80 px
/// horizontal blank = 8 front / 32 sync / 40 back, 460 µs minimum vertical
/// blank, 8-line vsync, 6-line vback) as ported from CRU
/// `CalculateCVTRB2Standard`. 2560×1440@144 cross-checks the published
/// 586.59 MHz / 2640×1543 DP mode (the 10 kHz field truncates to 586.58).
/// 1920×1080@60 is CEA-861 timing from the `AutomaticPC` table.
#[cfg(test)]
mod custom_res_tests {
    use crate::custom_res_edid::{
        block_checksum_ok, checksum_byte, device_params_path, extension_block_count,
        has_all_blocks, is_valid_edid, override_path, patch_edid, split_pnp,
    };
    use crate::custom_res_timing::{
        build_detailed_timing, cvt_rb2_front, hperiod_cvt_rb2, validate_custom_resolution,
    };

    /// Decoded EDID Type-0 descriptor: every field the encoder writes, read
    /// back out of its 18 bytes exactly the way a driver would.
    #[derive(Debug, PartialEq, Eq)]
    struct Dtd {
        pclk_10khz: u32,
        ha: u32,
        hb: u32,
        h_total: u32,
        va: u32,
        vb: u32,
        v_total: u32,
        h_front: u32,
        h_sync: u32,
        v_front: u32,
        v_sync: u32,
        flags: u8,
    }

    fn decode(d: &[u8; 18]) -> Dtd {
        let ha = d[2] as u32 | (((d[4] as u32) & 0xF0) << 4);
        let hb = d[3] as u32 | (((d[4] as u32) & 0x0F) << 8);
        let va = d[5] as u32 | (((d[7] as u32) & 0xF0) << 4);
        let vb = d[6] as u32 | (((d[7] as u32) & 0x0F) << 8);
        Dtd {
            pclk_10khz: d[0] as u32 | (d[1] as u32) << 8,
            ha,
            hb,
            h_total: ha + hb,
            va,
            vb,
            v_total: va + vb,
            h_front: d[8] as u32 | (((d[11] as u32) & 0xC0) << 2),
            h_sync: d[9] as u32 | (((d[11] as u32) & 0x30) << 4),
            v_front: ((d[10] as u32) >> 4) | (((d[11] as u32) & 0x0C) << 2),
            v_sync: (d[10] as u32 & 0x0F) | (((d[11] as u32) & 0x03) << 4),
            flags: d[17],
        }
    }

    fn timing(w: u32, h: u32, hz: u32) -> Dtd {
        decode(&build_detailed_timing(w, h, hz).expect("timing"))
    }

    /// A well-formed 128-byte base block whose first descriptor slot is a
    /// monitor descriptor (so a patch has something real to replace).
    fn base_edid() -> Vec<u8> {
        let mut b = vec![0u8; 128];
        b[..8].copy_from_slice(&[0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00]);
        b[8..10].copy_from_slice(&[0x10, 0xAC]); // manufacturer "DEL"
        b[18] = 1; // EDID 1.4
        b[19] = 4;
        b[54..58].copy_from_slice(&[0x00, 0x00, 0x00, 0xFC]); // "monitor name" tag
        b[58..72].copy_from_slice(b"Test Panel 27\"");
        b[126] = 0; // no extension blocks
        b[127] = checksum_byte(&b[..127]);
        b
    }

    #[test]
    fn cvt_rb2_matches_the_reference_2560x1440_144_vector() {
        let d = timing(2560, 1440, 144);
        // 2640 × 1543 @ 144 Hz = 586.586 MHz; the descriptor stores 10 kHz
        // units, so truncation puts it at 586.58 (the published mode is 586.59).
        assert_eq!(d.pclk_10khz, 58_658);
        assert_eq!((d.ha, d.hb, d.h_total), (2560, 80, 2640));
        assert_eq!((d.va, d.vb, d.v_total), (1440, 103, 1543));
        // RBv2 blanking: 8 front / 32 sync / 40 back horizontally.
        assert_eq!((d.h_front, d.h_sync), (8, 32));
        // The computed vfront is 89 lines, past the 6-bit field: the encoder
        // clamps it to 8 and leaves the 12-bit VBlank intact.
        assert_eq!((d.v_front, d.v_sync), (8, 8));
        assert_eq!(d.flags, 0b0001_1010, "digital separate, +h -v sync");
    }

    #[test]
    fn cvt_rb2_leaves_vfront_encodable_at_1680x1050_60() {
        let d = timing(1680, 1050, 60);
        // 1760 × 1080 @ 60 Hz = 114.048 MHz → 11404 after 10 kHz truncation.
        assert_eq!(d.pclk_10khz, 11_404);
        assert_eq!((d.h_total, d.v_total), (1760, 1080));
        assert_eq!((d.v_front, d.v_sync), (16, 8));
        assert_eq!(d.vb, 30, "vfront 16 + vsync 8 + vback 6");
    }

    #[test]
    fn automatic_pc_hit_is_the_cea_861_1920x1080_60_timing() {
        let d = timing(1920, 1080, 60);
        assert_eq!(d.pclk_10khz, 14_850, "CEA-861 1080p60 is 148.50 MHz");
        assert_eq!((d.ha, d.hb, d.h_total), (1920, 280, 2200));
        assert_eq!((d.va, d.vb, d.v_total), (1080, 45, 1125));
        assert_eq!((d.h_front, d.h_sync), (88, 44));
        assert_eq!((d.v_front, d.v_sync), (4, 5));
        assert_eq!(d.flags, 0b0001_1110, "digital separate, +h +v sync");
    }

    #[test]
    fn automatic_pc_hit_quantizes_pixel_clock_to_25() {
        // 1792 × 798 @ 60 Hz = 85.8096 MHz; TablePClock quantizes to 25
        // (PClockPrecision / 4) the way CRU does, landing on 85.75 MHz.
        let d = timing(1366, 768, 60);
        assert_eq!(d.pclk_10khz, 8_575);
        assert_eq!((d.h_total, d.v_total), (1792, 798));
        assert_eq!((d.h_front, d.h_sync), (70, 143));
    }

    #[test]
    fn high_refresh_1080p_stays_inside_the_16_bit_clock() {
        // 240 Hz still fits: 2000 × 1215 @ 240 Hz = 583.20 MHz.
        let d = timing(1920, 1080, 240);
        assert_eq!((d.pclk_10khz, d.v_total), (58_320, 1215));
        assert_eq!(d.v_front, 8, "121 computed front is clamped to the field");
        // 260 Hz also fits: 2000 × 1227 @ 260 Hz = 638.04 MHz.
        let d = timing(1920, 1080, 260);
        assert_eq!((d.pclk_10khz, d.v_total), (63_804, 1227));
        // 360 Hz needs 932.40 MHz: unencodable, so the DTD is capped near
        // 650 MHz (2000 × 1221 @ 612.85 MHz) for geometry only.
        let d = timing(1920, 1080, 360);
        assert_eq!((d.pclk_10khz, d.v_total), (61_285, 1221));
        assert!(d.pclk_10khz <= 65_535);
        assert_eq!((d.v_front, d.v_sync), (8, 8));
    }

    #[test]
    fn refresh_bounds_are_23_to_500_inclusive() {
        assert!(validate_custom_resolution(1920, 1080, 23).is_ok());
        assert!(validate_custom_resolution(1920, 1080, 500).is_ok());
        let err = validate_custom_resolution(1920, 1080, 22).unwrap_err();
        assert!(err.contains("23"), "{err}");
        let err = validate_custom_resolution(1920, 1080, 501).unwrap_err();
        assert!(err.contains("500"), "{err}");
        // The boundaries are real: the extremes still build a descriptor.
        assert!(build_detailed_timing(1920, 1080, 23).is_ok());
        assert!(build_detailed_timing(1920, 1080, 500).is_ok());
    }

    #[test]
    fn zero_and_oversized_inputs_are_rejected_not_panicking() {
        assert!(validate_custom_resolution(0, 0, 0).is_err());
        assert!(validate_custom_resolution(1, 1080, 60).is_err());
        assert!(validate_custom_resolution(u32::MAX, 1080, 60).is_err());
        assert!(validate_custom_resolution(1920, u32::MAX, 60).is_err());
        assert!(validate_custom_resolution(1920, 1080, u32::MAX).is_err());
        assert!(build_detailed_timing(0, 0, 0).is_err());
        // Odd sizes cannot be packed into an even-pixel detailed timing.
        assert!(validate_custom_resolution(1921, 1080, 144).is_err());
        assert!(validate_custom_resolution(1920, 1081, 144).is_err());
        // The range admits 8K, but Type-0 fields are 12-bit: 4320 lines and
        // widths over 4095 can never be encoded, so they fail at pack time.
        assert!(
            build_detailed_timing(7680, 4320, 60).unwrap_err().contains("12-bit"),
            "7680x4320 is out of range for the descriptor"
        );
        assert!(build_detailed_timing(4096, 2160, 60).is_err());
        // The AutomaticPC table's 24/25/30 Hz 1280×720 rows carry a 1760/2420
        // pixel horizontal front porch, past the 10-bit H-front field. Those
        // rows are skipped and 720p falls back to CVT-RB2, so the add succeeds
        // (see `low_refresh_720p_falls_back_to_cvt_rb2`); 48 Hz is a real table
        // hit and keeps its CRU timing.
        for hz in [24, 25, 30] {
            assert!(
                build_detailed_timing(1280, 720, hz).is_ok(),
                "1280x720@{hz} must be addable"
            );
        }
        assert!(build_detailed_timing(1280, 720, 48).is_ok(), "the 48 Hz row fits");
    }

    /// Asserts a packed descriptor describes `w × h` at about `hz` with sane,
    /// in-field geometry: nothing overflows its EDID Type-0 field and the
    /// totals really are larger than the active area.
    fn assert_consistent_timing(d: &Dtd, w: u32, h: u32, hz: u32) {
        assert_eq!((d.ha, d.va), (w, h), "{w}x{h}@{hz} active size");
        assert!(d.hb > 0 && d.h_total > w, "{w}x{h}@{hz}: h_total");
        assert!(d.vb > 0 && d.v_total > h, "{w}x{h}@{hz}: v_total");
        assert!(
            d.pclk_10khz >= 1 && d.pclk_10khz <= 65_535,
            "{w}x{h}@{hz}: pclk"
        );
        // Field widths: 10-bit H front/sync, 6-bit V front/sync (the decoders
        // mask to those widths, so re-encoding must reproduce the same bytes).
        assert!(
            d.h_front <= 1023 && d.h_sync <= 1023,
            "{w}x{h}@{hz}: h fields"
        );
        assert!(d.v_front <= 63 && d.v_sync <= 63, "{w}x{h}@{hz}: v fields");
        assert!(d.v_front + d.v_sync < d.vb, "{w}x{h}@{hz}: back porch");
        assert!(d.hb <= 4095 && d.vb <= 4095, "{w}x{h}@{hz}: 12-bit blank");
        assert_eq!(
            (d.pclk_10khz * 10_000 + d.h_total * d.v_total / 2) / (d.h_total * d.v_total),
            hz,
            "{w}x{h}@{hz}: reconstructed refresh"
        );
    }

    #[test]
    fn low_refresh_720p_falls_back_to_cvt_rb2() {
        // The three unencodable table rows (h_front 2420/2420/1760 > 1023) now
        // synthesize CVT-RB2 instead of erroring out of the add flow.
        for hz in [24, 25, 30] {
            let d = timing(1280, 720, hz);
            assert_consistent_timing(&d, 1280, 720, hz);
            // RBv2 blanking: 8 front / 32 sync / 40 back = 80 px.
            assert_eq!((d.h_front, d.h_sync, d.hb), (8, 32, 80), "1280x720@{hz}");
            // 720 lines always leave the computed front past the 6-bit field at
            // these rates (it collapses below the 460 µs blank); the encoder
            // clamps to the VESA offset and keeps the blank total.
            assert_eq!((d.v_front, d.v_sync), (1, 8), "1280x720@{hz}");
        }
        // Distinct descriptors: each rate is packed on its own pixel clock.
        let clocks: Vec<u32> = [24, 25, 30]
            .iter()
            .map(|hz| timing(1280, 720, *hz).pclk_10khz)
            .collect();
        assert!(clocks[0] < clocks[1] && clocks[1] < clocks[2], "{clocks:?}");
    }

    #[test]
    fn encodable_table_rows_are_byte_identical_to_the_golden_descriptors() {
        // Table hits must not be re-derived: these are the exact CRU-port bytes
        // captured before the CVT-RB2 fallback existed.
        let golden: &[((u32, u32, u32), [u8; 18])] = &[
            (
                (1920, 1080, 60),
                [
                    0x02, 0x3A, 0x80, 0x18, 0x71, 0x38, 0x2D, 0x40, 0x58, 0x2C, 0x45, 0x00, 0xE0,
                    0x0E, 0x11, 0x00, 0x00, 0x1E,
                ],
            ),
            (
                (1920, 1080, 50),
                [
                    0x02, 0x3A, 0x80, 0xD0, 0x72, 0x38, 0x2D, 0x40, 0x10, 0x2C, 0x45, 0x80, 0xE0,
                    0x0E, 0x11, 0x00, 0x00, 0x1E,
                ],
            ),
            (
                (1366, 768, 60),
                [
                    0x7F, 0x21, 0x56, 0xAA, 0x51, 0x00, 0x1E, 0x30, 0x46, 0x8F, 0x33, 0x00, 0x55,
                    0xC0, 0x10, 0x00, 0x00, 0x1E,
                ],
            ),
            (
                (1600, 900, 60),
                [
                    0x30, 0x2A, 0x40, 0xC8, 0x60, 0x84, 0x64, 0x30, 0x18, 0x50, 0x13, 0x00, 0x90,
                    0xE1, 0x10, 0x00, 0x00, 0x1E,
                ],
            ),
            (
                (1280, 720, 48),
                [
                    0x28, 0x23, 0x00, 0xC4, 0x54, 0xD0, 0x1E, 0x20, 0xC0, 0x28, 0x55, 0xC0, 0x40,
                    0xB4, 0x10, 0x00, 0x00, 0x1E,
                ],
            ),
        ];
        for ((w, h, hz), bytes) in golden {
            assert_eq!(
                &build_detailed_timing(*w, *h, *hz).unwrap(),
                bytes,
                "{w}x{h}@{hz} drifted from the CRU table timing"
            );
        }
    }

    #[test]
    fn timing_helpers_guard_degenerate_rates() {
        // hperiod: frame period in ps minus the 460 µs blank, per active line.
        assert_eq!(hperiod_cvt_rb2(1080, 60_000), 15_006_172);
        // Zero and negative rates return the 460 µs floor instead of dividing.
        assert_eq!(hperiod_cvt_rb2(1080, 0), 460_000_000);
        assert_eq!(hperiod_cvt_rb2(1080, -1), 460_000_000);
        // v_active 0 is clamped to 1: finite, never a panic.
        assert_eq!(hperiod_cvt_rb2(0, 60_000), 16_206_666_666);
        // A zero-line pedal returns the minimum 1-line front porch.
        assert_eq!(cvt_rb2_front(0, 0), 1);
        assert_eq!(cvt_rb2_front(480, -2), 1);
        assert_eq!(cvt_rb2_front(1050, 60_000), 16);
    }

    #[test]
    fn checksum_byte_makes_a_block_sum_to_zero() {
        for sum_seed in [0u8, 1, 17, 255] {
            let mut block = vec![sum_seed; 128];
            block[127] = checksum_byte(&block[..127]);
            let sum: u32 = block.iter().map(|b| *b as u32).sum();
            assert_eq!(sum % 256, 0, "seed {sum_seed}");
        }
        // The helper is byte-identical to the expression it replaced.
        let body: Vec<u8> = (0..127).map(|i| (i * 7 % 251) as u8).collect();
        let sum: u32 = body.iter().map(|b| *b as u32).sum();
        assert_eq!(checksum_byte(&body), ((256 - (sum % 256)) % 256) as u8);
        assert!(block_checksum_ok(&{
            let mut b = base_edid();
            b[127] = checksum_byte(&b[..127]);
            b
        }));
    }

    #[test]
    fn patch_round_trip_is_byte_identical_outside_the_descriptor() {
        let base = base_edid();
        let timing = build_detailed_timing(2560, 1440, 144).unwrap();
        let out = patch_edid(&base, timing).unwrap();
        // Header, chromaticity, established timings and the trailing
        // descriptor slots are copied untouched; only 54..72 changes.
        assert_eq!(out[..54], base[..54]);
        assert_eq!(out[54..72], timing);
        assert_eq!(out[72..127], base[72..127]);
        assert_eq!(out[126], 0, "extension count is preserved, not invented");
        // The checksum is recomputed for the patched block, and the result is
        // a valid block by the EDID rule (sum of all 128 bytes ≡ 0).
        assert!(block_checksum_ok(&out));
        let sum: u32 = out.iter().map(|b| *b as u32).sum();
        assert_eq!(sum % 256, 0);
        // Patching is idempotent: same base + same timing = same bytes.
        assert_eq!(patch_edid(&base, timing).unwrap(), out);
        assert_eq!(patch_edid(&out, timing).unwrap(), out);
    }

    #[test]
    fn patch_rejects_short_blocks_and_bad_headers() {
        assert_eq!(
            patch_edid(&[0u8; 127], [0u8; 18]).unwrap_err(),
            "Base EDID shorter than 128 bytes."
        );
        assert!(patch_edid(&[], [0u8; 18]).is_err());
        let mut bad = base_edid();
        bad[0] = 0x01; // broken 00 FF FF FF FF FF FF 00 header
        assert_eq!(patch_edid(&bad, [0u8; 18]).unwrap_err(), "Base EDID header invalid.");
        assert!(!is_valid_edid(&bad));
        assert!(is_valid_edid(&base_edid()));
        assert!(!is_valid_edid(&base_edid()[..127]), "a short slice is not an EDID");
    }

    #[test]
    fn a_corrupt_live_checksum_is_detected_and_the_patch_repairs_it() {
        let mut base = base_edid();
        base[100] ^= 0xFF; // byte flipped after the checksum was computed
        assert!(!block_checksum_ok(&base), "checksum failure is detected");
        assert!(is_valid_edid(&base), "the header check is independent of the checksum");
        // The writer still patches (a firmware-reported checksum must not block
        // the user) and the override it writes is valid again.
        let out = patch_edid(&base, build_detailed_timing(1920, 1080, 240).unwrap()).unwrap();
        assert!(block_checksum_ok(&out));
        assert_eq!(out[100], base[100], "the corrupt byte itself is copied, not guessed");
    }

    #[test]
    fn extension_blocks_are_counted_but_never_rewritten() {
        let mut base = base_edid();
        base[126] = 2; // declares two 128-byte extension blocks
        assert_eq!(extension_block_count(&base), 2);
        assert!(!has_all_blocks(&base), "128 bytes cannot hold the declared blocks");
        let mut full = base.clone();
        full.extend_from_slice(&[0u8; 256]);
        assert!(has_all_blocks(&full));
        // The writer emits exactly one 128-byte block and leaves the declared
        // count alone: it writes 54..72 + the checksum, nothing else.
        let out = patch_edid(&base, [1u8; 18]).unwrap();
        assert_eq!(out.len(), 128);
        assert_eq!(out[126], 2, "extension count copied from the base verbatim");
        assert_eq!(out[72..126], base[72..126]);
        assert_eq!(extension_block_count(&out), 2);
        // An empty slice has no count and no blocks.
        assert_eq!(extension_block_count(&[]), 0);
        assert!(!has_all_blocks(&[]));
    }

    #[test]
    fn split_pnp_accepts_only_display_paths() {
        let ok = split_pnp(r"DISPLAY\DEL4098\5&1a2b&0&UID4352").unwrap();
        assert_eq!(ok.0, "DEL4098");
        assert_eq!(ok.1, "5&1a2b&0&UID4352");
        // The enum name is case-insensitive and whitespace is trimmed.
        assert_eq!(split_pnp(" display\\DEL4098\\1 ").unwrap().0, "DEL4098");
        assert_eq!(split_pnp(r"DISPLAY\A\B").unwrap(), ("A".to_string(), "B".to_string()));
        // Non-hex, ampersand-heavy instance ids are the norm for PnP, not an
        // error: the resolver produced them.
        assert_eq!(
            split_pnp(r"DISPLAY\GSM5B7B\6&2f7c1d1&0&00000000").unwrap().1,
            "6&2f7c1d1&0&00000000"
        );
        // Nested instance segments rejoin with their separator.
        assert_eq!(split_pnp(r"DISPLAY\A\B\C").unwrap().1, r"B\C");
        for bad in [
            "",
            "DISPLAY",
            r"DISPLAY\",
            r"DISPLAY\DEL4098",
            r"DISPLAY\DEL4098\",
            r"PCI\VEN_10DE\DEV_2484",
            r"\\.\DISPLAY1",
        ] {
            assert!(split_pnp(bad).is_none(), "{bad:?} is not a DISPLAY PnP path");
        }
    }

    #[test]
    fn every_admitted_size_and_rate_packs_or_errors_cleanly() {
        // Sweep the whole validation envelope: no division panic, no partially
        // written descriptor, and every refusal carries a message.
        let (mut ok, mut err) = (0u32, 0u32);
        for w in [640, 641, 800, 1024, 1280, 1366, 1600, 1920, 2090, 2560, 3440, 3840, 4095, 4096, 5120, 7680] {
            for h in [480, 481, 600, 720, 768, 900, 1050, 1080, 1200, 1440, 1600, 2160, 4095, 4096, 4320] {
                for hz in [23, 24, 30, 48, 50, 60, 75, 100, 120, 144, 165, 240, 300, 360, 480, 500] {
                    match build_detailed_timing(w, h, hz) {
                        Ok(d) => {
                            let decoded = decode(&d);
                            assert_eq!((decoded.ha, decoded.va), (w, h), "{w}x{h}@{hz}");
                            assert!(decoded.pclk_10khz >= 1 && decoded.pclk_10khz <= 65_535);
                            ok += 1;
                        }
                        Err(e) => {
                            assert!(!e.is_empty(), "{w}x{h}@{hz} failed without a message");
                            err += 1;
                        }
                    }
                }
            }
        }
        assert!(ok > 0 && err > 0, "swept {ok} ok / {err} err");
    }

    #[test]
    fn device_params_path_is_the_registry_location_for_a_pnp_id() {
        let (dev, inst) = split_pnp(r"DISPLAY\DEL4098\5&1a2b&0&UID4352").unwrap();
        assert_eq!(
            device_params_path(&dev, &inst),
            r"SYSTEM\CurrentControlSet\Enum\DISPLAY\DEL4098\5&1a2b&0&UID4352\Device Parameters"
        );
        assert_eq!(
            override_path(&dev, &inst),
            r"SYSTEM\CurrentControlSet\Enum\DISPLAY\DEL4098\5&1a2b&0&UID4352\Device Parameters\EDID_OVERRIDE"
        );
        // A nested instance id keeps its separator in the registry path.
        let (dev, inst) = split_pnp(r"DISPLAY\A\B\C").unwrap();
        assert!(device_params_path(&dev, &inst).ends_with(r"DISPLAY\A\B\C\Device Parameters"));
    }
}
