//! Shell commands: the app's small operating-system errands — the one-shot tab
//! flag, the update-channel probe, opening a URL and the memory trim.

use tauri::State;

use crate::paths;
use crate::trim_working_set;
use crate::updater;
use crate::state::AppState;

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
pub(crate) fn open_external_url(url: String) -> Result<(), String> {
    updater::open_url(&url)
}

#[tauri::command]
pub(crate) fn trim_memory() -> Result<(), String> {
    trim_working_set();
    Ok(())
}
