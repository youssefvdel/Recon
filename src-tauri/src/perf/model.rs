//! Pure model: samples, memory bases, rollups and derivations.
//!
//! No I/O, no Win32, no statics — every function here is a function of its
//! arguments, and all of it is unit-tested in `perf/tests.rs`.

use std::collections::VecDeque;

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
