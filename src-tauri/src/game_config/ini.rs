//! INI primitives: section names, duplicate collapsing, load and store.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

pub(super) const SHOOTER_SECTION: &str = "[/Script/ShooterGame.ShooterGameUserSettings]";

/// ini-preserve uses bare names ("Player", not "[Player]").
pub(super) fn bare_section(section: &str) -> &str {
    let s = section.trim();
    s.strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(s)
}

/// Collapse duplicate keys per section (first wins) before parsing.
/// Heals files polluted by the old text-append bug; ini-preserve's
/// map-style set() then guarantees no new duplicates can ever form.
pub(super) fn collapse_duplicates(text: &str) -> String {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut cur = String::new();
    for line in text.split('\n') {
        // Work on \n-split text; tolerate CRLF leftovers.
        let ln = line.strip_suffix('\r').unwrap_or(line);
        let t = ln.trim();
        if t.starts_with('[') && t.ends_with(']') {
            cur = t.to_string();
            out.push(ln.to_string());
            continue;
        }
        if !cur.is_empty() && !t.is_empty() && !t.starts_with(';') && !t.starts_with('#') {
            if let Some(eq) = t.find('=') {
                let k = t[..eq].trim();
                if !k.is_empty() {
                    let id = format!("{}\x00{}", cur, k);
                    if !seen.insert(id) {
                        continue; // duplicate → drop
                    }
                }
            }
        }
        out.push(ln.to_string());
    }
    out.join("\n")
}

/// Read + unlock + parse. Returns the document and the
/// original permissions to reuse when storing.
pub(super) fn load_ini(path: &Path) -> Result<(ini_preserve::Ini, std::fs::Permissions), String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let perms = meta.permissions();
    if perms.readonly() {
        let mut p = perms.clone();
        p.set_readonly(false);
        fs::set_permissions(path, p).map_err(|e| e.to_string())?;
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let clean = collapse_duplicates(raw.trim_start_matches('\u{FEFF}'));
    ini_preserve::Ini::parse(&clean)
        .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
        .map(|ini| (ini, perms))
}

/// Serialize back with UE4-style CRLF, then apply the lock state.
/// Only values passed to set() change — layout, comments and spacing
/// stay byte-identical to what the game wrote.
pub(super) fn store_ini(
    path: &Path,
    ini: &ini_preserve::Ini,
    mut perms: std::fs::Permissions,
    lock_read_only: bool,
) -> Result<(), String> {
    let text = ini.to_string().replace("\r\n", "\n").replace('\n', "\r\n");
    fs::write(path, text).map_err(|e| e.to_string())?;
    perms.set_readonly(lock_read_only);
    fs::set_permissions(path, perms).map_err(|e| e.to_string())?;
    Ok(())
}
