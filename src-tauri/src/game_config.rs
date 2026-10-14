use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

const SHOOTER_SECTION: &str = "[/Script/ShooterGame.ShooterGameUserSettings]";

/// ini-preserve uses bare names ("Player", not "[Player]").
fn bare_section(section: &str) -> &str {
    let s = section.trim();
    s.strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(s)
}

/// Collapse duplicate keys per section (first wins) before parsing.
/// Heals files polluted by the old text-append bug; ini-preserve's
/// map-style set() then guarantees no new duplicates can ever form.
fn collapse_duplicates(text: &str) -> String {
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
fn load_ini(path: &Path) -> Result<(ini_preserve::Ini, std::fs::Permissions), String> {
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
fn store_ini(
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

/// Full parsed view of a VALORANT GameUserSettings.ini.
/// All value fields are Option so missing keys are visible instead of guessed.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ConfigFileInfo {
    pub path: PathBuf,
    pub display_name: String,
    pub is_read_only: bool,
    pub fullscreen_mode: Option<u32>,
    pub last_confirmed_fullscreen: Option<u32>,
    pub preferred_fullscreen: Option<u32>,
    pub should_letterbox: Option<bool>,
    pub last_letterbox: Option<bool>,
    pub res_x: Option<u32>,
    pub res_y: Option<u32>,
    pub last_confirmed_res_x: Option<u32>,
    pub last_confirmed_res_y: Option<u32>,
    pub desired_w: Option<u32>,
    pub desired_h: Option<u32>,
    pub last_confirmed_desired_w: Option<u32>,
    pub last_confirmed_desired_h: Option<u32>,
    #[serde(default)]
    pub window_pos_x: Option<i32>,
    #[serde(default)]
    pub window_pos_y: Option<i32>,
    #[serde(default)]
    pub resolution_quality: Option<f32>,
    #[serde(default)]
    pub use_desired_screen_height: Option<bool>,
}

/// Per-file result for apply operations — proves the write, not just claims it.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ApplyResult {
    pub path: PathBuf,
    pub display_name: String,
    pub ok: bool,
    pub verified: bool,
    pub message: String,
}

/// Per-file verification against an expected stretch target.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct VerifyResult {
    pub path: PathBuf,
    pub display_name: String,
    pub matches: bool,
    pub details: String,
    #[serde(default)]
    pub health_score: u32,
    #[serde(default)]
    pub is_healthy: bool,
    #[serde(default)]
    pub issues: Vec<String>,
}

/// Custom per-file options for the Valorant Config editor tab.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct CustomOptions {
    pub fullscreen_mode: Option<u32>,
    /// Some(true) = letterbox ON, Some(false) = OFF (stretch), None = leave alone
    pub letterbox: Option<bool>,
    pub res: Option<[u32; 2]>,
    pub desired: Option<[u32; 2]>,
    #[serde(default)]
    pub lock_readonly: bool,
}

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

fn parse_config(path: &Path) -> Option<ConfigFileInfo> {
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

/// Read-back check: re-parse the file and confirm expected values landed.
/// Returns Err with a concrete mismatch description when they didn't.
fn verify_after_write(
    path: &Path,
    expect_fullscreen: Option<u32>,
    expect_letterbox: Option<bool>,
    expect_res: Option<(u32, u32)>,
    expect_desired: Option<(u32, u32)>,
) -> Result<(), String> {
    let info = parse_config(path)
        .ok_or_else(|| format!("Wrote {} but could not re-read it for verification", path.display()))?;

    let mut mismatches: Vec<String> = Vec::new();

    if let Some(exp) = expect_fullscreen {
        if info.fullscreen_mode != Some(exp) {
            mismatches.push(format!(
                "FullscreenMode is {:?}, expected {}",
                info.fullscreen_mode, exp
            ));
        }
        // LastConfirmed/Preferred should follow when we write them.
        if let Some(lc) = info.last_confirmed_fullscreen {
            if lc != exp {
                mismatches.push(format!("LastConfirmedFullscreenMode is {}, expected {}", lc, exp));
            }
        }
    }
    if let Some(exp_lb) = expect_letterbox {
        if info.should_letterbox != Some(exp_lb) {
            mismatches.push(format!(
                "bShouldLetterbox is {:?}, expected {}",
                info.should_letterbox,
                if exp_lb { "True" } else { "False" }
            ));
        }
    }
    if let Some((w, h)) = expect_res {
        if info.res_x != Some(w) || info.res_y != Some(h) {
            mismatches.push(format!(
                "ResolutionSize is {:?}x{:?}, expected {}x{}",
                info.res_x, info.res_y, w, h
            ));
        }
    }
    if let Some((w, h)) = expect_desired {
        if info.desired_w != Some(w) || info.desired_h != Some(h) {
            mismatches.push(format!(
                "DesiredScreen is {:?}x{:?}, expected {}x{}",
                info.desired_w, info.desired_h, w, h
            ));
        }
    }

    if mismatches.is_empty() {
        Ok(())
    } else {
        Err(format!("Verification failed: {}", mismatches.join("; ")))
    }
}

#[allow(clippy::too_many_arguments)]

fn write_config_inner(
    path: &Path,
    set_fullscreen: Option<u32>,
    set_letterbox: Option<bool>,
    set_res: Option<(u32, u32)>,
    set_desired: Option<(u32, u32)>,
    lock_read_only: bool,
) -> Result<(), String> {
    let sec = bare_section(SHOOTER_SECTION);
    let (mut ini, perms) = load_ini(path)?;

    // Map-style edits on an ordered map: existing keys updated in place,
    // missing keys appended to the section. Duplicates are structurally
    // impossible — there is no text appending anywhere on this path.
    if let Some(fm) = set_fullscreen {
        let v = fm.to_string();
        ini.set(sec, "FullscreenMode", &v);
        ini.set(sec, "LastConfirmedFullscreenMode", &v);
        ini.set(sec, "PreferredFullscreenMode", &v);
        if fm == 2 {
            ini.set(sec, "WindowPosX", "0");
            ini.set(sec, "WindowPosY", "0");
        }
    }
    if let Some(lb) = set_letterbox {
        let v = if lb { "True" } else { "False" };
        ini.set(sec, "bShouldLetterbox", v);
        ini.set(sec, "bLastConfirmedShouldLetterbox", v);
    }
    if let Some((w, h)) = set_res {
        ini.set(sec, "ResolutionSizeX", &w.to_string());
        ini.set(sec, "ResolutionSizeY", &h.to_string());
        ini.set(sec, "LastUserConfirmedResolutionSizeX", &w.to_string());
        ini.set(sec, "LastUserConfirmedResolutionSizeY", &h.to_string());
    }
    if let Some((w, h)) = set_desired {
        ini.set(sec, "DesiredScreenWidth", &w.to_string());
        ini.set(sec, "DesiredScreenHeight", &h.to_string());
        ini.set(sec, "LastUserConfirmedDesiredScreenWidth", &w.to_string());
        ini.set(sec, "LastUserConfirmedDesiredScreenHeight", &h.to_string());
    }

    // Engine settings check: Honor Desired Height
    let engine_sec = bare_section("[/Script/Engine.GameUserSettings]");
    ini.set(engine_sec, "bUseDesiredScreenHeight", "True");

    // Scalability Groups: Ensure 100% 3D Render Resolution Scale.
    // Plain `100`: the game never writes this key itself, and the 6-decimal
    // `100.000000` form made the client drop render scale on some machines.
    let scal_sec = bare_section("[ScalabilityGroups]");
    ini.set(scal_sec, "sg.ResolutionQuality", "100");

    // Write unlocked first so verification reads the real bytes.
    store_ini(path, &ini, perms.clone(), false)?;

    // Verify BEFORE re-locking: re-read and confirm values actually landed.
    if let Err(v) = verify_after_write(path, set_fullscreen, set_letterbox, set_res, set_desired) {
        let mut p = perms.clone();
        p.set_readonly(lock_read_only);
        let _ = fs::set_permissions(path, p);
        return Err(v);
    }

    let mut p = perms;
    p.set_readonly(lock_read_only);
    fs::set_permissions(path, p).map_err(|e| e.to_string())?;

    Ok(())
}

pub fn update_config(
    path: &Path,
    set_windowed_and_fill: bool,
    new_res: Option<(u32, u32)>,
    lock_read_only: bool,
) -> Result<(), String> {
    let fm = if set_windowed_and_fill { Some(2) } else { None };
    let lb = if set_windowed_and_fill { Some(false) } else { None };
    // Keep DesiredScreen in sync with the resolution so the game can't
    // snap back to a cached 16:9 DesiredScreen on next launch.
    let desired = new_res;
    write_config_inner(path, fm, lb, new_res, desired, lock_read_only)
}

/// Full custom write from the Valorant Config editor tab.
/// Every field the user touches is verified by re-reading the file.
pub fn update_config_custom(path: &Path, opts: &CustomOptions) -> Result<(), String> {
    if opts.fullscreen_mode.is_none()
        && opts.letterbox.is_none()
        && opts.res.is_none()
        && opts.desired.is_none()
    {
        return Err("Nothing to write: pick at least one setting (fullscreen, letterbox, resolution)".to_string());
    }
    if let Some(fm) = opts.fullscreen_mode {
        if fm > 2 {
            return Err(format!("Invalid FullscreenMode={} (valid: 0, 1, 2)", fm));
        }
    }
    let res = opts.res.map(|r| (r[0], r[1]));
    let desired = opts.desired.map(|r| (r[0], r[1]));
    if let Some((w, h)) = res {
        if w == 0 || h == 0 || w > 7680 || h > 4320 {
            return Err(format!("Invalid resolution {}x{} (range 1-7680 x 1-4320)", w, h));
        }
    }
    write_config_inner(
        path,
        opts.fullscreen_mode,
        opts.letterbox,
        res,
        desired,
        opts.lock_readonly,
    )
}

pub fn apply_to_all_configs(w: u32, h: u32, lock_readonly: bool) -> Result<usize, String> {
    let results = apply_to_all_configs_verbose(w, h, lock_readonly);
    let ok_verified = results.iter().filter(|r| r.ok && r.verified).count();
    if ok_verified == 0 {
        let first_err = results
            .iter()
            .find(|r| !r.ok)
            .map(|r| r.message.clone())
            .unwrap_or_else(|| "Failed to update game configuration files".to_string());
        return Err(first_err);
    }
    Ok(ok_verified)
}

/// Per-file apply with verification — backs the new editor tab + Sync All.
pub fn apply_to_all_configs_verbose(w: u32, h: u32, lock_readonly: bool) -> Vec<ApplyResult> {
    // 1. Ensure GPU scaling is correctly configured for the user's active GPU vendor
    crate::gpu::apply_gpu_scaling_for_active_vendor(true);

    let configs = find_valorant_configs();
    configs
        .iter()
        .map(|cfg| match update_config(&cfg.path, true, Some((w, h)), lock_readonly) {
            Ok(()) => ApplyResult {
                path: cfg.path.clone(),
                display_name: cfg.display_name.clone(),
                ok: true,
                verified: true,
                message: format!("{}×{} verified (FullscreenMode 2, Letterbox False, Pos 0,0)", w, h),
            },
            Err(e) => ApplyResult {
                path: cfg.path.clone(),
                display_name: cfg.display_name.clone(),
                ok: false,
                verified: false,
                message: e,
            },
        })
        .collect()
}

/// Verify every detected config against an expected stretch target.
/// Letterbox is expected OFF (False) for stretch; pass None to skip that check.
pub fn verify_all_configs(expected_w: u32, expected_h: u32) -> Vec<VerifyResult> {
    find_valorant_configs()
        .iter()
        .map(|cfg| {
            let mut issues = Vec::new();
            let mut score = 100u32;

            // 1. Resolution Check
            if cfg.res_x != Some(expected_w) || cfg.res_y != Some(expected_h) {
                issues.push(format!(
                    "Resolution is {}×{} (target: {}×{})",
                    cfg.res_x.map(|n| n.to_string()).unwrap_or_else(|| "none".into()),
                    cfg.res_y.map(|n| n.to_string()).unwrap_or_else(|| "none".into()),
                    expected_w,
                    expected_h
                ));
                score = score.saturating_sub(30);
            }

            // 2. Desired Screen Check
            if cfg.desired_w != Some(expected_w) || cfg.desired_h != Some(expected_h) {
                issues.push(format!(
                    "DesiredScreen is {}×{} (target: {}×{})",
                    cfg.desired_w.map(|n| n.to_string()).unwrap_or_else(|| "none".into()),
                    cfg.desired_h.map(|n| n.to_string()).unwrap_or_else(|| "none".into()),
                    expected_w,
                    expected_h
                ));
                score = score.saturating_sub(15);
            }

            // 3. Letterbox Check (CRITICAL: causes black bars)
            if cfg.should_letterbox != Some(false) || cfg.last_letterbox != Some(false) {
                issues.push("bShouldLetterbox is enabled (causes black bars in-game)".to_string());
                score = score.saturating_sub(30);
            }

            // 4. FullscreenMode Check
            if cfg.fullscreen_mode != Some(2) {
                issues.push(format!(
                    "FullscreenMode is {} (must be 2 / Borderless for True Stretch)",
                    cfg.fullscreen_mode.map(|n| n.to_string()).unwrap_or_else(|| "none".into())
                ));
                score = score.saturating_sub(25);
            }

            // 5. Window Alignment Check
            if let Some(x) = cfg.window_pos_x {
                if x != 0 {
                    issues.push(format!("WindowPosX is {} (causes horizontal misalignment)", x));
                    score = score.saturating_sub(10);
                }
            }
            if let Some(y) = cfg.window_pos_y {
                if y != 0 {
                    issues.push(format!("WindowPosY is {} (causes vertical misalignment)", y));
                    score = score.saturating_sub(10);
                }
            }

            // 6. 3D Render Scale Check (0 to 100% graphics scaling)
            if let Some(rq) = cfg.resolution_quality {
                if (rq - 100.0).abs() > 0.01 {
                    issues.push(format!("3D Render Scale is {:.0}% (should be 100% for full clarity)", rq));
                    score = score.saturating_sub(15);
                }
            }

            // 7. Honor Desired Height Check
            if cfg.use_desired_screen_height == Some(false) {
                issues.push("bUseDesiredScreenHeight is False (should be True to honor desired height)".to_string());
                score = score.saturating_sub(10);
            }

            let is_healthy = issues.is_empty();
            let matches = is_healthy;

            let details = if is_healthy {
                format!(
                    "100% Healthy: {}×{}, FullscreenMode 2, Letterbox OFF, (0,0) flush, 100% Render Scale, Honor Desired Height ON",
                    expected_w, expected_h
                )
            } else {
                format!("Health {}%: {}", score, issues.join(" • "))
            };

            VerifyResult {
                path: cfg.path.clone(),
                display_name: cfg.display_name.clone(),
                matches,
                details,
                health_score: score,
                is_healthy,
                issues,
            }
        })
        .collect()
}

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


#[cfg(test)]
mod tests {
    use super::*;

    fn polluted_tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("aspect_ini_test");
        let _ = fs::create_dir_all(&dir);
        let p = dir.join(name);
        // Simulate the polluted file: keys repeated 30x, as the old bug produced.
        let mut text = String::from("[/Script/ShooterGame.ShooterGameUserSettings]\n");
        for _ in 0..30 {
            text.push_str("ResolutionSizeX=2090\nResolutionSizeY=1440\n");
        }
        text.push_str("FullscreenMode=2\nbShouldLetterbox=False\n");
        fs::write(&p, &text).unwrap();
        p
    }

    #[test]
    fn update_heals_duplicates_to_single_keys() {
        let p = polluted_tmp("heal.ini");
        update_config(&p, true, Some((1280, 960)), false).unwrap();
        let out = fs::read_to_string(&p).unwrap();
        // Count by exact key (trimmed, before '='): ini-preserve may style
        // new keys as "Key = value" — both forms are valid UE4 INI.
        let count_key = |out: &str, key: &str| {
            out.lines()
                .filter(|l| {
                    let t = l.trim();
                    match t.find('=') {
                        Some(i) => t[..i].trim() == key,
                        None => false,
                    }
                })
                .count()
        };
        let has_kv = |out: &str, key: &str, val: &str| {
            out.lines().any(|l| {
                let t = l.trim();
                match t.find('=') {
                    Some(i) => t[..i].trim() == key && t[i + 1..].trim() == val,
                    None => false,
                }
            })
        };
        for key in [
            "ResolutionSizeX",
            "ResolutionSizeY",
            "LastUserConfirmedResolutionSizeX",
            "LastUserConfirmedResolutionSizeY",
            "FullscreenMode",
            "LastConfirmedFullscreenMode",
            "PreferredFullscreenMode",
            "bShouldLetterbox",
            "bLastConfirmedShouldLetterbox",
            "DesiredScreenWidth",
            "DesiredScreenHeight",
        ] {
            let n = count_key(&out, key);
            assert_eq!(n, 1, "key {key} appears {n}x");
        }
        assert!(has_kv(&out, "ResolutionSizeX", "1280"));
        assert!(has_kv(&out, "ResolutionSizeY", "960"));
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn single_key_write_roundtrips_and_creates_section() {
        let p = polluted_tmp("single.ini");
        // Section does not exist yet — must be created, exactly once.
        set_config_value(&p, "[ScalabilityGroups]", "sg.ShadowQuality", "0", false).unwrap();
        // Second write to the same key must update, never duplicate.
        set_config_value(&p, "[ScalabilityGroups]", "sg.ShadowQuality", "3", false).unwrap();
        let out = fs::read_to_string(&p).unwrap();
        assert!(out.contains("[ScalabilityGroups]"));
        let n = out
            .lines()
            .filter(|l| {
                let t = l.trim();
                match t.find('=') {
                    Some(i) => t[..i].trim() == "sg.ShadowQuality",
                    None => false,
                }
            })
            .count();
        assert_eq!(n, 1, "sg.ShadowQuality appears {n}x");
        let has = out.lines().any(|l| {
            let t = l.trim();
            match t.find('=') {
                Some(i) => t[..i].trim() == "sg.ShadowQuality" && t[i + 1..].trim() == "3",
                None => false,
            }
        });
        assert!(has, "sg.ShadowQuality=3 missing");
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn config_sync_and_health_verification() {
        let p = polluted_tmp("sync_health.ini");
        update_config(&p, true, Some((2088, 1440)), true).unwrap();
        let parsed = parse_config(&p).expect("should parse synced config");
        assert_eq!(parsed.res_x, Some(2088));
        assert_eq!(parsed.res_y, Some(1440));
        assert_eq!(parsed.fullscreen_mode, Some(2));
        assert_eq!(parsed.should_letterbox, Some(false));
        assert_eq!(parsed.last_letterbox, Some(false));
        assert_eq!(parsed.window_pos_x, Some(0));
        assert_eq!(parsed.window_pos_y, Some(0));
        assert!(parsed.is_read_only);

        // Verify Engine section bUseDesiredScreenHeight = True
        let raw = fs::read_to_string(&p).unwrap();
        assert!(raw.contains("bUseDesiredScreenHeight=True") || raw.contains("bUseDesiredScreenHeight = True"));
        assert!(raw.contains("sg.ResolutionQuality=100") || raw.contains("sg.ResolutionQuality = 100"));

        // Clean up readonly before removal
        let mut perms = fs::metadata(&p).unwrap().permissions();
        perms.set_readonly(false);
        let _ = fs::set_permissions(&p, perms);
        let _ = fs::remove_file(&p);
    }
}
