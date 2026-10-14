// Single persistent settings store: `settings.json` in the app data dir.
//
// Replaces the scattered per-pref files (`auto_borderless.txt`,
// `start_minimized.txt`, `stretched_res.txt`, `hotkey.txt`, `shortcuts.txt`,
// `overlay_monitor.txt`). On first load after the upgrade, legacy files are
// read once, folded into `settings.json`, and deleted — existing installs
// keep their preferences. Transient handoff files (`requested_tab.txt`,
// updater artifacts) are NOT settings and stay untouched.

use std::sync::Mutex;

const SETTINGS_FILE: &str = "settings.json";

/// Legacy per-pref files folded into `settings.json` on first load.
const LEGACY_FILES: [&str; 6] = [
    "auto_borderless.txt",
    "start_minimized.txt",
    "stretched_res.txt",
    "hotkey.txt",
    "shortcuts.txt",
    "overlay_monitor.txt",
];

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
struct AppSettings {
    #[serde(default)]
    auto_borderless: bool,
    /// Boot launches hide to the tray. Default ON: a login launch must never
    /// pop a window over the game.
    #[serde(default = "default_true")]
    start_minimized: bool,
    #[serde(default)]
    stretched_w: Option<u32>,
    #[serde(default)]
    stretched_h: Option<u32>,
    /// `ShortcutBinding::serialize()` payload — opaque here, parsed by display.
    #[serde(default)]
    hotkey: Option<String>,
    /// "auto" or a `\\.\DISPLAYn` device name. Empty means unset.
    #[serde(default)]
    overlay_monitor: Option<String>,
    /// Raw `shortcuts.txt` payload (`id|name|match|icon|removable` lines).
    #[serde(default)]
    shortcuts_raw: Option<String>,
}

static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

fn parse_bool_flag(raw: &str) -> bool {
    raw.trim() == "1"
}

fn migrate_legacy() -> AppSettings {
    let mut s = AppSettings::default();
    // start_minimized has no legacy file for most installs (it is new):
    // absence means ON, an explicit "0" means OFF.
    s.start_minimized = crate::paths::read_data_file("start_minimized.txt")
        .map(|v| parse_bool_flag(&v))
        .unwrap_or(true);
    if let Some(v) = crate::paths::read_data_file("auto_borderless.txt") {
        s.auto_borderless = parse_bool_flag(&v);
    }
    if let Some(raw) = crate::paths::read_data_file("stretched_res.txt") {
        let parts: Vec<&str> = raw.trim().split(':').collect();
        if parts.len() == 2 {
            if let (Ok(w), Ok(h)) = (parts[0].parse(), parts[1].parse()) {
                if w > 0 && h > 0 {
                    s.stretched_w = Some(w);
                    s.stretched_h = Some(h);
                }
            }
        }
    }
    if let Some(raw) = crate::paths::read_data_file("hotkey.txt") {
        let clean = raw.trim().to_string();
        if !clean.is_empty() {
            s.hotkey = Some(clean);
        }
    }
    if let Some(raw) = crate::paths::read_data_file("shortcuts.txt") {
        if !raw.trim().is_empty() {
            s.shortcuts_raw = Some(raw);
        }
    }
    // Overlay monitor lives under LOCALAPPDATA (not the APPDATA data dir),
    // so it is read from its own path instead of `read_data_file`.
    let legacy_monitor = crate::window_manager::overlay_monitor_file()
        .is_file()
        .then(|| std::fs::read_to_string(crate::window_manager::overlay_monitor_file()).ok())
        .flatten()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    // `read_data_file` fallback covers installs where an older build already
    // placed it beside the other prefs.
    s.overlay_monitor = legacy_monitor.or_else(|| {
        crate::paths::read_data_file("overlay_monitor.txt")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    });

    save(&s);
    for name in LEGACY_FILES {
        crate::paths::remove_data_file(name);
    }
    // The LOCALAPPDATA copy is outside `remove_data_file`'s reach.
    let _ = std::fs::remove_file(crate::window_manager::overlay_monitor_file());
    s
}

fn load_all() -> AppSettings {
    if let Some(raw) = crate::paths::read_data_file(SETTINGS_FILE) {
        if let Ok(s) = serde_json::from_str::<AppSettings>(&raw) {
            return s;
        }
        log::warn!("[settings] settings.json unreadable, re-migrating from legacy files");
    }
    migrate_legacy()
}

fn save(s: &AppSettings) {
    match serde_json::to_string_pretty(s) {
        Ok(raw) => {
            let _ = crate::paths::write_data_file(SETTINGS_FILE, &raw);
        }
        Err(e) => log::warn!("[settings] serialize failed: {e}"),
    }
}

fn update(f: impl FnOnce(&mut AppSettings)) -> AppSettings {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut s = load_all();
    f(&mut s);
    save(&s);
    s
}

fn read() -> AppSettings {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_all()
}

// -- Typed accessors (the only API the rest of the crate uses) ---------------

pub fn is_auto_borderless() -> bool {
    read().auto_borderless
}

pub fn set_auto_borderless(enabled: bool) {
    update(|s| s.auto_borderless = enabled);
}

pub fn is_start_minimized() -> bool {
    read().start_minimized
}

pub fn set_start_minimized(enabled: bool) {
    update(|s| s.start_minimized = enabled);
}

pub fn load_hotkey_raw() -> Option<String> {
    read().hotkey
}

pub fn save_hotkey_raw(serialized: &str) {
    update(|s| s.hotkey = Some(serialized.to_string()));
}

pub fn load_stretched() -> Option<(u32, u32)> {
    let s = read();
    match (s.stretched_w, s.stretched_h) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Some((w, h)),
        _ => None,
    }
}

pub fn save_stretched(w: u32, h: u32) {
    update(|s| {
        s.stretched_w = Some(w);
        s.stretched_h = Some(h);
    });
}

pub fn load_overlay_monitor() -> Option<String> {
    read().overlay_monitor
}

pub fn save_overlay_monitor(name: &str) {
    update(|s| s.overlay_monitor = Some(name.to_string()));
}

pub fn load_shortcuts_raw() -> Option<String> {
    read().shortcuts_raw
}

pub fn save_shortcuts_raw(raw: &str) {
    update(|s| s.shortcuts_raw = Some(raw.to_string()));
}
