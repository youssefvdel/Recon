#![allow(dead_code)]
//! (moved verbatim from `display.rs`; split only, behaviour unchanged.)

use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ShortcutBinding {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub win: bool,
    pub vk: u16,
}

impl ShortcutBinding {
    pub const fn new(ctrl: bool, shift: bool, alt: bool, win: bool, vk: u16) -> Self {
        Self {
            ctrl,
            shift,
            alt,
            win,
            vk,
        }
    }

    pub const fn f4() -> Self {
        Self {
            ctrl: true,
            shift: false,
            alt: false,
            win: false,
            vk: 0x73,
        }
    }

    #[allow(dead_code)]
    pub const fn f11() -> Self {
        Self {
            ctrl: false,
            shift: false,
            alt: false,
            win: false,
            vk: 0x7A,
        }
    }

    #[allow(dead_code)]
    pub fn label(&self) -> String {
        self.format_display()
    }

    pub fn format_display(&self) -> String {
        if self.vk == 0 {
            return "Unbound".to_string();
        }
        let mut parts = Vec::new();
        if self.ctrl {
            parts.push("CTRL".to_string());
        }
        if self.alt {
            parts.push("ALT".to_string());
        }
        if self.shift {
            parts.push("SHIFT".to_string());
        }
        if self.win {
            parts.push("WIN".to_string());
        }
        parts.push(vk_to_name(self.vk));
        parts.join(" + ")
    }

    pub const fn to_code(&self) -> u32 {
        (self.vk as u32)
            | ((self.ctrl as u32) << 16)
            | ((self.shift as u32) << 17)
            | ((self.alt as u32) << 18)
            | ((self.win as u32) << 19)
    }

    pub const fn from_code(code: u32) -> Self {
        Self {
            vk: (code & 0xFFFF) as u16,
            ctrl: (code & (1 << 16)) != 0,
            shift: (code & (1 << 17)) != 0,
            alt: (code & (1 << 18)) != 0,
            win: (code & (1 << 19)) != 0,
        }
    }

    pub fn serialize(&self) -> String {
        format!(
            "{}:{}:{}:{}:{}",
            self.ctrl, self.shift, self.alt, self.win, self.vk
        )
    }

    pub fn deserialize(s: &str) -> Option<Self> {
        let parts: Vec<&str> = s.trim().split(':').collect();
        if parts.len() == 5 {
            let ctrl = parts[0].parse().ok()?;
            let shift = parts[1].parse().ok()?;
            let alt = parts[2].parse().ok()?;
            let win = parts[3].parse().ok()?;
            let vk = parts[4].parse().ok()?;
            Some(Self {
                ctrl,
                shift,
                alt,
                win,
                vk,
            })
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HotkeyPreset {
    F4,
    F11,
    F10,
    F9,
    F12,
    F8,
    CtrlShiftS,
    AltF11,
    Insert,
}

impl HotkeyPreset {
    pub fn all() -> &'static [HotkeyPreset] {
        &[
            HotkeyPreset::F4,
            HotkeyPreset::F11,
            HotkeyPreset::F10,
            HotkeyPreset::F9,
            HotkeyPreset::F12,
            HotkeyPreset::F8,
            HotkeyPreset::CtrlShiftS,
            HotkeyPreset::AltF11,
            HotkeyPreset::Insert,
        ]
    }

    pub fn label(&self) -> &'static str {
        match self {
            HotkeyPreset::F4 => "F4 (Default)",
            HotkeyPreset::F11 => "F11",
            HotkeyPreset::F10 => "F10",
            HotkeyPreset::F9 => "F9",
            HotkeyPreset::F12 => "F12",
            HotkeyPreset::F8 => "F8",
            HotkeyPreset::CtrlShiftS => "Ctrl + Shift + S",
            HotkeyPreset::AltF11 => "Alt + F11",
            HotkeyPreset::Insert => "Insert",
        }
    }

    pub fn to_binding(&self) -> ShortcutBinding {
        match self {
            HotkeyPreset::F4 => ShortcutBinding::new(false, false, false, false, 0x73),
            HotkeyPreset::F11 => ShortcutBinding::new(false, false, false, false, 0x7A),
            HotkeyPreset::F10 => ShortcutBinding::new(false, false, false, false, 0x79),
            HotkeyPreset::F9 => ShortcutBinding::new(false, false, false, false, 0x78),
            HotkeyPreset::F12 => ShortcutBinding::new(false, false, false, false, 0x7B),
            HotkeyPreset::F8 => ShortcutBinding::new(false, false, false, false, 0x77),
            HotkeyPreset::CtrlShiftS => ShortcutBinding::new(true, true, false, false, 0x53),
            HotkeyPreset::AltF11 => ShortcutBinding::new(false, false, true, false, 0x7A),
            HotkeyPreset::Insert => ShortcutBinding::new(false, false, false, false, 0x2D),
        }
    }
}

#[allow(dead_code)]
pub type HotkeyChoice = HotkeyPreset;

pub fn vk_to_name(vk: u16) -> String {
    match vk {
        0x70 => "F1".into(),
        0x71 => "F2".into(),
        0x72 => "F3".into(),
        0x73 => "F4".into(),
        0x74 => "F5".into(),
        0x75 => "F6".into(),
        0x76 => "F7".into(),
        0x77 => "F8".into(),
        0x78 => "F9".into(),
        0x79 => "F10".into(),
        0x7A => "F11".into(),
        0x7B => "F12".into(),
        0x7C => "F13".into(),
        0x7D => "F14".into(),
        0x7E => "F15".into(),
        0x7F => "F16".into(),
        0x80 => "F17".into(),
        0x81 => "F18".into(),
        0x82 => "F19".into(),
        0x83 => "F20".into(),
        0x84 => "F21".into(),
        0x85 => "F22".into(),
        0x86 => "F23".into(),
        0x87 => "F24".into(),

        0x41..=0x5A => ((vk as u8) as char).to_string(),
        0x30..=0x39 => ((vk as u8) as char).to_string(),

        0x60 => "Num 0".into(),
        0x61 => "Num 1".into(),
        0x62 => "Num 2".into(),
        0x63 => "Num 3".into(),
        0x64 => "Num 4".into(),
        0x65 => "Num 5".into(),
        0x66 => "Num 6".into(),
        0x67 => "Num 7".into(),
        0x68 => "Num 8".into(),
        0x69 => "Num 9".into(),
        0x6A => "Num *".into(),
        0x6B => "Num +".into(),
        0x6C => "Num Sep".into(),
        0x6D => "Num -".into(),
        0x6E => "Num .".into(),
        0x6F => "Num /".into(),

        0x08 => "Backspace".into(),
        0x09 => "Tab".into(),
        0x0D => "Enter".into(),
        0x13 => "Pause".into(),
        0x14 => "Caps Lock".into(),
        0x1B => "Esc".into(),
        0x20 => "Space".into(),
        0x21 => "Page Up".into(),
        0x22 => "Page Down".into(),
        0x23 => "End".into(),
        0x24 => "Home".into(),
        0x25 => "Left".into(),
        0x26 => "Up".into(),
        0x27 => "Right".into(),
        0x28 => "Down".into(),
        0x2C => "Print Screen".into(),
        0x2D => "Insert".into(),
        0x2E => "Delete".into(),

        0x90 => "Num Lock".into(),
        0x91 => "Scroll Lock".into(),

        0xBA => ";".into(),
        0xBB => "=".into(),
        0xBC => ",".into(),
        0xBD => "-".into(),
        0xBE => ".".into(),
        0xBF => "/".into(),
        0xC0 => "`".into(),
        0xDB => "[".into(),
        0xDC => "\\".into(),
        0xDD => "]".into(),
        0xDE => "'".into(),

        0x04 => "Mouse Middle".into(),
        0x05 => "Mouse 4".into(),
        0x06 => "Mouse 5".into(),

        other => format!("Key 0x{:02X}", other),
    }
}

pub fn get_current_modifiers() -> (bool, bool, bool, bool) {
    unsafe {
        let ctrl = (GetAsyncKeyState(0x11) as u16 & 0x8000) != 0;
        let shift = (GetAsyncKeyState(0x10) as u16 & 0x8000) != 0;
        let alt = (GetAsyncKeyState(0x12) as u16 & 0x8000) != 0;
        let win = (GetAsyncKeyState(0x5B) as u16 & 0x8000) != 0
            || (GetAsyncKeyState(0x5C) as u16 & 0x8000) != 0;
        (ctrl, shift, alt, win)
    }
}

pub fn scan_pressed_non_modifier_key() -> Option<u16> {
    // 1. Function keys F1..=F24 (0x70 ..= 0x87)
    for vk in 0x70..=0x87 {
        if unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 } {
            return Some(vk);
        }
    }
    // 2. Letters A-Z (0x41 ..= 0x5A)
    for vk in 0x41..=0x5A {
        if unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 } {
            return Some(vk);
        }
    }
    // 3. Numbers 0-9 (0x30 ..= 0x39)
    for vk in 0x30..=0x39 {
        if unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 } {
            return Some(vk);
        }
    }
    // 4. Numpad (0x60 ..= 0x6F)
    for vk in 0x60..=0x6F {
        if unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 } {
            return Some(vk);
        }
    }
    // 5. Navigation & Editing
    let nav_keys = [
        0x2D, // Insert
        0x2E, // Delete
        0x24, // Home
        0x23, // End
        0x21, // Page Up
        0x22, // Page Down
        0x25, // Left
        0x26, // Up
        0x27, // Right
        0x28, // Down
        0x20, // Space
        0x09, // Tab
        0x08, // Backspace
        0x0D, // Enter
        0x13, // Pause
        0x14, // Caps Lock
        0x2C, // Print Screen
        0x90, // Num Lock
        0x91, // Scroll Lock
    ];
    for &vk in &nav_keys {
        if unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 } {
            return Some(vk);
        }
    }
    // 6. OEM keys
    let oem_keys = [
        0xC0, // `
        0xBD, // -
        0xBB, // =
        0xDB, // [
        0xDD, // ]
        0xDC, // \
        0xBA, // ;
        0xDE, // '
        0xBC, // ,
        0xBE, // .
        0xBF, // /
    ];
    for &vk in &oem_keys {
        if unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 } {
            return Some(vk);
        }
    }
    // 7. Mouse thumb buttons
    for &vk in &[0x04, 0x05, 0x06] {
        if unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 } {
            return Some(vk);
        }
    }

    None
}

pub fn save_saved_hotkey(binding: &ShortcutBinding) {
    crate::settings::save_hotkey_raw(&binding.serialize());
}

pub fn load_saved_hotkey() -> ShortcutBinding {
    if let Some(s) = crate::settings::load_hotkey_raw() {
        if let Some(binding) = ShortcutBinding::deserialize(&s) {
            return binding;
        }
    }
    ShortcutBinding::f4()
}

pub fn save_saved_stretched_res(w: u32, h: u32) {
    crate::settings::save_stretched(w, h);
}

pub fn load_saved_stretched_res(default_w: u32, default_h: u32) -> (u32, u32) {
    crate::settings::load_stretched().unwrap_or((default_w, default_h))
}
