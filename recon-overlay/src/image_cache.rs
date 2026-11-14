//! URL -> disk image cache for agent icons / rank crests.
//!
//! Ownership split: the MAIN app downloads (it already owns HTTP via
//! `trn_http`) and writes response bytes with [`store_bytes`]; the sidecar
//! only ever reads local files through [`load`]. Files are content-addressed
//! by URL hash so a stale portrait can never serve a new agent, and the dir
//! is capped at ~50 MB with mtime LRU eviction ([`evict_lru`], also run at
//! sidecar startup).

use std::path::PathBuf;

use slint::{Image, Rgb8Pixel, SharedPixelBuffer};

/// Budget for the on-disk portrait/crest cache (~50 MB).
pub const CACHE_BUDGET_BYTES: u64 = 50 * 1024 * 1024;

pub fn cache_dir() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(r"C:\Users\Administrator\AppData\Local"))
            .join("Recon")
            .join("overlay-images")
    }
    #[cfg(not(windows))]
    {
        std::env::var("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                std::env::var("HOME")
                    .map(|h| PathBuf::from(h).join(".cache"))
                    .unwrap_or_else(|_| std::env::temp_dir())
            })
            .join("recon-overlay-images")
    }
}

/// Stable filename for a URL: hash + the origin extension when it looks like
/// an image suffix, `.bin` otherwise (Slint/`image` sniff content, not names).
pub fn path_for_url(url: &str) -> PathBuf {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in url.bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let ext = url
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('.')
        .next()
        .map(str::to_lowercase)
        .filter(|e| matches!(e.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif"))
        .unwrap_or_else(|| "bin".to_string());
    cache_dir().join(format!("{hash:016x}.{ext}"))
}

/// Write downloaded bytes for a URL. Returns the file path.
///
/// Called by the main app's downloader hookup (Phase 4 wiring); the test
/// suite covers it until then.
#[allow(dead_code)]
pub fn store_bytes(url: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let path = path_for_url(url);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, bytes)?;
    evict_lru(CACHE_BUDGET_BYTES);
    Ok(path)
}

/// Load a cached URL as a Slint image. Missing/invalid files are NOT errors:
/// the caller renders the empty slot (facts.slint leaves unknown icons empty,
/// never placeholders-as-data).
pub fn load(url: &str) -> Image {
    if url.is_empty() {
        return Image::default();
    }
    let path = path_for_url(url);
    // Sniff content, not the filename: hash names may carry `.bin`.
    let Ok(bytes) = std::fs::read(&path) else {
        return Image::default();
    };
    let Ok(dyn_img) = image::load_from_memory(&bytes) else {
        return Image::default();
    };
    let rgba = dyn_img.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    if w == 0 || h == 0 || w > 1024 || h > 1024 {
        return Image::default();
    }
    let mut buf: SharedPixelBuffer<Rgb8Pixel> = SharedPixelBuffer::new(w, h);
    for (dst, src) in buf
        .make_mut_bytes()
        .chunks_exact_mut(3)
        .zip(rgba.as_raw().chunks_exact(4))
    {
        dst.copy_from_slice(&src[..3]);
    }
    Image::from_rgb8(buf)
}

/// Drop oldest files (by mtime) until the dir fits `max_bytes`.
pub fn evict_lru(max_bytes: u64) {
    let dir = cache_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some((meta.modified().ok()?, meta.len(), e.path()))
        })
        .collect();
    let total: u64 = files.iter().map(|(_, len, _)| *len).sum();
    if total <= max_bytes {
        return;
    }
    files.sort_by_key(|(mtime, _, _)| *mtime);
    let mut freed = 0u64;
    let need = total - max_bytes;
    for (_, len, path) in files {
        if freed >= need {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            freed += len;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_paths_are_stable_and_suffixed() {
        let a = path_for_url("https://example.com/Jett.png?w=1");
        let b = path_for_url("https://example.com/Jett.png?w=1");
        let c = path_for_url("https://example.com/Omen.png?w=1");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.extension().and_then(|e| e.to_str()), Some("png"));
    }

    #[test]
    fn store_and_load_roundtrip() {
        use image::ImageEncoder;
        let mut png: Vec<u8> = Vec::new();
        let img = image::RgbImage::from_fn(4, 4, |x, y| {
            image::Rgb([(x * 64) as u8, (y * 64) as u8, 128])
        });
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(img.as_raw(), 4, 4, image::ExtendedColorType::Rgb8)
            .unwrap();
        let url = "https://example.com/roundtrip-agent.png";
        let path = store_bytes(url, &png).unwrap();
        assert!(path.exists());
        let loaded = load(url);
        assert_eq!((loaded.size().width, loaded.size().height), (4, 4));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_missing_is_empty_not_error() {
        let img = load("https://example.com/never-cached-0000.png");
        assert_eq!(img.size().width, 0);
    }

    #[test]
    fn evict_lru_keeps_newest_under_budget() {
        let dir = cache_dir();
        let _ = std::fs::create_dir_all(&dir);
        let now = std::time::SystemTime::now();
        for i in 0..4u8 {
            let p = dir.join(format!("evict-test-{i}.bin"));
            std::fs::write(&p, vec![i; 1024]).unwrap();
            // Stagger mtimes: file 0 oldest, file 3 newest.
            let t = now - std::time::Duration::from_secs((4 - i as u64) * 10);
            let ft = filetime::FileTime::from_system_time(t);
            filetime::set_file_mtime(&p, ft).unwrap();
        }
        evict_lru(2500);
        let remaining: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.starts_with("evict-test-"))
                    .unwrap_or(false)
            })
            .collect();
        // 4x1024 = 4096 > 2500: the two oldest must go, the two newest stay.
        assert_eq!(remaining.len(), 2, "evict kept {remaining:?}");
        for e in &remaining {
            let _ = std::fs::remove_file(e.path());
        }
    }
}
