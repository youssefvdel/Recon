//! Which window may receive which native style.
//!
//! The click-through recipe (WS_EX_TRANSPARENT + LAYERED, HTTRANSPARENT
//! subclass, no frame, topmost, toolwindow) is correct for exactly one HWND in
//! the process: the HUD. Applying any part of it to the normal app window makes
//! the app unclickable — a failure that looks like a frozen UI, so the choice
//! is a typed decision here instead of a boolean at each call site.
//!
//! Cross-platform on purpose: the rule is testable on the Linux host even
//! though only the Windows path acts on it.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowRole {
    /// Decorated, resizable, taskbar-visible tracker window.
    App,
    /// Transparent, topmost, click-through HUD over the game.
    Overlay,
}

/// Click-through is overlay-only. The app window must never receive
/// WS_EX_TRANSPARENT/LAYERED or the HTTRANSPARENT subclass.
pub fn wants_clickthrough(role: WindowRole) -> bool {
    matches!(role, WindowRole::Overlay)
}

/// Topmost, no-frame, toolwindow and the DWM strip are overlay-only too:
/// decorating the app window this way hides it from the taskbar and pins it
/// over everything.
pub fn wants_overlay_shell(role: WindowRole) -> bool {
    matches!(role, WindowRole::Overlay)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_window_never_gets_the_overlay_recipe() {
        assert!(!wants_clickthrough(WindowRole::App));
        assert!(!wants_overlay_shell(WindowRole::App));
    }

    #[test]
    fn overlay_window_gets_the_overlay_recipe() {
        assert!(wants_clickthrough(WindowRole::Overlay));
        assert!(wants_overlay_shell(WindowRole::Overlay));
    }
}
