//! The HUD window: creation, visibility, input styles, edit mode, placement.
//!
//! Split out of `lib.rs` by moving code only — same names, same bodies. The
//! daemons that drive these still live in `setup`.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager};

use crate::state::{OVERLAY_AVAILABLE, OVERLAY_EDIT_MODE, OVERLAY_PRESENT, OVERLAY_WINDOWED};
use crate::window_manager;

#[tauri::command]
pub(crate) fn show_overlay(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "Overlay window not found".to_string())?;
    let _ = window.set_shadow(false);
    let clickthrough = !OVERLAY_EDIT_MODE.load(Ordering::Relaxed);
    // Audit overlay#10: a swallowed style error here is how the overlay ends up
    // visible but opaque (eating clicks) with the UI claiming success. Report.
    window
        .set_ignore_cursor_events(clickthrough)
        .map_err(|e| format!("Overlay click-through failed: {e}"))?;
    window.show().map_err(|e| format!("Overlay show failed: {e}"))?;
    let _ = window.set_shadow(false);
    #[cfg(windows)]
    {
        if let Ok(hwnd) = window.hwnd() {
            window_manager::setup_overlay_window(hwnd.0 as isize, clickthrough)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn hide_overlay(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "Overlay window not found".to_string())?;
    window.hide().map_err(|e| format!("Overlay hide failed: {e}"))
}


/// Fail-safe exit from edit mode. Works without the overlay webview: the DOM
/// Esc handler is gone the moment that renderer dies, and that is exactly when
/// the process-global flag used to keep a fullscreen topmost window eating
/// every click until the app exited (audit overlay#1).
pub(crate) fn force_overlay_edit_mode_off(app: &tauri::AppHandle, reason: &str) {
    let was_editing = OVERLAY_EDIT_MODE.swap(false, Ordering::AcqRel);
    apply_overlay_unlocked(app);
    if was_editing {
        log::warn!("overlay edit mode force-exited ({reason})");
        let _ = app.emit("overlay-edit-mode-changed", false);
    }
}

#[tauri::command]
pub(crate) fn set_overlay_edit_mode(app: tauri::AppHandle, in_edit_mode: bool) -> Result<(), String> {
    if !in_edit_mode {
        force_overlay_edit_mode_off(&app, "user exit");
        return Ok(());
    }
    // Resolve the window BEFORE flipping the global flag: a missing overlay
    // must fail the call, not leave the process believing it is editing.
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "Overlay window not found".to_string())?;
    OVERLAY_EDIT_MODE.store(true, Ordering::Relaxed);
    #[cfg(windows)]
    window_manager::overlay_edit_touch();
    let _ = window.set_shadow(false);
    window
        .set_ignore_cursor_events(false)
        .map_err(|e| format!("Overlay edit mode: input capture failed: {e}"))?;
    window
        .show()
        .map_err(|e| format!("Overlay edit mode: show failed: {e}"))?;
    let _ = window.set_shadow(false);
    #[cfg(windows)]
    {
        match window.hwnd() {
            Ok(hwnd) => window_manager::set_overlay_editable(hwnd.0 as isize)?,
            Err(e) => {
                OVERLAY_EDIT_MODE.store(false, Ordering::Relaxed);
                return Err(format!("Overlay window handle unavailable: {e}"));
            }
        }
    }
    // No set_focus(): entering edit mode must not deactivate VALORANT
    // (audit overlay#5). Mouse drag/click do not need activation, and the
    // Ctrl+Shift+H chord plus the on-screen Lock button cover exiting.
    let _ = app.emit("overlay-edit-mode-changed", true);
    Ok(())
}

/// Tell the daemon whether the HUD has content worth a full-screen alpha layer
/// right now (audit overlay#4). The overlay calls this as its render gates
/// change (Tab-peek panel, pregame panel, crosshair): with `false` the daemon
/// stops compositing the layer for the whole match and only brings it up while
/// the Tab peek (or edit mode) needs it.
///
/// Defaults to TRUE at boot, so an older UI that never calls this keeps the
/// pre-audit always-on behaviour instead of losing its HUD.
#[tauri::command]
pub(crate) fn set_overlay_present(needed: bool) -> Result<(), String> {
    OVERLAY_PRESENT.store(needed, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub(crate) fn get_overlay_edit_mode() -> Result<bool, String> {
    Ok(OVERLAY_EDIT_MODE.load(Ordering::Relaxed))
}

#[tauri::command]
pub(crate) fn is_overlay_visible(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("overlay") {
        Ok(window.is_visible().unwrap_or(false))
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub(crate) fn is_tab_down() -> Result<bool, String> {
    #[cfg(windows)]
    {
        return Ok(window_manager::is_tab_down());
    }
    #[cfg(not(windows))]
    {
        return Ok(false);
    }
}

/// Dev debugging aid: drop the overlay out of fullscreen click-through into
/// a normal framed window (and back), so its surface can be inspected,
/// moved, and DevTools-docked like any app window.
#[tauri::command]
pub(crate) fn set_overlay_windowed(app: tauri::AppHandle, windowed: bool) -> Result<(), String> {
    OVERLAY_WINDOWED.store(windowed, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("overlay") {
        #[cfg(windows)]
        {
            if let Ok(hwnd) = window.hwnd() {
                if windowed {
                    let _ = window.set_fullscreen(false);
                    let _ = window.set_decorations(true);
                    let _ = window.set_always_on_top(false);
                    let _ = window.set_shadow(true);
                    let _ = window.set_ignore_cursor_events(false);
                    let _ = window.show();
                    let _ = window_manager::set_overlay_windowed(hwnd.0 as isize, true);
                    let _ = window.set_focus();
                } else {
                    let _ = window.set_decorations(false);
                    let _ = window.set_always_on_top(true);
                    let _ = window.set_shadow(false);
                    let _ = window.set_fullscreen(true);
                    let clickthrough = !OVERLAY_EDIT_MODE.load(Ordering::Relaxed);
                    let _ = window_manager::setup_overlay_window(hwnd.0 as isize, clickthrough);
                }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = window.show();
        }
        Ok(())
    } else {
        Err("Overlay window not found".to_string())
    }
}

#[tauri::command]
pub(crate) fn get_overlay_monitor() -> Result<String, String> {
    Ok(window_manager::get_overlay_monitor_setting())
}

#[tauri::command]
pub(crate) fn set_overlay_monitor(app: tauri::AppHandle, monitor: String) -> Result<String, String> {
    let saved = window_manager::set_overlay_monitor_setting(&monitor)?;
    // Move immediately if the overlay is up; the 2s daemon also enforces it.
    if let Some(overlay) = app.get_webview_window("overlay") {
        if overlay.is_visible().unwrap_or(false) {
            #[cfg(windows)]
            if let Ok(hwnd) = overlay.hwnd() {
                let _ = window_manager::align_overlay_to_valorant(hwnd.0 as isize);
            }
        }
    }
    Ok(saved)
}

/// Build the HUD from its `tauri.conf.json` entry, which is `"create": false`.
///
/// Deliberately not a config-created window: Tauri's own startup loop does
/// `.build()?` on every config window before our `setup` runs, so a webview
/// failure on the overlay aborted the whole process — zero windows, no dialog.
/// The HUD is optional; the app is not.
pub(crate) fn build_overlay_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    let cfg = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "overlay")
        .cloned()
        .ok_or_else(|| "overlay window config missing".to_string())?;
    let builder =
        tauri::WebviewWindowBuilder::from_config(app, &cfg).map_err(|e| e.to_string())?;
    builder.build().map_err(|e| e.to_string())
}

/// Re-assert click-through, the one state the process must never lose.
///
/// Single code path for the fail-safe exits (user exit, Ctrl+Shift+H, watchdog,
/// overlay close/crash). It keeps going after a failed step and logs, because
/// the caller is already in recovery: a half-applied exit that still eats
/// clicks would be worse than the failure it is handling.
pub(crate) fn apply_overlay_unlocked(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.set_shadow(false);
        if let Err(e) = window.set_ignore_cursor_events(true) {
            log::warn!("overlay unlock: set_ignore_cursor_events failed: {e}");
        }
        #[cfg(windows)]
        {
            if let Ok(hwnd) = window.hwnd() {
                if let Err(e) = window_manager::toggle_overlay_clickthrough(hwnd.0 as isize, true) {
                    log::warn!("overlay unlock: click-through restore failed: {e}");
                }
            }
        }
    }
}
