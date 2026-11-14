#![allow(dead_code)]
//! Built-in custom resolution Add (NVIDIA Control Panel + CRU style) without
//! manual CRU GUI. Works for every GPU (NVIDIA/AMD/Intel) via a minimal
//! single-descriptor EDID override in the Windows registry.
//!
//! Port notes (from `cru_src/`):
//! - `DisplayClass::SaveOverrideData` writes
//!   `HKLM\SYSTEM\CurrentControlSet\Enum\DISPLAY\<dev>\<inst>\Device Parameters\EDID_OVERRIDE`
//!   value `"0"` (128B base block, checksum fixed). We do the same, but with a
//!   minimal single-descriptor patch (offset 54) instead of a full CRU model.
//! - `DetailedResolutionClass::Write` (Type 0, 18B) packs the detailed timing
//!   descriptor. `CalculateAutomaticPC` table (lines 46-71) is ported verbatim;
//!   fallback is CVT-RB2 (`CalculateCVTRB2`: H 8/32/40, V sync 8 / back 6,
//!   front derived from 460ns blank constraint).
//! - `restart.c SetDriverState` disables/enables `GUID_DEVCLASS_DISPLAY`
//!   (GPU adapters, GLOBAL scope). We do it in-process first, falling back to
//!   `restart64.exe -q`. `reset-all.c` single delete is mirrored by
//!   `remove_custom_override`.
//! - `display.rs` resolver (`resolve_display_to_instance_id`) maps any UI id
//!   (`MONITOR\...` / `\\.\DISPLAYx` / `DISPLAY\...`) to canonical
//!   `DISPLAY\<model>\<uid>`; ambiguous duplicates are refused, never guessed.

use std::thread;
use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiCallClassInstaller, SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo,
    SetupDiGetClassDevsW, SetupDiSetClassInstallParamsW, DICS_DISABLE, DICS_ENABLE,
    DICS_FLAG_GLOBAL, DIF_PROPERTYCHANGE, DIGCF_PRESENT, GUID_DEVCLASS_DISPLAY,
    SP_CLASSINSTALL_HEADER, SP_DEVINFO_DATA, SP_PROPCHANGE_PARAMS,
};
use windows::Win32::Graphics::Gdi::{
    ChangeDisplaySettingsExW, EnumDisplaySettingsW, CDS_TEST, DEVMODEW, DM_DISPLAYFREQUENCY,
    DM_PELSHEIGHT, DM_PELSWIDTH, ENUM_CURRENT_SETTINGS,
};

use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_BINARY};
use winreg::{RegKey, RegValue};

mod edid;
mod timing;

pub use self::edid::patch_edid;
pub use self::timing::{build_detailed_timing, validate_custom_resolution};

use self::edid::{device_params_path, is_valid_edid, override_path, split_pnp};

// Admin/elevation texts belong to the registry half: the pure timing and EDID
// helpers never touch HKLM.
pub const ADMIN_ADD_ERR: &str = "Requires admin: run Outpeek as administrator to add custom resolutions (EDID override needs elevated registry write).";
pub const ADMIN_REMOVE_ERR: &str = "Requires admin: run Outpeek as administrator to remove EDID overrides (needs elevated registry write).";

// ---------------------------------------------------------------------------
// EDID registry helpers (HKLM\...\DISPLAY\<dev>\<inst>\Device Parameters)
// ---------------------------------------------------------------------------

/// Reads the live EDID (`EDID` value) for a canonical PnP path.
pub fn read_live_edid(pnp: &str) -> Result<Vec<u8>, String> {
    let (dev, inst) = split_pnp(pnp).ok_or_else(|| {
        format!(
            "Not a DISPLAY PnP path (need DISPLAY\\<model>\\<uid>): '{}'",
            pnp
        )
    })?;
    let path = device_params_path(&dev, &inst);
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm
        .open_subkey_with_flags(&path, KEY_QUERY_VALUE)
        .map_err(|e| format!("Failed to open EDID registry '{}': {}", path, e))?;
    let val: RegValue = key
        .get_raw_value("EDID")
        .map_err(|e| format!("No live EDID found for '{}' ({}): {}", pnp, path, e))?;
    if val.bytes.len() < 128 {
        return Err(format!(
            "Live EDID for '{}' too short ({} bytes).",
            pnp,
            val.bytes.len()
        ));
    }
    if !is_valid_edid(&val.bytes) {
        return Err(format!(
            "Live EDID for '{}' has a bad header (not 00 FF FF FF FF FF FF 00).",
            pnp
        ));
    }
    Ok(val.bytes)
}

fn backup_path_for(pnp: &str) -> Option<std::path::PathBuf> {
    let safe: String = pnp
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | ' ' => '_',
            _ => c,
        })
        .collect();
    crate::paths::data_file(&format!("edid_backup_{}.bin", safe))
}

fn write_override(dev: &str, inst: &str, patched: &[u8; 128]) -> Result<(), String> {
    let path = override_path(dev, inst);
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let (key, _disp) = hklm.create_subkey(&path).map_err(|e| {
        let msg = format!("{}", e);
        if msg.to_lowercase().contains("access")
            || msg.to_lowercase().contains("denied")
            || msg.to_lowercase().contains("privilege")
        {
            ADMIN_ADD_ERR.to_string()
        } else {
            format!("Failed to create EDID_OVERRIDE key '{}': {}", path, e)
        }
    })?;
    key.set_raw_value(
        "0",
        &RegValue {
            vtype: REG_BINARY,
            bytes: patched.to_vec(),
        },
    )
    .map_err(|e| {
        let msg = format!("{}", e);
        if msg.to_lowercase().contains("access")
            || msg.to_lowercase().contains("denied")
            || msg.to_lowercase().contains("privilege")
        {
            ADMIN_ADD_ERR.to_string()
        } else {
            format!("Failed to write EDID_OVERRIDE '0' (need admin): {}", e)
        }
    })?;
    Ok(())
}

fn delete_override_key(dev: &str, inst: &str) -> Result<bool, String> {
    let params = device_params_path(dev, inst);
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = hklm
        .open_subkey_with_flags(&params, KEY_SET_VALUE)
        .map_err(|e| {
            let msg = format!("{}", e);
            if msg.to_lowercase().contains("access")
                || msg.to_lowercase().contains("denied")
                || msg.to_lowercase().contains("privilege")
            {
                ADMIN_REMOVE_ERR.to_string()
            } else {
                format!("Failed to open '{}': {}", params, e)
            }
        })?;
    match key.delete_subkey("EDID_OVERRIDE") {
        Ok(()) => Ok(true),
        Err(e) => {
            let code = e.raw_os_error().unwrap_or(0);
            // 2 = FILE_NOT_FOUND: already reset â†’ success.
            if code == 2 {
                Ok(false)
            } else {
                let msg = format!("{}", e);
                if msg.to_lowercase().contains("access")
                    || msg.to_lowercase().contains("denied")
                    || msg.to_lowercase().contains("privilege")
                {
                    Err(ADMIN_REMOVE_ERR.to_string())
                } else {
                    // Fallback: try deleting values individually (handles a
                    // partially-written override without subkey delete rights).
                    let _ = key.delete_value("EDID_OVERRIDE");
                    Err(format!(
                        "Failed to delete EDID_OVERRIDE for '{}\\{}': {}",
                        dev, inst, e
                    ))
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// CDS_TEST + driver restart
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct CustomModeTest {
    pub exists: bool,
    pub code: i32,
}

fn gdi_name_for_test(preferred: Option<&str>) -> String {
    if let Some(p) = preferred {
        let t = p.trim();
        if t.len() >= 11 && t[..11].eq_ignore_ascii_case(r"\\.\DISPLAY") {
            return t.to_string();
        }
    }
    crate::display::get_primary_device_name()
}

/// `ChangeDisplaySettingsExW` with `CDS_TEST`: does the driver already list
/// this mode? `exists` is true only on `DISP_CHANGE_SUCCESSFUL` (0).
/// Common codes: 0 ok, -1 FAILED, -2 BADMODE (not in driver list), -5 BADPARAM.
pub fn test_display_mode(device_name: Option<&str>, w: u32, h: u32, hz: u32) -> CustomModeTest {
    let dev = gdi_name_for_test(device_name);
    let dev_u16: Vec<u16> = format!("{}\0", dev).encode_utf16().collect();
    unsafe {
        let mut dm = DEVMODEW {
            dmSize: std::mem::size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };
        let _ = EnumDisplaySettingsW(PCWSTR(dev_u16.as_ptr()), ENUM_CURRENT_SETTINGS, &mut dm);
        dm.dmPelsWidth = w;
        dm.dmPelsHeight = h;
        dm.dmDisplayFrequency = hz;
        dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY;
        let res =
            ChangeDisplaySettingsExW(PCWSTR(dev_u16.as_ptr()), Some(&dm), None, CDS_TEST, None);
        CustomModeTest {
            exists: res.0 == 0,
            code: res.0,
        }
    }
}

pub fn cds_code_to_text(code: i32) -> &'static str {
    match code {
        0 => "SUCCESSFUL",
        1 => "RESTART_REQUIRED",
        -1 => "FAILED",
        -2 => "BADMODE (mode not in driver list â€” Add it first)",
        -3 => "NOTUPDATED",
        -4 => "BADFLAGS",
        -5 => "BADPARAM",
        -6 => "BADDUALVIEW",
        _ => "UNKNOWN",
    }
}

/// Sets GLOBAL enable/disable on every present `GUID_DEVCLASS_DISPLAY`
/// adapter (`restart.c SetDriverState` port). Returns devnodes changed.
fn set_display_adapter_state(enable: bool) -> Result<usize, String> {
    unsafe {
        let hdev = SetupDiGetClassDevsW(Some(&GUID_DEVCLASS_DISPLAY), None, None, DIGCF_PRESENT)
            .map_err(|e| format!("SetupDiGetClassDevs(DISPLAY) failed: {}", e))?;
        if hdev.is_invalid() {
            return Err("SetupDiGetClassDevs returned invalid handle".to_string());
        }
        let state = if enable { DICS_ENABLE } else { DICS_DISABLE };
        let mut changed = 0usize;
        let mut index: u32 = 0;
        loop {
            let mut devinfo = SP_DEVINFO_DATA {
                cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            if SetupDiEnumDeviceInfo(hdev, index, &mut devinfo).is_err() {
                break;
            }
            let mut params = SP_PROPCHANGE_PARAMS {
                ClassInstallHeader: SP_CLASSINSTALL_HEADER {
                    cbSize: std::mem::size_of::<SP_CLASSINSTALL_HEADER>() as u32,
                    InstallFunction: DIF_PROPERTYCHANGE,
                },
                StateChange: state,
                Scope: DICS_FLAG_GLOBAL,
                HwProfile: 0,
            };
            let ok = SetupDiSetClassInstallParamsW(
                hdev,
                Some(&devinfo as *const SP_DEVINFO_DATA),
                Some(&params.ClassInstallHeader as *const SP_CLASSINSTALL_HEADER),
                std::mem::size_of::<SP_PROPCHANGE_PARAMS>() as u32,
            )
            .is_ok()
                && SetupDiCallClassInstaller(
                    DIF_PROPERTYCHANGE,
                    hdev,
                    Some(&devinfo as *const SP_DEVINFO_DATA),
                )
                .is_ok();
            if ok {
                changed += 1;
            }
            std::hint::black_box(&mut params);
            index += 1;
        }
        let _ = SetupDiDestroyDeviceInfoList(hdev);
        Ok(changed)
    }
}

/// In-process GPU stack restart: disable all present display adapters, then
/// re-enable (GLOBAL scope). Mirrors `restart.c` Stop/StartDriver minus the
/// CCC/Radeon companion handling (covered by the restart64 fallback).
fn restart_display_stack_inprocess() -> Result<usize, String> {
    let disabled = set_display_adapter_state(false)?;
    if disabled == 0 {
        return Err("In-process restart found 0 display adapters.".to_string());
    }
    thread::sleep(Duration::from_millis(500));
    let enabled = set_display_adapter_state(true)?;
    if enabled == 0 {
        return Err("In-process restart disabled but re-enabled 0 adapters.".to_string());
    }
    Ok(enabled)
}

pub fn restart_driver_stack() -> String {
    // Pure in-process SetupDi (no external binary, no console flash).
    match restart_display_stack_inprocess() {
        Ok(n) => {
            log::info!(
                "[custom_res] in-process driver restart cycled {} adapter(s)",
                n
            );
            thread::sleep(Duration::from_millis(2200));
            format!("Graphics driver restarted ({} adapter(s) cycled).", n)
        }
        Err(e) => {
            log::warn!("[custom_res] in-process restart failed: {}", e);
            format!("In-process driver restart note: {}. Restart PC or run as Administrator if changes are not immediately visible.", e)
        }
    }
}

/// Detects an Intel display adapter (for logging / FakeEDID awareness).
/// Modern Intel (Win10+) honors `EDID_OVERRIDE` like NVIDIA/AMD, so no extra
/// `FakeEDID_*` write is needed â€” `restart64.exe` already handles the legacy
/// Intel `FakeEDID_14_0_af0d_1723` / `ReadEDIDFromRegistry` recovery path on
/// fallback. This keeps one code path for every GPU.
fn intel_adapter_present() -> bool {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let base = "SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";
    let Ok(class_key) = hklm.open_subkey_with_flags(base, KEY_QUERY_VALUE) else {
        return false;
    };
    // Subkeys are 0000, 0001, ... â€” check ProviderName prefix.
    for i in 0..16 {
        let sub = format!("{:04}", i);
        if let Ok(k) = class_key.open_subkey_with_flags(&sub, KEY_QUERY_VALUE) {
            if let Ok(v) = k.get_value::<String, _>("ProviderName") {
                if v.len() >= 5 && v[..5].eq_ignore_ascii_case("Intel") {
                    return true;
                }
            }
            // REG_SZ may come back with different getter; try raw.
            if let Ok(rv) = k.get_raw_value("ProviderName") {
                let s = String::from_utf16_lossy(
                    &rv.bytes
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect::<Vec<_>>(),
                );
                if s.len() >= 5 && s[..5].eq_ignore_ascii_case("Intel") {
                    return true;
                }
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Public flows
// ---------------------------------------------------------------------------

/// Natively clears all custom EDID overrides under HKLM\SYSTEM\CurrentControlSet\Enum\DISPLAY
/// without external reset-all.exe binary.
pub fn reset_all_edid_overrides() -> Result<String, String> {
    if !crate::display::is_process_elevated() {
        return Err(ADMIN_REMOVE_ERR.to_string());
    }
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let display_path = r"SYSTEM\CurrentControlSet\Enum\DISPLAY";
    let Ok(disp_key) = hklm.open_subkey_with_flags(display_path, KEY_QUERY_VALUE) else {
        return Ok("No DISPLAY registry devices found.".to_string());
    };

    let mut removed_count = 0;
    for dev_name in disp_key.enum_keys().filter_map(|k| k.ok()) {
        if let Ok(dev_key) = disp_key.open_subkey_with_flags(&dev_name, KEY_QUERY_VALUE) {
            for inst_name in dev_key.enum_keys().filter_map(|k| k.ok()) {
                if let Ok(true) = delete_override_key(&dev_name, &inst_name) {
                    removed_count += 1;
                }
            }
        }
    }

    let restart_msg = restart_driver_stack();
    Ok(format!(
        "Reset {} custom EDID override(s) to factory defaults. {}",
        removed_count, restart_msg
    ))
}

/// Adds `WxHxHz` as a real driver mode via EDID override + driver restart.
///
/// 1. Validates ranges + even W; requires admin (same UX as device disable).
/// 2. Resolves any UI id to canonical `DISPLAY\<model>\<uid>`; ambiguous
///    duplicates are refused (never patch the wrong panel).
/// 3. Backs up the live EDID per-monitor, patches a single descriptor at
///    offset 54, fixes checksum, writes `EDID_OVERRIDE "0"`.
/// 4. Restarts the GPU stack (in-process SetupDi, fallback restart64.exe),
///    sleeps, re-enumerates, CDS_TESTs again and reports the result.
pub fn add_custom_resolution(monitor_id: &str, w: u32, h: u32, hz: u32) -> Result<String, String> {
    validate_custom_resolution(w, h, hz)?;

    if !crate::display::is_process_elevated() {
        return Err(ADMIN_ADD_ERR.to_string());
    }

    let target = monitor_id.trim();
    if target.is_empty() {
        return Err(
            "Empty monitor identifier. Pass device_id (DISPLAY\\...) or \\\\.\\DISPLAYx."
                .to_string(),
        );
    }
    let Some(pnp) = crate::display::resolve_display_to_instance_id(target) else {
        return Err(format!(
            "Could not resolve '{}' to a unique monitor (DISPLAY\\<model>\\<uid>). With duplicate models, pass the exact device_id from the monitor list â€” refusing to patch the wrong panel.",
            target
        ));
    };
    let (dev, inst) =
        split_pnp(&pnp).ok_or_else(|| format!("Resolved '{}' is not a DISPLAY PnP path.", pnp))?;

    // If the mode already exists, skip the registry write entirely.
    let gdi_hint = if target.len() >= 11 && target[..11].eq_ignore_ascii_case(r"\\.\DISPLAY") {
        Some(target)
    } else {
        None
    };
    let pre = test_display_mode(gdi_hint, w, h, hz);
    if pre.exists {
        return Ok(format!(
            "{}Ã—{} @ {} Hz already exists in the driver list (CDS_TEST ok) â€” no EDID change needed. Use Test to preview it.",
            w, h, hz
        ));
    }

    let live = read_live_edid(&pnp)?;
    if let Some(bp) = backup_path_for(&pnp) {
        // Per-monitor backup (full live EDID, not just block 0) so a manual
        // restore is always possible even without CRU.
        if let Err(e) = std::fs::write(&bp, &live) {
            log::warn!("[custom_res] EDID backup failed for '{}': {}", pnp, e);
        } else {
            log::info!("[custom_res] EDID backup for '{}' -> {}", pnp, bp.display());
        }
    }

    let timing = build_detailed_timing(w, h, hz)?;
    let patched = patch_edid(&live, timing)?;
    write_override(&dev, &inst, &patched)?;

    if intel_adapter_present() {
        // No extra FakeEDID_* write: modern Intel honors EDID_OVERRIDE; the
        // legacy FakeEDID recovery path lives in restart64.exe fallback.
        log::info!("[custom_res] Intel adapter present â€” EDID_OVERRIDE path used (FakeEDID handled by restart fallback if needed)");
    }

    let restart_msg = restart_driver_stack();
    // Give PnP + GDI time to re-enumerate before the post-check.
    thread::sleep(Duration::from_millis(1200));
    crate::gpu::enforce_all_gpu_scaling();
    let post = test_display_mode(gdi_hint, w, h, hz);
    if post.exists {
        Ok(format!(
            "Added {}Ã—{} @ {} Hz on {} (EDID override, backup saved). {}. Driver now lists the mode (CDS_TEST ok) â€” run Test (15s safe) to preview.",
            w, h, hz, pnp, restart_msg
        ))
    } else {
        Ok(format!(
            "Wrote EDID override for {}Ã—{} @ {} Hz on {} (backup saved). {}. Driver does not list it yet (CDS_TEST {}={}) â€” wait ~10s and Test again, or reboot; use Emergency Reset to undo.",
            w,
            h,
            hz,
            pnp,
            restart_msg,
            post.code,
            cds_code_to_text(post.code)
        ))
    }
}

/// Removes this monitor's `EDID_OVERRIDE` (single delete, `reset-all.c`
/// style) + driver restart. Global factory reset stays in
/// `reset_all_cru_overrides`.
pub fn remove_custom_override(monitor_id: &str) -> Result<String, String> {
    if !crate::display::is_process_elevated() {
        return Err(ADMIN_REMOVE_ERR.to_string());
    }
    let target = monitor_id.trim();
    if target.is_empty() {
        return Err("Empty monitor identifier.".to_string());
    }
    let Some(pnp) = crate::display::resolve_display_to_instance_id(target) else {
        return Err(format!(
            "Could not resolve '{}' to a unique monitor â€” refusing to delete the wrong override.",
            target
        ));
    };
    let (dev, inst) =
        split_pnp(&pnp).ok_or_else(|| format!("Resolved '{}' is not a DISPLAY PnP path.", pnp))?;
    let deleted = delete_override_key(&dev, &inst)?;
    let restart_msg = restart_driver_stack();
    thread::sleep(Duration::from_millis(800));
    crate::gpu::enforce_all_gpu_scaling();
    if deleted {
        Ok(format!(
            "Removed EDID override on {} (backup kept in %APPDATA%\\Outpeek). {}.",
            pnp, restart_msg
        ))
    } else {
        Ok(format!(
            "No EDID override found on {} (already factory). {}.",
            pnp, restart_msg
        ))
    }
}
