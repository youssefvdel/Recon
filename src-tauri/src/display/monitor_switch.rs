#![allow(dead_code)]
//! (moved verbatim from `display.rs`; split only, behaviour unchanged.)

use super::registry::ENUM_REGISTRY_SETTINGS;
use super::report::{get_all_monitors, MonitorDevice};
use std::thread;
use std::time::Duration;
use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    ChangeDisplaySettingsExW, EnumDisplayDevicesW, EnumDisplaySettingsW, CDS_NORESET,
    CDS_SET_PRIMARY, CDS_TYPE, CDS_UPDATEREGISTRY, DEVMODEW, DISPLAY_DEVICEW, DM_DISPLAYFREQUENCY,
    DM_PELSHEIGHT, DM_PELSWIDTH, DM_POSITION, ENUM_CURRENT_SETTINGS, ENUM_DISPLAY_SETTINGS_MODE,
};

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
            let _ = EnumDisplaySettingsW(
                PCWSTR(dev_name_u16.as_ptr()),
                ENUM_REGISTRY_SETTINGS,
                &mut dm,
            );
            if dm.dmPelsWidth == 0 {
                let _ = EnumDisplaySettingsW(
                    PCWSTR(dev_name_u16.as_ptr()),
                    ENUM_DISPLAY_SETTINGS_MODE(0),
                    &mut dm,
                );
            }
            dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_POSITION | DM_DISPLAYFREQUENCY;
            let _ = ChangeDisplaySettingsExW(
                PCWSTR(dev_name_u16.as_ptr()),
                Some(&dm),
                None,
                CDS_UPDATEREGISTRY | CDS_NORESET,
                None,
            );
            let _ = ChangeDisplaySettingsExW(PCWSTR::null(), None, None, CDS_TYPE(0), None);
        }
    } else {
        unsafe {
            dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_POSITION;
            dm.dmPelsWidth = 0;
            dm.dmPelsHeight = 0;
            let _ = ChangeDisplaySettingsExW(
                PCWSTR(dev_name_u16.as_ptr()),
                Some(&dm),
                None,
                CDS_UPDATEREGISTRY | CDS_NORESET,
                None,
            );
            let _ = ChangeDisplaySettingsExW(PCWSTR::null(), None, None, CDS_TYPE(0), None);
        }
    }

    thread::sleep(Duration::from_millis(350));
    Ok(get_all_monitors())
}

/// Back-compat alias: historic CCD detach path. New code should call
/// `set_monitor_topology_attached` for temporary detach or
/// `set_monitor_device_enabled` for a true Device Manager disable.
pub fn set_monitor_attached(
    device_name: &str,
    attached: bool,
) -> Result<Vec<MonitorDevice>, String> {
    set_monitor_topology_attached(device_name, attached)
}

pub fn set_monitor_primary(device_name: &str) -> Result<Vec<MonitorDevice>, String> {
    log::info!(
        "[display] setting primary monitor to '{}' via native Win32",
        device_name
    );
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
            if (dd.StateFlags & 0x00000001) != 0 {
                // DISPLAY_DEVICE_ATTACHED_TO_DESKTOP
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
            if EnumDisplaySettingsW(PCWSTR(name_u16.as_ptr()), ENUM_CURRENT_SETTINGS, &mut dm)
                .as_bool()
            {
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
    Err("CRU is disabled. Outpeek uses built-in native Win32/GPU display engine.".to_string())
}

pub fn restart_graphics_driver() -> Result<String, String> {
    Ok(crate::custom_res::restart_driver_stack())
}

pub fn reset_all_cru_overrides() -> Result<String, String> {
    crate::custom_res::reset_all_edid_overrides()
}
