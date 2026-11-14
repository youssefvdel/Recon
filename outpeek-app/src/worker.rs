//! One live poller for the whole process.
//!
//! Cadence, copied from the Tauri live service (`src-tauri/src/live.rs`, the
//! proven behaviour): 2.5 s while something is happening, backing off to 30 s
//! after 30 s of an idle phase, and a cheap lockfile `stat` decides whether the
//! Riot Client is even running — a closed client costs one filesystem check per
//! tick, not an HTTPS handshake.
//!
//! Rank is the exception: `/mmr` is remote, so it is read once when the account
//! resolves, again when it changes, and on explicit user request. Never on the
//! live tick.
//!
//! Every publish is a partial state change; the UI thread decides what to
//! repaint. The loop never blocks the UI thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::identity::{self, Identity};
use crate::live_facts::{derive_facts, find_local_presence};
use crate::model::{RankState, RankView, TrackerSnapshot};
use crate::rank;

/// Agent select is short and round transitions are quick.
pub const FAST_POLL: Duration = Duration::from_millis(2_500);
/// Menu cadence after [`IDLE_AFTER`] of idle phase.
pub const IDLE_POLL: Duration = Duration::from_secs(30);
/// How long the phase must have been idle before the slow cadence applies.
pub const IDLE_AFTER: Duration = Duration::from_secs(30);
/// Consecutive presence failures before the UI is told the client is gone.
pub const FAIL_STREAK_MAX: u32 = 8;
/// Retry pace while the client is running but not answering identity calls.
const IDENTITY_RETRY: Duration = Duration::from_secs(5);
/// Sleep granularity so a shutdown is never stuck behind a 30 s backoff.
const SLEEP_STEP: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Snapshot(TrackerSnapshot),
    Rank(RankView),
}

/// Cross-thread switches owned by the app (UI) and read by the poller.
#[derive(Debug, Default)]
pub struct Flags {
    pub stop: AtomicBool,
    /// Set by the "Refresh rank" button; consumed by the poller.
    pub refresh_rank: AtomicBool,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Start the single poller on its own thread with a current-thread runtime.
/// Slint owns the main thread; this thread only blocks on network/`sleep`.
pub fn spawn<F>(publish: F, flags: Arc<Flags>)
where
    F: Fn(Event) + Send + 'static,
{
    let _ = std::thread::Builder::new()
        .name("outpeek-live-poll".to_string())
        .spawn(move || {
            let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
            else {
                return;
            };
            rt.block_on(run(publish, flags));
        });
}

async fn run<F>(publish: F, flags: Arc<Flags>)
where
    F: Fn(Event) + Send + 'static,
{
    let mut snap = TrackerSnapshot::starting();
    let mut rank_view = RankView::waiting();
    let mut identity: Option<Identity> = None;
    let mut rank_pending = true;
    let mut idle_since: Option<Instant> = Some(Instant::now());
    let mut fail_streak: u32 = 0;

    publish(Event::Snapshot(snap.clone()));
    publish(Event::Rank(rank_view.clone()));

    loop {
        if flags.stop.load(Ordering::Relaxed) {
            return;
        }

        // Cheap gate first: no lockfile means no Riot client, so there is
        // nothing to ask. A client that closed mid-match cannot still be in
        // one — reset rather than keep a stale score on screen.
        if !identity::lockfile_present() {
            identity = None;
            rank_pending = true;
            let next = TrackerSnapshot::no_client();
            if next != snap {
                snap = next;
                publish(Event::Snapshot(snap.clone()));
            }
            if rank_view.state != RankState::Waiting {
                rank_view = RankView::waiting();
                publish(Event::Rank(rank_view.clone()));
            }
            idle_since.get_or_insert_with(Instant::now);
            sleep_or_stop(&flags, IDLE_POLL).await;
            continue;
        }

        // Identity is fetched once per session (startup or account change).
        if identity.is_none() {
            match identity::read_lockfile().and_then(|auth| identity::fetch_identity(&auth)) {
                Ok(id) => {
                    identity = Some(id.clone());
                    snap = snap.with_identity(&id.game_name, &id.tag_line);
                    publish(Event::Snapshot(snap.clone()));
                    rank_pending = true;
                    fail_streak = 0;
                }
                Err(e) => {
                    let next = snap.with_error(e);
                    if next != snap {
                        snap = next;
                        publish(Event::Snapshot(snap.clone()));
                    }
                    sleep_or_stop(&flags, IDENTITY_RETRY).await;
                    continue;
                }
            }
        }

        let Some(me) = identity.clone() else {
            continue;
        };

        // Presence poll: the only thing the live tick owns.
        let polled = identity::read_lockfile().and_then(|auth| identity::fetch_presences(&auth));
        match polled {
            Ok(root) => {
                fail_streak = 0;
                let facts = derive_facts(&root, &me.puuid, now_ms());
                let next = snap.with_facts(&facts);
                if next != snap {
                    snap = next;
                    publish(Event::Snapshot(snap.clone()));
                }
                // A real match is a reason to stay fast; a stable idle set is
                // what earns the slow cadence.
                if snap.phase == "idle" {
                    idle_since.get_or_insert_with(Instant::now);
                } else {
                    idle_since = None;
                }
                // A different account (client relaunch or sign-in switch) stops
                // matching: re-resolve identity and rank next tick instead of
                // staying blind on the old PUUID.
                if find_local_presence(&root, &me.puuid).is_none() {
                    identity = None;
                    rank_pending = true;
                }
            }
            Err(e) => {
                fail_streak += 1;
                let message = if fail_streak >= FAIL_STREAK_MAX {
                    "Lost the Riot Client — waiting for it to answer.".to_string()
                } else {
                    e
                };
                let next = snap.with_error(message);
                if next != snap {
                    snap = next;
                    publish(Event::Snapshot(snap.clone()));
                }
                idle_since.get_or_insert_with(Instant::now);
            }
        }

        // On-demand rank read (startup, account change, explicit refresh).
        // Never on the live tick: `/mmr` is a remote call.
        if identity.is_some() && (rank_pending || flags.refresh_rank.swap(false, Ordering::Relaxed))
        {
            rank_pending = false;
            publish(Event::Rank(RankView::loading()));
            let resolved = identity::read_lockfile().and_then(|auth| {
                let ent = identity::fetch_entitlements(&auth)?;
                if ent.subject.is_empty() {
                    return Err("Riot Client session has no PUUID.".to_string());
                }
                let region = rank::region_from_access_token(&ent.access_token)
                    .unwrap_or_else(|| "eu".to_string());
                rank::fetch_rank(&me.puuid, &ent, &region)
            });
            rank_view = match resolved {
                Ok(row) => RankView::from_rank(row.tier, row.rr),
                Err(e) => RankView::error(e),
            };
            publish(Event::Rank(rank_view.clone()));
        }

        let cadence = if idle_since.map_or(false, |t| t.elapsed() >= IDLE_AFTER) {
            IDLE_POLL
        } else {
            FAST_POLL
        };
        sleep_or_stop(&flags, cadence).await;
    }
}

/// Sleep `total`, waking often enough that `stop` is honoured promptly.
async fn sleep_or_stop(flags: &Flags, total: Duration) {
    let mut slept = Duration::ZERO;
    while slept < total {
        if flags.stop.load(Ordering::Relaxed) {
            return;
        }
        let chunk = SLEEP_STEP.min(total - slept);
        tokio::time::sleep(chunk).await;
        slept += chunk;
    }
}
