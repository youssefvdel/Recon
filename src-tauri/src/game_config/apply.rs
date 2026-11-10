//! Apply and verify across every config file at once.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use super::discover::find_valorant_configs;
use super::ini::*;
use super::model::{ApplyResult, VerifyResult};
use super::write::*;

/// Per-file apply with verification — backs the new editor tab + Sync All.
pub fn apply_to_all_configs_verbose(w: u32, h: u32, lock_readonly: bool) -> Vec<ApplyResult> {
    // 1. Ensure GPU scaling is correctly configured for the user's active GPU vendor
    crate::gpu::apply_gpu_scaling_for_active_vendor(true);

    let configs = find_valorant_configs();
    configs
        .iter()
        .map(|cfg| match update_config(&cfg.path, true, Some((w, h)), lock_readonly) {
            Ok(()) => ApplyResult {
                path: cfg.path.clone(),
                display_name: cfg.display_name.clone(),
                ok: true,
                verified: true,
                message: format!("{}×{} verified (FullscreenMode 2, Letterbox False, Pos 0,0)", w, h),
            },
            Err(e) => ApplyResult {
                path: cfg.path.clone(),
                display_name: cfg.display_name.clone(),
                ok: false,
                verified: false,
                message: e,
            },
        })
        .collect()
}

/// Verify every detected config against an expected stretch target.
/// Letterbox is expected OFF (False) for stretch; pass None to skip that check.
pub fn verify_all_configs(expected_w: u32, expected_h: u32) -> Vec<VerifyResult> {
    find_valorant_configs()
        .iter()
        .map(|cfg| {
            let mut issues = Vec::new();
            let mut score = 100u32;

            // 1. Resolution Check
            if cfg.res_x != Some(expected_w) || cfg.res_y != Some(expected_h) {
                issues.push(format!(
                    "Resolution is {}×{} (target: {}×{})",
                    cfg.res_x.map(|n| n.to_string()).unwrap_or_else(|| "none".into()),
                    cfg.res_y.map(|n| n.to_string()).unwrap_or_else(|| "none".into()),
                    expected_w,
                    expected_h
                ));
                score = score.saturating_sub(30);
            }

            // 2. Desired Screen Check
            if cfg.desired_w != Some(expected_w) || cfg.desired_h != Some(expected_h) {
                issues.push(format!(
                    "DesiredScreen is {}×{} (target: {}×{})",
                    cfg.desired_w.map(|n| n.to_string()).unwrap_or_else(|| "none".into()),
                    cfg.desired_h.map(|n| n.to_string()).unwrap_or_else(|| "none".into()),
                    expected_w,
                    expected_h
                ));
                score = score.saturating_sub(15);
            }

            // 3. Letterbox Check (CRITICAL: causes black bars)
            if cfg.should_letterbox != Some(false) || cfg.last_letterbox != Some(false) {
                issues.push("bShouldLetterbox is enabled (causes black bars in-game)".to_string());
                score = score.saturating_sub(30);
            }

            // 4. FullscreenMode Check
            if cfg.fullscreen_mode != Some(2) {
                issues.push(format!(
                    "FullscreenMode is {} (must be 2 / Borderless for True Stretch)",
                    cfg.fullscreen_mode.map(|n| n.to_string()).unwrap_or_else(|| "none".into())
                ));
                score = score.saturating_sub(25);
            }

            // 5. Window Alignment Check
            if let Some(x) = cfg.window_pos_x {
                if x != 0 {
                    issues.push(format!("WindowPosX is {} (causes horizontal misalignment)", x));
                    score = score.saturating_sub(10);
                }
            }
            if let Some(y) = cfg.window_pos_y {
                if y != 0 {
                    issues.push(format!("WindowPosY is {} (causes vertical misalignment)", y));
                    score = score.saturating_sub(10);
                }
            }

            // 6. 3D Render Scale Check (0 to 100% graphics scaling)
            if let Some(rq) = cfg.resolution_quality {
                if (rq - 100.0).abs() > 0.01 {
                    issues.push(format!("3D Render Scale is {:.0}% (should be 100% for full clarity)", rq));
                    score = score.saturating_sub(15);
                }
            }

            // 7. Honor Desired Height Check
            if cfg.use_desired_screen_height == Some(false) {
                issues.push("bUseDesiredScreenHeight is False (should be True to honor desired height)".to_string());
                score = score.saturating_sub(10);
            }

            let is_healthy = issues.is_empty();
            let matches = is_healthy;

            let details = if is_healthy {
                format!(
                    "100% Healthy: {}×{}, FullscreenMode 2, Letterbox OFF, (0,0) flush, 100% Render Scale, Honor Desired Height ON",
                    expected_w, expected_h
                )
            } else {
                format!("Health {}%: {}", score, issues.join(" • "))
            };

            VerifyResult {
                path: cfg.path.clone(),
                display_name: cfg.display_name.clone(),
                matches,
                details,
                health_score: score,
                is_healthy,
                issues,
            }
        })
        .collect()
}
