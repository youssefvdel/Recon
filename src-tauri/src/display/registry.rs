#![allow(dead_code)]
//! (moved verbatim from `display.rs`; split only, behaviour unchanged.)

use std::path::PathBuf;
use windows::core::PCWSTR;
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiGetDeviceInstanceIdW, SetupDiGetDeviceRegistryPropertyW, CONFIGFLAG_DISABLED,
    SPDRP_CONFIGFLAGS, SP_DEVINFO_DATA,
};
use windows::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
    DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SOURCE_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME, QDC_ALL_PATHS,
    QDC_DATABASE_CURRENT, QDC_ONLY_ACTIVE_PATHS,
};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayDevicesW, DISPLAY_DEVICEW, ENUM_DISPLAY_SETTINGS_MODE,
};
use windows::Win32::UI::Shell::IsUserAnAdmin;

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
    if let Some(dir) = crate::paths::app_data_dir() {
        let p = dir.join("tools").join(name);
        if p.exists() {
            return p;
        }
    }
    let p_desk = PathBuf::from(r"C:\Users\Administrator\Desktop\tools").join(name);
    if p_desk.exists() {
        return p_desk;
    }

    PathBuf::from(name)
}

pub(super) const ENUM_REGISTRY_SETTINGS: ENUM_DISPLAY_SETTINGS_MODE =
    ENUM_DISPLAY_SETTINGS_MODE(0xFFFFFFFE);

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

pub(super) fn setupdi_instance_id<H>(hdev: H, devinfo: &SP_DEVINFO_DATA) -> String
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

pub(super) fn setupdi_is_disabled<H>(hdev: H, devinfo: &SP_DEVINFO_DATA) -> bool
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
pub(super) fn model_from_instance_path(id: &str) -> Option<String> {
    let mut parts = id.split('\\');
    let _first = parts.next()?;
    let model = parts.next()?.trim();
    if model.is_empty() {
        return None;
    }
    Some(model.to_uppercase())
}

pub(super) fn is_gdi_monitor_id(s: &str) -> bool {
    s.len() > 8 && s.as_bytes()[7] == b'\\' && s[..7].eq_ignore_ascii_case("MONITOR")
}

pub(super) fn is_pnp_monitor_instance(s: &str) -> bool {
    s.len() > 8 && s.as_bytes()[7] == b'\\' && s[..7].eq_ignore_ascii_case("DISPLAY")
}

pub(super) fn is_gdi_display_name(s: &str) -> bool {
    s.len() >= 11 && s[..11].eq_ignore_ascii_case(r"\\.\DISPLAY")
}

pub(super) fn setupdi_reg_sz<H>(
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

pub(super) fn setupdi_reg_multi_sz<H>(
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
pub(super) fn pnp_instance_from_monitor_device_path(device_path: &str) -> String {
    let mut s = device_path.trim().to_string();
    if s.starts_with(r"\\?\") {
        s = s[4..].to_string();
    } else if s.starts_with(r"\\?") {
        s = s
            .trim_start_matches(r"\\?")
            .trim_start_matches('\\')
            .to_string();
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
pub(super) fn resolve_display_gdi_to_pnp(display_name: &str) -> Option<String> {
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
            .0 != 0
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
pub(super) fn find_display_name_for_gdi_id(gdi_id: &str) -> Option<String> {
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
