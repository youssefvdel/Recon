//! GPU commands: read the adapter state, change one setting, open the vendor panel.

use tauri::State;

use crate::game_config;
use crate::gpu;
use crate::state::AppState;

#[tauri::command]
pub(crate) async fn get_gpu_info() -> Result<gpu::GpuInfo, String> {
    tauri::async_runtime::spawn_blocking(gpu::detect_gpu)
        .await
        .map_err(|e| format!("Task failed: {}", e))
}

#[tauri::command]
pub(crate) async fn get_gpu_settings() -> Result<gpu::GpuSettingsReport, String> {
    tauri::async_runtime::spawn_blocking(gpu::get_gpu_settings_report)
        .await
        .map_err(|e| format!("Task failed: {}", e))
}

#[tauri::command]
pub(crate) fn set_gpu_setting(id: String, value: bool) -> Result<gpu::GpuSettingsReport, String> {
    gpu::apply_single_gpu_setting(&id, value)
}

#[tauri::command]
pub(crate) fn open_gpu_panel(vendor: String) -> Result<(), String> {
    let v = match vendor.to_lowercase().as_str() {
        "nvidia" => gpu::GpuVendor::Nvidia,
        "amd" => gpu::GpuVendor::Amd,
        "intel" => gpu::GpuVendor::Intel,
        _ => gpu::GpuVendor::Unknown,
    };
    gpu::launch_control_panel(&v)
}

#[tauri::command]
pub(crate) fn auto_configure_gpu_scaling(state: State<'_, AppState>) -> Result<String, String> {
    let (msg, _report) = gpu::auto_configure_all_gpu_settings()?;

    let (pref_w, pref_h) = {
        let pref = state.preferred_stretched.lock().unwrap();
        *pref
    };

    let configs = game_config::find_valorant_configs();
    let mut config_count = 0;
    for cfg in configs {
        let p = std::path::Path::new(&cfg.path);
        if game_config::update_config(p, true, Some((pref_w, pref_h)), true).is_ok() {
            config_count += 1;
        }
    }

    let extra = if config_count > 0 {
        format!(" • Synchronized 1.45:1 ({}×{}) in {} game config(s)", pref_w, pref_h, config_count)
    } else {
        String::new()
    };

    Ok(format!("{}{}", msg, extra))
}
