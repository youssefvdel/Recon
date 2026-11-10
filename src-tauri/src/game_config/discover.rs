//! Finding the config files on disk and parsing one into `ConfigFileInfo`.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use super::ini::*;
use super::model::ConfigFileInfo;

pub fn find_valorant_configs() -> Vec<ConfigFileInfo> {
    let mut configs = Vec::new();
    let local_app_data = match std::env::var("LOCALAPPDATA") {
        Ok(val) => PathBuf::from(val),
        Err(_) => return configs,
    };

    let base_config_dir = local_app_data.join("VALORANT").join("Saved").join("Config");
    if !base_config_dir.exists() {
        return configs;
    }

    // Search recursively for GameUserSettings.ini
    let mut dirs_to_visit = vec![base_config_dir];
    while let Some(current_dir) = dirs_to_visit.pop() {
        if let Ok(entries) = fs::read_dir(&current_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    dirs_to_visit.push(path);
                } else if path.file_name().and_then(|n| n.to_str()) == Some("GameUserSettings.ini") {
                    if let Some(info) = parse_config(&path) {
                        configs.push(info);
                    }
                }
            }
        }
    }

    configs
}

pub(super) fn parse_config(path: &Path) -> Option<ConfigFileInfo> {
    let metadata = fs::metadata(path).ok()?;
    let is_read_only = metadata.permissions().readonly();

    let mut content = String::new();
    let mut file = File::open(path).ok()?;
    let _ = file.read_to_string(&mut content);

    let mut fullscreen_mode = None;
    let mut last_confirmed_fullscreen = None;
    let mut preferred_fullscreen = None;
    let mut should_letterbox = None;
    let mut last_letterbox = None;
    let mut res_x = None;
    let mut res_y = None;
    let mut last_confirmed_res_x = None;
    let mut last_confirmed_res_y = None;
    let mut desired_w = None;
    let mut desired_h = None;
    let mut last_confirmed_desired_w = None;
    let mut last_confirmed_desired_h = None;
    let mut window_pos_x = None;
    let mut window_pos_y = None;
    let mut resolution_quality = None;
    let mut use_desired_screen_height = None;

    // Whitespace-tolerant like UE4 itself: "Key=value" and "Key = value"
    // both parse (ini-preserve writes new keys spaced).
    for line in content.lines() {
        let t = line.trim();
        let eq = match t.find('=') {
            Some(i) => i,
            None => continue,
        };
        let k = t[..eq].trim();
        let v = t[eq + 1..].trim();
        match k {
            "FullscreenMode" => fullscreen_mode = v.parse::<u32>().ok(),
            "LastConfirmedFullscreenMode" => last_confirmed_fullscreen = v.parse::<u32>().ok(),
            "PreferredFullscreenMode" => preferred_fullscreen = v.parse::<u32>().ok(),
            "bLastConfirmedShouldLetterbox" => last_letterbox = Some(v.eq_ignore_ascii_case("true")),
            "bShouldLetterbox" => should_letterbox = Some(v.eq_ignore_ascii_case("true")),
            "LastUserConfirmedResolutionSizeX" => last_confirmed_res_x = v.parse::<u32>().ok(),
            "LastUserConfirmedResolutionSizeY" => last_confirmed_res_y = v.parse::<u32>().ok(),
            "ResolutionSizeX" => res_x = v.parse::<u32>().ok(),
            "ResolutionSizeY" => res_y = v.parse::<u32>().ok(),
            "LastUserConfirmedDesiredScreenWidth" => last_confirmed_desired_w = v.parse::<u32>().ok(),
            "LastUserConfirmedDesiredScreenHeight" => last_confirmed_desired_h = v.parse::<u32>().ok(),
            "DesiredScreenWidth" => desired_w = v.parse::<u32>().ok(),
            "DesiredScreenHeight" => desired_h = v.parse::<u32>().ok(),
            "WindowPosX" => window_pos_x = v.parse::<i32>().ok(),
            "WindowPosY" => window_pos_y = v.parse::<i32>().ok(),
            "sg.ResolutionQuality" => resolution_quality = v.parse::<f32>().ok(),
            "bUseDesiredScreenHeight" => use_desired_screen_height = Some(v.eq_ignore_ascii_case("true")),
            _ => {}
        }
    }

    let parent_folder = path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let display_name = if parent_folder == "Config" {
        "Global Default Settings (WindowsClient)".to_string()
    } else if !parent_folder.is_empty() {
        format!("Player Account Profile ({})", &parent_folder[..parent_folder.len().min(8)])
    } else {
        "Valorant Client Settings".to_string()
    };

    Some(ConfigFileInfo {
        path: path.to_path_buf(),
        display_name,
        is_read_only,
        fullscreen_mode,
        last_confirmed_fullscreen,
        preferred_fullscreen,
        should_letterbox,
        last_letterbox,
        res_x,
        res_y,
        last_confirmed_res_x,
        last_confirmed_res_y,
        desired_w,
        desired_h,
        last_confirmed_desired_w,
        last_confirmed_desired_h,
        window_pos_x,
        window_pos_y,
        resolution_quality,
        use_desired_screen_height,
    })
}
