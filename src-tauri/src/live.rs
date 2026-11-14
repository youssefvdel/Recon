//! Rust live-facts service — Phase 0 of `docs/live-rust-pipeline.md`.
//!
//! One tokio task owns the only loopback poll of `/chat/v4/presences`. It
//! derives the fact set through the pure module (`live_facts`), and:
//!
//!   * emits `recon:live-facts` **only when the fact set changes** (compare,
//!     not poll — a quiet menu produces zero events);
//!   * keeps the latest fact set in a process-wide slot that the sidecar
//!     snapshot reads (`overlay_sidecar::sidecar_facts_snapshot`);
//!   * backs off to one poll per 30 s once the phase has been idle for 30 s,
//!     and returns to 2.5 s on the first change;
//!   * skips the HTTP poll entirely while no Riot lockfile exists (the client
//!     is not running; a menu-only launch costs one `stat` per tick).
//!
//! Read-only: loopback GETs through the existing `tracker` transport, the same
//! trust boundary as `local_presences`. No remote `pd/glz` calls, ever, on a
//! timer (`docs/live-rust-pipeline.md` rule).
//!
//! Additive by design: the TS poller keeps running unchanged; this service
//! only feeds the native sidecar and the new event until the TS side is
//! migrated (Phase 2).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Once, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::Emitter;

use crate::live_facts::{derive_facts, find_local_presence, LiveFacts};

/// Wire name stays `recon:` by policy (the repo rename does not touch it).
pub(crate) const LIVE_FACTS_EVENT: &str = "recon:live-facts";

/// Match cadence: agent select is short, round transitions are quick.
const FAST_POLL_MS: u64 = 2_500;
/// Menu cadence after `IDLE_AFTER_MS` of idle phase. Phase 1's log tailer is
/// what removes the worst-case detection delay this implies.
const IDLE_POLL_MS: u64 = 30_000;
/// How long the phase must have been idle before the slow cadence applies.
const IDLE_AFTER_MS: u64 = 30_000;
/// Consecutive read/parse failures tolerated before the fact set is forced to
/// idle. 8 × 2.5 s ≈ 20 s: long enough to ride a cloud-gateway blip (the TS
/// poller keeps its state for the same reason), short enough that a dead
/// client cannot leave a stale score on the HUD.
const FAIL_STREAK_MAX: u32 = 8;

static CURRENT: OnceLock<RwLock<LiveFacts>> = OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(0);
static STARTED: Once = Once::new();

fn slot() -> &'static RwLock<LiveFacts> {
    CURRENT.get_or_init(|| RwLock::new(LiveFacts::idle(0)))
}

/// Latest fact set, for the sidecar snapshot. Cloned so no caller holds the
/// lock across an IPC/write.
pub(crate) fn current_facts() -> LiveFacts {
    match slot().read() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

/// Start the single poller. Idempotent: `setup` runs once, but a future
/// command may also want to nudge it awake without spawning a second task.
pub(crate) fn start(app: tauri::AppHandle) {
    STARTED.call_once(|| {
        tauri::async_runtime::spawn(run(app));
    });
}

async fn run(app: tauri::AppHandle) {
    let mut puuid = String::new();
    // Idle from boot: a launch lands in menus, so the first useful poll can be
    // the slow one. A Riot launch is noticed within one slow tick.
    let mut idle_since: Option<Instant> = Some(Instant::now());
    let mut fail_streak: u32 = 0;
    log::info!("[live] presences watcher started");

    loop {
        let slow = idle_since.map_or(false, |t| t.elapsed().as_millis() as u64 >= IDLE_AFTER_MS);
        let cadence = if slow { IDLE_POLL_MS } else { FAST_POLL_MS };
        tokio::time::sleep(Duration::from_millis(cadence)).await;

        // Cheap gate first: no lockfile means no Riot client, so there is
        // nothing to ask. A client that closed mid-match cannot still be in
        // one — force idle rather than keep a stale score on screen.
        if !crate::tracker::is_riot_client_running() {
            let mut idle = LiveFacts::idle(now_ms());
            idle.confidence = "low".to_string();
            if publish(&app, idle) {
                log::info!("[live] Riot client gone — facts reset to idle");
            }
            idle_since.get_or_insert_with(Instant::now);
            continue;
        }

        match poll_once(&mut puuid).await {
            Ok(facts) => {
                if fail_streak > 0 {
                    log::info!("[live] presences recovered after {fail_streak} failed poll(s)");
                    fail_streak = 0;
                }
                let idle_phase = facts.phase == "idle";
                let changed = publish(&app, facts);
                // Any change is a fresh reason to stay fast; a stable idle
                // fact set is what earns the slow cadence.
                if changed || !idle_phase {
                    idle_since = None;
                } else {
                    idle_since.get_or_insert_with(Instant::now);
                }
            }
            Err(e) => {
                fail_streak += 1;
                if fail_streak == 1 {
                    // Once per streak, not once per tick: a missing client is
                    // one condition, not 24 log lines a minute.
                    log::warn!("[live] presence poll failed: {e}");
                }
                if fail_streak >= FAIL_STREAK_MAX {
                    if fail_streak == FAIL_STREAK_MAX {
                        log::warn!("[live] {FAIL_STREAK_MAX} failed polls — facts reset to idle");
                    }
                    let mut idle = LiveFacts::idle(now_ms());
                    idle.confidence = "low".to_string();
                    publish(&app, idle);
                    // Unknown phase, not proven idle: still back off, so a
                    // signed-out/broken client is not re-asked every 2.5 s
                    // for the rest of the session.
                    idle_since.get_or_insert_with(Instant::now);
                }
            }
        }
    }
}

/// One presence read. The entitlements call only happens when the local puuid
/// is unknown (startup, account switch) — presences themselves are the payload.
async fn poll_once(puuid: &mut String) -> Result<LiveFacts, String> {
    if puuid.is_empty() {
        let ent = crate::tracker::local_entitlements().await?;
        if ent.puuid.trim().is_empty() {
            return Err("entitlements carried no subject".to_string());
        }
        *puuid = ent.puuid;
    }
    let raw = crate::tracker::local_presences().await?;
    let root: Value = serde_json::from_str(&raw).map_err(|e| format!("presences JSON: {e}"))?;
    // A different account (client relaunch) stops matching: refetch next tick
    // instead of staying blind forever.
    if find_local_presence(&root, puuid).is_none() {
        puuid.clear();
    }
    Ok(derive_facts(&root, puuid, now_ms()))
}

/// Store the fact set and broadcast it if it changed. Returns whether it did.
fn publish(app: &tauri::AppHandle, mut facts: LiveFacts) -> bool {
    let mut guard = match slot().write() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if guard.same_facts(&facts) {
        return false;
    }
    facts.seq = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let prev_phase = guard.phase.clone();
    *guard = facts.clone();
    drop(guard);

    if prev_phase != facts.phase {
        log::info!(
            "[live] phase {prev_phase} -> {} (loop {}, queue {}, {}:{})",
            facts.phase,
            facts.loop_state,
            facts.queue,
            facts.blue,
            facts.red
        );
    }
    if let Err(e) = app.emit(LIVE_FACTS_EVENT, &facts) {
        log::warn!("[live] emit {LIVE_FACTS_EVENT} failed: {e}");
    }
    // The sidecar's own daemon tick is 2 s; a score change should not wait for
    // it. Blocking pipe write, so keep it off the async worker.
    let _ = tauri::async_runtime::spawn_blocking(crate::overlay_sidecar::push_current);
    true
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
