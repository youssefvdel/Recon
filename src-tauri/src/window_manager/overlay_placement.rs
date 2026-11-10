//! Where the HUD is put: pinned monitor, game rect, fallback screen, alignment.

//! The HUD window itself: styles, subclass, placement, edit mode, click-through.
//!
//! Style and placement stay in one file on purpose: `setup_overlay_window`,
//! `set_overlay_editable` and `toggle_overlay_clickthrough` each set styles AND
//! reposition in the same pass, so splitting them by "style vs policy" would cut
//! through single functions.

use super::enumeration::find_valorant_game_window;

use windows::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, RedrawWindow, HRGN, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE,
};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetSystemMetrics, GetWindowLongPtrW,
    GetWindowRect, GetWindowTextLengthW, GetWindowTextW, IsWindow, IsWindowVisible,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, GWL_STYLE,
    HWND_TOP, HWND_TOPMOST, SM_CXSCREEN, SM_CYSCREEN, SWP_FRAMECHANGED, SWP_NOACTIVATE,
    SWP_NOZORDER, SWP_SHOWWINDOW, SW_SHOW, WINDOW_STYLE, WS_BORDER, WS_CAPTION, WS_EX_TOOLWINDOW,
    WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_OVERLAPPEDWINDOW, WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
};

pub(crate) fn overlay_monitor_file() -> std::path::PathBuf {
    std::env::var("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from(r"C:\Users\Administrator\AppData\Local"))
        .join("Recon")
        .join("overlay_monitor.txt")
}

/// Overlay monitor choice: "auto" (default — follow the game window) or a
/// `\\.\DISPLAYn` device name pinned by the user in Settings.
pub fn get_overlay_monitor_setting() -> String {
    crate::settings::load_overlay_monitor()
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
    crate::settings::save_overlay_monitor(clean);
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
