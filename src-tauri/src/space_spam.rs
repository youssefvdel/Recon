use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Once;

use tauri::Emitter;
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_F3, VK_SPACE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
    KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN,
    WM_SYSKEYUP,
};

static ENABLED: AtomicBool = AtomicBool::new(false);
static SPACE_HELD: AtomicBool = AtomicBool::new(false);
static STARTED: Once = Once::new();
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

// Re-press cadence. 1 ms (~1000 taps/s) floods the game's input queue and costs frame time;
// this is the tuning knob if a game needs it faster or slower.
const REPRESS_INTERVAL_MS: u64 = 50; // ~20 taps/s
const IDLE_INTERVAL_MS: u64 = 15;

const TOGGLE_HOTKEY_VK: u32 = VK_F3.0 as u32;

pub fn start(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
    STARTED.call_once(|| {
        std::thread::spawn(worker);
    });
}

#[tauri::command]
pub fn set_space_spam(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    start(&app);
    ENABLED.store(enabled, Ordering::Relaxed);
    Ok(())
}

fn worker() {
    unsafe {
        // The hook ignores injected events, so our own SPACE taps never look like the
        // physical key being released. Polling GetAsyncKeyState cannot see that.
        let _hook =
            match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), HINSTANCE::default(), 0) {
                Ok(h) => h,
                Err(e) => {
                    // ponytail: no channel/lock back to the caller; the toggle just silently
                    // fails to take effect. Upgrade path: report via a channel if the UI must show it.
                    eprintln!("space_spam: SetWindowsHookExW failed: {e}");
                    return;
                }
            };

        // Hook/pump thread: this thread never sleeps. A low-level hook is synchronous in the
        // system input path, so blocking in GetMessageW keeps keystroke latency at zero.
        // The injector thread (below) is the one that polls and sleeps.
        std::thread::spawn(injector);

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn injector() {
    loop {
        if ENABLED.load(Ordering::Relaxed) && SPACE_HELD.load(Ordering::Relaxed) {
            unsafe { send_space_tap() };
            std::thread::sleep(std::time::Duration::from_millis(REPRESS_INTERVAL_MS));
        } else {
            std::thread::sleep(std::time::Duration::from_millis(IDLE_INTERVAL_MS));
        }
    }
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let kbd = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let injected = (kbd.flags.0 & LLKHF_INJECTED.0) != 0;
        if let Some(down) = is_physical_space_event(wparam.0, kbd.vkCode, injected) {
            SPACE_HELD.store(down, Ordering::Relaxed);
        }
        // Toggle on key-up: key-down auto-repeats while F3 is held, so a down toggle
        // machine-guns. F3 is not swallowed — CallNextHookEx below still passes it on; if
        // F3 ever collides with a game bind, swallowing it (return LRESULT(1)) is the change.
        if is_hotkey_release(wparam.0, kbd.vkCode, injected) {
            let next = !ENABLED.load(Ordering::Relaxed);
            ENABLED.store(next, Ordering::Relaxed);
            if let Some(app) = APP.get() {
                let _ = app.emit("recon:space-spam", next);
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

fn is_hotkey_release(wparam: usize, vk: u32, injected: bool) -> bool {
    !injected && vk == TOGGLE_HOTKEY_VK && matches!(wparam as u32, WM_KEYUP | WM_SYSKEYUP)
}

fn is_physical_space_event(wparam: usize, vk: u32, injected: bool) -> Option<bool> {
    if injected || vk != VK_SPACE.0 as u32 {
        return None;
    }
    match wparam as u32 {
        WM_KEYDOWN | WM_SYSKEYDOWN => Some(true),
        WM_KEYUP | WM_SYSKEYUP => Some(false),
        _ => None,
    }
}

unsafe fn send_space_tap() {
    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_SPACE,
                    ..Default::default()
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_SPACE,
                    dwFlags: KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        },
    ];
    SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_space_down() {
        assert_eq!(
            is_physical_space_event(WM_KEYDOWN as usize, VK_SPACE.0 as u32, false),
            Some(true)
        );
    }

    #[test]
    fn physical_space_up() {
        assert_eq!(
            is_physical_space_event(WM_KEYUP as usize, VK_SPACE.0 as u32, false),
            Some(false)
        );
    }

    #[test]
    fn injected_space_down_ignored() {
        assert_eq!(
            is_physical_space_event(WM_KEYDOWN as usize, VK_SPACE.0 as u32, true),
            None
        );
    }

    #[test]
    fn physical_other_key_ignored() {
        assert_eq!(
            is_physical_space_event(WM_KEYDOWN as usize, 65, false),
            None
        );
    }

    #[test]
    fn hotkey_release_detected() {
        assert!(is_hotkey_release(
            WM_KEYUP as usize,
            TOGGLE_HOTKEY_VK,
            false
        ));
    }

    #[test]
    fn hotkey_down_ignored() {
        assert!(!is_hotkey_release(
            WM_KEYDOWN as usize,
            TOGGLE_HOTKEY_VK,
            false
        ));
    }

    #[test]
    fn injected_hotkey_release_ignored() {
        assert!(!is_hotkey_release(
            WM_KEYUP as usize,
            TOGGLE_HOTKEY_VK,
            true
        ));
    }

    #[test]
    fn hotkey_predicate_ignores_space() {
        assert!(!is_hotkey_release(
            WM_KEYUP as usize,
            VK_SPACE.0 as u32,
            false
        ));
    }
}
