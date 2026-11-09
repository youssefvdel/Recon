#![allow(dead_code)]
//! (moved verbatim from `display.rs`; split only, behaviour unchanged.)

use super::mode::{get_all_supported_modes, get_primary_device_name};
use windows::core::PCWSTR;
use windows::Win32::Devices::Display::{
    GetDisplayConfigBufferSizes, QueryDisplayConfig, SetDisplayConfig, DISPLAYCONFIG_MODE_INFO,
    DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SCALING_ASPECTRATIOCENTEREDMAX,
    DISPLAYCONFIG_SCALING_STRETCHED, QDC_ONLY_ACTIVE_PATHS, SDC_ALLOW_CHANGES, SDC_APPLY,
    SDC_SAVE_TO_DATABASE, SDC_USE_SUPPLIED_DISPLAY_CONFIG,
};
use windows::Win32::Graphics::Gdi::{
    ChangeDisplaySettingsExW, ChangeDisplaySettingsW, EnumDisplaySettingsW, CDS_NORESET, CDS_TEST,
    CDS_TYPE, CDS_UPDATEREGISTRY, DEVMODEW, DM_BITSPERPEL, DM_DISPLAYFLAGS, DM_DISPLAYFREQUENCY,
    DM_DISPLAYORIENTATION, DM_PELSHEIGHT, DM_PELSWIDTH, DM_POSITION, ENUM_CURRENT_SETTINGS,
};

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
pub(super) fn cds_test_preflight(
    dev_name_u16: &[u16],
    width: u32,
    height: u32,
    refresh_rate: u32,
) -> (bool, i32) {
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
pub(super) fn badmode_friendly_message(
    width: u32,
    height: u32,
    refresh_rate: u32,
    test_code: i32,
) -> String {
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
        format!(" No {}x{} mode at any refresh rate yet.", width, height)
    } else if unique_rates.contains(&refresh_rate) {
        // Should not happen when preflight just failed, but keep it sane.
        format!(
            " Driver lists {}x{} at: {}Hz.",
            width,
            height,
            unique_rates
                .iter()
                .map(|r| r.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )
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
            return Err(badmode_friendly_message(
                width,
                height,
                refresh_rate,
                test_code,
            ));
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
        let buf_err =
            GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count);
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
        let buf_err =
            GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count);
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

                let flags = SDC_APPLY
                    | SDC_SAVE_TO_DATABASE
                    | SDC_ALLOW_CHANGES
                    | SDC_USE_SUPPLIED_DISPLAY_CONFIG;
                let set_err = SetDisplayConfig(Some(&paths), Some(&modes), flags);

                // WDDM `Scaling` values (Microsoft/Intel doc, CRU forum):
                //   2 = centre image, 3 = scale full screen, 4 = maintain aspect.
                // Stretched MUST be 3 — this used to write 4, i.e. it asked for
                // pillar/letterbox bars while labelling itself "0 Black Bars",
                // which is why the toggle looked like it did nothing.
                let reg_val = crate::gpu::wddm_scaling_value(stretched);
                // Pure in-process native winreg update (zero powershell / console flash, instant < 1ms)
                let hklm = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE);
                if let Ok(config_root) = hklm.open_subkey_with_flags(
                    r"SYSTEM\CurrentControlSet\Control\GraphicsDrivers\Configuration",
                    winreg::enums::KEY_READ | winreg::enums::KEY_SET_VALUE,
                ) {
                    fn set_scaling_subkeys(key: &winreg::RegKey, val: u32) {
                        let _ = key.set_value("Scaling", &val);
                        for sub in key.enum_keys().filter_map(|k| k.ok()) {
                            if let Ok(sub_key) = key.open_subkey_with_flags(
                                &sub,
                                winreg::enums::KEY_READ | winreg::enums::KEY_SET_VALUE,
                            ) {
                                set_scaling_subkeys(&sub_key, val);
                            }
                        }
                    }
                    set_scaling_subkeys(&config_root, reg_val);
                }

                if set_err == 0 {
                    return Ok(format!(
                        "{} applied to {} display path(s)",
                        if stretched {
                            "Full-Screen Stretched (0 Black Bars)"
                        } else {
                            "Aspect Ratio (Pillarboxes)"
                        },
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
