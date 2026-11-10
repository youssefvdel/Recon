//! Reading the desktop: which visible windows exist and which one is VALORANT.
//!
//! Pure Win32 reads. Nothing here changes a window.

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
