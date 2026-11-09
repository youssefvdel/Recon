#![allow(dead_code)]
//! (moved verbatim from `display.rs`; split only, behaviour unchanged.)

use super::shortcut::{get_current_modifiers, ShortcutBinding};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

/// Thread-safe controller for dynamic global hotkey updates
#[derive(Clone)]
pub struct HotkeyController {
    pub hotkey_code: Arc<AtomicU32>,
    pub running: Arc<AtomicBool>,
}

impl HotkeyController {
    pub fn set_shortcut(&self, binding: ShortcutBinding) {
        self.hotkey_code.store(binding.to_code(), Ordering::Relaxed);
    }
}

pub fn start_hotkey_listener(
    initial_shortcut: ShortcutBinding,
) -> (HotkeyController, Receiver<()>) {
    let (tx, rx) = channel();
    let hotkey_code = Arc::new(AtomicU32::new(initial_shortcut.to_code()));
    let running = Arc::new(AtomicBool::new(true));

    let code_clone = Arc::clone(&hotkey_code);
    let running_clone = Arc::clone(&running);

    thread::spawn(move || {
        let mut was_pressed = false;
        while running_clone.load(Ordering::Relaxed) {
            let code = code_clone.load(Ordering::Relaxed);
            let binding = ShortcutBinding::from_code(code);

            let is_down = if binding.vk == 0 {
                false
            } else {
                let key_down =
                    unsafe { (GetAsyncKeyState(binding.vk as i32) as u16 & 0x8000) != 0 };
                if !key_down {
                    false
                } else {
                    let (ctrl_down, shift_down, alt_down, win_down) = get_current_modifiers();
                    let is_letter_or_digit = (binding.vk >= 0x30 && binding.vk <= 0x39)
                        || (binding.vk >= 0x41 && binding.vk <= 0x5A)
                        || binding.vk == 0x20;

                    if is_letter_or_digit {
                        ctrl_down == binding.ctrl
                            && shift_down == binding.shift
                            && alt_down == binding.alt
                            && win_down == binding.win
                    } else {
                        let ctrl_match = !binding.ctrl || ctrl_down;
                        let shift_match = !binding.shift || shift_down;
                        let alt_match = !binding.alt || alt_down;
                        let win_match = !binding.win || win_down;
                        ctrl_match && shift_match && alt_match && win_match
                    }
                }
            };

            if is_down && !was_pressed {
                let _ = tx.send(());
            }
            was_pressed = is_down;

            thread::sleep(Duration::from_millis(30));
        }
    });

    (
        HotkeyController {
            hotkey_code,
            running,
        },
        rx,
    )
}
