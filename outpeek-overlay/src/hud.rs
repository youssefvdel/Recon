//! Facts contract and window driving for the HUD, split out of the binary so
//! the one-process app and the standalone sidecar share one implementation.
//!
//! The main app owns every fact; the HUD only renders. Facts arrive as partial
//! updates (every field optional: only the keys present in an object are
//! applied). There is deliberately NO fabrication here: unknown values stay
//! empty, never placeholders-as-data.
//!
//! Rosters need the core-game payload and stay at the `.slint` empty defaults
//! until a caller fills them.

use crate::image_cache;
use crate::ui::{Facts, OverlayWindow, PlayerFact};
use slint::ComponentHandle as _;

/// How often the pre-show pass retries while the backend is still
/// materialising the native handle.
#[cfg(windows)]
pub const STYLE_HIDDEN_RETRY: std::time::Duration = std::time::Duration::from_millis(20);

/// How long it keeps trying: Slint creates a window's HWND from the event
/// loop's first `create_inactive_windows` pass, i.e. within an iteration or
/// two of a running loop — never at component creation.
#[cfg(windows)]
pub const STYLE_HIDDEN_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);

/// Partial facts update. Every field is optional: only the keys present in the
/// object are applied.
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[allow(dead_code)]
pub struct FactsMsg {
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub present: Option<bool>,
    #[serde(default)]
    pub edit: Option<bool>,
    #[serde(default)]
    pub lite: Option<bool>,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub tab_held: Option<bool>,
    #[serde(default)]
    pub map: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub phase_label: Option<String>,
    #[serde(default)]
    pub live: Option<bool>,
    #[serde(default)]
    pub side: Option<String>,
    #[serde(default)]
    pub server: Option<String>,
    #[serde(default)]
    pub blue: Option<i32>,
    #[serde(default)]
    pub red: Option<i32>,
    #[serde(default)]
    pub rect: Option<RectMsg>,
    #[serde(default)]
    pub your_five: Option<Vec<RosterEntry>>,
    #[serde(default)]
    pub enemy_five: Option<Vec<RosterEntry>>,
    #[serde(default)]
    pub hint: Option<HintMsg>,
    #[serde(default)]
    pub whisper: Option<WhisperMsg>,
    #[serde(default)]
    pub cluster: Option<ClusterMsg>,
    #[serde(default)]
    pub scale: Option<f32>,
    #[serde(default)]
    pub display_key: Option<String>,
}

#[derive(Debug, Default, Clone, Copy, serde::Deserialize, PartialEq, Eq)]
pub struct RectMsg {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct RosterEntry {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub crest: String,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub isme: bool,
    #[serde(default)]
    pub party: i32,
    #[serde(default)]
    pub rr: i32,
}

#[derive(Debug, Default, Clone, serde::Deserialize)]
pub struct HintMsg {
    #[serde(default)]
    pub line: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub win01: f32,
    #[serde(default)]
    pub games: i32,
}

#[derive(Debug, Default, Clone, serde::Deserialize)]
pub struct WhisperMsg {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub tone: String,
}

#[derive(Debug, Default, Clone, Copy, serde::Deserialize)]
pub struct ClusterMsg {
    pub x: f32,
    pub y: f32,
}

/// Roster wire rows → Slint facts. Icons/crests load from the disk cache; a
/// missing file is an empty image, never a placeholder.
pub fn roster_to_facts(entries: Vec<RosterEntry>) -> Vec<PlayerFact> {
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

/// Apply one partial facts frame to the HUD globals. Call [`sync_visibility`]
/// afterwards (the standalone binary does; the app sets present first and
/// syncs once per change).
pub fn apply_facts(win: &OverlayWindow, msg: FactsMsg) {
    let facts = win.global::<Facts>();
    if let Some(v) = msg.present {
        crate::set_present(v);
    }
    if let Some(v) = msg.edit {
        crate::set_edit(v);
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

/// The overlay HWND, when the backend exposes one (Win32 only).
///
/// One place for "how to get the HWND": the pre-show pass and
/// [`sync_visibility`] must address the same window, and the standalone
/// binary's probes use it too.
#[cfg(windows)]
pub fn win32_hwnd(win: &OverlayWindow) -> Option<isize> {
    use raw_window_handle::HasWindowHandle as _;
    let handle = win.window().window_handle();
    let raw = handle.window_handle().ok()?;
    match raw.as_raw() {
        raw_window_handle::RawWindowHandle::Win32(h) => Some(h.hwnd.get() as isize),
        _ => None,
    }
}

/// Apply the overlay recipe at creation, while the window is still hidden.
///
/// `OverlayWindow::new()` hands back a normal Slint window: decorated, and
/// topmost because the `.slint` declares `always-on-top`. The
/// transparent/toolwindow/click-through recipe used to be applied only on the
/// first show, so any path that showed the window before that pass painted a
/// decorated topmost frame over whatever was on screen — the same flash the
/// sidecar already had to fix. Styling is a pure style write and cannot map the
/// window (see `crate::win_style::style_hidden`); [`sync_visibility`] still
/// re-asserts the recipe on every show and on the driver's 2 s cadence.
///
/// Returns whether the recipe ran: false off Windows, for the app window (the
/// [`crate::roles::should_style_hidden`] rule), or when the backend exposes no
/// Win32 HWND yet.
pub fn style_hidden(win: &OverlayWindow, role: crate::roles::WindowRole) -> bool {
    if !crate::roles::should_style_hidden(role) {
        return false;
    }
    #[cfg(windows)]
    {
        if style_hidden_once(win) {
            return true;
        }
        // No HWND yet: Slint creates it from the event loop, not from
        // `OverlayWindow::new()`. Keep trying so the recipe is on the window
        // before anything can show it (and so the startup log can prove it).
        schedule_style_hidden(win.as_weak(), std::time::Instant::now());
        false
    }
    #[cfg(not(windows))]
    {
        let _ = win;
        false
    }
}

/// One pre-show attempt. True when the recipe was written.
#[cfg(windows)]
fn style_hidden_once(win: &OverlayWindow) -> bool {
    match win32_hwnd(win) {
        Some(val) => crate::win_style::style_hidden(val),
        None => false,
    }
}

/// Retry [`style_hidden_once`] on the event loop until it lands or the budget
/// runs out; gives up with one line, never spins.
#[cfg(windows)]
fn schedule_style_hidden(win: slint::Weak<OverlayWindow>, started: std::time::Instant) {
    slint::Timer::single_shot(STYLE_HIDDEN_RETRY, move || {
        let Some(win) = win.upgrade() else {
            return;
        };
        if style_hidden_once(&win) {
            return;
        }
        if started.elapsed() >= STYLE_HIDDEN_BUDGET {
            eprintln!(
                "[outpeek-overlay] style_hidden: no Win32 HWND after {}ms; \
                 the first show will style the window",
                started.elapsed().as_millis()
            );
            return;
        }
        schedule_style_hidden(win.as_weak(), started);
    });
}

/// Window-level visibility: shown while editing or while the driver says the
/// HUD has a reason to be on screen. The `.slint` phase gates
/// (`selecting`/`peeking`) decide what paints inside; this only owns the
/// fullscreen alpha layer itself.
///
/// `rect` wins when the driver computed one; otherwise the live game window is
/// discovered (same source the Tauri app aligns to).
pub fn sync_visibility(win: &OverlayWindow, rect: Option<RectMsg>) {
    let edit = crate::edit();
    let present = crate::present();
    let want_visible = edit || present;
    eprintln!(
        "[outpeek-overlay] sync_visibility want={want_visible} edit={edit} present={present}"
    );
    if want_visible {
        // Snapshot focus BEFORE show: activation (if any) happens inside it,
        // so anything sampled later is already us.
        #[cfg(windows)]
        let prev_fg = crate::win_style::foreground();
        // Driver rect wins when the facts carry one; otherwise discover the
        // live game window (same source the TS overlay aligns to).
        #[cfg(windows)]
        let auto_rect = crate::win_style::discover_game_rect();
        #[cfg(not(windows))]
        let auto_rect: Option<(i32, i32, i32, i32)> = None;
        let r = rect.map(|r| (r.x, r.y, r.w, r.h)).or(auto_rect);
        if r.is_none() {
            eprintln!("[outpeek-overlay] sync_visibility: no rect from facts or discovery");
        } else {
            eprintln!(
                "[outpeek-overlay] sync_visibility rect from {}",
                if rect.is_some() { "facts" } else { "discovery" }
            );
        }
        if let Some((x, y, w, h)) = r {
            win.window()
                .set_position(slint::PhysicalPosition::new(x, y));
            win.window().set_size(slint::PhysicalSize::new(
                w.max(100) as u32,
                h.max(100) as u32,
            ));
        }
        // Recipe first, map second: a window that is still hidden gets the
        // full popup/toolwindow/transparent/click-through style, so the very
        // first ShowWindow maps a HUD — never a decorated topmost frame. The
        // pass cannot show the window, and a window that is already visible
        // is left for the re-assert below (same write, no double work).
        #[cfg(windows)]
        if let Some(val) = win32_hwnd(win) {
            if !crate::win_style::visible(val) {
                crate::win_style::apply(val, !edit, r);
            }
        }
        let show_r = win.show();
        eprintln!(
            "[outpeek-overlay] show result: {}",
            show_r.as_ref().map(|_| "ok").unwrap_or("ERR")
        );
        #[cfg(windows)]
        {
            if let Some(val) = win32_hwnd(win) {
                crate::win_style::apply(val, !edit, r);
                eprintln!(
                    "[outpeek-overlay] hwnd={val} visible={}",
                    crate::win_style::visible(val)
                );
                crate::win_style::refocus_if_stolen(val, prev_fg);
            }
        }
    } else {
        let _ = win.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn facts_msg_parses_a_partial_frame() {
        let msg: FactsMsg =
            serde_json::from_str(r#"{"seq":7,"phase":"coregame","map":"Ascent","blue":4,"red":2}"#)
                .unwrap();
        assert_eq!(msg.seq, 7);
        assert_eq!(msg.phase.as_deref(), Some("coregame"));
        assert_eq!(msg.map.as_deref(), Some("Ascent"));
        assert_eq!(msg.blue, Some(4));
        assert_eq!(msg.red, Some(2));
        // Absent keys stay unset: a partial frame never clears the rest.
        assert_eq!(msg.mode, None);
        assert_eq!(msg.rect, None);
        assert_eq!(msg.your_five, None);
    }

    #[test]
    fn facts_msg_empty_object_applies_nothing() {
        let msg: FactsMsg = serde_json::from_str("{}").unwrap();
        assert_eq!(msg.seq, 0);
        assert!(msg.present.is_none());
        assert!(msg.phase.is_none());
        assert!(msg.edit.is_none());
    }

    #[test]
    fn facts_msg_ignores_unknown_keys() {
        // Forward compatibility: a newer driver may send keys this build does
        // not know, and that must not drop the frame.
        let msg: FactsMsg =
            serde_json::from_str(r#"{"phase":"pregame","future_field":{"x":1}}"#).unwrap();
        assert_eq!(msg.phase.as_deref(), Some("pregame"));
    }

    #[test]
    fn rect_msg_parses_wire_shape() {
        let msg: FactsMsg =
            serde_json::from_str(r#"{"rect":{"x":-8,"y":0,"w":1920,"h":1080}}"#).unwrap();
        assert_eq!(
            msg.rect,
            Some(RectMsg {
                x: -8,
                y: 0,
                w: 1920,
                h: 1080
            })
        );
    }

    #[test]
    fn roster_rows_map_to_slint_facts() {
        let facts = roster_to_facts(vec![RosterEntry {
            name: "Jett".into(),
            agent: "Jett".into(),
            icon: String::new(),
            crest: String::new(),
            locked: true,
            isme: true,
            party: 2,
            rr: 74,
        }]);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].name.as_str(), "Jett");
        assert_eq!(facts[0].agent.as_str(), "Jett");
        assert!(facts[0].locked);
        assert!(facts[0].isme);
        assert_eq!(facts[0].party, 2);
        assert_eq!(facts[0].rr, 74);
        // An empty icon is the empty slot, never a placeholder image.
        assert_eq!(facts[0].icon.size().width, 0);
    }
}
