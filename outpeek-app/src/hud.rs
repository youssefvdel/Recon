//! HUD hosting for the app: platform capability, foreground gating and the
//! event-loop latency probe.
//!
//! The app does not spawn the sidecar. It creates the overlay window itself and
//! the same Slint event loop renders both windows; this module answers the two
//! questions that gate the HUD's visibility and provides the instrumentation
//! needed to judge the shared-loop trade-off honestly.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The proven transparent/topmost/click-through recipe is Win32-only.
pub const PLATFORM_SUPPORTS_HUD: bool = cfg!(windows);

/// Is the focused window the live VALORANT client?
///
/// On non-Windows hosts the answer is always false: the HUD window stays
/// hidden and the tracker says so, instead of pretending a Linux desktop can
/// host a DX12 overlay.
#[cfg(windows)]
pub fn game_foreground() -> bool {
    outpeek_overlay::win_style::is_game_foreground()
}

#[cfg(not(windows))]
pub fn game_foreground() -> bool {
    false
}

/// Event-loop contention probe, off unless `OUTPEEK_LOOP_PROBE=1`.
///
/// It posts one no-op closure every [`PROBE_INTERVAL`] and records how long the
/// closure waited to run on the UI thread. That is exactly the risk of two
/// windows on one loop: a tracker repaint delaying the HUD. Output goes to
/// stderr every 5 s (`[loop-probe] max=…ms n=…`).
pub const PROBE_INTERVAL: Duration = Duration::from_millis(50);

pub fn spawn_loop_probe(stop: Arc<AtomicBool>) {
    if std::env::var_os("OUTPEEK_LOOP_PROBE").is_none() {
        return;
    }
    let max_us = Arc::new(AtomicU64::new(0));
    let count = Arc::new(AtomicU64::new(0));
    std::thread::Builder::new()
        .name("outpeek-loop-probe".to_string())
        .spawn(move || {
            let mut last_report = Instant::now();
            loop {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let posted = Instant::now();
                let max = max_us.clone();
                let n = count.clone();
                let _ = slint::invoke_from_event_loop(move || {
                    let waited = posted.elapsed().as_micros() as u64;
                    max.fetch_max(waited, Ordering::Relaxed);
                    n.fetch_add(1, Ordering::Relaxed);
                });
                if last_report.elapsed() >= Duration::from_secs(5) {
                    let max = max_us.swap(0, Ordering::Relaxed);
                    let n = count.swap(0, Ordering::Relaxed);
                    eprintln!(
                        "[loop-probe] max={}ms n={n} (loop dispatch latency, last 5s)",
                        max / 1000
                    );
                    last_report = Instant::now();
                }
                std::thread::sleep(PROBE_INTERVAL);
            }
        })
        .ok();
}
