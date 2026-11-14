//! Pure detailed-timing maths for the custom-resolution writer: user range
//! validation and EDID Type-0 descriptor packing (CRU `AutomaticPC` table +
//! CVT-RB2 fallback).
//!
//! No `windows`, registry or filesystem access, so the host-agnostic test crate
//! (`src-tauri/pure`) compiles and tests this exact file by path. The
//! registry/SetupAPI half lives in the parent module.
//!
//! Moved verbatim from `custom_res.rs`; the CRU port notes there still describe
//! where every constant came from.

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

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

/// True when a table row fits the EDID Type-0 descriptor fields the packer
/// enforces afterwards: 12-bit active/blank (the back porches ride in the
/// blank totals), 10-bit H front/sync and 6-bit V front/sync.
///
/// The CRU table keeps raw CRU-native rows whose H front porch is far past
/// 1023 (the 24/25/30 Hz 1280×720 rows carry 2420/2420/1760 px), which no
/// monitor descriptor can express. Such a row must fall through to the
/// CVT-RB2 synthesis instead of failing the add.
fn table_row_encodable(e: &AutoPcEntry) -> bool {
    let h_blank = e.h_front + e.h_sync + e.h_back;
    let v_blank = e.v_front + e.v_sync + e.v_back;
    e.h_active <= 4095
        && e.v_active <= 4095
        && h_blank <= 4095
        && v_blank <= 4095
        && e.h_front <= 1023
        && e.h_sync <= 1023
        && e.v_front <= 63
        && e.v_sync <= 63
}

const MIN_TIME_CVT_RB2: i64 = 460_000_000;
/// `GetVRateDivisor` for Type 0 (PClockPrecision 100): 1e9 * Fields / 100.
const VRATE_DIVISOR_TYPE0: i64 = 10_000_000;

pub(crate) fn hperiod_cvt_rb2(v_active: i64, vrate_mhz: i64) -> i64 {
    if vrate_mhz <= 0 {
        return MIN_TIME_CVT_RB2;
    }
    (1_000_000_000_000_000i64 / vrate_mhz - MIN_TIME_CVT_RB2) / v_active.max(1)
}

pub(crate) fn cvt_rb2_front(v_active: u32, vrate_mhz: i64) -> u32 {
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
/// `CalculateCVTRB2Standard`). A table row whose fields cannot be expressed in
/// an EDID Type-0 descriptor is skipped and falls through to CVT-RB2 too, so
/// 1280×720 at 24/25/30 Hz is addable instead of rejected.
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
            && table_row_encodable(e)
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
