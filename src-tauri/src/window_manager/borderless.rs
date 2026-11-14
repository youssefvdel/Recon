//! Reshaping the *game* window: borderless fullscreen and back.
//!
//! Not the HUD — the overlay's own styles live in `overlay_window.rs`.

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
        // raises AND activates the game, so every auto-apply buried Outpeek
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
