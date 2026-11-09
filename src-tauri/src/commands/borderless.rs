//! Borderless helpers: list windows, toggle the auto-borderless daemon, and
//! reshape the game window.

use std::sync::atomic::Ordering;

use crate::state::AUTO_BORDERLESS_ENABLED;
use crate::window_manager;

#[tauri::command]
pub(crate) fn get_windows() -> Result<Vec<window_manager::WindowInfo>, String> {
    Ok(window_manager::list_visible_windows())
}

#[tauri::command]
pub(crate) fn set_auto_borderless(enabled: bool) -> Result<(), String> {
    AUTO_BORDERLESS_ENABLED.store(enabled, Ordering::Relaxed);
    crate::settings::set_auto_borderless(enabled);
    Ok(())
}

#[tauri::command]
pub(crate) fn get_auto_borderless() -> Result<bool, String> {
    Ok(AUTO_BORDERLESS_ENABLED.load(Ordering::Relaxed))
}

#[tauri::command]
pub(crate) fn make_window_borderless(hwnd: isize) -> Result<String, String> {
    window_manager::make_borderless(hwnd)
}

#[tauri::command]
pub(crate) fn restore_window_framed(hwnd: isize) -> Result<String, String> {
    window_manager::restore_window(hwnd)
}
