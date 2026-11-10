//! Unit tests for the config editor.

use super::*;
use std::fs;

use super::discover::parse_config;

    fn polluted_tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("aspect_ini_test");
        let _ = fs::create_dir_all(&dir);
        let p = dir.join(name);
        // Simulate the polluted file: keys repeated 30x, as the old bug produced.
        let mut text = String::from("[/Script/ShooterGame.ShooterGameUserSettings]\n");
        for _ in 0..30 {
            text.push_str("ResolutionSizeX=2090\nResolutionSizeY=1440\n");
        }
        text.push_str("FullscreenMode=2\nbShouldLetterbox=False\n");
        fs::write(&p, &text).unwrap();
        p
    }

    #[test]
    fn update_heals_duplicates_to_single_keys() {
        let p = polluted_tmp("heal.ini");
        update_config(&p, true, Some((1280, 960)), false).unwrap();
        let out = fs::read_to_string(&p).unwrap();
        // Count by exact key (trimmed, before '='): ini-preserve may style
        // new keys as "Key = value" — both forms are valid UE4 INI.
        let count_key = |out: &str, key: &str| {
            out.lines()
                .filter(|l| {
                    let t = l.trim();
                    match t.find('=') {
                        Some(i) => t[..i].trim() == key,
                        None => false,
                    }
                })
                .count()
        };
        let has_kv = |out: &str, key: &str, val: &str| {
            out.lines().any(|l| {
                let t = l.trim();
                match t.find('=') {
                    Some(i) => t[..i].trim() == key && t[i + 1..].trim() == val,
                    None => false,
                }
            })
        };
        for key in [
            "ResolutionSizeX",
            "ResolutionSizeY",
            "LastUserConfirmedResolutionSizeX",
            "LastUserConfirmedResolutionSizeY",
            "FullscreenMode",
            "LastConfirmedFullscreenMode",
            "PreferredFullscreenMode",
            "bShouldLetterbox",
            "bLastConfirmedShouldLetterbox",
            "DesiredScreenWidth",
            "DesiredScreenHeight",
        ] {
            let n = count_key(&out, key);
            assert_eq!(n, 1, "key {key} appears {n}x");
        }
        assert!(has_kv(&out, "ResolutionSizeX", "1280"));
        assert!(has_kv(&out, "ResolutionSizeY", "960"));
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn single_key_write_roundtrips_and_creates_section() {
        let p = polluted_tmp("single.ini");
        // Section does not exist yet — must be created, exactly once.
        set_config_value(&p, "[ScalabilityGroups]", "sg.ShadowQuality", "0", false).unwrap();
        // Second write to the same key must update, never duplicate.
        set_config_value(&p, "[ScalabilityGroups]", "sg.ShadowQuality", "3", false).unwrap();
        let out = fs::read_to_string(&p).unwrap();
        assert!(out.contains("[ScalabilityGroups]"));
        let n = out
            .lines()
            .filter(|l| {
                let t = l.trim();
                match t.find('=') {
                    Some(i) => t[..i].trim() == "sg.ShadowQuality",
                    None => false,
                }
            })
            .count();
        assert_eq!(n, 1, "sg.ShadowQuality appears {n}x");
        let has = out.lines().any(|l| {
            let t = l.trim();
            match t.find('=') {
                Some(i) => t[..i].trim() == "sg.ShadowQuality" && t[i + 1..].trim() == "3",
                None => false,
            }
        });
        assert!(has, "sg.ShadowQuality=3 missing");
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn config_sync_and_health_verification() {
        let p = polluted_tmp("sync_health.ini");
        update_config(&p, true, Some((2088, 1440)), true).unwrap();
        let parsed = parse_config(&p).expect("should parse synced config");
        assert_eq!(parsed.res_x, Some(2088));
        assert_eq!(parsed.res_y, Some(1440));
        assert_eq!(parsed.fullscreen_mode, Some(2));
        assert_eq!(parsed.should_letterbox, Some(false));
        assert_eq!(parsed.last_letterbox, Some(false));
        assert_eq!(parsed.window_pos_x, Some(0));
        assert_eq!(parsed.window_pos_y, Some(0));
        assert!(parsed.is_read_only);

        // Verify Engine section bUseDesiredScreenHeight = True
        let raw = fs::read_to_string(&p).unwrap();
        assert!(raw.contains("bUseDesiredScreenHeight=True") || raw.contains("bUseDesiredScreenHeight = True"));
        assert!(raw.contains("sg.ResolutionQuality=100") || raw.contains("sg.ResolutionQuality = 100"));

        // Clean up readonly before removal
        let mut perms = fs::metadata(&p).unwrap().permissions();
        perms.set_readonly(false);
        let _ = fs::set_permissions(&p, perms);
        let _ = fs::remove_file(&p);
    }
