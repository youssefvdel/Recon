//! Pure tracker view model: every string the window shows is derived here.
//!
//! The `.slint` file renders; it never formats a value. That keeps the honesty
//! rules testable on a Linux host: no invented ranks, no placeholder-as-data,
//! explicit empty/loading/error states for every panel.

use crate::live_facts::LiveFacts;
use crate::overlay_renderer::{resolve_renderer, ActiveOverlayRenderer, OverlayRendererSetting};
use outpeek_overlay::hud::FactsMsg;

/// Where the client/poll state stands. `Ready` means the lockfile was read and
/// a local account answered — not that a match is running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientState {
    Starting,
    Missing,
    Ready,
    Error(String),
}

/// One consistent view of the world. Both windows render this.
#[derive(Debug, Clone, PartialEq)]
pub struct TrackerSnapshot {
    pub client: ClientState,
    pub player_name: String,
    pub player_tag: String,
    pub phase: String,
    pub phase_label: String,
    pub map: String,
    pub mode: String,
    pub blue: i32,
    pub red: i32,
    pub updated_ms: u64,
}

impl Default for TrackerSnapshot {
    fn default() -> Self {
        Self::starting()
    }
}

impl TrackerSnapshot {
    /// Boot state: the first poll has not answered yet.
    pub fn starting() -> Self {
        Self {
            client: ClientState::Starting,
            player_name: String::new(),
            player_tag: String::new(),
            phase: "idle".to_string(),
            phase_label: String::new(),
            map: String::new(),
            mode: String::new(),
            blue: 0,
            red: 0,
            updated_ms: 0,
        }
    }

    /// No Riot Client lockfile: a state, not an error.
    pub fn no_client() -> Self {
        Self {
            client: ClientState::Missing,
            ..Self::starting()
        }
    }

    pub fn with_error(&self, message: impl Into<String>) -> Self {
        Self {
            client: ClientState::Error(message.into()),
            ..self.clone()
        }
    }

    /// Attach the locally signed-in account. Name/tag stay empty when the
    /// client did not report them — never a fabricated "#EUW".
    pub fn with_identity(&self, name: &str, tag: &str) -> Self {
        Self {
            client: ClientState::Ready,
            player_name: name.trim().to_string(),
            player_tag: tag.trim().to_string(),
            ..self.clone()
        }
    }

    /// Replace the live half with a derived fact set. Identity is preserved.
    pub(crate) fn with_facts(&self, facts: &LiveFacts) -> Self {
        Self {
            // An answered presence read proves the client is alive again:
            // recovery must clear a transient error, not leave it stuck.
            client: ClientState::Ready,
            phase: facts.phase.clone(),
            phase_label: facts.phase_label.clone(),
            map: facts.map.clone(),
            mode: facts.mode.clone(),
            blue: facts.blue,
            red: facts.red,
            updated_ms: facts.updated_at,
            ..self.clone()
        }
    }

    /// `Name#TAG`, or just the name, or empty. Never a bare "#TAG".
    pub fn player_display(&self) -> String {
        format_player_tag(&self.player_name, &self.player_tag)
    }

    /// Avatar letter: the first character of the name, uppercased.
    pub fn player_initial(&self) -> String {
        player_initial(&self.player_name)
    }

    pub fn has_match(&self) -> bool {
        matches!(self.phase.as_str(), "coregame" | "pregame")
    }

    /// `loading | empty | live | error` — the live panel's state.
    pub fn live_state(&self) -> &'static str {
        match &self.client {
            ClientState::Starting => "loading",
            ClientState::Missing => "empty",
            ClientState::Error(_) => "error",
            ClientState::Ready => {
                if self.has_match() {
                    "live"
                } else {
                    "empty"
                }
            }
        }
    }

    /// The one line the live panel shows when it is not rendering a match.
    /// A ready+specific match shows no message (the values are the message).
    pub fn live_message(&self) -> String {
        match &self.client {
            ClientState::Starting => "Reading the Riot Client…".to_string(),
            ClientState::Missing => {
                "Riot Client is not running. Launch VALORANT or the Riot Client.".to_string()
            }
            ClientState::Error(e) => e.clone(),
            ClientState::Ready => {
                if self.has_match() {
                    String::new()
                } else {
                    "No match in progress.".to_string()
                }
            }
        }
    }

    /// Human phase for the tracker card.
    pub fn phase_title(&self) -> &'static str {
        phase_title(&self.phase)
    }

    /// Short chip word. States, not fabricated values.
    pub fn phase_chip(&self) -> &'static str {
        match &self.client {
            ClientState::Starting => "…",
            ClientState::Missing | ClientState::Error(_) => "OFFLINE",
            ClientState::Ready => match self.phase.as_str() {
                "coregame" => "LIVE",
                "pregame" => "SELECT",
                _ => "MENUS",
            },
        }
    }

    /// Facts frame for the HUD window. Visibility (`present`) is deliberately
    /// left unset: the foreground gate owns it, not the match content.
    pub fn facts(&self) -> FactsMsg {
        FactsMsg {
            lite: Some(true),
            phase: Some(self.phase.clone()),
            phase_label: Some(self.phase_label.clone()),
            map: Some(self.map.clone()),
            mode: Some(self.mode.clone()),
            live: Some(self.phase == "coregame"),
            blue: Some(self.blue),
            red: Some(self.red),
            ..FactsMsg::default()
        }
    }
}

/// `Name#TAG` formatting. Empty name → empty string (never "#TAG" alone);
/// empty tag → just the name.
pub fn format_player_tag(name: &str, tag: &str) -> String {
    let name = name.trim();
    let tag = tag.trim().trim_start_matches('#');
    if name.is_empty() {
        return String::new();
    }
    if tag.is_empty() {
        name.to_string()
    } else {
        format!("{name}#{tag}")
    }
}

/// First character of the name, uppercased; empty when there is no name.
pub fn player_initial(name: &str) -> String {
    name.trim()
        .chars()
        .next()
        .map(|c| c.to_uppercase().to_string())
        .unwrap_or_default()
}

/// Tier id → display label. Mirrors `tierName` in `src/utils/tracker.ts` (the
/// canonical mapping): tier 0–2 is Unrated, 3+ is `<Division> <1..3>`, 27+ is
/// Radiant. Never invents a rank for a missing read — callers must not call
/// this with an unknown tier and then display the result.
pub fn tier_label(tier: i64) -> String {
    if !(0..=1000).contains(&tier) {
        return String::new();
    }
    if tier >= 27 {
        return "Radiant".to_string();
    }
    if tier < 3 {
        return "Unrated".to_string();
    }
    const TIERS: [&str; 8] = [
        "Iron",
        "Bronze",
        "Silver",
        "Gold",
        "Platinum",
        "Diamond",
        "Ascendant",
        "Immortal",
    ];
    let index = (((tier - 3) / 3) as usize).min(TIERS.len() - 1);
    let division = ((tier - 3) % 3) + 1;
    format!("{} {division}", TIERS[index])
}

/// Phase → human title. Unknown phases read as "Unknown", not as idle.
pub fn phase_title(phase: &str) -> &'static str {
    match phase {
        "coregame" => "In match",
        "pregame" => "Agent select",
        "idle" => "In menus",
        _ => "Unknown",
    }
}

/// Rank panel states. `Unranked` is only valid after a *successful* `/mmr`
/// answer with tier 0; an error must never be shown as Unrated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RankState {
    Waiting,
    Loading,
    Ok,
    Unranked,
    Error,
}

impl RankState {
    pub fn as_str(self) -> &'static str {
        match self {
            RankState::Waiting => "waiting",
            RankState::Loading => "loading",
            RankState::Ok => "ok",
            RankState::Unranked => "unranked",
            RankState::Error => "error",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RankView {
    pub state: RankState,
    pub label: String,
    pub rr: i64,
    pub message: String,
}

impl RankView {
    /// No client yet: an honest wait, not an error.
    pub fn waiting() -> Self {
        Self {
            state: RankState::Waiting,
            label: String::new(),
            rr: 0,
            message: "Waiting for the Riot Client.".to_string(),
        }
    }

    pub fn loading() -> Self {
        Self {
            state: RankState::Loading,
            label: String::new(),
            rr: 0,
            message: "Reading your rank…".to_string(),
        }
    }

    /// A valid `/mmr` answer. Tier 0 is a real "Unrated", so it is safe here.
    pub fn from_rank(tier: i64, rr: i64) -> Self {
        if tier < 3 {
            return Self {
                state: RankState::Unranked,
                label: "Unrated".to_string(),
                rr: 0,
                message: "No competitive rank this act.".to_string(),
            };
        }
        Self {
            state: RankState::Ok,
            label: tier_label(tier),
            rr,
            message: String::new(),
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            state: RankState::Error,
            label: String::new(),
            rr: 0,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HudTone {
    Off,
    Armed,
    Live,
    Unsupported,
}

impl HudTone {
    pub fn as_str(self) -> &'static str {
        match self {
            HudTone::Off => "off",
            HudTone::Armed => "armed",
            HudTone::Live => "live",
            HudTone::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HudStatus {
    pub text: &'static str,
    pub tone: HudTone,
}

/// The HUD's on-screen rule, in one place:
/// enabled ∧ native renderer ∧ VALORANT focused ∧ the platform can host it.
pub fn should_show_overlay(
    enabled: bool,
    setting: OverlayRendererSetting,
    game_foreground: bool,
    platform_supported: bool,
) -> bool {
    if !enabled || !game_foreground || !platform_supported {
        return false;
    }
    matches!(
        resolve_renderer(setting, true),
        ActiveOverlayRenderer::Native
    )
}

/// Status line for the kill switch. Pure so every combination is testable.
pub fn hud_status(
    enabled: bool,
    setting: OverlayRendererSetting,
    game_foreground: bool,
    platform_supported: bool,
) -> HudStatus {
    if !platform_supported {
        return HudStatus {
            text: "Windows only — HUD window stays hidden",
            tone: HudTone::Unsupported,
        };
    }
    if !enabled {
        return HudStatus {
            text: "Off — HUD will not show",
            tone: HudTone::Off,
        };
    }
    if !matches!(
        resolve_renderer(setting, true),
        ActiveOverlayRenderer::Native
    ) {
        return HudStatus {
            text: "Off — renderer set to TS",
            tone: HudTone::Off,
        };
    }
    if game_foreground {
        HudStatus {
            text: "Live over VALORANT",
            tone: HudTone::Live,
        }
    } else {
        HudStatus {
            text: "Armed — waiting for VALORANT",
            tone: HudTone::Armed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_tag_formatting_never_invents_a_tag() {
        assert_eq!(format_player_tag("Faker", "EUW"), "Faker#EUW");
        assert_eq!(format_player_tag("  Faker  ", " #EUW "), "Faker#EUW");
        assert_eq!(format_player_tag("Faker", ""), "Faker");
        assert_eq!(format_player_tag("", "EUW"), "");
        assert_eq!(format_player_tag("", ""), "");
    }

    #[test]
    fn avatar_initial_is_uppercase_or_empty() {
        assert_eq!(player_initial("faker"), "F");
        assert_eq!(player_initial("  zedd "), "Z");
        assert_eq!(player_initial(""), "");
    }

    #[test]
    fn tier_labels_match_the_ts_mapping() {
        assert_eq!(tier_label(0), "Unrated");
        assert_eq!(tier_label(2), "Unrated");
        assert_eq!(tier_label(3), "Iron 1");
        assert_eq!(tier_label(5), "Iron 3");
        assert_eq!(tier_label(6), "Bronze 1");
        assert_eq!(tier_label(17), "Platinum 3");
        assert_eq!(tier_label(24), "Immortal 1");
        assert_eq!(tier_label(26), "Immortal 3");
        assert_eq!(tier_label(27), "Radiant");
        assert_eq!(tier_label(99), "Radiant");
    }

    #[test]
    fn phase_titles_are_explicit_for_every_phase() {
        assert_eq!(phase_title("coregame"), "In match");
        assert_eq!(phase_title("pregame"), "Agent select");
        assert_eq!(phase_title("idle"), "In menus");
        assert_eq!(phase_title("something-new"), "Unknown");
    }

    #[test]
    fn no_client_is_a_state_not_an_error() {
        let snap = TrackerSnapshot::no_client();
        assert_eq!(snap.live_state(), "empty");
        assert!(snap.live_message().contains("not running"));
        assert_eq!(snap.phase_chip(), "OFFLINE");
        assert!(!snap.has_match());
        // An empty name is empty, not a placeholder.
        assert_eq!(snap.player_display(), "");
        assert_eq!(snap.player_initial(), "");
    }

    #[test]
    fn rank_errors_are_never_rendered_as_unrated() {
        let error = RankView::error("Riot refused the rank read (403).");
        assert_eq!(error.state, RankState::Error);
        assert_eq!(error.label, "");
        // The only path that may say "Unrated" is a successful read.
        let unranked = RankView::from_rank(0, 0);
        assert_eq!(unranked.state, RankState::Unranked);
        assert_eq!(unranked.label, "Unrated");
    }

    #[test]
    fn a_successful_presence_read_recovers_from_a_transient_error() {
        let failed = TrackerSnapshot::starting().with_error("Riot Client not responding");
        assert_eq!(failed.live_state(), "error");
        let recovered = failed.with_facts(&LiveFacts::idle(1));
        assert_eq!(recovered.client, ClientState::Ready);
        assert_eq!(recovered.live_state(), "empty");
    }

    #[test]
    fn facts_frame_carries_live_values_and_leaves_visibility_to_the_gate() {
        let snap = TrackerSnapshot {
            client: ClientState::Ready,
            player_name: "Faker".into(),
            player_tag: "EUW".into(),
            phase: "coregame".into(),
            phase_label: "LIVE".into(),
            map: "Ascent".into(),
            mode: "Competitive".into(),
            blue: 7,
            red: 5,
            updated_ms: 1,
        };
        let facts = snap.facts();
        assert_eq!(facts.phase.as_deref(), Some("coregame"));
        assert_eq!(facts.map.as_deref(), Some("Ascent"));
        assert_eq!(facts.mode.as_deref(), Some("Competitive"));
        assert_eq!(facts.blue, Some(7));
        assert_eq!(facts.red, Some(5));
        assert_eq!(facts.live, Some(true));
        // The foreground watcher owns present; the snapshot must not.
        assert_eq!(facts.present, None);
        assert_eq!(facts.rect, None);
    }

    #[test]
    fn overlay_visibility_needs_all_four_conditions() {
        use OverlayRendererSetting::{Auto, Native, Ts};
        // The happy path.
        assert!(should_show_overlay(true, Native, true, true));
        assert!(should_show_overlay(true, Auto, true, true));
        // Any missing condition hides it.
        assert!(!should_show_overlay(false, Native, true, true));
        assert!(!should_show_overlay(true, Ts, true, true));
        assert!(!should_show_overlay(true, Native, false, true));
        assert!(!should_show_overlay(true, Native, true, false));
    }

    #[test]
    fn hud_status_never_claims_the_hud_is_live_when_it_is_not() {
        use OverlayRendererSetting::Native;
        assert_eq!(hud_status(true, Native, true, true).tone, HudTone::Live);
        assert_eq!(hud_status(true, Native, false, true).tone, HudTone::Armed);
        assert_eq!(hud_status(false, Native, true, true).tone, HudTone::Off);
        assert_eq!(
            hud_status(true, Native, true, false).tone,
            HudTone::Unsupported
        );
    }
}
