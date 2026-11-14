//! Pure settings-page model: every string the Settings view shows is derived
//! here from injected values, so the honesty rules are testable on a Linux
//! host. Nothing in this module reads the environment, touches the filesystem,
//! or calls a platform API — `main.rs` resolves the real inputs and hands them
//! in.
//!
//! Rules encoded here:
//! * a path is either resolved from this machine or replaced by the reason it
//!   is not — never a guessed `C:\Users\...`;
//! * an MCP port is shown only when one was set and it is a usable port;
//! * the version/build rows use compile-time facts, and empty inputs produce an
//!   empty string, not a trailing separator;
//! * the "not ported" list can never silently become empty.

use std::path::{Path, PathBuf};

/// Directory name under `%APPDATA%` (same constant the shipping app uses).
pub const APP_DIR_NAME: &str = "Outpeek";
/// File the HUD toggle persists to (same file the Tauri app's settings read).
pub const RENDERER_FILE: &str = "overlay_renderer.txt";
/// `tauri.conf.json` identifier; the Tauri build's log dir is `<id>\logs`.
pub const LOG_IDENTIFIER: &str = "com.outpeek.utility";

/// The foreground rule, stated once for the Settings page and the README.
pub const HUD_RULE: &str =
    "Shows only while VALORANT owns the foreground; another window taking focus hides it within a second.";

/// Appearance is honest about having no control yet.
pub const THEME_LINE: &str =
    "The light palette is not designed yet, so there is no switch to flip — this page says so instead of showing a dead one.";

/// One row of the "not ported yet" list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotPorted {
    pub title: &'static str,
    pub detail: &'static str,
}

/// Features the Tauri build has and this shell does not. Kept short and
/// specific; `not_ported_list_is_non_empty_and_explains_each_row` enforces that
/// it never becomes an empty promise.
pub const NOT_PORTED: &[NotPorted] = &[
    NotPorted {
        title: "Stretch & resolution switching",
        detail: "Needs Windows display APIs (EDID read-back, custom-resolution commit) that this build does not link.",
    },
    NotPorted {
        title: "Config editor",
        detail: "Writes the VALORANT game config; it lives in the Tauri build, not here.",
    },
    NotPorted {
        title: "GPU report",
        detail: "Scaling and display read-back. Every row must be read back, so it ships only when it can be honest.",
    },
    NotPorted {
        title: "Updates",
        detail: "The signed updater and release channel belong to the Tauri build.",
    },
    NotPorted {
        title: "HUD edit mode",
        detail: "Drag/scale/lock chrome; the callbacks exist in the HUD crate only.",
    },
];

/// A path resolved on this machine, or the reason there is none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathState {
    Resolved(PathBuf),
    Unavailable(String),
}

impl PathState {
    /// What the row shows: the path, or the honest reason.
    pub fn display(&self) -> String {
        match self {
            PathState::Resolved(path) => path.display().to_string(),
            PathState::Unavailable(reason) => reason.clone(),
        }
    }

    pub fn is_resolved(&self) -> bool {
        matches!(self, PathState::Resolved(_))
    }
}

/// `%APPDATA%\Outpeek` — the same join rule as `paths::app_data_dir`, without
/// creating anything. `None`/empty `APPDATA` is reported, never invented.
pub fn data_dir(app_data: Option<&Path>) -> PathState {
    match app_data.filter(|base| !base.as_os_str().is_empty()) {
        Some(base) => PathState::Resolved(base.join(APP_DIR_NAME)),
        None => {
            PathState::Unavailable("APPDATA is not set — no writable data directory".to_string())
        }
    }
}

/// `%LOCALAPPDATA%\<identifier>\logs`, the path the Tauri build logs to, with
/// the same fallback order as `src-tauri/src/lib.rs`: LOCALAPPDATA, then
/// APPDATA, then the temp directory. The fallback is shown, not hidden.
pub fn log_dir(
    local_app_data: Option<&Path>,
    app_data: Option<&Path>,
    temp_dir: &Path,
    identifier: &str,
) -> PathState {
    if identifier.trim().is_empty() {
        return PathState::Unavailable("log directory has no app identifier".to_string());
    }
    let base = [local_app_data, app_data]
        .into_iter()
        .flatten()
        .find(|base| !base.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| temp_dir.to_path_buf());
    PathState::Resolved(base.join(identifier.trim()).join("logs"))
}

/// Path of a persisted file under the data directory, or why the toggle cannot
/// persist. Never returns a path when the directory is unavailable.
pub fn data_file_line(data: &PathState, file: &str) -> String {
    match data {
        PathState::Resolved(dir) => dir.join(file).display().to_string(),
        PathState::Unavailable(_) => format!("Not persisted — {file} has no writable directory"),
    }
}

/// `SLINT_MCP_PORT` / `--mcp-port` as three displayable states.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpPort {
    Unset,
    Set(u16),
    Invalid(String),
}

/// Classify the raw value. Unset and whitespace count as unset; anything that
/// is not an integer in 1..=65535 is invalid rather than silently coerced.
pub fn parse_mcp_port(raw: Option<&str>) -> McpPort {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return McpPort::Unset;
    };
    match raw.parse::<u32>() {
        Ok(port) if (1..=u16::MAX as u32).contains(&port) => McpPort::Set(port as u16),
        Ok(_) => McpPort::Invalid(raw.to_string()),
        Err(_) => McpPort::Invalid(raw.to_string()),
    }
}

/// One line for the MCP row. `Set` states the configured endpoint (a fact about
/// the configuration, not a claim that the socket is reachable).
pub fn mcp_line(state: &McpPort) -> String {
    match state {
        McpPort::Unset => {
            "Off. Start with --mcp-port 8099 (or set SLINT_MCP_PORT) to expose the UI introspection server."
                .to_string()
        }
        McpPort::Set(port) => format!("Enabled on port {port} — http://127.0.0.1:{port}/mcp"),
        McpPort::Invalid(raw) => {
            format!("'{raw}' is not a usable port (1–65535); the MCP server stays off.")
        }
    }
}

/// Chip tone for the MCP row: `ok | off | warn`.
pub fn mcp_tone(state: &McpPort) -> &'static str {
    match state {
        McpPort::Set(_) => "ok",
        McpPort::Unset => "off",
        McpPort::Invalid(_) => "warn",
    }
}

/// `"Product 1.2.3"`, with empty parts collapsed instead of leaving a ghost
/// space or a leading separator.
pub fn version_line(product: &str, version: &str) -> String {
    join_parts(&[product, version], " ")
}

/// `"release · x86_64-pc-windows-msvc"` from the compiler's own facts.
pub fn build_line(profile: &str, target: &str) -> String {
    join_parts(&[profile, target], " · ")
}

fn join_parts(parts: &[&str], separator: &str) -> String {
    parts
        .iter()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(separator)
}

/// Everything the Settings page renders, resolved once at boot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsView {
    pub data_path: PathState,
    pub log_path: PathState,
    pub hud_file: String,
    pub hud_rule: &'static str,
    pub theme_line: &'static str,
    pub mcp: McpPort,
    pub version_line: String,
    pub build_line: String,
    pub not_ported: &'static [NotPorted],
}

/// Assemble the page. Inputs only — no environment, no I/O, no clock.
#[allow(clippy::too_many_arguments)]
pub fn resolve(
    data_path: PathState,
    log_path: PathState,
    mcp_port: Option<&str>,
    product: &str,
    version: &str,
    profile: &str,
    target: &str,
) -> SettingsView {
    let hud_file = data_file_line(&data_path, RENDERER_FILE);
    SettingsView {
        data_path,
        log_path,
        hud_file,
        hud_rule: HUD_RULE,
        theme_line: THEME_LINE,
        mcp: parse_mcp_port(mcp_port),
        version_line: version_line(product, version),
        build_line: build_line(profile, target),
        not_ported: NOT_PORTED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(value: &str) -> PathBuf {
        PathBuf::from(value)
    }

    #[test]
    fn data_dir_resolves_under_appdata_and_reports_a_missing_base() {
        let base = Path::new(r"C:\Users\test\AppData\Roaming");
        let resolved = data_dir(Some(base));
        // `Path::join` is host-relative; the rule under test is the join, not
        // the separator, so the expectation is built the same way.
        assert_eq!(
            resolved.display(),
            base.join(APP_DIR_NAME).display().to_string()
        );
        assert!(resolved.is_resolved());

        // Missing or empty APPDATA is a reason, never an invented path.
        for missing in [None, Some(Path::new(""))] {
            let state = data_dir(missing);
            assert!(!state.is_resolved());
            assert!(state.display().contains("APPDATA"));
            assert!(!state.display().contains(APP_DIR_NAME));
        }
    }

    #[test]
    fn log_dir_falls_back_localappdata_then_appdata_then_temp() {
        let local = path(r"C:\Users\test\AppData\Local");
        let roaming = path(r"C:\Users\test\AppData\Roaming");
        let temp = path("/tmp");
        let id = "com.outpeek.utility";
        let under = |base: &Path| base.join(id).join("logs").display().to_string();

        // The normal case: the Tauri build's own log directory.
        assert_eq!(
            log_dir(Some(&local), Some(&roaming), &temp, id).display(),
            under(&local)
        );
        // LOCALAPPDATA missing: APPDATA is the second choice, as in lib.rs.
        assert_eq!(
            log_dir(None, Some(&roaming), &temp, id).display(),
            under(&roaming)
        );
        // Both missing: the temp fallback is shown as the path, not hidden.
        assert_eq!(log_dir(None, None, &temp, id).display(), under(&temp));
        assert_eq!(
            log_dir(Some(Path::new("")), None, &temp, id).display(),
            under(&temp)
        );
        // An empty identifier must not produce a bare "logs" directory.
        assert!(!log_dir(Some(&local), None, &temp, " ").is_resolved());
    }

    #[test]
    fn mcp_port_distinguishes_unset_set_and_invalid() {
        assert_eq!(parse_mcp_port(None), McpPort::Unset);
        assert_eq!(parse_mcp_port(Some("")), McpPort::Unset);
        assert_eq!(parse_mcp_port(Some("   ")), McpPort::Unset);
        assert_eq!(parse_mcp_port(Some("8099")), McpPort::Set(8099));
        assert_eq!(parse_mcp_port(Some(" 1 ")), McpPort::Set(1));
        assert_eq!(parse_mcp_port(Some("65535")), McpPort::Set(65535));
        // Out of range, non-numeric, negative and zero are invalid, not coerced.
        for bad in ["0", "65536", "99999", "abc", "-1", "80.99"] {
            assert_eq!(
                parse_mcp_port(Some(bad)),
                McpPort::Invalid(bad.to_string()),
                "{bad} must not become a port"
            );
        }
    }

    #[test]
    fn mcp_line_never_points_at_a_phantom_server() {
        let off = mcp_line(&McpPort::Unset);
        assert!(off.contains("--mcp-port"));
        assert!(!off.contains("http://"));

        let on = mcp_line(&McpPort::Set(8099));
        assert!(on.contains("8099"));
        assert!(on.contains("http://127.0.0.1:8099/mcp"));

        let bad = mcp_line(&McpPort::Invalid("abc".to_string()));
        assert!(bad.contains("abc"));
        assert!(bad.contains("stays off"));
        assert!(!bad.contains("http://"));

        assert_eq!(mcp_tone(&McpPort::Set(8099)), "ok");
        assert_eq!(mcp_tone(&McpPort::Unset), "off");
        assert_eq!(mcp_tone(&McpPort::Invalid("x".into())), "warn");
    }

    #[test]
    fn version_line_joins_product_and_version_without_ghost_parts() {
        assert_eq!(version_line("Outpeek", "0.4.4"), "Outpeek 0.4.4");
        assert_eq!(version_line(" Outpeek ", " 0.4.4 "), "Outpeek 0.4.4");
        assert_eq!(version_line("", "0.4.4"), "0.4.4");
        assert_eq!(version_line("Outpeek", ""), "Outpeek");
        assert_eq!(version_line("", ""), "");
    }

    #[test]
    fn build_line_reports_profile_and_target() {
        assert_eq!(
            build_line("release", "x86_64-pc-windows-msvc"),
            "release · x86_64-pc-windows-msvc"
        );
        assert_eq!(build_line("debug", ""), "debug");
        assert_eq!(
            build_line("", "aarch64-unknown-linux-gnu"),
            "aarch64-unknown-linux-gnu"
        );
        assert_eq!(build_line("  ", "  "), "");
    }

    #[test]
    fn not_ported_list_is_non_empty_and_explains_each_row() {
        assert!(!NOT_PORTED.is_empty());
        for row in NOT_PORTED {
            assert!(!row.title.trim().is_empty());
            assert!(
                !row.detail.trim().is_empty(),
                "{} needs a reason",
                row.title
            );
        }
        // The four the port brief names explicitly.
        let titles: Vec<&str> = NOT_PORTED.iter().map(|row| row.title).collect();
        for expected in ["Stretch", "Config editor", "GPU report", "Updates"] {
            assert!(
                titles.iter().any(|title| title.contains(expected)),
                "{expected} must be listed as not ported"
            );
        }
    }

    #[test]
    fn hud_file_line_is_a_real_path_or_a_refusal() {
        let data = PathState::Resolved(path(r"C:\Users\test\AppData\Roaming\Outpeek"));
        match &data {
            PathState::Resolved(dir) => assert_eq!(
                data_file_line(&data, RENDERER_FILE),
                dir.join(RENDERER_FILE).display().to_string()
            ),
            PathState::Unavailable(_) => unreachable!(),
        }
        let missing = data_dir(None);
        let line = data_file_line(&missing, RENDERER_FILE);
        assert!(line.contains("Not persisted"));
        assert!(!line.contains(APP_DIR_NAME));
    }

    #[test]
    fn resolve_assembles_a_page_with_no_empty_rows() {
        let data = PathState::Resolved(path(r"C:\Users\test\AppData\Roaming\Outpeek"));
        let logs = PathState::Resolved(path(
            r"C:\Users\test\AppData\Local\com.outpeek.utility\logs",
        ));
        let expected_file =
            data.display().to_string() + std::path::MAIN_SEPARATOR_STR + RENDERER_FILE;
        let view = resolve(
            data,
            logs,
            Some("8099"),
            "Outpeek",
            "0.4.4",
            "release",
            "x86_64-pc-windows-msvc",
        );
        assert_eq!(view.hud_file, expected_file);
        assert!(!view.hud_rule.is_empty());
        assert!(!view.theme_line.is_empty());
        assert!(!view.version_line.is_empty());
        assert!(!view.build_line.is_empty());
        assert!(!view.not_ported.is_empty());
        assert_eq!(view.mcp, McpPort::Set(8099));

        // The failure path stays honest too: no empty strings pretend to be data.
        let degraded = resolve(
            data_dir(None),
            log_dir(None, None, Path::new("/tmp"), ""),
            None,
            "Outpeek",
            "0.4.4",
            "debug",
            "",
        );
        for row in [
            degraded.data_path.display(),
            degraded.log_path.display(),
            degraded.hud_file.clone(),
        ] {
            assert!(!row.trim().is_empty());
        }
        assert_eq!(degraded.mcp, McpPort::Unset);
        assert_eq!(degraded.version_line, "Outpeek 0.4.4");
        assert_eq!(degraded.build_line, "debug");
    }
}
