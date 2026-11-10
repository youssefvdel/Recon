# Recon runtime — what actually runs on the PC (alpha22, measured)

Captured read-only on `Youssef-PC` 192.168.100.3: alpha22 launch **2026-11-09 19:34**, baseline
re-check **2026-11-10 02:30** (app still running, idle). Previous alpha16 snapshot kept only where
it differs. Installed build: **0.5.0-alpha22**, `recon.exe` mtime 2026-11-09 19:25:42, 38,453,760 B.

## 1. Process tree at idle (2026-11-10 02:30)

| PID | Parent | Process | Role | Working set |
| --- | --- | --- | --- | --- |
| 10740 | — (parent not captured) | `recon.exe` | app core, **session 2**, started 19:34:24 | 10.7 MB (priv 27.8) |
| 23532 | 10740 | `msedgewebview2.exe` | **our** WebView2 browser host | 25.3 MB |
| 19680 | 23532 | `msedgewebview2.exe` | renderer (main window) | 37.3 MB |
| 24560 | 23532 | `msedgewebview2.exe` | renderer (second webview) | 13.8 MB |
| 9740 | 23532 | `msedgewebview2.exe` | gpu-process | 8.4 MB |
| 9564 | 23532 | `msedgewebview2.exe` | utility (network) | 12.8 MB |
| 12756 | 23532 | `msedgewebview2.exe` | utility | 2.8 MB |
| 13000 | 23532 | `msedgewebview2.exe` | crashpad-handler | 1.0 MB |

- **7 processes ours** (1 app + 6 WebView2), **2 renderers**, ≈102 MB total working set.
- **Host is OURS, not the system one**: `C:\Users\youssefvdel\AppData\Local\Recon\webview2-runtime\msedgewebview2.exe`,
  version **157.0.4341.42**, launched with `--webview-exe-name=recon.exe`,
  `--user-data-dir=%LOCALAPPDATA%\com.recon.utility\EBWebView`. `HOST_IS_BUNDLED=True`.
- **Decoy:** second WebView2 group (23264 browser, 23140 renderer, 3100 gpu, 10444/13932 utility,
  9240 crashpad) belongs to **SearchHost.exe**, runs the **system** runtime and its own profile
  under `%LOCALAPPDATA%\Packages\MicrosoftWindows.Client.CBS_...\LocalState\EBWebView`.
- alpha16 (2026-11-09 03:32) for comparison: 9 processes, 2 renderers, ≈337 MB — renderer memory
  was 117 MB + 82 MB; alpha22 sits at 37 MB + 14 MB after its idle period.

## 2. Ports

- **9223: `127.0.0.1:9223` LISTENING, owner `recon.exe` (10740)** — loopback only, correct bind.
  Same binding as alpha16. HTTP probes still return no bytes; protocol **not measured**.
- No other listeners in the Recon PID set.
- Idle outbound: one ESTABLISHED from utility 9564 → `185.199.108.133:443` (GitHub Pages range).
  No tracker.gg / pvp.net connection at idle.

## 3. Disk footprint (unchanged by alpha22 except the exe)

| Path | Files | Bytes |
| --- | --- | --- |
| `%LOCALAPPDATA%\Recon` (install) | 260 | **749,240,739** (714.6 MiB) |
| ├ `recon.exe` | 1 | 38,453,760 |
| ├ `uninstall.exe` | 1 | 81,169 |
| └ `webview2-runtime\` (v157.0.4341.42) | 258 | ≈710,705,810 |
| `%LOCALAPPDATA%\com.recon.utility\EBWebView` | 666 | **109,289,776** (104.2 MiB) |
| ├ `Default\Cache\` | 123 | 24,140,564 |
| ├ `Default\Local Storage\` | 10 | 2,598,207 |
| └ `Default\Network\` | 13 | 118,249 |
| `%APPDATA%\com.recon.utility` | 11 | ~7.8 MB (trn-cache grows per fetch) |
| `%APPDATA%\Recon` | 2 | 668 (settings.json 173, monitor_res_cache.json 495) |

## 4. localStorage after an alpha22 launch

- `.ldb` files: `000005` 203,182 · `000081` 1,873,941 · `000084` 466,674 · **`000087` 27,742**
  (new at alpha22 start) · MANIFEST 5,608. **Total .ldb 2,571,539 B.**
- Parsed: **39 keys, ≈838 chars live** (heuristic ±; key set reliable).
- **Superseded generations are tombstoned, not live.** The `.ldb` files still carry **21 superseded
  key names on disk** (`recon_match_v6_*` 19 · `recon_live_player_stats_v2` 1 ·
  `recon_trn_cache_v1` 1), but the live `localStorage` measured app-side by QA is **0** for all of
  them. Per-table distribution proves compaction lag, not a leak: `000005` (Nov 8) 17 ·
  `000081` (Nov 9 03:11) 13 · `000084` (03:22) 1 · **`000087` (the only table written by alpha22,
  19:35:27) 0**. Deleted keys survive in old blocks until LevelDB compacts them — do not report
  this as a cache leak.
- New generation present: `recon_match_v7_*` 10 keys, `recon_live_player_stats_v3` (107 chars),
  `recon_trn_cache_v2`.
- Largest: `recon_live_player_stats_v2` 237 · `recon_match_v6_fd8cd7c7` 121 ·
  `recon_live_player_stats_v3` 107 · `recon_sidebar_mini_v2` 68.
- Quota history on this machine (code comments, QA-measured): ~5 MB origin budget; once **5.24 M
  chars** full with 11 v6 entries and 0 v7 (bump silently no-op'd); TRN bodies measured **4.76 MB
  of ~5 MB**, 256 KiB write OK / 512 KiB threw `QuotaExceededError`.

## 5. First working log baseline (`%LOCALAPPDATA%\com.recon.utility\logs`)

Files at 02:30: `recon-startup.log` 0 B (19:34:24) · `Recon.log` 1,583 B, 9 lines (last write 19:36:26).

- First line: `[2026-11-09][19:34:27][INFO][app_lib] [window] main frame delta 16x9 px @ 1x -> min size 1226x809 logical`
- Last line: `[2026-11-09][19:36:26][WARN][app_lib::win::overlay] overlay edit mode force-exited (user exit)`
- **0 ERROR**, **2 WARN** — both `overlay edit mode force-exited (user exit)` at 19:36:23 and 19:36:26.
- Rest of the 9 lines: 6 × `[display] DisplayConfig bridge` / `GDI ... bridged to PnP` for
  DISPLAY1 (HWP2866), DISPLAY2 (DELA0E2), DISPLAY3 (PHLC401).
- **No line written after 19:36:26** while the app stayed running — idle produces no log output.

## 6. Launch sequence (alpha22, measured)

| Time 2026-11-09 | Event |
| --- | --- |
| 19:25:42 | new `recon.exe` written (alpha22) |
| 19:34:24 | `recon.exe` starts (PID 10740); `recon-startup.log` created |
| 19:34:27 | first `Recon.log` line (window min-size) |
| 19:34:44–19:34:58 | **3 TRN cache files written** (1.71 MB, 191 KB, 3.97 MB) — startup TRN fetch |
| 19:35:09 | display enumeration (3 monitors bridged) |
| 19:36:23 / 19:36:26 | 2 overlay `WARN` lines |
| — | no lines since; process still alive at 02:30 |

Cold-start artifacts: bundled runtime dir dated 2026-11-08 22:50; `settings.json` has
`start_minimized: true`; `--minimized` boot-to-tray path exists. **Warm-start ordering not measured**
(could not relaunch).

## 7. Failure evidence / user-facing error surface

- **WebView2 missing:** `MessageBox` title `Recon - WebView2 runtime missing`, body
  `Recon cannot start because the WebView2 runtime is missing.` + `Debloated Windows images often
  remove it. Press OK to open the official Microsoft installer, run it, then start Recon again.`;
  opens `https://go.microsoft.com/fwlink/p/?LinkId=2124703`; process exits **code 3**.
- **Storage quota failures: invisible** — swallowed, app keeps running on stale cache.
- Tray tooltip `Recon • Valorant Companion`, left-click opens the menu (`show_menu_on_left_click(false)`).

## 8. Unverified claim: match board (AGENT SELECT / IN MATCH)

**No VALORANT match ran on alpha22, so the claim stays unverified.** Evidence at 02:30:

- No `VALORANT-Win64-Shipping.exe` process; only `RiotClientServices.exe` (16868) + crash handler.
- `%LOCALAPPDATA%\VALORANT\Saved\Logs\ShooterGame.log` last closed **2026-11-09 04:43:45** —
  15 h before alpha22 was installed.
- Prefetch: only `VALORANT-138-0-1-4874.EXE` (2026-10-23); no Win64-Shipping prefetch entry present.
- `Recon.log`: 0 lines matching board/agent/prematch/TRN.
- Board-state values in localStorage are **stale from the previous build**:
  `recon_live_player_stats_v3.fetchedAt` = 2026-11-09 **03:29:18**, `recon_tracker_snapshot_v1.savedAt`
  = 2026-11-09 **03:22:29** — both before alpha22 (19:25).
- `trn-cache` newest files are the 19:34:44–19:34:58 startup fetches; nothing newer.

## 9. Gaps (not measured — would need a relaunch or a live match)

Warm-start timing · 9223 protocol · `recon.exe` parent · live match board behaviour · window titles.

## 10. alpha28 cold launch (2026-11-10 06:25:16) — logging baseline

Build `0.5.0-alpha28`, exe mtime 06:17:10, 38,477,312 B. Process PID 6984, session 1, session-1
console; WS 12.1 MB. Installer wrote the exe at 06:17:10 and did **not** relaunch the app; the
launch came at 06:25:16. `MainWindowHandle 0`, empty title — no visible main window (settings
`start_minimized: true`).

- WebView2 (all ours): browser 16764 (39.7 MB), renderer 20352 (55.1), renderer 13216 (31.0),
  gpu 15488 (35.1), utility 8556 (7.8), utility 10488 (0). Host exe
  `%LOCALAPPDATA%\Recon\webview2-runtime\msedgewebview2.exe` v157.0.4341.42, `--webview-exe-name=recon.exe`,
  `--user-data-dir=%LOCALAPPDATA%\com.recon.utility\EBWebView`. `127.0.0.1:9223` LISTENING, owner 6984.
- `Recon.log`: 219 lines total (cumulative across builds). This launch added 12 lines, first
  `[2026-11-10][06:25:19][INFO][app_lib] [boot] setup reached - config windows exist`, then
  `[window] main frame delta 16x9 px @ 1x -> min size 1226x809 logical`.
- Boot markers: **observed split on alpha28, fixed after it.** On alpha28 the file pair was
  `recon-startup.log` for 3 of 4 (`run() entered v0.5.0-alpha28` → `webview2 preflight passed` →
  `builder ready; entering run()`, 06:25:16.905–16.976, epoch-ms only) and `Recon.log` for only
  `[boot] setup reached` — order correct, timeline split.
  **Shipped behaviour from `600fcf4` (current HEAD):** `boot_marker` buffers the pre-attach lines and
  `replay_boot_markers()` drains them through the attached logger once, so all four land in
  `Recon.log` contiguous and in order; `recon-startup.log` stays only as the fallback for a run that
  dies before attach.
  **Observed on alpha30** (2026-11-10 06:54:42): all four markers appear in `Recon.log`, in order,
  same second — `run() entered v0.5.0-alpha30` → `webview2 preflight passed` → `builder ready;
  entering run()` → `setup reached`. The split-timeline defect is gone in the shipped build.
- `[tracker]` 30 lines, `[riot]` 126 lines in the file; **every one is emitted twice** ~150 ms
  apart (same text) — double sink, visible in this launch too (`cached merge` ×2, `riot read
  failed` ×2).
- `[riot] read failed {"host":"pd.eu.a.pvp.net","path":"/match-details/v1/matches/:uuid","status":0,"kind":"transport"}`
  repeats at every launch and in this one (2× at 06:25:26).
- `recon-startup.log` was cumulative at alpha28 (21 lines, alpha25→alpha28, no rotation).
  From `600fcf4` it is capped at **256 KB, size-based, keeping one generation**
  (`recon-startup.log.1`) — a crash loop must not erase the evidence of the crash before it.
  Not yet exercised: the file is far below the cap on this machine, so rotation is designed-only.
