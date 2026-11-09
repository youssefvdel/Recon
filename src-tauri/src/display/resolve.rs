#![allow(dead_code)]
//! (moved verbatim from `display.rs`; split only, behaviour unchanged.)

use super::monitors::{
    candidates_matching_model, collect_monitor_candidates, format_candidates_for_error,
    MonitorCandidate,
};
use super::registry::{
    find_display_name_for_gdi_id, get_monitor_hardware_id, is_gdi_display_name, is_gdi_monitor_id,
    is_pnp_monitor_instance, model_from_instance_path, pnp_instance_from_monitor_device_path,
    setupdi_instance_id, setupdi_is_disabled,
};
use windows::core::PCWSTR;
use windows::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
    DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SOURCE_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME, QDC_ALL_PATHS,
    QDC_DATABASE_CURRENT, QDC_ONLY_ACTIVE_PATHS,
};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, DIGCF_ALLCLASSES,
    DIGCF_PRESENT, GUID_DEVCLASS_MONITOR, SETUP_DI_GET_CLASS_DEVS_FLAGS, SP_DEVINFO_DATA,
};

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
pub(super) fn resolve_to_pnp_instance(target: &str) -> Option<String> {
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
pub(super) fn enumerate_monitor_devnodes(
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
pub(super) fn get_monitor_disabled_map() -> std::collections::HashMap<String, (String, bool)> {
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

pub(super) fn friendly_name_from_instance_id(instance_id: &str, fallback: &str) -> String {
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
