//! The HUD window itself: styles, the message subclass, click-through, edit styles.
//!
//! Two of these functions mix style with placement in one pass —
//! `setup_overlay_window`, `set_overlay_editable` and `toggle_overlay_clickthrough`
//! set flags AND reposition by calling `overlay_placement::overlay_target_rect`.
//! They stay whole for that reason; the split is by responsibility, not by line.

use super::overlay_edit::overlay_edit_touch;
use super::overlay_placement::overlay_target_rect;

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
        // 6. Mouse activity while edit mode is on: the fail-safe heartbeat.
        // Not swallowed — falls through to DefSubclassProc like any normal
        // message; we only stamp that a human is still there.
        0x0200 | 0x0201 | 0x0202 | 0x020A => {
            if crate::OVERLAY_EDIT_MODE.load(std::sync::atomic::Ordering::Relaxed) {
                overlay_edit_touch();
            }
        }
        _ => {}
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

/// Invalidate the whole overlay window tree so DWM drops any stale surface
/// regions (white flashes) left behind by style toggles and resolution
/// switches. The frontend's own repaint hammer covers the web content.
pub fn install_overlay_subclass(top_hwnd: HWND) {
    unsafe {
        let _ = SetWindowSubclass(top_hwnd, Some(overlay_subclass_proc), 0x7001, 0);
    }
}

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

            // Eat clicks, activatable, normal z-order, NOT toolwindow.
            // No WS_EX_LAYERED: banned (AGENTS.md) — it breaks the
            // DirectComposition surface even in the debug window.
            let mut ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            ex_style &= !(0x00080000 | 0x00000020 | 0x08000000 | 0x00000008 | 0x00000080);
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
        // Click-through is already guaranteed twice: WS_EX_TRANSPARENT here and
        // the WM_NCHITTEST -> HTTRANSPARENT subclass below. WS_EX_LAYERED is
        // the banned legacy per-pixel-alpha flag (AGENTS.md): it forces DWM
        // composition over a borderless game and breaks DirectComposition.
        // Audit overlay#2: never set it on this path.
        if clickthrough {
            ex_style |= 0x00000020 | 0x08000000; // WS_EX_TRANSPARENT | WS_EX_NOACTIVATE
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
/// need activation (only keyboard does), and the on-screen Lock button and the
/// global Ctrl+Shift+H fail-safe cover exiting, so NOACTIVATE stays on and
/// this function NEVER calls SetForegroundWindow (audit overlay#5).
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
        // No SetForegroundWindow here: audit overlay#5. The overlay keeps
        // WS_EX_NOACTIVATE; the game never loses the foreground just because
        // the user opened HUD edit, and the chord/Lock button do not need it.

        restore_blur_behind(hwnd);
        redraw_all(hwnd);

        Ok(())
    }
}

/// True when the visible overlay lost its click-through flag — i.e. something
/// re-applied default styles after our setup, leaving an opaque layer that
/// eats game input. The daemon heals exactly this case, nothing else.
///
/// Audit overlay#2: WS_EX_LAYERED is no longer part of click-through, so the
/// predicate must only look for WS_EX_TRANSPARENT. Keeping the old LAYERED half
/// would report "missing" forever and make the daemon re-assert styles every
/// tick.
pub fn overlay_clickthrough_missing(hwnd_val: isize) -> bool {
    unsafe {
        let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
        if !IsWindow(hwnd).as_bool() {
            return false;
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        ex & 0x00000020 == 0 // WS_EX_TRANSPARENT
    }
}

/// Pure bit test behind [`overlay_frame_dirty`]: true when any frame/chrome
/// bit survived (or WS_POPUP went missing). Split out so the rule is
/// unit-testable without an HWND.
pub(crate) fn frame_bits_dirty(style: u32) -> bool {
    style & (0x00C00000 | 0x00040000 | 0x00010000 | 0x00020000 | 0x00080000 | 0x00800000) != 0
        || style & 0x80000000 == 0 // WS_POPUP
}

/// True when the overlay regained any frame/chrome style bits — i.e. something
/// (Tauri/winit re-asserting decorations on show/resize/focus, a debug
/// windowed round-trip) re-added a caption, thick frame, border or sysmenu
/// after our setup. That paints a top bar over the game even while
/// WS_EX_TRANSPARENT is intact, which is exactly the case the click-through
/// predicate above cannot see: it only watches one ex-style bit. The daemon
/// heals this with the same toggle path (which also re-asserts the DWM
/// no-chrome attributes), nothing else.
pub fn overlay_frame_dirty(hwnd_val: isize) -> bool {
    unsafe {
        let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
        if !IsWindow(hwnd).as_bool() {
            return false;
        }
        frame_bits_dirty(GetWindowLongPtrW(hwnd, GWL_STYLE) as u32)
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
        // Audit overlay#2: WS_EX_LAYERED is deliberately NOT part of
        // click-through. TRANSPARENT + the HTTRANSPARENT subclass carry it, and
        // the layered flag would force DWM composition over the game.
        if clickthrough {
            ex_style |= 0x00000020 | 0x08000000; // WS_EX_TRANSPARENT | WS_EX_NOACTIVATE
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

/// OS-level Tab key state for the in-match scoreboard peek.
/// Reads the physical key, not the focused window — the click-through overlay
/// never receives keyboard focus, so JS key listeners can't fire in-game.
pub fn is_tab_down() -> bool {
    unsafe { (GetAsyncKeyState(0x09) as u16 & 0x8000) != 0 }
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

#[cfg(test)]
mod frame_predicate_tests {
    use super::frame_bits_dirty;

    /// The recipe's own clean state: POPUP + CLIPSIBLINGS, nothing else.
    const CLEAN: u32 = 0x80000000 | 0x04000000;

    #[test]
    fn clean_recipe_is_not_dirty() {
        assert!(!frame_bits_dirty(CLEAN));
    }

    #[test]
    fn each_frame_bit_counts_as_dirty() {
        // WS_CAPTION | WS_THICKFRAME | WS_MAXIMIZEBOX | WS_MINIMIZEBOX |
        // WS_SYSMENU | WS_BORDER, one at a time over the clean base.
        for bit in [0x00C00000u32, 0x00040000, 0x00010000, 0x00020000, 0x00080000, 0x00800000] {
            assert!(frame_bits_dirty(CLEAN | bit), "bit {bit:#x} must be dirty");
        }
    }

    #[test]
    fn missing_popup_counts_as_dirty() {
        assert!(frame_bits_dirty(0x04000000));
    }
}
