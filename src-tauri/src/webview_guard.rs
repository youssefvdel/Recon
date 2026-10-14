// WebView2 runtime guard for debloated Windows machines.
//
// Valorant players commonly run debloated Windows images with the WebView2
// runtime stripped out. Tauri renders Recon through WebView2 (Edge Chromium),
// so without it the app cannot create its window and dies with a cryptic
// error. This check runs first in `run()`: if no runtime is detected we show
// a plain-English message box, open the official Microsoft installer, and
// exit instead of crashing.
//
// Detection order: registry `pv` version value (HKLM + HKCU, both registry
// views) then the on-disk EdgeWebView folder as a fallback. Any single hit
// counts as present — debloat scripts usually remove all of them together.

#[cfg(windows)]
const WEBVIEW2_CLIENT_ID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

#[cfg(windows)]
const REG_SUBKEY_SUFFIX: &str = "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients";

#[cfg(windows)]
const PV_VALUE_NAME: &str = "pv";

#[cfg(windows)]
fn registry_has_webview2() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_WOW64_32KEY};
    use winreg::RegKey;

    let subkey = format!("{}\\{}", REG_SUBKEY_SUFFIX, WEBVIEW2_CLIENT_ID);
    let wow_subkey = format!("{}\\{}", "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients", WEBVIEW2_CLIENT_ID);

    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let root = RegKey::predef(hive);
        // Native view.
        if let Ok(key) = root.open_subkey_with_flags(&subkey, KEY_QUERY_VALUE) {
            if let Ok(version) = key.get_value::<String, _>(PV_VALUE_NAME) {
                if !version.trim().is_empty() {
                    return true;
                }
            }
        }
        // 32-bit view (debloated images sometimes leave only one behind).
        if let Ok(key) = root.open_subkey_with_flags(&wow_subkey, KEY_QUERY_VALUE | KEY_WOW64_32KEY) {
            if let Ok(version) = key.get_value::<String, _>(PV_VALUE_NAME) {
                if !version.trim().is_empty() {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(windows)]
fn disk_has_webview2() -> bool {
    // `%ProgramFiles(x86)%\Microsoft\EdgeWebView\Application\<version>\msedgewebview2.exe`
    // Check both Program Files locations; any version folder with the exe counts.
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    for env_key in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Ok(dir) = std::env::var(env_key) {
            roots.push(std::path::PathBuf::from(dir).join("Microsoft").join("EdgeWebView").join("Application"));
        }
    }
    for app_dir in roots {
        if let Ok(entries) = std::fs::read_dir(&app_dir) {
            for entry in entries.flatten() {
                if entry.path().join("msedgewebview2.exe").is_file() {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(windows)]
fn show_missing_runtime_dialog() {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONERROR, MB_OK, SW_SHOWNORMAL,
    };
    use windows::core::{w, PCWSTR};

    unsafe {
        // Keep the message short: debloat users need the fix, not the internals.
        let _ = MessageBoxW(
            HWND(std::ptr::null_mut()),
            w!("Recon cannot start because the WebView2 runtime is missing.\n\nDebloated Windows images often remove it. Press OK to open the official Microsoft installer, run it, then start Recon again."),
            w!("Recon - WebView2 runtime missing"),
            MB_OK | MB_ICONERROR,
        );
        // Best effort: open the evergreen standalone installer in the browser.
        // All three literals, so `w!` covers everything — no HSTRING needed.
        ShellExecuteW(
            HWND(std::ptr::null_mut()),
            w!("open"),
            w!("https://go.microsoft.com/fwlink/p/?LinkId=2124703"),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
    }
}

/// Call at the very top of `run()` on Windows. Returns normally when the
/// runtime is present; otherwise shows the dialog, opens the installer page,
/// and terminates the process so Tauri never hits the cryptic webview error.
#[cfg(windows)]
pub fn ensure_webview2_or_exit() {
    if registry_has_webview2() || disk_has_webview2() {
        return;
    }
    log::warn!("[webview-guard] WebView2 runtime not detected; showing repair dialog");
    show_missing_runtime_dialog();
    std::process::exit(3);
}

#[cfg(not(windows))]
pub fn ensure_webview2_or_exit() {}
