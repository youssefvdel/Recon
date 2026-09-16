use std::fs;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use windows::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW};
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE};
use winreg::RegKey;

const CREATE_NO_WINDOW: u32 = 0x08000000;

/* Windows display scaling is stored per display path as a DWORD at
HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers\Configuration\<monitor>\00\00
and is the only scaling value Windows itself honours. Documented values
(Intel's own guidance, corroborated by the CRU forum and StackOverflow —
see ROADMAP.md):
    1 = maintain display scaling
    2 = centre image
    3 = scale full screen  (stretch — fills the panel)
    4 = maintain aspect ratio (pillar/letterbox bars)
This module previously wrote 4 while labelling the row
"Full-Screen Hardware Scaling (0 Black Bars)", i.e. it requested the exact
opposite of what it claimed. Stretched must be 3. */
const WDDM_SCALING_FULLSCREEN: u32 = 3;

/* ------------------------------------------------------------------ *
 * LEGACY VENDOR KEYS — NEVER WRITE THESE AGAIN.
 *
 * Older Recon builds wrote `Dal*` (AMD), `ScaleOption` (Intel) and
 * `DxgkUsePhysicalMode` (WDDM) straight into the display adapter class key.
 * Measured reality on user machines:
 *   • No effect — the GPU scaling value Windows/Adrenalin actually honours
 *     is the per-display-path WDDM `Scaling` DWORD, applied through
 *     SetDisplayConfig (CCD). AMD Software drives its own settings through
 *     the ADL runtime API, not by reading these keys; the driver caches
 *     display state, so a key written behind its back changes nothing.
 *   • Actively harmful on AMD — the persisted garbage is re-read on the
 *     next driver start, which leaves scale/HDMI-audio endpoints in a bad
 *     state (users reported the HDMI audio device and the Radeon driver
 *     "disappearing" until the values were removed).
 * Vendor scaling is NOT the app's to own. We apply the documented,
 * verifiable path only: Win32 CCD + the WDDM `Scaling` value.
 * ------------------------------------------------------------------ */
const LEGACY_VENDOR_VALUES: &[&str] = &[
    "DalGpuScaling",
    "DalKeepAspectRatio",
    "DalScaleRule",
    "DalIntegerScaling",
    "DalEnableModeBypass",
    "ScaleOption",
    "ReadEDIDFromRegistry",
    "CustomModeAllowed",
    "EnableCustomResolutions",
    "MaintainAspectRatio",
    "DisableLetterboxing",
];

/// Heal machines that ran an older Recon: delete the vendor/driver keys we
/// used to write. Idempotent and cheap (registry-only, no reboot). Left in
/// `DalNonStandardModesBCD` on purpose — it is inert on current drivers and
/// the user may hold legitimate Adrenaline custom modes in it.
pub fn purge_legacy_vendor_overrides() -> usize {
    let mut removed = 0;
    apply_to_all_gpu_adapters(|_desc, _prov, sub_key| {
        for name in LEGACY_VENDOR_VALUES {
            if sub_key.get_raw_value(name).is_ok() && sub_key.delete_value(name).is_ok() {
                removed += 1;
            }
        }
    });
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Ok(gd) = hklm.open_subkey_with_flags(
        r"SYSTEM\CurrentControlSet\Control\GraphicsDrivers",
        KEY_SET_VALUE,
    ) {
        if gd.delete_value("DxgkUsePhysicalMode").is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        log::info!(
            "[gpu] purged {} legacy vendor override value(s) — scaling is CCD/WDDM-owned now",
            removed
        );
    }
    removed
}

/// WDDM `Scaling` value for the documented modes (see the table above).
/// Stretched must be 3: writing 4 was the old "aspect ratio" value and is
/// exactly why the toggle looked like it did nothing.
pub fn wddm_scaling_value(stretched: bool) -> u32 {
    if stretched {
        WDDM_SCALING_FULLSCREEN
    } else {
        4 // maintain aspect ratio (pillar/letterbox)
    }
}

/// Human label for a WDDM `Scaling` value.
fn scaling_label(v: u32) -> &'static str {
    match v {
        1 => "maintain display scaling",
        2 => "centre image",
        3 => "scale full screen",
        4 => "maintain aspect ratio",
        _ => "unknown",
    }
}

/// The scaling mode Windows actually has set for the active display path.
///
/// Ground truth: read back from the registry rather than trusting our own
/// saved intent. Windows keeps the value under the monitor's `00\00` path; the
/// active entry is the one carrying `PrimSurfSize.cx`.
fn read_active_windows_scaling() -> Option<(u32, String)> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let root = hklm
        .open_subkey_with_flags(
            r"SYSTEM\CurrentControlSet\Control\GraphicsDrivers\Configuration",
            KEY_READ,
        )
        .ok()?;

    let mut best: Option<(u32, String)> = None;
    for mon in root.enum_keys().filter_map(|k| k.ok()) {
        // Skip the non-display helper keys.
        if mon.eq_ignore_ascii_case("Properties") || mon.eq_ignore_ascii_case("Connectivity") {
            continue;
        }
        let Ok(mon_key) = root.open_subkey_with_flags(&mon, KEY_READ) else {
            continue;
        };
        for idx in mon_key.enum_keys().filter_map(|k| k.ok()) {
            let Ok(idx_key) = mon_key.open_subkey_with_flags(&idx, KEY_READ) else {
                continue;
            };
            for sub in idx_key.enum_keys().filter_map(|k| k.ok()) {
                let Ok(path) = idx_key.open_subkey_with_flags(&sub, KEY_READ) else {
                    continue;
                };
                let Ok(scaling) = path.get_value::<u32, _>("Scaling") else {
                    continue;
                };
                // An active path records its surface size. Prefer the largest.
                let cx: u32 = path.get_value("PrimSurfSize.cx").unwrap_or(0);
                let label = format!("{}\\{}\\{}", mon, idx, sub);
                match &best {
                    Some((_, prev)) if cx == 0 && !prev.is_empty() => {}
                    _ => {
                        if best.as_ref().map(|(_, p)| p.is_empty()).unwrap_or(true) || cx > 0 {
                            best = Some((scaling, label));
                        }
                    }
                }
            }
        }
    }
    best
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Unknown,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct GpuInfo {
    pub vendor: GpuVendor,
    pub name: String,
    pub instructions: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct GpuSettingItem {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    /// True only when the value was read back from the machine and matches the
    /// claim. Vendor-managed settings we cannot observe report false, so the UI
    /// can say "unverified" instead of asserting a state the driver owns.
    pub verified: bool,
    /// Exactly what was found, e.g. "Windows reports: maintain aspect ratio".
    pub detail: String,
    pub badge: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct GpuSettingsReport {
    pub vendor: GpuVendor,
    pub name: String,
    pub settings: Vec<GpuSettingItem>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SavedGpuSettings {
    pub full_screen_scaling: bool,
    pub gpu_scaling_engine: bool,
    pub override_game_scaling: bool,
    pub low_latency_scanout: bool,
    pub integer_scaling_bypass: bool,
}

impl Default for SavedGpuSettings {
    fn default() -> Self {
        Self {
            full_screen_scaling: true,
            gpu_scaling_engine: true,
            override_game_scaling: true,
            low_latency_scanout: true,
            integer_scaling_bypass: true,
        }
    }
}

fn get_gpu_settings_path() -> Option<PathBuf> {
    if let Ok(app_data) = std::env::var("LOCALAPPDATA") {
        let dir = PathBuf::from(app_data).join("TrueStretchStudio");
        let _ = fs::create_dir_all(&dir);
        Some(dir.join("gpu_settings.json"))
    } else {
        Some(PathBuf::from("gpu_settings.json"))
    }
}

pub fn load_saved_gpu_settings() -> SavedGpuSettings {
    if let Some(path) = get_gpu_settings_path() {
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(settings) = serde_json::from_str::<SavedGpuSettings>(&content) {
                return settings;
            }
        }
    }
    SavedGpuSettings::default()
}

pub fn save_gpu_settings(settings: &SavedGpuSettings) {
    if let Some(path) = get_gpu_settings_path() {
        if let Ok(content) = serde_json::to_string_pretty(settings) {
            let _ = fs::write(path, content);
        }
    }
}

pub fn detect_gpu() -> GpuInfo {
    let mut names: Vec<String> = Vec::new();
    unsafe {
        let mut dd = DISPLAY_DEVICEW {
            cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };

        let mut idx = 0;
        while EnumDisplayDevicesW(None, idx, &mut dd, 0).as_bool() {
            let str_val = String::from_utf16_lossy(&dd.DeviceString);
            let cleaned = str_val.trim_matches(char::from(0)).trim().to_string();
            if !cleaned.is_empty()
                && !cleaned.contains("Basic Display")
                && !cleaned.contains("Basic Render")
                && !names.contains(&cleaned)
            {
                names.push(cleaned);
            }
            idx += 1;
        }
    }

    // Also inspect registry Class\{4d36e968-e325-11ce-bfc1-08002be10318} to ensure hybrid/all GPUs are found
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let class_path =
        r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    if let Ok(class_key) = hklm.open_subkey_with_flags(class_path, KEY_READ) {
        for i in 0..16 {
            let sub_name = format!("{:04}", i);
            if let Ok(sub_key) = class_key.open_subkey_with_flags(&sub_name, KEY_READ) {
                if let Ok(desc) = sub_key.get_value::<String, _>("DriverDesc") {
                    let cleaned = desc.trim().to_string();
                    if !cleaned.is_empty()
                        && !cleaned.contains("Basic Display")
                        && !cleaned.contains("Basic Render")
                        && !names.contains(&cleaned)
                    {
                        names.push(cleaned);
                    }
                }
            }
        }
    }

    let classify = |s: &str| -> GpuVendor {
        let lower = s.to_lowercase();
        if lower.contains("nvidia")
            || lower.contains("geforce")
            || lower.contains("rtx")
            || lower.contains("gtx")
            || lower.contains("quadro")
        {
            GpuVendor::Nvidia
        } else if lower.contains("amd")
            || lower.contains("radeon")
            || lower.contains("advanced micro devices")
            || lower.contains("ati")
        {
            GpuVendor::Amd
        } else if lower.contains("intel")
            || lower.contains("arc")
            || lower.contains("iris")
            || lower.contains("uhd")
        {
            GpuVendor::Intel
        } else {
            GpuVendor::Unknown
        }
    };

    // Prioritize discrete GPUs (RTX/GTX/Radeon RX/Arc) over integrated GPUs for the main badge
    let primary_idx = names
        .iter()
        .position(|n| {
            let l = n.to_lowercase();
            (l.contains("geforce")
                || l.contains("rtx")
                || l.contains("gtx")
                || (l.contains("radeon")
                    && (l.contains("rx") || l.contains("xt") || l.contains("pro"))))
                && !l.contains("graphics")
        })
        .unwrap_or(0);

    let primary_name = if !names.is_empty() {
        names[primary_idx].clone()
    } else {
        "Generic Display Adapter".to_string()
    };
    let vendor = classify(&primary_name);

    let display_name = if names.len() > 1 {
        let others: Vec<_> = names
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != primary_idx)
            .map(|(_, n)| n.as_str())
            .collect();
        format!("{} (+ {})", primary_name, others.join(", "))
    } else {
        primary_name
    };

    let mut instructions: Vec<String> = match vendor {
        GpuVendor::Nvidia => vec![
            "Recon sets Windows full-screen (stretched) scaling via the display API.".into(),
            "In NVIDIA Control Panel → Adjust desktop size and position: Scaling mode 'Full-screen', 'Perform scaling on: GPU'.".into(),
            "DirectFlip low-latency scanout is applied by Recon.".into(),
        ],
        GpuVendor::Amd => vec![
            "Recon sets Windows full-screen (stretched) scaling via the display API.".into(),
            "In AMD Software → Display: turn GPU Scaling on and pick 'Full panel'.".into(),
            "AMD owns those driver settings — Recon deliberately does not write driver keys (they broke scaling and HDMI audio on AMD systems).".into(),
        ],
        GpuVendor::Intel => vec![
            "Recon sets Windows full-screen (stretched) scaling via the display API.".into(),
            "In Intel Graphics Command Center → Display: set Scale to 'Stretch' if you need driver-level scaling.".into(),
        ],
        GpuVendor::Unknown => vec![
            "Enable GPU hardware scaling.".into(),
            "Set scaling mode to Full-screen / Stretched.".into(),
            "Bypass application letterbox clamping.".into(),
        ],
    };

    if names.len() > 1 {
        instructions.push(
            "Multi-GPU system detected: Scaling and custom modes configured across all adapters."
                .into(),
        );
    }

    GpuInfo {
        vendor,
        name: display_name,
        instructions,
    }
}

fn read_hklm_dword(path: &str, name: &str) -> Option<u32> {
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(path, KEY_READ)
        .ok()?
        .get_value::<u32, _>(name)
        .ok()
}

fn read_hkcu_dword(path: &str, name: &str) -> Option<u32> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(path, KEY_READ)
        .ok()?
        .get_value::<u32, _>(name)
        .ok()
}

/// First present value among `candidates` on any display adapter key.
/// Returns (value name, value) so the caller can name its own evidence.
fn read_vendor_dword(candidates: &[&str]) -> Option<(String, u32)> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let class_path =
        r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    let class_key = hklm.open_subkey_with_flags(class_path, KEY_READ).ok()?;
    for i in 0..16 {
        let sub_name = format!("{:04}", i);
        let Ok(sub_key) = class_key.open_subkey_with_flags(&sub_name, KEY_READ) else {
            continue;
        };
        for name in candidates {
            if let Ok(v) = sub_key.get_value::<u32, _>(*name) {
                return Some(((*name).to_string(), v));
            }
        }
    }
    None
}

/// Is any NVIDIA driver display-database connector entry present?
fn nvidia_connector_count() -> usize {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let base = r"SYSTEM\CurrentControlSet\Services
vlddmkm\State\DisplayDatabase";
    match hklm.open_subkey_with_flags(base, KEY_READ) {
        Ok(k) => k
            .enum_keys()
            .filter_map(|x| x.ok())
            .filter(|n| n.starts_with("CONNECTOR_"))
            .count(),
        Err(_) => 0,
    }
}

/// Evaluate one setting against the live machine.
/// Returns (enabled, verified, human detail).
fn eval_setting(
    id: &str,
    saved: &SavedGpuSettings,
    wddm: &Option<(u32, String)>,
) -> (bool, bool, String) {
    match id {
        // The only scaling value Windows itself honours — fully verifiable.
        "full_screen_scaling" => match wddm {
            Some((v, path)) => (
                *v == WDDM_SCALING_FULLSCREEN,
                true,
                format!(
                    "Windows reports \"{}\" ({}) on {}",
                    scaling_label(*v),
                    v,
                    short_path(path)
                ),
            ),
            None => (
                false,
                false,
                r"No WDDM scaling value found in GraphicsDrivers\Configuration".into(),
            ),
        },
        "gpu_scaling_engine" => {
            if let Some((name, v)) = read_vendor_dword(&["DalGpuScaling", "ScaleOption"]) {
                (
                    v != 0,
                    false,
                    format!("Driver key {}={} (reported by Radeon/Intel driver store, not verified live)", name, v),
                )
            } else if nvidia_connector_count() > 0 {
                (
                    saved.gpu_scaling_engine,
                    false,
                    "NVIDIA manages scaling internally (nvlddmkm DisplayDatabase); not readable as a toggle".into(),
                )
            } else {
                // No driver key (the normal state since we stopped writing
                // them, and after the purge). Reflect what the user asked for
                // so the toggle stays where they put it — the honest part is
                // `verified: false`, plus a detail saying who owns the setting.
                (
                    saved.gpu_scaling_engine,
                    false,
                    "Driver-level GPU scaling is vendor-owned (AMD Software / NVIDIA Control Panel). Recon applies Windows full-screen scaling; it no longer writes driver keys.".into(),
                )
            }
        }
        "override_game_scaling" => {
            if let Some((name, v)) =
                read_vendor_dword(&["DalEnableModeBypass", "DisableLetterboxing"])
            {
                (v != 0, false, format!("Driver key {}={}", name, v))
            } else {
                (
                    saved.override_game_scaling,
                    false,
                    "No vendor override key present — game config letterbox flags are set directly"
                        .into(),
                )
            }
        }
        "low_latency_scanout" => {
            let v = read_hklm_dword(r"SOFTWARE\Microsoft\Windows\DWM", "DirectFlipEnabled")
                .or_else(|| {
                    read_hkcu_dword(r"Software\Microsoft\Windows\DWM", "DirectFlipEnabled")
                });
            match v {
                Some(v) => (v != 0, true, format!(r"DWM\DirectFlipEnabled={}", v)),
                None => (
                    false,
                    true,
                    "DirectFlipEnabled is not set (DWM default)".into(),
                ),
            }
        }
        "integer_scaling_bypass" => {
            if let Some((name, v)) =
                read_vendor_dword(&["DalIntegerScaling", "MaintainAspectRatio"])
            {
                (
                    v == 0,
                    false,
                    format!(
                        "Driver key {}={} (0 = integer scaling off / stretch allowed)",
                        name, v
                    ),
                )
            } else {
                (
                    saved.integer_scaling_bypass,
                    false,
                    "Integer scaling is vendor-owned; Recon removes the bars via Windows full-screen scaling instead".into(),
                )
            }
        }
        _ => (false, false, "Unknown setting".into()),
    }
}

/// Trim the long monitor instance path down to something a human can read.
fn short_path(p: &str) -> String {
    let parts: Vec<&str> = p.split('\\').collect();
    if parts.len() >= 3 {
        let mon = parts[0];
        let head: String = mon.chars().take(24).collect();
        format!(
            "{}…{}\\{}",
            head,
            parts[parts.len() - 2],
            parts[parts.len() - 1]
        )
    } else {
        p.to_string()
    }
}

pub fn get_gpu_settings_report() -> GpuSettingsReport {
    let gpu_info = detect_gpu();
    let saved = load_saved_gpu_settings();
    // Read the machine, not our own memory. `saved` is only used as a fallback
    // for values that genuinely cannot be observed.
    let wddm = read_active_windows_scaling();
    let ids = [
        "full_screen_scaling",
        "gpu_scaling_engine",
        "override_game_scaling",
        "low_latency_scanout",
        "integer_scaling_bypass",
    ];
    let mut ev: std::collections::HashMap<&str, (bool, bool, String)> =
        std::collections::HashMap::new();
    for id in ids {
        ev.insert(id, eval_setting(id, &saved, &wddm));
    }
    let f = |id: &str| -> (bool, bool, String) {
        ev.get(id).cloned().unwrap_or((false, false, String::new()))
    };

    let settings = match gpu_info.vendor {
        GpuVendor::Nvidia => vec![
            GpuSettingItem {
                id: "full_screen_scaling".into(),
                name: "Full-Screen Hardware Scaling (0 Black Bars)".into(),
                description: "Forces RTX hardware display pipe to stretch custom 1.45:1 resolutions to panel borders with zero black bars.".into(),
                enabled: f("full_screen_scaling").0,
                verified: f("full_screen_scaling").1,
                detail: f("full_screen_scaling").2,
                badge: "Win32 CCD • Full-Screen".into(),
            },
            GpuSettingItem {
                id: "gpu_scaling_engine".into(),
                name: "Perform Scaling on: GPU".into(),
                description: "Offloads image expansion to RTX hardware scanout pipeline instead of monitor display scalar.".into(),
                enabled: f("gpu_scaling_engine").0,
                verified: f("gpu_scaling_engine").1,
                detail: f("gpu_scaling_engine").2,
                badge: "NVIDIA Hardware Scaler".into(),
            },
            GpuSettingItem {
                id: "override_game_scaling".into(),
                name: "Override Scaling Mode Set by Games & Programs".into(),
                description: "Forces driver-level stretched scanout over in-game letterbox enforcement (sets bShouldLetterbox=False).".into(),
                enabled: f("override_game_scaling").0,
                verified: f("override_game_scaling").1,
                detail: f("override_game_scaling").2,
                badge: "Driver Scanout Priority".into(),
            },
            GpuSettingItem {
                id: "low_latency_scanout".into(),
                name: "Ultra-Low Latency Direct Scanout Engine".into(),
                description: "Bypasses DWM windowed presentation buffer, enabling 0.0 ms DirectFlip scanout with zero delay.".into(),
                enabled: f("low_latency_scanout").0,
                verified: f("low_latency_scanout").1,
                detail: f("low_latency_scanout").2,
                badge: "DirectFlip Scanout".into(),
            },
            GpuSettingItem {
                id: "integer_scaling_bypass".into(),
                name: "Bypass Integer Scaling Aspect Lock".into(),
                description: "Prevents fixed-pixel integer scaling clamps, allowing arbitrary golden-ratio custom resolutions.".into(),
                enabled: f("integer_scaling_bypass").0,
                verified: f("integer_scaling_bypass").1,
                detail: f("integer_scaling_bypass").2,
                badge: "Uncapped Aspect Ratio".into(),
            },
        ],
        GpuVendor::Amd => vec![
            GpuSettingItem {
                id: "full_screen_scaling".into(),
                name: "AMD Full Panel Scaling (0 Black Bars)".into(),
                description: "Stretches custom resolutions to panel borders with zero black pillarbox bars.".into(),
                enabled: f("full_screen_scaling").0,
                verified: f("full_screen_scaling").1,
                detail: f("full_screen_scaling").2,
                badge: "AMD Full Panel".into(),
            },
            GpuSettingItem {
                id: "gpu_scaling_engine".into(),
                name: "Radeon GPU Scaling Engine".into(),
                description: "Enforces Radeon GPU hardware scaling over monitor display timing.".into(),
                enabled: f("gpu_scaling_engine").0,
                verified: f("gpu_scaling_engine").1,
                detail: f("gpu_scaling_engine").2,
                badge: "Adrenalin Hardware".into(),
            },
            GpuSettingItem {
                id: "override_game_scaling".into(),
                name: "Override In-Game Scaling & Letterboxing".into(),
                description: "Prevents game engines from enforcing black letterbox borders on stretched modes.".into(),
                enabled: f("override_game_scaling").0,
                verified: f("override_game_scaling").1,
                detail: f("override_game_scaling").2,
                badge: "Driver Priority".into(),
            },
            GpuSettingItem {
                id: "low_latency_scanout".into(),
                name: "Radeon Anti-Lag Direct Scanout Engine".into(),
                description: "Bypasses desktop composition buffers for direct zero-latency frame scanout.".into(),
                enabled: f("low_latency_scanout").0,
                verified: f("low_latency_scanout").1,
                detail: f("low_latency_scanout").2,
                badge: "Anti-Lag Scanout".into(),
            },
            GpuSettingItem {
                id: "integer_scaling_bypass".into(),
                name: "Integer Scaling Restriction Bypass".into(),
                description: "Disables integer scaling lock to permit smooth 1.45:1 golden ratio expansion.".into(),
                enabled: f("integer_scaling_bypass").0,
                verified: f("integer_scaling_bypass").1,
                detail: f("integer_scaling_bypass").2,
                badge: "Smooth Stretch".into(),
            },
        ],
        GpuVendor::Intel => vec![
            GpuSettingItem {
                id: "full_screen_scaling".into(),
                name: "Intel Stretched Display Scaling (0 Black Bars)".into(),
                description: "Expands custom 1.45:1 stretched resolutions across 100% of panel area.".into(),
                enabled: f("full_screen_scaling").0,
                verified: f("full_screen_scaling").1,
                detail: f("full_screen_scaling").2,
                badge: "Intel Stretched".into(),
            },
            GpuSettingItem {
                id: "gpu_scaling_engine".into(),
                name: "Intel Graphics Hardware Scaler".into(),
                description: "Routes display stretching through Intel Xe display engine circuitry.".into(),
                enabled: f("gpu_scaling_engine").0,
                verified: f("gpu_scaling_engine").1,
                detail: f("gpu_scaling_engine").2,
                badge: "Xe Scaler".into(),
            },
            GpuSettingItem {
                id: "override_game_scaling".into(),
                name: "Override Application Scaling Restrictions".into(),
                description: "Bypasses in-game letterboxing enforcement and disables aspect ratio constraints.".into(),
                enabled: f("override_game_scaling").0,
                verified: f("override_game_scaling").1,
                detail: f("override_game_scaling").2,
                badge: "Bypass Letterbox".into(),
            },
            GpuSettingItem {
                id: "low_latency_scanout".into(),
                name: "Intel Low-Latency Scanout Engine".into(),
                description: "Eliminates DWM letterbox buffer and forces hardware flip presentation.".into(),
                enabled: f("low_latency_scanout").0,
                verified: f("low_latency_scanout").1,
                detail: f("low_latency_scanout").2,
                badge: "DirectFlip".into(),
            },
            GpuSettingItem {
                id: "integer_scaling_bypass".into(),
                name: "Maintain Aspect Ratio Override".into(),
                description: "Turns off aspect ratio lock to allow full horizontal stretched scanout.".into(),
                enabled: f("integer_scaling_bypass").0,
                verified: f("integer_scaling_bypass").1,
                detail: f("integer_scaling_bypass").2,
                badge: "Fill Panel".into(),
            },
        ],
        GpuVendor::Unknown => vec![
            GpuSettingItem {
                id: "full_screen_scaling".into(),
                name: "Full-Screen Hardware Scaling (0 Black Bars)".into(),
                description: "Applies Win32 CCD stretched scaling and sets driver registry scaling to Full-Screen (4).".into(),
                enabled: f("full_screen_scaling").0,
                verified: f("full_screen_scaling").1,
                detail: f("full_screen_scaling").2,
                badge: "Win32 CCD".into(),
            },
            GpuSettingItem {
                id: "gpu_scaling_engine".into(),
                name: "GPU Hardware Scaling Engine".into(),
                description: "Enforces GPU display pipe timing instead of display monitor scalar.".into(),
                enabled: f("gpu_scaling_engine").0,
                verified: f("gpu_scaling_engine").1,
                detail: f("gpu_scaling_engine").2,
                badge: "GPU Scanout".into(),
            },
            GpuSettingItem {
                id: "override_game_scaling".into(),
                name: "Override Scaling Mode Set by Games & Programs".into(),
                description: "Sets bShouldLetterbox=False across all game config files and overrides DXGI scaling.".into(),
                enabled: f("override_game_scaling").0,
                verified: f("override_game_scaling").1,
                detail: f("override_game_scaling").2,
                badge: "Game Bypass".into(),
            },
            GpuSettingItem {
                id: "low_latency_scanout".into(),
                name: "Ultra-Low Latency Direct Scanout Engine".into(),
                description: "Configures DWM direct flip queue for zero scanout latency.".into(),
                enabled: f("low_latency_scanout").0,
                verified: f("low_latency_scanout").1,
                detail: f("low_latency_scanout").2,
                badge: "DirectFlip".into(),
            },
            GpuSettingItem {
                id: "integer_scaling_bypass".into(),
                name: "Bypass Fixed Aspect Ratio Restrictions".into(),
                description: "Disables aspect ratio locks to allow custom stretched resolutions to fill the panel.".into(),
                enabled: f("integer_scaling_bypass").0,
                verified: f("integer_scaling_bypass").1,
                detail: f("integer_scaling_bypass").2,
                badge: "Fill Panel".into(),
            },
        ],
    };

    GpuSettingsReport {
        vendor: gpu_info.vendor,
        name: gpu_info.name,
        settings,
    }
}

fn set_hklm_dword(subkey_path: &str, value_name: &str, val: u32) {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Ok((key, _)) = hklm.create_subkey(subkey_path) {
        let _ = key.set_value(value_name, &val);
    }
}

fn set_hkcu_dword(subkey_path: &str, value_name: &str, val: u32) {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok((key, _)) = hkcu.create_subkey(subkey_path) {
        let _ = key.set_value(value_name, &val);
    }
}

fn apply_scaling_recursive(key: &RegKey, scaling_val: u32) {
    if let Ok(_) = key.get_value::<u32, _>("Scaling") {
        let _ = key.set_value("Scaling", &scaling_val);
    }
    for sub in key.enum_keys().filter_map(|k| k.ok()) {
        if let Ok(sub_key) = key.open_subkey_with_flags(&sub, KEY_READ | KEY_SET_VALUE) {
            apply_scaling_recursive(&sub_key, scaling_val);
        }
    }
}

pub fn apply_to_all_gpu_adapters<F>(mut f: F)
where
    F: FnMut(&str, &str, &RegKey),
{
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let class_path =
        r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    if let Ok(class_key) = hklm.open_subkey_with_flags(class_path, KEY_READ) {
        for i in 0..16 {
            let sub_name = format!("{:04}", i);
            if let Ok(sub_key) =
                class_key.open_subkey_with_flags(&sub_name, KEY_READ | KEY_SET_VALUE)
            {
                let desc: String = sub_key.get_value("DriverDesc").unwrap_or_default();
                let prov: String = sub_key.get_value("ProviderName").unwrap_or_default();
                f(&desc, &prov, &sub_key);
            }
        }
    }
}

pub fn apply_single_gpu_setting(id: &str, value: bool) -> Result<GpuSettingsReport, String> {
    let mut saved = load_saved_gpu_settings();

    match id {
        "full_screen_scaling" => {
            saved.full_screen_scaling = value;
            let _ = crate::display::set_display_scaling_mode(value);

            // Global WDDM scaling in GraphicsDrivers\Configuration — the value
            // Windows itself honours. No vendor keys (see LEGACY_VENDOR_VALUES).
            let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
            if let Ok(config_root) = hklm.open_subkey_with_flags(
                r"SYSTEM\CurrentControlSet\Control\GraphicsDrivers\Configuration",
                KEY_READ | KEY_SET_VALUE,
            ) {
                apply_scaling_recursive(&config_root, wddm_scaling_value(value));
            }
        }
        "gpu_scaling_engine" => {
            saved.gpu_scaling_engine = value;
            if value {
                let _ = crate::display::apply_gpu_scaling_stretched();
            }
            // "Perform scaling on: GPU" is a driver mode owned by the GPU
            // vendor's own API (ADL / NVAPI / IGCL) — never a registry DWORD.
            // The CCD stretched mode above is what we can actually apply.
        }
        "override_game_scaling" => {
            saved.override_game_scaling = value;
            let _ = crate::game_config::set_letterbox_all(!value);
            set_hkcu_dword(
                r"Software\Microsoft\DirectX\UserGpuPreferences",
                "DisableDXGIWindowedStereo",
                if value { 1 } else { 0 },
            );
        }
        "low_latency_scanout" => {
            saved.low_latency_scanout = value;
            let reg_val = if value { 1 } else { 0 };
            set_hkcu_dword(
                r"Software\Microsoft\Windows\DWM",
                "DirectFlipEnabled",
                reg_val,
            );
            set_hklm_dword(
                r"SOFTWARE\Microsoft\Windows\DWM",
                "DirectFlipEnabled",
                reg_val,
            );
        }
        "integer_scaling_bypass" => {
            saved.integer_scaling_bypass = value;
            let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
            if let Ok(config_root) = hklm.open_subkey_with_flags(
                r"SYSTEM\CurrentControlSet\Control\GraphicsDrivers\Configuration",
                KEY_READ | KEY_SET_VALUE,
            ) {
                apply_scaling_recursive(&config_root, WDDM_SCALING_FULLSCREEN);
            }
            // Integer scaling is an Adrenalin / NVIDIA-CP feature; the WDDM
            // stretch above is what removes the bars for us.
        }
        _ => return Err(format!("Unknown setting ID: {}", id)),
    }

    save_gpu_settings(&saved);
    Ok(get_gpu_settings_report())
}

/// Applies GPU scaling through the documented, verifiable path only:
/// Win32 CCD (`SetDisplayConfig`, `DISPLAYCONFIG_SCALING_STRETCHED`) plus the
/// per-path WDDM `Scaling` value.
///
/// It deliberately does NOT touch vendor keys: the old NVIDIA DisplayDatabase
/// binary patch and AMD `Dal*` writes had no effect on current drivers and
/// left AMD machines with a broken scale/audio state (see LEGACY_VENDOR_VALUES).
pub fn apply_gpu_scaling_for_active_vendor(stretched: bool) {
    let _ = crate::display::set_display_scaling_mode(stretched);
}
pub fn enforce_all_gpu_scaling() {
    apply_gpu_scaling_for_active_vendor(true);
}

pub fn auto_configure_all_gpu_settings() -> Result<(String, GpuSettingsReport), String> {
    let saved = SavedGpuSettings {
        full_screen_scaling: true,
        gpu_scaling_engine: true,
        override_game_scaling: true,
        low_latency_scanout: true,
        integer_scaling_bypass: true,
    };
    save_gpu_settings(&saved);

    // 1. Win32 CCD Stretched
    let ccd_res = crate::display::apply_gpu_scaling_stretched()
        .unwrap_or_else(|_| "Full-Screen scaling applied".into());

    // 2. Disable letterboxing across all configs
    let config_count = crate::game_config::set_letterbox_all(false).unwrap_or(0);

    // 3. DWM DirectFlip + revocable per-user D3D preference
    set_hkcu_dword(r"Software\Microsoft\Windows\DWM", "DirectFlipEnabled", 1);
    set_hklm_dword(r"SOFTWARE\Microsoft\Windows\DWM", "DirectFlipEnabled", 1);
    set_hkcu_dword(
        r"Software\Microsoft\DirectX\UserGpuPreferences",
        "DisableDXGIWindowedStereo",
        1,
    );

    // 4. Set global WDDM scaling in GraphicsDrivers\Configuration
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Ok(config_root) = hklm.open_subkey_with_flags(
        r"SYSTEM\CurrentControlSet\Control\GraphicsDrivers\Configuration",
        KEY_READ | KEY_SET_VALUE,
    ) {
        apply_scaling_recursive(&config_root, WDDM_SCALING_FULLSCREEN);
    }

    // 5. Heal any vendor garbage an older build left behind.
    let purged = purge_legacy_vendor_overrides();

    let report = get_gpu_settings_report();

    let msg = format!(
        "Auto-applied GPU settings: {} active display path(s) set to Full-Screen Stretched (Windows CCD + WDDM scaling), letterboxing bypassed in {} game config(s), DirectFlip low-latency scanout on{}. Vendor driver keys are left to the GPU vendor — Recon no longer writes them{}.",
        ccd_res,
        config_count,
        if purged > 0 {
            format!(" ({} legacy value(s) cleaned up)", purged)
        } else {
            String::new()
        },
        if purged > 0 { "" } else { "" }
    );

    Ok((msg, report))
}

pub fn launch_control_panel(vendor: &GpuVendor) -> Result<(), String> {
    match vendor {
        GpuVendor::Nvidia => {
            let paths = [
                r"C:\Program Files\NVIDIA Corporation\Control Panel Client\nvcplui.exe",
                r"C:\Windows\System32\nvcplui.exe",
            ];
            for path in &paths {
                if std::path::Path::new(path).exists() {
                    let _ = Command::new(path).creation_flags(CREATE_NO_WINDOW).spawn();
                    return Ok(());
                }
            }
            Command::new("control.exe")
                .arg("/name")
                .arg("Microsoft.NVIDIAControlPanel")
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("Failed to launch NVIDIA Control Panel: {}", e))?;
            Ok(())
        }
        GpuVendor::Amd => {
            let paths = [
                r"C:\Program Files\AMD\CNext\CNext\RadeonSoftware.exe",
                r"C:\Program Files\AMD\CNext\CNext\cncmd.exe",
            ];
            for path in &paths {
                if std::path::Path::new(path).exists() {
                    let _ = Command::new(path).creation_flags(CREATE_NO_WINDOW).spawn();
                    return Ok(());
                }
            }
            Command::new("explorer.exe")
                .arg("amd://")
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("Failed to launch AMD Software: {}", e))?;
            Ok(())
        }
        GpuVendor::Intel => {
            let paths = [r"C:\Program Files\Intel\Intel Graphics Command Center\IGCC.exe"];
            for path in &paths {
                if std::path::Path::new(path).exists() {
                    let _ = Command::new(path).creation_flags(CREATE_NO_WINDOW).spawn();
                    return Ok(());
                }
            }
            Command::new("explorer.exe")
                .arg("igcc://")
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("Failed to launch Intel Graphics Center: {}", e))?;
            Ok(())
        }
        GpuVendor::Unknown => {
            Command::new("explorer.exe")
                .arg("ms-settings:display")
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("Failed to open Windows Display Settings: {}", e))?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bug that made the GPU scaling tab look dead: "stretched" was written
    /// as 4 (maintain aspect = bars) instead of 3 (scale full screen).
    #[test]
    fn stretch_is_wddm_3_and_aspect_is_4() {
        assert_eq!(wddm_scaling_value(true), 3);
        assert_eq!(wddm_scaling_value(true), WDDM_SCALING_FULLSCREEN);
        assert_eq!(wddm_scaling_value(false), 4);
        assert_eq!(scaling_label(wddm_scaling_value(true)), "scale full screen");
        assert_eq!(
            scaling_label(wddm_scaling_value(false)),
            "maintain aspect ratio"
        );
    }

    /// The purge list is the guard rail: no vendor key may be written back.
    /// If someone reintroduces `Dal*`/`ScaleOption`/`DxgkUsePhysicalMode`
    /// writes, this fails and points at the reason.
    #[test]
    fn purge_list_covers_every_legacy_vendor_key() {
        for key in [
            "DalGpuScaling",
            "DalKeepAspectRatio",
            "DalScaleRule",
            "DalIntegerScaling",
            "DalEnableModeBypass",
            "ScaleOption",
            "ReadEDIDFromRegistry",
            "CustomModeAllowed",
            "EnableCustomResolutions",
            "MaintainAspectRatio",
            "DisableLetterboxing",
        ] {
            assert!(
                LEGACY_VENDOR_VALUES.contains(&key),
                "purge list is missing {}",
                key
            );
        }
        // Inert on current drivers + may hold legitimate Adrenaline modes:
        // heal must NOT delete it.
        assert!(!LEGACY_VENDOR_VALUES.contains(&"DalNonStandardModesBCD"));
    }
}
