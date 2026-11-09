#![allow(dead_code)]
//! (moved verbatim from `trn_proxy.rs`; split only.)
use tauri::Manager;
use super::ceiling::{now_ms};
use super::constants::{PROXY_IDLE_TTL, PROXY_LABEL, PROXY_URL, WATCHDOG_TIMEOUT};
use super::readiness::{parse_readiness, readiness_probe};
use super::script::{WARDEN_HOOK_JS};
use super::state::{PROXY_FAIL_STREAK, PROXY_INFLIGHT, PROXY_LAST_RECREATE_MS, PROXY_READY, PROXY_TEARDOWN_GEN, PROXY_WINDOW_LOCK, ProxyState, recreate_backoff_elapsed, reset_proxy_lifecycle, self_heal_due, set_proxy_state, teardown_still_valid, watchdog_reason, watchdog_should_recreate};

use std::sync::atomic::{Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
/// In-flight request guard, entered before the window is acquired.
///
/// `Drop` runs on every exit path — 2xx, `HTTP {code}`, `EDGE_PAUSED`,
/// `EDGE_UNAVAILABLE`, early return — so the in-flight count can never be
/// stranded above zero (which would disable teardown for the rest of the
/// session) and can never hit zero while an eval is still outstanding.
pub(super) struct InflightGuard(AppHandle);

impl InflightGuard {
    pub(super) fn enter(app: &AppHandle) -> Self {
        PROXY_INFLIGHT.fetch_add(1, Ordering::AcqRel);
        Self(app.clone())
    }
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        PROXY_INFLIGHT.fetch_sub(1, Ordering::AcqRel);
        arm_idle_teardown(&self.0);
    }
}

/// Arm the idle sweep for the window this request just used.
///
/// Only the request that takes the in-flight count to zero arms one, and it
/// invalidates every sweep armed before it. The sweep sleeps, re-checks under
/// the same lock `proxy_window` takes, and only then destroys — so a create
/// racing the deadline either wins the lock (and arms its own sweep when it
/// completes) or loses it and leaves a window that is genuinely still idle.
pub(super) fn arm_idle_teardown(app: &AppHandle) {
    if PROXY_INFLIGHT.load(Ordering::Acquire) != 0 {
        return;
    }
    let gen = PROXY_TEARDOWN_GEN.fetch_add(1, Ordering::AcqRel) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PROXY_IDLE_TTL).await;
        if PROXY_INFLIGHT.load(Ordering::Acquire) != 0 {
            return;
        }
        let Ok(_guard) = PROXY_WINDOW_LOCK.lock() else {
            return;
        };
        let valid = teardown_still_valid(
            gen,
            PROXY_TEARDOWN_GEN.load(Ordering::Acquire),
            PROXY_INFLIGHT.load(Ordering::Acquire),
        );
        if !valid {
            return;
        }
        // Reuse the watchdog teardown: `destroy`, never `close` — CloseRequested
        // is intercepted app-wide into hide(), which would leave a dead window
        // registered forever and accumulate orphans across cycles.
        trn_trace!("IDLE teardown (no TRN request for {PROXY_IDLE_TTL:?})");
        destroy_proxy_window(&app);
        reset_proxy_lifecycle();
    });
}

pub(super) fn eval_fire(window: &WebviewWindow, js: String) -> Result<(), String> {
    window.eval(js).map_err(|e| format!("EDGE_UNAVAILABLE proxy eval: {e}"))
}

/// One eval-with-result round trip. The callback fires on WebView2's
/// completion thread and wakes us via Notify — the webview thread is never
/// blocked. None when the webview is gone.
pub(super) async fn eval_roundtrip(window: &WebviewWindow, js: String) -> Option<String> {
    eval_roundtrip_timeout(window, js, Duration::from_secs(5)).await
}

/// Same, with a caller-chosen budget. The watchdog passes 2s (proven wedge
/// threshold); everything else keeps the patient 5s. Pure plumbing — the
/// wedge decision itself lives in `watchdog_should_recreate`.
pub(super) async fn eval_roundtrip_timeout(
    window: &WebviewWindow,
    js: String,
    timeout: Duration,
) -> Option<String> {
    let out: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let wake = Arc::new(tokio::sync::Notify::new());
    let out2 = Arc::clone(&out);
    let wake2 = Arc::clone(&wake);
    // Fn (not FnOnce): the Mutex makes the single send shareable.
    if window
        .eval_with_callback(js, move |v| {
            if let Ok(mut g) = out2.lock() {
                *g = Some(v);
            }
            wake2.notify_one();
        })
        .is_err()
    {
        return None;
    }
    if tokio::time::timeout(timeout, wake.notified())
        .await
        .is_err()
    {
        return None;
    }
    let x = out.lock().ok()?.take();
    x
}

/// Destroy a wedged/challenged window so the next build starts clean.
/// `destroy`, not `close` — CloseRequested is intercepted app-wide into
/// hide(), which would leave the dead page in place.
pub(super) fn destroy_proxy_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PROXY_LABEL) {
        let _ = w.destroy();
    }
}

/// Recreate the proxy window after the watchdog fires: a fresh navigation
/// re-earns clearance, and the readiness gate below re-vets it before any
/// fetch. Makes no API calls itself. `reason` is the watchdog's own verdict
/// and `path` the request it interrupted, so the line names both failures
/// instead of a generic "wedge/challenge".
pub(super) fn recreate_proxy(
    app: &AppHandle,
    window: &mut WebviewWindow,
    reason: &str,
    path: &str,
) -> Result<(), String> {
    destroy_proxy_window(app);
    PROXY_READY.store(false, Ordering::Relaxed);
    PROXY_FAIL_STREAK.store(0, Ordering::Release);
    PROXY_LAST_RECREATE_MS.store(now_ms(), Ordering::Release);
    set_proxy_state(ProxyState::Recreated);
    trn_trace!("RECREATED reason={reason} path={path} (fresh navigation re-earns clearance)");
    *window = proxy_window(app)?;
    Ok(())
}

/// Watchdog + bounded self-heal. Two cases:
///
/// - Window already READY: one fast liveness ping (the passive readiness probe,
///   DOM reads only, zero API calls). Silence past the budget or a mid-life
///   challenge recreates the window (backed off — see `recreate_backoff_elapsed`).
/// - Window NOT ready: this used to return immediately, which made a window
///   wedged before its first READY immortal. `PROXY_FAIL_STREAK` now counts
///   failed gates, and once it reaches `PROXY_SELF_HEAL_AFTER` the window is
///   rebuilt here, before the readiness gate re-vets the fresh navigation. The
///   backoff bounds a permanently challenged page to one rebuild per minute.
pub(super) async fn ensure_proxy_alive(
    app: &AppHandle,
    window: &mut WebviewWindow,
    path: &str,
) -> Result<(), String> {
    if !PROXY_READY.load(Ordering::Relaxed) {
        if self_heal_due(
            PROXY_FAIL_STREAK.load(Ordering::Acquire),
            PROXY_LAST_RECREATE_MS.load(Ordering::Acquire),
            now_ms(),
        ) {
            trn_trace!("SELF-HEAL reason=never-ready path={path} (failed readiness {PROXY_SELF_HEAL_AFTER}x)");
            recreate_proxy(app, window, "never-ready", path)?;
        }
        return Ok(());
    }
    let ping = eval_roundtrip_timeout(window, readiness_probe(), WATCHDOG_TIMEOUT)
        .await
        .and_then(|env| parse_readiness(&env));
    if !watchdog_should_recreate(ping.as_ref()) {
        set_proxy_state(ProxyState::Ready);
        PROXY_FAIL_STREAK.store(0, Ordering::Release);
        return Ok(());
    }
    PROXY_FAIL_STREAK.fetch_add(1, Ordering::AcqRel);
    let reason = watchdog_reason(ping.as_ref());
    if !recreate_backoff_elapsed(PROXY_LAST_RECREATE_MS.load(Ordering::Acquire), now_ms()) {
        // The page passed the gate then wedged again inside the backoff: do not
        // churn renderers, surface it and let the next fetch (after backoff)
        // rebuild. Bounded wait, no recreate loop.
        trn_trace!("WEDGED path={path} reason={reason} (recreate backed off)");
        return Err("EDGE_PAUSED proxy wedged".to_string());
    }
    recreate_proxy(app, window, reason, path)
}

/// Existing hidden window, or a fresh one. Shared WebView2 pool (default
/// environment — no separate data dir), stays hidden + off-taskbar, never
/// focused. Idempotent: safe to call per fetch, and the lock makes it
/// idempotent under concurrency too — racing callers can never build a second
/// window under the same label, so cycles cannot accumulate or orphan one.
pub(super) fn proxy_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let _guard = PROXY_WINDOW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(w) = app.get_webview_window(PROXY_LABEL) {
        let _ = w.hide();
        return Ok(w);
    }
    // Fresh window lifetime: readiness must re-pass before the first fetch.
    PROXY_READY.store(false, Ordering::Relaxed);
    let w = WebviewWindowBuilder::new(
        app,
        PROXY_LABEL,
        WebviewUrl::External(
            PROXY_URL
                .parse()
                .map_err(|e| format!("EDGE_UNAVAILABLE bad proxy url: {e}"))?,
        ),
    )
    .title("Recon TRN proxy")
    .inner_size(16.0, 16.0)
    .decorations(false)
    .transparent(true)
    .focused(false)
    .visible(false)
    .skip_taskbar(true)
    .always_on_top(false)
    // Observation-only Warden recorder (see WARDEN_HOOK_JS). This window's
    // page is where a future replay would read the token from; the human pass
    // itself happens in `trn_verify_open`'s visible window.
    .initialization_script(WARDEN_HOOK_JS)
    .build()
    .map_err(|e| format!("EDGE_UNAVAILABLE proxy window: {e}"))?;
    let _ = w.hide();
    Ok(w)
}
