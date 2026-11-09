#![allow(dead_code)]
//! (moved verbatim from `display.rs`; split only, behaviour unchanged.)

use super::monitors::{
    candidates_matching_model, collect_monitor_candidates, format_candidates_for_error,
};
use super::registry::{
    get_monitor_hardware_id, is_gdi_display_name, is_gdi_monitor_id, is_pnp_monitor_instance,
    is_process_elevated, model_from_instance_path, setupdi_instance_id,
};
use super::report::{get_all_monitors, MonitorDevice};
use super::resolve::{resolve_display_to_instance_id, resolve_to_pnp_instance};
use std::thread;
use std::time::Duration;
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiCallClassInstaller, SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo,
    SetupDiGetClassDevsW, SetupDiGetDeviceInstallParamsW, SetupDiSetClassInstallParamsW,
    DICS_DISABLE, DICS_ENABLE, DICS_FLAG_CONFIGSPECIFIC, DIF_PROPERTYCHANGE, DIGCF_ALLCLASSES,
    DIGCF_PRESENT, DI_NEEDREBOOT, GUID_DEVCLASS_MONITOR, SETUP_DI_GET_CLASS_DEVS_FLAGS,
    SP_CLASSINSTALL_HEADER, SP_DEVINFO_DATA, SP_DEVINSTALL_PARAMS_W, SP_PROPCHANGE_PARAMS,
};

/// Returns true when the devnode currently needs a reboot to complete a
/// property change (DI_NEEDREBOOT in its install params).
pub(super) fn setupdi_needs_reboot<H>(hdev: H, devinfo: &SP_DEVINFO_DATA) -> bool
where
    H: windows::core::Param<windows::Win32::Devices::DeviceAndDriverInstallation::HDEVINFO> + Copy,
{
    unsafe {
        let mut params = SP_DEVINSTALL_PARAMS_W {
            cbSize: std::mem::size_of::<SP_DEVINSTALL_PARAMS_W>() as u32,
            ..Default::default()
        };
        if SetupDiGetDeviceInstallParamsW(
            hdev,
            Some(devinfo as *const SP_DEVINFO_DATA),
            &mut params,
        )
        .is_ok()
        {
            return (params.Flags.0 & DI_NEEDREBOOT.0) != 0;
        }
    }
    false
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
            "Requires admin: run Recon as administrator to enable/disable monitor devices in Device Manager.".to_string(),
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
                    format!(
                        " Model '{}' matched {} MONITOR-class candidate(s).",
                        m,
                        hits.len()
                    )
                })
                .unwrap_or_default();
            format!(
                "GDI id '{}' is not a PnP path and could not be bridged to a unique MONITOR devnode (DISPLAY\\<model>\\<uid>).{}. Pass the canonical device_id (DISPLAY\\...) shown in the monitor list.",
                target, model_note
            )
        } else {
            format!("Identifier '{}' matched no MONITOR-class devnode.", target)
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
                        if enabled {
                            "DICS_ENABLE"
                        } else {
                            "DICS_DISABLE"
                        },
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
                        Some(&params.ClassInstallHeader as *const SP_CLASSINSTALL_HEADER),
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
                                "Requires admin: run Recon as administrator to enable/disable monitor devices in Device Manager."
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
                                        "Requires admin: run Recon as administrator to enable/disable monitor devices in Device Manager."
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
    thread::sleep(Duration::from_millis(
        needs_reboot.then_some(800).unwrap_or(500),
    ));
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
