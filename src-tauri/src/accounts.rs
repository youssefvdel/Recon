//! Riot account switcher — the entire mechanism lives here; TypeScript only
//! renders what these commands return and forwards button clicks.
//!
//! Idea (learned from TcNo-Acc-Switcher, reimplemented — no foreign code):
//! the Riot Client keeps its login session in a handful of files under
//! `%LOCALAPPDATA%/Riot Games/Riot Client/`. Quicksaving an account snapshots
//! those files into the vault; switching kills the client processes, swaps a
//! snapshot into place, and relaunches the client — which wakes up already
//! logged into that account. No passwords are ever stored or typed.
//!
//! The swap set is adaptive: entries that don't exist on this machine are
//! skipped (older clients have `Cookies/`, newer ones may not; the private
//! settings file has shipped under two names). Candidates, newest first:
//!   Data/Cookies, Data/Sessions, Data/RiotClientPrivateSettings.yaml,
//!   Data/RiotGamesPrivateSettings.yaml, Config/RiotClientSettings.yaml

use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

/// Session locations relative to `<localappdata>/Riot Games/Riot Client/`.
/// Missing entries are skipped, never errors.
const SWAP_ENTRIES: &[&str] = &[
    "Data/Cookies",
    "Data/Sessions",
    "Data/RiotClientPrivateSettings.yaml",
    "Data/RiotGamesPrivateSettings.yaml",
    "Config/RiotClientSettings.yaml",
];

/// Client processes that pin the session files. The shipping exe is the live
/// game — the UI warns before a switch closes it.
const KILL_LIST: &[&str] = &[
    "RiotClientServices.exe",
    "RiotClientUx.exe",
    "RiotClientUxRender.exe",
    "VALORANT.exe",
    "VALORANT-Win64-Shipping.exe",
    "LeagueClient.exe",
];

/// Locate RiotClientServices.exe with zero hardcoded roots:
/// 1. the running process (authoritative exact path),
/// 2. uninstall registry entries (DisplayName match → InstallLocation probe).
fn client_exe_from_process() -> Option<PathBuf> {
    let out = silent_cmd("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-Process RiotClientServices -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path",
        ])
        .output()
        .ok()?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if p.is_empty() {
        return None;
    }
    let pb = PathBuf::from(p);
    if pb.is_file() {
        Some(pb)
    } else {
        None
    }
}

fn client_exe_from_registry() -> Option<PathBuf> {
    use winreg::enums::*;
    use winreg::RegKey;
    const UNINSTALL: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
    const UNINSTALL_WOW: &str = "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
    let hives = [
        (HKEY_LOCAL_MACHINE, UNINSTALL),
        (HKEY_LOCAL_MACHINE, UNINSTALL_WOW),
        (HKEY_CURRENT_USER, UNINSTALL),
    ];
    for (hive, base) in hives {
        let Ok(root) = RegKey::predef(hive).open_subkey(base) else {
            continue;
        };
        for name in root.enum_keys().flatten() {
            let Ok(k) = root.open_subkey(&name) else {
                continue;
            };
            let disp: String = k.get_value("DisplayName").unwrap_or_default();
            let low = disp.to_lowercase();
            if !(low.contains("riot") || low.contains("valorant")) {
                continue;
            }
            let loc: String = k.get_value("InstallLocation").unwrap_or_default();
            if loc.trim().is_empty() {
                continue;
            }
            let l = PathBuf::from(loc.trim());
            // InstallLocation may be the Riot root, the game dir, or the
            // client dir itself — probe the layouts, plus the parent level
            // (game dir with a sibling client dir, or a nested one).
            for s in ["Riot Client/RiotClientServices.exe", "RiotClientServices.exe"] {
                let c = l.join(s);
                if c.is_file() {
                    return Some(c);
                }
            }
            if let Some(parent) = l.parent() {
                for s in [
                    "Riot Client/RiotClientServices.exe",
                    "VALORANT/Riot Client/RiotClientServices.exe",
                ] {
                    let c = parent.join(s);
                    if c.is_file() {
                        return Some(c);
                    }
                }
            }
        }
    }
    None
}

fn find_client_exe() -> Result<PathBuf, String> {
    if let Some(p) = client_exe_from_process() {
        return Ok(p);
    }
    if let Some(p) = client_exe_from_registry() {
        return Ok(p);
    }
    Err("Riot Client not found — launch Valorant once first.".to_string())
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct AccountMeta {
    pub id: String,
    pub game_name: String,
    pub tag_line: String,
    pub puuid: String,
    /// Millis timestamps — plain numbers over the bridge.
    pub saved_at: i64,
    pub last_used: i64,
    /// Fingerprint of the live session files at snapshot time. The tick
    /// re-snapshots whenever this drifts = the client flushed new tokens.
    #[serde(default)]
    pub disk_sig: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct Seen {
    riot_id: String,
    at: i64,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Vault {
    #[serde(default)]
    accounts: Vec<AccountMeta>,
    #[serde(default)]
    last_seen: Option<Seen>,
    /// Relaunch the client after a switch. Default on (reference parity).
    #[serde(default = "default_auto_start")]
    auto_start: bool,
}

fn default_auto_start() -> bool {
    true
}

/// Minimum gap between two renewals of the same record — the client can
/// rewrite session files several times during login/play.
const RENEW_THROTTLE_MILLIS: i64 = 60 * 1000;

/// Fingerprint of the live session files: per candidate, mtime + size
/// (files) or mtime + child count (dirs), joined. Any client flush that
/// rotates tokens changes this — the exact "new token" signal.
fn disk_sig(live_base: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    for rel in SWAP_ENTRIES {
        let p = live_base.join(rel);
        let meta = match std::fs::metadata(&p) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        if meta.is_dir() {
            let count = std::fs::read_dir(&p).map(|r| r.count()).unwrap_or(0);
            parts.push(format!("{}:{}:{}", rel, mtime, count));
        } else {
            parts.push(format!("{}:{}:{}", rel, mtime, meta.len()));
        }
    }
    parts.join("|")
}

/// Snapshots seal file contents at rest (reference "vault" parity).
/// Sealed files carry the magic header; plain legacy files still restore.
const VAULT_MAGIC: &[u8] = b"RCM1";

/// Tag written into every snapshot root — the restore refuses a snapshot
/// whose tag disagrees with the requested id (cross-wire guard).
const ID_FILE: &str = "recon-id.txt";

#[cfg(windows)]
fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::HLOCAL;
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };
    use windows::core::PCWSTR;
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("Seal failed: {}", e))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData as *mut std::ffi::c_void));
        Ok(bytes)
    }
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::HLOCAL;
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| "Snapshot unreadable — it was sealed by another Windows user.".to_string())?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData as *mut std::ffi::c_void));
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(not(windows))]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

/// Seal one snapshot file in place (idempotent — skips sealed files).
fn seal_file(path: &Path) -> Result<(), String> {
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    if raw.starts_with(VAULT_MAGIC) {
        return Ok(());
    }
    let mut sealed = VAULT_MAGIC.to_vec();
    sealed.extend(dpapi_protect(&raw)?);
    std::fs::write(path, sealed).map_err(|e| e.to_string())
}

/// Read one snapshot file, unsealing when needed.
fn open_snapshot_file(path: &Path) -> Result<Vec<u8>, String> {
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    if raw.starts_with(VAULT_MAGIC) {
        dpapi_unprotect(&raw[VAULT_MAGIC.len()..])
    } else {
        Ok(raw)
    }
}

/// Collect a snapshot into memory: plain file bytes (unsealed) plus the dir
/// tree. Decrypting FIRST means a bad snapshot fails before live is touched.
fn stage_snapshot(snap: &Path) -> Result<(Vec<(PathBuf, Vec<u8>)>, Vec<PathBuf>), String> {
    let mut files: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![snap.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let p = entry.path();
            let rel = p.strip_prefix(snap).map_err(|e| e.to_string())?.to_path_buf();
            if rel.components().count() > 8 {
                return Err("Snapshot path too deep.".to_string());
            }
            if p.is_dir() {
                dirs.push(rel);
                stack.push(p);
            } else {
                if entry.file_name() == ID_FILE {
                    continue;
                }
                files.push((rel, open_snapshot_file(&p)?));
            }
        }
    }
    Ok((files, dirs))
}

/// Write a staged snapshot to live: clear first, recreate dirs, write files.
fn write_staged(
    live_base: &Path,
    files: &[(PathBuf, Vec<u8>)],
    dirs: &[PathBuf],
) -> Result<(), String> {
    clear_live(live_base);
    for rel in dirs {
        std::fs::create_dir_all(live_base.join(rel)).map_err(|e| e.to_string())?;
    }
    for (rel, bytes) in files {
        let dst = live_base.join(rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&dst, bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Seal every file under a snapshot root (dirs skipped, ID tag skipped).
fn seal_snapshot_files(snap: &Path) -> Result<(), String> {
    let mut stack: Vec<PathBuf> = vec![snap.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if entry.file_name() != ID_FILE {
                seal_file(&p)?;
            }
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct TickResult {
    pub current: Option<String>,
    pub changed: bool,
    pub is_new: bool,
}

#[derive(serde::Serialize)]
pub struct SwitchResult {
    pub ok: bool,
    pub auto_saved: bool,
    pub game_was_running: bool,
    pub relaunched: bool,
}

fn silent_cmd(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Launch RiotClientServices.exe as a completely detached, top-level process
/// via Windows ShellExecuteW. This ensures Riot Client (and any game it launches)
/// is parented by Windows Explorer / Desktop Shell, NOT recon.exe.
/// If Recon is closed, updated, or End-Tasked in Task Manager, Valorant and
/// Riot Client stay 100% alive without being terminated by Windows Job Objects.
pub fn launch_client_detached(exe_path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let wide_exe: Vec<u16> = exe_path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let wide_op: Vec<u16> = std::ffi::OsStr::new("open").encode_wide().chain(std::iter::once(0)).collect();
        let dir = exe_path.parent();
        let wide_dir: Option<Vec<u16>> = dir.map(|d| d.as_os_str().encode_wide().chain(std::iter::once(0)).collect());

        let res = unsafe {
            ShellExecuteW(
                HWND(std::ptr::null_mut()),
                PCWSTR(wide_op.as_ptr()),
                PCWSTR(wide_exe.as_ptr()),
                PCWSTR::null(),
                wide_dir.as_ref().map(|d| PCWSTR(d.as_ptr())).unwrap_or(PCWSTR::null()),
                SW_SHOWNORMAL,
            )
        };

        if (res.0 as usize) <= 32 {
            use std::os::windows::process::CommandExt;
            let mut cmd = Command::new(exe_path);
            if let Some(d) = dir {
                cmd.current_dir(d);
            }
            // 0x01000000 = CREATE_BREAKAWAY_FROM_JOB
            // 0x00000008 = DETACHED_PROCESS
            // 0x00000200 = CREATE_NEW_PROCESS_GROUP
            cmd.creation_flags(0x01000000 | 0x00000008 | 0x00000200);
            cmd.spawn().map_err(|e| format!("Failed to launch client: {}", e))?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Command::new(exe_path).spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn riot_client_dir() -> Result<PathBuf, String> {
    let la = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA not set.".to_string())?;
    Ok(PathBuf::from(la)
        .join("Riot Games")
        .join("Riot Client"))
}

fn vault_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "App data dir unavailable.".to_string())?
        .join("accounts");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Vault unavailable: {}", e))?;
    Ok(dir)
}

fn meta_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(vault_root(app)?.join("accounts.json"))
}

fn load_vault(app: &tauri::AppHandle) -> Vault {
    let path = match meta_path(app) {
        Ok(p) => p,
        Err(_) => return Vault::default(),
    };
    let raw = std::fs::read_to_string(path).unwrap_or_default();
    if raw.trim().is_empty() {
        return Vault::default();
    }
    // Current shape first, then the legacy bare-array shape.
    if let Ok(v) = serde_json::from_str::<Vault>(&raw) {
        return v;
    }
    match serde_json::from_str::<Vec<AccountMeta>>(&raw) {
        Ok(accounts) => Vault { accounts, last_seen: None, ..Default::default() },
        Err(_) => Vault::default(),
    }
}

fn store_vault(app: &tauri::AppHandle, vault: &Vault) -> Result<(), String> {
    let path = meta_path(app)?;
    let raw = serde_json::to_string_pretty(vault).map_err(|e| e.to_string())?;
    // Atomic write: temp + rename, so a crash mid-save can never leave a
    // torn accounts.json behind. This is the durability SQLite would buy us
    // at this scale (a dozen rows, one writer) — without the dependency.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("Vault write failed: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Vault write failed: {}", e))
}

fn load_metas(app: &tauri::AppHandle) -> Vec<AccountMeta> {
    load_vault(app).accounts
}

fn store_metas(app: &tauri::AppHandle, metas: &[AccountMeta]) -> Result<(), String> {
    let mut vault = load_vault(app);
    vault.accounts = metas.to_vec();
    store_vault(app, &vault)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let entries = std::fs::read_dir(src).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Mirror one swap entry live <-> snapshot. Direction live→vault when
/// `to_vault`, vault→live otherwise. Absent sources are skipped.
fn mirror_entry(live_base: &Path, vault_base: &Path, rel: &str, to_vault: bool) -> Result<(), String> {
    let (src, dst) = if to_vault {
        (live_base.join(rel), vault_base.join(rel))
    } else {
        (vault_base.join(rel), live_base.join(rel))
    };
    if !src.exists() {
        return Ok(());
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if src.is_dir() {
        if dst.exists() {
            std::fs::remove_dir_all(&dst).map_err(|e| e.to_string())?;
        }
        copy_dir_recursive(&src, &dst)
    } else {
        std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Delete every candidate live entry (files and dirs), ignoring absence.
/// Mirrors TcNo's ClearCurrentLogin: the restore must never mix a snapshot
/// with leftovers of another login state.
fn clear_live(live_base: &Path) {
    for rel in SWAP_ENTRIES {
        let p = live_base.join(rel);
        if p.is_dir() {
            let _ = std::fs::remove_dir_all(&p);
        } else if p.exists() {
            let _ = std::fs::remove_file(&p);
        }
    }
}

fn slug(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn process_running(image: &str) -> bool {
    let out = silent_cmd("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {}", image), "/NH"])
        .output();
    match out {
        Ok(o) => {
            let txt = String::from_utf8_lossy(&o.stdout).to_lowercase();
            txt.contains(&image.to_lowercase())
        }
        Err(_) => false,
    }
}

fn kill_clients() {
    // Two-phase: graceful WM_CLOSE first so the client flushes reboot-grade
    // credentials to disk (a /F-only kill keeps whatever stale copy happens
    // to be on disk — unrestorable once server-side rotation moves on).
    // Force-kill leftovers afterwards so a hung process can't block a switch.
    for image in KILL_LIST {
        let _ = silent_cmd("taskkill").args(["/IM", image]).output();
    }
    for _ in 0..16 {
        if !KILL_LIST.iter().any(|i| process_running(i)) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    for image in KILL_LIST {
        let _ = silent_cmd("taskkill").args(["/F", "/IM", image]).output();
    }
    // Let handles release before the swap; bail early once all are gone.
    for _ in 0..10 {
        if !KILL_LIST.iter().any(|i| process_running(i)) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    // Shutdown writes land just before process exit — let them settle.
    std::thread::sleep(std::time::Duration::from_millis(2000));
}

fn current_identity() -> Result<(String, String), String> {
    let (port, password) = crate::tracker::lockfile_auth()?;
    let v = crate::tracker::local_get(&port, &password, "/player-account/aliases/v1/active")?;
    let name = v
        .get("game_name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let tag = v
        .get("tag_line")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if name.is_empty() {
        return Err("No signed-in Riot account — log in once first.".to_string());
    }
    Ok((name, tag))
}

fn snapshot_current(
    app: &tauri::AppHandle,
    live: &Path,
    now: i64,
    touch_used: bool,
) -> Result<AccountMeta, String> {
    let (game_name, tag_line) = current_identity()?;
    let mut vault = load_vault(app);
    let key = format!("{}#{}", game_name.to_lowercase(), tag_line.to_lowercase());
    let id = vault
        .accounts
        .iter()
        .find(|m| format!("{}#{}", m.game_name.to_lowercase(), m.tag_line.to_lowercase()) == key)
        .map(|m| m.id.clone())
        .unwrap_or_else(|| format!("{}-{}", slug(&format!("{}-{}", game_name, tag_line)), now));
    let snap = vault_root(app)?.join(&id);
    std::fs::create_dir_all(&snap).map_err(|e| e.to_string())?;
    for rel in SWAP_ENTRIES {
        mirror_entry(live, &snap, rel, true)?;
    }
    // Tag the snapshot with its owner id (cross-wire guard on restore) and
    // seal every file at rest (reference vault parity). Both idempotent.
    std::fs::write(snap.join(ID_FILE), id.as_str()).map_err(|e| e.to_string())?;
    seal_snapshot_files(&snap)?;
    let is_new = !vault.accounts.iter().any(|m| m.id == id);
    let _ = is_new;
    let meta = AccountMeta {
        id: id.clone(),
        game_name,
        tag_line,
        puuid: String::new(),
        saved_at: now,
        // Background refreshes renew credentials only; the "used" stamp is
        // for real manual saves and switches.
        last_used: vault
            .accounts
            .iter()
            .find(|m| m.id == id)
            .map(|m| if touch_used { now } else { m.last_used })
            .unwrap_or(now),
        disk_sig: disk_sig(live),
    };
    if let Some(slot) = vault.accounts.iter_mut().find(|m| m.id == id) {
        let first = slot.saved_at;
        let used = slot.last_used;
        *slot = meta.clone();
        slot.saved_at = first;
        if !touch_used {
            slot.last_used = used;
        }
    } else {
        vault.accounts.push(meta.clone());
    }
    // Most-recent first — the UI renders in order, no sorting logic needed.
    vault.accounts.sort_by(|a, b| b.last_used.cmp(&a.last_used));
    vault.last_seen = Some(Seen { riot_id: key, at: now });
    store_vault(app, &vault)?;
    Ok(meta)
}

/// Saved account snapshots, most-recent first. UI renders in order.
#[tauri::command]
pub async fn accounts_list(app: tauri::AppHandle) -> Result<Vec<AccountMeta>, String> {
    Ok(load_metas(&app))
}

/// Whoever is signed into the Riot Client right now (`Name#Tag`), or null.
/// Lets the UI badge the live account and disable switching to itself.
#[tauri::command]
pub async fn account_current() -> Result<Option<String>, String> {
    Ok(current_identity()
        .map(|(name, tag)| format!("{}#{}", name, tag))
        .ok())
}

/// Snapshot whoever is signed in right now (upsert by Riot ID).
#[tauri::command]
pub async fn account_save_current(app: tauri::AppHandle) -> Result<AccountMeta, String> {
    let live = riot_client_dir()?;
    let now = now_millis();
    tauri::async_runtime::spawn_blocking(move || snapshot_current(&app, &live, now, true))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

/// Watchdog tick — the UI calls this on a timer; ALL policy lives here.
/// Renewal is driven by the files, not the clock: whoever is signed in gets
/// re-snapshotted whenever the live session files drift from the stored
/// fingerprint (client flushed new tokens), throttled to once a minute.
/// Unknown login → snapshot immediately. Client closed → quiet no-op.
#[tauri::command]
pub async fn accounts_auto_tick(app: tauri::AppHandle) -> Result<TickResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let now = now_millis();
        let identity = match current_identity() {
            Ok((name, tag)) => format!("{}#{}", name, tag),
            Err(_) => {
                return Ok(TickResult { current: None, changed: false, is_new: false });
            }
        };
        let key = identity.to_lowercase();
        let live = riot_client_dir()?;
        let vault = load_vault(&app);
        let rec = vault.accounts.iter().find(|m| {
            format!("{}#{}", m.game_name.to_lowercase(), m.tag_line.to_lowercase()) == key
        });
        match rec {
            None => {
                // New login seen — snapshot it straight away.
                match snapshot_current(&app, &live, now, false) {
                    Ok(_) => Ok(TickResult { current: Some(identity), changed: true, is_new: true }),
                    Err(_) => Ok(TickResult { current: Some(identity), changed: false, is_new: false }),
                }
            }
            Some(r) => {
                // Known login: renew only on fresh disk state, throttled.
                if now - r.saved_at < RENEW_THROTTLE_MILLIS {
                    return Ok(TickResult { current: Some(identity), changed: false, is_new: false });
                }
                if disk_sig(&live) == r.disk_sig {
                    // No flush since the snapshot — stamp the sighting so the
                    // next drift check has a sane baseline, without copying.
                    let mut vault = load_vault(&app);
                    vault.last_seen = Some(Seen { riot_id: key, at: now });
                    let _ = store_vault(&app, &vault);
                    return Ok(TickResult { current: Some(identity), changed: false, is_new: false });
                }
                match snapshot_current(&app, &live, now, false) {
                    Ok(_) => Ok(TickResult { current: Some(identity), changed: true, is_new: false }),
                    Err(_) => Ok(TickResult { current: Some(identity), changed: false, is_new: false }),
                }
            }
        }
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Switch to a snapshot, mirroring TcNo's ritual exactly:
/// graceful kill (shutdown flush writes reboot-grade credentials) → save the
/// previous session AFTER the kill → clear all live login state → restore
/// the snapshot → relaunch the bare client exe (no forced args).
#[tauri::command]
pub async fn account_switch(app: tauri::AppHandle, id: String) -> Result<SwitchResult, String> {
    if id.contains(['/', '\\', '.', ':']) || id.is_empty() || id.len() > 128 {
        return Err("Invalid account.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let snap = vault_root(&app)?.join(&id);
        if !snap.is_dir() {
            return Err("Unknown account.".to_string());
        }
        let live = riot_client_dir()?;
        let now = now_millis();
        // Resolve the relaunch target BEFORE killing anything: a missing exe
        // must never leave the client dead.
        let exe = find_client_exe()?;
        let game_was_running =
            process_running("VALORANT.exe") || process_running("VALORANT-Win64-Shipping.exe");
        kill_clients();
        // Auto-save whoever was signed in — post-kill files are the freshest.
        // Identity unresolvable (already logged out) → skip, keep the snapshot.
        let auto_saved = snapshot_current(&app, &live, now, true).is_ok();
        // Cross-wire guard: the snapshot must tag itself with this id.
        // Legacy (untagged) snapshots restore without the check.
        let tag = std::fs::read_to_string(snap.join(ID_FILE)).unwrap_or_default();
        if !tag.trim().is_empty() && tag.trim() != id {
            return Err("Snapshot mismatch — refusing to restore.".to_string());
        }
        // Stage (decrypt) fully BEFORE touching live, then clear + write.
        let (files, dirs) = stage_snapshot(&snap)?;
        write_staged(&live, &files, &dirs)?;
        let mut vault = load_vault(&app);
        let auto_start = vault.auto_start;
        if let Some(slot) = vault.accounts.iter_mut().find(|m| m.id == id) {
            slot.last_used = now;
        }
        vault.accounts.sort_by(|a, b| b.last_used.cmp(&a.last_used));
        store_vault(&app, &vault)?;
        let relaunched = if auto_start {
            launch_client_detached(&exe)?;
            true
        } else {
            false
        };
        Ok(SwitchResult { ok: true, auto_saved, game_was_running, relaunched })
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Forget a snapshot (vault files + metadata). Never touches the live login.
#[tauri::command]
pub async fn account_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if id.contains(['/', '\\', '.', ':']) || id.is_empty() || id.len() > 128 {
        return Err("Invalid account.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let snap = vault_root(&app)?.join(&id);
        if snap.is_dir() {
            std::fs::remove_dir_all(&snap).map_err(|e| e.to_string())?;
        }
        let mut metas = load_metas(&app);
        metas.retain(|m| m.id != id);
        store_metas(&app, &metas)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Vault setting: relaunch the client after a switch. Default on.
#[tauri::command]
pub async fn accounts_get_auto_start(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(load_vault(&app).auto_start)
}

/// Vault setting: relaunch the client after a switch. Default on.
#[tauri::command]
pub async fn accounts_set_auto_start(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut vault = load_vault(&app);
        vault.auto_start = enabled;
        store_vault(&app, &vault)?;
        Ok(enabled)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Log in a new account without touching any snapshot: snapshot whoever is
/// signed in (best effort), clear the live login, relaunch to a fresh login
/// screen. The watchdog auto-saves the new login once it lands.
#[tauri::command]
pub async fn account_add_new(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let live = riot_client_dir()?;
        let now = now_millis();
        let exe = find_client_exe()?;
        kill_clients();
        let saved_prev = snapshot_current(&app, &live, now, true).is_ok();
        clear_live(&live);
        let mut vault = load_vault(&app);
        let auto_start = vault.auto_start;
        vault.last_seen = None;
        store_vault(&app, &vault)?;
        if auto_start {
            launch_client_detached(&exe)?;
        }
        Ok(saved_prev)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Launch RiotClientServices.exe detached from Recon so it survives Recon exit/kill.
#[tauri::command]
pub async fn account_launch_client() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe = find_client_exe()?;
        launch_client_detached(&exe)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}
