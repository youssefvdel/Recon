mod calculator;
mod accounts;
mod custom_res;
mod display;
mod game_config;
mod gpu;
mod paths;
mod perf;
mod riot_http;
mod shortcuts;
mod space_spam;
mod tracker;
mod trn_cache;
mod trn_proxy;
mod window_manager;
mod updater;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

static AUTO_BORDERLESS_ENABLED: AtomicBool = AtomicBool::new(false);
pub static OVERLAY_EDIT_MODE: AtomicBool = AtomicBool::new(false);
static OVERLAY_WINDOWED: AtomicBool = AtomicBool::new(false);

/// Main window's logical CONTENT size at launch. Mirrored in `tauri.conf.json`
/// (main window `width`/`height`/`minWidth`/`minHeight`). The runtime floor in
/// `setup` uses this single constant because config min sizes are not reliably
/// enforced on undecorated windows on Windows; that floor is grown by the
/// measured undecorated frame delta so it keeps the client area this large.
const MAIN_WINDOW_SIZE_LOGICAL: (f64, f64) = (1210.0, 800.0);
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State,
};

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DisplayInfo {
    pub current_width: u32,
    pub current_height: u32,
    pub current_hz: u32,
    pub native_width: u32,
    pub native_height: u32,
    pub supported_refresh_rates: Vec<u32>,
    pub active_profile: String,
    pub device_name: String,
}

pub struct AppState {
    pub hotkey_controller: display::HotkeyController,
    pub preferred_stretched: std::sync::Arc<Mutex<(u32, u32)>>,
}

#[tauri::command]
fn window_minimize(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_toggle_maximize(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn window_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_start_dragging(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_is_maximized(window: tauri::WebviewWindow) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

/// Build the dev-dashboard window at runtime instead of declaring it in
/// `tauri.conf.json`.
///
/// Tauri instantiates every statically-declared window during `setup`, in
/// release too, and each one is a full WebView2 renderer process. A config-
/// declared `dev` window therefore cost ~100MB of resident RAM on every boot
/// for a dashboard the release UI never exposes (the TopBar button is
/// `IS_DEV`-gated and `perf_poll` already refuses in release). Debug builds
/// re-create it from `setup` below, so `tauri dev` keeps the identical
/// boot-time behaviour — hidden until the button shows it.
#[cfg(debug_assertions)]
fn build_dev_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    tauri::WebviewWindowBuilder::new(app, "dev", tauri::WebviewUrl::App("index.html#dev".into()))
        .title("Recon \u{2022} Dev Dashboard")
        // 16:9. The dashboard is a multi-column grid (1 → 2 at xl → 3 at 2xl),
        // and a 1080x780 window only ever reached 2 columns with the trace log
        // squeezed. NOTE: 1920x1080 inner is larger than a 1080p screen once the
        // taskbar is subtracted, so the window can overflow the bottom edge
        // there — it is resizable, and the minimum below keeps a laptop window
        // usable.
        .inner_size(1920.0, 1080.0)
        // 1100x620 is roughly 16:9, i.e. the narrowest the grid stays readable
        // at (1 column, charts stacked, no clipped trace columns). Below that
        // the fixed-width log cells start to collide.
        .min_inner_size(1100.0, 620.0)
        .resizable(true)
        .visible(false)
        // The webview is transparent (index.html forces `background:transparent
        // !important`), so without this the native layer under it is white and
        // the dark dashboard flashes white on open. `0x140e1b` is the
        // `m3-surface` token in tailwind.config.ts.
        .background_color(tauri::utils::config::Color(0x14, 0x0e, 0x1b, 0xff))
        .build()
        .map_err(|e| e.to_string())
}

/// Release builds have no dev dashboard to open. The command stays registered
/// so the IPC surface and the frontend `IS_DEV` gate are identical across
/// debug and release.
#[cfg(not(debug_assertions))]
fn build_dev_window(_app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    Err("Dev dashboard is only available in debug builds.".to_string())
}

#[tauri::command]
fn open_dev_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("dev") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        Ok(())
    } else {
        build_dev_window(&app).map(|_| ())
    }
}

fn build_display_info() -> DisplayInfo {
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

#[tauri::command]
async fn get_display_info() -> Result<DisplayInfo, String> {
    tauri::async_runtime::spawn_blocking(build_display_info)
        .await
        .map_err(|e| format!("Task failed: {}", e))
}

#[tauri::command]
fn apply_resolution(width: u32, height: u32, hz: u32) -> Result<(), String> {
    display::apply_display_mode(width, height, hz)
}

#[tauri::command]
fn toggle_profile(state: State<'_, AppState>, app: tauri::AppHandle) -> Result<DisplayInfo, String> {
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
fn get_preferred_stretched_res(state: State<'_, AppState>) -> Result<[u32; 2], String> {
    let pref = state.preferred_stretched.lock().unwrap();
    Ok([pref.0, pref.1])
}

#[tauri::command]
fn set_preferred_stretched_res(
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
fn apply_custom_res_to_all_configs(
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
fn get_shortcut_binding() -> Result<display::ShortcutBinding, String> {
    Ok(display::load_saved_hotkey())
}

#[tauri::command]
fn save_shortcut_binding(
    state: State<'_, AppState>,
    binding: display::ShortcutBinding,
) -> Result<(), String> {
    display::save_saved_hotkey(&binding);
    state.hotkey_controller.set_shortcut(binding);
    Ok(())
}

#[tauri::command]
async fn get_gpu_info() -> Result<gpu::GpuInfo, String> {
    tauri::async_runtime::spawn_blocking(gpu::detect_gpu)
        .await
        .map_err(|e| format!("Task failed: {}", e))
}

#[tauri::command]
async fn get_gpu_settings() -> Result<gpu::GpuSettingsReport, String> {
    tauri::async_runtime::spawn_blocking(gpu::get_gpu_settings_report)
        .await
        .map_err(|e| format!("Task failed: {}", e))
}

#[tauri::command]
fn set_gpu_setting(id: String, value: bool) -> Result<gpu::GpuSettingsReport, String> {
    gpu::apply_single_gpu_setting(&id, value)
}

#[tauri::command]
fn open_gpu_panel(vendor: String) -> Result<(), String> {
    let v = match vendor.to_lowercase().as_str() {
        "nvidia" => gpu::GpuVendor::Nvidia,
        "amd" => gpu::GpuVendor::Amd,
        "intel" => gpu::GpuVendor::Intel,
        _ => gpu::GpuVendor::Unknown,
    };
    gpu::launch_control_panel(&v)
}

#[tauri::command]
fn auto_configure_gpu_scaling(state: State<'_, AppState>) -> Result<String, String> {
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

#[tauri::command]
fn get_windows() -> Result<Vec<window_manager::WindowInfo>, String> {
    Ok(window_manager::list_visible_windows())
}

#[tauri::command]
fn set_auto_borderless(enabled: bool) -> Result<(), String> {
    AUTO_BORDERLESS_ENABLED.store(enabled, Ordering::Relaxed);
    let _ = paths::write_data_file("auto_borderless.txt", if enabled { "1" } else { "0" });
    Ok(())
}

#[tauri::command]
fn get_auto_borderless() -> Result<bool, String> {
    Ok(AUTO_BORDERLESS_ENABLED.load(Ordering::Relaxed))
}

#[tauri::command]
fn make_window_borderless(hwnd: isize) -> Result<String, String> {
    window_manager::make_borderless(hwnd)
}

#[tauri::command]
fn restore_window_framed(hwnd: isize) -> Result<String, String> {
    window_manager::restore_window(hwnd)
}

#[tauri::command]
fn show_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.set_shadow(false);
        let clickthrough = !OVERLAY_EDIT_MODE.load(Ordering::Relaxed);
        let _ = window.set_ignore_cursor_events(clickthrough);
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_shadow(false);
        #[cfg(windows)]
        {
            if let Ok(hwnd) = window.hwnd() {
                let _ = window_manager::setup_overlay_window(hwnd.0 as isize, clickthrough);
            }
        }
        Ok(())
    } else {
        Err("Overlay window not found".to_string())
    }
}

#[tauri::command]
fn hide_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.hide().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Overlay window not found".to_string())
    }
}

#[tauri::command]
fn set_overlay_clickthrough(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.set_ignore_cursor_events(enabled);
        #[cfg(windows)]
        {
            if let Ok(hwnd) = window.hwnd() {
                let _ = window_manager::toggle_overlay_clickthrough(hwnd.0 as isize, enabled);
            }
        }
        if !enabled {
            let _ = window.set_focus();
        }
        Ok(())
    } else {
        Err("Overlay window not found".to_string())
    }
}

#[tauri::command]
fn set_overlay_edit_mode(app: tauri::AppHandle, in_edit_mode: bool) -> Result<(), String> {
    OVERLAY_EDIT_MODE.store(in_edit_mode, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.set_shadow(false);
        if in_edit_mode {
            let _ = window.set_ignore_cursor_events(false);
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.set_shadow(false);
            #[cfg(windows)]
            {
                if let Ok(hwnd) = window.hwnd() {
                    let _ = window_manager::set_overlay_editable(hwnd.0 as isize);
                }
            }
        } else {
            let _ = window.set_shadow(false);
            let _ = window.set_ignore_cursor_events(true);
            #[cfg(windows)]
            {
                if let Ok(hwnd) = window.hwnd() {
                    let _ = window_manager::toggle_overlay_clickthrough(hwnd.0 as isize, true);
                }
                // Hand focus back: the overlay owned focus while editing, and
                // a click-through layer that stays the ACTIVE window keeps DWM
                // painting active-frame chrome (the pale top bar). Exiting from
                // the app's button never hit this — the click itself had
                // already deactivated the overlay.
                unsafe {
                    use windows::Win32::Foundation::HWND;
                    use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
                    let target = window_manager::find_valorant_game_window()
                        .map(|w| w.hwnd)
                        .or_else(|| {
                            app.get_webview_window("main")
                                .and_then(|m| m.hwnd().ok())
                                .map(|h| h.0 as isize)
                        });
                    if let Some(raw) = target {
                        let _ = SetForegroundWindow(HWND(raw as *mut std::ffi::c_void));
                    }
                }
            }
        }
        let _ = app.emit("overlay-edit-mode-changed", in_edit_mode);
        Ok(())
    } else {
        Err("Overlay window not found".to_string())
    }
}

#[tauri::command]
fn get_overlay_edit_mode() -> Result<bool, String> {
    Ok(OVERLAY_EDIT_MODE.load(Ordering::Relaxed))
}

#[tauri::command]
fn is_overlay_visible(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("overlay") {
        Ok(window.is_visible().unwrap_or(false))
    } else {
        Ok(false)
    }
}

#[tauri::command]
fn is_tab_down() -> Result<bool, String> {
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
fn set_overlay_windowed(app: tauri::AppHandle, windowed: bool) -> Result<(), String> {
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
async fn get_valorant_configs() -> Result<Vec<game_config::ConfigFileInfo>, String> {
    tauri::async_runtime::spawn_blocking(game_config::find_valorant_configs)
        .await
        .map_err(|e| format!("Task failed: {}", e))
}

#[tauri::command]
fn update_valorant_config(
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
fn update_valorant_config_custom(
    path: String,
    options: game_config::CustomOptions,
) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    game_config::update_config_custom(p, &options)
}

#[tauri::command]
fn verify_valorant_configs(width: u32, height: u32) -> Result<Vec<game_config::VerifyResult>, String> {
    Ok(game_config::verify_all_configs(width, height))
}

#[tauri::command]
fn apply_custom_res_verbose(
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
fn get_valorant_config_raw(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    game_config::read_config_raw(p)
}

#[tauri::command]
fn get_valorant_config_sections(path: String) -> Result<Vec<game_config::SectionInfo>, String> {
    let p = std::path::Path::new(&path);
    game_config::get_all_sections(p)
}

#[tauri::command]
fn set_valorant_config_value(
    path: String,
    section: String,
    key: String,
    value: String,
    lock_readonly: bool,
) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    game_config::set_config_value(p, &section, &key, &value, lock_readonly)
}

#[tauri::command]
fn get_quick_shortcuts() -> Result<Vec<shortcuts::QuickShortcut>, String> {
    Ok(shortcuts::load_shortcuts())
}

#[tauri::command]
fn check_requested_tab() -> Option<String> {
    let content = paths::read_data_file("requested_tab.txt")?;
    // One-shot flag: consume it from both dirs so the migrated legacy copy is
    // not replayed by the read fallback on the next launch.
    paths::remove_data_file("requested_tab.txt");
    Some(content.trim().to_lowercase())
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct PROCESSENTRY32W {
    dw_size: u32,
    cnt_usage: u32,
    th32_process_id: u32,
    th32_default_heap_id: usize,
    th32_module_id: u32,
    cnt_threads: u32,
    th32_parent_process_id: u32,
    pc_pri_class_base: i32,
    dw_flags: u32,
    sz_exe_file: [u16; 260],
}

#[cfg(target_os = "windows")]
extern "system" {
    fn SetProcessWorkingSetSize(h_process: *mut std::ffi::c_void, dw_min: usize, dw_max: usize) -> i32;
    fn GetCurrentProcess() -> *mut std::ffi::c_void;
    fn GetCurrentProcessId() -> u32;
    fn CreateToolhelp32Snapshot(dw_flags: u32, th32_process_id: u32) -> *mut std::ffi::c_void;
    fn Process32FirstW(h_snapshot: *mut std::ffi::c_void, lppe: *mut PROCESSENTRY32W) -> i32;
    fn Process32NextW(h_snapshot: *mut std::ffi::c_void, lppe: *mut PROCESSENTRY32W) -> i32;
    fn OpenProcess(dw_desired_access: u32, b_inherit_handle: i32, dw_process_id: u32) -> *mut std::ffi::c_void;
    fn CloseHandle(h_object: *mut std::ffi::c_void) -> i32;
}

pub fn trim_working_set() {
    #[cfg(target_os = "windows")]
    unsafe {
        // 1. Trim host process itself (Recon)
        let handle = GetCurrentProcess();
        SetProcessWorkingSetSize(handle, usize::MAX, usize::MAX);

        // 2. Discover and trim all descendant WebView2 processes (Manager, GPU process, Renderer, Utility)
        let our_pid = GetCurrentProcessId();
        let snapshot = CreateToolhelp32Snapshot(0x00000002 /* TH32CS_SNAPPROCESS */, 0);
        if snapshot as isize != -1 && !snapshot.is_null() {
            let mut entries: Vec<(u32, u32)> = Vec::new();
            let mut entry = PROCESSENTRY32W {
                dw_size: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                cnt_usage: 0,
                th32_process_id: 0,
                th32_default_heap_id: 0,
                th32_module_id: 0,
                cnt_threads: 0,
                th32_parent_process_id: 0,
                pc_pri_class_base: 0,
                dw_flags: 0,
                sz_exe_file: [0u16; 260],
            };

            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    entries.push((entry.th32_process_id, entry.th32_parent_process_id));
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);

            // Collect all descendants (children, grandchildren)
            let mut descendant_pids = std::collections::HashSet::new();
            let mut current_parents = std::collections::HashSet::new();
            current_parents.insert(our_pid);

            for _ in 0..4 {
                let mut next_parents = std::collections::HashSet::new();
                for &(pid, parent_pid) in &entries {
                    if current_parents.contains(&parent_pid) && !descendant_pids.contains(&pid) {
                        descendant_pids.insert(pid);
                        next_parents.insert(pid);
                    }
                }
                if next_parents.is_empty() {
                    break;
                }
                current_parents = next_parents;
            }

            // Flush physical working set for all WebView2 child processes
            for pid in descendant_pids {
                // PROCESS_SET_QUOTA (0x0100) | PROCESS_QUERY_LIMITED_INFORMATION (0x1000)
                let h_proc = OpenProcess(0x0100 | 0x1000, 0, pid);
                if !h_proc.is_null() {
                    SetProcessWorkingSetSize(h_proc, usize::MAX, usize::MAX);
                    CloseHandle(h_proc);
                }
            }
        }
    }
}

#[tauri::command]
async fn check_channel_update(
    webview: tauri::Webview,
    channel: String,
) -> Result<Option<updater::UpdateMetadata>, String> {
    updater::check_channel_update_internal(webview, channel).await
}

#[tauri::command]
fn get_autostart_enabled() -> Result<bool, String> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run = hkcu.open_subkey_with_flags("Software\\Microsoft\\Windows\\CurrentVersion\\Run", KEY_READ)
        .map_err(|e| format!("Failed to open Run key: {}", e))?;
    match run.get_value::<String, _>("Aspect") {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
fn set_autostart_enabled(enabled: bool) -> Result<bool, String> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run, _) = hkcu.create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .map_err(|e| format!("Failed to open Run key for write: {}", e))?;
    if enabled {
        let exe_path = std::env::current_exe()
            .map_err(|e| format!("Cannot get current exe path: {}", e))?;
        let exe_str = format!("\"{}\"", exe_path.to_string_lossy());
        run.set_value("Aspect", &exe_str)
            .map_err(|e| format!("Failed to set registry value: {}", e))?;
    } else {
        let _ = run.delete_value("Aspect");
    }
    Ok(enabled)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    updater::open_url(&url)
}

#[tauri::command]
fn trim_memory() -> Result<(), String> {
    trim_working_set();
    Ok(())
}

#[tauri::command]
async fn get_all_monitors() -> Result<Vec<display::MonitorDevice>, String> {
    tauri::async_runtime::spawn_blocking(display::get_all_monitors)
        .await
        .map_err(|e| format!("Task failed: {}", e))
}

#[tauri::command]
fn get_overlay_monitor() -> Result<String, String> {
    Ok(window_manager::get_overlay_monitor_setting())
}

#[tauri::command]
fn set_overlay_monitor(app: tauri::AppHandle, monitor: String) -> Result<String, String> {
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

/// Kept for backend compat only. The Display Manager UI no longer exposes CCD
/// Attached/Detached — only Device Manager Enable/Disable remains. Retained so
/// existing invokes / restore paths don't break.
#[tauri::command]
fn set_monitor_attached(device_name: String, attached: bool) -> Result<Vec<display::MonitorDevice>, String> {
    display::set_monitor_topology_attached(&device_name, attached)
}

#[tauri::command]
fn set_monitor_device_enabled(monitor_id: String, enabled: bool) -> Result<Vec<display::MonitorDevice>, String> {
    display::set_monitor_device_enabled(&monitor_id, enabled)
}

#[tauri::command]
fn set_monitor_primary(device_name: String) -> Result<Vec<display::MonitorDevice>, String> {
    display::set_monitor_primary(&device_name)
}

#[tauri::command]
fn launch_cru() -> Result<(), String> {
    display::launch_cru()
}

#[tauri::command]
fn restart_graphics_driver() -> Result<String, String> {
    Ok(custom_res::restart_driver_stack())
}

#[tauri::command]
fn reset_all_cru_overrides() -> Result<String, String> {
    custom_res::reset_all_edid_overrides()
}

#[tauri::command]
fn reset_all_edid_overrides() -> Result<String, String> {
    custom_res::reset_all_edid_overrides()
}

#[tauri::command]
fn test_custom_mode(width: u32, height: u32, hz: u32) -> Result<custom_res::CustomModeTest, String> {
    custom_res::validate_custom_resolution(width, height, hz)?;
    Ok(custom_res::test_display_mode(None, width, height, hz))
}

#[tauri::command]
fn add_custom_resolution(monitor_id: String, width: u32, height: u32, hz: u32) -> Result<String, String> {
    custom_res::add_custom_resolution(&monitor_id, width, height, hz)
}

#[tauri::command]
fn remove_custom_override(monitor_id: String) -> Result<String, String> {
    custom_res::remove_custom_override(&monitor_id)
}

#[tauri::command]
fn list_supported_modes() -> Result<Vec<display::DisplayMode>, String> {
    Ok(display::get_all_supported_modes())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Copy any pre-rename data out of %LOCALAPPDATA%\TrueStretchStudio before
    // the first read below; copy-only, per file, idempotent, failures logged.
    paths::migrate_legacy_data();

    let initial_shortcut = display::load_saved_hotkey();
    let (hotkey_controller, rx) = display::start_hotkey_listener(initial_shortcut);

    let (_native_w, native_h) = display::get_native_resolution();
    let default_stretched_w = {
        let raw = ((native_h as f64) * 1.45).round() as u32;
        // 8-pixel horizontal alignment for native AMD/NVIDIA/Intel hardware timing compatibility
        // (e.g. 2088 for 1440p panel, 1568 for 1080p panel)
        ((raw + 4) / 8) * 8
    };

    let (saved_w, saved_h) = display::load_saved_stretched_res(default_stretched_w, native_h);
    let preferred_stretched = std::sync::Arc::new(Mutex::new((saved_w, saved_h)));
    let pref_clone = std::sync::Arc::clone(&preferred_stretched);

    let initial_auto_bl = paths::read_data_file("auto_borderless.txt")
        .map(|s| s.trim() == "1")
        .unwrap_or(false);
    AUTO_BORDERLESS_ENABLED.store(initial_auto_bl, Ordering::Relaxed);

    // Self-heal: earlier builds wrote vendor display keys (AMD Dal*, Intel
    // ScaleOption*, DxgkUsePhysicalMode) that do nothing on current drivers and
    // left AMD machines with a broken scale/HDMI-audio state. Purge them once
    // per launch — idempotent and registry-only, so it is safe to always run.
    std::thread::spawn(|| {
        let _ = gpu::purge_legacy_vendor_overrides();
    });

    let app_state = AppState {
        hotkey_controller,
        preferred_stretched,
    };

    // MCP Bridge plugin enabled for automation and live MCP verification
    // Single-instance: re-running the exe/shortcut while Aspect sits in the
    // tray focuses the existing window instead of spawning a second copy.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_mcp_bridge::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));

    builder
        .manage(app_state)
        .setup(move |app| {
            // Dev-only: re-create the boot-time dev dashboard that used to be
            // declared in tauri.conf.json. Compiled out of release entirely —
            // no renderer, no window, nothing to hide.
            #[cfg(debug_assertions)]
            if let Err(e) = build_dev_window(app.handle()) {
                log::warn!("[dev] dev dashboard window: {e}");
            }
            space_spam::start(app.handle());
            let handle = app.handle().clone();
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

            // Background Auto-Borderless Daemon for Valorant:
            // Runs continuously in the background only when explicitly enabled by the user.
            let auto_bl_handle = app.handle().clone();
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

            // Auto In-Game Overlay Daemon:
            // Shows overlay automatically when Valorant is the foreground window,
            // and hides it when Valorant exits OR is tabbed out (background).
            // Hiding while background lets the compositor skip the fullscreen
            // transparent WebView entirely — at 260Hz that vsync churn alone is
            // several percent CPU before any JS runs. The 2s cadence stays:
            // worst-case re-show on tab-back-in is ~2s, fine against
            // agent-select/pregame durations.
            // Edit-mode / windowed-debug precedence: daemon never hides while
            // editing (set_overlay_edit_mode already forces visible on entry).
            // Last daemon decision for the debug-only change-of-decision trace
            // below: u8::MAX = none yet, 0 = skip, 1 = show, 2 = hide.
            #[cfg(debug_assertions)]
            static LAST_OVERLAY_DECISION: std::sync::atomic::AtomicU8 =
                std::sync::atomic::AtomicU8::new(u8::MAX);
            let auto_overlay_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(2000));
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
                    let should_show = valorant_present && valorant_foreground;
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
                            let _ = show_overlay(auto_overlay_handle.clone());
                        } else if !should_show && is_vis {
                            let _ = hide_overlay(auto_overlay_handle.clone());
                        } else if should_show && is_vis {
                            #[cfg(windows)]
                            if let Ok(hwnd) = overlay.hwnd() {
                                let _ = window_manager::align_overlay_to_valorant(hwnd.0 as isize);
                                // Self-heal: if something re-applied default styles
                                // (opaque layer eating game input), reassert click-through.
                                if window_manager::overlay_clickthrough_missing(hwnd.0 as isize) {
                                    let _ = overlay.set_ignore_cursor_events(true);
                                    let _ = window_manager::toggle_overlay_clickthrough(hwnd.0 as isize, true);
                                }
                            }
                        }
                    }
                }
            });

            // Working-set trims happen on hide/unfocus events below — no timer:
            // EmptyWorkingSet every 12s was faulting hot pages back in and
            // hitching the UI on a fixed cadence.

            // Explicitly set high-res icon on the main window for crystal clear Windows taskbar & titlebar rendering
            if let Some(window) = app.get_webview_window("main") {
                let img = tauri::include_image!("icons/icon.png");
                let _ = window.set_icon(img);
                // Single runtime owner of the main window floor. Windows
                // enforces ptMinTrackSize on the OUTER rect, so a bare
                // MAIN_WINDOW_SIZE_LOGICAL floor let the client area shrink to
                // 1194x791 and the layout overflow. Measure the undecorated
                // frame delta per launch (DPI- and Windows-version-dependent)
                // and add it, guaranteeing a 1210x800 CONTENT area. The
                // frontend no longer touches min size (its call was
                // ACL-denied and drifted with whatever outer size it saw).
                let (main_w, main_h) = MAIN_WINDOW_SIZE_LOGICAL;
                let scale = window.scale_factor().unwrap_or(1.0);
                let (frame_w, frame_h) = match (window.outer_size(), window.inner_size()) {
                    (Ok(outer), Ok(inner)) => (
                        outer.width.saturating_sub(inner.width) as f64,
                        outer.height.saturating_sub(inner.height) as f64,
                    ),
                    _ => (0.0, 0.0),
                };
                // ceil: display rounding may never eat a pixel of the floor.
                let min_w = main_w + (frame_w / scale).ceil();
                let min_h = main_h + (frame_h / scale).ceil();
                log::info!(
                    "[window] main frame delta {frame_w}x{frame_h} px @ {scale}x -> min size {min_w}x{min_h} logical"
                );
                let _ = window.set_min_size(Some(tauri::LogicalSize::new(min_w, min_h)));
            }

            // Ensure overlay window starts in true click-through mode
            if let Some(overlay) = app.get_webview_window("overlay") {
                let _ = overlay.set_shadow(false);
                let _ = overlay.set_ignore_cursor_events(true);
                #[cfg(windows)]
                if let Ok(hwnd) = overlay.hwnd() {
                    let _ = window_manager::toggle_overlay_clickthrough(hwnd.0 as isize, true);
                }
            }

            // Create System Tray Menu
            let show_i = MenuItem::with_id(app, "show", "Show Aspect", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Aspect", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            if let Some(icon) = app.default_window_icon() {
                let _tray = TrayIconBuilder::new()
                    .icon(icon.clone())
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .tooltip("Aspect • Stretched Resolution & Utility")
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "quit" => {
                            app.exit(0);
                        }
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let _ = window.hide();
                    api.prevent_close();
                    trim_working_set();
                    std::thread::spawn(|| {
                        std::thread::sleep(std::time::Duration::from_millis(300));
                        trim_working_set();
                    });
                }
                tauri::WindowEvent::Focused(false) => {
                    trim_working_set();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_display_info,
            apply_resolution,
            toggle_profile,
            get_preferred_stretched_res,
            set_preferred_stretched_res,
            apply_custom_res_to_all_configs,
            get_shortcut_binding,
            save_shortcut_binding,
            get_gpu_info,
            get_gpu_settings,
            set_gpu_setting,
            open_gpu_panel,
            auto_configure_gpu_scaling,
            get_windows,
            set_auto_borderless,
            get_auto_borderless,
            make_window_borderless,
            restore_window_framed,
            show_overlay,
            hide_overlay,
            set_overlay_clickthrough,
            set_overlay_edit_mode,
            get_overlay_edit_mode,
            is_overlay_visible,
            is_tab_down,
            set_overlay_windowed,
            get_valorant_configs,
            update_valorant_config,
            update_valorant_config_custom,
            verify_valorant_configs,
            apply_custom_res_verbose,
            get_valorant_config_raw,
            get_valorant_config_sections,
            set_valorant_config_value,
            tracker::is_riot_client_running,
            tracker::detect_local_account,
            tracker::local_entitlements,
            tracker::local_request,
            tracker::local_presences,
            tracker::local_client_version,
            tracker::riot_direct_get,
            tracker::riot_direct_post,
            tracker::riot_direct_put,
            accounts::accounts_list,
            accounts::account_current,
            accounts::account_save_current,
            accounts::accounts_auto_tick,
            accounts::account_switch,
            accounts::account_remove,
            accounts::accounts_get_auto_start,
            accounts::accounts_set_auto_start,
            accounts::account_add_new,
            accounts::account_launch_client,
            tracker::riot_resolve_names,
            tracker::riot_local_namesets,
            trn_proxy::trn_proxy_fetch,
            trn_proxy::trn_proxy_paused,
            trn_proxy::trn_proxy_state,
            trn_proxy::trn_trace_log,
            trn_cache::trn_cache_get,
            trn_cache::trn_cache_put,
            trn_cache::trn_cache_read,
            trn_cache::trn_cache_write,
            trn_cache::trn_cache_stats,
            trn_cache::trn_cache_trace_log,
            perf::perf_poll,
            space_spam::set_space_spam,
            get_quick_shortcuts,
            check_requested_tab,
            trim_memory,
            get_all_monitors,
            get_overlay_monitor,
            set_overlay_monitor,
            set_monitor_attached,
            set_monitor_device_enabled,
            set_monitor_primary,
            launch_cru,
            restart_graphics_driver,
            reset_all_cru_overrides,
            reset_all_edid_overrides,
            test_custom_mode,
            add_custom_resolution,
            remove_custom_override,
            list_supported_modes,
            check_channel_update,
            get_autostart_enabled,
            set_autostart_enabled,
            open_external_url,
            open_dev_window,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_start_dragging,
            window_is_maximized,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
