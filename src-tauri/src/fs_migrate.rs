//! One-way, copy-only directory handoff between two app-data locations.
//!
//! Used for the product rename (`%APPDATA%\Recon` -> `%APPDATA%\Outpeek`), and
//! deliberately free of `windows`, `tauri` and environment reads so the same
//! file compiles and runs under the host-agnostic test crate (`src-tauri/pure`).
//!
//! Contract, in order:
//! 1. marker present in `dst` -> `AlreadyMigrated` (nothing is touched);
//! 2. `src` is not a directory -> `MissingSource` (the normal fresh install);
//! 3. `dst` already holds entries -> `TargetNotEmpty` (never merge into live
//!    data — an existing install wins);
//! 4. otherwise copy files and subdirectories recursively, then write the
//!    marker with the timestamp and the copy count.
//!
//! `src` is never modified or deleted: an older build still finds its data
//! after a rollback. Per-file failures are collected in the report, not raised:
//! one unreadable file must not stop the rest or block startup.

use std::fs;
use std::io;
use std::path::Path;

/// Marker written into the destination once the handoff completed.
pub const MARKER_FILE: &str = ".migrated-from-recon";

/// Why `migrate_dir` copied nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// Marker present: this migration already ran in an earlier session.
    AlreadyMigrated,
    /// Nothing to migrate — no previous directory exists.
    MissingSource,
    /// The destination already holds data; it is never merged into.
    TargetNotEmpty,
}

/// What one `migrate_dir` call did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct MigrationReport {
    /// Files copied into the destination by this run.
    pub copied: usize,
    /// Set when nothing was attempted.
    pub skipped: Option<SkipReason>,
    /// `path: error` for every file or directory that could not be carried over.
    pub failures: Vec<String>,
}

/// Copy `src` into `dst` recursively, once, guarded by [`MARKER_FILE`].
///
/// Returns `Err` only when the destination cannot be created or the source's
/// top level cannot be listed. Everything else is reported per file, so the
/// caller can log and carry on.
pub fn migrate_dir(src: &Path, dst: &Path) -> io::Result<MigrationReport> {
    // Marker first: a destination holding only the marker is "already
    // migrated", not "empty", and must never re-copy over newer files.
    if dst.join(MARKER_FILE).is_file() {
        return Ok(MigrationReport {
            skipped: Some(SkipReason::AlreadyMigrated),
            ..MigrationReport::default()
        });
    }
    if !src.is_dir() {
        return Ok(MigrationReport {
            skipped: Some(SkipReason::MissingSource),
            ..MigrationReport::default()
        });
    }
    if dir_has_entries(dst)? {
        return Ok(MigrationReport {
            skipped: Some(SkipReason::TargetNotEmpty),
            ..MigrationReport::default()
        });
    }

    fs::create_dir_all(dst)?;
    let mut report = MigrationReport::default();
    copy_tree(src, dst, &mut report)?;

    let marker = format!(
        "from={}\nat_unix={}\ncopied={}\nfailed={}\n",
        src.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        unix_seconds(),
        report.copied,
        report.failures.len()
    );
    let path = dst.join(MARKER_FILE);
    if let Err(e) = fs::write(&path, marker) {
        report.failures.push(format!("{}: {e}", path.display()));
    }
    Ok(report)
}

fn dir_has_entries(dir: &Path) -> io::Result<bool> {
    match fs::read_dir(dir) {
        Ok(mut entries) => Ok(entries.next().is_some()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

fn copy_tree(src: &Path, dst: &Path, report: &mut MigrationReport) -> io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                report.failures.push(format!("{}: {e}", src.display()));
                continue;
            }
        };
        let from = entry.path();
        let to = dst.join(entry.file_name());
        match entry.file_type() {
            Ok(t) if t.is_dir() => {
                if let Err(e) = fs::create_dir_all(&to) {
                    report.failures.push(format!("{}: {e}", to.display()));
                    continue;
                }
                // A nested listing error stops that subtree only.
                if let Err(e) = copy_tree(&from, &to, report) {
                    report.failures.push(format!("{}: {e}", from.display()));
                }
            }
            Ok(t) if t.is_file() => match fs::copy(&from, &to) {
                Ok(_) => report.copied += 1,
                Err(e) => report.failures.push(format!("{}: {e}", from.display())),
            },
            // Symlinks and other kinds carry no settings; nothing to copy.
            Ok(_) => {}
            Err(e) => report.failures.push(format!("{}: {e}", from.display())),
        }
    }
    Ok(())
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC_NAME: &str = "Recon";
    const DST_NAME: &str = "Outpeek";

    /// A throwaway parent holding `<parent>/Recon` and `<parent>/Outpeek`.
    fn pair() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let root = tempfile::tempdir().expect("tempdir");
        let src = root.path().join(SRC_NAME);
        let dst = root.path().join(DST_NAME);
        fs::create_dir_all(&src).expect("source dir");
        (root, src, dst)
    }

    #[test]
    fn copies_nested_files_and_writes_the_marker() {
        let (_root, src, dst) = pair();
        fs::create_dir_all(src.join("cache").join("nested")).unwrap();
        fs::write(src.join("settings.json"), r#"{"v":1}"#).unwrap();
        fs::write(src.join("cache").join("b.bin"), "B").unwrap();
        fs::write(src.join("cache").join("nested").join("a.bin"), "A").unwrap();

        let report = migrate_dir(&src, &dst).expect("migration runs");

        assert_eq!(report.skipped, None);
        assert_eq!(report.copied, 3);
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(
            fs::read_to_string(dst.join("settings.json")).unwrap(),
            r#"{"v":1}"#
        );
        assert_eq!(
            fs::read_to_string(dst.join("cache").join("nested").join("a.bin")).unwrap(),
            "A"
        );
        // Copy, never move: the source stays behind as a rollback fallback.
        assert!(src.join("settings.json").exists());
        assert!(src.join("cache").join("nested").join("a.bin").exists());

        let marker = fs::read_to_string(dst.join(MARKER_FILE)).unwrap();
        assert!(marker.contains("copied=3"), "marker was: {marker}");
        assert!(marker.contains("at_unix="), "marker was: {marker}");
        assert!(
            marker.contains(&format!("from={SRC_NAME}")),
            "marker was: {marker}"
        );
    }

    #[test]
    fn skips_a_non_empty_target() {
        let (_root, src, dst) = pair();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("settings.json"), "old").unwrap();
        fs::write(dst.join("settings.json"), "new").unwrap();

        let report = migrate_dir(&src, &dst).expect("migration decides, not errors");

        assert_eq!(report.skipped, Some(SkipReason::TargetNotEmpty));
        assert_eq!(report.copied, 0);
        // Never merge into live data, and never claim the migration happened.
        assert_eq!(
            fs::read_to_string(dst.join("settings.json")).unwrap(),
            "new"
        );
        assert!(!dst.join(MARKER_FILE).exists());
    }

    #[test]
    fn runs_once_and_honours_the_marker() {
        let (_root, src, dst) = pair();
        fs::write(src.join("settings.json"), "v1").unwrap();
        assert_eq!(migrate_dir(&src, &dst).unwrap().copied, 1);

        // Leave only the marker, so the non-empty-target rule cannot be what
        // blocks the rerun: this isolates the marker check.
        fs::remove_file(dst.join("settings.json")).unwrap();
        fs::write(src.join("late.txt"), "must not travel").unwrap();

        let second = migrate_dir(&src, &dst).expect("second run decides, not errors");

        assert_eq!(second.skipped, Some(SkipReason::AlreadyMigrated));
        assert_eq!(second.copied, 0);
        assert!(!dst.join("late.txt").exists());
    }

    #[test]
    fn is_a_noop_without_a_source_dir() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join(SRC_NAME);
        let dst = root.path().join(DST_NAME);

        let report = migrate_dir(&src, &dst).expect("missing source is not an error");

        assert_eq!(report.skipped, Some(SkipReason::MissingSource));
        assert_eq!(report.copied, 0);
        assert!(!dst.exists());
    }
}
