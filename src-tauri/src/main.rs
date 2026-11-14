// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    unsafe {
        use windows::core::w;
        use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
        let _ = SetCurrentProcessExplicitAppUserModelID(w!("com.outpeek.utility"));
    }

    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGS",
        "--disable-features=CalculateNativeWinOcclusion,msSmartScreenProtection --disable-background-networking --disable-component-update --disable-domain-reliability --disable-renderer-backgrounding --in-process-gpu --disable-gpu-process-for-dx12-info-collection",
    );
    app_lib::run();
}
