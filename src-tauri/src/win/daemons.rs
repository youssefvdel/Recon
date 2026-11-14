//! Background threads: display hotkey, auto-borderless, the HUD daemon, the
//! overlay guard and the one-shot vendor purge.
//!
//! Moved out of `setup` verbatim. Every captured variable is an explicit
//! parameter here — the bodies still read the same names they closed over
//! (`handle`, `pref_clone`, `auto_bl_handle`, `auto_overlay_handle`,
//! `guard_handle`), so a reviewer can check the move by reading the signatures
//! against the old closure captures.

/// Last daemon decision for the debug-only change-of-decision trace:
/// u8::MAX = none yet, 0 = skip, 1 = show, 2 = hide.
#[cfg(debug_assertions)]
static LAST_OVERLAY_DECISION: std::sync::atomic::AtomicU8 =
    std::sync::atomic::AtomicU8::new(u8::MAX);


use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::display::build_display_info;
use crate::display;
use crate::gpu;
use crate::log_line;
use crate::state::{
    ACTIVE_RENDERER_NATIVE, AUTO_BORDERLESS_ENABLED, OVERLAY_AVAILABLE, OVERLAY_EDIT_MODE,
    OVERLAY_EDIT_WATCHDOG_MS, OVERLAY_PRESENT, OVERLAY_WINDOWED,
};
use crate::win::overlay::{force_overlay_edit_mode_off, hide_overlay, show_overlay};
use crate::window_manager;

/// One-shot: purge vendor display overrides earlier builds wrote.
pub(crate) fn gpu_purge() {
    std::thread::spawn(|| {
let _ = gpu::purge_legacy_vendor_overrides();
    });
}

/// Display-mode hotkey: applies the mode, emits the change, and nudges the game
/// borderless when the switch went stretched.
pub(crate) fn display_hotkey(
    handle: AppHandle,
    rx: std::sync::mpsc::Receiver<()>,
    pref_clone: Arc<Mutex<(u32, u32)>>,
) {
    std::thread::spawn(move || {
        while let Ok(()) = rx.recv() {
            let cur_opt = display::get_current_display_mode();
            let (nw, nh) = display::get_native_resolution();
            if let Some(cur) = cur_opt {
                let (target_w, target_h) = if cur.width == nw {
                    let pref = pref_clone.lock().unwrap();
                    *pref
                } else {
                    (nw, nh)
                };
                let _ = display::apply_display_mode(target_w, target_h, cur.refresh_rate);
                let info = build_display_info();
                let _ = handle.emit("display-mode-changed", &info);

                // If switching to stretched and auto-borderless is enabled, make Valorant borderless fullscreen
                if (target_w != nw || target_h != nh) && AUTO_BORDERLESS_ENABLED.load(Ordering::Relaxed) {
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(300));
                        if let Some(target) = window_manager::find_valorant_game_window() {
                            let _ = window_manager::make_borderless(target.hwnd);
                        }
                    });
                }
            }
        }
    });
}

/// Auto-borderless daemon: keeps the game borderless while stretched is active.
pub(crate) fn auto_borderless(auto_bl_handle: AppHandle) {
    std::thread::spawn(move || {
        let mut last_handled_hwnd: Option<isize> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1500));

            if !AUTO_BORDERLESS_ENABLED.load(Ordering::Relaxed) {
                continue;
            }

            let is_stretched = if let Some(cur) = display::get_current_display_mode() {
                let (nw, nh) = display::get_native_resolution();
                cur.width != nw || cur.height != nh
            } else {
                false
            };

            if is_stretched {
                if let Some(target) = window_manager::find_valorant_game_window() {
                    let hwnd_val = target.hwnd;
                    let hwnd = windows::Win32::Foundation::HWND(hwnd_val as *mut std::ffi::c_void);

                    let needs_borderless = if last_handled_hwnd != Some(hwnd_val) {
                        true
                    } else {
                        !window_manager::is_window_borderless_fullscreen(hwnd)
                    };

                    if needs_borderless {
                        match window_manager::make_borderless(hwnd_val) {
                            Ok(msg) => {
                                last_handled_hwnd = Some(hwnd_val);
                                let _ = auto_bl_handle.emit(
                                    "auto-borderless-applied",
                                    serde_json::json!({
                                        "hwnd": hwnd_val,
                                        "title": target.title,
                                        "message": msg,
                                    }),
                                );
                            }
                            Err(e) => {
                                log::warn!("Auto-borderless failed on hwnd {}: {}", hwnd_val, e);
                            }
                        }
                    }
                }
            } else {
                last_handled_hwnd = None;
            }
        }
    });
}

/// HUD daemon: show/hide on game focus, align, heal lost click-through.
pub(crate) fn overlay_daemon(auto_overlay_handle: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(2000));
            // Sidecar follows at daemon cadence (covers the edit/windowed
            // paths that `continue` below, and the no-TS-overlay case):
            // full snapshot, best-effort.
            crate::overlay_sidecar::push_current();
            // HUD ownership: while the native sidecar owns the screen, the
            // Tauri window must neither show nor align — both are full-screen
            // alpha layers, so showing this one too would composite two HUDs
            // and feed the edit/hit-test paths a window the user cannot see.
            // Hiding a window left over from a switch or a crash hand-back is
            // this tick's job; the daemon is the only place that can.
            if ACTIVE_RENDERER_NATIVE.load(Ordering::Relaxed) {
                if let Some(overlay) = auto_overlay_handle.get_webview_window("overlay") {
                    if overlay.is_visible().unwrap_or(false) {
                        if let Err(e) = hide_overlay(auto_overlay_handle.clone()) {
                            log::warn!("overlay daemon: native renderer owns the HUD, hide failed: {e}");
                        }
                    }
                }
                continue;
            }
            // No HUD window: nothing to show, align, heal or hide.
            if !OVERLAY_AVAILABLE.load(Ordering::Relaxed) {
                continue;
            }
            if OVERLAY_EDIT_MODE.load(Ordering::Relaxed)
                || OVERLAY_WINDOWED.load(Ordering::Relaxed)
            {
                // ponytail: eprintln!, not log::debug! — like trn_trace!,
                // there is no logger backend so log:: would vanish in dev.
                #[cfg(debug_assertions)]
                {
                    let reason = if OVERLAY_EDIT_MODE.load(Ordering::Relaxed) {
                        "edit"
                    } else {
                        "windowed"
                    };
                    if LAST_OVERLAY_DECISION.swap(0, Ordering::Relaxed) != 0 {
                        let ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis())
                            .unwrap_or(0);
                        eprintln!("[OVERLAY {ms}] daemon decision=skip reason={reason}");
                    }
                }
                continue;
            }
            let valorant_present = window_manager::find_valorant_game_window().is_some();
            // Same foreground reader as the TRN/perf pause gates
            // (GetForegroundWindow in window_manager::is_valorant_foreground).
            // Agent select / pregame runs with VALORANT foreground, so
            // foreground-gating preserves pre-pick — do not "fix" this
            // by showing while background.
            let valorant_foreground =
                valorant_present && window_manager::is_valorant_foreground();
            // Audit overlay#4: a visible full-screen alpha layer is
            // composited every frame. When the UI reports no content
            // (`set_overlay_present(false)`) only the Tab peek needs the
            // layer; the 100 ms guard thread owns that fast transition,
            // and this slow tick must not fight it by re-showing.
            let present =
                OVERLAY_PRESENT.load(Ordering::Relaxed) || window_manager::is_tab_down();
            let should_show = valorant_present && valorant_foreground && present;
            #[cfg(debug_assertions)]
            {
                let reason = if should_show {
                    "foreground"
                } else if !valorant_present {
                    "no-game"
                } else {
                    "background"
                };
                let want = if should_show { 1 } else { 2 };
                if LAST_OVERLAY_DECISION.swap(want, Ordering::Relaxed) != want {
                    let ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    eprintln!(
                        "[OVERLAY {ms}] daemon decision={} reason={reason}",
                        if should_show { "show" } else { "hide" }
                    );
                }
            }
            if let Some(overlay) = auto_overlay_handle.get_webview_window("overlay") {
                let is_vis = overlay.is_visible().unwrap_or(false);
                if should_show && !is_vis {
                    if let Err(e) = show_overlay(auto_overlay_handle.clone()) {
                        log::warn!("overlay daemon: show failed: {e}");
                    }
                } else if !should_show && is_vis {
                    if let Err(e) = hide_overlay(auto_overlay_handle.clone()) {
                        log::warn!("overlay daemon: hide failed: {e}");
                    }
                } else if should_show && is_vis {
                    #[cfg(windows)]
                    if let Ok(hwnd) = overlay.hwnd() {
                        if let Err(e) =
                            window_manager::align_overlay_to_valorant(hwnd.0 as isize)
                        {
                            log::warn!("overlay daemon: align failed: {e}");
                        }
                        // Self-heal: if something re-applied default styles
                        // (opaque layer eating game input), reassert click-through.
                        // The frame check is the pale-bar half: a re-added
                        // caption/thick-frame paints a top bar over the game
                        // while TRANSPARENT stays set, which the predicate
                        // above cannot see. Same toggle path re-strips the
                        // frame bits and the DWM no-chrome attributes.
                        let hwnd_val = hwnd.0 as isize;
                        let heal_click = window_manager::overlay_clickthrough_missing(hwnd_val);
                        let heal_frame =
                            !heal_click && window_manager::overlay_frame_dirty(hwnd_val);
                        if heal_click {
                            log::warn!("overlay daemon: click-through lost — reasserting");
                        } else if heal_frame {
                            log::warn!("overlay daemon: frame chrome reappeared — reasserting");
                        }
                        if heal_click || heal_frame {
                            let _ = overlay.set_ignore_cursor_events(true);
                            if let Err(e) = window_manager::toggle_overlay_clickthrough(
                                hwnd_val,
                                true,
                            ) {
                                log::warn!(
                                    "overlay daemon: click-through reassert failed: {e}"
                                );
                            }
                        }
                    }
                }
            }
        }
    });
}

/// Overlay guard: edit-exit chord, 90 s watchdog, Tab peek.
pub(crate) fn overlay_guard(guard_handle: AppHandle) {
    std::thread::spawn(move || {
        let mut chord_was_down = false;
        let mut tab_shown = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(100));
            // Edit mode and the Tab peek both need the window; with no
            // HUD there is nothing to guard, no chord to serve, and the
            // watchdog cannot be armed (edit mode needs the window).
            if !OVERLAY_AVAILABLE.load(Ordering::Relaxed) {
                continue;
            }
            let chord = window_manager::overlay_edit_exit_chord_down();
            if chord && !chord_was_down {
                force_overlay_edit_mode_off(&guard_handle, "Ctrl+Shift+H");
            }
            chord_was_down = chord;
            if OVERLAY_EDIT_MODE.load(Ordering::Relaxed)
                && window_manager::overlay_edit_idle_ms() > OVERLAY_EDIT_WATCHDOG_MS
            {
                force_overlay_edit_mode_off(&guard_handle, "no edit activity for 90s");
                continue;
            }
            // The fast path only runs when the UI says the layer has no
            // content of its own; otherwise the 2 s daemon owns it. It also
            // stays out of native ownership: the Tab peek is a Tauri-window
            // feature, and showing it while the sidecar renders would put two
            // HUDs on screen.
            let gated = !ACTIVE_RENDERER_NATIVE.load(Ordering::Relaxed)
                && !OVERLAY_EDIT_MODE.load(Ordering::Relaxed)
                && !OVERLAY_WINDOWED.load(Ordering::Relaxed)
                && !OVERLAY_PRESENT.load(Ordering::Relaxed)
                && window_manager::is_valorant_foreground();
            if !gated {
                tab_shown = false;
                continue;
            }
            let tab = window_manager::is_tab_down();
            if tab && !tab_shown {
                if let Err(e) = show_overlay(guard_handle.clone()) {
                    log::warn!("overlay tab-peek: show failed: {e}");
                }
                tab_shown = true;
            } else if !tab && tab_shown {
                // ~200 ms grace: a quick double-tap must not flash.
                std::thread::sleep(std::time::Duration::from_millis(200));
                if !window_manager::is_tab_down() {
                    if let Err(e) = hide_overlay(guard_handle.clone()) {
                        log::warn!("overlay tab-peek: hide failed: {e}");
                    }
                    tab_shown = false;
                }
            }
        }
    });
}
