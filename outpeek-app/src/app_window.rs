//! App-window chrome — DWM corner preference and frame colours.
//!
//! This is the *app* window's counterpart to `outpeek_overlay::win_style`,
//! which owns the HUD's hard-edged recipe (DONOTROUND, transparent, no frame).
//! Nothing here may ever run on the HUD HWND: a rounded, captioned frame on a
//! transparent click-through layer is the exact visual bug the overlay recipe
//! exists to prevent. The role split is a typed decision, tested on the Linux
//! host even though only Windows acts on it.
//!
//! Frame colour: the caption is painted with the app's own surface token
//! (`Theme.surface-dim`, `#0e0813` in `outpeek-overlay/ui/tokens.slint`) so the
//! DWM frame belongs to the product instead of the pale system accent.

use outpeek_overlay::roles::WindowRole;

/// `DWMWCP_DONOTROUND` — square corners (the HUD's requirement).
pub const DWMWCP_DONOTROUND: u32 = 1;
/// `DWMWCP_ROUND` — a small radius on all four corners.
pub const DWMWCP_ROUND: u32 = 2;
/// `DWMWCP_ROUNDSMALL` — tighter radius for compact windows (unused today).
pub const DWMWCP_ROUNDSMALL: u32 = 3;

/// `DWMWA_COLOR_NONE` — DWM draws no border line at all.
pub const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;

/// DWM attribute ids. Named because raw numbers are unreadable at the call
/// site and a typo would silently colour the wrong part of the frame.
pub const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
pub const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
pub const DWMWA_BORDER_COLOR: u32 = 34;
pub const DWMWA_CAPTION_COLOR: u32 = 35;

/// Which corner preference a window role gets.
///
/// App: rounded, because it is a normal application window.
/// Overlay: never rounded — its recipe already asks DWM for square corners and
/// the HUD's pixel contract assumes the full rectangle.
pub fn corner_preference(role: WindowRole) -> u32 {
    match role {
        WindowRole::App => DWMWCP_ROUND,
        WindowRole::Overlay => DWMWCP_DONOTROUND,
    }
}

/// `DWMWA_CAPTION_COLOR` / `DWMWA_BORDER_COLOR` take a `COLORREF`, which is
/// `0x00BBGGRR` — blue in the high byte, red in the low byte. Passing an RGB
/// value here paints red and blue swapped, a bug that looks like a wrong
/// palette rather than a wrong API.
pub fn colorref(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

/// `COLORREF` back to a plain `0xRRGGBB` value, for logs only.
pub fn rgb_hex(colorref: u32) -> u32 {
    ((colorref & 0xFF) << 16) | (colorref & 0xFF00) | ((colorref >> 16) & 0xFF)
}

/// One HRESULT per attribute, kept so startup can log what Windows accepted
/// instead of claiming the styling worked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StyleReport {
    pub corner: i32,
    pub border: i32,
    pub caption: i32,
    pub dark_mode: i32,
}

impl StyleReport {
    /// Windows refused an attribute if the HRESULT is negative (`FAILED`).
    /// A refused attribute is a cosmetic miss, never a reason to panic.
    pub fn all_ok(&self) -> bool {
        [self.corner, self.border, self.caption, self.dark_mode]
            .iter()
            .all(|hr| *hr >= 0)
    }

    /// The one startup line that proves what DWM accepted.
    pub fn log_line(&self, caption: u32) -> String {
        format!(
            "app-window chrome: corner=ROUND hr=0x{:08X} border=NONE hr=0x{:08X} \
             caption=#{:06X} hr=0x{:08X} dark-mode hr=0x{:08X}",
            self.corner as u32,
            self.border as u32,
            // COLORREF -> RGB for the log, so the line shows the token colour.
            rgb_hex(caption),
            self.caption as u32,
            self.dark_mode as u32,
        )
    }
}

/// Apply the app-window attributes and report each HRESULT.
///
/// `caption` must be a `COLORREF` (see [`colorref`]). Never panics: a refused
/// attribute is returned in the report for the caller to log.
#[cfg(windows)]
pub fn style_app_window(hwnd: isize, caption: u32) -> StyleReport {
    use std::os::raw::c_void;

    #[link(name = "dwmapi")]
    extern "system" {
        // HWND is a pointer-sized handle; `isize` keeps this module free of the
        // windows-rs types the overlay crate needs for its full recipe.
        fn DwmSetWindowAttribute(
            hwnd: isize,
            attribute: u32,
            value: *const c_void,
            size: u32,
        ) -> i32;
    }

    let set = |attribute: u32, value: u32| -> i32 {
        let size = std::mem::size_of::<u32>() as u32;
        // SAFETY: `value` lives for the whole call and DWM only reads it.
        unsafe {
            DwmSetWindowAttribute(hwnd, attribute, &value as *const u32 as *const c_void, size)
        }
    };

    StyleReport {
        corner: set(
            DWMWA_WINDOW_CORNER_PREFERENCE,
            corner_preference(WindowRole::App),
        ),
        // No accent line around the client area (the pale bar's source).
        border: set(DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE),
        // Paint the caption with the app surface token, not the system accent.
        caption: set(DWMWA_CAPTION_COLOR, caption),
        // Keep caption text/icons light on the dark frame.
        dark_mode: set(DWMWA_USE_IMMERSIVE_DARK_MODE, 1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_window_rounds_and_the_overlay_never_does() {
        assert_eq!(corner_preference(WindowRole::App), DWMWCP_ROUND);
        assert_eq!(corner_preference(WindowRole::Overlay), DWMWCP_DONOTROUND);
        // The two must never agree: one recipe for both windows is the bug.
        assert_ne!(
            corner_preference(WindowRole::App),
            corner_preference(WindowRole::Overlay)
        );
    }

    #[test]
    fn caption_color_uses_dwm_colorref_byte_order() {
        // Theme.surface-dim is #0e0813: red 0x0e, green 0x08, blue 0x13.
        let caption = colorref(0x0e, 0x08, 0x13);
        assert_eq!(caption, 0x0013_080e);
        // COLORREF keeps red in the low byte; RGB would put it in the high one.
        assert_eq!(caption & 0xFF, 0x0e);
        assert_eq!((caption >> 16) & 0xFF, 0x13);
        // The log form round-trips to the token hex.
        assert_eq!(rgb_hex(caption), 0x0e_08_13);
    }

    #[test]
    fn style_report_requires_every_attribute_to_be_accepted() {
        let ok = StyleReport {
            corner: 0,
            border: 0,
            caption: 0,
            dark_mode: 0,
        };
        assert!(ok.all_ok());
        for broken in [
            StyleReport { corner: -1, ..ok },
            StyleReport {
                border: -2147024809,
                ..ok
            },
            StyleReport { caption: -1, ..ok },
            StyleReport {
                dark_mode: -1,
                ..ok
            },
        ] {
            assert!(!broken.all_ok(), "{broken:?} must not pass");
        }
    }

    #[test]
    fn startup_log_line_names_every_attribute_and_the_caption_colour() {
        let report = StyleReport {
            corner: 0,
            border: -1,
            caption: 0,
            dark_mode: 0,
        };
        let line = report.log_line(colorref(0x0e, 0x08, 0x13));
        assert!(line.contains("corner=ROUND"));
        assert!(line.contains("border=NONE"));
        assert!(line.contains("caption=#0E0813"));
        assert!(line.contains("dark-mode"));
        // A refused attribute shows its HRESULT, not a silent success.
        assert!(line.contains("hr=0xFFFFFFFF"));
    }
}
