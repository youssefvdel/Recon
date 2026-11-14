//! `outpeek-overlay` sidecar lifecycle: spawn, feed, respawn, kill.
//!
//! The sidecar is a separate Slint binary declared in `tauri.conf.json`
//! (`externalBin`), launched deferred like the TS overlay build (~700 ms),
//! killed on exit, and respawned if it crashes. Facts go over its stdin as
//! NDJSON at the overlay-daemon cadence plus on every show/hide/edit
//! transition; the TS overlay stays the fallback either way — a missing
//! binary is a warn, never a startup failure.
//!
//! What the main app owns today: rect, present, edit, tab_held, lite.
//! Score/phase/rosters arrive with the Rust live pipeline (Phase 0/1) and
//! stay at the sidecar's `.slint` defaults until then.

use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

static CHILD: Mutex<Option<Child>> = Mutex::new(None);
static STDIN: Mutex<Option<ChildStdin>> = Mutex::new(None);
static BIN_PATH: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);
static FACT_SEQ: AtomicU64 = AtomicU64::new(0);

fn candidate_names() -> [&'static str; 2] {
    [
        // Tauri externalBin layout: binaries/<name>-<target-triple>.exe
        "outpeek-overlay-x86_64-pc-windows-msvc.exe",
        // Dev/manual drop next to the exe.
        "outpeek-overlay.exe",
    ]
}

fn sidecar_path(app: &AppHandle) -> Option<std::path::PathBuf> {
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

fn start_locked(path: &std::path::Path) -> Result<(), String> {
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
    let mut child = cmd.spawn().map_err(|e| format!("sidecar spawn failed: {e}"))?;
    let stdin = child.stdin.take();
    // Drain stdout (edit-chrome events) to the log so a chatty sidecar can
    // never block on a full pipe.
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
                log::info!("[sidecar] {line}");
            }
        });
    }
    *STDIN.lock().map_err(|e| e.to_string())? = stdin;
    *CHILD.lock().map_err(|e| e.to_string())? = Some(child);
    log::info!("[sidecar] started {}", path.display());
    Ok(())
}

/// Deferred spawn + crash respawn. Missing binary is a warn: the TS overlay
/// stays the fallback, so the sidecar can never fail startup.
pub(crate) fn spawn_sidecar(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(700));
        let Some(path) = sidecar_path(&app) else {
            log::warn!("[sidecar] binary not found, TS overlay stays active");
            return;
        };
        *BIN_PATH.lock().unwrap_or_else(|p| p.into_inner()) = Some(path.clone());
        if start_locked(&path).is_err() {
            return;
        }
        // Crash respawn: the daemon re-pushes full state every tick, so a
        // fresh child converges without any replay log.
        loop {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let dead = CHILD
                .lock()
                .map(|mut guard| {
                    guard.as_mut().map(|c| matches!(c.try_wait(), Ok(Some(_)))).unwrap_or(false)
                })
                .unwrap_or(false);
            if dead {
                log::warn!("[sidecar] exited, respawning");
                *CHILD.lock().unwrap_or_else(|p| p.into_inner()) = None;
                *STDIN.lock().unwrap_or_else(|p| p.into_inner()) = None;
                let path = BIN_PATH
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_else(|p| p.into_inner().clone());
                if let Some(path) = path {
                    let _ = start_locked(&path);
                }
            }
        }
    });
}

/// Best-effort facts write. A dead pipe just drops the handle; the watcher
/// respawns and the next daemon tick re-syncs full state.
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

/// Full state the main app owns today: rect, visibility, edit, Tab, lite.
/// Score/phase/rosters follow with the Rust live pipeline.
pub(crate) fn sidecar_facts_snapshot() -> serde_json::Value {
    let (x, y, w, h) = sidecar_rect();
    serde_json::json!({
        "seq": FACT_SEQ.fetch_add(1, Ordering::Relaxed),
        "present": crate::state::OVERLAY_PRESENT.load(Ordering::Relaxed),
        "edit": crate::OVERLAY_EDIT_MODE.load(Ordering::Relaxed),
        "lite": true,
        "tab_held": crate::window_manager::is_tab_down(),
        "rect": {"x": x, "y": y, "w": w, "h": h},
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
                if windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect).is_ok()
                {
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
            (0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN))
        }
    }
    #[cfg(not(windows))]
    {
        (0, 0, 1920, 1080)
    }
}

/// Kill the sidecar on app exit. The `--parent-pid` watchdog is the backstop;
/// this is the polite path.
pub(crate) fn shutdown_sidecar() {
    if let Ok(mut guard) = CHILD.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
    if let Ok(mut guard) = STDIN.lock() {
        *guard = None;
    }
}

#[tauri::command]
pub(crate) fn sidecar_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "running": sidecar_running() }))
}
