#![allow(dead_code)]
//! (moved verbatim from `display.rs`; split only, behaviour unchanged.)

use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    EnumDisplayDevicesW, EnumDisplaySettingsW, DEVMODEW, DISPLAY_DEVICEW,
    DISPLAY_DEVICE_PRIMARY_DEVICE, ENUM_CURRENT_SETTINGS, ENUM_DISPLAY_SETTINGS_MODE,
};

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
