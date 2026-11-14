//! Which HUD owns the screen — the one resolver every renderer decision goes
//! through.
//!
//! Two HUDs exist: the Tauri `overlay` window (TypeScript) and the native
//! Slint sidecar. Exactly one may be live, so ownership is a single setting
//! (`overlay_renderer`) resolved against the backend fact "is the sidecar
//! healthy right now":
//!
//! - `ts`     → the Tauri window renders; the sidecar is never spawned.
//! - `native` → the sidecar renders; the daemon never shows the Tauri window.
//! - `auto`   → native only while the sidecar answers its health check, TS
//!              otherwise (and after a crash until a respawn proves healthy).
//!
//! Host-agnostic on purpose: this file is compiled by `recon-pure` and tested
//! on any host, so the daemon and the settings UI cannot disagree about what a
//! setting means.

/// The persisted `overlay_renderer` value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayRendererSetting {
    Ts,
    Native,
    Auto,
}

/// The renderer that is actually allowed to render right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveOverlayRenderer {
    Ts,
    Native,
}

impl OverlayRendererSetting {
    /// Missing or unreadable storage means Auto: it degrades to TS by itself,
    /// which is the pre-existing behaviour.
    pub const DEFAULT: Self = Self::Auto;

    /// Unknown strings are Auto, never an error: a hand-edited settings.json
    /// must not leave the app with no HUD.
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "ts" => Self::Ts,
            "native" => Self::Native,
            _ => Self::DEFAULT,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ts => "ts",
            Self::Native => "native",
            Self::Auto => "auto",
        }
    }
}

impl ActiveOverlayRenderer {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ts => "ts",
            Self::Native => "native",
        }
    }
}

/// The whole ownership rule. `sidecar_healthy` is the last probe verdict
/// (`--health` spawn ok), never "the process exists": a sidecar that cannot
/// build its window must not take the screen.
pub fn resolve_renderer(
    setting: OverlayRendererSetting,
    sidecar_healthy: bool,
) -> ActiveOverlayRenderer {
    match setting {
        OverlayRendererSetting::Ts => ActiveOverlayRenderer::Ts,
        OverlayRendererSetting::Native => ActiveOverlayRenderer::Native,
        OverlayRendererSetting::Auto => {
            if sidecar_healthy {
                ActiveOverlayRenderer::Native
            } else {
                ActiveOverlayRenderer::Ts
            }
        }
    }
}
