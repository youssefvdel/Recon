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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

pub const ADMIN_ADD_ERR: &str = "Requires admin: run Recon as administrator to add custom resolutions (EDID override needs elevated registry write).";
pub const ADMIN_REMOVE_ERR: &str = "Requires admin: run Recon as administrator to remove EDID overrides (needs elevated registry write).";

pub fn validate_custom_resolution(w: u32, h: u32, hz: u32) -> Result<(), String> {
    if w < 640 || w > 7680 {
        return Err(format!("Width {} out of range (640â€“7680).", w));
    }
    if h < 480 || h > 4320 {
        return Err(format!("Height {} out of range (480â€“4320).", h));
    }
    if hz < 23 || hz > 500 {
        return Err(format!("Refresh rate {} out of range (23â€“500 Hz).", hz));
    }
    if w % 2 != 0 {
        return Err(format!(
            "Width {} must be even (EDID detailed timing requires even pixels).",
            w
        ));
    }
    if h % 2 != 0 {
        return Err(format!("Height {} must be even.", h));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Detailed timing (CRU port)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct AutoPcEntry {
    h_active: u32,
    v_active: u32,
    interlaced: u32,
    min_vrate: i64,
    max_vrate: i64,
    h_front: u32,
    h_sync: u32,
    h_back: u32,
    v_front: u32,
    v_sync: u32,
    v_back: u32,
    h_pol: bool,
    v_pol: bool,
}

/// Verbatim port of `DetailedResolutionClass::AutomaticPC` (CRU).
const AUTOMATIC_PC: &[AutoPcEntry] = &[
    AutoPcEntry {
        h_active: 1920,
        v_active: 1080,
        interlaced: 0,
        min_vrate: 59500,
        max_vrate: 60500,
        h_front: 88,
        h_sync: 44,
        h_back: 148,
        v_front: 4,
        v_sync: 5,
        v_back: 36,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1920,
        v_active: 1080,
        interlaced: 0,
        min_vrate: 49500,
        max_vrate: 50500,
        h_front: 528,
        h_sync: 44,
        h_back: 148,
        v_front: 4,
        v_sync: 5,
        v_back: 36,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1920,
        v_active: 1080,
        interlaced: 0,
        min_vrate: 47500,
        max_vrate: 48500,
        h_front: 638,
        h_sync: 44,
        h_back: 148,
        v_front: 4,
        v_sync: 5,
        v_back: 36,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1920,
        v_active: 1080,
        interlaced: 0,
        min_vrate: 29500,
        max_vrate: 30500,
        h_front: 88,
        h_sync: 44,
        h_back: 148,
        v_front: 4,
        v_sync: 5,
        v_back: 36,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1920,
        v_active: 1080,
        interlaced: 0,
        min_vrate: 24500,
        max_vrate: 25500,
        h_front: 528,
        h_sync: 44,
        h_back: 148,
        v_front: 4,
        v_sync: 5,
        v_back: 36,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1920,
        v_active: 1080,
        interlaced: 0,
        min_vrate: 23500,
        max_vrate: 24500,
        h_front: 638,
        h_sync: 44,
        h_back: 148,
        v_front: 4,
        v_sync: 5,
        v_back: 36,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1920,
        v_active: 1080,
        interlaced: 1,
        min_vrate: 59500,
        max_vrate: 60500,
        h_front: 88,
        h_sync: 44,
        h_back: 148,
        v_front: 4,
        v_sync: 10,
        v_back: 31,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1920,
        v_active: 1080,
        interlaced: 1,
        min_vrate: 49500,
        max_vrate: 50500,
        h_front: 528,
        h_sync: 44,
        h_back: 148,
        v_front: 4,
        v_sync: 10,
        v_back: 31,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1600,
        v_active: 900,
        interlaced: 0,
        min_vrate: 59500,
        max_vrate: 60500,
        h_front: 24,
        h_sync: 80,
        h_back: 96,
        v_front: 1,
        v_sync: 3,
        v_back: 96,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1366,
        v_active: 768,
        interlaced: 0,
        min_vrate: 59500,
        max_vrate: 60500,
        h_front: 70,
        h_sync: 143,
        h_back: 213,
        v_front: 3,
        v_sync: 3,
        v_back: 24,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1360,
        v_active: 768,
        interlaced: 0,
        min_vrate: 59500,
        max_vrate: 60500,
        h_front: 64,
        h_sync: 112,
        h_back: 256,
        v_front: 3,
        v_sync: 6,
        v_back: 18,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1280,
        v_active: 720,
        interlaced: 0,
        min_vrate: 59500,
        max_vrate: 60500,
        h_front: 110,
        h_sync: 40,
        h_back: 220,
        v_front: 5,
        v_sync: 5,
        v_back: 20,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1280,
        v_active: 720,
        interlaced: 0,
        min_vrate: 49500,
        max_vrate: 50500,
        h_front: 440,
        h_sync: 40,
        h_back: 220,
        v_front: 5,
        v_sync: 5,
        v_back: 20,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1280,
        v_active: 720,
        interlaced: 0,
        min_vrate: 47500,
        max_vrate: 48500,
        h_front: 960,
        h_sync: 40,
        h_back: 220,
        v_front: 5,
        v_sync: 5,
        v_back: 20,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1280,
        v_active: 720,
        interlaced: 0,
        min_vrate: 29500,
        max_vrate: 30500,
        h_front: 1760,
        h_sync: 40,
        h_back: 220,
        v_front: 5,
        v_sync: 5,
        v_back: 20,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1280,
        v_active: 720,
        interlaced: 0,
        min_vrate: 24500,
        max_vrate: 25500,
        h_front: 2420,
        h_sync: 40,
        h_back: 220,
        v_front: 5,
        v_sync: 5,
        v_back: 20,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1280,
        v_active: 720,
        interlaced: 0,
        min_vrate: 23500,
        max_vrate: 24500,
        h_front: 1760,
        h_sync: 40,
        h_back: 220,
        v_front: 5,
        v_sync: 5,
        v_back: 20,
        h_pol: true,
        v_pol: true,
    },
    AutoPcEntry {
        h_active: 1440,
        v_active: 576,
        interlaced: 1,
        min_vrate: 49500,
        max_vrate: 50500,
        h_front: 24,
        h_sync: 126,
        h_back: 138,
        v_front: 4,
        v_sync: 6,
        v_back: 39,
        h_pol: false,
        v_pol: false,
    },
    AutoPcEntry {
        h_active: 1440,
        v_active: 480,
        interlaced: 1,
        min_vrate: 59500,
        max_vrate: 60500,
        h_front: 38,
        h_sync: 124,
        h_back: 114,
        v_front: 8,
        v_sync: 6,
        v_back: 31,
        h_pol: false,
        v_pol: false,
    },
    AutoPcEntry {
        h_active: 720,
        v_active: 576,
        interlaced: 0,
        min_vrate: 49500,
        max_vrate: 50500,
        h_front: 12,
        h_sync: 64,
        h_back: 68,
        v_front: 5,
        v_sync: 5,
        v_back: 39,
        h_pol: false,
        v_pol: false,
    },
    AutoPcEntry {
        h_active: 720,
        v_active: 480,
        interlaced: 0,
        min_vrate: 59500,
        max_vrate: 60500,
        h_front: 16,
        h_sync: 62,
        h_back: 60,
        v_front: 9,
        v_sync: 6,
        v_back: 30,
        h_pol: false,
        v_pol: false,
    },
    AutoPcEntry {
        h_active: 640,
        v_active: 480,
        interlaced: 0,
        min_vrate: 59500,
        max_vrate: 60500,
        h_front: 16,
        h_sync: 96,
        h_back: 48,
        v_front: 10,
        v_sync: 2,
        v_back: 33,
        h_pol: false,
        v_pol: false,
    },
];

const MIN_TIME_CVT_RB2: i64 = 460_000_000;
/// `GetVRateDivisor` for Type 0 (PClockPrecision 100): 1e9 * Fields / 100.
const VRATE_DIVISOR_TYPE0: i64 = 10_000_000;

fn hperiod_cvt_rb2(v_active: i64, vrate_mhz: i64) -> i64 {
    if vrate_mhz <= 0 {
        return MIN_TIME_CVT_RB2;
    }
    (1_000_000_000_000_000i64 / vrate_mhz - MIN_TIME_CVT_RB2) / v_active.max(1)
}

fn cvt_rb2_front(v_active: u32, vrate_mhz: i64) -> u32 {
    const V_SYNC: i64 = 8;
    const V_BACK: i64 = 6;
    let hperiod = hperiod_cvt_rb2(v_active as i64, vrate_mhz);
    if hperiod <= 0 {
        return 1;
    }
    let v_blank = MIN_TIME_CVT_RB2 / hperiod + 1;
    let mut v_front = v_blank - V_SYNC - V_BACK;
    if v_front < 1 {
        v_front = 1;
    }
    v_front as u32
}

/// Builds an 18-byte EDID detailed timing descriptor (Type 0, progressive).
///
/// Strategy mirrors CRU `CalculateAutomaticPC` â†’ `CalculateCVTRB2Standard`:
/// exact AutomaticPC table hit first (nearest for known CEA modes), else
/// CVT-RB2 with a second pass on the actual refresh (like CRU's double-pass
/// `CalculateCVTRB2Standard`).
pub fn build_detailed_timing(w: u32, h: u32, hz: u32) -> Result<[u8; 18], String> {
    validate_custom_resolution(w, h, hz)?;
    let vrate: i64 = hz as i64 * 1000;

    // (a) AutomaticPC exact hit.
    let (
        h_front,
        h_sync,
        h_back,
        mut v_front,
        v_sync,
        v_back,
        h_pol,
        v_pol,
        pclock,
        h_total,
        mut v_total,
    ): (u32, u32, u32, u32, u32, u32, bool, bool, i64, i64, i64);

    if let Some(hit) = AUTOMATIC_PC.iter().find(|e| {
        e.h_active == w
            && e.v_active == h
            && e.interlaced == 0
            && vrate >= e.min_vrate
            && vrate <= e.max_vrate
    }) {
        h_front = hit.h_front;
        h_sync = hit.h_sync;
        h_back = hit.h_back;
        v_front = hit.v_front;
        v_sync = hit.v_sync;
        v_back = hit.v_back;
        h_pol = hit.h_pol;
        v_pol = hit.v_pol;
        let h_blank = (h_front + h_sync + h_back) as i64;
        h_total = w as i64 + h_blank;
        let v_blank = (v_front + v_sync + v_back) as i64;
        v_total = h as i64 + v_blank;
        // CRU `CalculateActualPClockForCVTRB`: quantize to 25 (PClockPrecision/4).
        let raw = vrate * h_total * v_total / VRATE_DIVISOR_TYPE0;
        pclock = raw / 25 * 25;
    } else {
        // (b) CVT-RB2 fallback with CRU-style second pass on actual rate.
        h_pol = true;
        v_pol = false;
        const H_FRONT: u32 = 8;
        const H_SYNC: u32 = 32;
        const H_BACK: u32 = 40;
        const V_SYNC: u32 = 8;
        const V_BACK: u32 = 6;
        h_front = H_FRONT;
        h_sync = H_SYNC;
        h_back = H_BACK;
        v_sync = V_SYNC;
        v_back = V_BACK;

        let h_blank = (H_FRONT + H_SYNC + H_BACK) as i64;
        h_total = w as i64 + h_blank;
        // Pass 1 with requested rate.
        v_front = cvt_rb2_front(h, vrate);
        v_total = h as i64 + (v_front + V_SYNC + V_BACK) as i64;
        // CRU `CalculateActualPClockForCVTRB2`: no quantization.
        let pc1 = vrate * h_total * v_total / VRATE_DIVISOR_TYPE0;
        // Pass 2 with actual rate (mirrors CalculateCVTRB2Standard re-calc).
        let actual_vrate = if h_total > 0 && v_total > 0 && pc1 > 0 {
            pc1 * VRATE_DIVISOR_TYPE0 / h_total / v_total
        } else {
            vrate
        };
        v_front = cvt_rb2_front(h, actual_vrate);
        v_total = h as i64 + (v_front + V_SYNC + V_BACK) as i64;
        // Final pclock from requested rate over final totals keeps the nominal
        // Hz exact while preserving RB2 blanking (CRU-compatible envelope).
        pclock = vrate * h_total * v_total / VRATE_DIVISOR_TYPE0;
    }

    let (pclock, total_v_blank, vf_raw) = if pclock > 65535 {
        // High refresh rate (e.g. 240Hz, 260Hz, 360Hz) exceeds 16-bit DTD limit (655.35 MHz).
        // Standard 128-byte base EDID descriptors cannot exceed 655.35 MHz in the 16-bit clock field.
        // We calculate the maximum standard refresh rate timing that fits under 655.35 MHz (e.g. 144Hz/165Hz)
        // so the panel recognizes the aspect ratio & resolution geometry,
        // while the GPU driver mode table (NV_Modes / GPU Scaling) provides the full native 260Hz output!
        let max_safe_vrate = ((65000i64 * VRATE_DIVISOR_TYPE0) / (h_total * v_total)).max(60000);
        let vf = cvt_rb2_front(h, max_safe_vrate);
        let total_vb = (vf + v_sync + v_back) as u32;
        let vt = h as i64 + total_vb as i64;
        let pc = (max_safe_vrate * h_total * vt / VRATE_DIVISOR_TYPE0).min(65535);
        (pc, total_vb, vf)
    } else {
        let total_vb = (v_front + v_sync + v_back) as u32;
        (pclock, total_vb, v_front)
    };

    if pclock <= 0 || pclock > 65535 {
        return Err(format!(
            "Invalid pixel clock calculated ({:.2} MHz) for {}Ã—{} @ {} Hz.",
            pclock as f64 / 100.0,
            w,
            h,
            hz
        ));
    }
    let h_blank = h_front + h_sync + h_back;
    let v_blank = total_v_blank;

    // EDID Type-0 field widths: H/V active+blank 12b, H front/sync 10b, V front/sync 6b.
    // In CVT-RB2, at high refresh rates (>= 144Hz), the standard CVT-RB2 formula dumps
    // the variable vertical blanking into VFront. Because EDID Type-0 only allocates 6 bits
    // for VFront (max 63 lines), any VFront > 63 cannot physically be encoded.
    // We clamp VFront to a standard VESA offset (8 lines) while preserving the full 12-bit VBlank.
    // The display controller reconstructs VBack = VBlank - VFront - VSync, preserving 100% exact
    // frame geometry, pixel clock, and refresh rate.
    let v_front = if vf_raw > 63 {
        8.min(v_blank.saturating_sub(10))
    } else {
        vf_raw
    };
    let v_sync = if v_sync > 63 { 8 } else { v_sync };

    if w > 4095 || h_blank > 4095 || h > 4095 || v_blank > 4095 {
        return Err("Timing exceeds EDID 12-bit active/blank limits.".to_string());
    }
    if h_front > 1023 || h_sync > 1023 {
        return Err("Horizontal front/sync exceed EDID 10-bit limits.".to_string());
    }
    if v_front > 63 || v_sync > 63 {
        return Err("Vertical front/sync exceed EDID 6-bit limits.".to_string());
    }

    // Pack exactly like `DetailedResolutionClass::Write` Type 0.
    let mut d = [0u8; 18];
    let pc = pclock as u32;
    let ha = w;
    let hb = h_blank;
    let va = h;
    let vb = v_blank;
    d[0] = (pc & 0xFF) as u8;
    d[1] = ((pc >> 8) & 0xFF) as u8;
    d[2] = (ha & 0xFF) as u8;
    d[3] = (hb & 0xFF) as u8;
    d[4] = ((((ha & 0xF00) >> 4) | ((hb & 0xF00) >> 8)) & 0xFF) as u8;
    d[5] = (va & 0xFF) as u8;
    d[6] = (vb & 0xFF) as u8;
    d[7] = ((((va & 0xF00) >> 4) | ((vb & 0xF00) >> 8)) & 0xFF) as u8;
    d[8] = (h_front & 0xFF) as u8;
    d[9] = (h_sync & 0xFF) as u8;
    d[10] = (((v_front & 0xF) << 4) | (v_sync & 0xF)) as u8;
    d[11] = ((((h_front & 0x300) >> 2)
        | ((h_sync & 0x300) >> 4)
        | ((v_front & 0x30) >> 2)
        | ((v_sync & 0x30) >> 4))
        & 0xFF) as u8;
    d[12] = ((ha >> 2) & 0xFF) as u8;
    d[13] = ((va >> 2) & 0xFF) as u8;
    d[14] = ((((ha >> 2) & 0xF00) >> 4) | (((va >> 2) & 0xF00) >> 8)) as u8;
    d[15] = 0;
    d[16] = 0;
    d[17] = (if h_pol { 2 } else { 0 }) | (if v_pol { 4 } else { 0 }) | 8 | 16;
    Ok(d)
}

// ---------------------------------------------------------------------------
// EDID registry helpers (HKLM\...\DISPLAY\<dev>\<inst>\Device Parameters)
// ---------------------------------------------------------------------------

fn split_pnp(pnp: &str) -> Option<(String, String)> {
    let t = pnp.trim();
    // Expect DISPLAY\<device>\<instance...>
    let mut parts = t.split('\\');
    let enum_name = parts.next()?.trim();
    if !enum_name.eq_ignore_ascii_case("DISPLAY") {
        return None;
    }
    let dev = parts.next()?.trim().to_string();
    if dev.is_empty() {
        return None;
    }
    let rest: Vec<&str> = parts.collect();
    if rest.is_empty() {
        return None;
    }
    let inst = rest.join("\\").trim().to_string();
    if inst.is_empty() {
        return None;
    }
    Some((dev, inst))
}

fn device_params_path(dev: &str, inst: &str) -> String {
    format!(
        "SYSTEM\\CurrentControlSet\\Enum\\DISPLAY\\{}\\{}\\Device Parameters",
        dev, inst
    )
}

fn override_path(dev: &str, inst: &str) -> String {
    format!("{}\\EDID_OVERRIDE", device_params_path(dev, inst))
}

fn is_valid_edid(edid: &[u8]) -> bool {
    edid.len() >= 128
        && edid[0] == 0x00
        && edid[1] == 0xFF
        && edid[2] == 0xFF
        && edid[3] == 0xFF
        && edid[4] == 0xFF
        && edid[5] == 0xFF
        && edid[6] == 0xFF
        && edid[7] == 0x00
}

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

/// Minimal single-descriptor patch: copy 128B base, overwrite the first
/// detailed descriptor at offset 54, fix checksum byte 127.
pub fn patch_edid(base: &[u8], timing: [u8; 18]) -> Result<[u8; 128], String> {
    if base.len() < 128 {
        return Err("Base EDID shorter than 128 bytes.".to_string());
    }
    if !is_valid_edid(base) {
        return Err("Base EDID header invalid.".to_string());
    }
    let mut out = [0u8; 128];
    out.copy_from_slice(&base[..128]);
    out[54..72].copy_from_slice(&timing);
    // Fix checksum: sum of all 128 bytes must be 0 mod 256.
    let sum: u32 = out[..127].iter().map(|b| *b as u32).sum();
    out[127] = ((256 - (sum % 256)) % 256) as u8;
    Ok(out)
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
            "Removed EDID override on {} (backup kept in %APPDATA%\\Recon). {}.",
            pnp, restart_msg
        ))
    } else {
        Ok(format!(
            "No EDID override found on {} (already factory). {}.",
            pnp, restart_msg
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_res() {
        assert!(validate_custom_resolution(1920, 1080, 144).is_ok());
        assert!(validate_custom_resolution(2090, 1440, 240).is_ok());
        assert!(validate_custom_resolution(100, 1080, 144).is_err());
        assert!(validate_custom_resolution(1920, 100, 144).is_err());
        assert!(validate_custom_resolution(10000, 1080, 144).is_err());
        assert!(validate_custom_resolution(1921, 1080, 144).is_err()); // odd width
    }

    #[test]
    fn test_build_type0_high_hz() {
        for hz in [60, 75, 120, 144, 165, 240, 260, 360] {
            let desc_1440 = build_detailed_timing(2090, 1440, hz);
            assert!(
                desc_1440.is_ok(),
                "1440p @ {}Hz failed: {:?}",
                hz,
                desc_1440.err()
            );
            let desc_1080 = build_detailed_timing(1568, 1080, hz);
            assert!(
                desc_1080.is_ok(),
                "1080p @ {}Hz failed: {:?}",
                hz,
                desc_1080.err()
            );
        }
    }
}
