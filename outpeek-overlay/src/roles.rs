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

/// The recipe is applied at creation, while the HWND is still hidden, and
/// again on every show.
///
/// Overlay only, and the pre-show pass is the one that matters: a fresh Slint
/// window is decorated (and topmost when the `.slint` says always-on-top), so
/// waiting for the first show to restyle it puts winit's default frame on the
/// user's screen — the decorated topmost flash the sidecar already shipped
/// once. The app window must keep its decoration (taskbar, resize grip,
/// activation), so it is never restyled before it appears.
pub fn should_style_hidden(role: WindowRole) -> bool {
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

    #[test]
    fn only_the_overlay_is_styled_while_hidden() {
        // The HUD must never be shown with winit's default decorated frame,
        // even for one frame; the app window must keep its decoration.
        assert!(should_style_hidden(WindowRole::Overlay));
        assert!(!should_style_hidden(WindowRole::App));
    }

    #[test]
    fn pre_show_styling_never_contradicts_the_shell_rule() {
        // Anything styled before its first show must also pass the normal
        // recipe rule: no window gets a pre-show pass the live path refuses.
        for role in [WindowRole::App, WindowRole::Overlay] {
            if should_style_hidden(role) {
                assert!(wants_overlay_shell(role));
                assert!(wants_clickthrough(role));
            }
        }
    }
}
