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
mod trn_http;
mod trn_proxy;
mod window_manager;
mod updater;
mod webview_guard;
mod settings;
mod state;
mod win;
mod commands;

// Re-exported at the crate root so the split moved code without moving any
// caller: `crate::OVERLAY_EDIT_MODE` and friends still resolve.
pub use state::OVERLAY_EDIT_MODE;
pub(crate) use state::{
    AppState, DisplayInfo, AUTO_BORDERLESS_ENABLED, MAIN_WINDOW_SIZE_LOGICAL, OVERLAY_AVAILABLE,
    OVERLAY_EDIT_WATCHDOG_MS, OVERLAY_PRESENT, OVERLAY_WINDOWED,
};
pub(crate) use commands::display::build_display_info;
pub(crate) use win::tray::build_tray;
pub(crate) use win::overlay::{
    build_overlay_window, force_overlay_edit_mode_off, get_overlay_edit_mode, get_overlay_monitor,
    hide_overlay, is_overlay_visible, is_tab_down, set_overlay_clickthrough, set_overlay_edit_mode,
    set_overlay_monitor, set_overlay_present, set_overlay_windowed, show_overlay,
};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State,
};


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
fn get_windows() -> Result<Vec<window_manager::WindowInfo>, String> {
    Ok(window_manager::list_visible_windows())
}

#[tauri::command]
fn set_auto_borderless(enabled: bool) -> Result<(), String> {
    AUTO_BORDERLESS_ENABLED.store(enabled, Ordering::Relaxed);
    crate::settings::set_auto_borderless(enabled);
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
    match run.get_value::<String, _>("Recon") {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
fn set_autostart_enabled(enabled: bool) -> Result<bool, String> {
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

/// Start-minimized pref for boot launches. Lives in settings.json (not
/// localStorage) so the backend can honor it before any window exists.
/// Default ON: a login launch should never pop a window over the game.
fn start_minimized_enabled() -> bool {
    crate::settings::is_start_minimized()
}

#[tauri::command]
fn get_start_minimized() -> Result<bool, String> {
    Ok(start_minimized_enabled())
}

#[tauri::command]
fn set_start_minimized(enabled: bool) -> Result<bool, String> {
    crate::settings::set_start_minimized(enabled);
    // Re-write the Run entry so a stored boot launch picks up the new flag.
    if get_autostart_enabled().unwrap_or(false) {
        return set_autostart_enabled(true);
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

/// Directory `tauri-plugin-log` writes to: `%LOCALAPPDATA%\<identifier>\logs` —
/// the same path the plugin resolves through `app_log_dir()`. Duplicated here so
/// failures that happen BEFORE the logger attaches (WebView2 guard, startup)
/// still reach disk instead of vanishing.
fn app_log_dir(identifier: &str) -> std::path::PathBuf {
    std::env::var("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join(identifier)
        .join("logs")
}

/// Append one line to `recon-startup.log`. Pre-logger paths only; never panics,
/// never blocks startup, silently gives up if the disk is unwritable.
fn append_startup_log(identifier: &str, level: log::Level, msg: &str) {
    let dir = app_log_dir(identifier);
    let _ = std::fs::create_dir_all(&dir);
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("recon-startup.log"))
    else {
        return;
    };
    use std::io::Write;
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = writeln!(file, "[{ms}] {level} {msg}");
}

/// Through the plugin when it is attached, straight to the file when it is not.
/// `tauri-plugin-log` is now registered, but its setup runs late: the guard and
/// a failed `Builder::run` both execute before it, and those are exactly the
/// lines worth having.
pub(crate) fn log_line(identifier: &str, level: log::Level, msg: &str) {
    if log::max_level() == log::LevelFilter::Off {
        append_startup_log(identifier, level, msg);
    } else {
        log::log!(level, "{msg}");
    }
}

/// `tauri-plugin-log` registration policy — the plugin was a dependency but was
/// never registered, so every `log::` call in this app was a no-op.
///
/// File target in the app log dir, warn+ everywhere, info from our own crate,
/// 4 MB rotation keeping one backup, stderr in debug builds. Writability is
/// probed FIRST: the plugin's setup returns Err when it cannot create the
/// directory, and a plugin setup error aborts the whole app. A broken log path
/// must never be a startup failure — it degrades to stderr.
fn build_log_plugin<R: tauri::Runtime>(identifier: &str) -> tauri::plugin::TauriPlugin<R> {
    use tauri_plugin_log::{Builder, RotationStrategy, Target, TargetKind, TimezoneStrategy};

    let mut builder = Builder::new()
        .level(log::LevelFilter::Warn)
        .level_for("app_lib", log::LevelFilter::Info)
        .max_file_size(4 * 1024 * 1024)
        .rotation_strategy(RotationStrategy::KeepOne)
        .timezone_strategy(TimezoneStrategy::UseLocal);

    let dir = app_log_dir(identifier);
    let writable = std::fs::create_dir_all(&dir).is_ok()
        && std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("recon-startup.log"))
            .is_ok();

    if writable {
        // Debug: file + stderr, replacing the plugin's default stdout target so
        // a dev console does not get every line twice.
        #[cfg(debug_assertions)]
        {
            builder = builder.targets(vec![
                Target::new(TargetKind::LogDir { file_name: None }),
                Target::new(TargetKind::Stderr),
            ]);
        }
    } else {
        builder = builder.targets(vec![Target::new(TargetKind::Stderr)]);
    }

    builder.build()
}

/// Last-resort surface for a fatal startup error.
///
/// Release builds run with `windows_subsystem = "windows"` (`main.rs`), so the
/// process has no console: a panic or an `.expect()` on `Builder::run` writes
/// its message nowhere, the process dies, and the user sees zero windows and no
/// dialog. That is exactly how the broken bundled WebView2 runtime presented in
/// 0.4.x. A MessageBox is the only channel that survives a dead console, so
/// every fatal startup path goes through here.
fn show_message_box(title: &str, body: &str) {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

        // MessageBoxW takes NUL-terminated UTF-16; build both strings by hand
        // (same shape as window_manager's SetWindowTextW call) so nothing here
        // depends on an HSTRING import.
        let mut body_w: Vec<u16> = body.encode_utf16().collect();
        body_w.push(0);
        let mut title_w: Vec<u16> = title.encode_utf16().collect();
        title_w.push(0);

        let _ = MessageBoxW(
            HWND(std::ptr::null_mut()),
            windows::core::PCWSTR(body_w.as_ptr()),
            windows::core::PCWSTR(title_w.as_ptr()),
            MB_OK | MB_ICONERROR,
        );
    }
    #[cfg(not(windows))]
    eprintln!("{title}: {body}");
}

fn fatal_startup_error(identifier: &str, detail: &str) {
    log_line(
        identifier,
        log::Level::Error,
        &format!("[startup] fatal: {detail}"),
    );
    show_message_box(
        "Recon - startup failed",
        &format!(
            "Recon could not start.\n\nRe-run the installer or check the WebView2 runtime.\n\nDetails: {detail}"
        ),
    );
    std::process::exit(1);
}

/// What the player reads when the HUD window could not be built. Pure so it can
/// be unit-tested without a window.
fn overlay_unavailable_message(detail: &str) -> String {
    format!(
        "The in-game HUD window could not be created, so Recon is running without overlays.\n\nEverything else keeps working. Restart Recon, and if the HUD stays missing re-run the installer or check the WebView2 runtime.\n\nDetails: {detail}"
    )
}

pub(crate) fn notify_overlay_unavailable(detail: &str) {
    log::warn!("[overlay] unavailable: {detail}");
    show_message_box(
        "Recon - HUD unavailable",
        &overlay_unavailable_message(detail),
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Context is built once and reused: it carries the bundle identifier that
    // both the log plugin and the pre-logger startup log resolve their path from.
    let context = tauri::generate_context!();
    let log_id = context.config().identifier.clone();

    // Debloated Windows images often ship without WebView2. Fail with a
    // repair dialog instead of the cryptic webview-creation error.
    webview_guard::ensure_webview2_or_exit(&log_id);

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

    let initial_auto_bl = crate::settings::is_auto_borderless();
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
        // Registered FIRST: every other plugin's warnings should reach the file.
        .plugin(build_log_plugin(&log_id))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Our own remote-control surface for testing the running app. It can
        // execute JS and invoke commands with no authentication, so it binds to
        // loopback only: a machine on the LAN must not be able to drive Recon.
        // Remote tooling reaches it through an SSH tunnel.
        .plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));

    let setup_log_id = log_id.clone();
    let run_result = builder
        .manage(app_state)
        .setup(move |app| {
            // Boot-to-tray: the Run entry passes --minimized at login, so the
            // main window stays hidden and the tray icon owns the session.
            // A tray click (or single-instance re-launch) shows it again.
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.hide();
                }
            }
            // Dev-only: re-create the boot-time dev dashboard that used to be
            // declared in tauri.conf.json. Compiled out of release entirely —
            // no renderer, no window, nothing to hide.
            #[cfg(debug_assertions)]
            if let Err(e) = build_dev_window(app.handle()) {
                log::warn!("[dev] dev dashboard window: {e}");
            }

            // The HUD is built here, not by Tauri's config loop, so a webview
            // failure disables overlays instead of killing the app. Every
            // overlay daemon below reads OVERLAY_AVAILABLE and no-ops when this
            // failed; the tray reports the reason on demand.
            match build_overlay_window(app.handle()) {
                Ok(_) => OVERLAY_AVAILABLE.store(true, Ordering::Relaxed),
                Err(e) => {
                    log_line(
                        &setup_log_id,
                        log::Level::Error,
                        &format!("[overlay] HUD window creation failed; running without overlays: {e}"),
                    );
                }
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
                                if window_manager::overlay_clickthrough_missing(hwnd.0 as isize) {
                                    log::warn!("overlay daemon: click-through lost — reasserting");
                                    let _ = overlay.set_ignore_cursor_events(true);
                                    if let Err(e) = window_manager::toggle_overlay_clickthrough(
                                        hwnd.0 as isize,
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

            // Overlay fail-safe guard (audit overlay#1 + #4). One 100 ms thread:
            //   (a) Ctrl+Shift+H always leaves edit mode — no WebView focus, no
            //       DOM Esc, works even when the overlay renderer is dead;
            //   (b) edit mode with no mouse activity for OVERLAY_EDIT_WATCHDOG_MS
            //       is force-exited (an abandoned edit session was a fullscreen
            //       topmost window eating every click until app exit);
            //   (c) when the UI reports no content, the full-screen alpha layer
            //       is shown only while Tab is held, so it is not composited for
            //       the whole match (the audit's Tab-peek gate).
            let guard_handle = app.handle().clone();
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
                    // content of its own; otherwise the 2 s daemon owns it.
                    let gated = !OVERLAY_EDIT_MODE.load(Ordering::Relaxed)
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

            build_tray(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Audit overlay#1c: a closing overlay must never leave edit
                    // mode armed — the flag would keep the HWND in raw-input
                    // mode with no webview to press Esc in.
                    if window.label() == "overlay" {
                        force_overlay_edit_mode_off(window.app_handle(), "overlay close");
                    }
                    let _ = window.hide();
                    api.prevent_close();
                    trim_working_set();
                    std::thread::spawn(|| {
                        std::thread::sleep(std::time::Duration::from_millis(300));
                        trim_working_set();
                    });
                }
                tauri::WindowEvent::Destroyed => {
                    // Renderer/window gone (crash, forced destroy): same rule.
                    if window.label() == "overlay" {
                        force_overlay_edit_mode_off(window.app_handle(), "overlay destroyed");
                    }
                    trim_working_set();
                }
                tauri::WindowEvent::Focused(false) => {
                    trim_working_set();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::display::get_display_info,
            commands::display::apply_resolution,
            commands::display::toggle_profile,
            commands::display::get_preferred_stretched_res,
            commands::display::set_preferred_stretched_res,
            commands::display::apply_custom_res_to_all_configs,
            get_shortcut_binding,
            save_shortcut_binding,
            commands::gpu::get_gpu_info,
            commands::gpu::get_gpu_settings,
            commands::gpu::set_gpu_setting,
            commands::gpu::open_gpu_panel,
            commands::gpu::auto_configure_gpu_scaling,
            get_windows,
            set_auto_borderless,
            get_auto_borderless,
            make_window_borderless,
            restore_window_framed,
            win::overlay::show_overlay,
            win::overlay::hide_overlay,
            win::overlay::set_overlay_clickthrough,
            win::overlay::set_overlay_edit_mode,
            win::overlay::get_overlay_edit_mode,
            win::overlay::is_overlay_visible,
            win::overlay::set_overlay_present,
            win::overlay::is_tab_down,
            win::overlay::set_overlay_windowed,
            get_valorant_configs,
            update_valorant_config,
            update_valorant_config_custom,
            verify_valorant_configs,
            commands::display::apply_custom_res_verbose,
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
            trn_proxy::trn_proxy_reset,
            trn_proxy::trn_verify_open,
            trn_proxy::trn_warden_token,
            trn_proxy::trn_trace_log,
            trn_http::trn_http_get,
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
            commands::display::get_all_monitors,
            win::overlay::get_overlay_monitor,
            win::overlay::set_overlay_monitor,
            commands::display::set_monitor_attached,
            commands::display::set_monitor_device_enabled,
            commands::display::set_monitor_primary,
            commands::display::launch_cru,
            commands::display::restart_graphics_driver,
            commands::display::reset_all_cru_overrides,
            commands::display::reset_all_edid_overrides,
            commands::display::test_custom_mode,
            commands::display::add_custom_resolution,
            commands::display::remove_custom_override,
            commands::display::list_supported_modes,
            check_channel_update,
            get_autostart_enabled,
            set_autostart_enabled,
            get_start_minimized,
            set_start_minimized,
            open_external_url,
            open_dev_window,
            commands::window::window_minimize,
            commands::window::window_toggle_maximize,
            commands::window::window_close,
            commands::window::window_start_dragging,
            commands::window::window_is_maximized,
        ])
        .run(context);

    // No `.expect()` here: this process has no console, so a panic on a failed
    // run (window/webview creation is the usual cause) exits silently with zero
    // windows. Surface it in a dialog instead.
    if let Err(error) = run_result {
        fatal_startup_error(&log_id, &error.to_string());
    }
}

#[cfg(test)]
mod overlay_startup_tests {
    use super::overlay_unavailable_message;

    /// The player-facing text is the whole point of the non-fatal path: it must
    /// say the app still works and carry the underlying error for support.
    #[test]
    fn unavailable_message_names_the_hud_and_carries_the_detail() {
        let msg = overlay_unavailable_message("failed to create webview: 0x80070002");
        assert!(msg.contains("running without overlays"));
        assert!(msg.contains("failed to create webview: 0x80070002"));
        assert!(msg.contains("HUD"));
    }
}
