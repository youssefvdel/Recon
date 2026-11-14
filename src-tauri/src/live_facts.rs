//! Presence JSON → live facts: the pure half of the Phase 0 live service.
//!
//! `docs/live-rust-pipeline.md` §Phase 0. The Rust live service (`src/live.rs`)
//! polls Riot's loopback `/chat/v4/presences` and needs exactly one thing from
//! it: the local player's private presence blob, decoded, with the loop state,
//! map, queue and team scores. That derivation is pure `serde_json`, so it is
//! compiled and tested on a non-Windows host through `src-tauri/pure` — no
//! Tauri, no Win32, no network (see `docs/architecture/host-agnostic-tests.md`).
//!
//! The TS parser (`src/utils/tracker.ts` + `src/sources/presence.ts`) is the
//! reference for the field order: `matchPresenceData` first, then the flat
//! blob. Keep the two in agreement — the HUD must not show a different match
//! than the rest of the app.
//!
//! Safety: read-only. This module only parses bytes the client already returns.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped when the fact shape changes in a way a subscriber must notice.
pub(crate) const LIVE_FACTS_VERSION: u32 = 1;

/// The only source this slice has: Riot's own loopback presences.
pub(crate) const SOURCE_PRESENCES: &str = "presences";

/// The derived fact set. Every event carries `source` + `seq` + `confidence`
/// (docs rule); `seq` is monotonic per process and only stamped on emit.
///
/// `phase` is the HUD's gate vocabulary: `idle | pregame | coregame`.
/// `phase_label` is the human strip word derived from it: `SELECT | LIVE`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct LiveFacts {
    pub version: u32,
    pub seq: u64,
    pub source: String,
    /// `high` = local presence decoded and carried a loop state;
    /// `medium` = blob decoded but no loop state (we default to idle);
    /// `low` = no local presence / unreadable blob (unknown, stay idle).
    pub confidence: String,
    pub phase: String,
    pub phase_label: String,
    /// Raw `sessionLoopState` (`INGAME`, `PREGAME`, `MENU`, …) — kept so a
    /// subscriber can tell "menu" from "unknown" without re-parsing.
    pub loop_state: String,
    pub map: String,
    pub queue: String,
    /// Human mode label derived from `queue` (`Competitive`, `Swiftplay`, …).
    pub mode: String,
    /// Team scores as the presence reports them: ally = the local player's
    /// team. Blue/red naming is the HUD's problem, not this module's.
    pub blue: i32,
    pub red: i32,
    pub updated_at: u64,
}

impl Default for LiveFacts {
    fn default() -> Self {
        Self::idle(0)
    }
}

impl LiveFacts {
    /// Known-nothing fact set. Empty strings, never placeholder-as-data.
    pub(crate) fn idle(now_ms: u64) -> Self {
        Self {
            version: LIVE_FACTS_VERSION,
            seq: 0,
            source: SOURCE_PRESENCES.to_string(),
            confidence: "low".to_string(),
            phase: "idle".to_string(),
            phase_label: String::new(),
            loop_state: String::new(),
            map: String::new(),
            queue: String::new(),
            mode: String::new(),
            blue: 0,
            red: 0,
            updated_at: now_ms,
        }
    }

    /// Emit-on-change comparison: everything except the monotonic `seq` and the
    /// wall-clock stamp. A poll that saw the same match must stay silent.
    pub(crate) fn same_facts(&self, other: &Self) -> bool {
        self.version == other.version
            && self.source == other.source
            && self.confidence == other.confidence
            && self.phase == other.phase
            && self.phase_label == other.phase_label
            && self.loop_state == other.loop_state
            && self.map == other.map
            && self.queue == other.queue
            && self.mode == other.mode
            && self.blue == other.blue
            && self.red == other.red
    }
}

/// `/chat/v4/presences` body → facts for the player whose puuid is `local_puuid`.
///
/// Never fails and never panics: a malformed shape yields the idle fact set
/// with `confidence: "low"` so the caller can keep the last good frame and
/// retry. Presence keeps the *last* match's map/queue/scores while the player
/// sits in menus — those are deliberately dropped: an idle HUD must not show a
/// finished match's score.
pub(crate) fn derive_facts(root: &Value, local_puuid: &str, now_ms: u64) -> LiveFacts {
    let mut facts = LiveFacts::idle(now_ms);
    let Some(presence) = find_local_presence(root, local_puuid) else {
        return facts;
    };
    let Some(blob) = presence_blob(presence) else {
        return facts;
    };
    // Decoded, but no loop state yet: the phase is *unknown*, not proven idle.
    facts.confidence = "medium".to_string();
    let loop_state = blob_text(&blob, "sessionLoopState").to_uppercase();
    if loop_state.is_empty() {
        return facts;
    }
    facts.confidence = "high".to_string();
    facts.loop_state = loop_state.clone();
    match loop_state.as_str() {
        "INGAME" => {
            facts.phase = "coregame".to_string();
            facts.phase_label = "LIVE".to_string();
        }
        "PREGAME" => {
            facts.phase = "pregame".to_string();
            facts.phase_label = "SELECT".to_string();
        }
        // MENU and anything unexpected: idle. The blob still holds last match's
        // values at this point, which is exactly why the early return is here.
        _ => return facts,
    }
    // `matchMap` is the modern key; `partyOwnerMatchMap` is what the flat blob
    // has always carried. First non-empty wins.
    facts.map = non_empty(blob_text(&blob, "matchMap"))
        .or_else(|| non_empty(blob_text(&blob, "partyOwnerMatchMap")))
        .map(|raw| map_display_name(&raw))
        .unwrap_or_default();
    facts.queue = blob_text(&blob, "queueId").to_lowercase();
    facts.mode = queue_mode_label(&facts.queue);
    facts.blue = blob_number(&blob, "partyOwnerMatchScoreAllyTeam");
    facts.red = blob_number(&blob, "partyOwnerMatchScoreEnemyTeam");
    facts
}

/// The local player's presence entry, matched by `puuid` (case-insensitive) or
/// the `pid` form (`puuid@region`). `None` when the list has no such entry —
/// which the caller treats as "account may have changed", not as an error.
pub(crate) fn find_local_presence<'a>(root: &'a Value, local_puuid: &str) -> Option<&'a Value> {
    let wanted = local_puuid.trim();
    if wanted.is_empty() {
        return None;
    }
    root.get("presences")?
        .as_array()?
        .iter()
        .find(|p| presence_puuid(p).eq_ignore_ascii_case(wanted))
}

/// Decoded private blob. Base64 → UTF-8 → JSON, any step failing = `None`.
fn presence_blob(presence: &Value) -> Option<Value> {
    let raw = presence.get("private")?.as_str()?;
    let bytes = decode_base64(raw)?;
    let text = String::from_utf8(bytes).ok()?;
    serde_json::from_str(&text).ok()
}

fn presence_puuid(presence: &Value) -> String {
    if let Some(s) = presence.get("puuid").and_then(Value::as_str) {
        let s = s.trim();
        if !s.is_empty() {
            return s.to_string();
        }
    }
    presence
        .get("pid")
        .and_then(Value::as_str)
        .map(|s| s.split('@').next().unwrap_or(s).trim().to_string())
        .unwrap_or_default()
}

/// A string field, `matchPresenceData` first then the flat blob (the TS
/// fallback order). First non-empty value wins; whitespace is trimmed.
fn blob_text(blob: &Value, key: &str) -> String {
    let nested = blob
        .get("matchPresenceData")
        .and_then(Value::as_object)
        .and_then(|o| o.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(s) = nested {
        return s.to_string();
    }
    blob.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

/// A numeric field with the same fallback order. Numbers and numeric strings
/// both count (`Number("6")` in the TS parser); anything else is 0.
fn blob_number(blob: &Value, key: &str) -> i32 {
    fn read(v: Option<&Value>) -> Option<i32> {
        match v? {
            Value::Number(n) => n.as_i64().map(|x| x as i32),
            Value::String(s) => s.trim().parse::<i64>().ok().map(|x| x as i32),
            _ => None,
        }
    }
    let nested = blob
        .get("matchPresenceData")
        .and_then(Value::as_object)
        .and_then(|o| read(o.get(key)));
    nested.or_else(|| read(blob.get(key))).unwrap_or(0)
}

fn non_empty(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Queue id → the human mode label the HUD renders. Mirrors
/// `queueLabel` in `src/utils/playerDisplay.ts` (same words on both renderers),
/// unknown ids get title-cased instead of being hidden — the queue id itself is
/// still a fact.
pub(crate) fn queue_mode_label(queue: &str) -> String {
    let q = queue.trim().to_lowercase();
    let label = match q.as_str() {
        "" => return String::new(),
        "competitive" => "Competitive",
        "unrated" => "Unrated",
        "swiftplay" | "quickbomb" => "Swiftplay",
        "spikerush" => "Spike Rush",
        "deathmatch" => "Deathmatch",
        "premier" => "Premier",
        "ggteam" => "Escalation",
        "onefa" => "Replication",
        "snowball" => "Snowball Fight",
        other => return title_case(other),
    };
    label.to_string()
}

fn title_case(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Presence map value → display text. Riot has shipped both a display name
/// ("Ascent") and a content path ("/Game/Maps/Ascent/Ascent") in presence-era
/// blobs; a path is reduced to its last segment so the HUD never renders an
/// asset path. Content codenames (`Duality` → Bind) need the game-data table,
/// which lives in the UI — that translation is not invented here.
pub(crate) fn map_display_name(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let segment = trimmed
        .rsplit('/')
        .find(|s| !s.is_empty())
        .unwrap_or(trimmed);
    title_case(segment)
}

/// Standard or URL-safe base64, padding optional. `None` on a non-alphabet
/// byte, data after padding, or an impossible tail — a malformed blob must read
/// as "unreadable", never as bytes the JSON parser then half-understands.
/// `pub(crate)` for the fixture tests in `src-tauri/pure`.
pub(crate) fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut pad = 0usize;
    for byte in input.bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        if byte == b'=' {
            pad += 1;
            continue;
        }
        if pad > 0 {
            return None;
        }
        let value = base64_value(byte)?;
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    // `pad > 2` is not base64; a 6-bit tail is a one-character group (atob
    // rejects it too). Two- and three-character tails with padding are valid.
    if pad > 2 || bits >= 6 {
        return None;
    }
    Some(out)
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}
