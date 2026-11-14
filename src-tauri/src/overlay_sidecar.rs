//! `outpeek-overlay` sidecar lifecycle: ownership, spawn, health, respawn, kill.
//!
//! The sidecar is a separate Slint binary declared in `tauri.conf.json`
//! (`externalBin`), launched deferred like the TS overlay build (~700 ms),
//! killed on exit, and restarted if it crashes. Facts go over its stdin as
//! NDJSON at the overlay-daemon cadence plus on every show/hide/edit
//! transition.
//!
//! Exactly one HUD renders: `init` reads the persisted `overlay_renderer`
//! setting and claims the screen for the sidecar only when the setting asks for
//! it (`native`, or `auto` while the sidecar passes its health check). The
//! verdict is published in `state::ACTIVE_RENDERER_NATIVE`, which is the one
//! flag `win/daemons.rs` reads before showing or aligning the Tauri window. A
//! crash hands the screen back (`auto` → TS); a healthy restart takes it again.
//! `ts` never spawns, probes, or touches any of this — a missing binary is a
//! warn, never a startup failure.
//!
//! What the main app owns today: rect, present, edit, tab_held, lite, plus the
//! live fact set (phase, phase_label, map, mode, blue, red) from the Rust live
//! service (`src/live.rs`). Rosters need the core-game payload and stay at the
//! sidecar's empty defaults until that lands.

use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI8, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::overlay_renderer::{resolve_renderer, ActiveOverlayRenderer, OverlayRendererSetting};
use crate::state::ACTIVE_RENDERER_NATIVE;

static CHILD: Mutex<Option<Child>> = Mutex::new(None);
static STDIN: Mutex<Option<ChildStdin>> = Mutex::new(None);
static BIN_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);
static FACT_SEQ: AtomicU64 = AtomicU64::new(0);

/// The user wants the sidecar running (`native` or `auto`). FALSE means stop
/// and stay stopped: the supervisor must never fight a switch back to `ts`.
static WANTED: AtomicBool = AtomicBool::new(false);
/// Last health verdict — a successful `--health` probe plus a successful start.
/// A live process alone is not enough: a sidecar that cannot build its window
/// must not take the screen.
static HEALTHY: AtomicBool = AtomicBool::new(false);
/// One supervisor thread per process.
static SUPERVISOR: AtomicBool = AtomicBool::new(false);
/// `-1` not resolved yet, `0` binary absent, `1` present. Only the supervisor
/// resolves it, so an untouched `ts` install stays "unknown", not "missing".
static BINARY_PRESENT: AtomicI8 = AtomicI8::new(-1);

/// Respawn pacing: a crash loop re-probes and restarts at most this often.
const RESPAWN_EVERY: Duration = Duration::from_secs(5);
/// A probe that has not exited by then is treated as unhealthy and killed.
const HEALTH_POLL: Duration = Duration::from_millis(100);
const HEALTH_STEPS: usize = 30;

fn candidate_names() -> [&'static str; 2] {
    [
        // Tauri externalBin layout: binaries/<name>-<target-triple>.exe
        "outpeek-overlay-x86_64-pc-windows-msvc.exe",
        // Dev/manual drop next to the exe.
        "outpeek-overlay.exe",
    ]
}

fn sidecar_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        for name in candidate_names() {
            let p = res.join("binaries").join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in candidate_names() {
                let p = dir.join(name);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    None
}

fn start_locked(path: &Path) -> Result<(), String> {
    let mut cmd = Command::new(path);
    cmd.arg("--parent-pid")
        .arg(std::process::id().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        // No console window for the sidecar, same as the GPU helper spawns.
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("sidecar spawn failed: {e}"))?;
    let stdin = child.stdin.take();
    // Drain stdout (edit-chrome events) to the log so a chatty sidecar can
    // never block on a full pipe.
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                log::info!("[sidecar] {line}");
            }
        });
    }
    *STDIN.lock().map_err(|e| e.to_string())? = stdin;
    *CHILD.lock().map_err(|e| e.to_string())? = Some(child);
    Ok(())
}

fn child_alive() -> bool {
    CHILD
        .lock()
        .map(|mut guard| {
            guard
                .as_mut()
                .map(|c| matches!(c.try_wait(), Ok(None)))
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn stop_child() {
    if let Ok(mut guard) = CHILD.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    if let Ok(mut guard) = STDIN.lock() {
        *guard = None;
    }
}

/// `outpeek-overlay --health`: build the same window the HUD uses, report, and
/// exit without ever showing it.
///
/// Deliberately not `--probe`: that one shows the window for ~50 ms to read the
/// applied styles back, and a startup check must never flash a fullscreen layer
/// over the game. A broken renderer still fails here — the probe exits
/// non-zero when the window cannot be constructed.
fn probe_health(path: &Path) -> bool {
    let mut cmd = Command::new(path);
    cmd.arg("--health")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let Ok(mut child) = cmd.spawn() else {
        return false;
    };
    // `std` has no wait_timeout: poll, then kill a hung probe.
    for _ in 0..HEALTH_STEPS {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => std::thread::sleep(HEALTH_POLL),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    false
}

/// Publish the ownership verdict for the daemons.
///
/// `ACTIVE_RENDERER_NATIVE` is written here and read by the overlay daemon and
/// the overlay guard. Promoting to native hides the Tauri window immediately
/// instead of waiting for the 2 s daemon tick: the sidecar is already up by
/// then and a tick of overlap would render two HUDs.
fn apply_ownership(app: &AppHandle, healthy: bool) {
    let setting = crate::settings::overlay_renderer_setting();
    let native = resolve_renderer(setting, healthy) == ActiveOverlayRenderer::Native;
    let was = ACTIVE_RENDERER_NATIVE.swap(native, Ordering::SeqCst);
    if native && !was {
        hide_ts_overlay(app);
    }
    if !native && was {
        log::info!("[sidecar] HUD handed to the in-app overlay");
    }
    // The visibility fact depends on ownership (see `sidecar_facts_snapshot`),
    // so the new owner's window is corrected now instead of on the next tick.
    push_current();
}

fn hide_ts_overlay(app: &AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        if overlay.is_visible().unwrap_or(false) {
            if let Err(e) = crate::win::overlay::hide_overlay(app.clone()) {
                log::warn!("[sidecar] could not hide the in-app HUD: {e}");
            }
        }
    }
}

/// Boot ownership: claim the screen when the setting asks for the sidecar and
/// start the supervisor. Replaces the old unconditional spawn.
pub(crate) fn init(app: AppHandle) {
    match crate::settings::overlay_renderer_setting() {
        OverlayRendererSetting::Ts => {
            // Explicit TS: no spawn, no probe, no daemon gate.
            ACTIVE_RENDERER_NATIVE.store(false, Ordering::SeqCst);
            log::info!("[sidecar] renderer=ts, native sidecar not started");
        }
        setting => {
            // Claim the screen before the first daemon tick. Auto hands it back
            // if the probe fails, but the TS window must never come up first
            // and overlap a sidecar that is already rendering.
            ACTIVE_RENDERER_NATIVE.store(true, Ordering::SeqCst);
            WANTED.store(true, Ordering::SeqCst);
            start_supervisor(app);
            log::info!(
                "[sidecar] renderer={} native sidecar wanted",
                setting.as_str()
            );
        }
    }
}

fn start_supervisor(app: AppHandle) {
    if SUPERVISOR.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || supervise(app));
}

fn supervise(app: AppHandle) {
    // Deferred like the TS overlay build (~700 ms): let the event loop settle
    // before a second renderer initialises.
    std::thread::sleep(Duration::from_millis(700));
    let mut last_attempt: Option<Instant> = None;
    let mut missing_logged = false;
    loop {
        if !WANTED.load(Ordering::SeqCst) {
            stop_child();
            HEALTHY.store(false, Ordering::SeqCst);
            missing_logged = false;
            std::thread::sleep(Duration::from_secs(1));
            continue;
        }
        if child_alive() {
            std::thread::sleep(Duration::from_secs(1));
            continue;
        }
        // A child that existed and is gone crashed. Hand the screen back now
        // (auto -> TS; native stays native and honestly renders nothing)
        // instead of leaving the last verdict up for another retry window.
        let crashed = CHILD.lock().map(|g| g.is_some()).unwrap_or(false);
        if crashed {
            stop_child();
            HEALTHY.store(false, Ordering::SeqCst);
            apply_ownership(&app, false);
            log::warn!("[sidecar] exited; HUD handed back while it restarts");
        }
        if last_attempt.is_some_and(|t| t.elapsed() < RESPAWN_EVERY) {
            std::thread::sleep(Duration::from_secs(1));
            continue;
        }
        last_attempt = Some(Instant::now());
        let Some(path) = sidecar_path(&app) else {
            BINARY_PRESENT.store(0, Ordering::Relaxed);
            if !missing_logged {
                log::warn!("[sidecar] binary not found; native HUD unavailable");
                missing_logged = true;
            }
            HEALTHY.store(false, Ordering::SeqCst);
            apply_ownership(&app, false);
            std::thread::sleep(Duration::from_secs(1));
            continue;
        };
        BINARY_PRESENT.store(1, Ordering::Relaxed);
        if let Ok(mut bin) = BIN_PATH.lock() {
            *bin = Some(path.clone());
        }
        let healthy = probe_health(&path);
        let started = healthy && start_locked(&path).is_ok();
        HEALTHY.store(started, Ordering::SeqCst);
        apply_ownership(&app, started);
        if started {
            log::info!("[sidecar] started {}", path.display());
        } else {
            log::warn!("[sidecar] health check failed; native HUD not started");
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// Runtime switch from the settings UI: persist-then-apply is the caller's
/// job, this only re-aims the supervisor and the ownership flag.
pub(crate) fn apply_setting(app: &AppHandle) {
    match crate::settings::overlay_renderer_setting() {
        OverlayRendererSetting::Ts => {
            WANTED.store(false, Ordering::SeqCst);
            stop_child();
            HEALTHY.store(false, Ordering::SeqCst);
            ACTIVE_RENDERER_NATIVE.store(false, Ordering::SeqCst);
            log::info!("[sidecar] renderer=ts, native sidecar stopped");
        }
        OverlayRendererSetting::Native => {
            WANTED.store(true, Ordering::SeqCst);
            // Explicit native owns the screen even while unhealthy: an empty
            // HUD is the honest result, not a silent switch the user did not
            // ask for. The status row reports the missing sidecar.
            ACTIVE_RENDERER_NATIVE.store(true, Ordering::SeqCst);
            start_supervisor(app.clone());
            hide_ts_overlay(app);
        }
        OverlayRendererSetting::Auto => {
            WANTED.store(true, Ordering::SeqCst);
            start_supervisor(app.clone());
            // Optimistic claim so the TS window cannot overlap a sidecar that
            // is already rendering; the supervisor demotes as soon as health
            // says no.
            ACTIVE_RENDERER_NATIVE.store(true, Ordering::SeqCst);
            hide_ts_overlay(app);
        }
    }
}

/// Best-effort facts write. A dead pipe just drops the handle; the supervisor
/// restarts the child and the next daemon tick re-syncs full state.
pub(crate) fn push_sidecar_facts(v: serde_json::Value) {
    let mut guard = match STDIN.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(stdin) = guard.as_mut() {
        use std::io::Write;
        if writeln!(stdin, "{}", v.to_string()).is_err() {
            *guard = None;
        }
    }
}

pub(crate) fn sidecar_running() -> bool {
    child_alive()
}

/// Full state the main app owns today: rect, visibility, edit, Tab, lite,
/// plus the live fact set (phase/map/mode/scores) from the Rust live service.
/// Rosters are not in this frame yet — they need the core-game payload, not
/// presences (Phase 1+); the sidecar keeps its empty-list defaults.
pub(crate) fn sidecar_facts_snapshot() -> serde_json::Value {
    let (x, y, w, h) = sidecar_rect();
    let facts = crate::live::current_facts();
    let live = facts.phase == "coregame";
    // Visibility is an ownership fact, not a content fact: the TS webview's
    // render gates describe the TS HUD and keep running while it is hidden, so
    // they cannot decide whether the native window shows. Native visibility
    // follows the game (the daemon's rule); TS keeps its own gate.
    let present = if ACTIVE_RENDERER_NATIVE.load(Ordering::Relaxed) {
        crate::window_manager::is_valorant_foreground()
    } else {
        crate::state::OVERLAY_PRESENT.load(Ordering::Relaxed)
    };
    serde_json::json!({
        "seq": FACT_SEQ.fetch_add(1, Ordering::Relaxed),
        "present": present,
        "edit": crate::OVERLAY_EDIT_MODE.load(Ordering::Relaxed),
        "lite": true,
        "tab_held": crate::window_manager::is_tab_down(),
        "rect": {"x": x, "y": y, "w": w, "h": h},
        // Live facts. Empty string = unknown; the sidecar clears its default
        // placeholder rather than inventing a map/mode.
        "phase": facts.phase,
        "phase_label": facts.phase_label,
        "live": live,
        "map": facts.map,
        "mode": facts.mode,
        "blue": facts.blue,
        "red": facts.red,
    })
}

/// Push the current snapshot now (show/hide/edit transitions).
pub(crate) fn push_current() {
    if sidecar_running() {
        push_sidecar_facts(sidecar_facts_snapshot());
    }
}

pub(crate) fn sidecar_rect() -> (i32, i32, i32, i32) {
    #[cfg(windows)]
    {
        if let Some(target) = crate::window_manager::find_valorant_game_window() {
            unsafe {
                let hwnd = windows::Win32::Foundation::HWND(target.hwnd as *mut std::ffi::c_void);
                let mut rect = windows::Win32::Foundation::RECT::default();
                if windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect).is_ok() {
                    let w = rect.right - rect.left;
                    let h = rect.bottom - rect.top;
                    if w > 100 && h > 100 {
                        return (rect.left, rect.top, w, h);
                    }
                }
            }
        }
        // No (usable) game rect: primary screen fallback.
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::{
                GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN,
            };
            (
                0,
                0,
                GetSystemMetrics(SM_CXSCREEN),
                GetSystemMetrics(SM_CYSCREEN),
            )
        }
    }
    #[cfg(not(windows))]
    {
        (0, 0, 1920, 1080)
    }
}

/// Kill the sidecar on app exit. The `--parent-pid` watchdog is the backstop;
/// this is the polite path. `WANTED` goes false first so the supervisor does
/// not respawn during shutdown.
pub(crate) fn shutdown_sidecar() {
    WANTED.store(false, Ordering::SeqCst);
    stop_child();
}

fn status_json() -> serde_json::Value {
    let setting = crate::settings::overlay_renderer_setting();
    let running = sidecar_running();
    let active = if ACTIVE_RENDERER_NATIVE.load(Ordering::Relaxed) {
        ActiveOverlayRenderer::Native
    } else {
        ActiveOverlayRenderer::Ts
    };
    let binary = match BINARY_PRESENT.load(Ordering::Relaxed) {
        -1 => serde_json::Value::Null,
        0 => serde_json::Value::Bool(false),
        _ => serde_json::Value::Bool(true),
    };
    serde_json::json!({
        "running": running,
        "healthy": HEALTHY.load(Ordering::Relaxed) && running,
        "setting": setting.as_str(),
        // The side that owns the screen right now — the one the daemons read.
        "active": active.as_str(),
        "binary": binary,
    })
}

#[tauri::command]
pub(crate) fn sidecar_status() -> Result<serde_json::Value, String> {
    Ok(status_json())
}

/// Persist the renderer setting and apply it immediately: `ts` stops the
/// sidecar and hands the HUD to the Tauri window on the next daemon tick;
/// `native`/`auto` start it. No restart required.
#[tauri::command]
pub(crate) fn set_overlay_renderer(
    app: AppHandle,
    setting: String,
) -> Result<serde_json::Value, String> {
    crate::settings::save_overlay_renderer(&setting);
    apply_setting(&app);
    Ok(status_json())
}
