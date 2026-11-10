//! Section / setting browsing and single-value edits.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use super::discover::find_valorant_configs;
use super::ini::*;
use super::write::update_config;

/// Raw file text for the "prove it" viewer in the editor tab.
pub fn read_config_raw(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

/// One key=value row from the ShooterGame section — powers the
/// "all settings with friendly names" list in the editor tab.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SettingRow {
    pub key: String,
    pub value: String,
}

/// One section of the ini file with its key=value rows — powers the
/// friendly "every setting explained" editor tab.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SectionInfo {
    pub name: String,
    pub rows: Vec<SettingRow>,
}

/// Every section in the file with all key=value pairs in file order.
/// Duplicates collapse last-wins (matches UE4): a polluted file shows
/// each key once with the value the game actually uses.
pub fn get_all_sections(path: &Path) -> Result<Vec<SectionInfo>, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut sections: Vec<SectionInfo> = Vec::new();
    let mut cur: Option<String> = None;
    for line in content.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            cur = Some(t.to_string());
            if !sections.iter().any(|s| s.name == *t) {
                sections.push(SectionInfo {
                    name: t.to_string(),
                    rows: Vec::new(),
                });
            }
            continue;
        }
        let sec_name = match &cur {
            Some(s) => s.clone(),
            None => continue,
        };
        if t.is_empty() || t.starts_with(';') || t.starts_with('#') {
            continue;
        }
        if let Some(eq) = t.find('=') {
            let key = t[..eq].trim().to_string();
            let value = t[eq + 1..].trim().to_string();
            if key.is_empty() {
                continue;
            }
            if let Some(sec) = sections.iter_mut().find(|s| s.name == sec_name) {
                if let Some(existing) = sec.rows.iter_mut().find(|r| r.key == key) {
                    existing.value = value;
                } else {
                    sec.rows.push(SettingRow { key, value });
                }
            }
        }
    }
    Ok(sections)
}

/// Write a single key inside the given section (creates section/key if
/// missing), then re-read to verify the byte actually landed.
pub fn set_config_value(
    path: &Path,
    section: &str,
    key: &str,
    value: &str,
    lock_read_only: bool,
) -> Result<(), String> {
    let key = key.trim();
    let value = value.trim();
    let section = section.trim();
    if section.is_empty() {
        return Err("Invalid section name: empty".to_string());
    }
    if key.is_empty() || key.contains(['=', '[', ']', '\n', '\r']) {
        return Err(format!("Invalid setting name: {}", key));
    }
    if value.contains(['\n', '\r']) {
        return Err("Invalid setting value: must be a single line".to_string());
    }

    let (mut ini, perms) = load_ini(path)?;
    ini.set(bare_section(section), key, value);
    store_ini(path, &ini, perms.clone(), false)?;

    // Verify by re-reading.
    let sections = get_all_sections(path)?;
    match sections
        .iter()
        .find(|s| s.name == section)
        .and_then(|s| s.rows.iter().find(|r| r.key == key))
    {
        Some(r) if r.value == value => {}
        Some(r) => {
            let mut p = perms.clone();
            p.set_readonly(lock_read_only);
            let _ = fs::set_permissions(path, p);
            return Err(format!(
                "Verification failed: {} is '{}', expected '{}'",
                key, r.value, value
            ));
        }
        None => {
            let mut p = perms.clone();
            p.set_readonly(lock_read_only);
            let _ = fs::set_permissions(path, p);
            return Err(format!("Verification failed: {} missing after write", key));
        }
    }

    let mut p = perms;
    p.set_readonly(lock_read_only);
    fs::set_permissions(path, p).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_letterbox_all(disable_letterbox: bool) -> Result<usize, String> {
    let configs = find_valorant_configs();
    let mut count = 0;
    for cfg in &configs {
        if disable_letterbox {
            if update_config(&cfg.path, true, None, false).is_ok() {
                count += 1;
            }
        } else if let Ok(content) = fs::read_to_string(&cfg.path) {
            let mut was_ro = false;
            if let Ok(meta) = fs::metadata(&cfg.path) {
                if meta.permissions().readonly() {
                    was_ro = true;
                    let mut p = meta.permissions();
                    p.set_readonly(false);
                    let _ = fs::set_permissions(&cfg.path, p);
                }
            }
            let mut new_lines = Vec::new();
            for line in content.lines() {
                if line.starts_with("bShouldLetterbox=") {
                    new_lines.push("bShouldLetterbox=True".to_string());
                } else if line.starts_with("bLastConfirmedShouldLetterbox=") {
                    new_lines.push("bLastConfirmedShouldLetterbox=True".to_string());
                } else {
                    new_lines.push(line.to_string());
                }
            }
            if fs::write(&cfg.path, new_lines.join("\r\n")).is_ok() {
                count += 1;
            }
            if was_ro {
                if let Ok(meta) = fs::metadata(&cfg.path) {
                    let mut p = meta.permissions();
                    p.set_readonly(true);
                    let _ = fs::set_permissions(&cfg.path, p);
                }
            }
        }
    }
    Ok(count)
}

#[allow(dead_code)]
pub fn is_letterbox_disabled_in_configs() -> bool {
    let configs = find_valorant_configs();
    if configs.is_empty() {
        return true;
    }
    for cfg in configs {
        if cfg.should_letterbox == Some(false) {
            return true;
        }
    }
    false
}
