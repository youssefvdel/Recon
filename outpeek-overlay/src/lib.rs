//! Outpeek overlay library: the Slint HUD surface plus the Win32 shaping that
//! makes it a transparent, click-through, topmost layer.
//!
//! The crate ships two consumers of this same code:
//!
//! 1. the `outpeek-overlay` **binary** (thin `main.rs`): the headless gate
//!    harness and the fallback HUD driven over stdin NDJSON;
//! 2. `outpeek-app`: the one-process app that creates the HUD window next to
//!    its own window and drives the same `Facts` globals in memory.
//!
//! Why the split: window style is a per-HWND property, not a per-process one.
//! Both windows share one event loop, so facts travel as Slint properties
//! instead of a pipe.
//!
//! Safety: read-only. Nothing here touches game memory, injects input, or
//! mutates Riot state.

pub mod hud;
pub mod image_cache;
pub mod roles;
#[cfg(windows)]
pub mod win_style;

/// The generated Slint types for `ui/overlay.slint` (build.rs output).
///
/// `OverlayWindow`, `Facts`, `PlayerFact` and the per-widget components live
/// here so both consumers use one compiled UI, never a copy.
pub mod ui {
    slint::include_modules!();
}

use std::sync::atomic::{AtomicU8, Ordering};

/// 0 = clicks pass through to the game/desktop, 1 = edit mode captures.
/// Read by the Win32 subclass proc in `win_style` on WM_NCHITTEST. Process-
/// wide on purpose: exactly one HUD window exists per process.
pub static EDIT_MODE: AtomicU8 = AtomicU8::new(0);

/// Whether the HUD has a reason to be on screen right now. The driver sets it
/// (foreground + renderer setting in the app; the first facts frame in the
/// standalone binary); `sync_visibility` reads it.
pub static PRESENT: AtomicU8 = AtomicU8::new(1);

/// Pin the one proven renderer: winit + FemtoVG-over-wgpu (DX12 on Windows).
///
/// The OpenGL path is proven blocked on the target machine and the software
/// renderer is not compiled in, so a broken GPU path fails closed instead of
/// silently going opaque (Slint #9507/#4120). Set only when the operator has
/// not chosen a backend, so `SLINT_BACKEND=...` still wins.
pub fn force_femtovg() {
    if std::env::var_os("SLINT_BACKEND").is_none() {
        // SAFETY: called at process startup, before any backend or event loop
        // exists.
        unsafe { std::env::set_var("SLINT_BACKEND", "winit-femtovg-wgpu") };
    }
}

/// Register bundled OFL fonts when present (`<exe>/fonts/*.ttf|*.otf`).
/// Nothing is committed to the repo: without files this is a no-op and the
/// UI falls back to system fonts (see `fonts/README.md`).
pub fn register_fonts() -> usize {
    use slint::fontique_011::fontique;
    let mut registered = 0usize;
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent().map(|p| p.join("fonts")) {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for e in entries.filter_map(|e| e.ok()) {
                    let p = e.path();
                    let is_font = p
                        .extension()
                        .and_then(|x| x.to_str())
                        .map(|x| x.eq_ignore_ascii_case("ttf") || x.eq_ignore_ascii_case("otf"))
                        .unwrap_or(false);
                    if !is_font {
                        continue;
                    }
                    match std::fs::read(&p) {
                        Ok(bytes) => {
                            let blob = fontique::Blob::new(std::sync::Arc::new(bytes));
                            let mut collection = slint::fontique_011::shared_collection();
                            registered += collection.register_fonts(blob, None).len();
                        }
                        Err(e) => eprintln!("[outpeek-overlay] font {}: {e}", p.display()),
                    }
                }
            }
        }
    }
    registered
}

/// Read the process-wide present flag.
pub fn present() -> bool {
    PRESENT.load(Ordering::Relaxed) == 1
}

/// Set the process-wide present flag (the HUD's visibility gate).
pub fn set_present(value: bool) {
    PRESENT.store(u8::from(value), Ordering::Relaxed);
}

/// Read the process-wide edit flag (see [`EDIT_MODE`]).
pub fn edit() -> bool {
    EDIT_MODE.load(Ordering::Relaxed) == 1
}

/// Set the process-wide edit flag (see [`EDIT_MODE`]).
pub fn set_edit(value: bool) {
    EDIT_MODE.store(u8::from(value), Ordering::Relaxed);
}
