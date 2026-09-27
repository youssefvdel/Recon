//! Dev-only Recon footprint timeline (backend + own WebViews resident bytes,
//! and CPU %).
//!
//! Full footprint, not backend-only: the backend process plus ONLY Recon's
//! own WebView2 process tree (main/dev/overlay/trn-proxy windows), attributed
//! by process tree — descendants of our own PID whose exe is
//! msedgewebview2.exe. That covers the whole set, not just renderers: one
//! browser host, its GPU process, its network/storage services, the crashpad
//! handler, and one renderer per window. System-wide WebViews are excluded by
//! construction (different exes + outside our tree: the user's Chromium/Brave/
//! other apps can never match). Re-verified live 2026-09-26: our 10-process
//! subtree (recon.exe 28304 + browser host 5776 + 8 helpers) vs two foreign
//! WebView2 environments on the same box (QuotaVPN 6, SearchHost 6) — scope
//! verified, both foreign sets excluded, zero orphans.
//!
//! The metric is Task Manager's "Memory" column: private working set, summed
//! over the tree. It used to be `PrivateUsage` (private COMMIT charge — pages
//! reserved whether or not they are resident), which read ~750 MiB against
//! Task Manager's ~105 MB for the same tree. Commit is what the app costs the
//! pagefile; resident is what it costs RAM, and a user reading a memory number
//! means resident.
//!
//! CPU covers the SAME set as memory — backend + every `msedgewebview2.exe` in
//! our own tree — for the same reason. It used to read `GetProcessTimes` on the
//! backend handle alone, so the chart was `recon.exe` by itself while the
//! WebView2 renderers, which are where a React app actually burns CPU, were
//! invisible. Measured 2026-09-26 over one 5s window on this box: the dashboard
//! read 0.23% for the backend while the 10-process tree burned 3359 ms of CPU
//! = 5.59% of a 12-core machine, one renderer alone accounting for 2469 ms of
//! it. Same class of bug as the memory one: the number was right about the
//! wrong set of processes.
//!
//! Private working set comes from `\Process(*)\Working Set - Private`, the PDH
//! counter Task Manager's own Memory column is computed from, so a tree sum here
//! is directly comparable to the Recon + WebView2 group total there. PIDs come
//! from a second wildcard counter (`\Process(*)\ID Process`) matched to the
//! first by instance index, with the instance names compared as a guard.
//!
//! DEAD END, recorded so nobody re-derives it: the per-page route
//! (`PSAPI_WORKING_SET_EX_INFORMATION`, ShareCount in bits 1-3 of
//! `VirtualAttributes`) does not work on this machine. Measured 2026-09-26:
//! `psapi!QueryWorkingSetEx` returns TRUE and writes NOTHING at any buffer size,
//! and `NtQueryInformationProcess` class 77 answers
//! `STATUS_INFO_LENGTH_MISMATCH` to both a 16-byte probe and a
//! working-set-sized buffer, while neighbouring classes size normally
//! (76 -> 432 bytes, 82 -> 16, 85 -> 16746) — so the probe was sound and the
//! class is simply not implemented in this kernel. The quantity is available
//! through PDH regardless.
//!
//! When PDH cannot be read the sample degrades, and says so instead of quietly
//! substituting a different number:
//!   * `MemBasis::PrivateWorkingSet` — every process read from the private
//!     counter. Task Manager's quantity.
//!   * `MemBasis::ResidentWorkingSet` — PDH unavailable, so a process falls
//!     back to its full resident working set. Still resident, never commit, but
//!     it includes pages shared with other processes and with system DLLs, so
//!     summing it over a tree counts those pages once per process and reads
//!     HIGH (~1.6-2x on this box). The dashboard shows a degraded marker.
//!   * `MemBasis::Mixed` — some processes on each basis, or some unreadable.
//!     `omitted` carries the unreadable count so a gap is never a silent zero.
//! Commit is not read at all any more, so no basis can silently substitute it.
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
    /// Backend process resident working set in MiB.
    pub rss_mb: f64,
    /// Recon's own WebView2 process tree resident working set in MiB
    /// (tree-attributed). The whole set — browser host, GPU, renderers,
    /// services, crashpad — not renderers alone.
    pub webview_mb: f64,
    /// rss_mb + webview_mb: resident bytes across 1 + N processes. Read
    /// `basis` before comparing it to anything — on the fallback basis it is
    /// a summed FULL working set and reads high.
    pub total_mb: f64,
    /// Backend CPU as % of total machine (all cores), clamped 0–100.
    pub cpu_pct: f64,
    /// Processes the `cpu_pct` figure covers: the backend plus every
    /// `msedgewebview2.exe` in our own tree — the same set `webview_mb` covers.
    pub cpu_processes: u32,
    /// Tree processes whose CPU times could NOT be read this sample. Non-zero
    /// means `cpu_pct` is an UNDER-count, and the gap is reported rather than
    /// folded in as zero. Same discipline as the memory `omitted`.
    pub cpu_omitted: u32,
    /// Which metric the three numbers above were actually measured from.
    /// Serialised so the UI can refuse to present a degraded total as a clean
    /// one.
    pub basis: MemBasis,
    /// Processes in the tree that could not be read on ANY basis. Reported, not
    /// folded into the total as zero.
    pub omitted: u32,
}

/// What a sample's memory numbers were measured from. The dashboard must render
/// this: a number on the wrong basis shown as though it were on the right one is
/// exactly the bug this type exists to prevent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum MemBasis {
    /// Private working set (resident, `ShareCount == 0` pages) for every
    /// process in the tree — Task Manager's "Memory" column, summed.
    PrivateWorkingSet,
    /// The working-set-ex class is unavailable here, so every readable process
    /// fell back to its full resident working set. Resident, never commit — but
    /// it includes pages shared with other processes and system DLLs, so summed
    /// over a tree it double-counts them and reads HIGH.
    ResidentWorkingSet,
    /// Not a clean read: some processes on one basis and some on the other, or
    /// some unreadable entirely. Carries the gap in `omitted`; never presented
    /// as either clean basis.
    Mixed,
}

/// One process's resident bytes and how they were obtained.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcMem {
    /// Private working set: `ShareCount == 0` pages x page size.
    Private(u64),
    /// The working-set-ex query failed for this process; these are its FULL
    /// resident working set bytes instead — documented, cheap, resident, but
    /// includes shared pages.
    ResidentFallback(u64),
    /// Neither counter could be read (access denied, or the process exited
    /// mid-poll). Counted as omitted; never a silent zero.
    Unavailable,
}

/// Summed memory for the backend plus its WebView2 tree, and the census needed
/// to name the basis honestly.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TreeMem {
    pub own_bytes: u64,
    pub webview_bytes: u64,
    /// Processes read on the private-working-set basis.
    pub private: u32,
    /// Processes read on the resident-fallback basis.
    pub fallback: u32,
    /// Processes that could not be read at all.
    pub omitted: u32,
}

impl TreeMem {
    pub fn total_bytes(&self) -> u64 {
        self.own_bytes.saturating_add(self.webview_bytes)
    }
    pub fn basis(&self) -> MemBasis {
        mem_basis(self.private, self.fallback, self.omitted)
    }
}

/// One outcome as `(bytes, private, fallback, omitted)`. Pure.
fn tally(p: ProcMem) -> (u64, u32, u32, u32) {
    match p {
        ProcMem::Private(b) => (b, 1, 0, 0),
        ProcMem::ResidentFallback(b) => (b, 0, 1, 0),
        ProcMem::Unavailable => (0, 0, 0, 1),
    }
}

/// Sum per-process outcomes into the backend / webview split. Pure — unit-tested
/// with mock outcomes, no syscall involved.
pub fn rollup(own: ProcMem, webviews: &[ProcMem]) -> TreeMem {
    let (ob, op, of, oo) = tally(own);
    let mut m = TreeMem {
        own_bytes: ob,
        webview_bytes: 0,
        private: op,
        fallback: of,
        omitted: oo,
    };
    for p in webviews {
        let (b, pv, fb, om) = tally(*p);
        m.webview_bytes = m.webview_bytes.saturating_add(b);
        m.private += pv;
        m.fallback += fb;
        m.omitted += om;
    }
    m
}

/// Name the basis for a census of per-process outcomes. Only an all-private
/// read is `PrivateWorkingSet`; an all-fallback read is the degraded
/// `ResidentWorkingSet`; everything else — including nothing readable at all —
/// is `Mixed`, so no gap is ever labelled clean. Pure — unit-tested.
pub fn mem_basis(private: u32, fallback: u32, omitted: u32) -> MemBasis {
    match (private > 0, fallback > 0, omitted > 0) {
        (true, false, false) => MemBasis::PrivateWorkingSet,
        (false, true, false) => MemBasis::ResidentWorkingSet,
        _ => MemBasis::Mixed,
    }
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
/// `wall_secs` on `num_cpus`. `proc_100ns` is the SUM of kernel+user across the
/// whole measured process set, never a per-process figure and never an average:
/// the clamp is 0–100 of the machine, so a value that is already a machine-wide
/// fraction must not be normalised twice. Pure — unit-tested.
pub fn cpu_pct_from_deltas(proc_100ns: u64, wall_secs: f64, num_cpus: usize) -> f64 {
    if wall_secs <= 0.0 || num_cpus == 0 {
        return 0.0;
    }
    let pct = (proc_100ns as f64 / 10_000_000.0) / (wall_secs * num_cpus as f64) * 100.0;
    pct.clamp(0.0, 100.0)
}

/// Census of one CPU sample: how many processes it set out to cover, and how
/// many it could not read. Mirrors `TreeMem`'s `omitted` discipline — a process
/// that cannot be read is reported, never treated as a process that burned no
/// CPU.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CpuCensus {
    /// Backend + tree processes in the sample.
    pub processes: u32,
    /// How many of them could not be read. Non-zero means the percentage this
    /// sample produced is LOW by an unknown amount.
    pub omitted: u32,
}

/// `pid -> kernel+user 100ns since process start`, for the backend + every
/// WebView2 process in our own tree. Cumulative per PID, NOT summed: see
/// [`cpu_delta_100ns`] for why the sum is the wrong shape to subtract.
pub type CpuTimes = std::collections::BTreeMap<u32, u64>;

/// CPU actually burned between two samples, in 100ns units.
///
/// Only PIDs present in BOTH samples contribute. A renderer that appeared since
/// the last poll has no baseline and contributes 0 for this interval; one that
/// exited simply stops contributing. Subtracting the two totals instead would be
/// wrong in both directions — a new renderer inflates the sum by its whole
/// lifetime, and an exiting (or PID-reused) one makes the subtraction go
/// negative, which on `u64` wraps to ~1.8e19 and clamps the chart to a flat
/// 100%. Pure — unit-tested.
pub fn cpu_delta_100ns(prev: &CpuTimes, now: &CpuTimes) -> u64 {
    let mut total: u64 = 0;
    for (pid, cur) in now {
        if let Some(before) = prev.get(pid) {
            total = total.saturating_add(cur.saturating_sub(*before));
        }
    }
    total
}

/// Count what a sample covered and what it lost, from per-process read outcomes.
/// `None` = that process's times could not be read. Pure — unit-tested with
/// mock outcomes, no syscall involved.
pub fn rollup_cpu(own: Option<u64>, webviews: &[Option<u64>]) -> CpuCensus {
    let omitted = u32::from(own.is_none()) + webviews.iter().filter(|p| p.is_none()).count() as u32;
    CpuCensus {
        processes: 1 + webviews.len() as u32,
        omitted,
    }
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

/// Kernel+user CPU time of one PID since process start, in 100ns units.
///
/// `PROCESS_QUERY_LIMITED_INFORMATION` rather than the full-query right the
/// memory path opens: it is the minimum GetProcessTimes needs and is granted
/// more widely, so a renderer that would refuse a full query still reports
/// instead of being counted as omitted. One open/read/close per process on the
/// 5s poll path — ~12 handles every 5s, which is nothing; the expensive pass on
/// that path is the PDH wildcard read, and CPU deliberately does NOT ride it
/// (see the module header on why the CPU headline must stay at 5s).
///
/// PDH could have supplied this from `\Process(*)\% Processor Time`, but it was
/// not used: that counter is already a rate over PDH's own window, its Windows
/// value is per-CORE (so a tree sum needs a second normalisation the memory
/// metric does not, and getting that wrong is exactly the "silently changed
/// the unit" failure), and the only persistent PDH query here is the 20s
/// private-working-set one, which would have made the CPU number the user is
/// comparing against Task Manager up to 20s stale. GetProcessTimes keeps the
/// existing 5s cadence and the existing, already-tested formula. None on any
/// error: a process that exited mid-poll is `None`, not zero.
#[cfg(all(debug_assertions, windows))]
fn cpu_100ns_of_pid(pid: u32) -> Option<u64> {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut created: FILETIME = std::mem::zeroed();
        let mut exited: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        let read = GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user).ok();
        let _ = CloseHandle(h);
        read.map(|()| filetime_u64(&kernel).wrapping_add(filetime_u64(&user)))
    }
}

/// One CPU sample over the backend + tree: per-PID cumulative totals plus the
/// census of what that sample could and could not read. `None` (unreadable) is
/// dropped from the map and counted in the census — never inserted as 0, which
/// would erase the whole interval of work that process actually did.
#[cfg(all(debug_assertions, windows))]
fn cpu_tree_times(own: u32, webviews: &[u32]) -> (CpuTimes, CpuCensus) {
    let own_read = cpu_100ns_of_pid(own);
    let webview_reads: Vec<Option<u64>> =
        webviews.iter().map(|&pid| cpu_100ns_of_pid(pid)).collect();
    let mut times = CpuTimes::new();
    if let Some(v) = own_read {
        times.insert(own, v);
    }
    for (&pid, read) in webviews.iter().zip(&webview_reads) {
        if let Some(v) = *read {
            times.insert(pid, v);
        }
    }
    (times, rollup_cpu(own_read, &webview_reads))
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

/// PIDs of Recon's own WebView2 processes: descendants of `own_pid` whose
/// exe is msedgewebview2.exe. The exe test has no `--type=` notion, so the
/// browser host, GPU process, network/storage services and crashpad handler
/// are all included alongside the per-window renderers — the sum is the whole
/// tree, deliberately. Pure (tree injected) — unit-tested with mocks.
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
/// Previous sample's per-PID CPU totals plus its monotonic clock. Per PID, not
/// one summed total — see `cpu_delta_100ns`.
#[cfg(debug_assertions)]
static PERF_LAST: Mutex<Option<(CpuTimes, std::time::Instant)>> = Mutex::new(None);

/// Minimum interval between private-working-set passes. A pass opens a PDH query
/// and reads two wildcard counter arrays covering EVERY process on the box
/// (~300 instances; both reads measured at 22 ms), so it must not ride the 5s
/// poll path. 20s keeps a dev sparkline well inside its own resolution at one
/// pass per four polls, and the cheap per-process resident pass still runs every
/// poll to carry the series in between.
/// ponytail: ceiling is a private-WS headline up to 20s stale; lower it if the
/// number ever needs to be fresher than the chart's cadence.
#[cfg(all(debug_assertions, windows))]
const PRIV_WS_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(20);

/// Last private-working-set pass and its result, so the PDH read runs at
/// `PRIV_WS_MIN_INTERVAL` and a successful rollup is reused between passes.
#[cfg(all(debug_assertions, windows))]
struct PrivWsCache {
    last_try: Option<std::time::Instant>,
    /// `None` until a private pass succeeds, and again if one later fails.
    last: Option<TreeMem>,
}
#[cfg(all(debug_assertions, windows))]
static PRIV_WS: Mutex<PrivWsCache> = Mutex::new(PrivWsCache {
    last_try: None,
    last: None,
});

/// Grow-only PDH output buffer, reused across passes. One allocation for the life
/// of the process; the reused span is zeroed on every call.
#[cfg(all(debug_assertions, windows))]
static PDH_BUF: Mutex<Vec<u8>> = Mutex::new(Vec::new());

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

/// Resident working set of one PID in bytes —
/// `PROCESS_MEMORY_COUNTERS_EX.WorkingSetSize`. One call, no per-page data, so
/// it stays on the 5s poll path. It is RESIDENT (never commit, so it can never
/// over-report against Task Manager by the old 7x), but it includes pages shared
/// with other processes and with system DLLs — see the module header on why
/// summing it over a tree reads high. None on any error: a renderer that exits
/// mid-poll reads as unavailable, not as a failed sample.
#[cfg(all(debug_assertions, windows))]
fn resident_bytes_of_pid(pid: u32) -> Option<u64> {
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
        .map(|_| counters.WorkingSetSize as u64);
        let _ = CloseHandle(h);
        bytes
    }
}

/// PDH ("Performance Data Helper") is used directly rather than through the
/// `windows` crate: the `Win32_Performance` feature is not enabled for this
/// crate, and the project must not gain dependencies. These are plain OS imports
/// linked against `pdh.dll`, the same pattern `lib.rs` already uses for
/// `SetProcessWorkingSetSize`. `PDH_STATUS` is a signed 32-bit code; 0 is success.
#[cfg(all(debug_assertions, windows))]
mod pdh {
    /// Buffer too small — PDH rewrites the size argument with what it needs.
    pub const MORE_DATA: i32 = 0x800007D2u32 as i32;
    /// `PDH_FMT_COUNTERVALUE | PDH_FMT_LARGE`: raw 64-bit value, no scaling.
    pub const FMT: u32 = 0x0000_0C00;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub union ValueUnion {
        pub long_value: i64,
        pub double_value: f64,
        pub ansi_string: *mut u8,
        pub wide_string: *mut u16,
    }

    /// `PDH_FMT_COUNTERVALUE`: CValue, CStatus, then the value union. 16 bytes.
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct FormattedValue {
        pub c_value: u32,
        pub c_status: u32,
        pub value: ValueUnion,
    }

    /// `PDH_FMT_COUNTERVALUE_ITEM_W`: instance name (NUL-terminated UTF-16,
    /// pointing into the same output buffer) plus its value.
    #[repr(C)]
    pub struct FormattedItem {
        pub name: *mut u16,
        pub value: FormattedValue,
    }

    #[link(name = "pdh")]
    unsafe extern "system" {
        pub fn PdhOpenQueryW(user_data: isize, data_size: u32, query: *mut isize) -> i32;
        pub fn PdhCloseQuery(query: isize) -> i32;
        pub fn PdhAddEnglishCounterW(
            query: isize,
            path: *const u16,
            user_data: isize,
            counter: *mut isize,
        ) -> i32;
        pub fn PdhCollectQueryData(query: isize) -> i32;
        pub fn PdhGetFormattedCounterArrayW(
            counter: isize,
            format: u32,
            buffer_size: *mut u32,
            value_count: *mut u32,
            buffer: *mut u8,
        ) -> i32;
    }
}

/// NUL-terminated UTF-16 at `p`, or "" for null.
#[cfg(all(debug_assertions, windows))]
unsafe fn pdh_name_at(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut n = 0usize;
    while *p.add(n) != 0 {
        n += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(p, n))
}

/// One formatted wildcard counter array as `(instance name, value)` pairs. `None`
/// if PDH refuses, or keeps asking for more space than we will grow to.
#[cfg(all(debug_assertions, windows))]
fn pdh_read(counter: isize, buf: &mut Vec<u8>) -> Option<Vec<(String, i64)>> {
    use pdh::{FormattedItem, MORE_DATA};
    // Seed generously for ~300 processes; PDH's growth protocol rewrites `need`.
    let mut need: u32 = 96 * 1024;
    for _ in 0..6 {
        let want = need as usize;
        if buf.len() < want {
            buf.resize(want, 0);
        } else {
            buf[..want].fill(0);
        }
        let mut count: u32 = 0;
        let st = unsafe {
            pdh::PdhGetFormattedCounterArrayW(
                counter,
                pdh::FMT,
                &mut need,
                &mut count,
                buf.as_mut_ptr(),
            )
        };
        if st == MORE_DATA {
            continue;
        }
        if st != 0 {
            return None;
        }
        let stride = std::mem::size_of::<FormattedItem>();
        let mut out = Vec::with_capacity(count as usize);
        for i in 0..count as usize {
            let it = unsafe { (buf.as_ptr() as *const u8).add(i * stride) as *const FormattedItem };
            let (name, val) = unsafe { (pdh_name_at((*it).name), (*it).value.value.long_value) };
            out.push((name, val));
        }
        return Some(out);
    }
    None
}

/// Private working set for EVERY process on the box, keyed by PID:
/// `\Process(*)\Working Set - Private` — the same PDH counter Task Manager's
/// "Memory" column is computed from, so a tree sum of these is directly
/// comparable to the Recon + WebView2 group total there.
///
/// PIDs come from a second wildcard counter, `\Process(*)\ID Process`, paired with
/// the first by instance index. Instance names are compared as a guard: if the
/// two arrays disagree on any name, the pass is rejected rather than silently
/// attributing one process's memory to another. Process instance names collide
/// across this machine's several independent WebView2 environments, so
/// name-keyed matching is not safe here.
///
/// `None` when PDH cannot be read. Callers MUST fall back explicitly: a `None` is
/// never read as zero and never as commit.
#[cfg(all(debug_assertions, windows))]
fn private_ws_by_pid() -> Option<std::collections::HashMap<u32, u64>> {
    use pdh::{PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhOpenQueryW};
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let priv_path = wide(r"\Process(*)\Working Set - Private");
    let id_path = wide(r"\Process(*)\ID Process");
    let mut buf = PDH_BUF.lock().ok()?;
    unsafe {
        let mut query: isize = 0;
        if PdhOpenQueryW(0, 0, &mut query) != 0 {
            return None;
        }
        let mut c_priv: isize = 0;
        let mut c_id: isize = 0;
        let ready = PdhAddEnglishCounterW(query, priv_path.as_ptr(), 0, &mut c_priv) == 0
            && PdhAddEnglishCounterW(query, id_path.as_ptr(), 0, &mut c_id) == 0
            // A formatted read before any collection answers "no data".
            && PdhCollectQueryData(query) == 0;
        let privs = ready.then(|| pdh_read(c_priv, &mut buf)).flatten();
        let ids = ready.then(|| pdh_read(c_id, &mut buf)).flatten();
        let _ = PdhCloseQuery(query);
        let (privs, ids) = (privs?, ids?);
        if privs.len() != ids.len() {
            return None;
        }
        let mut map = std::collections::HashMap::with_capacity(privs.len());
        for ((pname, pval), (iname, ival)) in privs.iter().zip(ids.iter()) {
            if pname != iname || *ival <= 0 {
                continue;
            }
            map.insert(*ival as u32, (*pval).max(0) as u64);
        }
        (!map.is_empty()).then_some(map)
    }
}

/// One process on the best available basis: the private counter when PDH has it,
/// else that process's full resident working set, else omitted. Never commit.
#[cfg(all(debug_assertions, windows))]
fn mem_for_pid(pid: u32, priv_ws: &std::collections::HashMap<u32, u64>) -> ProcMem {
    match priv_ws.get(&pid) {
        Some(b) => ProcMem::Private(*b),
        None => resident_bytes_of_pid(pid)
            .map(ProcMem::ResidentFallback)
            .unwrap_or(ProcMem::Unavailable),
    }
}

/// One private pass over the backend + tree. `None` only when the private counter
/// itself is unreadable, in which case the whole sample degrades together.
#[cfg(all(debug_assertions, windows))]
fn try_private_ws_all(own: u32, webviews: &[u32]) -> Option<TreeMem> {
    let map = private_ws_by_pid()?;
    Some(rollup(
        mem_for_pid(own, &map),
        &webviews
            .iter()
            .map(|&pid| mem_for_pid(pid, &map))
            .collect::<Vec<_>>(),
    ))
}

/// Resident fallback for the backend + tree, every poll. Cheap, and the honest
/// answer when the private counter cannot be read.

#[cfg(all(debug_assertions, windows))]
fn resident_tree_mem(own: u32, webviews: &[u32]) -> TreeMem {
    rollup(
        resident_bytes_of_pid(own)
            .map(ProcMem::ResidentFallback)
            .unwrap_or(ProcMem::Unavailable),
        &webviews
            .iter()
            .map(|&pid| {
                resident_bytes_of_pid(pid)
                    .map(ProcMem::ResidentFallback)
                    .unwrap_or(ProcMem::Unavailable)
            })
            .collect::<Vec<_>>(),
    )
}

/// One memory sample for the backend + tree. The cheap resident pass runs every
/// poll; the private pass is attempted at `PRIV_WS_MIN_INTERVAL` and its result
/// reused in between.
#[cfg(all(debug_assertions, windows))]
fn sample_tree_mem(own: u32, webviews: &[u32]) -> TreeMem {
    let resident = resident_tree_mem(own, webviews);
    let mut cache = match PRIV_WS.lock() {
        Ok(c) => c,
        Err(_) => return resident,
    };
    let now = std::time::Instant::now();
    let due = cache
        .last_try
        .map_or(true, |t| now.duration_since(t) >= PRIV_WS_MIN_INTERVAL);
    if due {
        cache.last_try = Some(now);
        cache.last = try_private_ws_all(own, webviews);
    }
    // No successful private pass yet (or PDH is unreadable): the resident
    // fallback, reported on the basis that says so.
    cache.last.unwrap_or(resident)
}

/// One sample: memory for the backend + its WebView2 tree, CPU % for the SAME
/// set from GetProcessTimes deltas over a monotonic wall clock. One tree walk
/// (`snapshot_entries` + `recon_webview_pids`) feeds both, so CPU adds no
/// process-table cost to the poll. First call reports 0% CPU (no delta yet).
/// None when the counters are unreadable.
#[cfg(debug_assertions)]
fn sample_once() -> Option<PerfSample> {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::GetCurrentProcessId;
        let own = unsafe { GetCurrentProcessId() };
        // ONE tree walk, two metrics: memory and CPU both claim the same set,
        // so the process table is enumerated once per poll, not once per metric.
        let webviews = recon_webview_pids(&snapshot_entries(), own);
        let (cpu_times, census) = cpu_tree_times(own, &webviews);
        let cpu_pct = {
            let now = std::time::Instant::now();
            let cpus = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1);
            let mut last = PERF_LAST.lock().ok()?;
            let pct = match &*last {
                Some((prev, prev_now)) => {
                    let wall = now.duration_since(*prev_now).as_secs_f64();
                    // ponytail: wall comes from Instant (monotonic); a 0 wall
                    // means a double-sample in one tick — report 0, not inf.
                    cpu_pct_from_deltas(cpu_delta_100ns(prev, &cpu_times), wall, cpus)
                }
                None => 0.0,
            };
            *last = Some((cpu_times, now));
            pct
        };
        let m = sample_tree_mem(own, &webviews);
        Some(PerfSample {
            t,
            rss_mb: rss_mb_from_bytes(m.own_bytes),
            webview_mb: rss_mb_from_bytes(m.webview_bytes),
            total_mb: rss_mb_from_bytes(m.total_bytes()),
            cpu_pct,
            cpu_processes: census.processes,
            cpu_omitted: census.omitted,
            basis: m.basis(),
            omitted: m.omitted,
        })
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
}
