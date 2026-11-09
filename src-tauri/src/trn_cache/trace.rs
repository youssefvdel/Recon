#![allow(dead_code)]
//! (moved verbatim from `trn_cache.rs`; split only.)

use std::collections::VecDeque;

use std::sync::Mutex;

use crate::trn_proxy::{TraceLine};

/* ---- Dev trace ring: the same line shape, this module's own ring ---- *
 * See the header note: `trn_proxy`'s ring and its `trn_trace!` macro are
 * private to that file, so this is a second ring with the same
 * `[TRN <ms>] …` prefix and the same `TraceLine` payload. The dashboard polls
 * both and merges by timestamp. Defined before the call sites because a
 * `macro_rules!` is only in scope after its own definition. */
#[cfg(debug_assertions)]
macro_rules! cache_trace {
    ($($t:tt)*) => {{
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        cache_emit(format!("[TRN {}] {}", ms, format!($($t)*)));
    }};
}
#[cfg(not(debug_assertions))]
macro_rules! cache_trace {
    ($($t:tt)*) => {
        ()
    };
}

/// Never written in release (the macro is compiled out), so it allocates
/// nothing there — same shape as `trn_proxy`'s ring.
pub(super) static CACHE_RING: Mutex<VecDeque<TraceLine>> = Mutex::new(VecDeque::new());

#[cfg(debug_assertions)]
pub(super) static CACHE_SEQ: AtomicU64 = AtomicU64::new(0);

#[cfg(debug_assertions)]
pub(super) fn cache_emit(line: String) {
    eprintln!("{line}");
    let seq = CACHE_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let Ok(mut r) = CACHE_RING.lock() else { return };
    while r.len() >= TRACE_RING_CAP {
        r.pop_front();
    }
    r.push_back(TraceLine { seq, text: line });
}
