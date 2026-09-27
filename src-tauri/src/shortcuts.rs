#![allow(dead_code)]

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ShortcutIcon {
    Valorant,
    Gamepad,
    Crosshair,
    Zap,
    Star,
    Maximize,
}

impl ShortcutIcon {
    pub fn all() -> &'static [ShortcutIcon] {
        &[
            ShortcutIcon::Valorant,
            ShortcutIcon::Gamepad,
            ShortcutIcon::Crosshair,
            ShortcutIcon::Zap,
            ShortcutIcon::Star,
            ShortcutIcon::Maximize,
        ]
    }

    pub fn to_str(&self) -> &'static str {
        match self {
            ShortcutIcon::Valorant => "valorant",
            ShortcutIcon::Gamepad => "gamepad",
            ShortcutIcon::Crosshair => "crosshair",
            ShortcutIcon::Zap => "zap",
            ShortcutIcon::Star => "star",
            ShortcutIcon::Maximize => "maximize",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "valorant" => ShortcutIcon::Valorant,
            "gamepad" => ShortcutIcon::Gamepad,
            "crosshair" => ShortcutIcon::Crosshair,
            "zap" => ShortcutIcon::Zap,
            "star" => ShortcutIcon::Star,
            _ => ShortcutIcon::Maximize,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            ShortcutIcon::Valorant => "Valorant",
            ShortcutIcon::Gamepad => "Gamepad",
            ShortcutIcon::Crosshair => "Crosshair",
            ShortcutIcon::Zap => "Lightning",
            ShortcutIcon::Star => "Star",
            ShortcutIcon::Maximize => "Window",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct QuickShortcut {
    pub id: String,
    pub name: String,
    pub window_match: String,
    pub icon: ShortcutIcon,
    pub is_removable: bool,
}

pub fn load_shortcuts() -> Vec<QuickShortcut> {
    let mut list = vec![QuickShortcut {
        id: "valorant".to_string(),
        name: "VALORANT".to_string(),
        window_match: "VALORANT".to_string(),
        icon: ShortcutIcon::Valorant,
        is_removable: false,
    }];

    if let Some(content) = crate::paths::read_data_file("shortcuts.txt") {
        for line in content.lines() {
            let clean_line = line.trim().trim_start_matches('\u{feff}');
            let parts: Vec<&str> = clean_line.split('|').collect();
            if parts.len() >= 4 {
                let id = parts[0].trim().to_string();
                let name = parts[1].trim().to_string();
                let window_match = parts[2].trim().to_string();
                let icon = ShortcutIcon::from_str(parts[3].trim());
                let is_removable = parts.get(4).map(|v| *v == "true").unwrap_or(true);

                if !id.eq_ignore_ascii_case("valorant")
                    && !name.is_empty()
                    && !window_match.is_empty()
                {
                    list.push(QuickShortcut {
                        id,
                        name,
                        window_match,
                        icon,
                        is_removable,
                    });
                }
            }
        }
    }

    list
}

pub fn save_shortcuts(shortcuts: &[QuickShortcut]) {
    let mut lines = Vec::new();
    for s in shortcuts {
        lines.push(format!(
            "{}|{}|{}|{}|{}",
            s.id,
            s.name,
            s.window_match,
            s.icon.to_str(),
            s.is_removable
        ));
    }
    let _ = crate::paths::write_data_file("shortcuts.txt", &lines.join("\r\n"));
}
