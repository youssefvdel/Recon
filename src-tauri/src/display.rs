#![allow(dead_code)]
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    ChangeDisplaySettingsExW, ChangeDisplaySettingsW, EnumDisplayDevicesW, EnumDisplaySettingsW,
    CDS_NORESET, CDS_SET_PRIMARY, CDS_TEST, CDS_TYPE, CDS_UPDATEREGISTRY, DEVMODEW, DISPLAY_DEVICEW,
    DISPLAY_DEVICE_PRIMARY_DEVICE,
    DM_BITSPERPEL, DM_DISPLAYFLAGS, DM_DISPLAYFREQUENCY, DM_DISPLAYORIENTATION,
    DM_PELSHEIGHT, DM_PELSWIDTH, DM_POSITION, ENUM_CURRENT_SETTINGS,
    ENUM_DISPLAY_SETTINGS_MODE,
};
use windows::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig, SetDisplayConfig,
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
    DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SCALING_ASPECTRATIOCENTEREDMAX, DISPLAYCONFIG_SCALING_STRETCHED,
    DISPLAYCONFIG_SOURCE_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME, QDC_ALL_PATHS,
    QDC_DATABASE_CURRENT, QDC_ONLY_ACTIVE_PATHS, SDC_ALLOW_CHANGES, SDC_APPLY,
    SDC_SAVE_TO_DATABASE, SDC_USE_SUPPLIED_DISPLAY_CONFIG,
};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiCallClassInstaller, SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo,
    SetupDiGetClassDevsW, SetupDiGetDeviceInstallParamsW, SetupDiGetDeviceInstanceIdW,
    SetupDiGetDeviceRegistryPropertyW, SetupDiSetClassInstallParamsW, CONFIGFLAG_DISABLED,
    DICS_DISABLE, DICS_ENABLE, DICS_FLAG_CONFIGSPECIFIC, DI_NEEDREBOOT, DIF_PROPERTYCHANGE,
    DIGCF_ALLCLASSES, DIGCF_PRESENT, GUID_DEVCLASS_MONITOR, SETUP_DI_GET_CLASS_DEVS_FLAGS,
    SP_CLASSINSTALL_HEADER, SP_DEVINFO_DATA, SP_DEVINSTALL_PARAMS_W, SP_PROPCHANGE_PARAMS,
    SPDRP_CONFIGFLAGS, SPDRP_DEVICEDESC, SPDRP_FRIENDLYNAME, SPDRP_HARDWAREID,
};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::Shell::IsUserAnAdmin;

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
        Self { ctrl, shift, alt, win, vk }
    }

    pub const fn f4() -> Self {
        Self { ctrl: true, shift: false, alt: false, win: false, vk: 0x73 }
    }

    #[allow(dead_code)]
    pub const fn f11() -> Self {
        Self { ctrl: false, shift: false, alt: false, win: false, vk: 0x7A }
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
        format!("{}:{}:{}:{}:{}", self.ctrl, self.shift, self.alt, self.win, self.vk)
    }

    pub fn deserialize(s: &str) -> Option<Self> {
        let parts: Vec<&str> = s.trim().split(':').collect();
        if parts.len() == 5 {
            let ctrl = parts[0].parse().ok()?;
            let shift = parts[1].parse().ok()?;
            let alt = parts[2].parse().ok()?;
            let win = parts[3].parse().ok()?;
            let vk = parts[4].parse().ok()?;
            Some(Self { ctrl, shift, alt, win, vk })
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

fn get_hotkey_storage_path() -> Option<PathBuf> {
    if let Ok(app_data) = std::env::var("LOCALAPPDATA") {
        let dir = PathBuf::from(app_data).join("TrueStretchStudio");
        let _ = fs::create_dir_all(&dir);
        Some(dir.join("hotkey.txt"))
    } else {
        Some(PathBuf::from("hotkey.txt"))
    }
}

pub fn save_saved_hotkey(binding: &ShortcutBinding) {
    if let Some(path) = get_hotkey_storage_path() {
        let _ = fs::write(path, binding.serialize());
    }
}

pub fn load_saved_hotkey() -> ShortcutBinding {
    if let Some(path) = get_hotkey_storage_path() {
        if let Ok(s) = fs::read_to_string(path) {
            if let Some(binding) = ShortcutBinding::deserialize(&s) {
                return binding;
            }
        }
    }
    ShortcutBinding::f4()
}

pub fn get_stretched_res_path() -> Option<PathBuf> {
    if let Ok(app_data) = std::env::var("LOCALAPPDATA") {
        let dir = PathBuf::from(app_data).join("TrueStretchStudio");
        let _ = fs::create_dir_all(&dir);
        Some(dir.join("stretched_res.txt"))
    } else {
        Some(PathBuf::from("stretched_res.txt"))
    }
}

pub fn save_saved_stretched_res(w: u32, h: u32) {
    if let Some(path) = get_stretched_res_path() {
        let _ = fs::write(path, format!("{}:{}", w, h));
    }
}

pub fn load_saved_stretched_res(default_w: u32, default_h: u32) -> (u32, u32) {
    if let Some(path) = get_stretched_res_path() {
        if let Ok(s) = fs::read_to_string(path) {
            let parts: Vec<&str> = s.trim().split(':').collect();
            if parts.len() == 2 {
                if let (Ok(w), Ok(h)) = (parts[0].parse(), parts[1].parse()) {
                    if w > 0 && h > 0 {
                        return (w, h);
                    }
                }
            }
        }
    }
    (default_w, default_h)
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DisplayMode {
    pub width: u32,
    pub height: u32,
    pub refresh_rate: u32,
}

/// Retrieves primary monitor device name (e.g. "\\.\DISPLAY1")
pub fn get_primary_device_name() -> String {
    let mut dd = DISPLAY_DEVICEW {
        cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
        ..Default::default()
    };
    let mut i = 0;
    unsafe {
        while EnumDisplayDevicesW(None, i, &mut dd, 0).as_bool() {
            if (dd.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE) != 0 {
                let name = String::from_utf16_lossy(&dd.DeviceName);
                return name.trim_matches(char::from(0)).to_string();
            }
            i += 1;
        }
    }
    r"\\.\DISPLAY1".to_string()
}

/// Retrieves the current display mode (width, height, refresh_rate)
pub fn get_current_display_mode() -> Option<DisplayMode> {
    let dev_name = get_primary_device_name();
    let dev_name_u16: Vec<u16> = format!("{}\0", dev_name).encode_utf16().collect();

    let mut dm = DEVMODEW {
        dmSize: std::mem::size_of::<DEVMODEW>() as u16,
        ..Default::default()
    };

    unsafe {
        let ok = EnumDisplaySettingsW(
            PCWSTR(dev_name_u16.as_ptr()),
            ENUM_CURRENT_SETTINGS,
            &mut dm,
        );
        if ok.as_bool() {
            Some(DisplayMode {
                width: dm.dmPelsWidth,
                height: dm.dmPelsHeight,
                refresh_rate: dm.dmDisplayFrequency,
            })
        } else {
            None
        }
    }
}

/// Retrieves all supported display modes from Windows GDI
pub fn get_all_supported_modes() -> Vec<DisplayMode> {
    let dev_name = get_primary_device_name();
    let dev_name_u16: Vec<u16> = format!("{}\0", dev_name).encode_utf16().collect();

    let mut modes = Vec::new();
    let mut i = 0;
    loop {
        let mut dm = DEVMODEW {
            dmSize: std::mem::size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };
        unsafe {
            if EnumDisplaySettingsW(
                PCWSTR(dev_name_u16.as_ptr()),
                ENUM_DISPLAY_SETTINGS_MODE(i),
                &mut dm,
            )
            .as_bool()
            {
                let mode = DisplayMode {
                    width: dm.dmPelsWidth,
                    height: dm.dmPelsHeight,
                    refresh_rate: dm.dmDisplayFrequency,
                };
                if !modes.contains(&mode) {
                    modes.push(mode);
                }
                i += 1;
            } else {
                break;
            }
        }
    }
    modes
}

/// Detect the monitor panel's native resolution.
/// Native resolution is the highest 16:9 pixel resolution supported by the display.
pub fn get_native_resolution() -> (u32, u32) {
    let modes = get_all_supported_modes();
    let mut best_w = 2560;
    let mut best_h = 1440;
    let mut max_pixels = 0u64;

    for m in &modes {
        // Standard PC aspect ratios (16:9, 16:10)
        let pixels = (m.width as u64) * (m.height as u64);
        if pixels > max_pixels {
            max_pixels = pixels;
            best_w = m.width;
            best_h = m.height;
        }
    }

    (best_w, best_h)
}

/// Queries supported refresh rates for a given resolution, sorted highest to lowest.
pub fn get_supported_refresh_rates_for(width: u32, height: u32) -> Vec<u32> {
    let modes = get_all_supported_modes();
    let mut freqs: Vec<u32> = modes
        .iter()
        .filter(|m| m.width == width && m.height == height)
        .map(|m| m.refresh_rate)
        .collect();

    freqs.sort_unstable();
    freqs.dedup();
    freqs.reverse(); // Highest refresh rate first (e.g. 260, 240, 165, 144, 120, 60)

    if freqs.is_empty() {
        // Fallback to all unique monitor refresh rates
        let mut all_freqs: Vec<u32> = modes.iter().map(|m| m.refresh_rate).collect();
        all_freqs.sort_unstable();
        all_freqs.dedup();
        all_freqs.reverse();
        if all_freqs.is_empty() {
            vec![260, 240, 165, 144, 120, 60]
        } else {
            all_freqs
        }
    } else {
        freqs
    }
}

/// Symbolic text for `ChangeDisplaySettingsExW` return codes.
/// Mirrors `custom_res::cds_code_to_text` so the switch path reports the same
/// names instead of a cryptic number. 0 ok, -2 BADMODE = mode not in the
/// driver `EnumDisplaySettings` list (needs EDID Add first).
pub fn disp_code_to_str(code: i32) -> &'static str {
    match code {
        0 => "SUCCESSFUL",
        1 => "RESTART_REQUIRED",
        -1 => "FAILED",
        -2 => "BADMODE (mode not in driver list — Add it first)",
        -3 => "NOTUPDATED",
        -4 => "BADFLAGS",
        -5 => "BADPARAM",
        -6 => "BADDUALVIEW",
        _ => "UNKNOWN",
    }
}

/// `CDS_TEST` preflight: is `WxH@Hz` already in the driver mode list?
/// No desktop change. Returns `(exists, raw_code)`; `exists` is true for
/// `SUCCESSFUL` (0) only, `RESTART_REQUIRED` (1) is treated as "proceed and
/// try for real" by the caller.
fn cds_test_preflight(dev_name_u16: &[u16], width: u32, height: u32, refresh_rate: u32) -> (bool, i32) {
    unsafe {
        let mut dm = DEVMODEW {
            dmSize: std::mem::size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };
        let _ = EnumDisplaySettingsW(
            PCWSTR(dev_name_u16.as_ptr()),
            ENUM_CURRENT_SETTINGS,
            &mut dm,
        );
        dm.dmPelsWidth = width;
        dm.dmPelsHeight = height;
        dm.dmDisplayFrequency = refresh_rate;
        dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY;
        let res = ChangeDisplaySettingsExW(
            PCWSTR(dev_name_u16.as_ptr()),
            Some(&dm),
            None,
            CDS_TEST,
            None,
        );
        (res.0 == 0, res.0)
    }
}

/// Friendly actionable error for a missing driver mode (BADMODE -2).
/// Includes a nearest-Hz suggestion when the WxH dimensions exist at other
/// refresh rates.
fn badmode_friendly_message(width: u32, height: u32, refresh_rate: u32, test_code: i32) -> String {
    // Exact-match rates only (no fallback): distinguishes "WxH missing at any
    // Hz" from "WxH exists but not at this Hz".
    let exact_rates: Vec<u32> = get_all_supported_modes()
        .iter()
        .filter(|m| m.width == width && m.height == height)
        .map(|m| m.refresh_rate)
        .collect();
    let mut unique_rates = exact_rates;
    unique_rates.sort_unstable();
    unique_rates.dedup();

    let hint = if unique_rates.is_empty() {
        format!(
            " No {}x{} mode at any refresh rate yet.",
            width, height
        )
    } else if unique_rates.contains(&refresh_rate) {
        // Should not happen when preflight just failed, but keep it sane.
        format!(" Driver lists {}x{} at: {}Hz.", width, height, unique_rates.iter().map(|r| r.to_string()).collect::<Vec<_>>().join(", "))
    } else {
        let nearest = unique_rates
            .iter()
            .min_by_key(|r| (**r as i32 - refresh_rate as i32).abs())
            .copied()
            .unwrap_or(unique_rates[0]);
        format!(
            " Nearest supported for {}x{} is {}Hz (supported: {}Hz). Either use {}Hz now or Add {}x{}@{}Hz below.",
            width,
            height,
            nearest,
            unique_rates.iter().map(|r| r.to_string()).collect::<Vec<_>>().join(", "),
            nearest,
            width,
            height,
            refresh_rate
        )
    };

    format!(
        "Mode {}x{}@{}Hz not in driver list (BADMODE -2, CDS_TEST {}={}).{} Go to Custom Res & Test > Add Mode {}x{}@{}Hz as admin (EDID override + driver restart), then Test.",
        width,
        height,
        refresh_rate,
        test_code,
        disp_code_to_str(test_code),
        hint,
        width,
        height,
        refresh_rate
    )
}

/// Changes the Windows primary display resolution and refresh rate.
pub fn apply_display_mode(width: u32, height: u32, refresh_rate: u32) -> Result<(), String> {
    let dev_name = get_primary_device_name();
    let dev_name_u16: Vec<u16> = format!("{}\0", dev_name).encode_utf16().collect();

    // Preflight with CDS_TEST so a computed True Stretch mode that was never
    // Added (e.g. 2088x1440@260) fails fast with an actionable message
    // instead of a cryptic "code: -2" after mutating registry state.
    // (Same semantics as custom_res::test_display_mode, done inline to avoid
    // a display<->custom_res module cycle.)
    let (preflight_ok, test_code) = cds_test_preflight(&dev_name_u16, width, height, refresh_rate);
    if !preflight_ok && test_code != 1 {
        if test_code == -2 {
            log::warn!(
                "[display] preflight BADMODE -2 for {}x{}@{}Hz — mode missing, guiding to Custom Res Add",
                width, height, refresh_rate
            );
            return Err(badmode_friendly_message(width, height, refresh_rate, test_code));
        }
        // Any other CDS_TEST rejection: still fail fast with symbolic text
        // rather than attempting 3 mutating methods that will all fail.
        return Err(format!(
            "Mode {}x{}@{}Hz rejected by driver preflight (CDS_TEST {}={}). {}",
            width,
            height,
            refresh_rate,
            test_code,
            disp_code_to_str(test_code),
            if test_code == -2 {
                "Add it first via Custom Res & Test."
            } else {
                "Pick a listed mode or Test it in Custom Res first."
            }
        ));
    }

    let mut dm = DEVMODEW {
        dmSize: std::mem::size_of::<DEVMODEW>() as u16,
        ..Default::default()
    };

    unsafe {
        let _ = EnumDisplaySettingsW(
            PCWSTR(dev_name_u16.as_ptr()),
            ENUM_CURRENT_SETTINGS,
            &mut dm,
        );

        dm.dmPelsWidth = width;
        dm.dmPelsHeight = height;
        dm.dmDisplayFrequency = refresh_rate;
        dm.dmFields = DM_PELSWIDTH
            | DM_PELSHEIGHT
            | DM_DISPLAYFREQUENCY
            | DM_POSITION
            | DM_BITSPERPEL
            | DM_DISPLAYORIENTATION
            | DM_DISPLAYFLAGS;

        // Method 1: Multi-monitor friendly registry update + commit
        let res_sub = ChangeDisplaySettingsExW(
            PCWSTR(dev_name_u16.as_ptr()),
            Some(&dm),
            None,
            CDS_UPDATEREGISTRY | CDS_NORESET,
            None,
        );

        let res_commit = ChangeDisplaySettingsExW(None, None, None, CDS_TYPE(0), None);

        if res_sub.0 == 0 && res_commit.0 == 0 {
            return Ok(());
        }

        // Method 2: Direct primary display setting update
        let res_direct = ChangeDisplaySettingsExW(
            PCWSTR(dev_name_u16.as_ptr()),
            Some(&dm),
            None,
            CDS_UPDATEREGISTRY,
            None,
        );
        if res_direct.0 == 0 {
            return Ok(());
        }

        // Method 3: Global ChangeDisplaySettingsW
        let res_global = ChangeDisplaySettingsW(Some(&dm), CDS_UPDATEREGISTRY);
        if res_global.0 == 0 {
            return Ok(());
        }

        // Report ALL stage codes with symbolic text (previously res_sub was
        // discarded, showing a misleading commit:0). When any stage is
        // BADMODE -2 the mode is missing from the driver list: point at Add.
        let extra = if [res_sub.0, res_commit.0, res_direct.0, res_global.0].contains(&-2) {
            format!(
                " This is BADMODE (-2): Mode {}x{}@{}Hz not in driver list. Go to Custom Res & Test > Add Mode {}x{}@{}Hz as admin (EDID override + driver restart), then Test.",
                width, height, refresh_rate, width, height, refresh_rate
            )
        } else {
            String::new()
        };
        Err(format!(
            "Failed to apply {}x{} @ {}Hz: sub:{}={} commit:{}={} direct:{}={} global:{}={}.{}",
            width,
            height,
            refresh_rate,
            res_sub.0,
            disp_code_to_str(res_sub.0),
            res_commit.0,
            disp_code_to_str(res_commit.0),
            res_direct.0,
            disp_code_to_str(res_direct.0),
            res_global.0,
            disp_code_to_str(res_global.0),
            extra
        ))
    }
}

/// Queries whether the current active display scaling mode is Stretched (Full-Screen)
pub fn is_scaling_stretched() -> Option<bool> {
    unsafe {
        let mut path_count = 0u32;
        let mut mode_count = 0u32;
        let buf_err = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count);
        if buf_err.0 == 0 && path_count > 0 {
            let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
            let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];

            let query_err = QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut path_count,
                paths.as_mut_ptr(),
                &mut mode_count,
                modes.as_mut_ptr(),
                None,
            );

            if query_err.0 == 0 && !paths.is_empty() {
                return Some(paths[0].targetInfo.scaling == DISPLAYCONFIG_SCALING_STRETCHED);
            }
        }
    }
    None
}

/// Applies Win32 CCD and Registry scaling: stretched (true) or aspect-ratio centered (false)
pub fn set_display_scaling_mode(stretched: bool) -> Result<String, String> {
    unsafe {
        let mut path_count = 0u32;
        let mut mode_count = 0u32;
        let buf_err = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count);
        if buf_err.0 == 0 && path_count > 0 {
            let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
            let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];

            let query_err = QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut path_count,
                paths.as_mut_ptr(),
                &mut mode_count,
                modes.as_mut_ptr(),
                None,
            );

            if query_err.0 == 0 {
                paths.truncate(path_count as usize);
                modes.truncate(mode_count as usize);

                let target_scaling = if stretched {
                    DISPLAYCONFIG_SCALING_STRETCHED
                } else {
                    DISPLAYCONFIG_SCALING_ASPECTRATIOCENTEREDMAX
                };

                let mut updated = 0;
                for p in paths.iter_mut() {
                    p.targetInfo.scaling = target_scaling;
                    updated += 1;
                }

                let flags = SDC_APPLY | SDC_SAVE_TO_DATABASE | SDC_ALLOW_CHANGES | SDC_USE_SUPPLIED_DISPLAY_CONFIG;
                let set_err = SetDisplayConfig(
                    Some(&paths),
                    Some(&modes),
                    flags,
                );

                let reg_val = if stretched { 4 } else { 2 };
                // Pure in-process native winreg update (zero powershell / console flash, instant < 1ms)
                let hklm = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE);
                if let Ok(config_root) = hklm.open_subkey_with_flags(
                    r"SYSTEM\CurrentControlSet\Control\GraphicsDrivers\Configuration",
                    winreg::enums::KEY_READ | winreg::enums::KEY_SET_VALUE,
                ) {
                    fn set_scaling_subkeys(key: &winreg::RegKey, val: u32) {
                        let _ = key.set_value("Scaling", &val);
                        for sub in key.enum_keys().filter_map(|k| k.ok()) {
                            if let Ok(sub_key) = key.open_subkey_with_flags(&sub, winreg::enums::KEY_READ | winreg::enums::KEY_SET_VALUE) {
                                set_scaling_subkeys(&sub_key, val);
                            }
                        }
                    }
                    set_scaling_subkeys(&config_root, reg_val);
                }

                if set_err == 0 {
                    return Ok(format!(
                        "{} applied to {} display path(s)",
                        if stretched { "Full-Screen Stretched (0 Black Bars)" } else { "Aspect Ratio (Pillarboxes)" },
                        updated
                    ));
                }
            }
        }
    }
    Err("Failed to set display scaling mode via Win32 SetDisplayConfig".to_string())
}

/// Automatically applies GPU Full-Screen scaling via Win32 CCD API and driver registry profiles.
pub fn apply_gpu_scaling_stretched() -> Result<String, String> {
    set_display_scaling_mode(true)
}

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

pub fn start_hotkey_listener(initial_shortcut: ShortcutBinding) -> (HotkeyController, Receiver<()>) {
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
                let key_down = unsafe { (GetAsyncKeyState(binding.vk as i32) as u16 & 0x8000) != 0 };
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

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct MonitorDevice {
    pub device_name: String,
    pub adapter_name: String,
    pub monitor_name: String,
    pub is_attached: bool,
    pub is_primary: bool,
    pub width: u32,
    pub height: u32,
    pub refresh_rate: u32,
    pub position_x: i32,
    pub position_y: i32,
    pub orientation: String,
    /// PnP instance path, e.g. `MONITOR\PHLC401\{...}\0001`. Empty if unresolvable.
    #[serde(default)]
    pub device_id: String,
    /// True when the monitor devnode is disabled in Device Manager (SetupDi
    /// `CONFIGFLAG_DISABLED`). Distinct from `is_attached` (CCD topology).
    #[serde(default)]
    pub is_device_disabled: bool,
}

pub fn get_tool_path(name: &str) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p1 = dir.join("tools").join(name);
            if p1.exists() {
                return p1;
            }
            let p2 = dir.join(name);
            if p2.exists() {
                return p2;
            }
        }
    }
    if let Ok(app_data) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(app_data).join("TrueStretchStudio").join("tools").join(name);
        if p.exists() {
            return p;
        }
    }
    let p_desk = PathBuf::from(r"C:\Users\Administrator\Desktop\tools").join(name);
    if p_desk.exists() {
        return p_desk;
    }
    let p_proj = PathBuf::from(r"C:\Users\Administrator\.gemini\antigravity\scratch\truestretch_tauri\tools").join(name);
    if p_proj.exists() {
        return p_proj;
    }

    PathBuf::from(name)
}

const ENUM_REGISTRY_SETTINGS: ENUM_DISPLAY_SETTINGS_MODE = ENUM_DISPLAY_SETTINGS_MODE(0xFFFFFFFE);

// ---------------------------------------------------------------------------
// True Device Manager (SetupDi) helpers
// ---------------------------------------------------------------------------

/// Returns true when the current process is elevated (admin).
pub fn is_process_elevated() -> bool {
    unsafe { IsUserAnAdmin().as_bool() }
}

/// Reads the PnP DeviceID for `\\.\DISPLAYx` via the second EnumDisplayDevicesW
/// call, e.g. `MONITOR\PHLC401\{...}\0001`. Empty string when unresolvable.
pub fn get_monitor_hardware_id(display_name: &str) -> String {
    let dev_name_u16: Vec<u16> = format!("{}\0", display_name).encode_utf16().collect();
    let mut mon_dd = DISPLAY_DEVICEW {
        cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
        ..Default::default()
    };
    unsafe {
        if EnumDisplayDevicesW(PCWSTR(dev_name_u16.as_ptr()), 0, &mut mon_dd, 0).as_bool() {
            return String::from_utf16_lossy(&mon_dd.DeviceID)
                .trim_matches(char::from(0))
                .to_string();
        }
    }
    String::new()
}

fn setupdi_instance_id<H>(hdev: H, devinfo: &SP_DEVINFO_DATA) -> String
where
    H: windows::core::Param<windows::Win32::Devices::DeviceAndDriverInstallation::HDEVINFO> + Copy,
{
    let mut needed: u32 = 0;
    unsafe {
        // First call to get required size (expected to fail with INSUFFICIENT_BUFFER).
        let mut probe = vec![0u16; 1];
        let _ = SetupDiGetDeviceInstanceIdW(hdev, devinfo, Some(&mut probe), Some(&mut needed));
        if needed == 0 {
            needed = 256;
        }
        let mut buf = vec![0u16; needed as usize];
        let mut out_len: u32 = 0;
        match SetupDiGetDeviceInstanceIdW(hdev, devinfo, Some(&mut buf), Some(&mut out_len)) {
            Ok(()) => String::from_utf16_lossy(&buf)
                .trim_matches(char::from(0))
                .to_string(),
            Err(_) => String::new(),
        }
    }
}

fn setupdi_is_disabled<H>(hdev: H, devinfo: &SP_DEVINFO_DATA) -> bool
where
    H: windows::core::Param<windows::Win32::Devices::DeviceAndDriverInstallation::HDEVINFO> + Copy,
{
    unsafe {
        let mut reg_type: u32 = 0;
        let mut buf = [0u8; 4];
        let mut required: u32 = 0;
        if SetupDiGetDeviceRegistryPropertyW(
            hdev,
            devinfo,
            SPDRP_CONFIGFLAGS,
            Some(&mut reg_type),
            Some(&mut buf),
            Some(&mut required),
        )
        .is_ok()
        {
            let flags = u32::from_ne_bytes(buf);
            return (flags & CONFIGFLAG_DISABLED.0) != 0;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// GDI MONITOR\... <-> SetupDi DISPLAY\... bridge.
//
// Background: `EnumDisplayDevicesW` reports a GDI monitor id like
// `MONITOR\PHLC401\{4d36e96e-...}\0005`. That string is NOT a PnP device
// instance path. Real monitor devnodes enumerated with
// `SetupDiGetClassDevs(GUID_DEVCLASS_MONITOR)` (= {4d36e96e-...}) have
// instance paths like `DISPLAY\PHLC401\5&3cd28fe&0&UID4354` — the enumerator
// for the MONITOR class is historically `DISPLAY`. Display *adapters* (GPUs)
// live under GUID_DEVCLASS_DISPLAY ({4d36e968-...}) with `PCI\...` paths and
// must never be disabled here. Exact string comparison between the GDI form
// and the PnP form can therefore never match; we must bridge them.
// ---------------------------------------------------------------------------

/// Second path component, uppercased. Works for both GDI (`MONITOR\PHLC401\...`)
/// and PnP (`DISPLAY\PHLC401\...`) forms.
fn model_from_instance_path(id: &str) -> Option<String> {
    let mut parts = id.split('\\');
    let _first = parts.next()?;
    let model = parts.next()?.trim();
    if model.is_empty() {
        return None;
    }
    Some(model.to_uppercase())
}

fn is_gdi_monitor_id(s: &str) -> bool {
    s.len() > 8 && s.as_bytes()[7] == b'\\' && s[..7].eq_ignore_ascii_case("MONITOR")
}

fn is_pnp_monitor_instance(s: &str) -> bool {
    s.len() > 8 && s.as_bytes()[7] == b'\\' && s[..7].eq_ignore_ascii_case("DISPLAY")
}

fn is_gdi_display_name(s: &str) -> bool {
    s.len() >= 11 && s[..11].eq_ignore_ascii_case(r"\\.\DISPLAY")
}

fn setupdi_reg_sz<H>(
    hdev: H,
    devinfo: &SP_DEVINFO_DATA,
    prop: windows::Win32::Devices::DeviceAndDriverInstallation::SETUP_DI_REGISTRY_PROPERTY,
) -> String
where
    H: windows::core::Param<windows::Win32::Devices::DeviceAndDriverInstallation::HDEVINFO> + Copy,
{
    unsafe {
        let mut reg_type: u32 = 0;
        let mut buf = vec![0u8; 4096];
        let mut required: u32 = 0;
        if SetupDiGetDeviceRegistryPropertyW(
            hdev,
            devinfo,
            prop,
            Some(&mut reg_type),
            Some(&mut buf),
            Some(&mut required),
        )
        .is_err()
        {
            return String::new();
        }
        if required == 0 || required as usize > buf.len() {
            return String::new();
        }
        // REG_SZ / REG_EXPAND_SZ are UTF-16LE.
        let u16_len = required as usize / 2;
        let mut wide = Vec::with_capacity(u16_len);
        for chunk in buf[..u16_len * 2].chunks_exact(2) {
            wide.push(u16::from_le_bytes([chunk[0], chunk[1]]));
        }
        String::from_utf16_lossy(&wide)
            .trim_matches(char::from(0))
            .trim()
            .to_string()
    }
}

fn setupdi_reg_multi_sz<H>(
    hdev: H,
    devinfo: &SP_DEVINFO_DATA,
    prop: windows::Win32::Devices::DeviceAndDriverInstallation::SETUP_DI_REGISTRY_PROPERTY,
) -> Vec<String>
where
    H: windows::core::Param<windows::Win32::Devices::DeviceAndDriverInstallation::HDEVINFO> + Copy,
{
    unsafe {
        let mut reg_type: u32 = 0;
        let mut buf = vec![0u8; 8192];
        let mut required: u32 = 0;
        if SetupDiGetDeviceRegistryPropertyW(
            hdev,
            devinfo,
            prop,
            Some(&mut reg_type),
            Some(&mut buf),
            Some(&mut required),
        )
        .is_err()
        {
            return Vec::new();
        }
        if required == 0 || required as usize > buf.len() {
            return Vec::new();
        }
        let u16_len = required as usize / 2;
        let mut wide = Vec::with_capacity(u16_len);
        for chunk in buf[..u16_len * 2].chunks_exact(2) {
            wide.push(u16::from_le_bytes([chunk[0], chunk[1]]));
        }
        wide.split(|&c| c == 0)
            .map(|s| String::from_utf16_lossy(s).trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }
}

/// Converts a `DISPLAYCONFIG_TARGET_DEVICE_NAME.monitorDevicePath` like
/// `\\?\DISPLAY#HWP2866#5&33cd28fe&0&UID4353#{e6f07b5f-...}` into the PnP
/// instance path `DISPLAY\HWP2866\5&33cd28fe&0&UID4353`.
fn pnp_instance_from_monitor_device_path(device_path: &str) -> String {
    let mut s = device_path.trim().to_string();
    if s.starts_with(r"\\?\") {
        s = s[4..].to_string();
    } else if s.starts_with(r"\\?") {
        s = s.trim_start_matches(r"\\?").trim_start_matches('\\').to_string();
    }
    if let Some(idx) = s.find("#{") {
        s.truncate(idx);
    } else if let Some(idx) = s.find("{") {
        // Defensive: strip a trailing interface-GUID segment.
        let prefix = s[..idx].trim_end_matches(['#', '\\']).to_string();
        s = prefix;
    }
    s = s.replace('#', "\\");
    s.trim_matches('\\').trim().to_string()
}

/// Bridges `\\.\DISPLAYx` -> PnP `DISPLAY\<model>\<uid>` via CCD
/// `QueryDisplayConfig` + `DisplayConfigGetDeviceInfo`.
///
/// `DISPLAYCONFIG_SOURCE_DEVICE_NAME.viewGdiDeviceName` links a CCD source to
/// the GDI name; the same path's target then yields `monitorDevicePath`,
/// which embeds the PnP instance id. This is the only reliable way to tell
/// apart two identical panels (same model, different UID).
fn resolve_display_gdi_to_pnp(display_name: &str) -> Option<String> {
    let want = display_name.trim();
    if !is_gdi_display_name(want) {
        return None;
    }
    unsafe {
        for flags in [QDC_ONLY_ACTIVE_PATHS, QDC_DATABASE_CURRENT, QDC_ALL_PATHS] {
            let mut path_count: u32 = 0;
            let mut mode_count: u32 = 0;
            if GetDisplayConfigBufferSizes(flags, &mut path_count, &mut mode_count).0 != 0 {
                continue;
            }
            if path_count == 0 {
                continue;
            }
            let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
            let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
            if QueryDisplayConfig(
                flags,
                &mut path_count,
                paths.as_mut_ptr(),
                &mut mode_count,
                modes.as_mut_ptr(),
                None,
            )
            .0
                != 0
            {
                continue;
            }
            paths.truncate(path_count as usize);
            for p in &paths {
                let mut src = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
                    header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                        r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                        size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                        adapterId: p.sourceInfo.adapterId,
                        id: p.sourceInfo.id,
                    },
                    ..Default::default()
                };
                if DisplayConfigGetDeviceInfo(
                    &mut src.header as *mut DISPLAYCONFIG_DEVICE_INFO_HEADER,
                ) != 0
                {
                    continue;
                }
                let gdi = String::from_utf16_lossy(&src.viewGdiDeviceName)
                    .trim_matches(char::from(0))
                    .trim()
                    .to_string();
                if !gdi.eq_ignore_ascii_case(want) {
                    continue;
                }
                let mut tgt = DISPLAYCONFIG_TARGET_DEVICE_NAME {
                    header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                        r#type: DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
                        size: std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32,
                        adapterId: p.targetInfo.adapterId,
                        id: p.targetInfo.id,
                    },
                    ..Default::default()
                };
                if DisplayConfigGetDeviceInfo(
                    &mut tgt.header as *mut DISPLAYCONFIG_DEVICE_INFO_HEADER,
                ) != 0
                {
                    continue;
                }
                let raw_path = String::from_utf16_lossy(&tgt.monitorDevicePath)
                    .trim_matches(char::from(0))
                    .trim()
                    .to_string();
                if raw_path.is_empty() {
                    continue;
                }
                let pnp = pnp_instance_from_monitor_device_path(&raw_path);
                if !pnp.is_empty() {
                    log::info!(
                        "[display] DisplayConfig bridge '{}' -> '{}' (raw '{}')",
                        want,
                        pnp,
                        raw_path
                    );
                    return Some(pnp);
                }
            }
        }
    }
    log::warn!(
        "[display] DisplayConfig bridge found no PnP path for '{}'",
        want
    );
    None
}

/// Finds the `\\.\DISPLAYx` whose GDI hardware id exactly equals `gdi_id`.
/// Used to disambiguate duplicate models: each physical panel has a unique
/// trailing `\000x` index even when the model matches.
fn find_display_name_for_gdi_id(gdi_id: &str) -> Option<String> {
    unsafe {
        let mut di: u32 = 0;
        loop {
            let mut dd = DISPLAY_DEVICEW {
                cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
                ..Default::default()
            };
            if !EnumDisplayDevicesW(None, di, &mut dd, 0).as_bool() {
                break;
            }
            let dn = String::from_utf16_lossy(&dd.DeviceName)
                .trim_matches(char::from(0))
                .trim()
                .to_string();
            if !dn.is_empty() {
                let hid = get_monitor_hardware_id(&dn);
                if !hid.is_empty() && hid.eq_ignore_ascii_case(gdi_id.trim()) {
                    return Some(dn);
                }
            }
            di += 1;
            if di > 64 {
                break;
            }
        }
    }
    None
}

#[derive(Clone, Debug)]
struct MonitorCandidate {
    instance_id: String,
    lower: String,
    model_upper: Option<String>,
    hw_ids: Vec<String>,
    friendly: String,
    desc: String,
    disabled: bool,
}

/// Enumerates MONITOR-class devnodes (instance paths are `DISPLAY\...`) with
/// hardware ids + friendly names. Merges PRESENT first then all devnodes
/// (flags 0) so disabled/ghosted panels stay resolvable for re-enable.
fn collect_monitor_candidates() -> Vec<MonitorCandidate> {
    let mut map: std::collections::HashMap<String, MonitorCandidate> =
        std::collections::HashMap::new();
    for flags in [
        DIGCF_PRESENT,
        SETUP_DI_GET_CLASS_DEVS_FLAGS(0),
    ] {
        unsafe {
            let hdev = match SetupDiGetClassDevsW(Some(&GUID_DEVCLASS_MONITOR), None, None, flags)
            {
                Ok(h) => h,
                Err(e) => {
                    log::warn!(
                        "[display] candidate enum SetupDiGetClassDevs(MONITOR, {:?}) failed: {}",
                        flags,
                        e
                    );
                    continue;
                }
            };
            if hdev.is_invalid() {
                continue;
            }
            let mut index: u32 = 0;
            loop {
                let mut devinfo = SP_DEVINFO_DATA {
                    cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
                    ..Default::default()
                };
                if SetupDiEnumDeviceInfo(hdev, index, &mut devinfo).is_err() {
                    break;
                }
                let instance_id = setupdi_instance_id(hdev, &devinfo);
                if instance_id.is_empty() {
                    index += 1;
                    continue;
                }
                // Safety: never treat GPU adapters as monitors. MONITOR-class
                // instance paths start with DISPLAY\; anything else is logged
                // and skipped.
                if !is_pnp_monitor_instance(&instance_id) {
                    log::warn!(
                        "[display] skipping non-monitor instance '{}' in MONITOR class enum",
                        instance_id
                    );
                    index += 1;
                    continue;
                }
                let disabled = setupdi_is_disabled(hdev, &devinfo);
                let hw_ids = setupdi_reg_multi_sz(hdev, &devinfo, SPDRP_HARDWAREID);
                let friendly = setupdi_reg_sz(hdev, &devinfo, SPDRP_FRIENDLYNAME);
                let desc = setupdi_reg_sz(hdev, &devinfo, SPDRP_DEVICEDESC);
                let key = instance_id.to_lowercase();
                let model_upper = model_from_instance_path(&instance_id);
                match map.get_mut(&key) {
                    Some(existing) => {
                        if existing.hw_ids.is_empty() && !hw_ids.is_empty() {
                            existing.hw_ids = hw_ids;
                        }
                        if existing.friendly.is_empty() && !friendly.is_empty() {
                            existing.friendly = friendly;
                        }
                        if existing.desc.is_empty() && !desc.is_empty() {
                            existing.desc = desc;
                        }
                        if disabled {
                            existing.disabled = true;
                        }
                        if existing.model_upper.is_none() {
                            existing.model_upper = model_upper;
                        }
                    }
                    None => {
                        map.insert(
                            key.clone(),
                            MonitorCandidate {
                                instance_id: instance_id.clone(),
                                lower: key,
                                model_upper,
                                hw_ids,
                                friendly,
                                desc,
                                disabled,
                            },
                        );
                    }
                }
                index += 1;
            }
            let _ = SetupDiDestroyDeviceInfoList(hdev);
        }
    }
    // Fallback: whole-class enumeration if the MONITOR hint returned nothing
    // (e.g. class hint missed a phantom devnode). Keep only DISPLAY\...
    // instances with MONITOR\... hardware ids so GPU adapters never leak in.
    if map.is_empty() {
        unsafe {
            let hdev = match SetupDiGetClassDevsW(None, None, None, DIGCF_ALLCLASSES) {
                Ok(h) => h,
                Err(_) => return Vec::new(),
            };
            if hdev.is_invalid() {
                return Vec::new();
            }
            let mut index: u32 = 0;
            loop {
                let mut devinfo = SP_DEVINFO_DATA {
                    cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
                    ..Default::default()
                };
                if SetupDiEnumDeviceInfo(hdev, index, &mut devinfo).is_err() {
                    break;
                }
                let instance_id = setupdi_instance_id(hdev, &devinfo);
                if !instance_id.is_empty() && is_pnp_monitor_instance(&instance_id) {
                    let hw_ids = setupdi_reg_multi_sz(hdev, &devinfo, SPDRP_HARDWAREID);
                    let looks_like_monitor = hw_ids.iter().any(|h| is_gdi_monitor_id(h))
                        || model_from_instance_path(&instance_id).is_some();
                    if looks_like_monitor {
                        let key = instance_id.to_lowercase();
                        map.entry(key.clone()).or_insert(MonitorCandidate {
                            instance_id: instance_id.clone(),
                            lower: key,
                            model_upper: model_from_instance_path(&instance_id),
                            hw_ids,
                            friendly: setupdi_reg_sz(hdev, &devinfo, SPDRP_FRIENDLYNAME),
                            desc: setupdi_reg_sz(hdev, &devinfo, SPDRP_DEVICEDESC),
                            disabled: setupdi_is_disabled(hdev, &devinfo),
                        });
                    }
                }
                index += 1;
            }
            let _ = SetupDiDestroyDeviceInfoList(hdev);
        }
    }
    map.into_values().collect()
}

fn candidates_matching_model<'a>(
    candidates: &'a [MonitorCandidate],
    model_upper: &str,
) -> Vec<&'a MonitorCandidate> {
    candidates
        .iter()
        .filter(|c| {
            if let Some(m) = c.model_upper.as_ref() {
                if m == model_upper {
                    return true;
                }
            }
            c.hw_ids.iter().any(|h| {
                if let Some(m) = model_from_instance_path(h) {
                    m == model_upper
                } else {
                    h.eq_ignore_ascii_case(model_upper)
                        || h.to_uppercase().contains(model_upper)
                }
            })
        })
        .collect()
}

fn format_candidates_for_error(candidates: &[MonitorCandidate]) -> String {
    if candidates.is_empty() {
        return "(none enumerated in MONITOR class)".to_string();
    }
    let mut sorted: Vec<&MonitorCandidate> = candidates.iter().collect();
    sorted.sort_by(|a, b| a.instance_id.cmp(&b.instance_id));
    sorted
        .iter()
        .map(|c| {
            let mut s = c.instance_id.clone();
            if !c.hw_ids.is_empty() {
                s.push_str(&format!(" [hw: {}]", c.hw_ids.join("|")));
            }
            let name = if !c.friendly.is_empty() {
                c.friendly.clone()
            } else if !c.desc.is_empty() {
                c.desc.clone()
            } else {
                String::new()
            };
            if !name.is_empty() {
                s.push_str(&format!(" (\"{}\")", name));
            }
            s
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Robust resolver: any accepted input (`MONITOR\...` GDI id,
/// `\\.\DISPLAYx`, or `DISPLAY\...` PnP path) -> canonical PnP
/// `DISPLAY\<model>\<uid>` from the MONITOR class.
///
/// Match precedence:
/// (a) exact PnP instance-id (case-insensitive) — covers re-enable of
///     ghosted devnodes and callers that already pass the canonical id;
/// (b) GDI id -> owning `\\.\DISPLAYx` (exact trailing `\000x`) ->
///     DisplayConfig bridge -> PnP path (disambiguates duplicate models);
/// (c) `\\.\DISPLAYx` -> DisplayConfig bridge -> PnP path;
/// (d) single-candidate model fallback (`MONITOR\<model>` prefix / hardware
///     id). Ambiguous multi-candidate models return None so we never disable
///     the wrong duplicate panel.
fn resolve_to_pnp_instance(target: &str) -> Option<String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidates = collect_monitor_candidates();
    if candidates.is_empty() {
        log::warn!("[display] resolve: no MONITOR candidates enumerated");
        return None;
    }
    // (a) Exact PnP instance match.
    for c in &candidates {
        if c.instance_id.eq_ignore_ascii_case(trimmed) {
            return Some(c.instance_id.clone());
        }
    }
    // GDI MONITOR\... input.
    if is_gdi_monitor_id(trimmed) {
        // (b) Exact GDI -> DISPLAYx -> DisplayConfig -> PnP.
        if let Some(display_name) = find_display_name_for_gdi_id(trimmed) {
            log::info!(
                "[display] resolve GDI '{}' owned by '{}'",
                trimmed,
                display_name
            );
            if let Some(pnp) = resolve_display_gdi_to_pnp(&display_name) {
                if candidates
                    .iter()
                    .any(|c| c.instance_id.eq_ignore_ascii_case(&pnp))
                {
                    return Some(
                        candidates
                            .iter()
                            .find(|c| c.instance_id.eq_ignore_ascii_case(&pnp))
                            .map(|c| c.instance_id.clone())
                            .unwrap_or(pnp),
                    );
                }
                log::warn!(
                    "[display] bridge PnP '{}' for '{}' not in MONITOR enum; keeping bridge value",
                    pnp,
                    display_name
                );
                return Some(pnp);
            }
            // Bridge failed (e.g. already disabled): fall through to model.
        } else {
            log::warn!(
                "[display] resolve GDI '{}' matches no live DISPLAYx; trying model fallback",
                trimmed
            );
        }
        // (d) Model fallback.
        if let Some(model) = model_from_instance_path(trimmed) {
            let hits = candidates_matching_model(&candidates, &model);
            log::info!(
                "[display] resolve GDI model '{}' matched {} candidate(s)",
                model,
                hits.len()
            );
            if hits.len() == 1 {
                return Some(hits[0].instance_id.clone());
            }
            if hits.len() > 1 {
                log::warn!(
                    "[display] ambiguous GDI model '{}': {} candidates; refusing to guess. Available: {}",
                    model,
                    hits.len(),
                    format_candidates_for_error(&candidates)
                );
                return None;
            }
        }
        return None;
    }
    // (c) DISPLAYx input.
    if is_gdi_display_name(trimmed) {
        if let Some(pnp) = resolve_display_gdi_to_pnp(trimmed) {
            if let Some(hit) = candidates
                .iter()
                .find(|c| c.instance_id.eq_ignore_ascii_case(&pnp))
            {
                return Some(hit.instance_id.clone());
            }
            return Some(pnp);
        }
        // Bridge failed: try the DISPLAYx's GDI hardware id model as fallback.
        let raw_gdi = get_monitor_hardware_id(trimmed);
        if !raw_gdi.is_empty() {
            if let Some(model) = model_from_instance_path(&raw_gdi) {
                let hits = candidates_matching_model(&candidates, &model);
                if hits.len() == 1 {
                    return Some(hits[0].instance_id.clone());
                }
                log::warn!(
                    "[display] DISPLAYx '{}' (GDI '{}') model '{}' matched {} candidates",
                    trimmed,
                    raw_gdi,
                    model,
                    hits.len()
                );
            }
        }
        return None;
    }
    // PnP DISPLAY\... input that didn't exact-match: try model singleton.
    if is_pnp_monitor_instance(trimmed) {
        if let Some(model) = model_from_instance_path(trimmed) {
            let hits = candidates_matching_model(&candidates, &model);
            if hits.len() == 1 {
                return Some(hits[0].instance_id.clone());
            }
        }
        return None;
    }
    // Unknown form: case-insensitive hardware-id / friendly-name contains.
    let upper = trimmed.to_uppercase();
    let mut hits: Vec<&MonitorCandidate> = candidates
        .iter()
        .filter(|c| {
            c.hw_ids.iter().any(|h| h.eq_ignore_ascii_case(trimmed))
                || c.friendly.eq_ignore_ascii_case(trimmed)
                || (!trimmed.is_empty()
                    && (c.friendly.to_uppercase().contains(&upper)
                        || c.instance_id.to_uppercase().contains(&upper)))
        })
        .collect();
    if hits.len() == 1 {
        return Some(hits.remove(0).instance_id.clone());
    }
    None
}

/// Enumerates MONITOR devnodes with the given SetupDi flags, merging into `map`.
fn enumerate_monitor_devnodes(
    map: &mut std::collections::HashMap<String, (String, bool)>,
    flags: SETUP_DI_GET_CLASS_DEVS_FLAGS,
) {
    unsafe {
        let hdev = match SetupDiGetClassDevsW(Some(&GUID_DEVCLASS_MONITOR), None, None, flags) {
            Ok(h) => h,
            Err(e) => {
                log::warn!(
                    "[display] SetupDiGetClassDevs(MONITOR, flags={:?}) failed: {}",
                    flags,
                    e
                );
                return;
            }
        };
        if hdev.is_invalid() {
            return;
        }
        let mut index: u32 = 0;
        loop {
            let mut devinfo = SP_DEVINFO_DATA {
                cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            if SetupDiEnumDeviceInfo(hdev, index, &mut devinfo).is_err() {
                break;
            }
            let instance_id = setupdi_instance_id(hdev, &devinfo);
            if !instance_id.is_empty() {
                let disabled = setupdi_is_disabled(hdev, &devinfo);
                // Prefer the PRESENT enumeration's disabled flag, but keep any
                // ghosted devnode so disabled monitors stay visible + re-enableable.
                let key = instance_id.to_lowercase();
                map.entry(key.clone())
                    .or_insert((instance_id.clone(), disabled));
                // If we already knew this devnode and the new pass says disabled,
                // upgrade the flag (ghosted pass may know it is disabled).
                if disabled {
                    if let Some(entry) = map.get_mut(&key) {
                        entry.1 = true;
                    }
                }
            }
            index += 1;
        }
        let _ = SetupDiDestroyDeviceInfoList(hdev);
    }
}

/// Maps lowercase instance-id -> (canonical instance-id, is_disabled) for every
/// MONITOR devnode, including ghosted/disabled devnodes that GDI no longer
/// enumerates. Never fails hard; returns empty map on error.
fn get_monitor_disabled_map() -> std::collections::HashMap<String, (String, bool)> {
    let mut map = std::collections::HashMap::new();
    // Present devices first (authoritative disabled flag).
    enumerate_monitor_devnodes(&mut map, DIGCF_PRESENT);
    // Then all devnodes (flags 0 = present + phantom/ghosted) so a hard
    // Device Manager disable that hides the DISPLAYx entry is still found and
    // can be re-enabled.
    enumerate_monitor_devnodes(&mut map, SETUP_DI_GET_CLASS_DEVS_FLAGS(0));
    // Fallback: whole-class enumeration in case the MONITOR class hint misses
    // a phantom devnode.
    if map.is_empty() {
        enumerate_monitor_devnodes(&mut map, DIGCF_ALLCLASSES);
    }
    map
}

/// Last-known resolution cache so disabled monitors keep showing their real
/// resolution (and a correct aspect ratio) instead of 0x0 / NaN.
fn get_monitor_res_cache_path() -> Option<PathBuf> {
    if let Ok(app_data) = std::env::var("LOCALAPPDATA") {
        let dir = PathBuf::from(app_data).join("TrueStretchStudio");
        let _ = fs::create_dir_all(&dir);
        Some(dir.join("monitor_res_cache.json"))
    } else {
        Some(PathBuf::from("monitor_res_cache.json"))
    }
}

fn load_monitor_res_cache() -> std::collections::HashMap<String, (u32, u32, u32)> {
    let mut out = std::collections::HashMap::new();
    let path = match get_monitor_res_cache_path() {
        Some(p) => p,
        None => return out,
    };
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return out,
    };
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(obj) = json.as_object() {
            for (k, v) in obj {
                let w = v.get("w").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                let h = v.get("h").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                let r = v.get("r").and_then(|x| x.as_u64()).unwrap_or(60) as u32;
                if w > 0 && h > 0 {
                    out.insert(k.to_lowercase(), (w, h, r));
                }
            }
        }
    }
    out
}

fn save_monitor_res_cache(cache: &std::collections::HashMap<String, (u32, u32, u32)>) {
    let path = match get_monitor_res_cache_path() {
        Some(p) => p,
        None => return,
    };
    let mut obj = serde_json::Map::new();
    for (k, (w, h, r)) in cache {
        obj.insert(
            k.clone(),
            serde_json::json!({ "w": w, "h": h, "r": r }),
        );
    }
    let _ = fs::write(&path, serde_json::Value::Object(obj).to_string());
}

/// Returns true when the devnode currently needs a reboot to complete a
/// property change (DI_NEEDREBOOT in its install params).
fn setupdi_needs_reboot<H>(hdev: H, devinfo: &SP_DEVINFO_DATA) -> bool
where
    H: windows::core::Param<windows::Win32::Devices::DeviceAndDriverInstallation::HDEVINFO> + Copy,
{
    unsafe {
        let mut params = SP_DEVINSTALL_PARAMS_W {
            cbSize: std::mem::size_of::<SP_DEVINSTALL_PARAMS_W>() as u32,
            ..Default::default()
        };
        if SetupDiGetDeviceInstallParamsW(hdev, Some(devinfo as *const SP_DEVINFO_DATA), &mut params)
            .is_ok()
        {
            return (params.Flags.0 & DI_NEEDREBOOT.0) != 0;
        }
    }
    false
}

/// Resolves `\\.\DISPLAYx` (or a raw `MONITOR\...` GDI id, or a `DISPLAY\...`
/// PnP path) to the canonical SetupDi MONITOR-class instance path
/// (`DISPLAY\<model>\<uid>`). Returns None when no devnode matches.
///
/// NOTE: GDI `MONITOR\...` ids are *not* PnP paths and never equal-match a
/// SetupDi instance id. Resolution goes GDI -> owning DISPLAYx ->
/// DisplayConfig bridge -> PnP, with a single-candidate model fallback.
/// Ambiguous duplicate models return None so callers never touch the wrong
/// panel.
pub fn resolve_display_to_instance_id(display_or_id: &str) -> Option<String> {
    let trimmed = display_or_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Robust bridge handles all three input forms (exact PnP, GDI id, DISPLAYx).
    if let Some(pnp) = resolve_to_pnp_instance(trimmed) {
        return Some(pnp);
    }
    // No guess on ambiguity: surface None so the caller can list MONITOR-class
    // candidates instead of failing on a raw GDI string later.
    log::warn!(
        "[display] resolve_display_to_instance_id: no PnP devnode for '{}'",
        trimmed
    );
    None
}

fn friendly_name_from_instance_id(instance_id: &str, fallback: &str) -> String {
    if !fallback.is_empty() && fallback != "Generic PnP Monitor" {
        return fallback.to_string();
    }
    if !instance_id.is_empty() {
        let parts: Vec<&str> = instance_id.split('\\').collect();
        if parts.len() > 1 && !parts[1].is_empty() {
            return format!("Monitor ({})", parts[1]);
        }
    }
    if fallback.is_empty() {
        "Generic Display".to_string()
    } else {
        fallback.to_string()
    }
}

pub fn get_all_monitors() -> Vec<MonitorDevice> {
    const FLAG_ATTACHED: u32 = 0x00000001;
    const FLAG_PRIMARY: u32 = 0x00000004;

    let disabled_map = get_monitor_disabled_map();
    // Rich candidates (hw ids + friendly names) for the GDI->PnP bridge and
    // single-model fallback. Collected once so per-DISPLAYx joins don't
    // re-enumerate SetupDi.
    let candidates = collect_monitor_candidates();
    // Lowercase PnP -> candidate index for O(1) bridge lookups.
    let candidate_by_lower: std::collections::HashMap<&str, &MonitorCandidate> = candidates
        .iter()
        .map(|c| (c.lower.as_str(), c))
        .collect();
    let mut seen_instance_ids = std::collections::HashSet::new();
    // Last-known resolutions so disabled monitors keep real w/h for aspect ratio.
    let mut res_cache = load_monitor_res_cache();
    let mut res_cache_dirty = false;

    let mut monitors = Vec::new();
    let mut i = 0u32;
    loop {
        let mut dd = DISPLAY_DEVICEW {
            cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        let ok = unsafe { EnumDisplayDevicesW(None, i, &mut dd, 0).as_bool() };
        if !ok {
            break;
        }

        let adapter_name = String::from_utf16_lossy(&dd.DeviceString)
            .trim_matches(char::from(0))
            .to_string();
        let device_name = String::from_utf16_lossy(&dd.DeviceName)
            .trim_matches(char::from(0))
            .to_string();
        let is_attached = (dd.StateFlags & FLAG_ATTACHED) != 0;
        let is_primary = (dd.StateFlags & FLAG_PRIMARY) != 0;

        let dev_name_u16: Vec<u16> = format!("{}\0", device_name).encode_utf16().collect();
        let mut mon_dd = DISPLAY_DEVICEW {
            cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        let mut monitor_name = "Generic Display".to_string();
        let mut raw_device_id = String::new();
        unsafe {
            if EnumDisplayDevicesW(PCWSTR(dev_name_u16.as_ptr()), 0, &mut mon_dd, 0).as_bool() {
                let mon_str = String::from_utf16_lossy(&mon_dd.DeviceString)
                    .trim_matches(char::from(0))
                    .to_string();
                let mon_id = String::from_utf16_lossy(&mon_dd.DeviceID)
                    .trim_matches(char::from(0))
                    .to_string();
                raw_device_id = mon_id.clone();
                if !mon_str.is_empty() && mon_str != "Generic PnP Monitor" {
                    monitor_name = mon_str;
                } else if !mon_id.is_empty() {
                    // Extract model code from MONITOR\PHLC401\...
                    let parts: Vec<&str> = mon_id.split('\\').collect();
                    if parts.len() > 1 {
                        monitor_name = format!("Monitor ({})", parts[1]);
                    } else {
                        monitor_name = mon_str;
                    }
                }
            }
        }

        // Join GDI MONITOR\... with the SetupDi MONITOR-class PnP devnode
        // (DISPLAY\<model>\<uid>). Exact match alone can never hit because the
        // two id forms differ by design; bridge via DisplayConfig, then fall
        // back to a single-candidate model match. Multi-candidate models stay
        // on the raw GDI id (never guess the wrong duplicate panel).
        let (device_id, is_device_disabled) = if raw_device_id.is_empty() {
            (String::new(), false)
        } else if let Some((canonical, disabled)) =
            disabled_map.get(&raw_device_id.to_lowercase())
        {
            seen_instance_ids.insert(canonical.to_lowercase());
            monitor_name = friendly_name_from_instance_id(canonical, &monitor_name);
            (canonical.clone(), *disabled)
        } else if let Some(bridged) = resolve_display_gdi_to_pnp(&device_name) {
            if let Some((canonical, disabled)) = disabled_map.get(&bridged.to_lowercase()) {
                seen_instance_ids.insert(canonical.to_lowercase());
                // Prefer the SetupDi friendly name when GDI only has generic text.
                if let Some(cand) = candidate_by_lower.get(canonical.to_lowercase().as_str()) {
                    if (monitor_name == "Generic Display"
                        || monitor_name == "Generic PnP Monitor"
                        || monitor_name.starts_with("Monitor ("))
                        && !cand.friendly.is_empty()
                    {
                        monitor_name = cand.friendly.clone();
                    } else {
                        monitor_name =
                            friendly_name_from_instance_id(canonical, &monitor_name);
                    }
                } else {
                    monitor_name = friendly_name_from_instance_id(canonical, &monitor_name);
                }
                log::info!(
                    "[display] GDI '{}' ({}) bridged to PnP '{}'",
                    device_name,
                    raw_device_id,
                    canonical
                );
                (canonical.clone(), *disabled)
            } else if let Some(cand) = candidate_by_lower.get(bridged.to_lowercase().as_str()) {
                seen_instance_ids.insert(cand.instance_id.to_lowercase());
                if monitor_name.starts_with("Monitor (") && !cand.friendly.is_empty() {
                    monitor_name = cand.friendly.clone();
                }
                (cand.instance_id.clone(), cand.disabled)
            } else {
                // Bridge produced a PnP path SetupDi didn't list (transient?).
                // Keep the bridged id so enable/disable can still target it.
                log::warn!(
                    "[display] bridge PnP '{}' for '{}' not in disabled_map; using bridge value",
                    bridged,
                    device_name
                );
                seen_instance_ids.insert(bridged.to_lowercase());
                (bridged, false)
            }
        } else if let Some(model) = model_from_instance_path(&raw_device_id) {
            let hits = candidates_matching_model(&candidates, &model);
            if hits.len() == 1 {
                let cand = hits[0];
                let disabled = disabled_map
                    .get(&cand.lower)
                    .map(|(_, d)| *d)
                    .unwrap_or(cand.disabled);
                seen_instance_ids.insert(cand.instance_id.to_lowercase());
                if monitor_name.starts_with("Monitor (") && !cand.friendly.is_empty() {
                    monitor_name = cand.friendly.clone();
                } else {
                    monitor_name =
                        friendly_name_from_instance_id(&cand.instance_id, &monitor_name);
                }
                log::info!(
                    "[display] GDI '{}' ({}) model-matched singleton PnP '{}'",
                    device_name,
                    raw_device_id,
                    cand.instance_id
                );
                (cand.instance_id.clone(), disabled)
            } else {
                if hits.len() > 1 {
                    log::warn!(
                        "[display] GDI '{}' ({}) model '{}' ambiguous ({} candidates); keeping GDI id",
                        device_name,
                        raw_device_id,
                        model,
                        hits.len()
                    );
                }
                (raw_device_id.clone(), false)
            }
        } else {
            (raw_device_id.clone(), false)
        };
        if !device_id.is_empty() {
            seen_instance_ids.insert(device_id.to_lowercase());
        }

        let mut dm = DEVMODEW {
            dmSize: std::mem::size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };
        let mut width = 0;
        let mut height = 0;
        let mut refresh_rate = 60;
        let mut position_x = 0;
        let mut position_y = 0;
        let mut orientation = "Landscape".to_string();

        unsafe {
            let ok_mode = if is_attached {
                EnumDisplaySettingsW(PCWSTR(dev_name_u16.as_ptr()), ENUM_CURRENT_SETTINGS, &mut dm)
            } else {
                EnumDisplaySettingsW(PCWSTR(dev_name_u16.as_ptr()), ENUM_REGISTRY_SETTINGS, &mut dm)
            };

            if ok_mode.as_bool() {
                width = dm.dmPelsWidth;
                height = dm.dmPelsHeight;
                refresh_rate = dm.dmDisplayFrequency;
                position_x = dm.Anonymous1.Anonymous2.dmPosition.x;
                position_y = dm.Anonymous1.Anonymous2.dmPosition.y;
                let o = dm.Anonymous1.Anonymous2.dmDisplayOrientation.0;
                orientation = match o {
                    1 => "Portrait (90°)",
                    2 => "Landscape (Flipped)",
                    3 => "Portrait (270°)",
                    _ => "Landscape",
                }.to_string();
            }
        }

        // Never report 0x0 for a disabled monitor when we know its real mode:
        // prefer the live mode, then the last-known cached mode, so the UI
        // aspect ratio never shows 0:0 / NaN.
        if !device_id.is_empty() {
            let key = device_id.to_lowercase();
            if width > 0 && height > 0 {
                let entry = res_cache.get(&key).copied();
                if entry != Some((width, height, refresh_rate)) {
                    res_cache.insert(key, (width, height, refresh_rate));
                    res_cache_dirty = true;
                }
            } else if let Some(&(cw, ch, cr)) = res_cache.get(&key) {
                width = cw;
                height = ch;
                // Keep live refresh rate when valid, else cached.
                if refresh_rate == 0 || refresh_rate == 60 {
                    refresh_rate = cr;
                }
            }
        }

        // Keep disabled devnodes visible even when CCD reports width==0 /
        // detached, so the UI shows "Device Disabled" instead of looking like
        // the display was "closed" / removed.
        if !device_name.is_empty() && (is_attached || width > 0 || is_device_disabled) {
            monitors.push(MonitorDevice {
                device_name,
                adapter_name,
                monitor_name,
                is_attached,
                is_primary,
                width,
                height,
                refresh_rate,
                position_x,
                position_y,
                orientation,
                device_id,
                is_device_disabled,
            });
        }

        i += 1;
    }

    if res_cache_dirty {
        save_monitor_res_cache(&res_cache);
    }

    // Append SetupDi MONITOR devnodes that GDI no longer enumerates (e.g. hard
    // Device Manager disable hides the DISPLAYx entry). These get a synthetic
    // card so the user can still see and re-enable them. Use the last-known
    // cached resolution so aspect ratio stays correct.
    for (canonical_id, disabled) in disabled_map.values() {
        if seen_instance_ids.contains(&canonical_id.to_lowercase()) {
            continue;
        }
        if !disabled {
            continue;
        }
        let (cw, ch, cr) = res_cache
            .get(&canonical_id.to_lowercase())
            .copied()
            .unwrap_or((0, 0, 60));
        monitors.push(MonitorDevice {
            device_name: canonical_id.clone(),
            adapter_name: "Monitor Device".to_string(),
            monitor_name: friendly_name_from_instance_id(canonical_id, "Generic PnP Monitor"),
            is_attached: false,
            is_primary: false,
            width: cw,
            height: ch,
            refresh_rate: cr,
            position_x: 0,
            position_y: 0,
            orientation: "Landscape".to_string(),
            device_id: canonical_id.clone(),
            is_device_disabled: true,
        });
    }

    monitors
}

/// CCD topology detach/attach only (temporary). Natively adjusts GDI attached state via ChangeDisplaySettingsExW.
/// `set_monitor_attached` historically did: NirSoft MultiMonitorTool
/// `/disable` (CCD wrapper) or a `ChangeDisplaySettingsExW` 0x0 fallback.
/// Device Manager still shows Enabled and games can still enumerate the panel.
pub fn set_monitor_topology_attached(
    device_name: &str,
    attached: bool,
) -> Result<Vec<MonitorDevice>, String> {
    log::info!(
        "[display] topology {} {} (CCD detach path)",
        if attached { "attach" } else { "detach" },
        device_name
    );
    let dev_name_u16: Vec<u16> = format!("{}\0", device_name).encode_utf16().collect();
    let mut dm = DEVMODEW {
        dmSize: std::mem::size_of::<DEVMODEW>() as u16,
        ..Default::default()
    };
    if attached {
        unsafe {
            let _ = EnumDisplaySettingsW(PCWSTR(dev_name_u16.as_ptr()), ENUM_REGISTRY_SETTINGS, &mut dm);
            if dm.dmPelsWidth == 0 {
                let _ = EnumDisplaySettingsW(PCWSTR(dev_name_u16.as_ptr()), ENUM_DISPLAY_SETTINGS_MODE(0), &mut dm);
            }
            dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_POSITION | DM_DISPLAYFREQUENCY;
            let _ = ChangeDisplaySettingsExW(PCWSTR(dev_name_u16.as_ptr()), Some(&dm), None, CDS_UPDATEREGISTRY | CDS_NORESET, None);
            let _ = ChangeDisplaySettingsExW(PCWSTR::null(), None, None, CDS_TYPE(0), None);
        }
    } else {
        unsafe {
            dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_POSITION;
            dm.dmPelsWidth = 0;
            dm.dmPelsHeight = 0;
            let _ = ChangeDisplaySettingsExW(PCWSTR(dev_name_u16.as_ptr()), Some(&dm), None, CDS_UPDATEREGISTRY | CDS_NORESET, None);
            let _ = ChangeDisplaySettingsExW(PCWSTR::null(), None, None, CDS_TYPE(0), None);
        }
    }

    thread::sleep(Duration::from_millis(350));
    Ok(get_all_monitors())
}

/// Back-compat alias: historic CCD detach path. New code should call
/// `set_monitor_topology_attached` for temporary detach or
/// `set_monitor_device_enabled` for a true Device Manager disable.
pub fn set_monitor_attached(device_name: &str, attached: bool) -> Result<Vec<MonitorDevice>, String> {
    set_monitor_topology_attached(device_name, attached)
}

/// True Device Manager enable/disable for a monitor devnode.
///
/// Accepts any of: canonical PnP `DISPLAY\<model>\<uid>` (preferred — this is
/// what `get_all_monitors().device_id` now returns), GDI `MONITOR\...` id, or
/// `\\.\DISPLAYx`. GDI ids are bridged GDI -> owning DISPLAYx ->
/// DisplayConfig -> PnP; duplicate models are disambiguated by the bridge, and
/// ambiguous multi-candidate models are rejected instead of touching the wrong
/// panel. Only `GUID_DEVCLASS_MONITOR` devnodes are ever touched — GPU
/// adapters (`GUID_DEVCLASS_DISPLAY`, `PCI\...`) are never disabled. Uses
/// `SetupDiSetClassInstallParams(DIF_PROPERTYCHANGE, DICS_ENABLE/DICS_DISABLE,
/// DICS_FLAG_CONFIGSPECIFIC)` + `SetupDiCallClassInstaller` for an immediate
/// profile-specific state change (no deferred reboot semantics).
///
/// Safety: refuses to disable the last enabled monitor. Requires elevation;
/// returns a clear admin error (no silent fallback — the frontend must surface
/// it). Checks DI_NEEDREBOOT via SetupDiGetDeviceInstallParams and logs it.
pub fn set_monitor_device_enabled(
    device_id_or_name: &str,
    enabled: bool,
) -> Result<Vec<MonitorDevice>, String> {
    let action = if enabled { "enable" } else { "disable" };
    log::info!(
        "[display] device {} requested for '{}'",
        action,
        device_id_or_name
    );

    if !is_process_elevated() {
        log::warn!("[display] device {} denied: not elevated", action);
        return Err(
            "Requires admin: run TrueStretch as administrator to enable/disable monitor devices in Device Manager.".to_string(),
        );
    }

    let target = device_id_or_name.trim();
    if target.is_empty() {
        return Err("Empty monitor identifier".to_string());
    }

    // Robust bridge: GDI MONITOR\... / DISPLAYx / PnP DISPLAY\... -> canonical
    // MONITOR-class PnP path (DISPLAY\<model>\<uid>). Exact PnP matches cover
    // the re-enable path for ghosted devnodes (flags 0 enumeration).
    let resolved_pnp: Option<String> = resolve_to_pnp_instance(target);
    // Keep the legacy resolver output for log parity; prefer the robust bridge.
    let resolved = resolved_pnp
        .clone()
        .or_else(|| resolve_display_to_instance_id(target))
        .unwrap_or_else(|| target.to_string());
    log::info!("[display] resolved '{}' -> '{}'", target, resolved);

    // Unresolvable / ambiguous: fail fast with the MONITOR-class candidate
    // list (PnP DISPLAY\... + hw ids + friendly names) instead of running a
    // doomed exact-match loop over incompatible id forms. Never fall back to
    // disabling a GPU adapter.
    if resolved_pnp.is_none() {
        let candidates = collect_monitor_candidates();
        let detail = if is_gdi_monitor_id(target) || is_gdi_display_name(target) {
            let model_note = model_from_instance_path(target)
                .or_else(|| {
                    if is_gdi_display_name(target) {
                        let gdi = get_monitor_hardware_id(target);
                        if gdi.is_empty() {
                            None
                        } else {
                            model_from_instance_path(&gdi)
                        }
                    } else {
                        None
                    }
                })
                .map(|m| {
                    let hits = candidates_matching_model(&candidates, &m);
                    format!(" Model '{}' matched {} MONITOR-class candidate(s).", m, hits.len())
                })
                .unwrap_or_default();
            format!(
                "GDI id '{}' is not a PnP path and could not be bridged to a unique MONITOR devnode (DISPLAY\\<model>\\<uid>).{}. Pass the canonical device_id (DISPLAY\\...) shown in the monitor list.",
                target, model_note
            )
        } else {
            format!(
                "Identifier '{}' matched no MONITOR-class devnode.",
                target
            )
        };
        return Err(format!(
            "Device Manager change failed: {}. Available MONITOR devnodes (never GPU adapters): {}",
            detail,
            format_candidates_for_error(&candidates)
        ));
    }
    // From here `resolved` is the canonical PnP id; match SetupDi devnodes on
    // it exactly (case-insensitive) so duplicate-model panels can't collide.
    let resolved = resolved;

    // Safety: never disable the last enabled monitor devnode.
    // Snapshot current topology first (also warms the res cache so the
    // disabled card keeps its real resolution for aspect ratio).
    if !enabled {
        let current = get_all_monitors();
        let enabled_count = current.iter().filter(|m| !m.is_device_disabled).count();
        let target_is_currently_enabled = current.iter().any(|m| {
            if m.is_device_disabled {
                return false;
            }
            // Exact hits first (canonical PnP device_id, DISPLAYx name).
            if m.device_name.eq_ignore_ascii_case(target)
                || m.device_name.eq_ignore_ascii_case(&resolved)
                || (!m.device_id.is_empty()
                    && (m.device_id.eq_ignore_ascii_case(target)
                        || m.device_id.eq_ignore_ascii_case(&resolved)))
            {
                return true;
            }
            // Loose model hit as a safety net: a stale GDI MONITOR\<model>
            // id must still count as "the last monitor" when only one panel
            // is enabled, so we refuse rather than orphan the desktop.
            if let Some(target_model) = model_from_instance_path(target).or_else(|| {
                if is_gdi_display_name(target) {
                    let gdi = get_monitor_hardware_id(target);
                    if gdi.is_empty() {
                        None
                    } else {
                        model_from_instance_path(&gdi)
                    }
                } else {
                    None
                }
            }) {
                if let Some(m_model) = model_from_instance_path(&m.device_id) {
                    if m_model == target_model {
                        return true;
                    }
                }
            }
            false
        });
        // If we cannot positively identify the target in the list, fall back to
        // counting: with <=1 enabled monitor, refuse.
        if enabled_count <= 1 && (target_is_currently_enabled || enabled_count == 1) {
            log::warn!("[display] refusing to disable last active monitor");
            return Err(
                "Refusing to disable the last active monitor (at least one must stay enabled). Re-enable another display first.".to_string(),
            );
        }
    }

    let state_change = if enabled { DICS_ENABLE } else { DICS_DISABLE };

    // Try PRESENT first; for the enable path the devnode may be ghosted
    // (non-present), so fall back to flags 0 (all) then DIGCF_ALLCLASSES.
    let flag_sets: [SETUP_DI_GET_CLASS_DEVS_FLAGS; 3] = [
        DIGCF_PRESENT,
        SETUP_DI_GET_CLASS_DEVS_FLAGS(0),
        DIGCF_ALLCLASSES,
    ];

    let mut matched_total = 0usize;
    let mut needs_reboot = false;
    let mut last_err: Option<String> = None;

    for flags in flag_sets {
        let attempt: Result<(usize, bool), String> = unsafe {
            let hdev = SetupDiGetClassDevsW(Some(&GUID_DEVCLASS_MONITOR), None, None, flags)
                .map_err(|e| {
                    let msg = format!("SetupDiGetClassDevs(MONITOR) failed: {}", e);
                    log::error!("[display] {}", msg);
                    msg
                })?;
            if hdev.is_invalid() {
                return Err("SetupDiGetClassDevs returned an invalid handle".to_string());
            }

            let mut matched = 0usize;
            let mut reboot = false;
            let mut attempt_err: Option<String> = None;
            let mut index: u32 = 0;
            loop {
                let mut devinfo = SP_DEVINFO_DATA {
                    cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
                    ..Default::default()
                };
                if SetupDiEnumDeviceInfo(hdev, index, &mut devinfo).is_err() {
                    break;
                }
                let instance_id = setupdi_instance_id(hdev, &devinfo);
                // `resolved` is the canonical MONITOR-class PnP path
                // (DISPLAY\<model>\<uid>) from the GDI->DisplayConfig bridge.
                // Match it exactly (case-insensitive). Never compare a GDI
                // MONITOR\... id against a PnP DISPLAY\... id here — those
                // forms differ by design and can never equal-match. Never
                // match GPU adapters: we only enumerated GUID_DEVCLASS_MONITOR
                // and skip non-DISPLAY\... instances below.
                if !is_pnp_monitor_instance(&instance_id) {
                    log::warn!(
                        "[display] skipping non-monitor instance '{}' during {}",
                        instance_id,
                        action
                    );
                    index += 1;
                    continue;
                }
                let is_target = instance_id.eq_ignore_ascii_case(&resolved)
                    || (is_pnp_monitor_instance(target)
                        && instance_id.eq_ignore_ascii_case(target));

                if is_target {
                    log::info!(
                        "[display] DIF_PROPERTYCHANGE {} (CONFIGSPECIFIC) on '{}'",
                        if enabled { "DICS_ENABLE" } else { "DICS_DISABLE" },
                        instance_id
                    );
                    let mut params = SP_PROPCHANGE_PARAMS {
                        ClassInstallHeader: SP_CLASSINSTALL_HEADER {
                            cbSize: std::mem::size_of::<SP_CLASSINSTALL_HEADER>() as u32,
                            InstallFunction: DIF_PROPERTYCHANGE,
                        },
                        StateChange: state_change,
                        Scope: DICS_FLAG_CONFIGSPECIFIC,
                        HwProfile: 0,
                    };
                    let set_res = SetupDiSetClassInstallParamsW(
                        hdev,
                        Some(&devinfo as *const SP_DEVINFO_DATA),
                        Some(
                            &params.ClassInstallHeader as *const SP_CLASSINSTALL_HEADER,
                        ),
                        std::mem::size_of::<SP_PROPCHANGE_PARAMS>() as u32,
                    );
                    if let Err(e) = set_res {
                        let code = format!("{}", e);
                        log::error!("[display] SetupDiSetClassInstallParams failed: {}", code);
                        if code.contains("0x80070005")
                            || code.to_lowercase().contains("access")
                            || code.to_lowercase().contains("privilege")
                        {
                            attempt_err = Some(
                                "Requires admin: run TrueStretch as administrator to enable/disable monitor devices in Device Manager."
                                    .to_string(),
                            );
                        } else {
                            attempt_err = Some(format!(
                                "SetupDiSetClassInstallParams failed for {}: {}",
                                instance_id, code
                            ));
                        }
                    } else {
                        match SetupDiCallClassInstaller(
                            DIF_PROPERTYCHANGE,
                            hdev,
                            Some(&devinfo as *const SP_DEVINFO_DATA),
                        ) {
                            Ok(()) => {
                                log::info!("[display] {} succeeded for {}", action, instance_id);
                                // Check whether the driver reports a reboot is still needed.
                                if setupdi_needs_reboot(hdev, &devinfo) {
                                    reboot = true;
                                    log::warn!(
                                        "[display] {} for {} reports DI_NEEDREBOOT — a reboot may be required to complete the state change",
                                        action,
                                        instance_id
                                    );
                                }
                                matched += 1;
                            }
                            Err(e) => {
                                let code = format!("{}", e);
                                log::error!("[display] SetupDiCallClassInstaller failed: {}", code);
                                if code.contains("0x80070005")
                                    || code.to_lowercase().contains("access")
                                    || code.to_lowercase().contains("privilege")
                                {
                                    attempt_err = Some(
                                        "Requires admin: run TrueStretch as administrator to enable/disable monitor devices in Device Manager."
                                            .to_string(),
                                    );
                                } else {
                                    attempt_err = Some(format!(
                                        "Device {} rejected state change ({}). It may need a reboot to complete.",
                                        instance_id, code
                                    ));
                                }
                            }
                        }
                    }
                    // Keep params alive until after the installer call.
                    std::hint::black_box(&mut params);
                    break;
                }
                index += 1;
            }

            let _ = SetupDiDestroyDeviceInfoList(hdev);

            if matched > 0 {
                Ok((matched, reboot))
            } else if let Some(err) = attempt_err {
                Err(err)
            } else {
                Err(String::new())
            }
        };

        match attempt {
            Ok((n, reboot)) => {
                matched_total = n;
                needs_reboot = reboot;
                last_err = None;
                break;
            }
            Err(e) if !e.is_empty() => {
                last_err = Some(e);
                break;
            }
            Err(_) => {
                // Not found with these flags — try the next (wider) flag set.
                continue;
            }
        }
    }

    if matched_total == 0 {
        if let Some(err) = last_err {
            return Err(err);
        }
        // List MONITOR-class candidates only (DISPLAY\... + hw ids + friendly
        // names). Never list GPU adapters. The GDI MONITOR\... id and the PnP
        // DISPLAY\... id differ by design — show both so the mapping is clear.
        let candidates = collect_monitor_candidates();
        return Err(format!(
            "Device Manager change failed: Monitor '{}' (resolved '{}') not found in Device Manager monitor class (GUID_DEVCLASS_MONITOR). GDI MONITOR\\... ids are not PnP paths; the bridge resolves them to DISPLAY\\<model>\\<uid>. Available MONITOR devnodes (never GPU adapters): {}",
            target,
            resolved,
            format_candidates_for_error(&candidates)
        ));
    }

    // PnP state change is async; give the display stack a beat to re-enumerate
    // before re-querying topology so the UI doesn't show stale state.
    thread::sleep(Duration::from_millis(needs_reboot.then_some(800).unwrap_or(500)));
    let monitors = get_all_monitors();
    if needs_reboot {
        log::warn!(
            "[display] device {} completed for '{}' but Windows reports a reboot is needed to fully apply it",
            action,
            resolved
        );
    }
    Ok(monitors)
}

pub fn set_monitor_primary(device_name: &str) -> Result<Vec<MonitorDevice>, String> {
    log::info!("[display] setting primary monitor to '{}' via native Win32", device_name);
    unsafe {
        let mut dev_names = Vec::new();
        let mut i = 0u32;
        loop {
            let mut dd = DISPLAY_DEVICEW {
                cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
                ..Default::default()
            };
            if !EnumDisplayDevicesW(None, i, &mut dd, 0).as_bool() {
                break;
            }
            i += 1;
            if (dd.StateFlags & 0x00000001) != 0 { // DISPLAY_DEVICE_ATTACHED_TO_DESKTOP
                let name = String::from_utf16_lossy(&dd.DeviceName)
                    .trim_matches(char::from(0))
                    .to_string();
                dev_names.push(name);
            }
        }

        let mut modes: Vec<(String, DEVMODEW)> = Vec::new();
        let mut target_offset_x = 0i32;
        let mut target_offset_y = 0i32;
        let mut target_found = false;

        for name in &dev_names {
            let name_u16: Vec<u16> = format!("{}\0", name).encode_utf16().collect();
            let mut dm = DEVMODEW {
                dmSize: std::mem::size_of::<DEVMODEW>() as u16,
                ..Default::default()
            };
            if EnumDisplaySettingsW(PCWSTR(name_u16.as_ptr()), ENUM_CURRENT_SETTINGS, &mut dm).as_bool() {
                if name.eq_ignore_ascii_case(device_name) {
                    target_offset_x = dm.Anonymous1.Anonymous2.dmPosition.x;
                    target_offset_y = dm.Anonymous1.Anonymous2.dmPosition.y;
                    target_found = true;
                }
                modes.push((name.clone(), dm));
            }
        }

        if target_found {
            for (name, dm) in &mut modes {
                dm.Anonymous1.Anonymous2.dmPosition.x -= target_offset_x;
                dm.Anonymous1.Anonymous2.dmPosition.y -= target_offset_y;
                dm.dmFields |= DM_POSITION;

                let name_u16: Vec<u16> = format!("{}\0", name).encode_utf16().collect();
                let flags = if name.eq_ignore_ascii_case(device_name) {
                    CDS_SET_PRIMARY | CDS_UPDATEREGISTRY | CDS_NORESET
                } else {
                    CDS_UPDATEREGISTRY | CDS_NORESET
                };
                let _ = ChangeDisplaySettingsExW(
                    PCWSTR(name_u16.as_ptr()),
                    Some(dm),
                    None,
                    flags,
                    None,
                );
            }
            let _ = ChangeDisplaySettingsExW(PCWSTR::null(), None, None, CDS_UPDATEREGISTRY, None);
        }
    }
    thread::sleep(Duration::from_millis(350));
    Ok(get_all_monitors())
}

pub fn launch_cru() -> Result<(), String> {
    Err("CRU is disabled. TrueStretch uses built-in native Win32/GPU display engine.".to_string())
}

pub fn restart_graphics_driver() -> Result<String, String> {
    Ok(crate::custom_res::restart_driver_stack())
}

pub fn reset_all_cru_overrides() -> Result<String, String> {
    crate::custom_res::reset_all_edid_overrides()
}


