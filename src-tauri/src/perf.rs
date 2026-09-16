//! Dev-only Recon footprint timeline (backend private bytes + CPU %, own
//! WebViews private bytes).
//!
//! Full footprint, not backend-only: the backend process plus ONLY Recon's
//! own WebView2 renderers (main/dev/overlay/trn-proxy windows), attributed by
//! process tree — descendants of our own PID whose exe is
//! msedgewebview2.exe. System-wide WebViews are excluded by construction
//! (different exes + outside our tree: the user's Chromium/Brave/other apps
//! can never match). Proven live 2026-09-16: our subtree (browser 15648 +
//! renderers incl. a 171 MiB GPU/renderer child) vs the foreign Widgets
//! subtree (9424) — scope verified, foreign excluded.
//!
//! Metric is PRIVATE bytes (committed, process-exclusive), matching Task
//! Manager's Memory column. Full working sets were tried first and
//! double-counted Edge's shared pages once per process (~386 MiB shown vs
//! ~150 MiB real) — never sum working sets across Chromium processes.
//!
//! The dashboard polls `perf_poll` every 5s (dev builds only); the backend pushes one sample per call into a 720-slot (1h) ring
//! and returns the timeline for SVG sparklines. Sampling pauses while
//! Valorant owns the screen (FPS-first: even one syscall per 5s is skipped
//! mid-match).
//!
//! Dev-only: every static + the sampler body is `#[cfg(debug_assertions)]`;
//! release builds keep a stub command returning `Err` — zero buffer, zero
//! syscalls. Matches the `trn_trace!` gating convention in trn_proxy.rs.

use std::collections::VecDeque;
use std::sync::Mutex;

/// 1h ring at the dashboard's 5s poll cadence (720 × 5s).
pub const PERF_RING_CAP: usize = 720;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct PerfSample {
    /// Unix epoch seconds.
    pub t: u64,
    /// Backend process private bytes in MiB.
    pub rss_mb: f64,
    /// Recon's own WebView2 renderers private bytes in MiB (tree-attributed).
    pub webview_mb: f64,
    /// rss_mb + webview_mb (the prominent series).
    pub total_mb: f64,
    /// Backend CPU as % of total machine (all cores), clamped 0–100.
    pub cpu_pct: f64,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct PerfStats {
    pub current: f64,
    pub min: f64,
    pub max: f64,
    pub avg: f64,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct PerfTimeline {
    pub samples: Vec<PerfSample>,
    pub paused: bool,
    pub rss: PerfStats,
    pub webview: PerfStats,
    pub total: PerfStats,
    pub cpu: PerfStats,
}

/// % of total machine CPU from a GetProcessTimes delta (100ns units) over
/// `wall_secs` on `num_cpus`. Pure — unit-tested.
pub fn cpu_pct_from_deltas(proc_100ns: u64, wall_secs: f64, num_cpus: usize) -> f64 {
    if wall_secs <= 0.0 || num_cpus == 0 {
        return 0.0;
    }
    let pct = (proc_100ns as f64 / 10_000_000.0) / (wall_secs * num_cpus as f64) * 100.0;
    pct.clamp(0.0, 100.0)
}

/// Bytes → MiB. Pure — unit-tested.
pub fn rss_mb_from_bytes(bytes: u64) -> f64 {
    bytes as f64 / 1_048_576.0
}

/// Push one sample, evicting the oldest past `cap`. Pure — unit-tested.
pub fn push_sample(buf: &mut VecDeque<PerfSample>, s: PerfSample, cap: usize) {
    if cap == 0 {
        return;
    }
    while buf.len() >= cap {
        buf.pop_front();
    }
    buf.push_back(s);
}

/// current/min/max/avg over `vals` (current = last). Empty → zeros.
/// Pure — unit-tested.
pub fn summarize(vals: &[f64]) -> PerfStats {
    if vals.is_empty() {
        return PerfStats {
            current: 0.0,
            min: 0.0,
            max: 0.0,
            avg: 0.0,
        };
    }
    let mut min = vals[0];
    let mut max = vals[0];
    let mut sum = 0.0;
    for &v in vals {
        if v < min {
            min = v;
        }
        if v > max {
            max = v;
        }
        sum += v;
    }
    PerfStats {
        current: vals[vals.len() - 1],
        min,
        max,
        avg: sum / vals.len() as f64,
    }
}

/// FPS-first: skip sampling while the game owns the screen. Pure (facts
/// injected) — unit-tested. Same focus-only predicate family as
/// trn_proxy::should_pause, minus the phase (resources have no lobby fill).
pub fn should_pause_sampling(game_present: bool, game_foreground: bool) -> bool {
    game_present && game_foreground
}

/// One process-table row for tree attribution. Pure data — unit tests build
/// mock trees from these without touching the snapshot API.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcEntry {
    pub pid: u32,
    pub ppid: u32,
    pub exe: String,
}

/// True iff `exe` is a WebView2 renderer process. Exact filename, case
/// insensitive — the user's Chromium/Brave/other apps have different exes
/// and never match. Pure — unit-tested.
pub fn is_recon_webview(exe: &str) -> bool {
    exe.eq_ignore_ascii_case("msedgewebview2.exe")
}

/// PIDs of Recon's own WebView2 renderers: descendants of `own_pid` whose
/// exe is msedgewebview2.exe. Pure (tree injected) — unit-tested with mocks.
pub fn recon_webview_pids(entries: &[ProcEntry], own_pid: u32) -> Vec<u32> {
    use std::collections::HashSet;
    // ponytail: fixpoint BFS, no depth constant to tune — trees are tiny.
    let mut in_tree = HashSet::from([own_pid]);
    loop {
        let n = in_tree.len();
        for e in entries {
            if in_tree.contains(&e.ppid) {
                in_tree.insert(e.pid);
            }
        }
        if in_tree.len() == n {
            break;
        }
    }
    entries
        .iter()
        .filter(|e| e.pid != own_pid && in_tree.contains(&e.pid) && is_recon_webview(&e.exe))
        .map(|e| e.pid)
        .collect()
}

#[cfg(debug_assertions)]
static PERF_BUF: Mutex<VecDeque<PerfSample>> = Mutex::new(VecDeque::new());
#[cfg(debug_assertions)]
static PERF_LAST: Mutex<Option<(u64, std::time::Instant)>> = Mutex::new(None);

#[cfg(all(debug_assertions, windows))]
fn filetime_u64(ft: &windows::Win32::Foundation::FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

/// Full process table via Toolhelp32Snapshot (windows crate, zero new deps).
/// Fail-open: any snapshot error yields an empty table (webviews read 0).
#[cfg(all(debug_assertions, windows))]
fn snapshot_entries() -> Vec<ProcEntry> {
    use windows::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    unsafe {
        let snap = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return out,
        };
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: PROCESSENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;
        if Process32First(snap, &mut entry).is_ok() {
            loop {
                // szExeFile is CHAR (i8): ASCII filename, NUL-terminated.
                let raw: Vec<u8> = entry
                    .szExeFile
                    .iter()
                    .take_while(|&&c| c != 0)
                    .map(|&c| c as u8)
                    .collect();
                out.push(ProcEntry {
                    pid: entry.th32ProcessID,
                    ppid: entry.th32ParentProcessID,
                    exe: String::from_utf8_lossy(&raw).into_owned(),
                });
                if Process32Next(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

/// Private bytes of one PID (committed, process-exclusive) — matches Task
/// Manager's Memory column. Full working sets double-count Edge's shared
/// pages once per process, so they are deliberately NOT used here.
/// Fail-open (None on any error — a renderer that exits mid-poll reads as
/// gone, not as a failed sample).
#[cfg(all(debug_assertions, windows))]
fn private_bytes_of_pid(pid: u32) -> Option<u64> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid).ok()?;
        let mut counters: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
        let bytes = GetProcessMemoryInfo(
            h,
            &mut counters as *mut _ as *mut _,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        )
        .ok()
        .map(|_| counters.PrivateUsage as u64);
        let _ = CloseHandle(h);
        bytes
    }
}

/// Summed private bytes of Recon's own WebView2 renderers. Fail-open 0.
#[cfg(all(debug_assertions, windows))]
fn recon_webview_private_bytes() -> u64 {
    use windows::Win32::System::Threading::GetCurrentProcessId;
    let own = unsafe { GetCurrentProcessId() };
    recon_webview_pids(&snapshot_entries(), own)
        .into_iter()
        .filter_map(private_bytes_of_pid)
        .sum()
}

/// One own-process sample: private bytes via GetProcessMemoryInfo, CPU % from
/// GetProcessTimes deltas over a monotonic wall clock. First call reports
/// 0% CPU (no delta yet). None when the counters are unreadable.
#[cfg(debug_assertions)]
fn sample_once() -> Option<PerfSample> {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::FILETIME;
        use windows::Win32::System::ProcessStatus::{
            GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX,
        };
        use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
        unsafe {
            let h = GetCurrentProcess();
            let mut counters: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
            GetProcessMemoryInfo(
                h,
                &mut counters as *mut _ as *mut _,
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            )
            .ok()?;
            let mut _ft_c: FILETIME = std::mem::zeroed();
            let mut _ft_e: FILETIME = std::mem::zeroed();
            let mut ft_k: FILETIME = std::mem::zeroed();
            let mut ft_u: FILETIME = std::mem::zeroed();
            GetProcessTimes(h, &mut _ft_c, &mut _ft_e, &mut ft_k, &mut ft_u).ok()?;
            let total = filetime_u64(&ft_k).wrapping_add(filetime_u64(&ft_u));
            let now = std::time::Instant::now();
            let cpus = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1);
            let mut last = PERF_LAST.lock().ok()?;
            let cpu_pct = match *last {
                Some((prev_total, prev_now)) => {
                    let wall = now.duration_since(prev_now).as_secs_f64();
                    // ponytail: wall comes from Instant (monotonic); a 0 wall
                    // means a double-sample in one tick — report 0, not inf.
                    cpu_pct_from_deltas(total.wrapping_sub(prev_total), wall, cpus)
                }
                None => 0.0,
            };
            *last = Some((total, now));
            let rss_mb = rss_mb_from_bytes(counters.PrivateUsage as u64);
            let webview_mb = rss_mb_from_bytes(recon_webview_private_bytes());
            Some(PerfSample {
                t,
                rss_mb,
                webview_mb,
                total_mb: rss_mb + webview_mb,
                cpu_pct,
            })
        }
    }
    #[cfg(not(windows))]
    {
        let _ = t;
        None
    }
}

/// Dev-only timeline poll: one own-process sample per call (5s frontend
/// cadence), 1h ring, FPS-first pause. Release stub carries zero cost.
#[tauri::command]
pub fn perf_poll() -> Result<PerfTimeline, String> {
    #[cfg(not(debug_assertions))]
    {
        return Err("dev only".to_string());
    }
    #[cfg(debug_assertions)]
    {
        let paused = should_pause_sampling(
            crate::window_manager::find_valorant_game_window().is_some(),
            crate::window_manager::is_valorant_foreground(),
        );
        let mut buf = PERF_BUF.lock().map_err(|e| format!("perf lock: {e}"))?;
        if !paused {
            if let Some(s) = sample_once() {
                push_sample(&mut buf, s, PERF_RING_CAP);
            }
        }
        let rss_vals: Vec<f64> = buf.iter().map(|s| s.rss_mb).collect();
        let wv_vals: Vec<f64> = buf.iter().map(|s| s.webview_mb).collect();
        let tot_vals: Vec<f64> = buf.iter().map(|s| s.total_mb).collect();
        let cpu_vals: Vec<f64> = buf.iter().map(|s| s.cpu_pct).collect();
        Ok(PerfTimeline {
            samples: buf.iter().cloned().collect(),
            paused,
            rss: summarize(&rss_vals),
            webview: summarize(&wv_vals),
            total: summarize(&tot_vals),
            cpu: summarize(&cpu_vals),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(t: u64, rss: f64, cpu: f64) -> PerfSample {
        PerfSample {
            t,
            rss_mb: rss,
            webview_mb: 0.0,
            total_mb: rss,
            cpu_pct: cpu,
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

    #[test]
    fn rss_math() {
        assert!((rss_mb_from_bytes(1_048_576) - 1.0).abs() < 1e-9);
        assert_eq!(rss_mb_from_bytes(0), 0.0);
        assert!((rss_mb_from_bytes(256 * 1_048_576) - 256.0).abs() < 1e-9);
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
}
