//! Single source of truth for Recon's user-data directory.
//!
//! Data lives in `%APPDATA%\Recon` (Roaming), chosen deliberately over
//! `%LOCALAPPDATA%\Recon`: the latter is the per-user *install* directory
//! (`recon.exe`, `uninstall.exe`, `trnfetch.exe`, `signing\recon.key`), and an
//! uninstall/reinstall there would destroy settings and EDID backups.
//!
//! Older builds stored everything under `%LOCALAPPDATA%\TrueStretchStudio`;
//! `migrate_legacy_data()` copies that directory forward per file, never
//! overwriting and never moving, so an older build still finds its data after
//! a rollback.
//!
//! ponytail: `%APPDATA%` roams on domain-joined machines, and
//! `monitor_res_cache.json`, `stretched_res.txt` and `hotkey.txt` are
//! machine-specific — on a roaming profile they can follow the user to a
//! machine with different monitors. Acceptable for a personal gaming PC; a
//! future split into Roaming-vs-Local data is a conscious choice, not an
//! accident.

use std::fs;
use std::path::{Path, PathBuf};

/// Directory name under `%APPDATA%`.
pub const APP_DIR_NAME: &str = "Recon";
/// Legacy directory name under `%LOCALAPPDATA%`.
pub const LEGACY_DIR_NAME: &str = "TrueStretchStudio";

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

fn app_data_dir_in(base: &Path) -> PathBuf {
    base.join(APP_DIR_NAME)
}

fn create_dir(dir: &Path) -> bool {
    match fs::create_dir_all(dir) {
        Ok(()) => true,
        Err(e) => {
            log::warn!("[paths] cannot create '{}': {e}", dir.display());
            false
        }
    }
}

/// `%APPDATA%\Recon`, created on demand. `None` when `APPDATA` is missing or
/// the directory cannot be created — never panics.
pub fn app_data_dir() -> Option<PathBuf> {
    let dir = app_data_dir_in(&env_dir("APPDATA")?);
    create_dir(&dir).then_some(dir)
}

/// `%LOCALAPPDATA%\TrueStretchStudio`. Never created — migration source only.
pub fn legacy_data_dir() -> Option<PathBuf> {
    Some(env_dir("LOCALAPPDATA")?.join(LEGACY_DIR_NAME))
}

/// Path for `name` inside the app data dir (directory created on demand).
pub fn data_file(name: &str) -> Option<PathBuf> {
    Some(app_data_dir()?.join(name))
}

/// Read `name` from the app data dir, falling back to the legacy dir when the
/// new copy does not exist yet (migration may have been skipped or not run).
pub fn read_data_file(name: &str) -> Option<String> {
    let new_dir = env_dir("APPDATA").map(|base| app_data_dir_in(&base));
    let old_dir = legacy_data_dir();
    match (new_dir, old_dir) {
        (Some(new), Some(old)) => read_data_file_in(&new, &old, name),
        (Some(new), None) => fs::read_to_string(new.join(name)).ok(),
        _ => None,
    }
}

/// Write `name` to the app data dir only. Returns the written path on success.
pub fn write_data_file(name: &str, contents: &str) -> Option<PathBuf> {
    write_data_file_in(&app_data_dir()?, name, contents)
}

/// Remove `name` from the app data dir and the legacy dir. Used for one-shot
/// flag files whose migrated legacy copy would otherwise be replayed by the
/// read fallback on the next launch.
pub fn remove_data_file(name: &str) {
    if let Some(base) = env_dir("APPDATA") {
        remove_data_file_in(&app_data_dir_in(&base), name);
    }
    if let Some(dir) = legacy_data_dir() {
        remove_data_file_in(&dir, name);
    }
}

/// Copy every legacy file into the app data dir. Per-file: an existing
/// destination is left alone (newer data wins), a missing one is copied.
/// Copy, never move — the legacy directory stays intact for rollbacks, so a
/// second run is a no-op. A failing file is logged and does not stop the rest.
pub fn migrate_legacy_data() {
    let (Some(old), Some(new)) = (legacy_data_dir(), app_data_dir()) else {
        log::warn!("[paths] legacy data migration skipped: APPDATA or LOCALAPPDATA not set");
        return;
    };
    let copied = migrate_legacy_data_in(&old, &new);
    if copied > 0 {
        log::info!(
            "[paths] migrated {copied} legacy file(s) from '{}' to '{}'",
            old.display(),
            new.display()
        );
    }
}

// --- test seams: explicit directories, no environment, no global state ---

fn migrate_legacy_data_in(old: &Path, new: &Path) -> usize {
    if !old.is_dir() {
        return 0;
    }
    if !create_dir(new) {
        return 0;
    }
    copy_missing(old, new)
}

fn copy_missing(old: &Path, new: &Path) -> usize {
    let mut copied = 0;
    let entries = match fs::read_dir(old) {
        Ok(entries) => entries,
        Err(e) => {
            log::warn!("[paths] cannot read legacy dir '{}': {e}", old.display());
            return 0;
        }
    };
    for entry in entries.flatten() {
        let src = entry.path();
        let dst = new.join(entry.file_name());
        match entry.file_type() {
            Ok(t) if t.is_dir() => {
                if create_dir(&dst) {
                    copied += copy_missing(&src, &dst);
                }
            }
            _ => {
                if dst.exists() {
                    continue;
                }
                match fs::copy(&src, &dst) {
                    Ok(_) => copied += 1,
                    Err(e) => log::warn!("[paths] cannot migrate '{}': {e}", src.display()),
                }
            }
        }
    }
    copied
}

fn read_data_file_in(new_dir: &Path, legacy_dir: &Path, name: &str) -> Option<String> {
    fs::read_to_string(new_dir.join(name))
        .or_else(|_| fs::read_to_string(legacy_dir.join(name)))
        .ok()
}

fn remove_data_file_in(dir: &Path, name: &str) {
    let _ = fs::remove_file(dir.join(name));
}

fn write_data_file_in(dir: &Path, name: &str, contents: &str) -> Option<PathBuf> {
    let path = dir.join(name);
    match fs::write(&path, contents) {
        Ok(()) => Some(path),
        Err(e) => {
            log::warn!("[paths] write failed for '{}': {e}", path.display());
            None
        }
    }
}

#[cfg(test)]
fn data_file_in(base: &Path, name: &str) -> PathBuf {
    app_data_dir_in(base).join(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    /// A throwaway pair of directories under TEMP, named per test.
    fn tmp_pair(tag: &str) -> (PathBuf, PathBuf) {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("recon-paths-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let new = root.join("Roaming").join("Recon");
        let old = root.join("Local").join("TrueStretchStudio");
        fs::create_dir_all(&new).expect("new dir");
        fs::create_dir_all(&old).expect("legacy dir");
        (new, old)
    }

    #[test]
    fn app_data_dir_resolves_under_base_and_ends_in_recon() {
        // The real `app_data_dir()` reads APPDATA, which tests must not touch;
        // `app_data_dir_in` is the exact same join rule with an injected base.
        let base = Path::new(r"C:\Users\test\AppData\Roaming");
        let dir = app_data_dir_in(base);
        assert_eq!(dir, base.join("Recon"));
        assert_eq!(dir.file_name().unwrap(), "Recon");
        assert_eq!(APP_DIR_NAME, "Recon");
    }

    #[test]
    fn data_file_is_under_the_app_data_dir() {
        let base = Path::new(r"C:\Users\test\AppData\Roaming");
        assert_eq!(
            data_file_in(base, "x.txt"),
            base.join("Recon").join("x.txt")
        );
    }

    #[test]
    fn migration_copies_legacy_file_into_empty_dir() {
        let (new, old) = tmp_pair("copy");
        fs::write(old.join("hotkey.txt"), "f4").unwrap();
        let copied = migrate_legacy_data_in(&old, &new);
        assert_eq!(copied, 1);
        assert_eq!(fs::read_to_string(new.join("hotkey.txt")).unwrap(), "f4");
        // Copy, never move: the legacy copy must survive for rollbacks.
        assert!(old.join("hotkey.txt").exists());
    }

    #[test]
    fn migration_is_idempotent() {
        let (new, old) = tmp_pair("idempotent");
        fs::write(old.join("gpu_settings.json"), r#"{"v":1}"#).unwrap();
        assert_eq!(migrate_legacy_data_in(&old, &new), 1);
        // Newer data edited in place after the first migration.
        fs::write(new.join("gpu_settings.json"), r#"{"v":2}"#).unwrap();
        assert_eq!(migrate_legacy_data_in(&old, &new), 0);
        assert_eq!(
            fs::read_to_string(new.join("gpu_settings.json")).unwrap(),
            r#"{"v":2}"#
        );
    }

    #[test]
    fn migration_does_not_overwrite_a_newer_destination() {
        let (new, old) = tmp_pair("no-overwrite");
        fs::write(new.join("hotkey.txt"), "newer").unwrap();
        fs::write(old.join("hotkey.txt"), "older").unwrap();
        assert_eq!(migrate_legacy_data_in(&old, &new), 0);
        assert_eq!(fs::read_to_string(new.join("hotkey.txt")).unwrap(), "newer");
    }

    #[test]
    fn migration_handles_partial_legacy_dir() {
        let (new, old) = tmp_pair("partial");
        fs::write(old.join("a.txt"), "a").unwrap();
        // b.txt is absent from the legacy dir; tools/ exists with one file.
        fs::create_dir_all(old.join("tools")).unwrap();
        fs::write(old.join("tools").join("restart64.exe"), "MZ").unwrap();
        let copied = migrate_legacy_data_in(&old, &new);
        assert_eq!(copied, 2);
        assert_eq!(fs::read_to_string(new.join("a.txt")).unwrap(), "a");
        assert!(new.join("tools").join("restart64.exe").exists());
        assert!(!new.join("b.txt").exists());
    }

    #[test]
    fn migration_of_missing_legacy_dir_is_a_noop() {
        let (new, old) = tmp_pair("missing");
        fs::remove_dir_all(&old).unwrap();
        assert_eq!(migrate_legacy_data_in(&old, &new), 0);
    }

    #[test]
    fn read_fallback_finds_legacy_file_when_new_one_is_missing() {
        let (new, old) = tmp_pair("fallback");
        fs::write(old.join("stretched_res.txt"), "2090:1440").unwrap();
        assert_eq!(
            read_data_file_in(&new, &old, "stretched_res.txt").unwrap(),
            "2090:1440"
        );
        // New location wins once it exists.
        fs::write(new.join("stretched_res.txt"), "1568:1080").unwrap();
        assert_eq!(
            read_data_file_in(&new, &old, "stretched_res.txt").unwrap(),
            "1568:1080"
        );
    }

    #[test]
    fn writes_never_land_in_the_legacy_directory() {
        let (new, old) = tmp_pair("write");
        let written = write_data_file_in(&new, "auto_borderless.txt", "1").unwrap();
        assert!(written.starts_with(&new));
        assert_eq!(
            fs::read_to_string(new.join("auto_borderless.txt")).unwrap(),
            "1"
        );
        assert_eq!(fs::read_dir(&old).unwrap().count(), 0);
    }

    #[test]
    fn remove_data_file_clears_both_locations() {
        let (new, old) = tmp_pair("remove");
        fs::write(new.join("requested_tab.txt"), "settings").unwrap();
        fs::write(old.join("requested_tab.txt"), "settings").unwrap();
        remove_data_file_in(&new, "requested_tab.txt");
        remove_data_file_in(&old, "requested_tab.txt");
        assert!(!new.join("requested_tab.txt").exists());
        assert!(!old.join("requested_tab.txt").exists());
    }
}
