#![allow(dead_code)]
//! (moved verbatim from `display.rs`; split only, behaviour unchanged.)

use super::monitors::{candidates_matching_model, collect_monitor_candidates, MonitorCandidate};
use super::registry::{model_from_instance_path, ENUM_REGISTRY_SETTINGS};
use super::resolution_cache::CachedRes;
use super::resolution_cache::{load_monitor_res_cache, save_monitor_res_cache};
use super::resolve::{
    friendly_name_from_instance_id, get_monitor_disabled_map, resolve_display_gdi_to_pnp,
};
use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    EnumDisplayDevicesW, EnumDisplaySettingsW, DEVMODEW, DISPLAY_DEVICEW, ENUM_CURRENT_SETTINGS,
};

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct MonitorDevice {
    pub device_name: String,
    pub adapter_name: String,
    pub monitor_name: String,
    pub is_attached: bool,
    pub is_primary: bool,
    pub width: u32,
    pub height: u32,
    pub refresh_rate: u32,
    pub position_x: i32,
    pub position_y: i32,
    pub orientation: String,
    /// PnP instance path, e.g. `MONITOR\PHLC401\{...}\0001`. Empty if unresolvable.
    #[serde(default)]
    pub device_id: String,
    /// True when the monitor devnode is disabled in Device Manager (SetupDi
    /// `CONFIGFLAG_DISABLED`). Distinct from `is_attached` (CCD topology).
    #[serde(default)]
    pub is_device_disabled: bool,
}

pub fn get_all_monitors() -> Vec<MonitorDevice> {
    const FLAG_ATTACHED: u32 = 0x00000001;
    const FLAG_PRIMARY: u32 = 0x00000004;

    let disabled_map = get_monitor_disabled_map();
    // Rich candidates (hw ids + friendly names) for the GDI->PnP bridge and
    // single-model fallback. Collected once so per-DISPLAYx joins don't
    // re-enumerate SetupDi.
    let candidates = collect_monitor_candidates();
    // Lowercase PnP -> candidate index for O(1) bridge lookups.
    let candidate_by_lower: std::collections::HashMap<&str, &MonitorCandidate> =
        candidates.iter().map(|c| (c.lower.as_str(), c)).collect();
    let mut seen_instance_ids = std::collections::HashSet::new();
    // Last-known resolutions so disabled monitors keep real w/h for aspect ratio.
    let mut res_cache = load_monitor_res_cache();
    let mut res_cache_dirty = false;

    let mut monitors = Vec::new();
    let mut i = 0u32;
    loop {
        let mut dd = DISPLAY_DEVICEW {
            cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        let ok = unsafe { EnumDisplayDevicesW(None, i, &mut dd, 0).as_bool() };
        if !ok {
            break;
        }

        let adapter_name = String::from_utf16_lossy(&dd.DeviceString)
            .trim_matches(char::from(0))
            .to_string();
        let device_name = String::from_utf16_lossy(&dd.DeviceName)
            .trim_matches(char::from(0))
            .to_string();
        let is_attached = (dd.StateFlags & FLAG_ATTACHED) != 0;
        let is_primary = (dd.StateFlags & FLAG_PRIMARY) != 0;

        let dev_name_u16: Vec<u16> = format!("{}\0", device_name).encode_utf16().collect();
        let mut mon_dd = DISPLAY_DEVICEW {
            cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        let mut monitor_name = "Generic Display".to_string();
        let mut raw_device_id = String::new();
        unsafe {
            if EnumDisplayDevicesW(PCWSTR(dev_name_u16.as_ptr()), 0, &mut mon_dd, 0).as_bool() {
                let mon_str = String::from_utf16_lossy(&mon_dd.DeviceString)
                    .trim_matches(char::from(0))
                    .to_string();
                let mon_id = String::from_utf16_lossy(&mon_dd.DeviceID)
                    .trim_matches(char::from(0))
                    .to_string();
                raw_device_id = mon_id.clone();
                if !mon_str.is_empty() && mon_str != "Generic PnP Monitor" {
                    monitor_name = mon_str;
                } else if !mon_id.is_empty() {
                    // Extract model code from MONITOR\PHLC401\...
                    let parts: Vec<&str> = mon_id.split('\\').collect();
                    if parts.len() > 1 {
                        monitor_name = format!("Monitor ({})", parts[1]);
                    } else {
                        monitor_name = mon_str;
                    }
                }
            }
        }

        // Join GDI MONITOR\... with the SetupDi MONITOR-class PnP devnode
        // (DISPLAY\<model>\<uid>). Exact match alone can never hit because the
        // two id forms differ by design; bridge via DisplayConfig, then fall
        // back to a single-candidate model match. Multi-candidate models stay
        // on the raw GDI id (never guess the wrong duplicate panel).
        let (device_id, is_device_disabled) = if raw_device_id.is_empty() {
            (String::new(), false)
        } else if let Some((canonical, disabled)) = disabled_map.get(&raw_device_id.to_lowercase())
        {
            seen_instance_ids.insert(canonical.to_lowercase());
            monitor_name = friendly_name_from_instance_id(canonical, &monitor_name);
            (canonical.clone(), *disabled)
        } else if let Some(bridged) = resolve_display_gdi_to_pnp(&device_name) {
            if let Some((canonical, disabled)) = disabled_map.get(&bridged.to_lowercase()) {
                seen_instance_ids.insert(canonical.to_lowercase());
                // Prefer the SetupDi friendly name when GDI only has generic text.
                if let Some(cand) = candidate_by_lower.get(canonical.to_lowercase().as_str()) {
                    if (monitor_name == "Generic Display"
                        || monitor_name == "Generic PnP Monitor"
                        || monitor_name.starts_with("Monitor ("))
                        && !cand.friendly.is_empty()
                    {
                        monitor_name = cand.friendly.clone();
                    } else {
                        monitor_name = friendly_name_from_instance_id(canonical, &monitor_name);
                    }
                } else {
                    monitor_name = friendly_name_from_instance_id(canonical, &monitor_name);
                }
                log::info!(
                    "[display] GDI '{}' ({}) bridged to PnP '{}'",
                    device_name,
                    raw_device_id,
                    canonical
                );
                (canonical.clone(), *disabled)
            } else if let Some(cand) = candidate_by_lower.get(bridged.to_lowercase().as_str()) {
                seen_instance_ids.insert(cand.instance_id.to_lowercase());
                if monitor_name.starts_with("Monitor (") && !cand.friendly.is_empty() {
                    monitor_name = cand.friendly.clone();
                }
                (cand.instance_id.clone(), cand.disabled)
            } else {
                // Bridge produced a PnP path SetupDi didn't list (transient?).
                // Keep the bridged id so enable/disable can still target it.
                log::warn!(
                    "[display] bridge PnP '{}' for '{}' not in disabled_map; using bridge value",
                    bridged,
                    device_name
                );
                seen_instance_ids.insert(bridged.to_lowercase());
                (bridged, false)
            }
        } else if let Some(model) = model_from_instance_path(&raw_device_id) {
            let hits = candidates_matching_model(&candidates, &model);
            if hits.len() == 1 {
                let cand = hits[0];
                let disabled = disabled_map
                    .get(&cand.lower)
                    .map(|(_, d)| *d)
                    .unwrap_or(cand.disabled);
                seen_instance_ids.insert(cand.instance_id.to_lowercase());
                if monitor_name.starts_with("Monitor (") && !cand.friendly.is_empty() {
                    monitor_name = cand.friendly.clone();
                } else {
                    monitor_name = friendly_name_from_instance_id(&cand.instance_id, &monitor_name);
                }
                log::info!(
                    "[display] GDI '{}' ({}) model-matched singleton PnP '{}'",
                    device_name,
                    raw_device_id,
                    cand.instance_id
                );
                (cand.instance_id.clone(), disabled)
            } else {
                if hits.len() > 1 {
                    log::warn!(
                        "[display] GDI '{}' ({}) model '{}' ambiguous ({} candidates); keeping GDI id",
                        device_name,
                        raw_device_id,
                        model,
                        hits.len()
                    );
                }
                (raw_device_id.clone(), false)
            }
        } else {
            (raw_device_id.clone(), false)
        };
        if !device_id.is_empty() {
            seen_instance_ids.insert(device_id.to_lowercase());
        }

        let mut dm = DEVMODEW {
            dmSize: std::mem::size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };
        let mut width = 0;
        let mut height = 0;
        let mut refresh_rate = 60;
        let mut position_x = 0;
        let mut position_y = 0;
        let mut orientation = "Landscape".to_string();

        unsafe {
            let ok_mode = if is_attached {
                EnumDisplaySettingsW(
                    PCWSTR(dev_name_u16.as_ptr()),
                    ENUM_CURRENT_SETTINGS,
                    &mut dm,
                )
            } else {
                EnumDisplaySettingsW(
                    PCWSTR(dev_name_u16.as_ptr()),
                    ENUM_REGISTRY_SETTINGS,
                    &mut dm,
                )
            };

            if ok_mode.as_bool() {
                width = dm.dmPelsWidth;
                height = dm.dmPelsHeight;
                refresh_rate = dm.dmDisplayFrequency;
                position_x = dm.Anonymous1.Anonymous2.dmPosition.x;
                position_y = dm.Anonymous1.Anonymous2.dmPosition.y;
                let o = dm.Anonymous1.Anonymous2.dmDisplayOrientation.0;
                orientation = match o {
                    1 => "Portrait (90°)",
                    2 => "Landscape (Flipped)",
                    3 => "Portrait (270°)",
                    _ => "Landscape",
                }
                .to_string();
            }
        }

        // Never report 0x0 for a disabled monitor when we know its real mode:
        // prefer the live mode, then the last-known cached mode, so the UI
        // aspect ratio never shows 0:0 / NaN.
        if !device_id.is_empty() {
            let key = device_id.to_lowercase();
            if width > 0 && height > 0 {
                let same_mode = res_cache.get(&key).map_or(false, |c| {
                    c.width == width && c.height == height && c.refresh_hz == refresh_rate
                });
                let same_name = res_cache
                    .get(&key)
                    .map_or(false, |c| c.name == monitor_name);
                if !same_mode || !same_name {
                    res_cache.insert(
                        key,
                        CachedRes {
                            name: monitor_name.clone(),
                            width,
                            height,
                            refresh_hz: refresh_rate,
                        },
                    );
                    res_cache_dirty = true;
                }
            } else if let Some(cached) = res_cache.get(&key) {
                width = cached.width;
                height = cached.height;
                // Keep live refresh rate when valid, else cached.
                if refresh_rate == 0 || refresh_rate == 60 {
                    refresh_rate = cached.refresh_hz;
                }
            }
        }

        // Keep disabled devnodes visible even when CCD reports width==0 /
        // detached, so the UI shows "Device Disabled" instead of looking like
        // the display was "closed" / removed.
        if !device_name.is_empty() && (is_attached || width > 0 || is_device_disabled) {
            monitors.push(MonitorDevice {
                device_name,
                adapter_name,
                monitor_name,
                is_attached,
                is_primary,
                width,
                height,
                refresh_rate,
                position_x,
                position_y,
                orientation,
                device_id,
                is_device_disabled,
            });
        }

        i += 1;
    }

    if res_cache_dirty {
        save_monitor_res_cache(&res_cache);
    }

    // Append SetupDi MONITOR devnodes that GDI no longer enumerates (e.g. hard
    // Device Manager disable hides the DISPLAYx entry). These get a synthetic
    // card so the user can still see and re-enable them. Use the last-known
    // cached resolution so aspect ratio stays correct.
    for (canonical_id, disabled) in disabled_map.values() {
        if seen_instance_ids.contains(&canonical_id.to_lowercase()) {
            continue;
        }
        if !disabled {
            continue;
        }
        let (cw, ch, cr) = res_cache
            .get(&canonical_id.to_lowercase())
            .map(|c| (c.width, c.height, c.refresh_hz))
            .unwrap_or((0, 0, 60));
        monitors.push(MonitorDevice {
            device_name: canonical_id.clone(),
            adapter_name: "Monitor Device".to_string(),
            monitor_name: friendly_name_from_instance_id(canonical_id, "Generic PnP Monitor"),
            is_attached: false,
            is_primary: false,
            width: cw,
            height: ch,
            refresh_rate: cr,
            position_x: 0,
            position_y: 0,
            orientation: "Landscape".to_string(),
            device_id: canonical_id.clone(),
            is_device_disabled: true,
        });
    }

    monitors
}
