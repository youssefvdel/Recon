//! Dev-only Outpeek footprint timeline (backend + own WebViews resident bytes,
//! and CPU %).
//!
//! Full footprint, not backend-only: the backend process plus ONLY Outpeek's
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
//! is directly comparable to the Outpeek + WebView2 group total there. PIDs come
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

mod model;
pub(crate) mod sample;

pub use model::*;
pub use sample::{is_recon_webview, perf_poll, recon_webview_pids, ProcEntry};

#[cfg(test)]
mod tests;
