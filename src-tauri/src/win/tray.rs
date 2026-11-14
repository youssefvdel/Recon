//! Tray icon, its menu and the two window actions behind it.

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

use crate::notify_overlay_unavailable;
use crate::win::overlay::show_overlay;

/// Builds the tray. Command bodies are untouched; this only gives the block a
/// name so `setup` reads as wiring.
pub(crate) fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    // Create System Tray Menu
    let show_i = MenuItem::with_id(app, "show", "Show Outpeek", true, None::<&str>)?;
    let hud_i = MenuItem::with_id(app, "hud", "Show HUD", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit Outpeek", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &hud_i, &quit_i])?;

    if let Some(icon) = app.default_window_icon() {
        let _tray = TrayIconBuilder::new()
            .icon(icon.clone())
            .menu(&menu)
            .show_menu_on_left_click(false)
            .tooltip("Outpeek • Valorant Companion")
            .on_menu_event(|app, event| match event.id.as_ref() {
                "quit" => {
                    app.exit(0);
                }
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
                // An unavailable HUD used to fail silently here. The
                // player gets the reason instead, once per click.
                "hud" => {
                    if let Err(e) = show_overlay(app.clone()) {
                        notify_overlay_unavailable(&e);
                    }
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    let app = tray.app_handle();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
            })
            .build(app)?;
    }
    Ok(())
}
