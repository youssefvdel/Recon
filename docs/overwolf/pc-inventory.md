# Overwolf / Tracker Network — PC inventory + install → copy → uninstall plan

Captured 2026-11-08 17:57–18:00 (Africa/Cairo) over SSH to `youssefvdel@192.168.100.3`.
**Read-only round: nothing was installed, downloaded, changed or deleted on the PC.**

## 1. Inventory

| Item | Result |
| --- | --- |
| Overwolf client installed? | **No.** `%LOCALAPPDATA%\Overwolf`, `%PROGRAMFILES%\Overwolf`, `%PROGRAMFILES(x86)%\Overwolf`, `%PROGRAMDATA%\Overwolf`, `%APPDATA%\Overwolf` all absent |
| Overwolf processes | **0** (`tasklist` filtered; no Overwolf.exe / OverwolfBrowser.exe / OverwolfHelper*.exe) |
| Overwolf registry / URI handler | **None.** No `HKCU|HKLM\Software\Overwolf`, no `HKLM\Software\Classes\overwolf` or `overwolfstore` |
| TRN app present? | **No** — no app packages anywhere (nothing to inventory) |
| VALORANT | **Installed**: `C:\Program Files (x64)\Riot Games\VALORANT\live` (~35.1 GB, 278 files). Note the non-standard `Program Files (x64)` root |
| Riot Client | `C:\Program Files (x64)\Riot Games\Riot Client\RiotClientServices.exe`, 142.0.6.5218, mtime 2026-11-05 17:31 |
| Riot Vanguard | `C:\Program Files\Riot Vanguard` present |
| Game activity | Prefetch shows `VALORANT-WIN64-SHIPPING.EXE` last run 2026-11-08 01:36 — he plays on this PC |
| Free disk | C: 289.9 GB free of 930.1 GB |
| Interactive session | **Yes**, session 1 (console) active, logged in 2026-11-08 16:00 |
| SSH shell elevation | **Elevated** (`IsInRole(Administrator) = True`) |
| UAC | **Off** (`HKLM\...\Policies\System\EnableLUA = 0`) — installers never raise a UAC prompt |
| Network to Overwolf | DNS resolves: `download.overwolf.com` → 108.159.102.x, `www.overwolf.com` → 3.175.196.x |

## 2. What the "TRN Overwolf app" actually is (verified from the store page)

- Store page: <https://www.overwolf.com/app/tracker_network-tracker.gg>
- App id: `ekmbhgikmjbagjojiebkkbgghcedofnobpajodoi` · platform **Electron** · version **0.23.0** (2026-11-05) · package 133.3 MB · alpha · contains ads.
- Official blurb: *"This is a standalone app … it does not require the Overwolf client."*
  → **Do not install the Overwolf client.** It is not needed; installing it adds a second
  uninstall, extra services and more risk for zero study value.
- Supported titles on the page: Battlefield 6, Fortnite, R6 Siege, Roblox, Deadlock ("more soon").
  **VALORANT is not listed.** The page only names Valorant as something tracker.gg covers as a site.
- Install footprint is not "one folder in Program Files": it is an ow-electron app installed per-user
  (expected under `%LOCALAPPDATA%`; exact dir confirmed at install time, see step 3).

## 3. Official download URLs (verified with HEAD from the PC, nothing downloaded)

Both are small bootstrappers; the real payload comes from Overwolf's CDN during install.

| Target | URL | Resolves to | Size |
| --- | --- | --- | --- |
| TRN app (preferred) | `https://download.overwolf.com/install/Download?Name=Tracker.gg&ExtensionId=ekmbhgikmjbagjojiebkkbgghcedofnobpajodoi&Channel=web_dl_btn&utm_source=web_app_store` | `.../installer/prod/4ff7f4e10254b4b849f9a89fa895963e/Tracker.gg%20-%20Installer.exe` | 3,013,313 B |
| Overwolf client (not needed) | `https://download.overwolf.com/install/Download?Channel=web_dl_btn&utm_source=web_app_store` | `.../installer/prod/dc79fe6e46b9754dafd65483453e1ab7/OverwolfInstaller.exe` | 2,994,071 B |

Integrity: **Overwolf publishes no checksum file** for either installer (no hash on the page or in
the redirect chain). Substitute, in this order: HTTPS to the official host, then Authenticode
(`Get-AuthenticodeSignature` must be `Valid` and signed by Overwolf Ltd), then our own SHA-256
recorded before execution. Treat a silently-failing signature as a stop.

**Deep link correction:** there is no documented `overwolf://install/<appId>` deep link for this app.
The official route is the HTTPS download endpoint above; Overwolf's URI handler (`overwolfstore://`,
`overwolf-support://`) only exists after a client install, which we are skipping. Do not build the
plan around a deep link.

## 4. GEP reality check (needed later)

VALORANT game events on Overwolf are real and rich — the dev docs expose `roster` (player names,
puuids, **rank**), `match_id`, `scoreboard`, `kill_feed`, `match_start/end`, map, round phase
(<https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/valorant/>). So the platform
can produce the events.

But events are delivered to **apps that subscribe**, and the TRN standalone app does not list
VALORANT as a supported title. Expect the TRN app to be useful for studying *how TRN talks to its
backend*, not for VALORANT GEP capture. If GEP capture is the real goal, the correct tool is
Overwolf's open-source <https://github.com/overwolf/events-sample-app> (or a 20-line ow-electron
app that subscribes to `match_info`), not this installer. **Confirm which one the study wants before
installing anything** — that single answer decides whether steps 5–9 are even needed.

## 5. Plan (each step marked silent / needs-user)

Preconditions: UAC off, SSH shell elevated, session 1 active. All PC work over
`ssh -o BatchMode=yes youssefvdel@192.168.100.3 "powershell -NoProfile -Command -" < step.ps1`.

| # | Step | Mode |
| --- | --- | --- |
| 1 | Download `Tracker.gg - Installer.exe` to `%TEMP%\ow-study\` with `curl.exe -L`, record SHA-256, verify Authenticode is Valid + Overwolf Ltd; abort otherwise | **silent** |
| 2 | Try a silent install in session 0: `Start-Process ... -ArgumentList '/S'` (fallbacks `--silent`, `-silent`), 10 min cap, then check for the app dir + uninstall key. The bootstrapper ships a welcome/CMP screen, so silent success is **unverified** until tried | **silent** (attempt) |
| 3 | Discover the install: registry `Uninstall\*` where `DisplayName -match 'Tracker'`, then `%LOCALAPPDATA%\Programs\*`, `%LOCALAPPDATA%\Overwolf\*`; record path, version, file count, SHA-256 manifest | **silent** |
| 4 | **If step 2 failed:** run the installer once in his session (`schtasks /Create … /IT`, then `/Run`) so the welcome + CMP consent is visible and he clicks Install/accept. This is the **only** user action in the whole plan | **needs-user — 1 click** |
| 5 | Copy the install dir to the server as ONE tar stream (`ssh … "tar -C <parent> -cf - <dir>" \| tar -xf -`) into `~/Projects/Recon/docs/overwolf/captures/<ts>/`; do not copy `%APPDATA%` yet — decide after seeing what the app writes | **silent** (~150–300 MB LAN, no WAN) |
| 6 | Verify the copy: file count + SHA-256 equal to step 3, `package.json`/`manifest.json` version = 0.23.0, then study offline (asar unpack, endpoints, auth, GEP subscriptions) | **silent** |
| 7 | Optional second capture after one launch: the per-user data dir (%APPDATA% or %LOCALAPPDATA%) — only if the study needs tokens/config | **silent** |
| 8 | Uninstall silently: run `UninstallString` (expect `--uninstall` / `--silent-uninstall /S`), wait for exit, verify process gone | **silent** |
| 9 | Leftover sweep + proof: app dir, registry key, `%APPDATA%`/`%LOCALAPPDATA%` app data, Start-menu shortcut, scheduled tasks, URI handler. Re-check "installed = No, processes = 0". Delete the `%TEMP%\ow-study` staging dir | **silent** |
| 10 | Delete the installer + any captured PII before committing the study notes (repo is public) | **silent** |

**Not touched ever:** VALORANT, Riot Client, Vanguard, the existing `recon.exe` session. No reboot
is needed at any step. The whole exercise is per-user and reversible by step 8–9.

## 6. Risks / unknowns

1. **Silent flags unverified** for the Overwolf Electron Installer; step 2 decides whether the user
   clicks at all. Do not promise zero clicks before testing.
2. **CMP consent** is a legal screen bundled in the installer; if it appears, it must be the user's
   click, not a scripted accept. That is why step 4 exists.
3. **Metered line**: the 133 MB payload comes from Overwolf's CDN (WAN). Install traffic is one-time
   and small compared to a game patch, but say it out loud.
4. **Frontend controls**: the study targets a tray/overlay app on his daily-driver PC. It will run in
   his session and may draw an overlay over the game. Keep the install-to-uninstall window short and
   do not launch it while VALORANT is running unless the study needs a live match.
5. **Uninstall may leave `%APPDATA%` data** and the Overwolf uninstaller can be interactive; step 9
   is the real guarantee.
6. If the study needs VALORANT GEP, re-scope to the events sample app (see §4) — the TRN app will
   not give Valorant events.

## 7. Install attempt aborted + rollback (2026-11-08 18:02–18:12) — no install was needed

The Lead cancelled the install mid-flight (the .opk is public on Overwolf's CDN and was studied
from Linux). Record of what happened, for completeness:

- Downloaded installer: `Tracker.gg - Installer.exe`, **3,050,368 B**, SHA-256
  `1893CD1DA79CB728FA14299773107E7FE01979AA969A9B51F61A2B140FD7C34E`, VersionInfo 2.316.0.1,
  Authenticode **Valid**, signer `CN=Overwolf Ltd, O=Overwolf Ltd, Ramat Gan, IL, SERIALNUMBER=514330331`,
  DigiCert G4 Code Signing CA, timestamped.
- Gotcha recorded for any future download: the CDN serves the exe with `Content-Encoding: gzip`;
  plain `curl -o file` saves gzip bytes (no `MZ` header, no signature). Use `curl --compressed`.
- Silent install `/S` did **not** complete: the bootstrapper process (`Tracker.gg-Installer.exe`,
  PID 14292) sat in session 0 for 7 minutes with no finished install. It had created
  `%LOCALAPPDATA%\Overwolf\Settings` + `\Temp` (4 files, 164,798 B) and
  `HKLM:\SOFTWARE\WOW6432Node\Overwolf`. No ARP entry, no services, no scheduled tasks, no
  shortcuts, no visible window.
- Rollback: killed the installer PID, removed `%LOCALAPPDATA%\Overwolf`,
  `HKLM:\SOFTWARE\WOW6432Node\Overwolf`, the `%TEMP%\ow-study` staging dir (installer + scripts),
  and the temporary helper scripts. Verified: `%LOCALAPPDATA%` top-level dirs back to the
  pre-install baseline of 91, 0 Overwolf dirs in LocalAppData/Roaming/ProgramData, 0 registry keys,
  0 processes, 0 tasks/services, no leftover `*.ps1` in `%TEMP%`.
- Untouched: VALORANT, Riot Client (7 processes running throughout), Riot Vanguard, `recon.exe`.
  (`recon.exe` PID 17872 from the 2026-11-07 capture no longer exists — the machine was logged in
  again at 16:00 that day; it was not killed by this work.)
- Conclusion for the record: **no Overwolf/TRN install was needed or left behind**.
