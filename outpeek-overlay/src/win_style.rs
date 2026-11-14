//! Win32 shaping for the Slint window: the `overlay_window.rs` recipe —
//! WS_POPUP/TOPMOST/TOOLWINDOW + TRANSPARENT|NOACTIVATE, NO `WS_EX_LAYERED`,
//! HTTRANSPARENT subclass, DWM strip. Style writes live here, never in the
//! `.slint` (which only declares no-frame/always-on-top/transparent).

use windows::Win32::Foundation::{BOOL, FALSE, HWND, LPARAM, LRESULT, RECT, TRUE, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, IsWindow, IsWindowVisible, SetForegroundWindow,
    SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GWL_STYLE, HWND_TOPMOST, SWP_FRAMECHANGED,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
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

#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: HWND,
        dw_attribute: u32,
        pv_attribute: *const std::ffi::c_void,
        cb_attribute: u32,
    ) -> windows::core::HRESULT;
}

// A layered window must also declare how its pixels are composited; LWA_ALPHA
// at 255 means "use the window's own alpha unchanged", which is what a
// transparent swapchain needs. Without it Windows can treat the layered
// surface as fully transparent.
#[link(name = "user32")]
extern "system" {
    fn SetLayeredWindowAttributes(
        hwnd: HWND,
        color_key: COLORREF,
        b_alpha: u8,
        dw_flags: LAYERED_WINDOW_ATTRIBUTES_FLAGS,
    ) -> BOOL;
}

#[repr(C)]
pub struct COLORREF(pub u32);

#[repr(C)]
pub struct LAYERED_WINDOW_ATTRIBUTES_FLAGS(pub u32);

pub const LWA_ALPHA: LAYERED_WINDOW_ATTRIBUTES_FLAGS = LAYERED_WINDOW_ATTRIBUTES_FLAGS(0x2);

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        0x0083 => {
            // WM_NCCALCSIZE: client covers the whole window, zero frame.
            if wparam.0 != 0 {
                return LRESULT(0);
            }
        }
        0x0084 => {
            // WM_NCHITTEST: HTTRANSPARENT while not editing (flag mirrors the
            // main app's OVERLAY_EDIT_MODE, pushed over stdin as `edit`).
            if super::EDIT_MODE.load(std::sync::atomic::Ordering::Relaxed) == 0 {
                return LRESULT(-1);
            }
        }
        0x0085 => return LRESULT(0), // WM_NCPAINT
        0x0086 => return LRESULT(1), // WM_NCACTIVATE
        0x0014 => return LRESULT(1), // WM_ERASEBKGND: no GDI white flash
        _ => {}
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

fn hwnd(val: isize) -> HWND {
    HWND(val as *mut std::ffi::c_void)
}

/// VALORANT's window signature, mirrored from the main app's
/// `window_manager::enumeration::is_valorant_game_window` so both skins agree.
/// Real game client: title "VALORANT*" + UnrealWindow class; companion apps,
/// trackers, launchers and browsers excluded by name.
fn is_valorant_window(title: &str, class_name: &str) -> bool {
    let lower = title.trim().to_lowercase();
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
    if class_name == "UnrealWindow"
        || class_name == "VALORANTUnrealWindow"
        || class_name.contains("UnrealWindow")
    {
        return lower == "valorant" || lower.starts_with("valorant");
    }
    lower == "valorant" || lower.starts_with("valorant")
}

unsafe extern "system" fn enum_game_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<(isize, String, String)>);
    let len = GetWindowTextLengthW(hwnd);
    if len > 0 && len < 512 {
        let mut buf = vec![0u16; (len + 1) as usize];
        let copied = GetWindowTextW(hwnd, &mut buf);
        if copied > 0 {
            let title = String::from_utf16_lossy(&buf[..copied as usize]);
            let mut cls = [0u16; 128];
            let clen = GetClassNameW(hwnd, &mut cls);
            let class = if clen > 0 {
                String::from_utf16_lossy(&cls[..clen as usize])
            } else {
                String::new()
            };
            out.push((hwnd.0 as isize, title, class));
        }
    }
    BOOL(1)
}

/// The visible VALORANT game window, if one exists. Same predicate and
/// visibility rule `discover_game_rect` uses; exposed for callers that need
/// the HWND itself (foreground gating, probes).
pub fn game_window() -> Option<isize> {
    unsafe {
        let mut wins: Vec<(isize, String, String)> = Vec::new();
        let _ = EnumWindows(Some(enum_game_cb), LPARAM(&mut wins as *mut _ as isize));
        for (hwnd_val, title, class) in &wins {
            if !is_valorant_window(title, class) {
                continue;
            }
            let hwnd = HWND(*hwnd_val as *mut std::ffi::c_void);
            if !IsWindowVisible(hwnd).as_bool() {
                continue;
            }
            let mut r = RECT::default();
            if GetWindowRect(hwnd, &mut r).is_ok() {
                if r.right - r.left > 100 && r.bottom - r.top > 100 {
                    return Some(*hwnd_val);
                }
            }
        }
        None
    }
}

/// True when the focused window is the live VALORANT client.
///
/// This is the only fact the HUD visibility gate consumes: an overlay layer
/// over the desktop or the tracker is a bug, not a feature. The predicate is
/// mirrored from the main app's `window_manager::enumeration` so both skins
/// agree on what "the game" is.
pub fn is_game_foreground() -> bool {
    let fg = foreground();
    if fg == 0 {
        return false;
    }
    unsafe {
        let h = hwnd(fg);
        let len = GetWindowTextLengthW(h);
        if len == 0 {
            return false;
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let copied = GetWindowTextW(h, &mut buf);
        if copied == 0 {
            return false;
        }
        let title = String::from_utf16_lossy(&buf[..copied as usize]);
        let mut cls = [0u16; 128];
        let clen = GetClassNameW(h, &mut cls);
        let class = if clen > 0 {
            String::from_utf16_lossy(&cls[..clen as usize])
        } else {
            String::new()
        };
        is_valorant_window(title.trim(), &class)
    }
}

/// Where the overlay belongs when the facts carry no rect: the live game
/// window, else the primary screen. Mirrors the main app's
/// `overlay_target_rect` (minus the pinned-monitor choice, which stays
/// main-app-side). Runs on every facts frame, so res/monitor switches are
/// followed at the daemon's cadence.
pub fn discover_game_rect() -> Option<(i32, i32, i32, i32)> {
    if let Some(val) = game_window() {
        unsafe {
            let mut r = RECT::default();
            if GetWindowRect(hwnd(val), &mut r).is_ok() {
                let (w, h) = (r.right - r.left, r.bottom - r.top);
                if w > 100 && h > 100 {
                    return Some((r.left, r.top, w, h));
                }
            }
        }
    }
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    unsafe {
        Some((
            0,
            0,
            GetSystemMetrics(SM_CXSCREEN),
            GetSystemMetrics(SM_CYSCREEN),
        ))
    }
}

pub fn valid(val: isize) -> bool {
    unsafe { IsWindow(hwnd(val)).as_bool() }
}

pub fn visible(val: isize) -> bool {
    unsafe { IsWindowVisible(hwnd(val)).as_bool() }
}

pub fn foreground() -> isize {
    unsafe { GetForegroundWindow().0 as isize }
}

/// If showing the overlay activated it (Slint shows before NOACTIVATE lands),
/// hand focus back to whoever had it. Uses AttachThreadInput so the foreground
/// lock cannot refuse the restore; best-effort otherwise.
pub fn refocus_if_stolen(ours: isize, prev: isize) {
    let now = foreground();
    eprintln!("[sidecar] refocus check ours={ours} prev={prev} fg_now={now}");
    if prev == 0 || prev == ours {
        return;
    }
    unsafe {
        use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
        use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
        let ours_h = hwnd(ours);
        if GetForegroundWindow() != ours_h || !valid(prev) {
            return;
        }
        let my_tid = GetCurrentThreadId();
        let fg_tid = GetWindowThreadProcessId(ours_h, None);
        let mut attached = false;
        if fg_tid != 0 && fg_tid != my_tid {
            attached = AttachThreadInput(my_tid, fg_tid, TRUE).as_bool();
        }
        let set_ok = SetForegroundWindow(hwnd(prev)).as_bool();
        let fg_after = foreground();
        eprintln!(
            "[sidecar] refocus my_tid={my_tid} fg_tid={fg_tid} attached={attached} set_ok={set_ok} fg_after={fg_after}"
        );
        if attached {
            let _ = AttachThreadInput(my_tid, fg_tid, FALSE);
        }
    }
}

pub fn strip_dwm(val: isize) {
    unsafe {
        let h = hwnd(val);
        let do_not_round: u32 = 1; // DWMWCP_DONOTROUND
        let _ = DwmSetWindowAttribute(
            h,
            33, // DWMWA_WINDOW_CORNER_PREFERENCE
            &do_not_round as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
        // NOTE: DWMWA_NCRENDERING_POLICY is deliberately NOT touched (same
        // reason as overlay_window.rs: it resets the blur-behind tao and
        // composites the transparent overlay opaque — the white bar).
        let color_none: u32 = 0xFFFFFFFE; // DWMWA_COLOR_NONE
        let _ = DwmSetWindowAttribute(
            h,
            34, // DWMWA_BORDER_COLOR
            &color_none as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            h,
            35, // DWMWA_CAPTION_COLOR
            &color_none as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

pub fn install_subclass(val: isize) -> bool {
    unsafe { SetWindowSubclass(hwnd(val), Some(subclass_proc), 0x7001, 0).as_bool() }
}

/// Apply the full recipe: popup, topmost, toolwindow, click-through (or raw
/// input in edit mode), then reposition. Never touches WS_VISIBLE and never
/// passes SWP_SHOWWINDOW — show/hide is Slint's job, styles never undo it.
pub fn apply(val: isize, clickthrough: bool, rect: Option<(i32, i32, i32, i32)>) {
    if !valid(val) {
        return;
    }
    unsafe {
        let h = hwnd(val);
        let cur = GetWindowLongPtrW(h, GWL_STYLE) as u32;
        let style = (
            (cur & !(0x00C00000 | 0x00040000 | 0x00010000 | 0x00020000 | 0x00080000 | 0x00800000))
            | 0x80000000 // WS_POPUP
            | 0x04000000
            // WS_CLIPSIBLINGS
        ) as i32 as isize;
        SetWindowLongPtrW(h, GWL_STYLE, style);

        let mut ex = (GetWindowLongPtrW(h, GWL_EXSTYLE) as u32) | 0x00000008 | 0x00000080; // TOPMOST | TOOLWINDOW
        if clickthrough {
            // Reference implementation: Tao's set_ignore_cursor_events (and
            // winit's set_cursor_hittest) both set TRANSPARENT **and**
            // LAYERED. HTTRANSPARENT from WM_NCHITTEST only forwards within
            // the same thread, so without LAYERED the click stays on this
            // window instead of reaching the game. Proven by reading
            // tao-0.35.3/src/platform_impl/windows/window_state.rs:285-287.
            // LWA_ALPHA 255 keeps the composited content fully opaque; the
            // alpha comes from the swapchain, not the layered attribute.
            ex |= 0x00000020 | 0x00080000 | 0x08000000; // TRANSPARENT | LAYERED | NOACTIVATE
        } else {
            ex &= !(0x00000020 | 0x00080000 | 0x08000000);
        }
        SetWindowLongPtrW(h, GWL_EXSTYLE, ex as i32 as isize);
        if clickthrough {
            let _ = SetLayeredWindowAttributes(h, COLORREF(0), 255, LWA_ALPHA);
        }

        strip_dwm(val);
        if !install_subclass(val) {
            eprintln!("[sidecar] WARN: HTTRANSPARENT subclass install FAILED on {val:#x}");
        }
        if let Some((x, y, w, hgt)) = rect {
            let _ = SetWindowPos(
                h,
                HWND_TOPMOST,
                x,
                y,
                w,
                hgt,
                SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER,
            );
        } else {
            let _ = SetWindowPos(
                h,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOSIZE | SWP_NOMOVE,
            );
        }
        // Read back what actually landed: catches a silent SetWindowLongPtr
        // failure or a backend re-assert between our write and now.
        let style_after = GetWindowLongPtrW(h, GWL_STYLE) as u32;
        let ex_after = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        let want_transparent = clickthrough;
        let has_transparent = ex_after & 0x00000020 != 0;
        // LAYERED is part of the click-through recipe (see apply), so it is
        // only a defect when it survives into edit mode.
        let has_layered = !clickthrough && ex_after & 0x00080000 != 0;
        let has_frame = style_after
            & (0x00C00000 | 0x00040000 | 0x00010000 | 0x00020000 | 0x00080000 | 0x00800000)
            != 0;
        if has_transparent != want_transparent || has_layered || has_frame {
            eprintln!(
                "[sidecar] WARN: style readback mismatch want_ct={want_transparent} ex={ex_after:#x} style={style_after:#x}"
            );
        }
    }
}

/// The recipe applied at creation, while the window is still hidden.
///
/// Same style write as [`apply`] minus every geometry flag: the first show
/// sizes and places the window. Nothing here can map the window — no
/// `SWP_SHOWWINDOW` is ever passed — so a HUD that never gets presented stays
/// invisible, and one that is presented never flashes winit's default
/// decorated/topmost frame on the way in.
///
/// Returns whether the HWND existed and the pass ran, and logs the readback
/// once: this runs at startup, so the log is the only place the applied style
/// can be checked without a visible window.
pub fn style_hidden(val: isize) -> bool {
    if !valid(val) {
        return false;
    }
    apply(val, true, None);
    eprintln!("[outpeek-overlay] style_hidden: {}", probe_json(val));
    true
}

/// Style/readback snapshot for `--probe` and the soak predicate. Mirrors the
/// main app's `overlay_clickthrough_missing` predicate: click-through is
/// WS_EX_TRANSPARENT, never WS_EX_LAYERED.
pub fn probe_json(val: isize) -> serde_json::Value {
    if !valid(val) {
        return serde_json::json!({"ok": false, "reason": "bad-hwnd"});
    }
    unsafe {
        let h = hwnd(val);
        let style = GetWindowLongPtrW(h, GWL_STYLE) as u32;
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        let mut rect = windows::Win32::Foundation::RECT::default();
        let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(h, &mut rect);
        serde_json::json!({
            "ok": true,
            "hwnd": val,
            "visible": visible(val),
            "style": format!("{style:#010x}"),
            "ex_style": format!("{ex:#010x}"),
            "is_popup": style & 0x80000000 != 0,
            "topmost": ex & 0x00000008 != 0,
            "toolwindow": ex & 0x00000080 != 0,
            "clickthrough": ex & 0x00000020 != 0,
            "noactivate": ex & 0x08000000 != 0,
            "layered": ex & 0x00080000 != 0,
            "clickthrough_missing": ex & 0x00000020 == 0,
            "rect": {"x": rect.left, "y": rect.top,
                     "w": rect.right - rect.left, "h": rect.bottom - rect.top},
            "backend": std::env::var("SLINT_BACKEND").unwrap_or_default(),
        })
    }
}

/// Exit when the parent (main app) dies: every spawn path passes
/// `--parent-pid`, so an orphaned fullscreen topmost window is impossible even
/// if the kill-on-exit hook is ever skipped.
pub fn watch_parent(pid: u32) {
    std::thread::spawn(move || {
        use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            unsafe {
                let h: HANDLE = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                    Ok(h) => h,
                    Err(_) => std::process::exit(0),
                };
                if h.is_invalid() {
                    std::process::exit(0);
                }
                let rc = windows::Win32::System::Threading::WaitForSingleObject(h, 0);
                let _ = CloseHandle(h);
                if rc == WAIT_OBJECT_0 {
                    std::process::exit(0);
                }
            }
        }
    });
}
