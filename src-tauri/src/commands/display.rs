//! Display commands: resolution, refresh rate, monitors, custom modes and the CRU helpers.

use tauri::{Emitter, State};

use crate::custom_res;
use crate::display;
use crate::game_config;
use crate::state::{AppState, DisplayInfo};

#[tauri::command]
pub(crate) async fn get_display_info() -> Result<DisplayInfo, String> {
    tauri::async_runtime::spawn_blocking(build_display_info)
        .await
        .map_err(|e| format!("Task failed: {}", e))
}

#[tauri::command]
pub(crate) fn apply_resolution(width: u32, height: u32, hz: u32) -> Result<(), String> {
    display::apply_display_mode(width, height, hz)
}

#[tauri::command]
pub(crate) fn toggle_profile(state: State<'_, AppState>, app: tauri::AppHandle) -> Result<DisplayInfo, String> {
    let cur = display::get_current_display_mode().ok_or("Failed to query display mode")?;
    let (native_w, native_h) = display::get_native_resolution();

    let (target_w, target_h) = if cur.width == native_w {
        let pref = state.preferred_stretched.lock().unwrap();
        *pref
    } else {
        (native_w, native_h)
    };

    display::apply_display_mode(target_w, target_h, cur.refresh_rate)?;
    let info = build_display_info();
    let _ = app.emit("display-mode-changed", &info);
    Ok(info)
}

#[tauri::command]
pub(crate) fn get_preferred_stretched_res(state: State<'_, AppState>) -> Result<[u32; 2], String> {
    let pref = state.preferred_stretched.lock().unwrap();
    Ok([pref.0, pref.1])
}

#[tauri::command]
pub(crate) fn set_preferred_stretched_res(
    state: State<'_, AppState>,
    width: u32,
    height: u32,
) -> Result<[u32; 2], String> {
    if width == 0 || height == 0 {
        return Err("Invalid resolution dimensions".to_string());
    }
    display::save_saved_stretched_res(width, height);
    let mut pref = state.preferred_stretched.lock().unwrap();
    *pref = (width, height);
    Ok([width, height])
}

#[tauri::command]
pub(crate) fn apply_custom_res_to_all_configs(
    width: u32,
    height: u32,
    lock_readonly: bool,
) -> Result<String, String> {
    let count = game_config::apply_to_all_configs(width, height, lock_readonly)?;
    let lock_text = if lock_readonly {
        "and write-protected (Read-Only) against game updates"
    } else {
        "unlocked for manual in-game edits"
    };
    Ok(format!(
        "Successfully applied {}×{} {} across {} game config file(s)!",
        width, height, lock_text, count
    ))
}

#[tauri::command]
pub(crate) fn apply_custom_res_verbose(
    width: u32,
    height: u32,
    lock_readonly: bool,
) -> Result<Vec<game_config::ApplyResult>, String> {
    let results = game_config::apply_to_all_configs_verbose(width, height, lock_readonly);
    if results.is_empty() {
        return Err("No VALORANT GameUserSettings.ini files found. Please launch VALORANT once to generate configuration files.".to_string());
    }
    Ok(results)
}

#[tauri::command]
pub(crate) async fn get_all_monitors() -> Result<Vec<display::MonitorDevice>, String> {
    tauri::async_runtime::spawn_blocking(display::get_all_monitors)
        .await
        .map_err(|e| format!("Task failed: {}", e))
}

/// Kept for backend compat only. The Display Manager UI no longer exposes CCD
/// Attached/Detached — only Device Manager Enable/Disable remains. Retained so
/// existing invokes / restore paths don't break.
#[tauri::command]
pub(crate) fn set_monitor_attached(device_name: String, attached: bool) -> Result<Vec<display::MonitorDevice>, String> {
    display::set_monitor_topology_attached(&device_name, attached)
}

#[tauri::command]
pub(crate) fn set_monitor_device_enabled(monitor_id: String, enabled: bool) -> Result<Vec<display::MonitorDevice>, String> {
    display::set_monitor_device_enabled(&monitor_id, enabled)
}

#[tauri::command]
pub(crate) fn set_monitor_primary(device_name: String) -> Result<Vec<display::MonitorDevice>, String> {
    display::set_monitor_primary(&device_name)
}

#[tauri::command]
pub(crate) fn launch_cru() -> Result<(), String> {
    display::launch_cru()
}

#[tauri::command]
pub(crate) fn restart_graphics_driver() -> Result<String, String> {
    Ok(custom_res::restart_driver_stack())
}

#[tauri::command]
pub(crate) fn reset_all_cru_overrides() -> Result<String, String> {
    custom_res::reset_all_edid_overrides()
}

#[tauri::command]
pub(crate) fn reset_all_edid_overrides() -> Result<String, String> {
    custom_res::reset_all_edid_overrides()
}

#[tauri::command]
pub(crate) fn test_custom_mode(width: u32, height: u32, hz: u32) -> Result<custom_res::CustomModeTest, String> {
    custom_res::validate_custom_resolution(width, height, hz)?;
    Ok(custom_res::test_display_mode(None, width, height, hz))
}

#[tauri::command]
pub(crate) fn add_custom_resolution(monitor_id: String, width: u32, height: u32, hz: u32) -> Result<String, String> {
    custom_res::add_custom_resolution(&monitor_id, width, height, hz)
}

#[tauri::command]
pub(crate) fn remove_custom_override(monitor_id: String) -> Result<String, String> {
    custom_res::remove_custom_override(&monitor_id)
}

#[tauri::command]
pub(crate) fn list_supported_modes() -> Result<Vec<display::DisplayMode>, String> {
    Ok(display::get_all_supported_modes())
}

pub(crate) fn build_display_info() -> DisplayInfo {
    let (native_w, native_h) = display::get_native_resolution();
    let cur = display::get_current_display_mode().unwrap_or(display::DisplayMode {
        width: native_w,
        height: native_h,
        refresh_rate: 260,
    });
    let rates = display::get_supported_refresh_rates_for(cur.width, cur.height);
    let active_profile = if cur.width == native_w && cur.height == native_h {
        "native".to_string()
    } else {
        "stretched".to_string()
    };
    let dev_name = display::get_primary_device_name();

    DisplayInfo {
        current_width: cur.width,
        current_height: cur.height,
        current_hz: cur.refresh_rate,
        native_width: native_w,
        native_height: native_h,
        supported_refresh_rates: rates,
        active_profile,
        device_name: dev_name,
    }
}
