//! Unit tests for the model and the pure sampler helpers.

use super::*;

    use super::*;

    fn s(t: u64, rss: f64, cpu: f64) -> PerfSample {
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

    fn e(pid: u32, ppid: u32, exe: &str) -> ProcEntry {
        ProcEntry {
            pid,
            ppid,
            exe: exe.to_string(),
        }
    }

    #[test]
    fn cpu_math() {
        // One core fully busy for 1s of 1s wall = 100% of the machine.
        assert!((cpu_pct_from_deltas(10_000_000, 1.0, 1) - 100.0).abs() < 1e-9);
        // Same load on 8 cores = 12.5% of the machine.
        assert!((cpu_pct_from_deltas(10_000_000, 1.0, 8) - 12.5).abs() < 1e-9);
        // Half a core-second over a 5s wall on 8 cores = 1.25%.
        assert!((cpu_pct_from_deltas(5_000_000, 5.0, 8) - 1.25).abs() < 1e-9);
        // Degenerate inputs never inf/nan/panic.
        assert_eq!(cpu_pct_from_deltas(10_000_000, 0.0, 8), 0.0);
        assert_eq!(cpu_pct_from_deltas(10_000_000, -1.0, 8), 0.0);
        assert_eq!(cpu_pct_from_deltas(10_000_000, 1.0, 0), 0.0);
        // Single-tick spike clamps instead of reporting >100%.
        assert_eq!(cpu_pct_from_deltas(80_000_000, 1.0, 1), 100.0);
    }

    /// The whole point of the CPU fix: the sample must SUM the tree, not average
    /// it and not read one process. A backend idle on 1% while three renderers
    /// each burn a third of a core is ~8% of a 4-core box — the shape the old
    /// own-process-only read reported as 1%.
    #[test]
    fn cpu_covers_the_same_set_as_memory() {
        // 3 renderers x 1s + backend 0.5s = 3.5 core-seconds over 5s wall on a
        // 4-core machine = 17.5%.
        let d = cpu_delta_100ns(
            &CpuTimes::from([(1, 0), (2, 0), (3, 0), (4, 0)]),
            &CpuTimes::from([
                (1, 5_000_000),
                (2, 10_000_000),
                (3, 10_000_000),
                (4, 10_000_000),
            ]),
        );
        assert_eq!(d, 35_000_000);
        assert!((cpu_pct_from_deltas(d, 5.0, 4) - 17.5).abs() < 1e-9);
        // AVERAGING the same four processes would have read 8.75% — half the
        // real cost. This is the assertion that keeps `rollup`-style averaging
        // out of the CPU path.
        assert!((cpu_pct_from_deltas(d / 4, 5.0, 4) - 4.375).abs() < 1e-9);
    }

    /// The census is the memory path's `omitted` discipline applied to CPU: a
    /// process whose times could not be read is COUNTED, never inserted as a
    /// zero that would erase the CPU it actually burned.
    #[test]
    fn cpu_unreadable_is_counted_not_zeroed() {
        // Everything readable.
        let clean = rollup_cpu(Some(10), &[Some(20), Some(30)]);
        assert_eq!(clean.processes, 3);
        assert_eq!(clean.omitted, 0);
        // The backend refused: the other two still count, the gap is reported.
        let backend_gone = rollup_cpu(None, &[Some(20), Some(30)]);
        assert_eq!((backend_gone.processes, backend_gone.omitted), (3, 1));
        // A renderer exited mid-poll — the common case, since a WebView2 child
        // can be reaped between two 5s samples.
        let mixed = rollup_cpu(Some(10), &[Some(20), None, None]);
        assert_eq!((mixed.processes, mixed.omitted), (4, 2));
        // Nothing readable at all still reports the full set as omitted, so an
        // all-zero CPU chart is visibly a failure and not an idle app.
        let none = rollup_cpu(None, &[None, None]);
        assert_eq!((none.processes, none.omitted), (3, 3));
    }

    /// A PID that appears or disappears between two samples must not move the
    /// number. Subtracting the summed totals instead would inflate on a new
    /// renderer and, when one exits, wrap the `u64` subtraction to ~1.8e19 —
    /// which the clamp would render as a flat 100% chart.
    #[test]
    fn cpu_delta_ignores_processes_without_a_baseline() {
        let prev = CpuTimes::from([(1, 1_000_000), (2, 5_000_000)]);
        // A brand-new renderer (huge lifetime total so far) and one that exited.
        let now = CpuTimes::from([(1, 1_500_000), (2, 5_500_000), (3, 900_000_000)]);
        assert_eq!(cpu_delta_100ns(&prev, &now), 1_000_000);

        // A process whose counter went BACKWARDS (PID reuse) contributes zero
        // rather than wrapping: saturating, not wrapping.
        let reused = CpuTimes::from([(1, 10), (2, 500)]);
        assert_eq!(
            cpu_delta_100ns(&CpuTimes::from([(1, 5_000_000), (2, 7_000_000)]), &reused),
            0
        );

        // No overlap at all (the whole tree was replaced): 0, not garbage.
        assert_eq!(cpu_delta_100ns(&prev, &CpuTimes::from([(77, 12_345)])), 0);
        // Empty samples.
        assert_eq!(cpu_delta_100ns(&CpuTimes::new(), &CpuTimes::new()), 0);
    }

    #[test]
    fn rss_math() {
        assert!((rss_mb_from_bytes(1_048_576) - 1.0).abs() < 1e-9);
        assert_eq!(rss_mb_from_bytes(0), 0.0);
        assert!((rss_mb_from_bytes(256 * 1_048_576) - 256.0).abs() < 1e-9);
    }

    /// The metric's own arithmetic: bytes to the MiB the dashboard prints, at
    /// Task Manager scale for a real recon tree (25_600 4 KiB pages = 100 MB).
    /// The prescribed per-page route (ShareCount==0 blocks x page size) is not
    /// used - the private counter reports bytes directly - so bytes -> MiB is
    /// the whole of the conversion.
    #[test]
    fn bytes_to_mib_at_task_manager_scale() {
        assert_eq!(rss_mb_from_bytes(0), 0.0);
        assert!((rss_mb_from_bytes(1_048_576) - 1.0).abs() < 1e-9);
        assert!((rss_mb_from_bytes(100 * 1_048_576) - 100.0).abs() < 1e-9);
        // The old bug's magnitude: commit ran ~3x the private figure for the
        // same tree. A basis that reintroduces that scale is a bug.
        assert!((rss_mb_from_bytes(300 * 1_048_576) - 300.0).abs() < 1e-9);
    }

    /// The basis enum must never label a non-private read as private. This is the
    /// assertion that keeps the original bug (a wrong number presented as a
    /// right one) from coming back.
    #[test]
    fn mem_basis_derivation() {
        // Every process read privately: the clean basis.
        assert_eq!(mem_basis(10, 0, 0), MemBasis::PrivateWorkingSet);
        // Every process on the documented fallback: degraded, but named.
        assert_eq!(mem_basis(0, 10, 0), MemBasis::ResidentWorkingSet);
        // Any split is mixed, never rounded up to the clean basis.
        assert_eq!(mem_basis(9, 1, 0), MemBasis::Mixed);
        assert_eq!(mem_basis(1, 9, 0), MemBasis::Mixed);
        // An unreadable process poisons the basis, so a gap is visible.
        assert_eq!(mem_basis(10, 0, 1), MemBasis::Mixed);
        assert_eq!(mem_basis(0, 10, 1), MemBasis::Mixed);
        // Nothing readable at all is not the private basis.
        assert_eq!(mem_basis(0, 0, 10), MemBasis::Mixed);
    }

    /// The fallback contract, spelled out: when the private query fails the
    /// process contributes its RESIDENT bytes and is counted as degraded — not
    /// zero, and not some other quantity silently swapped in. When both reads
    /// fail the process is counted in `omitted` so the gap is reported instead
    /// of reading as a small total.
    #[test]
    fn fallback_is_explicit_never_silent_zero() {
        // Private read fails for every process: resident fallback, all counted.
        let all_fallback = rollup(
            ProcMem::ResidentFallback(40 * 1_048_576),
            &[ProcMem::ResidentFallback(60 * 1_048_576)],
        );
        assert_eq!(all_fallback.own_bytes, 40 * 1_048_576);
        assert_eq!(all_fallback.webview_bytes, 60 * 1_048_576);
        assert_eq!(all_fallback.total_bytes(), 100 * 1_048_576);
        assert_eq!(
            (
                all_fallback.private,
                all_fallback.fallback,
                all_fallback.omitted
            ),
            (0, 2, 0)
        );
        // The degraded basis is what the UI is told to render.
        assert_eq!(all_fallback.basis(), MemBasis::ResidentWorkingSet);

        // The fallback carries the bytes through: a failed private read must not
        // read as zero memory.
        assert_ne!(all_fallback.total_bytes(), 0);

        // Private works for the backend but not for one webview: the total
        // keeps both real numbers and the basis says "mixed" rather than
        // quietly claiming a clean private read.
        let split = rollup(
            ProcMem::Private(10 * 1_048_576),
            &[
                ProcMem::ResidentFallback(20 * 1_048_576),
                ProcMem::Unavailable,
            ],
        );
        assert_eq!(split.total_bytes(), 30 * 1_048_576);
        assert_eq!((split.private, split.fallback, split.omitted), (1, 1, 1));
        assert_eq!(split.basis(), MemBasis::Mixed);

        // Both reads fail: the unreadable process is reported, not swallowed.
        let dead = rollup(
            ProcMem::Unavailable,
            &[ProcMem::Unavailable, ProcMem::Private(8 * 1_048_576)],
        );
        assert_eq!(dead.omitted, 2);
        assert_eq!(dead.total_bytes(), 8 * 1_048_576);
        assert_eq!(dead.basis(), MemBasis::Mixed);

        // Empty tree: nothing read, nothing claimed.
        let empty = rollup(ProcMem::Unavailable, &[]);
        assert_eq!(empty.total_bytes(), 0);
        assert_eq!(empty.basis(), MemBasis::Mixed);
    }

    #[test]
    fn ring_evicts_oldest() {
        let mut buf = VecDeque::new();
        for i in 0..5 {
            push_sample(&mut buf, s(i, i as f64, 0.0), 3);
        }
        assert_eq!(buf.len(), 3);
        assert_eq!(buf[0].t, 2);
        assert_eq!(buf[2].t, 4);
        // Zero cap never stores.
        let mut z = VecDeque::new();
        push_sample(&mut z, s(0, 1.0, 1.0), 0);
        assert!(z.is_empty());
    }

    #[test]
    fn summarize_table() {
        let e = summarize(&[]);
        assert_eq!((e.current, e.min, e.max, e.avg), (0.0, 0.0, 0.0, 0.0));
        let one = summarize(&[42.0]);
        assert_eq!(
            (one.current, one.min, one.max, one.avg),
            (42.0, 42.0, 42.0, 42.0)
        );
        let m = summarize(&[10.0, 20.0, 30.0]);
        assert_eq!(m.current, 30.0);
        assert_eq!(m.min, 10.0);
        assert_eq!(m.max, 30.0);
        assert!((m.avg - 20.0).abs() < 1e-9);
    }

    #[test]
    fn pause_truth_table() {
        assert!(!should_pause_sampling(false, false));
        assert!(!should_pause_sampling(false, true));
        assert!(!should_pause_sampling(true, false));
        assert!(should_pause_sampling(true, true));
    }

    #[test]
    fn webview_exe_allowlist() {
        assert!(is_recon_webview("msedgewebview2.exe"));
        assert!(is_recon_webview("MSEDGEWEBVIEW2.EXE"));
        // Anything else never matches: user's browsers + our own backend.
        for exe in [
            "chrome.exe",
            "brave.exe",
            "msedge.exe",
            "firefox.exe",
            "recon.exe",
            "",
            "webview2.exe",
        ] {
            assert!(!is_recon_webview(exe), "exe: {exe}");
        }
    }

    #[test]
    fn tree_attributes_own_webviews_only() {
        // Mock tree: own PID 100 (recon.exe), two renderer children (one
        // nested grandchild), a non-webview child, and a foreign subtree.
        let entries = vec![
            e(100, 1, "recon.exe"),
            e(101, 100, "msedgewebview2.exe"),
            e(102, 100, "notepad.exe"),
            e(103, 101, "msedgewebview2.exe"),
            e(104, 999, "msedgewebview2.exe"),
            e(105, 104, "msedgewebview2.exe"),
            e(999, 1, "brave.exe"),
        ];
        assert_eq!(recon_webview_pids(&entries, 100), vec![101, 103]);
        // Unknown PID owns nothing.
        assert!(recon_webview_pids(&entries, 4242).is_empty());
        // Empty table attributes nothing.
        assert!(recon_webview_pids(&[], 100).is_empty());
    }

    /// Pins the SCOPE the total claims, using the shape proven live
    /// 2026-09-26: one browser host + GPU + two utility services + crashpad
    /// handler + one renderer per window, all siblings under the host, plus a
    /// whole foreign WebView2 environment (SearchHost/Widgets) on the
    /// machine. Every one of ours is included — the exe test has no
    /// `--type=` notion, so a future "only count renderers" tweak would
    /// silently shrink the number; and none of the foreign one is, which is
    /// the difference between ~880 MiB and a machine-wide sum.
    #[test]
    fn tree_counts_helpers_not_just_renderers() {
        let entries = vec![
            e(20380, 4500, "recon.exe"),
            // ours: browser host (child of the backend) + its whole helper set
            e(22496, 20380, "msedgewebview2.exe"),
            e(27104, 22496, "msedgewebview2.exe"), // gpu-process
            e(18528, 22496, "msedgewebview2.exe"), // network service
            e(25756, 22496, "msedgewebview2.exe"), // storage service
            e(10748, 22496, "msedgewebview2.exe"), // crashpad-handler
            e(10076, 22496, "msedgewebview2.exe"), // renderer
            e(14992, 22496, "msedgewebview2.exe"), // renderer
            e(20328, 22496, "msedgewebview2.exe"), // renderer
            // foreign: a second WebView2 environment elsewhere on the box
            e(11116, 10396, "msedgewebview2.exe"),
            e(11988, 11116, "msedgewebview2.exe"),
            e(12260, 11116, "msedgewebview2.exe"),
            e(10396, 1516, "SearchHost.exe"),
        ];
        assert_eq!(
            recon_webview_pids(&entries, 20380),
            vec![22496, 27104, 18528, 25756, 10748, 10076, 14992, 20328]
        );
        // The foreign host is a msedgewebview2.exe too — only the tree walk
        // keeps it out. If this ever fails, the total is summing system-wide.
        assert!(!recon_webview_pids(&entries, 20380).contains(&11116));
    }
