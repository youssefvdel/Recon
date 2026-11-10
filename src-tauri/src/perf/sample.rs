//! The sampler: one Win32/PDH pass over Recon and its own WebView2 tree.

use super::model::*;

// Debug-only sampler state (ring buffer, last CPU totals, PDH scratch). The
// statics below are `#[cfg(debug_assertions)]`, so in a release build these
// imports would be dead — but `cargo test --lib` is a DEBUG build and CI runs
// it, so they are required there. Gated with their users, not left unconditional.
#[cfg(debug_assertions)]
use std::collections::VecDeque;
#[cfg(debug_assertions)]
use std::sync::Mutex;

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
