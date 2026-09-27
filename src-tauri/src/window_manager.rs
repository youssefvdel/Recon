use windows::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, RedrawWindow, HRGN, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE,
};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetSystemMetrics, GetWindowLongPtrW,
    GetWindowRect, GetWindowTextLengthW, GetWindowTextW, IsWindow, IsWindowVisible,
    SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, GWL_STYLE,
    HWND_TOP, HWND_TOPMOST, SM_CXSCREEN, SM_CYSCREEN, SWP_FRAMECHANGED, SWP_NOACTIVATE,
    SWP_NOZORDER, SWP_SHOWWINDOW, SW_SHOW, WINDOW_STYLE, WS_BORDER, WS_CAPTION, WS_EX_TOOLWINDOW,
    WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_OVERLAPPEDWINDOW, WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
};

#[link(name = "comctl32")]
extern "system" {
    fn SetWindowSubclass(
        hwnd: HWND,
        pfn_subclass: Option<
            unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM, usize, usize) -> LRESULT,
        >,
        u_id_subclass: usize,
        dw_ref_data: usize,
    ) -> BOOL;

    fn DefSubclassProc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT;
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct WindowInfo {
    pub hwnd: isize,
    pub title: String,
    #[serde(default)]
    pub class_name: String,
    #[serde(default)]
    pub is_game: bool,
}

pub fn list_visible_windows() -> Vec<WindowInfo> {
    let mut windows: Vec<WindowInfo> = Vec::new();
    let lparam = &mut windows as *mut Vec<WindowInfo> as isize;

    unsafe {
        let _ = EnumWindows(Some(enum_windows_proc), LPARAM(lparam));
    }

    windows
}

unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }

        let length = GetWindowTextLengthW(hwnd);
        if length == 0 {
            return BOOL(1);
        }

        // Filter out zero-size and tool windows
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return BOOL(1);
        }
        if (rect.right - rect.left) < 120 || (rect.bottom - rect.top) < 80 {
            return BOOL(1);
        }

        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
            return BOOL(1);
        }

        let mut buffer: Vec<u16> = vec![0; (length + 1) as usize];
        let copied = GetWindowTextW(hwnd, &mut buffer);
        if copied > 0 {
            let title = String::from_utf16_lossy(&buffer[..copied as usize]);
            let trimmed = title.trim();
            if !trimmed.is_empty()
                && trimmed != "Program Manager"
                && trimmed != "Windows Input Experience"
                && !trimmed.starts_with("Settings")
                && trimmed != "True Stretch Toolkit"
                && trimmed != "Aspect"
            {
                let mut class_buf = [0u16; 128];
                let class_len = GetClassNameW(hwnd, &mut class_buf);
                let class_name = if class_len > 0 {
                    String::from_utf16_lossy(&class_buf[..class_len as usize])
                } else {
                    String::new()
                };

                let is_game = is_game_window(hwnd, trimmed, &class_name);

                let windows = &mut *(lparam.0 as *mut Vec<WindowInfo>);
                windows.push(WindowInfo {
                    hwnd: hwnd.0 as isize,
                    title: trimmed.to_string(),
                    class_name,
                    is_game,
                });
            }
        }

        BOOL(1)
    }
}

pub fn is_valorant_game_window(_hwnd: HWND, title: &str, class_name: &str) -> bool {
    let trimmed = title.trim();
    let lower = trimmed.to_lowercase();

    // 1. Filter out companion apps, trackers, overlays, and launchers.
    // "Valorant Tracker", "Overwolf", "Blitz", "Riot Client", etc.
    if lower.contains("tracker")
        || lower.contains("overwolf")
        || lower.contains("blitz")
        || lower.contains("riot client")
        || lower.contains("aspect")
        || lower.contains("discord")
        || lower.contains("obs")
        || lower.contains("chrome")
        || lower.contains("edge")
    {
        return false;
    }

    // 2. Valorant's real game client is an Unreal Engine 4 window ("UnrealWindow" or "VALORANTUnrealWindow").
    // Third-party trackers and Electron wrappers are NEVER "UnrealWindow".
    if class_name == "UnrealWindow"
        || class_name == "VALORANTUnrealWindow"
        || class_name.contains("UnrealWindow")
    {
        return lower == "valorant" || lower.starts_with("valorant");
    }

    // 3. Fallback: exact match on title "VALORANT" if class_name is unavailable
    lower == "valorant" || lower.starts_with("valorant")
}

#[allow(dead_code)]
pub fn is_valorant_foreground() -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if !IsWindow(fg).as_bool() {
            return false;
        }
        let length = GetWindowTextLengthW(fg);
        if length == 0 {
            return false;
        }
        let mut buffer: Vec<u16> = vec![0; (length + 1) as usize];
        let copied = GetWindowTextW(fg, &mut buffer);
        if copied > 0 {
            let title = String::from_utf16_lossy(&buffer[..copied as usize]);
            let mut class_buf = [0u16; 128];
            let class_len = GetClassNameW(fg, &mut class_buf);
            let class_name = if class_len > 0 {
                String::from_utf16_lossy(&class_buf[..class_len as usize])
            } else {
                String::new()
            };
            return is_valorant_game_window(fg, title.trim(), &class_name);
        }
        false
    }
}

pub fn is_game_window(hwnd: HWND, title: &str, class_name: &str) -> bool {
    if is_valorant_game_window(hwnd, title, class_name) {
        return true;
    }
    let lower = title.trim().to_lowercase();
    if lower.contains("tracker")
        || lower.contains("overwolf")
        || lower.contains("blitz")
        || lower.contains("riot client")
        || lower.contains("aspect")
    {
        return false;
    }
    lower.contains("counter-strike") || lower.contains("cs2") || lower.contains("aimlabs")
}

pub fn find_valorant_game_window() -> Option<WindowInfo> {
    let windows = list_visible_windows();
    for w in windows {
        let hwnd = HWND(w.hwnd as *mut std::ffi::c_void);
        if is_valorant_game_window(hwnd, &w.title, &w.class_name) {
            return Some(w);
        }
    }
    None
}

pub fn is_window_borderless_fullscreen(hwnd: HWND) -> bool {
    unsafe {
        if !IsWindow(hwnd).as_bool() {
            return false;
        }

        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        let is_popup = (style & WS_POPUP.0) != 0;
        let has_caption = (style & (WS_CAPTION.0 | WS_THICKFRAME.0)) != 0;

        if !is_popup || has_caption {
            return false;
        }

        let h_mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };

        if GetMonitorInfoW(h_mon, &mut mi).as_bool() {
            let mut wr = RECT::default();
            if GetWindowRect(hwnd, &mut wr).is_ok() {
                let mon_w = mi.rcMonitor.right - mi.rcMonitor.left;
                let mon_h = mi.rcMonitor.bottom - mi.rcMonitor.top;
                let win_w = wr.right - wr.left;
                let win_h = wr.bottom - wr.top;
                return win_w == mon_w && win_h == mon_h;
            }
        }
        false
    }
}

pub fn make_borderless(hwnd_val: isize) -> Result<String, String> {
    unsafe {
        let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
        if !IsWindow(hwnd).as_bool() {
            return Err("Target window is no longer valid.".to_string());
        }

        let current_style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        let mut style = WINDOW_STYLE(current_style);

        // Strip decorations
        style &= !(WS_CAPTION
            | WS_THICKFRAME
            | WS_MINIMIZEBOX
            | WS_MAXIMIZEBOX
            | WS_SYSMENU
            | WS_BORDER);
        style |= WS_POPUP;

        SetWindowLongPtrW(hwnd, GWL_STYLE, style.0 as isize);

        // Query monitor bounds
        let h_mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };

        let (x, y, width, height) = if GetMonitorInfoW(h_mon, &mut mi).as_bool() {
            let rc: RECT = mi.rcMonitor;
            (rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top)
        } else {
            let cx = GetSystemMetrics(SM_CXSCREEN);
            let cy = GetSystemMetrics(SM_CYSCREEN);
            (0, 0, cx, cy)
        };

        // Borderless FULLSCREEN = strip the frame AND cover the whole monitor.
        // Applied twice: games often re-assert their own size on the first
        // style change — the second pass wins.
        //
        // SWP_NOACTIVATE | SWP_NOZORDER are load-bearing: without them this
        // raises AND activates the game, so every auto-apply buried Recon
        // behind Valorant and forced an alt-tab. The game does not need
        // z-order or activation to be borderless — only style + geometry.
        for _ in 0..2 {
            SetWindowPos(
                hwnd,
                HWND_TOP,
                x,
                y,
                width,
                height,
                SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .map_err(|e| format!("SetWindowPos failed: {}", e))?;
        }

        // Re-assert shortly after: Valorant reverts external resizes on some
        // frames. A background nudge wins without blocking the UI.
        // (HWND is a raw pointer, so the plain integer crosses threads.)
        let hwnd_val = hwnd_val;
        std::thread::spawn(move || {
            let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
            for ms in [400u64, 1000] {
                std::thread::sleep(std::time::Duration::from_millis(ms));
                if !IsWindow(hwnd).as_bool() {
                    break;
                }
                let _ = SetWindowPos(
                    hwnd,
                    HWND_TOP,
                    x,
                    y,
                    width,
                    height,
                    SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_NOZORDER,
                );
            }
        });

        // Read back what actually stuck, so the UI reports truth, not hope.
        let mut final_rect = RECT::default();
        let (fw, fh) = if GetWindowRect(hwnd, &mut final_rect).is_ok() {
            (
                final_rect.right - final_rect.left,
                final_rect.bottom - final_rect.top,
            )
        } else {
            (width, height)
        };

        Ok(format!(
            "Borderless fullscreen: window now {}x{} on a {}x{} screen",
            fw, fh, width, height
        ))
    }
}

pub fn restore_window(hwnd_val: isize) -> Result<String, String> {
    unsafe {
        let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
        if !IsWindow(hwnd).as_bool() {
            return Err("Target window is no longer valid.".to_string());
        }

        let current_style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        let mut style = WINDOW_STYLE(current_style);

        style &= !WS_POPUP;
        style |= WS_OVERLAPPEDWINDOW;

        SetWindowLongPtrW(hwnd, GWL_STYLE, style.0 as isize);

        SetWindowPos(
            hwnd,
            HWND_TOP,
            100,
            100,
            1280,
            720,
            SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_NOZORDER,
        )
        .map_err(|e| format!("SetWindowPos failed: {}", e))?;

        Ok("Window restored to standard framed mode.".to_string())
    }
}

/// Dev debugging aid: reshape the overlay into a normal framed window (and
/// back) using raw Win32 only — Tauri's set_decorations/set_fullscreen calls
/// silently no-op on this fullscreen-created window, so they are avoided.
pub fn set_overlay_windowed(hwnd_val: isize, windowed: bool) -> Result<(), String> {
    unsafe {
        let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
        if !IsWindow(hwnd).as_bool() {
            return Err("Overlay window handle is invalid.".to_string());
        }

        if windowed {
            // Restore from any maximized/fullscreen state first
            let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(
                hwnd,
                windows::Win32::UI::WindowsAndMessaging::SW_RESTORE,
            );

            // Set window title so title bar displays title
            let title: Vec<u16> = "Aspect Overlay (Debug Window)\0".encode_utf16().collect();
            let _ = windows::Win32::UI::WindowsAndMessaging::SetWindowTextW(
                hwnd,
                windows::core::PCWSTR(title.as_ptr()),
            );

            // Framed, resizable window with standard caption and controls
            let new_style: i32 = 0x14CF0000; // WS_VISIBLE | WS_CLIPSIBLINGS | WS_OVERLAPPEDWINDOW
            SetWindowLongPtrW(hwnd, GWL_STYLE, new_style as isize);

            // Eat clicks, activatable, normal z-order, NOT toolwindow
            let mut ex_style = (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32) | 0x00080000; // WS_EX_LAYERED
            ex_style &= !(0x00000020 | 0x08000000 | 0x00000008 | 0x00000080);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style as isize);

            // Center a 1280x800 window on the nearest monitor.
            let h_mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut mi = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            let (mx, my, mw, mh) = if GetMonitorInfoW(h_mon, &mut mi).as_bool() {
                let rc = mi.rcMonitor;
                (rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top)
            } else {
                (
                    0,
                    0,
                    GetSystemMetrics(SM_CXSCREEN),
                    GetSystemMetrics(SM_CYSCREEN),
                )
            };
            let _ = SetWindowPos(
                hwnd,
                HWND_TOP,
                mx + (mw - 1280) / 2,
                my + (mh - 800) / 2,
                1280,
                800,
                SWP_FRAMECHANGED | SWP_SHOWWINDOW,
            );
        }
        Ok(())
    }
}

/// Invalidate the whole overlay window tree so DWM drops any stale surface
/// regions (white flashes) left behind by style toggles and resolution
/// switches. The frontend's own repaint hammer covers the web content.
fn redraw_all(hwnd: HWND) {
    unsafe {
        // Null region handle by value: Option<HRGN> does not implement
        // Param<HRGN> under the mixed windows-core versions in this graph.
        let _ = RedrawWindow(
            hwnd,
            None,
            HRGN(std::ptr::null_mut()),
            RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN,
        );
    }
}

#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: HWND,
        dw_attribute: u32,
        pv_attribute: *const std::ffi::c_void,
        cb_attribute: u32,
    ) -> windows::core::HRESULT;
}

pub fn strip_all_dwm_borders(hwnd: HWND) {
    unsafe {
        // 1. Prevent Windows 11 rounded corners from drawing white pixels in corners
        let do_not_round: u32 = 1; // DWMWCP_DONOTROUND
        let _ = DwmSetWindowAttribute(
            hwnd,
            33, // DWMWA_WINDOW_CORNER_PREFERENCE
            &do_not_round as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );

        // 2. NOTE: DWMWA_NCRENDERING_POLICY = DWMNCRP_DISABLED is intentionally
        // NOT set here. Per MS docs it is a documented reset trigger for the
        // blur-behind compositing tao establishes at window creation — setting
        // it makes DWM composite the transparent overlay opaque (white bar).
        // The border/caption color attributes below already suppress all chrome.

        // 3. Strictly prohibit DWM from drawing any window border or frame
        let color_none: u32 = 0xFFFFFFFE; // DWMWA_COLOR_NONE
        let _ = DwmSetWindowAttribute(
            hwnd,
            34, // DWMWA_BORDER_COLOR
            &color_none as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );

        // 4. Force caption area color to none if any non-client calculation leaks
        let _ = DwmSetWindowAttribute(
            hwnd,
            35, // DWMWA_CAPTION_COLOR
            &color_none as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

/// Re-enable DWM blur-behind compositing — the transparency tao establishes
/// at window creation for `transparent: true` windows. Style/pos changes and
/// the resulting WM_NCCALCSIZE can make DWM drop it, leaving the overlay
/// composited opaque (the white bar). Harmless if already enabled.
pub fn restore_blur_behind(_hwnd: HWND) {
    // No-op: modern Windows 10/11 DirectComposition transparent webview
    // handles alpha blending natively. DwmEnableBlurBehindWindow is a legacy
    // API that causes visual artifacts and flickering on layered windows.
}

fn overlay_monitor_file() -> std::path::PathBuf {
    std::env::var("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from(r"C:\Users\Administrator\AppData\Local"))
        .join("Recon")
        .join("overlay_monitor.txt")
}

/// Overlay monitor choice: "auto" (default — follow the game window) or a
/// `\\.\DISPLAYn` device name pinned by the user in Settings.
pub fn get_overlay_monitor_setting() -> String {
    std::fs::read_to_string(overlay_monitor_file())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "auto".to_string())
}

pub fn set_overlay_monitor_setting(name: &str) -> Result<String, String> {
    let clean = name.trim();
    if !clean.eq_ignore_ascii_case("auto") {
        let known = crate::display::get_all_monitors();
        if !known.iter().any(|m| m.device_name == clean) {
            return Err(format!("Unknown monitor '{}'", clean));
        }
    }
    let file = overlay_monitor_file();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create settings dir: {}", e))?;
    }
    std::fs::write(&file, clean).map_err(|e| format!("Cannot save overlay monitor: {}", e))?;
    Ok(clean.to_string())
}

/// Pinned monitor rect, if the user picked one and it is still attached.
pub fn overlay_monitor_rect() -> Option<(i32, i32, i32, i32)> {
    let want = get_overlay_monitor_setting();
    if want.eq_ignore_ascii_case("auto") {
        return None;
    }
    crate::display::get_all_monitors()
        .into_iter()
        .find_map(|m| {
            if m.device_name == want && m.is_attached && !m.is_device_disabled {
                Some((m.position_x, m.position_y, m.width as i32, m.height as i32))
            } else {
                None
            }
        })
}

/// Single source of truth for where the overlay belongs: pinned monitor >
/// game window > nearest monitor.
pub fn overlay_target_rect(hwnd: HWND) -> (i32, i32, i32, i32) {
    if let Some(r) = overlay_monitor_rect() {
        return r;
    }
    get_valorant_or_screen_rect(hwnd)
}

pub fn get_valorant_or_screen_rect(hwnd: HWND) -> (i32, i32, i32, i32) {
    unsafe {
        if let Some(val) = find_valorant_game_window() {
            let val_hwnd = HWND(val.hwnd as *mut std::ffi::c_void);
            let mut rect = RECT::default();
            if GetWindowRect(val_hwnd, &mut rect).is_ok() {
                let w = rect.right - rect.left;
                let h = rect.bottom - rect.top;
                if w > 100 && h > 100 {
                    return (rect.left, rect.top, w, h);
                }
            }
        }

        let h_mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(h_mon, &mut mi).as_bool() {
            let rc = mi.rcMonitor;
            (rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top)
        } else {
            let cx = GetSystemMetrics(SM_CXSCREEN);
            let cy = GetSystemMetrics(SM_CYSCREEN);
            (0, 0, cx, cy)
        }
    }
}

pub fn align_overlay_to_valorant(hwnd_val: isize) -> Result<(), String> {
    unsafe {
        let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
        if !IsWindow(hwnd).as_bool() {
            return Err("Overlay window handle is invalid.".to_string());
        }

        // Pinned monitor wins; otherwise follow the game window (or nearest
        // screen via overlay_target_rect's fallback).
        let (tx, ty, tw, th) = overlay_target_rect(hwnd);
        if tw > 100 && th > 100 {
            let mut cur_rect = RECT::default();
            if GetWindowRect(hwnd, &mut cur_rect).is_ok() {
                if cur_rect.left != tx
                    || cur_rect.top != ty
                    || (cur_rect.right - cur_rect.left) != tw
                    || (cur_rect.bottom - cur_rect.top) != th
                {
                    // ponytail: no SWP_SHOWWINDOW — positioning must never
                    // undo a hide(); callers that mean "show" call
                    // window.show() themselves.
                    let _ = SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        tx,
                        ty,
                        tw,
                        th,
                        SWP_NOACTIVATE | SWP_NOZORDER,
                    );
                }
            }
        }
        Ok(())
    }
}

/// OS-level Tab key state for the in-match scoreboard peek.
/// Reads the physical key, not the focused window — the click-through overlay
/// never receives keyboard focus, so JS key listeners can't fire in-game.
pub fn is_tab_down() -> bool {
    unsafe { (GetAsyncKeyState(0x09) as u16 & 0x8000) != 0 }
}

unsafe extern "system" fn overlay_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _u_id_subclass: usize,
    _dw_ref_data: usize,
) -> LRESULT {
    match msg {
        // 1. WM_NCCALCSIZE (0x0083):
        // Returning 0 when wParam is TRUE indicates that the client area covers the ENTIRE window.
        // Windows sets titlebar height, non-client borders, and frame margins to 0 pixels.
        // This eliminates the ~30px ghost titlebar completely!
        0x0083 => {
            if wparam.0 != 0 {
                return LRESULT(0);
            }
        }
        // 2. WM_NCHITTEST (0x0084):
        // When not actively editing, return HTTRANSPARENT (-1).
        // Tells Windows mouse hit-testing to ignore this window completely and dispatch
        // all cursor clicks/events to the window beneath it (Valorant)!
        0x0084 => {
            if !crate::OVERLAY_EDIT_MODE.load(std::sync::atomic::Ordering::Relaxed) {
                return LRESULT(-1); // HTTRANSPARENT
            }
        }
        // 3. WM_NCPAINT (0x0085):
        // Return 0 so DWM never attempts to render non-client frame/borders.
        0x0085 => return LRESULT(0),
        // 4. WM_NCACTIVATE (0x0086):
        // Return 1 so Windows never repaints the titlebar on focus change.
        0x0086 => return LRESULT(1),
        // 5. WM_ERASEBKGND (0x0014):
        // Return 1 so GDI never paints a white background before DirectX composites.
        0x0014 => return LRESULT(1),
        _ => {}
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

pub fn install_overlay_subclass(top_hwnd: HWND) {
    unsafe {
        let _ = SetWindowSubclass(top_hwnd, Some(overlay_subclass_proc), 0x7001, 0);
    }
}

pub fn make_child_windows_clickthrough(_top_hwnd: HWND, _clickthrough: bool) {
    // No-op: do NOT mutate child HWND extended styles.
    // Calling SetWindowLongPtrW/SetWindowPos on WebView2's Intermediate D3D Window
    // breaks DirectComposition swapchain presentation to Windows DWM!
}

/// Styles + positions the overlay WITHOUT changing visibility.
/// Callers: `show_overlay` (already called window.show()), the
/// `set_overlay_windowed windowed=false` path (deliberately NO show — the
/// daemon owns hidden-vs-shown when there is no explicit user show intent),
/// and never the auto-overlay daemon directly. Anyone that means "show"
/// calls `window.show()` itself; this fn only preserves whatever state is
/// current, so it can never undo a hide().
pub fn setup_overlay_window(hwnd_val: isize, clickthrough: bool) -> Result<(), String> {
    unsafe {
        let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
        if !IsWindow(hwnd).as_bool() {
            return Err("Overlay window handle is invalid.".to_string());
        }

        // 1. Strip ALL standard window decorations, frames, and captions so zero title bar renders.
        // WS_VISIBLE is deliberately left untouched here (neither forced
        // nor cleared): forcing it re-showed a hidden overlay on every
        // styling pass, and clearing it would undo a show_overlay. Only
        // window.show()/hide() own visibility.
        let current_style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        let new_style = ((current_style
            & !(0x00C00000 | 0x00040000 | 0x00010000 | 0x00020000 | 0x00080000 | 0x00800000))
            | 0x80000000  // WS_POPUP
            | 0x04000000) // WS_CLIPSIBLINGS
            as i32 as isize;
        SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);

        // 2. Configure extended styles
        let mut ex_style = (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32)
            | 0x00000008  // WS_EX_TOPMOST
            | 0x00000080; // WS_EX_TOOLWINDOW
        if clickthrough {
            ex_style |= 0x00080000 | 0x00000020 | 0x08000000; // WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE
        } else {
            ex_style &= !(0x00080000 | 0x00000020 | 0x08000000);
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style as i32 as isize);

        // 3. Strip all DWM borders & shadows
        strip_all_dwm_borders(hwnd);
        install_overlay_subclass(hwnd);
        make_child_windows_clickthrough(hwnd, clickthrough);

        // 4. Align strictly to Valorant window rect
        let (x, y, width, height) = overlay_target_rect(hwnd);

        // No SWP_SHOWWINDOW (see align_overlay_to_valorant): showing is
        // the caller's job (window.show()), never a styling side-effect.
        let _ = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            x,
            y,
            width,
            height,
            SWP_FRAMECHANGED | SWP_NOACTIVATE,
        );

        restore_blur_behind(hwnd);
        redraw_all(hwnd);

        Ok(())
    }
}

/// Edit-mode styles: like click-through PLUS mouse input, but WITHOUT
/// activation. Stealing the foreground deactivates Valorant, which blanks
/// its top strip to pure white until refocused. Mouse drag/clicks do not
/// need activation (only keyboard does), and the on-screen Lock button
/// covers exiting, so NOACTIVATE stays on.
pub fn set_overlay_editable(hwnd_val: isize) -> Result<(), String> {
    unsafe {
        let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
        if !IsWindow(hwnd).as_bool() {
            return Err("Overlay window handle is invalid.".to_string());
        }

        let current_style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        let new_style = ((current_style
            & !(0x00C00000 | 0x00040000 | 0x00010000 | 0x00020000 | 0x00080000 | 0x00800000))
            | 0x80000000  // WS_POPUP
            | 0x10000000  // WS_VISIBLE
            | 0x04000000) // WS_CLIPSIBLINGS
            as i32 as isize;
        SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);

        // In Edit Mode: preserve Tao DirectComposition surface, allow full user interaction
        let mut ex_style = (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32)
            | 0x00000008  // WS_EX_TOPMOST
            | 0x00000080; // WS_EX_TOOLWINDOW
        ex_style &= !0x00080000; // DO NOT set WS_EX_LAYERED (breaks DirectComposition)
        ex_style &= !(0x00000020 | 0x08000000);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style as i32 as isize);

        strip_all_dwm_borders(hwnd);
        install_overlay_subclass(hwnd);
        make_child_windows_clickthrough(hwnd, false);

        let (x, y, width, height) = overlay_target_rect(hwnd);

        // Deliberate show: entering edit mode is an explicit user intent
        // to see and interact with the overlay.
        let _ = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            x,
            y,
            width,
            height,
            SWP_FRAMECHANGED | SWP_SHOWWINDOW,
        );

        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);

        restore_blur_behind(hwnd);
        redraw_all(hwnd);

        Ok(())
    }
}

/// True when the visible overlay lost its click-through flag — i.e. something
/// re-applied default styles after our setup, leaving an opaque layer that
/// eats game input. The daemon heals exactly this case, nothing else.
pub fn overlay_clickthrough_missing(hwnd_val: isize) -> bool {
    unsafe {
        let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
        if !IsWindow(hwnd).as_bool() {
            return false;
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        (ex & 0x00000020 == 0) || (ex & 0x00080000 == 0) // WS_EX_TRANSPARENT or WS_EX_LAYERED
    }
}

/// Click-through style toggle. Visibility-preserving by design: leaves
/// WS_VISIBLE alone and never passes SWP_SHOWWINDOW, so daemon-adjacent
/// calls (boot init, edit-mode exit, daemon self-heal) can never undo a
/// hide(). Explicit shows own themselves: `show_overlay` (window.show()),
/// edit-mode entry (`set_overlay_editable`, which keeps its own show), and
/// the `set_overlay_windowed windowed=true` debug path (window.show()).
pub fn toggle_overlay_clickthrough(hwnd_val: isize, clickthrough: bool) -> Result<(), String> {
    unsafe {
        let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
        if !IsWindow(hwnd).as_bool() {
            return Err("Overlay window handle is invalid.".to_string());
        }

        // Always strip caption and force WS_POPUP with 64-bit sign extension.
        // WS_VISIBLE untouched: show()/hide() own visibility.
        let current_style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        let new_style = ((current_style
            & !(0x00C00000 | 0x00040000 | 0x00010000 | 0x00020000 | 0x00080000 | 0x00800000))
            | 0x80000000  // WS_POPUP
            | 0x04000000) // WS_CLIPSIBLINGS
            as i32 as isize;
        SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);

        let mut ex_style = (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32)
            | 0x00000008  // WS_EX_TOPMOST
            | 0x00000080; // WS_EX_TOOLWINDOW
        if clickthrough {
            ex_style |= 0x00080000 | 0x00000020 | 0x08000000; // WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE
        } else {
            ex_style &= !(0x00080000 | 0x00000020 | 0x08000000);
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style as i32 as isize);

        // Strip DWM borders
        strip_all_dwm_borders(hwnd);
        install_overlay_subclass(hwnd);
        make_child_windows_clickthrough(hwnd, clickthrough);

        // Synchronize position to Valorant if running. No SWP_SHOWWINDOW:
        // a hidden overlay must stay hidden through style re-asserts.
        let (x, y, width, height) = overlay_target_rect(hwnd);

        let _ = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            x,
            y,
            width,
            height,
            SWP_FRAMECHANGED | SWP_NOACTIVATE,
        );

        restore_blur_behind(hwnd);
        redraw_all(hwnd);

        Ok(())
    }
}
