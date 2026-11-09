#![allow(dead_code)]
//! (moved verbatim from `display.rs`; split only, behaviour unchanged.)

/// Last-known resolution cache so disabled monitors keep showing their real
/// resolution (and a correct aspect ratio) instead of 0x0 / NaN.
///
/// Storage is a pretty-printed, name-sorted JSON **array** with full field
/// names — human-readable by design:
///
/// ```json
/// [
///   {
///     "id": "display\\phlc401\\5&3cd28fe&0&uid4357",
///     "name": "PHLC401",
///     "width": 2560,
///     "height": 1440,
///     "refresh_hz": 260
///   }
/// ]
/// ```
///
/// The `id` stays the stable lowercase PnP instance path (friendly names are
/// neither unique nor stable enough to key on — two identical panels share a
/// model string). The legacy `{ "<id>": {"w","h","r"} }` object format still
/// loads and is rewritten pretty on the next save.
#[derive(Clone, Debug)]
pub(super) struct CachedRes {
    pub(super) name: String,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) refresh_hz: u32,
}

/// Display label for a lowercase PnP instance path
/// (`display\<model>\<uid>` → `MODEL`).
pub(super) fn model_label(lower_id: &str) -> String {
    lower_id
        .split('\\')
        .nth(1)
        .map(|m| m.to_ascii_uppercase())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| lower_id.to_string())
}

pub(super) fn load_monitor_res_cache() -> std::collections::HashMap<String, CachedRes> {
    let mut out = std::collections::HashMap::new();
    let text = match crate::paths::read_data_file("monitor_res_cache.json") {
        Some(t) => t,
        None => return out,
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return out;
    };
    // Current format: pretty array of entries.
    if let Some(arr) = json.as_array() {
        for v in arr {
            let id = v
                .get("id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_lowercase();
            if id.is_empty() {
                continue;
            }
            let w = v.get("width").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            let h = v.get("height").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            let r = v.get("refresh_hz").and_then(|x| x.as_u64()).unwrap_or(60) as u32;
            if w > 0 && h > 0 {
                let name = v
                    .get("name")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| model_label(&id));
                out.insert(
                    id,
                    CachedRes {
                        name,
                        width: w,
                        height: h,
                        refresh_hz: r,
                    },
                );
            }
        }
        return out;
    }
    // Legacy format: `{ "<pnp path>": {"w":..,"h":..,"r":..} }`.
    if let Some(obj) = json.as_object() {
        for (k, v) in obj {
            let w = v.get("w").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            let h = v.get("h").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            let r = v.get("r").and_then(|x| x.as_u64()).unwrap_or(60) as u32;
            if w > 0 && h > 0 {
                let id = k.to_lowercase();
                out.insert(
                    id.clone(),
                    CachedRes {
                        name: model_label(&id),
                        width: w,
                        height: h,
                        refresh_hz: r,
                    },
                );
            }
        }
    }
    out
}

pub(super) fn save_monitor_res_cache(cache: &std::collections::HashMap<String, CachedRes>) {
    let mut entries: Vec<serde_json::Value> = cache
        .iter()
        .map(|(id, c)| {
            serde_json::json!({
                "id": id,
                "name": c.name,
                "width": c.width,
                "height": c.height,
                "refresh_hz": c.refresh_hz,
            })
        })
        .collect();
    // Sort by display name so the file is deterministic (HashMap order is
    // random) and reads top-to-bottom.
    entries.sort_by(|a, b| {
        let an = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let bn = b.get("name").and_then(|x| x.as_str()).unwrap_or("");
        an.cmp(bn)
    });
    let text = serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".to_string());
    let _ = crate::paths::write_data_file("monitor_res_cache.json", &text);
}
