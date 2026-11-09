//! App settings commands: shortcuts, autostart, start minimised, update channel,
//! shell helpers and the memory trim.

use tauri::State;

use crate::display;
use crate::paths;
use crate::trim_working_set;
use crate::shortcuts;
use crate::updater;
use crate::state::AppState;

#[tauri::command]
pub(crate) fn get_shortcut_binding() -> Result<display::ShortcutBinding, String> {
    Ok(display::load_saved_hotkey())
}

#[tauri::command]
pub(crate) fn save_shortcut_binding(
    state: State<'_, AppState>,
    binding: display::ShortcutBinding,
) -> Result<(), String> {
    display::save_saved_hotkey(&binding);
    state.hotkey_controller.set_shortcut(binding);
    Ok(())
}

#[tauri::command]
pub(crate) fn get_quick_shortcuts() -> Result<Vec<shortcuts::QuickShortcut>, String> {
    Ok(shortcuts::load_shortcuts())
}

#[tauri::command]
pub(crate) fn check_requested_tab() -> Option<String> {
    let content = paths::read_data_file("requested_tab.txt")?;
    // One-shot flag: consume it from both dirs so the migrated legacy copy is
    // not replayed by the read fallback on the next launch.
    paths::remove_data_file("requested_tab.txt");
    Some(content.trim().to_lowercase())
}

#[tauri::command]
pub(crate) async fn check_channel_update(
    webview: tauri::Webview,
    channel: String,
) -> Result<Option<updater::UpdateMetadata>, String> {
    updater::check_channel_update_internal(webview, channel).await
}

#[tauri::command]
pub(crate) fn get_autostart_enabled() -> Result<bool, String> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run = hkcu.open_subkey_with_flags("Software\\Microsoft\\Windows\\CurrentVersion\\Run", KEY_READ)
        .map_err(|e| format!("Failed to open Run key: {}", e))?;
    match run.get_value::<String, _>("Recon") {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub(crate) fn set_autostart_enabled(enabled: bool) -> Result<bool, String> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run, _) = hkcu.create_subkey("Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run")
        .map_err(|e| format!("Failed to open Run key for write: {}", e))?;
    if enabled {
        let exe_path = std::env::current_exe()
            .map_err(|e| format!("Cannot get current exe path: {}", e))?;
        // Boot lands in the tray when the start-minimized pref is on
        // (default): the flag is read back in setup to hide the window.
        let exe_str = if start_minimized_enabled() {
            format!("\"{}\" --minimized", exe_path.to_string_lossy())
        } else {
            format!("\"{}\"", exe_path.to_string_lossy())
        };
        run.set_value("Recon", &exe_str)
            .map_err(|e| format!("Failed to set registry value: {}", e))?;
        // Drop the legacy pre-rename entry so the app doesn't boot twice.
        let _ = run.delete_value("Aspect");
    } else {
        let _ = run.delete_value("Aspect");
        let _ = run.delete_value("Recon");
    }
    Ok(enabled)
}

#[tauri::command]
pub(crate) fn get_start_minimized() -> Result<bool, String> {
    Ok(start_minimized_enabled())
}

#[tauri::command]
pub(crate) fn set_start_minimized(enabled: bool) -> Result<bool, String> {
    crate::settings::set_start_minimized(enabled);
    // Re-write the Run entry so a stored boot launch picks up the new flag.
    if get_autostart_enabled().unwrap_or(false) {
        return set_autostart_enabled(true);
    }
    Ok(enabled)
}

#[tauri::command]
pub(crate) fn open_external_url(url: String) -> Result<(), String> {
    updater::open_url(&url)
}

#[tauri::command]
pub(crate) fn trim_memory() -> Result<(), String> {
    trim_working_set();
    Ok(())
}

/// Start-minimized pref for boot launches. Lives in settings.json (not
/// localStorage) so the backend can honor it before any window exists.
/// Default ON: a login launch should never pop a window over the game.
pub(crate) fn start_minimized_enabled() -> bool {
    crate::settings::is_start_minimized()
}
