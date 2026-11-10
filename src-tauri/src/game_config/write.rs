//! The write path. Every write is followed by a read-back (`verify_after_write`):
//! a state that was not read back is a bug, not a success.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use super::discover::parse_config;
use super::ini::*;
use super::model::CustomOptions;

/// Read-back check: re-parse the file and confirm expected values landed.
/// Returns Err with a concrete mismatch description when they didn't.
pub(super) fn verify_after_write(
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

pub(super) fn write_config_inner(
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
