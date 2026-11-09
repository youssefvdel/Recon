#![allow(dead_code)]
//! (moved verbatim from `display.rs`; split only, behaviour unchanged.)

use super::registry::{
    is_gdi_monitor_id, is_pnp_monitor_instance, model_from_instance_path, setupdi_instance_id,
    setupdi_is_disabled, setupdi_reg_multi_sz, setupdi_reg_sz,
};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, DIGCF_ALLCLASSES,
    DIGCF_PRESENT, GUID_DEVCLASS_MONITOR, SETUP_DI_GET_CLASS_DEVS_FLAGS, SPDRP_DEVICEDESC,
    SPDRP_FRIENDLYNAME, SPDRP_HARDWAREID, SP_DEVINFO_DATA,
};

#[derive(Clone, Debug)]
pub(super) struct MonitorCandidate {
    pub(super) instance_id: String,
    pub(super) lower: String,
    pub(super) model_upper: Option<String>,
    pub(super) hw_ids: Vec<String>,
    pub(super) friendly: String,
    pub(super) desc: String,
    pub(super) disabled: bool,
}

/// Enumerates MONITOR-class devnodes (instance paths are `DISPLAY\...`) with
/// hardware ids + friendly names. Merges PRESENT first then all devnodes
/// (flags 0) so disabled/ghosted panels stay resolvable for re-enable.
pub(super) fn collect_monitor_candidates() -> Vec<MonitorCandidate> {
    let mut map: std::collections::HashMap<String, MonitorCandidate> =
        std::collections::HashMap::new();
    for flags in [DIGCF_PRESENT, SETUP_DI_GET_CLASS_DEVS_FLAGS(0)] {
        unsafe {
            let hdev = match SetupDiGetClassDevsW(Some(&GUID_DEVCLASS_MONITOR), None, None, flags) {
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

pub(super) fn candidates_matching_model<'a>(
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
                    h.eq_ignore_ascii_case(model_upper) || h.to_uppercase().contains(model_upper)
                }
            })
        })
        .collect()
}

pub(super) fn format_candidates_for_error(candidates: &[MonitorCandidate]) -> String {
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
