#![allow(dead_code)]
//! (moved verbatim from `trn_proxy.rs`; split only.)

use std::collections::VecDeque;
use std::sync::Mutex;
/// DEV-ONLY structured trace: `[TRN <epoch-ms>] …` on stderr (visible in the
/// `tauri dev` terminal). The codebase writes `log::*` elsewhere but
/// initializes no logger backend, so `log::debug!` would vanish even in dev.
/// Fully compiled out when `debug_assertions` are off: zero prod output, no
/// new deps. Never log a RESPONSE body (player names) — paths, phases,
/// statuses, and the page's own exception text only (see `trace_err`).
#[cfg(debug_assertions)]
macro_rules! trn_trace {
    ($($t:tt)*) => {{
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        // One capture point for every call site: stderr (what `tauri dev`
        // shows) AND the dev ring the dashboard reads. No call site had to
        // change to be visible in the UI.
        trace_emit(format!("[TRN {}] {}", ms, format!($($t)*)));
    }};
}
#[cfg(not(debug_assertions))]
macro_rules! trn_trace {
    ($($t:tt)*) => {
        ()
    };
}

/* ---- Dev trace ring: the same lines, readable in the dashboard ---- *
 * The trace used to live only in the `tauri dev` terminal. `trn_trace!`
 * now routes every line through `trace_emit` into a bounded ring that
 * `trn_trace_log` serves, so a TRN bug report no longer needs a
 * screenshot of a scrollback buffer. Written ONLY by the macro, which
 * is compiled out of release — the release ring therefore stays empty
 * forever (one never-allocated `VecDeque`), and the command answers
 * "no lines" instead of erroring. */
/// Recent trace lines held for the DevDashboard readout.
///
/// A full lobby fill is ~25 requests × ~5 lines ≈ 125 lines inside a few
/// seconds, and the dashboard polls once a second. 512 keeps several
/// fills of history (enough to read a whole duplicate-request incident
/// start to finish) while staying far below the per-poll DOM cost of an
/// unbounded list, and the ring is bounded so a long session can never
/// grow it. Same shape as `PERF_RING_CAP` in perf.rs.
// `#[allow(dead_code)]` is RELEASE-only load-bearing: the sole reader is
// `trace_push`, which is `#[cfg(debug_assertions)]`, so a release build
// (tracer compiled out) has no consumer for the number and `dead_code`
// fires. The other three trace items needed no allow — the command being in
// `invoke_handler` is what makes those live, in both profiles.
#[allow(dead_code)]
pub const TRACE_RING_CAP: usize = 512;

/// One captured line plus its process-lifetime sequence, so the dashboard
/// can poll incrementally instead of refetching the whole ring.
#[derive(Clone, serde::Serialize)]
pub struct TraceLine {
    /// Monotonic from 1; never reset, never reused.
    pub seq: u64,
    /// The `[TRN <ms>] …` line exactly as stderr shows it.
    pub text: String,
}

/// One incremental read of the ring.
#[derive(serde::Serialize)]
pub struct TrnTraceLog {
    /// Newest sequence held; pass back as `after` on the next poll.
    pub head: u64,
    /// Lines newer than `after`, oldest-first.
    pub lines: Vec<TraceLine>,
    /// The ring evicted lines the poller never saw (its view has a gap).
    pub missed: bool,
}

/// Never written in release (the macro is compiled out), so it allocates
/// nothing there — an empty `VecDeque` behind one mutex.
pub(super) static TRACE_RING: Mutex<VecDeque<TraceLine>> = Mutex::new(VecDeque::new());

#[cfg(debug_assertions)]
pub(super) static TRACE_SEQ: AtomicU64 = AtomicU64::new(0);

/// The single capture point `trn_trace!` funnels into: stderr + the ring.
/// Dev-only because its only caller is the dev-only macro.
#[cfg(debug_assertions)]
pub(super) fn trace_emit(line: String) {
    eprintln!("{line}");
    let seq = TRACE_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let Ok(mut r) = TRACE_RING.lock() else { return };
    trace_push(&mut r, TraceLine { seq, text: line }, TRACE_RING_CAP);
}

/// Push one line, evicting the oldest past `cap`. Pure — unit-tested.
/// Same idiom as `perf::push_sample`. Dev-only (its only caller is the
/// dev-only capture point).
#[cfg(debug_assertions)]
pub(super) fn trace_push(buf: &mut VecDeque<TraceLine>, line: TraceLine, cap: usize) {
    if cap == 0 {
        return;
    }
    while buf.len() >= cap {
        buf.pop_front();
    }
    buf.push_back(line);
}

/// Everything newer than `after`: (head, lines, missed). Pure — unit-tested.
/// `missed` is true when the oldest returned line is not exactly `after + 1`,
/// i.e. the poller was too slow and the ring dropped lines in between.
pub(super) fn trace_since(buf: &VecDeque<TraceLine>, after: u64) -> (u64, Vec<TraceLine>, bool) {
    let head = buf.back().map(|l| l.seq).unwrap_or(after);
    let lines: Vec<TraceLine> = buf.iter().filter(|l| l.seq > after).cloned().collect();
    let missed = lines.first().is_some_and(|l| l.seq > after + 1);
    (head, lines, missed)
}

