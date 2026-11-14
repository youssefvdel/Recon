//! Window construction and window-scoped behaviour.
//!
//! Named `win`, not `windows`: a root `mod windows` shadows the windows-rs
//! crate for every `windows::Win32::…` path in this crate.

pub(crate) mod daemons;
pub(crate) mod memory;
pub(crate) mod overlay;
pub(crate) mod tray;

// Guards the HUD boundary: `src-tauri/src/win/` owns the overlay's LIFECYCLE only.
//
// Style, hit-test and placement work belongs to `window_manager::overlay_window`.
// Two files claiming "the HUD" is how a fix lands in the wrong one and strands
// clicks, so this fails if a Win32 style/placement token reappears under `win/`.
//
// Moved here from `scripts/overlay-boundary-check.ts`: the guard reads Rust
// source, so it belongs next to it and runs under `cargo test --lib` on the
// Windows target. The bodies are `include_str!`: a missing file is a compile
// error, not a silently skipped scan.
//
// BOUNDARY-MARK-START — the block below is extracted verbatim for the rustc proof.
#[cfg(test)]
mod boundary_tests {
    use std::path::Path;

    /// Win32 window-style / placement tokens that may only exist outside `win/`.
    const FORBIDDEN: [&str; 18] = [
        "SetWindowPos",
        "SetWindowLongPtrW",
        "GetWindowLongPtrW",
        "DwmSetWindowAttribute",
        "MonitorFromWindow",
        "GetMonitorInfoW",
        "HWND_TOPMOST",
        "HTTRANSPARENT",
        "WS_EX_",
        "WS_POPUP",
        "WS_OVERLAPPEDWINDOW",
        "WS_CAPTION",
        "WS_THICKFRAME",
        "SWP_",
        "0x80000000", // WS_POPUP bit
        "0x08000000", // WS_EX_NOACTIVATE bit
        "0x00080000", // WS_EX_LAYERED bit
        "0x00000020", // WS_EX_TRANSPARENT bit
    ];

    /// The scanned files, as `(file name, contents)`.
    ///
    /// `mod.rs` is deliberately absent: it holds this guard's own vocabulary
    /// (`WS_EX_`, …), so scanning it would fail on the guard itself. Nothing is
    /// lost by that — `files_under_win_are_all_scanned` below fails the moment a
    /// `.rs` file appears here that this list does not cover, so a new file
    /// cannot slip past unscanned.
    const SCANNED: [(&str, &str); 4] = [
        ("daemons.rs", include_str!("daemons.rs")),
        ("memory.rs", include_str!("memory.rs")),
        ("overlay.rs", include_str!("overlay.rs")),
        ("tray.rs", include_str!("tray.rs")),
    ];

    /// Win32 tokens found in code (not comments) under `win/`.
    fn violations() -> Vec<String> {
        let mut out = Vec::new();
        for (name, src) in SCANNED {
            for (i, line) in src.split('\n').enumerate() {
                // Comments explain the boundary; only code lines are checked.
                let code = match line.find("//") {
                    Some(at) => &line[..at],
                    None => line,
                };
                for token in FORBIDDEN {
                    if code.contains(token) {
                        out.push(format!("{name}:{}  {token}", i + 1));
                    }
                }
            }
        }
        out
    }

    /// `window_manager::<snake_case>` call sites in the lifecycle file. The old
    /// guard's regex was `window_manager::[a-z_]+`, so a bare `window_manager::`
    /// that is not followed by a snake_case ident does not count.
    fn delegations(src: &str) -> usize {
        const NEEDLE: &str = "window_manager::";
        src.match_indices(NEEDLE)
            .filter(|(at, _)| {
                src[at + NEEDLE.len()..]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_lowercase() || c == '_')
            })
            .count()
    }

    #[test]
    fn no_style_or_placement_code_under_win() {
        let found = violations();
        assert!(
            found.is_empty(),
            "OVERLAY_BOUNDARY_FAIL: window style/placement code found under win/ — it belongs in\n  \
             src-tauri/src/window_manager/overlay_window.rs\n\n{}",
            found.join("\n"),
        );
    }

    #[test]
    fn lifecycle_file_delegates() {
        // A header that says "delegates" while calling nothing would pass the
        // grep and still be the old lie.
        let lifecycle = SCANNED
            .iter()
            .find(|(name, _)| *name == "overlay.rs")
            .map(|(_, src)| *src)
            .expect("overlay.rs is in SCANNED");
        let count = delegations(lifecycle);
        assert!(
            count >= 5,
            "OVERLAY_BOUNDARY_FAIL: win/overlay.rs delegates only {count} calls to window_manager:: — \
             style/placement work is expected to live there, not be re-implemented here",
        );
    }

    #[test]
    fn files_under_win_are_all_scanned() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("win");
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("OVERLAY_BOUNDARY_FAIL: cannot list {}: {e}", dir.display()))
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".rs"))
            .collect();
        names.sort();
        assert!(
            !names.is_empty(),
            "OVERLAY_BOUNDARY_FAIL: no Rust files found under {}",
            dir.display()
        );
        for name in names {
            assert!(
                name == "mod.rs" || SCANNED.iter().any(|(n, _)| *n == name),
                "OVERLAY_BOUNDARY_FAIL: {name} is not scanned by this guard — add it to SCANNED",
            );
        }
    }
}
// BOUNDARY-MARK-END
