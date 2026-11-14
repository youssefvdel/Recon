#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// No console window in release (a console-subsystem exe flashes one on the
// user's screen at every spawn — the twin lesson). Stdin/stdout pipes are
// inherited handles and keep working without a console.

//! Outpeek overlay sidecar: a native Slint HUD window driven by the main app.
//!
//! The main app owns every fact; this process only renders. Facts arrive as
//! NDJSON objects on stdin (partial updates, `seq` for ordering); UI events
//! (edit-chrome callbacks) go back out as NDJSON on stdout. stderr is logs.
//!
//! Window contract: winit backend + FemtoVG renderer (forced via
//! `SLINT_BACKEND=winit-femtovg`; the software renderer is not compiled in,
//! so transparency can never silently fall back to an opaque surface). The
//! fullscreen click-through recipe (no `WS_EX_LAYERED`, HTTRANSPARENT
//! subclass, DWM strip) is mirrored from the main app's `overlay_window.rs`
//! in `win_style` — `.slint` only declares no-frame/always-on-top/transparent.
//!
//! Modes: default (stdin-driven HUD), `--probe` (one-shot style/readback
//! dump), `--show-test <secs>` (timed visible pass for screenshots),
//! `--soak <secs>` (hidden style-predicate watch). `--parent-pid <pid>`
//! exits with the main app so a stray fullscreen topmost window is impossible.

mod image_cache;
#[cfg(windows)]
mod win_style;

use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU8, Ordering};

slint::include_modules!();

/// 0 = clicks pass through to the game/desktop, 1 = edit mode captures.
/// Read by the Win32 subclass proc (`win_style`) on WM_NCHITTEST.
static EDIT_MODE: AtomicU8 = AtomicU8::new(0);

/// Whether the HUD has content worth a fullscreen alpha layer right now
/// (mirrors the main app's OVERLAY_PRESENT; the Tab-peek gate owns the fast
/// path there, the window here).
static PRESENT: AtomicU8 = AtomicU8::new(1);

/// Partial facts update from the main app. Every field is optional: only the
/// keys present in the object are applied.
///
/// There is deliberately NO fabrication here: the main app sends only what it
/// owns — window state (rect, edit, visibility, tab, lite) plus the live fact
/// set from the Rust live service (phase, map, mode, scores). Rosters need the
/// core-game payload and stay at their empty `.slint` defaults until then.
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[allow(dead_code)]
struct FactsMsg {
    #[serde(default)]
    seq: u64,
    #[serde(default)]
    present: Option<bool>,
    #[serde(default)]
    edit: Option<bool>,
    #[serde(default)]
    lite: Option<bool>,
    #[serde(default)]
    phase: Option<String>,
    #[serde(default)]
    tab_held: Option<bool>,
    #[serde(default)]
    map: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    phase_label: Option<String>,
    #[serde(default)]
    live: Option<bool>,
    #[serde(default)]
    side: Option<String>,
    #[serde(default)]
    server: Option<String>,
    #[serde(default)]
    blue: Option<i32>,
    #[serde(default)]
    red: Option<i32>,
    #[serde(default)]
    rect: Option<RectMsg>,
    #[serde(default)]
    your_five: Option<Vec<RosterEntry>>,
    #[serde(default)]
    enemy_five: Option<Vec<RosterEntry>>,
    #[serde(default)]
    hint: Option<HintMsg>,
    #[serde(default)]
    whisper: Option<WhisperMsg>,
    #[serde(default)]
    cluster: Option<ClusterMsg>,
    #[serde(default)]
    scale: Option<f32>,
    #[serde(default)]
    display_key: Option<String>,
}

#[derive(Debug, Default, Clone, Copy, serde::Deserialize)]
struct RectMsg {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

#[derive(Debug, Default, Clone, serde::Deserialize)]
struct RosterEntry {
    #[serde(default)]
    name: String,
    #[serde(default)]
    agent: String,
    #[serde(default)]
    icon: String,
    #[serde(default)]
    crest: String,
    #[serde(default)]
    locked: bool,
    #[serde(default)]
    isme: bool,
    #[serde(default)]
    party: i32,
    #[serde(default)]
    rr: i32,
}

#[derive(Debug, Default, Clone, serde::Deserialize)]
struct HintMsg {
    #[serde(default)]
    line: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    win01: f32,
    #[serde(default)]
    games: i32,
}

#[derive(Debug, Default, Clone, serde::Deserialize)]
struct WhisperMsg {
    #[serde(default)]
    text: String,
    #[serde(default)]
    tone: String,
}

#[derive(Debug, Default, Clone, Copy, serde::Deserialize)]
struct ClusterMsg {
    x: f32,
    y: f32,
}

fn emit_event(v: serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", v.to_string());
    let _ = out.flush();
}

fn log_line(msg: &str) {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "[outpeek-overlay] {msg}");
    let _ = err.flush();
}

fn roster_to_facts(entries: Vec<RosterEntry>) -> Vec<PlayerFact> {
    entries
        .into_iter()
        .map(|e| PlayerFact {
            name: e.name.into(),
            agent: e.agent.into(),
            icon: image_cache::load(&e.icon),
            crest: image_cache::load(&e.crest),
            locked: e.locked,
            isme: e.isme,
            party: e.party,
            rr: e.rr,
        })
        .collect()
}

fn apply_facts(win: &OverlayWindow, msg: FactsMsg) {
    let facts = win.global::<Facts>();
    if let Some(v) = msg.present {
        PRESENT.store(u8::from(v), Ordering::Relaxed);
    }
    if let Some(v) = msg.edit {
        EDIT_MODE.store(u8::from(v), Ordering::Relaxed);
        facts.set_edit_mode(v);
    }
    if let Some(v) = msg.lite {
        facts.set_lite(v);
    }
    if let Some(v) = msg.phase {
        facts.set_phase(v.into());
    }
    if let Some(v) = msg.tab_held {
        facts.set_tab_held(v);
    }
    if let Some(v) = msg.map {
        facts.set_map_name(v.into());
    }
    if let Some(v) = msg.mode {
        facts.set_mode(v.into());
    }
    if let Some(v) = msg.phase_label {
        facts.set_phase_label(v.into());
    }
    if let Some(v) = msg.live {
        facts.set_live(v);
    }
    if let Some(v) = msg.side {
        facts.set_side(v.into());
    }
    if let Some(v) = msg.server {
        facts.set_server(v.into());
    }
    if let Some(v) = msg.blue {
        facts.set_blue_score(v);
    }
    if let Some(v) = msg.red {
        facts.set_red_score(v);
    }
    if let Some(list) = msg.your_five {
        let model = std::rc::Rc::new(slint::VecModel::from(roster_to_facts(list)));
        facts.set_your_five(model.into());
    }
    if let Some(list) = msg.enemy_five {
        let model = std::rc::Rc::new(slint::VecModel::from(roster_to_facts(list)));
        facts.set_enemy_five(model.into());
    }
    if let Some(h) = msg.hint {
        facts.set_hint_line(h.line.into());
        facts.set_hint_source(h.source.into());
        facts.set_hint_win01(h.win01);
        facts.set_hint_games(h.games);
    }
    if let Some(w) = msg.whisper {
        facts.set_whisper(w.text.into());
        facts.set_whisper_tone(w.tone.into());
    }
    if let Some(c) = msg.cluster {
        facts.set_cluster_x(c.x);
        facts.set_cluster_y(c.y);
    }
    if let Some(s) = msg.scale {
        facts.set_ui_scale(s.clamp(0.5, 2.0));
    }
    if let Some(k) = msg.display_key {
        facts.set_display_key(k.into());
    }
}

/// Window-level visibility: shown while editing or while the main app says the
/// HUD has content. The `.slint` phase gates (`selecting`/`peeking`) decide
/// what paints inside; this only owns the fullscreen alpha layer itself.
fn sync_visibility(win: &OverlayWindow, rect: Option<RectMsg>) {
    let edit = EDIT_MODE.load(Ordering::Relaxed) == 1;
    let present = PRESENT.load(Ordering::Relaxed) == 1;
    let want_visible = edit || present;
    log_line(&format!(
        "sync_visibility want={want_visible} edit={edit} present={present}"
    ));
    if want_visible {
        // Snapshot focus BEFORE show: activation (if any) happens inside it,
        // so anything sampled later is already us.
        #[cfg(windows)]
        let prev_fg = win_style::foreground();
        // Driver rect wins when the facts carry one; otherwise discover the
        // live game window (same source the TS overlay aligns to).
        #[cfg(windows)]
        let auto_rect = win_style::discover_game_rect();
        #[cfg(not(windows))]
        let auto_rect: Option<(i32, i32, i32, i32)> = None;
        let r = rect.map(|r| (r.x, r.y, r.w, r.h)).or(auto_rect);
        if r.is_none() {
            log_line("sync_visibility: no rect from facts or discovery");
        } else {
            log_line(&format!(
                "sync_visibility rect from {}",
                if rect.is_some() { "facts" } else { "discovery" }
            ));
        }
        if let Some((x, y, w, h)) = r {
            win.window()
                .set_position(slint::PhysicalPosition::new(x, y));
            win.window().set_size(slint::PhysicalSize::new(
                w.max(100) as u32,
                h.max(100) as u32,
            ));
        }
        let show_r = win.show();
        log_line(&format!(
            "show result: {}",
            show_r.as_ref().map(|_| "ok").unwrap_or("ERR")
        ));
        #[cfg(windows)]
        {
            use raw_window_handle::HasWindowHandle as _;
            let handle = win.window().window_handle();
            if let Ok(raw) = handle.window_handle() {
                if let raw_window_handle::RawWindowHandle::Win32(h) = raw.as_raw() {
                    let val = h.hwnd.get() as isize;
                    win_style::apply(val, !edit, r);
                    log_line(&format!("hwnd={val} visible={}", win_style::visible(val)));
                    win_style::refocus_if_stolen(val, prev_fg);
                }
            }
        }
    } else {
        let _ = win.hide();
    }
}

/// Register bundled OFL fonts when present (`<exe>/fonts/*.ttf|*.otf`).
/// Nothing is committed to the repo: without files this is a no-op and the
/// UI falls back to system fonts (see `fonts/README.md`).
fn register_fonts() {
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
                        Err(e) => log_line(&format!("font {}: {e}", p.display())),
                    }
                }
            }
        }
    }
    log_line(&format!("fonts registered from sidecar dir: {registered}"));
}

fn wire_edit_callbacks(win: &OverlayWindow) {
    win.on_toggle_lite(|| {
        emit_event(serde_json::json!({"event": "toggle-lite"}));
    });
    win.on_reset_layout(|| {
        emit_event(serde_json::json!({"event": "reset-layout"}));
    });
    win.on_scale_step(|f| {
        emit_event(serde_json::json!({"event": "scale-step", "step": f}));
    });
    win.on_lock_overlay(|| {
        emit_event(serde_json::json!({"event": "lock-overlay"}));
    });
    win.on_nudge_cluster(|dx, dy| {
        emit_event(serde_json::json!({"event": "nudge-cluster", "dx": dx, "dy": dy}));
    });
}

fn force_femtovg() {
    // FemtoVG-over-wgpu (DX12 on Windows): no WGL anywhere in this process.
    // The software renderer is not compiled in, so a broken GPU path fails
    // closed instead of silently going opaque.
    if std::env::var_os("SLINT_BACKEND").is_none() {
        // SAFETY: single-threaded at startup, before any backend exists.
        unsafe { std::env::set_var("SLINT_BACKEND", "winit-femtovg-wgpu") };
    }
    log_line(&format!(
        "SLINT_BACKEND={}",
        std::env::var("SLINT_BACKEND").unwrap_or_default()
    ));
}

#[cfg(windows)]
fn current_hwnd(win: &OverlayWindow) -> Option<isize> {
    use raw_window_handle::HasWindowHandle as _;
    win.window()
        .window_handle()
        .window_handle()
        .ok()
        .and_then(|h| match h.as_raw() {
            raw_window_handle::RawWindowHandle::Win32(w) => Some(w.hwnd.get() as isize),
            _ => None,
        })
}

fn usage() -> &'static str {
    "usage: outpeek-overlay [--parent-pid N] [--probe] [--show-test SECS] [--soak SECS]"
}

fn main() {
    force_femtovg();
    image_cache::evict_lru(image_cache::CACHE_BUDGET_BYTES);

    let args: Vec<String> = std::env::args().collect();
    let mut parent_pid: Option<u32> = None;
    let mut mode = "run";
    let mut secs: u64 = 0;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--parent-pid" => {
                i += 1;
                parent_pid = args.get(i).and_then(|s| s.parse().ok());
            }
            "--probe" => mode = "probe",
            "--show-test" => {
                mode = "show-test";
                i += 1;
                secs = args.get(i).and_then(|s| s.parse().ok()).unwrap_or(6);
            }
            "--soak" => {
                mode = "soak";
                i += 1;
                secs = args.get(i).and_then(|s| s.parse().ok()).unwrap_or(600);
            }
            "--help" | "-h" => {
                eprintln!("{}", usage());
                return;
            }
            other => {
                eprintln!("unknown arg {other}\n{}", usage());
                std::process::exit(2);
            }
        }
        i += 1;
    }

    #[cfg(windows)]
    if let Some(pid) = parent_pid {
        win_style::watch_parent(pid);
    }
    #[cfg(not(windows))]
    let _ = parent_pid;

    register_fonts();

    match mode {
        "probe" => return run_probe(),
        "show-test" => return run_show_test(secs),
        "soak" => {
            eprintln!("[sidecar] dispatch soak secs={secs}");
            return run_soak(secs);
        }
        _ => {}
    }

    let win = OverlayWindow::new().expect("overlay window");
    wire_edit_callbacks(&win);
    // Boot hidden: the first facts frame decides visibility.
    let _ = win.hide();

    // Stdin NDJSON loop on a worker; Slint owns the main thread.
    let weak = win.as_weak();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut last_rect: Option<RectMsg> = None;
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            let msg: Result<FactsMsg, _> = serde_json::from_str(&line);
            let weak = weak.clone();
            match msg {
                Ok(m) => {
                    if m.rect.is_some() {
                        last_rect = m.rect;
                    }
                    let rect = last_rect;
                    // The event loop may not be spinning yet (facts often
                    // arrive before win.run()): retry until the invoke lands
                    // instead of dropping the frame that shows the window.
                    let weak2 = weak.clone();
                    log_line(&format!("facts received seq={}", m.seq));
                    std::thread::spawn(move || {
                        for attempt in 0..100 {
                            let m2 = m.clone();
                            let done = slint::invoke_from_event_loop({
                                let weak = weak2.clone();
                                move || {
                                    if let Some(w) = weak.upgrade() {
                                        apply_facts(&w, m2);
                                        sync_visibility(&w, rect);
                                    }
                                }
                            });
                            if attempt == 0 {
                                log_line(&format!(
                                    "first invoke {}",
                                    if done.is_ok() { "ok" } else { "pending" }
                                ));
                            }
                            if done.is_ok() {
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(100));
                        }
                    });
                }
                Err(e) => log_line(&format!("bad facts line: {e}")),
            }
        }
        log_line("stdin closed, exiting");
        std::process::exit(0);
    });

    // NOTE: never win.run() here — ComponentHandle::run() calls show()
    // implicitly, flashing an unstyled activating window before the first
    // facts frame. The event loop spins with the window hidden; the first
    // facts frame shows it through sync_visibility (styled + non-activating).
    slint::run_event_loop().expect("overlay event loop");
}

/// Block (test modes only) until the platform HWND materializes, so styles
/// land microseconds after show instead of a fixed 600 ms later. Production
/// (facts path) already applies synchronously in the same invoke closure.
#[cfg(windows)]
fn await_hwnd(win: &OverlayWindow, budget_ms: u64) -> Option<isize> {
    let mut waited = 0;
    while waited < budget_ms {
        if let Some(v) = current_hwnd(win) {
            return Some(v);
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        waited += 20;
    }
    current_hwnd(win)
}

/// Run `f` on the event-loop thread once the platform window exists.
///
/// The HWND only materializes after the first event-loop iteration past
/// `show()` — reading it synchronously always yields nothing (seen live:
/// `--probe` reported `no-hwnd`). So: show, spin the loop, do the work
/// via `invoke_from_event_loop` after a short settle, then quit the loop.
#[cfg(windows)]
fn run_on_loop<F>(win: &OverlayWindow, delay_ms: u64, f: F) -> Result<(), slint::PlatformError>
where
    F: FnOnce(OverlayWindow) + Send + 'static,
{
    win.show()?;
    let weak = win.as_weak();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        let _ = slint::invoke_from_event_loop(move || {
            if let Some(w) = weak.upgrade() {
                f(w);
            }
            let _ = slint::quit_event_loop();
        });
    });
    slint::run_event_loop()
}

#[cfg(windows)]
fn run_probe() {
    let win = OverlayWindow::new().expect("overlay window");
    let t0 = std::time::Instant::now();
    run_on_loop(&win, 50, move |w| {
        if let Some(v) = await_hwnd(&w, 1000) {
            let t1 = std::time::Instant::now();
            win_style::apply(v, true, None);
            let mut p = win_style::probe_json(v);
            p["show_ms"] = serde_json::json!(t0.elapsed().as_millis() as u64);
            p["apply_us"] = serde_json::json!(t1.elapsed().as_micros() as u64);
            p["slint"] = serde_json::json!(env!("CARGO_PKG_VERSION"));
            emit_event(p);
            let _ = w.hide();
        } else {
            emit_event(serde_json::json!({"ok": false, "reason": "no-hwnd"}));
        }
    })
    .expect("probe event loop");
}

#[cfg(not(windows))]
fn run_probe() {
    emit_event(serde_json::json!({"ok": false, "reason": "probe needs Windows"}));
    std::process::exit(1);
}

/// Timed visible pass: show fullscreen-transparent, report show latency, sleep
/// for screenshots, re-probe, hide, report hide latency, exit.
#[cfg(windows)]
fn run_show_test(secs: u64) {
    let win = OverlayWindow::new().expect("overlay window");
    wire_edit_callbacks(&win);
    // Cover the live game window (falls back to primary) so the timed pass
    // proves transparency over VALORANT, not just the desktop.
    let (sw, sh, sx, sy) = win_style::discover_game_rect()
        .map(|(x, y, w, h)| (w, h, x, y))
        .unwrap_or_else(|| {
            use windows::Win32::UI::WindowsAndMessaging::{
                GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN,
            };
            unsafe {
                (
                    GetSystemMetrics(SM_CXSCREEN),
                    GetSystemMetrics(SM_CYSCREEN),
                    0,
                    0,
                )
            }
        });
    win.window()
        .set_position(slint::PhysicalPosition::new(sx, sy));
    win.window()
        .set_size(slint::PhysicalSize::new(sw as u32, sh as u32));
    let t0 = std::time::Instant::now();
    #[cfg(windows)]
    let prev_fg = win_style::foreground();
    win.show().expect("show-test show");
    let weak = win.as_weak();
    // Sleeps live on a worker: the loop thread stays free to composite.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let _ = slint::invoke_from_event_loop({
            let weak = weak.clone();
            let t0 = t0;
            move || {
                if let Some(w) = weak.upgrade() {
                    if let Some(v) = await_hwnd(&w, 1000) {
                        let t1 = std::time::Instant::now();
                        win_style::apply(v, true, Some((sx, sy, sw, sh)));
                        #[cfg(windows)]
                        win_style::refocus_if_stolen(v, prev_fg);
                        emit_event(serde_json::json!({"event": "shown",
                                "show_ms": t0.elapsed().as_millis() as u64,
                                "apply_us": t1.elapsed().as_micros() as u64,
                                "hwnd": v}));
                    }
                }
            }
        });
        std::thread::sleep(std::time::Duration::from_secs(secs));
        let _ = slint::invoke_from_event_loop(move || {
            if let Some(w) = weak.upgrade() {
                if let Some(v) = current_hwnd(&w) {
                    emit_event(win_style::probe_json(v));
                }
                let t1 = std::time::Instant::now();
                let _ = w.hide();
                emit_event(serde_json::json!({"event": "hidden",
                        "hide_ms": t1.elapsed().as_millis() as u64}));
            }
            let _ = slint::quit_event_loop();
        });
    });
    slint::run_event_loop().expect("show-test event loop");
}

#[cfg(not(windows))]
fn run_show_test(_secs: u64) {
    emit_event(serde_json::json!({"ok": false, "reason": "show-test needs Windows"}));
    std::process::exit(1);
}

/// Hidden soak: apply the recipe once, then verify the click-through
/// predicate (`overlay_clickthrough_missing` equivalent) every 30 s.
/// The window stays SHOWN the whole time: a transparent click-through window
/// is already invisible, and hiding it lets the event loop return (it exits
/// when no window is visible), which would end the process before the ticks.
/// Breadcrumb trail on stderr (unbuffered): every early return has a distinct
/// exit code, so a silent death always leaves its last step behind.
#[cfg(windows)]
fn run_soak(secs: u64) {
    use std::sync::{Arc, Mutex};
    eprintln!("[sidecar] soak entry secs={secs}");
    let win = match OverlayWindow::new() {
        Ok(w) => {
            eprintln!("[sidecar] soak window created");
            w
        }
        Err(e) => {
            eprintln!("[sidecar] soak window create FAILED: {e:?}");
            std::process::exit(10);
        }
    };
    if let Err(e) = win.show() {
        eprintln!("[sidecar] soak show FAILED: {e:?}");
        std::process::exit(11);
    }
    eprintln!("[sidecar] soak shown, worker starting");
    let hwnd_cell: Arc<Mutex<Option<isize>>> = Arc::new(Mutex::new(None));
    let weak = win.as_weak();
    let cell = hwnd_cell.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let cell2 = cell.clone();
        let invoked = slint::invoke_from_event_loop({
            let weak = weak.clone();
            move || {
                if let Some(w) = weak.upgrade() {
                    eprintln!("[sidecar] soak invoke landed");
                    if let Some(v) = await_hwnd(&w, 1000) {
                        eprintln!("[sidecar] soak hwnd={v}, applying");
                        win_style::apply(v, true, None);
                        // Deliberately NOT hidden: the loop exits when no
                        // window is visible, which would end the soak before
                        // the first tick. Transparent + HTTRANSPARENT is
                        // already invisible to the user.
                        *cell2.lock().unwrap() = Some(v);
                        eprintln!("[sidecar] soak applied, window stays visible");
                    } else {
                        eprintln!("[sidecar] soak await_hwnd timed out");
                    }
                    // No quit: the loop must stay alive for the ticks.
                } else {
                    eprintln!("[sidecar] soak weak upgrade FAILED");
                }
            }
        });
        eprintln!(
            "[sidecar] soak invoke dispatched: {}",
            if invoked.is_ok() {
                "ok"
            } else {
                "ERR(loop not running?)"
            }
        );
        let mut v = None;
        for _ in 0..100 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if let Some(x) = *cell.lock().unwrap() {
                v = Some(x);
                break;
            }
        }
        let Some(v) = v else {
            eprintln!("[sidecar] soak no HWND after 10s");
            emit_event(serde_json::json!({"ok": false, "reason": "no-hwnd"}));
            std::process::exit(13);
        };
        eprintln!("[sidecar] soak ticking on hwnd={v}");
        let ticks = secs.max(30) / 30;
        let mut bad = 0u32;
        for n in 0..ticks {
            std::thread::sleep(std::time::Duration::from_secs(30.min(secs)));
            let p = win_style::probe_json(v);
            let missing = p["clickthrough_missing"].as_bool().unwrap_or(true);
            // LAYERED is part of the click-through recipe (Tao/winit both set
            // it); only a missing TRANSPARENT bit or a hidden window is bad.
            let layered = p["layered"].as_bool().unwrap_or(false);
            let shown = p["visible"].as_bool().unwrap_or(false);
            if missing || !shown {
                bad += 1;
            }
            eprintln!(
                "[sidecar] soak tick {n}: missing={missing} layered={layered} visible={shown}"
            );
            emit_event(serde_json::json!({"event": "soak-tick", "n": n,
                "clickthrough_missing": missing, "layered": layered, "visible": shown}));
        }
        eprintln!("[sidecar] soak done bad={bad}");
        emit_event(serde_json::json!({"event": "soak-done", "bad_ticks": bad}));
        std::process::exit(if bad == 0 { 0 } else { 1 });
    });
    // Spins until the worker exits the process when the ticks are done.
    eprintln!("[sidecar] soak entering event loop");
    let loop_r = slint::run_event_loop();
    eprintln!("[sidecar] soak event loop ENDED unexpectedly: {loop_r:?}");
    std::process::exit(12);
}

#[cfg(not(windows))]
fn run_soak(_secs: u64) {
    emit_event(serde_json::json!({"ok": false, "reason": "soak needs Windows"}));
    std::process::exit(1);
}
