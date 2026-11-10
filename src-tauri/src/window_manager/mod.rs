//! Win32 window work, in three pieces that do not share state:
//!
//! - `enumeration` reads the desktop (what exists, what is VALORANT, focus).
//! - `borderless` reshapes the game window.
//! - `overlay_window` is the HUD: styles, subclass, placement, edit mode.
//!
//! The HUD module keeps styling and placement together deliberately — see its
//! own doc comment. Everything public is re-exported here so the 41
//! `crate::window_manager::…` call sites did not move with the code.

mod borderless;
mod enumeration;
mod overlay_window;

pub use borderless::{is_window_borderless_fullscreen, make_borderless, restore_window};
pub use enumeration::{
    find_valorant_game_window, is_game_window, is_valorant_foreground, is_valorant_game_window,
    list_visible_windows, WindowInfo,
};
pub(crate) use overlay_window::overlay_monitor_file;
pub use overlay_window::{
    align_overlay_to_valorant, get_overlay_monitor_setting, get_valorant_or_screen_rect,
    install_overlay_subclass, is_tab_down, make_child_windows_clickthrough,
    overlay_clickthrough_missing, overlay_edit_exit_chord_down, overlay_edit_idle_ms,
    overlay_edit_touch, overlay_monitor_rect, overlay_target_rect, restore_blur_behind,
    set_overlay_editable, set_overlay_monitor_setting, set_overlay_windowed,
    setup_overlay_window, strip_all_dwm_borders, toggle_overlay_clickthrough,
    OVERLAY_EDIT_ACTIVITY_MS,
};
