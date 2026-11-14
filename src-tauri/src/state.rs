//! Crate-wide runtime state: overlay flags, fixed budgets, and the two structs
//! Tauri manages.
//!
//! Split out of `lib.rs` by moving code only. `lib.rs` re-exports these names at
//! its root, so `crate::OVERLAY_EDIT_MODE` and friends keep resolving unchanged.

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use crate::display;

pub(crate) static AUTO_BORDERLESS_ENABLED: AtomicBool = AtomicBool::new(false);
pub static OVERLAY_EDIT_MODE: AtomicBool = AtomicBool::new(false);
pub(crate) static OVERLAY_WINDOWED: AtomicBool = AtomicBool::new(false);

/// TRUE once the HUD window was built successfully in `setup`.
///
/// The overlay is no longer a config-created window (`"create": false`): Tauri
/// builds config windows with `.build()?` before our setup runs, so a failed
/// HUD used to abort the entire app. Now its creation is ours, failures are
/// non-fatal, and this flag is the single switch every overlay daemon reads
/// before touching a window.
pub static OVERLAY_AVAILABLE: AtomicBool = AtomicBool::new(false);

/// TRUE when the native Slint sidecar owns the HUD. The overlay daemon and the
/// overlay guard read this before showing, hiding or aligning the Tauri window:
/// two renderers ship in this build, and this one flag is what keeps exactly
/// one HUD on screen. Written only by `overlay_sidecar` (startup, crash
/// hand-back, setting change).
pub(crate) static ACTIVE_RENDERER_NATIVE: AtomicBool = AtomicBool::new(false);

/// Whether the HUD has content worth compositing right now (audit overlay#4).
/// TRUE at boot: the daemon's pre-audit behaviour is preserved until the UI
/// reports its own render gates through `set_overlay_present`.
pub(crate) static OVERLAY_PRESENT: AtomicBool = AtomicBool::new(true);

/// Abandoned-edit budget: edit mode with no mouse activity for this long is
/// force-exited by the overlay guard thread (audit overlay#1b). 90 s is the
/// audit's number: long enough to think, short enough that a stuck fullscreen
/// layer cannot own the mouse for a whole match.
pub(crate) const OVERLAY_EDIT_WATCHDOG_MS: u64 = 90_000;

/// Main window's logical CONTENT size at launch. Mirrored in `tauri.conf.json`
/// (main window `width`/`height`/`minWidth`/`minHeight`). The runtime floor in
/// `setup` uses this single constant because config min sizes are not reliably
/// enforced on undecorated windows on Windows; that floor is grown by the
/// measured undecorated frame delta so it keeps the client area this large.
pub(crate) const MAIN_WINDOW_SIZE_LOGICAL: (f64, f64) = (1210.0, 800.0);

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub(crate) struct DisplayInfo {
    pub current_width: u32,
    pub current_height: u32,
    pub current_hz: u32,
    pub native_width: u32,
    pub native_height: u32,
    pub supported_refresh_rates: Vec<u32>,
    pub active_profile: String,
    pub device_name: String,
}

pub(crate) struct AppState {
    pub hotkey_controller: display::HotkeyController,
    pub preferred_stretched: std::sync::Arc<Mutex<(u32, u32)>>,
}
