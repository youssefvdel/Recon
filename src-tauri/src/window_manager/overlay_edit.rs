//! Edit-mode bookkeeping: the activity clock, the idle budget and the exit chord.
//!
//! The window styling that edit mode applies lives in `overlay_window.rs`; the
//! subclass proc that stamps activity lives there too, because it is also the
//! hit-test gate. This file owns only the numbers and the probes.

//! The HUD window itself: styles, subclass, placement, edit mode, click-through.
//!
//! Style and placement stay in one file on purpose: `setup_overlay_window`,
//! `set_overlay_editable` and `toggle_overlay_clickthrough` each set styles AND
//! reposition in the same pass, so splitting them by "style vs policy" would cut
//! through single functions.

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

/// Last mouse activity delivered to the overlay while edit mode was on (epoch
/// ms; 0 = never). Written by the subclass proc, read by the overlay guard
/// thread's watchdog. A window that has seen no mouse message for the watchdog
/// budget is presumed abandoned — exactly the state that used to swallow every
/// click until the process exited (audit overlay#1).
pub static OVERLAY_EDIT_ACTIVITY_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}


/// Mark edit-mode activity. Called by the subclass on mouse messages over the
/// non-click-through overlay and on every entry into edit mode.
pub fn overlay_edit_touch() {
    OVERLAY_EDIT_ACTIVITY_MS.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
}

/// Milliseconds since the last edit-mode mouse activity.
pub fn overlay_edit_idle_ms() -> u64 {
    now_ms().saturating_sub(OVERLAY_EDIT_ACTIVITY_MS.load(std::sync::atomic::Ordering::Relaxed))
}

/// Ctrl+Shift+H — the always-available "leave edit mode" chord.
///
/// Polled rather than hooked on purpose: a low-level keyboard hook sits in the
/// system input path and taxes every keystroke, while this only reads key
/// state on the guard thread's 100 ms tick. Works regardless of focus and
/// regardless of whether the overlay webview is alive, which is the whole point
/// (audit overlay#1a).
pub fn overlay_edit_exit_chord_down() -> bool {
    unsafe {
        let ctrl = (GetAsyncKeyState(0x11) as u16 & 0x8000) != 0; // VK_CONTROL
        let shift = (GetAsyncKeyState(0x10) as u16 & 0x8000) != 0; // VK_SHIFT
        let h = (GetAsyncKeyState(0x48) as u16 & 0x8000) != 0; // 'H'
        ctrl && shift && h
    }
}
