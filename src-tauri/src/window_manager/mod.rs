//! Win32 window work, one concern per file:
//!
//! - `enumeration` reads the desktop (what exists, what is VALORANT, focus).
//! - `borderless` reshapes the game window.
//! - `overlay_window` styles the HUD: flags, the message subclass, click-through.
//! - `overlay_placement` decides where the HUD goes and aligns it.
//! - `overlay_edit` holds edit-mode bookkeeping (activity clock, idle budget, chord).
//!
//! `overlay_window` keeps style and placement inside the same functions where
//! they genuinely interleave (setup, edit styles, click-through); the rect maths
//! they call lives in `overlay_placement`. Everything public is re-exported here
//! so the `crate::window_manager::…` call sites never moved with the code.

mod borderless;
mod enumeration;
mod overlay_edit;
mod overlay_placement;
mod overlay_window;

pub use borderless::{is_window_borderless_fullscreen, make_borderless, restore_window};
pub use enumeration::{
    find_valorant_game_window, is_game_window, is_valorant_foreground, is_valorant_game_window,
    list_visible_windows, WindowInfo,
};
pub use overlay_edit::{
    overlay_edit_exit_chord_down, overlay_edit_idle_ms, overlay_edit_touch,
    OVERLAY_EDIT_ACTIVITY_MS,
};
pub use overlay_placement::{
    align_overlay_to_valorant, get_overlay_monitor_setting, get_valorant_or_screen_rect,
    overlay_monitor_rect, overlay_target_rect, set_overlay_monitor_setting,
};
pub(crate) use overlay_placement::overlay_monitor_file;
pub use overlay_window::{
    install_overlay_subclass, is_tab_down, make_child_windows_clickthrough,
    overlay_clickthrough_missing, restore_blur_behind, set_overlay_editable, set_overlay_windowed,
    setup_overlay_window, strip_all_dwm_borders, toggle_overlay_clickthrough,
};
