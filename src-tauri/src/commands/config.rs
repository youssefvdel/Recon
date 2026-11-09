//! VALORANT config commands: discover, read, diff and write the game's INI files.

use crate::game_config;

#[tauri::command]
pub(crate) async fn get_valorant_configs() -> Result<Vec<game_config::ConfigFileInfo>, String> {
    tauri::async_runtime::spawn_blocking(game_config::find_valorant_configs)
        .await
        .map_err(|e| format!("Task failed: {}", e))
}

#[tauri::command]
pub(crate) fn update_valorant_config(
    path: String,
    set_windowed: bool,
    res: Option<[u32; 2]>,
    lock_readonly: bool,
) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let res_tuple = res.map(|r| (r[0], r[1]));
    game_config::update_config(p, set_windowed, res_tuple, lock_readonly)
}

#[tauri::command]
pub(crate) fn update_valorant_config_custom(
    path: String,
    options: game_config::CustomOptions,
) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    game_config::update_config_custom(p, &options)
}

#[tauri::command]
pub(crate) fn verify_valorant_configs(width: u32, height: u32) -> Result<Vec<game_config::VerifyResult>, String> {
    Ok(game_config::verify_all_configs(width, height))
}

#[tauri::command]
pub(crate) fn get_valorant_config_raw(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    game_config::read_config_raw(p)
}

#[tauri::command]
pub(crate) fn get_valorant_config_sections(path: String) -> Result<Vec<game_config::SectionInfo>, String> {
    let p = std::path::Path::new(&path);
    game_config::get_all_sections(p)
}

#[tauri::command]
pub(crate) fn set_valorant_config_value(
    path: String,
    section: String,
    key: String,
    value: String,
    lock_readonly: bool,
) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    game_config::set_config_value(p, &section, &key, &value, lock_readonly)
}
