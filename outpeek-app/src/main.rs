#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// No console window in release. One process hosts both windows, so there is no
// child process to flash a console.

//! Outpeek app: one process, two windows.
//!
//! * `AppWindow` — the tracker shell (decorated, resizable, taskbar).
//! * `OverlayWindow` — the HUD from `outpeek-overlay`'s compiled UI, created
//!   hidden at startup and shown only while VALORANT is focused and the HUD
//!   toggle is on.
//!
//! One poller publishes `Event`s; this file applies them to both windows on the
//! UI thread. No stdin protocol, no `--parent-pid`, no second executable.

slint::include_modules!();

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use outpeek_app::hud::{self, PLATFORM_SUPPORTS_HUD};
use outpeek_app::model::{self, ClientState, RankView, TrackerSnapshot};
use outpeek_app::overlay_renderer::OverlayRendererSetting;
use outpeek_app::worker::{self, Event, Flags};
use outpeek_app::{paths, PRODUCT_NAME, VERSION};
use outpeek_overlay::ui::OverlayWindow;
use slint::ComponentHandle as _;

/// Persisted HUD toggle. Missing file = on: this app's own HUD is the point.
const RENDERER_FILE: &str = "overlay_renderer.txt";

fn main() {
    // Pin the one proven renderer before any window exists.
    outpeek_overlay::force_femtovg();
    parse_args();
    // Copy-only migrations, exactly once per launch (same rules as the Tauri app).
    paths::migrate_previous_app_data();
    paths::migrate_legacy_data();

    let app = AppWindow::new().expect("outpeek-app: app window");
    // The HUD window is created hidden here; a failure is a notice in the
    // tracker, never a startup failure (the tracker must still work).
    let (overlay, overlay_error) = match OverlayWindow::new() {
        Ok(overlay) => {
            let _ = overlay.hide();
            (Some(overlay), None)
        }
        Err(e) => (None, Some(e.to_string())),
    };
    // PRESENT defaults to 1 for the standalone binary's first-frame contract;
    // the app owns the gate, and it starts closed. Without this the first
    // facts frame would show the HUD before the foreground check ran.
    outpeek_overlay::set_present(false);

    let enabled = Arc::new(AtomicBool::new(load_enabled()));
    let foreground = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let flags = Arc::new(Flags::default());

    // Boot the chrome from the persisted toggle so the first frame is honest.
    let t = app.global::<Tracker>();
    t.set_version(VERSION.into());
    let platform_note = if !PLATFORM_SUPPORTS_HUD {
        "HUD window styling is Win32-only; the overlay stays hidden on this host.".to_string()
    } else if let Some(error) = &overlay_error {
        format!("HUD window could not open: {error}")
    } else {
        String::new()
    };
    if let Some(error) = &overlay_error {
        eprintln!("[{PRODUCT_NAME}] overlay window failed to open: {error}");
    }
    t.set_platform_note(platform_note.into());
    apply_hud(&app, enabled.load(Ordering::Relaxed), false);

    // Overlay close does not kill the app; app close kills the process.
    app.window().on_close_requested(|| {
        let _ = slint::quit_event_loop();
        slint::CloseRequestResponse::HideWindow
    });

    wire_callbacks(&app, &overlay, &enabled, &foreground, &flags);

    // Both background threads start on the first loop iteration:
    // `invoke_from_event_loop` is only accepted once the loop is running.
    {
        let app_weak = app.as_weak();
        let overlay_weak = overlay.as_ref().map(|o| o.as_weak());
        let enabled = enabled.clone();
        let foreground = foreground.clone();
        let stop = stop.clone();
        let flags = flags.clone();
        slint::Timer::single_shot(Duration::ZERO, move || {
            start_worker(app_weak.clone(), overlay_weak.clone(), &flags);
            if let Some(app) = app_weak.upgrade() {
                spawn_foreground_watch(
                    stop.clone(),
                    enabled,
                    foreground,
                    app.as_weak(),
                    overlay_weak,
                );
            }
            if let Some(app) = app_weak.upgrade() {
                hud::spawn_loop_probe(stop.clone());
                maybe_run_repaint_bench(&app);
            }
            // CI/dev smoke hook: close the app through the same path a user
            // close takes, so shutdown (HUD hide, poller stop) is exercised.
            if let Some(ms) = std::env::var("OUTPEEK_SMOKE_EXIT_MS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
            {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(ms));
                    let _ = slint::quit_event_loop();
                });
            }
        });
    }

    let run = app.run();
    // Shutdown: the HUD is the first thing that must go.
    stop.store(true, Ordering::Relaxed);
    flags.stop.store(true, Ordering::Relaxed);
    outpeek_overlay::set_present(false);
    if let Some(overlay) = &overlay {
        let _ = overlay.hide();
    }
    if let Err(e) = run {
        eprintln!("[{PRODUCT_NAME}] event loop error: {e}");
    }
}

/// `--mcp-port PORT` (and `--help`). Slint reads `SLINT_MCP_PORT` at backend
/// init; the flag only fills it when the environment did not.
fn parse_args() {
    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--mcp-port" => {
                i += 1;
                if let Some(port) = args.get(i) {
                    if std::env::var_os("SLINT_MCP_PORT").is_none() {
                        // SAFETY: single-threaded at startup, before any
                        // backend or event loop exists.
                        unsafe { std::env::set_var("SLINT_MCP_PORT", port) };
                    }
                }
            }
            "--help" | "-h" => {
                eprintln!(
                    "usage: outpeek-app [--mcp-port PORT]\n\
                     \n\
                     One process hosts the tracker window and the HUD overlay window.\n\
                     OUTPEEK_LOOP_PROBE=1  logs max event-loop dispatch latency every 5 s\n\
                     OUTPEEK_BENCH_REPAINTS=1  runs the 200-update loop bench once"
                );
                std::process::exit(0);
            }
            other => {
                eprintln!("outpeek-app: unknown argument {other} (try --help)");
                std::process::exit(2);
            }
        }
        i += 1;
    }
}

fn load_enabled() -> bool {
    !matches!(
        paths::read_data_file(RENDERER_FILE)
            .as_deref()
            .map(str::trim),
        Some("ts")
    )
}

fn save_enabled(enabled: bool) {
    let _ = paths::write_data_file(RENDERER_FILE, if enabled { "native" } else { "ts" });
}

fn setting(enabled: bool) -> OverlayRendererSetting {
    if enabled {
        OverlayRendererSetting::Native
    } else {
        OverlayRendererSetting::Ts
    }
}

fn wire_callbacks(
    app: &AppWindow,
    overlay: &Option<OverlayWindow>,
    enabled: &Arc<AtomicBool>,
    foreground: &Arc<AtomicBool>,
    flags: &Arc<Flags>,
) {
    // Kill switch. Persist first, then apply to the live window on this thread
    // so a hitch is isolated by one click instead of an app restart.
    {
        let app_weak = app.as_weak();
        let enabled = enabled.clone();
        let foreground = foreground.clone();
        let overlay_handle: Option<OverlayWindow> = overlay.as_ref().map(|o| o.clone_strong());
        app.on_toggle_hud(move || {
            let now = !enabled.load(Ordering::Relaxed);
            enabled.store(now, Ordering::Relaxed);
            save_enabled(now);
            let fg = foreground.load(Ordering::Relaxed);
            outpeek_overlay::set_present(model::should_show_overlay(
                now,
                setting(now),
                fg,
                PLATFORM_SUPPORTS_HUD,
            ));
            if let Some(overlay) = &overlay_handle {
                outpeek_overlay::hud::sync_visibility(overlay, None);
            }
            if let Some(app) = app_weak.upgrade() {
                apply_hud(&app, now, fg);
            }
        });
    }

    {
        let flags = flags.clone();
        app.on_refresh_rank(move || {
            flags.refresh_rank.store(true, Ordering::Relaxed);
        });
    }
}

fn apply_hud(ui: &AppWindow, enabled: bool, game_foreground: bool) {
    let status = model::hud_status(
        enabled,
        setting(enabled),
        game_foreground,
        PLATFORM_SUPPORTS_HUD,
    );
    let t = ui.global::<Tracker>();
    t.set_hud_enabled(enabled);
    t.set_hud_status(status.text.into());
    t.set_hud_tone(status.tone.as_str().into());
}

fn apply_snapshot(ui: &AppWindow, snap: &TrackerSnapshot) {
    let t = ui.global::<Tracker>();
    t.set_player_display(snap.player_display().into());
    t.set_player_initial(snap.player_initial().into());
    t.set_phase_title(snap.phase_title().into());
    t.set_phase_chip(snap.phase_chip().into());
    t.set_map_name(snap.map.clone().into());
    t.set_mode(snap.mode.clone().into());
    t.set_blue(snap.blue);
    t.set_red(snap.red);
    t.set_live_state(snap.live_state().into());
    t.set_live_message(snap.live_message().into());

    let (line, tone) = match &snap.client {
        ClientState::Starting => ("Connecting to the Riot Client…", "warn"),
        ClientState::Missing => ("Riot Client not running", "warn"),
        ClientState::Ready => ("Riot Client connected", "ok"),
        ClientState::Error(_) => ("Riot Client error", "error"),
    };
    t.set_client_line(line.into());
    t.set_client_tone(tone.into());
}

fn apply_rank(ui: &AppWindow, view: &RankView) {
    let t = ui.global::<Tracker>();
    t.set_rank_state(view.state.as_str().into());
    t.set_rank_label(view.label.clone().into());
    t.set_rank_rr(view.rr as i32);
    t.set_rank_message(view.message.clone().into());
}

fn start_worker(
    app: slint::Weak<AppWindow>,
    overlay: Option<slint::Weak<OverlayWindow>>,
    flags: &Arc<Flags>,
) {
    worker::spawn(
        move |event: Event| {
            let app = app.clone();
            let overlay = overlay.clone();
            let _ = slint::invoke_from_event_loop(move || {
                let Some(app) = app.upgrade() else {
                    return;
                };
                match event {
                    Event::Snapshot(snap) => {
                        apply_snapshot(&app, &snap);
                        if let Some(overlay) = overlay.as_ref().and_then(|weak| weak.upgrade()) {
                            // Same facts, same event loop: properties, not a pipe.
                            outpeek_overlay::hud::apply_facts(&overlay, snap.facts());
                            outpeek_overlay::hud::sync_visibility(&overlay, None);
                        }
                    }
                    Event::Rank(view) => apply_rank(&app, &view),
                }
            });
        },
        flags.clone(),
    );
}

fn spawn_foreground_watch(
    stop: Arc<AtomicBool>,
    enabled: Arc<AtomicBool>,
    foreground: Arc<AtomicBool>,
    app: slint::Weak<AppWindow>,
    overlay: Option<slint::Weak<OverlayWindow>>,
) {
    let _ = std::thread::Builder::new()
        .name("outpeek-foreground".to_string())
        .spawn(move || {
            // Force the first frame: the tracker's HUD status must be right
            // even before the first foreground change.
            let mut last_fg = !hud::game_foreground();
            let mut last_on = !enabled.load(Ordering::Relaxed);
            let mut last_sync = Instant::now();
            loop {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let fg = hud::game_foreground();
                let on = enabled.load(Ordering::Relaxed);
                foreground.store(fg, Ordering::Relaxed);
                let show = model::should_show_overlay(on, setting(on), fg, PLATFORM_SUPPORTS_HUD);
                // Re-assert the HUD every 2 s while it is visible (the cadence
                // the Tauri daemon used for the sidecar): follows a resolution
                // or window move and heals a lost topmost/click-through bit.
                // Transitions are immediate; the periodic pass runs only while
                // shown.
                let resync = show && last_sync.elapsed() >= Duration::from_secs(2);
                if fg != last_fg || on != last_on || resync {
                    last_fg = fg;
                    last_on = on;
                    if resync {
                        last_sync = Instant::now();
                    }
                    let app = app.clone();
                    let overlay = overlay.clone();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(app) = app.upgrade() {
                            apply_hud(&app, on, fg);
                        }
                        if let Some(overlay) = overlay.as_ref().and_then(|weak| weak.upgrade()) {
                            outpeek_overlay::set_present(show);
                            outpeek_overlay::hud::sync_visibility(&overlay, None);
                        }
                    });
                }
                std::thread::sleep(Duration::from_millis(1_000));
            }
        });
}

/// Debug instrumentation for the shared-event-loop risk. OFF by default.
///
/// Pushes 200 tracker property updates through `invoke_from_event_loop` and
/// reports total wall time plus the worst UI-thread dispatch latency. That is
/// the cost of both windows sharing one loop; it is **not** GPU frame time.
/// Run with the HUD visible to make the comparison meaningful.
fn maybe_run_repaint_bench(app: &AppWindow) {
    if std::env::var_os("OUTPEEK_BENCH_REPAINTS").is_none() {
        return;
    }
    let weak = app.as_weak();
    let _ = std::thread::Builder::new()
        .name("outpeek-bench".to_string())
        .spawn(move || {
            // Let the first frame + poller settle, then warm the loop so the
            // measurement is steady state, not renderer startup.
            std::thread::sleep(Duration::from_millis(1_500));
            let (warm_tx, warm_rx) = std::sync::mpsc::channel();
            for _ in 0..5 {
                let tx = warm_tx.clone();
                if slint::invoke_from_event_loop(move || {
                    let _ = tx.send(());
                })
                .is_err()
                {
                    return;
                }
            }
            drop(warm_tx);
            for _ in warm_rx.iter().take(5) {}

            let (tx, rx) = std::sync::mpsc::channel();
            let started = Instant::now();
            let mut posted = 0usize;
            for i in 0..200i32 {
                let at = Instant::now();
                let weak = weak.clone();
                let tx = tx.clone();
                let ok = slint::invoke_from_event_loop(move || {
                    if let Some(app) = weak.upgrade() {
                        app.global::<Tracker>().set_rank_rr(i % 100);
                    }
                    let _ = tx.send(at.elapsed());
                });
                if ok.is_err() {
                    break;
                }
                posted += 1;
            }
            drop(tx);
            let mut max = Duration::ZERO;
            let mut completed = 0usize;
            for waited in rx.iter() {
                max = max.max(waited);
                completed += 1;
            }
            eprintln!(
                "[bench] {completed}/{posted} tracker updates: total={}ms max_dispatch={}ms \
                 (event-loop queue latency, not GPU frame time)",
                started.elapsed().as_millis(),
                max.as_millis()
            );
        });
}
