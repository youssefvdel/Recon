#![allow(dead_code)]
//! Tests moved verbatim from the former inline `mod tests`.
use super::flight::{FOLLOWER_ABANDONED, FOLLOWER_TIMEOUT, FlightSlot, flight_remove};
use super::memo::{TRN_MEMO_TTL_MS};
use super::readiness::{has_cf_cookie, readiness_probe};
#[cfg(debug_assertions)]
use super::trace::trace_push;

use super::*;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// The probe reads the cookie jar WHOLE. A `.slice(0,500)` could cut
/// `cf_clearance` off the end of a long jar and report "no clearance" on a
/// cleared page.

#[test]
pub(super) fn readiness_probe_never_slices_the_cookie_jar() {
    let s = readiness_probe();
    assert!(s.contains("cookies:document.cookie||''"), "got: {s}");
    // host/title are human labels, so their slices are fine and must stay.
    assert!(
        s.contains("host:(location.hostname||'').slice(0,80)"),
        "got: {s}"
    );
    // And the clearance search is proven on a jar too long for any slice.
    let long_jar = format!("{} cf_clearance=tok", "x=1; ".repeat(200));
    assert!(has_cf_cookie(&long_jar));
}

/* ---- single-flight ---- *
 * What these prove: the leader/follower decision, the follower's
 * bounded wait, and the guard's leak/deadlock safety — over a real tokio
 * runtime and a real (hand-published) slot. What they do NOT prove: the
 * real webview path in `trn_proxy_fetch`, which needs an AppHandle and
 * a live tracker.gg page. The wire count is asserted with a counter that
 * only the leader arm increments. */

pub(super) fn slot() -> FlightSlot {
    Arc::new(Mutex::new(None))
}

#[test]
pub(super) fn one_leader_per_path() {
    let mut f: Vec<(String, FlightSlot)> = Vec::new();
    let (a, lead_a) = flight_acquire(&mut f, "/api/v2/players/abc");
    assert!(lead_a, "first caller must lead");
    // A second realm asking for the same path while the first is on the
    // wire joins it instead of opening a second flight.
    let (b, lead_b) = flight_acquire(&mut f, "/api/v2/players/abc");
    assert!(!lead_b, "second caller must follow");
    assert!(Arc::ptr_eq(&a, &b), "follower must share the leader's slot");
    // A different path is a different request, so it leads its own.
    let (c, lead_c) = flight_acquire(&mut f, "/api/v2/players/xyz");
    assert!(lead_c);
    assert!(!Arc::ptr_eq(&a, &c));
    assert_eq!(f.len(), 2);
}

#[test]
pub(super) fn follower_is_never_billed_and_removal_is_identity_safe() {
    let mut f: Vec<(String, FlightSlot)> = Vec::new();
    let (a, _) = flight_acquire(&mut f, "/api/p");
    flight_remove(&mut f, "/api/p", &a);
    assert!(f.is_empty(), "leader's guard must remove its own entry");
    // A new leader for the same path, then a LATE guard from the old one:
    // the new entry must survive, or a live flight would lose its waiters.
    let (b, lead_b) = flight_acquire(&mut f, "/api/p");
    assert!(lead_b);
    flight_remove(&mut f, "/api/p", &a);
    assert_eq!(f.len(), 1, "a stale guard must not remove a live flight");
    flight_remove(&mut f, "/api/p", &b);
    assert!(f.is_empty());
}

#[tokio::test]
async fn two_callers_one_wire_request() {
    let mut f: Vec<(String, FlightSlot)> = Vec::new();
    let (leader, is_leader) = flight_acquire(&mut f, "/api/season");
    let (follower, is_follower) = flight_acquire(&mut f, "/api/season");
    assert!(is_leader && !is_follower);
    let wire = Arc::new(AtomicU64::new(0));
    // Leader: exactly one "fetch", published 120ms later.
    let w = Arc::clone(&wire);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(120)).await;
        w.fetch_add(1, Ordering::AcqRel);
        *leader.lock().expect("slot") = Some(Ok("{\"seg\":1}".to_string()));
    });
    let body = wait_flight("/api/season", &follower, Duration::from_secs(5))
        .await
        .expect("follower must receive the leader body");
    assert_eq!(body, "{\"seg\":1}");
    assert_eq!(
        wire.load(Ordering::Acquire),
        1,
        "exactly one underlying fetch"
    );
}

#[tokio::test]
async fn follower_times_out_instead_of_hanging() {
    let s = slot();
    // Nothing ever publishes (a wedged leader): the follower must surface
    // the bounded shape, never wait forever.
    let out = wait_flight("/api/never", &s, Duration::from_millis(60)).await;
    assert_eq!(out.unwrap_err(), FOLLOWER_TIMEOUT);
    assert!(!FOLLOWER_TIMEOUT.contains("429") && !FOLLOWER_TIMEOUT.contains("403"));
}

#[tokio::test]
async fn leader_failure_does_not_strand_a_follower_or_poison_the_memo() {
    let path = "/api/leader-fails";
    let s = slot();
    let s2 = Arc::clone(&s);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(60)).await;
        *s2.lock().expect("slot") = Some(Err("HTTP 429: slow down".to_string()));
    });
    let out = wait_flight(path, &s, Duration::from_secs(5)).await;
    // Verbatim: the follower feeds the same ladder with the same answer.
    assert_eq!(out.unwrap_err(), "HTTP 429: slow down");
    // ...and nothing was memoized, so a later caller is a fresh leader
    // rather than a replay of the leader's error.
    assert!(memo_get(path, now_ms()).is_none());
}

#[tokio::test]
async fn abandoned_leader_unblocks_followers_and_leaves_no_entry() {
    // The real static, so the guard's Drop — the thing under test — runs
    // for real. Unique path: the tests share it.
    let path = "/api/abandoned-leader";
    let (leader, is_leader) = flight_acquire(&mut TRN_FLIGHTS.lock().expect("flights"), path);
    assert!(is_leader);
    // The leader leaves without publishing (cancelled or panicked).
    drop(FlightGuard::new(path, &leader));
    // A follower already holding the slot is released at once instead of
    // burning its budget, and the entry is gone — the next caller leads
    // afresh rather than joining a dead flight.
    let out = wait_flight(path, &leader, Duration::from_millis(60)).await;
    assert_eq!(out.unwrap_err(), FOLLOWER_ABANDONED);
    let (again, leads_again) = flight_acquire(&mut TRN_FLIGHTS.lock().expect("flights"), path);
    assert!(leads_again, "an abandoned entry must not be reused");
    drop(FlightGuard::new(path, &again));
    // Not memoized, and not a ladder string.
    assert!(memo_get(path, now_ms()).is_none());
    assert!(!FOLLOWER_ABANDONED.contains("429"));
}

#[tokio::test]
async fn in_flight_path_survives_the_memo_expiring() {
    let path = "/api/slow-season";
    // Nothing memoized yet: the flight alone has to carry the request.
    assert!(memo_get(path, now_ms()).is_none());
    let s = slot();
    let s2 = Arc::clone(&s);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        *s2.lock().expect("slot") = Some(Ok("{\"late\":true}".to_string()));
    });
    // The wait outlives any memo TTL that could be written mid-flight, so
    // an expired (or never written) entry cannot strand the follower.
    let out = wait_flight(path, &s, Duration::from_secs(5)).await;
    assert_eq!(out.unwrap(), "{\"late\":true}");
    assert!(FOLLOWER_WAIT > Duration::from_millis(TRN_MEMO_TTL_MS));
}

/* ---- dev trace ring ---- */

pub(super) fn line(seq: u64) -> TraceLine {
    TraceLine {
        seq,
        text: format!("[TRN {seq}] x"),
    }
}

#[cfg(debug_assertions)]
#[test]
pub(super) fn trace_ring_evicts_oldest_and_reads_incrementally() {
    let mut r: VecDeque<TraceLine> = VecDeque::new();
    for seq in 1..=(TRACE_RING_CAP as u64 + 10) {
        trace_push(&mut r, line(seq), TRACE_RING_CAP);
    }
    assert_eq!(r.len(), TRACE_RING_CAP);
    assert_eq!(r.front().unwrap().seq, 11, "oldest must be evicted");
    assert_eq!(r.back().unwrap().seq, TRACE_RING_CAP as u64 + 10);
    // Incremental read: only what the poller has not seen.
    let head = r.back().unwrap().seq;
    let (h, fresh, missed) = trace_since(&r, head - 3);
    assert_eq!(h, head);
    let seqs: Vec<u64> = fresh.iter().map(|l| l.seq).collect();
    assert_eq!(seqs, vec![head - 2, head - 1, head]);
    assert!(!missed);
    // A slow poller is told it missed lines instead of silently losing them.
    let (_, fresh, missed) = trace_since(&r, 2);
    assert!(missed);
    assert_eq!(fresh.first().unwrap().seq, 11);
    // Zero cap never stores, exactly like perf::push_sample.
    let mut z: VecDeque<TraceLine> = VecDeque::new();
    trace_push(&mut z, line(1), 0);
    assert!(z.is_empty());
    // An empty ring answers with the poller's own cursor, never a reset.
    let (h, fresh, missed) = trace_since(&VecDeque::new(), 42);
    assert_eq!((h, fresh.len(), missed), (42, 0, false));
}
