//! Value types returned by the config editor.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

/// Full parsed view of a VALORANT GameUserSettings.ini.
/// All value fields are Option so missing keys are visible instead of guessed.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ConfigFileInfo {
    pub path: PathBuf,
    pub display_name: String,
    pub is_read_only: bool,
    pub fullscreen_mode: Option<u32>,
    pub last_confirmed_fullscreen: Option<u32>,
    pub preferred_fullscreen: Option<u32>,
    pub should_letterbox: Option<bool>,
    pub last_letterbox: Option<bool>,
    pub res_x: Option<u32>,
    pub res_y: Option<u32>,
    pub last_confirmed_res_x: Option<u32>,
    pub last_confirmed_res_y: Option<u32>,
    pub desired_w: Option<u32>,
    pub desired_h: Option<u32>,
    pub last_confirmed_desired_w: Option<u32>,
    pub last_confirmed_desired_h: Option<u32>,
    #[serde(default)]
    pub window_pos_x: Option<i32>,
    #[serde(default)]
    pub window_pos_y: Option<i32>,
    #[serde(default)]
    pub resolution_quality: Option<f32>,
    #[serde(default)]
    pub use_desired_screen_height: Option<bool>,
}

/// Per-file result for apply operations — proves the write, not just claims it.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ApplyResult {
    pub path: PathBuf,
    pub display_name: String,
    pub ok: bool,
    pub verified: bool,
    pub message: String,
}

/// Per-file verification against an expected stretch target.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct VerifyResult {
    pub path: PathBuf,
    pub display_name: String,
    pub matches: bool,
    pub details: String,
    #[serde(default)]
    pub health_score: u32,
    #[serde(default)]
    pub is_healthy: bool,
    #[serde(default)]
    pub issues: Vec<String>,
}

/// Custom per-file options for the Valorant Config editor tab.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct CustomOptions {
    pub fullscreen_mode: Option<u32>,
    /// Some(true) = letterbox ON, Some(false) = OFF (stretch), None = leave alone
    pub letterbox: Option<bool>,
    pub res: Option<[u32; 2]>,
    pub desired: Option<[u32; 2]>,
    #[serde(default)]
    pub lock_readonly: bool,
}
