#![allow(dead_code)]
//! (moved verbatim from `trn_proxy.rs`; split only.)
use super::constants::{MAX_SLOT_CHARS};

#[derive(serde::Deserialize)]
pub(super) struct SlotResult {
    pub(super) ok: bool,
    pub(super) status: u16,
    pub(super) body: String,
    /// Untruncated body length in UTF-16 units — the same unit the in-page
    /// `.slice()` counts, so `len > MAX_SLOT_CHARS` means "the slice cut this".
    /// Defaults to 0 so a slot written by an older build still decodes.
    #[serde(default)]
    pub(super) len: usize,
}

/// Strict path allowlist (/api/ only, no whitespace, ≤300 chars).
/// Pure — unit-tested.
pub(super) fn validate_path(path: &str) -> Result<(), String> {
    if path.contains([' ', '\n', '\r']) || !path.starts_with("/api/") {
        return Err("Invalid path.".to_string());
    }
    if path.len() > 300 {
        return Err("Path too long.".to_string());
    }
    Ok(())
}

/// Pause iff Valorant is the FOREGROUND window AND the match is live
/// (coregame/ingame/unknown) — the only real FPS risk is the user watching
/// live gameplay. Fetch freely when pregame/lobby/menus is detected, or when
/// the game is not foreground (tabbed out looking at Outpeek: zero FPS risk).
/// Rect checks are deliberately excluded: a tabbed-out borderless window
/// keeps its size, so rect-only detection over-blocks forever.
/// Exclusive-fullscreen always holds focus while visible, so it stays
/// covered. `phase` is TS's best-known match phase (Riot-local gives it
/// free); unknown/blank + foreground still pauses. `drain` exempts an
/// already-budgeted lobby fill: dispatched pre-flip, it runs to completion
/// across the phase flip (bounded ≤10, ladder-guarded) instead of abandoning
/// the batch. Pure (all facts injected) — unit-tested.
pub(super) fn should_pause(game_present: bool, game_foreground: bool, phase: &str, drain: bool) -> bool {
    // Dispatched drain: the budget was claimed while unpaused — finishing a
    // bounded batch of light JSON fetches is harmless (loading screens don't
    // need FPS) and dash-abandonment is worse.
    if drain {
        return false;
    }
    if !game_present || !game_foreground {
        return false;
    }
    match phase.trim().to_lowercase().as_str() {
        // Menus, lobby, agent-select, queue: always fetch (hidden window +
        // budgeted + ladder-guarded costs ~zero FPS — and this is the only
        // window where pre-fetch can run).
        "pregame" | "lobby" | "menu" | "menus" | "idle" => false,
        // Foreground live gameplay / unknown: a hidden fetch would steal
        // GPU/scheduler time mid-match for data nobody reads until tab-out.
        _ => true,
    }
}

/// True iff the Valorant window currently owns user focus. Focus-only by
/// design (see `should_pause`): never a rect check.
pub(super) fn game_has_focus() -> bool {
    if crate::window_manager::find_valorant_game_window().is_none() {
        return false;
    }
    crate::window_manager::is_valorant_foreground()
}

/// Document-start Warden observer, injected into BOTH tracker.gg windows (the
/// hidden proxy and the visible verify window).
///
/// Observation only, and deliberately so: every wrapper calls through with the
/// original `this`/arguments and returns the original result, so the page's
/// fetch/XHR behaviour is unchanged. It records the `X-Warden-Challenge-Passed`
/// value tracker.gg's own JS sends on a request or receives on a response into
/// `window.__reconWarden = {token, ts}`; `trn_warden_token` reads that. Replay
/// is NOT wired — a token is evidence a human pass happened, nothing more.
///
/// A broken init script would take the proxy window down with it, so every
/// layer is wrapped in try/catch and nothing is ever thrown or re-thrown.
pub(super) const WARDEN_HOOK_JS: &str = r#"
(function () {
  try {
    if (window.__reconWardenHooked) return;
    window.__reconWardenHooked = true;
    window.__reconWarden = { token: '', ts: 0 };
    var K = 'x-warden-challenge-passed';
    function note(v) {
      if (!v) return;
      try { window.__reconWarden = { token: String(v), ts: Date.now() }; } catch (e) {}
    }
    function fromInit(init) {
      try {
        var h = init && init.headers;
        if (!h) return;
        if (typeof h.get === 'function') return h.get('X-Warden-Challenge-Passed');
        if (Array.isArray(h)) {
          for (var i = 0; i < h.length; i++) {
            if (String((h[i] && h[i][0]) || '').toLowerCase() === K) return h[i][1];
          }
          return;
        }
        for (var k in h) { if (String(k).toLowerCase() === K) return h[k]; }
      } catch (e) {}
    }
    if (typeof window.fetch === 'function') {
      var of = window.fetch;
      window.fetch = function (input, init) {
        try { note(fromInit(init)); } catch (e) {}
        var p = of.apply(this, arguments);
        try {
          p.then(function (r) {
            try {
              if (r && r.headers && r.headers.get) note(r.headers.get('X-Warden-Challenge-Passed'));
            } catch (e) {}
          }, function () {});
        } catch (e) {}
        return p;
      };
    }
    if (window.XMLHttpRequest && XMLHttpRequest.prototype) {
      var xs = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        try { if (String(k).toLowerCase() === K) note(v); } catch (e) {}
        return xs.apply(this, arguments);
      };
      var xo = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function () {
        try {
          var self = this;
          self.addEventListener('load', function () {
            try { note(self.getResponseHeader('X-Warden-Challenge-Passed')); } catch (e) {}
          });
        } catch (e) {}
        return xo.apply(this, arguments);
      };
    }
  } catch (e) {}
})();
"#;

/// Reads the token `WARDEN_HOOK_JS` recorded. Returns a JS string, so the
/// ExecuteScript envelope is one JSON string literal (same double-decode as
/// `parse_poll`).
pub(super) const WARDEN_PROBE_JS: &str = "String(((window.__reconWarden || {}).token) || '')";

/// Kick script: starts the same-site fetch, parks the outcome on a per-call
/// window slot. Slot + URL are JSON-encoded so exotic paths (quotes,
/// unicode) can't break out of the string. Pure — unit-tested.
pub(super) fn kick_script(slot: &str, url: &str) -> String {
    let slot = serde_json::to_string(slot).unwrap_or_else(|_| "\"__trn\"".to_string());
    let url = serde_json::to_string(url).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "window[{slot}]=null;\
        fetch({url},{{credentials:'include'}}).then(async r=>{{\
        let b='';try{{b=await r.text()}}catch(e){{}}\
        window[{slot}]=JSON.stringify({{ok:r.ok,status:r.status,len:b.length,body:(b||'').slice(0,{MAX_SLOT_CHARS})}})\
        }}).catch(e=>{{\
        window[{slot}]=JSON.stringify({{ok:false,status:0,len:0,body:String((e&&e.message)||e||'fetch failed').slice(0,500)}})\
        }})"
    )
}

/// Poll expression: `''` while pending, the result JSON once resolved.
/// Pure — unit-tested.
pub(super) fn poll_expr(slot: &str) -> String {
    let slot = serde_json::to_string(slot).unwrap_or_else(|_| "\"__trn\"".to_string());
    format!("String(window[{slot}]??'')")
}

/// Decode one `eval_with_callback` envelope: None = still pending (or
/// garbage — never poison the wait). Pure — unit-tested.
pub(super) fn parse_poll(envelope: &str) -> Option<SlotResult> {
    let inner: String = serde_json::from_str(envelope).ok()?;
    if inner.is_empty() {
        return None;
    }
    serde_json::from_str(&inner).ok()
}

pub(super) fn snippet(body: &str) -> String {
    body.chars().take(300).collect()
}
