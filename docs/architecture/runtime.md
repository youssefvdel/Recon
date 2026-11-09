# Recon runtime — what actually runs on the PC (alpha16, measured)

Capture window: **2026-11-09 03:31–03:40 Africa/Cairo**, `Youssef-PC` 192.168.100.3, read-only.
Installed build: **0.5.0-alpha16** (`%LOCALAPPDATA%\Recon\recon.exe`, mtime 2026-11-09 03:10:12).
The app was running when the snapshot was taken and **exited at ~03:36** (no crash event, no WER
report, no Application-log entry). Everything below was measured live; items that were not are
marked **not measured — PC in use**.

## 1. Process tree at idle

Measured 03:32–03:34 while alpha16 was idle (no game).

| PID | Parent | Process | Role | Working set |
| --- | --- | --- | --- | --- |
| 13756 | 23396 (identity **not measured — PC in use**) | `recon.exe` | app core, session 1 | 37.9 MB |
| 3204 | 13756 | `msedgewebview2.exe` | **our** WebView2 browser host | 57.2 MB |
| 4340 | 3204 | `msedgewebview2.exe` | renderer (main window) | 117.1 MB |
| 2596 | 3204 | `msedgewebview2.exe` | renderer (second webview — overlay/dev) | 81.6 MB |
| 19716 | 3204 | `msedgewebview2.exe` | gpu-process | 49.4 MB |
| 14760 | 3204 | `msedgewebview2.exe` | utility (network) | 22.2 MB |
| 22332 | 3204 | `msedgewebview2.exe` | utility | 4.0 MB |
| 15668 | 3204 | `msedgewebview2.exe` | crashpad-handler | 2.9 MB |
| 1796 | 15668 | `msedgewebview2.exe` | crashpad-handler child | 2.3 MB |

- **9 processes**, **2 renderers**, **≈337 MB** total working set.
- **The host is OURS, not the system one**: host exe is
  `%LOCALAPPDATA%\Recon\webview2-runtime\msedgewebview2.exe` (bundled, **v157.0.4341.42**),
  launched with `--webview-exe-name=recon.exe` and
  `--user-data-dir=%LOCALAPPDATA%\com.recon.utility\EBWebView`.
- `recon.exe` command line at idle: just its own path, no debug or runtime flags.
- **Decoy to keep out of diagrams:** a second WebView2 group (8952 browser + 9676 renderer +
  2264 gpu + 4328/9452 utility + 9084 crashpad) belongs to **SearchHost.exe**, uses the
  **system** runtime `%ProgramFiles(x86)%\Microsoft\EdgeWebView\Application\157.0.4341.42\` and its
  own profile under `%LOCALAPPDATA%\Packages\MicrosoftWindows.Client.CBS_...\LocalState\EBWebView`.

## 2. Ports

- **9223: LISTENING on `127.0.0.1:9223`, owner `recon.exe` (13756)** — loopback only, correct bind.
- HTTP probes to `/`, `/json/version`, `/json/list`, `/health` returned **no bytes** (curl code 000):
  it is **not** an HTTP/CDP endpoint on this build. Actual protocol **not measured — PC in use**.
- No other listening sockets in the Recon PID set.
- Outbound at idle from utility 14760: `185.199.111.133:443` (GitHub Pages range) and
  `172.67.141.245:443` (Cloudflare). Destination service names **not measured**.

## 3. Disk footprint

| Path | Files | Bytes | Notes |
| --- | --- | --- | --- |
| `%LOCALAPPDATA%\Recon` (install) | 260 | **749,251,379** (714.6 MiB) | mostly the bundled runtime |
| ├ `recon.exe` | 1 | 38,461,440 | 2026-11-09 03:10:12 |
| ├ `uninstall.exe` | 1 | 81,169 | 2026-11-09 03:21:15 |
| └ `webview2-runtime\` | 258 | ≈710,708,770 | v157.0.4341.42 |
| `%LOCALAPPDATA%\com.recon.utility\EBWebView` (profile) | 666 | **109,289,776** (104.2 MiB) | |
| ├ `Default\` | 517 | 40,086,072 | |
| ├ `Default\Cache\` | 123 | 24,140,564 | |
| ├ `Default\Local Storage\` | 9 | 2,584,128 | leveldb, see §4 |
| ├ `Default\Service Worker\` | 10 | 270,518 | |
| └ `Default\Network\` | 13 | 118,249 | |
| `%APPDATA%\com.recon.utility` | 8 | 7,816,241 | |
| ├ `trn-cache\` | 3 | 7,808,266 | 2,473,240 + 1,671,865 + 3,663,161 |
| └ `accounts\` | 5 | 7,975 | accounts.json 509, recon-id 28, 2×3530 yaml, heartbeat 378 |
| `%APPDATA%\Recon` | 2 | 668 | settings.json 173, monitor_res_cache.json 495 |

## 4. localStorage state (leveldb, `Default\Local Storage\leveldb`)

- Files: `000005.ldb` 203,182 · `000081.ldb` 1,873,941 · `000084.ldb` 466,674 ·
  `MANIFEST-000001` 5,608 · `LOG.old` 1,205 · empty `000083.log`/`LOG`/`LOCK`.
  **Total .ldb on disk 2,543,797 B** (includes tombstoned/superseded generations, not live payload).
- Heuristic parse of live entries: **37 distinct keys, ≈730 chars of values** (parser is
  approximate; treat ±10–20% and the key *set* as reliable, exact byte totals as approximate).
- Largest parsed keys: `recon_live_player_stats_v2` 237 · `recon_match_v6_fd8cd7c7` 121 ·
  `recon_sidebar_mini_v2` 68 · `recon_match_v6_631eb5df` 55 ·
  `recon_tracker_snapshot_v1:<puuid>` 51 · `recon_live_round_seq_4b49d707` 42 · `aspect_tracker_shard` 40.
- Generation census inside the leveldb: **`recon_match_v6_*` 19 keys / 29 refs** (superseded
  ballast still on disk) · **`recon_match_v7_*` 10 keys / 10 refs** · `recon_trn_cache_*` 1 ·
  `recon_tracker_snapshot_v1` 2 · `aspect_*` 6 · `truestretch_*` 0.
- Quota numbers on record for this machine (code comments, measured by QA, not re-measured now):
  origin budget **~5 MB**; at one point **~5.24 M chars** with **11 `recon_match_v6_*` and 0
  `recon_match_v7_*`** — full storage made the version bump a silent no-op; TRN measured
  **4.76 MB of ~5 MB**, where a **256 KiB write succeeded and a 512 KiB write threw
  `QuotaExceededError`**; largest TRN payload **2,176,778 chars**. Bodies now live in `trn-cache\`.

## 5. Launch sequence (observed)

| Time (2026-11-09) | Event |
| --- | --- |
| 03:21:15 | `uninstall.exe` written by the installer |
| 03:21:37 | `recon.exe` starts (22 s later) |
| 03:22:41 | first localStorage write after start (`000084.ldb` mtime, 64 s after start) |
| ~03:36 | `recon.exe` exits; webview tree gone; no crash artifacts |

- Cold start evidence: bundled runtime dir written **2026-11-08 22:50:26**, exe **03:10:12**,
  `--minimized` boot-to-tray path exists (`settings.json` has `start_minimized: true`).
- **Warm-start ordering not measured — PC in use** (no relaunch allowed; the running instance
  exited before the stop order).
- Window creation is `.visible(false)` then shown; tray built with tooltip
  `Recon • Valorant Companion`, `show_menu_on_left_click(false)`.

## 6. What the user sees when something fails

- **WebView2 runtime missing** (guard runs first, before any window):
  title `Recon - WebView2 runtime missing`; body `Recon cannot start because the WebView2 runtime
  is missing.` + `Debloated Windows images often remove it. Press OK to open the official Microsoft
  installer, run it, then start Recon again.`; icon error; then opens
  `https://go.microsoft.com/fwlink/p/?LinkId=2124703`; process **exits with code 3**.
- **Nothing on screen for storage failures**: localStorage quota errors were swallowed and the
  cache simply stayed stale — the app kept running with old data (the 5.24 M char case above).
- App exit at ~03:36 produced **no error surface** (no dialog, no event-log entry, no WER).

## 7. Gaps to fill later (explicitly not measured — PC in use)

Warm-start timing · 9223 protocol · parent of `recon.exe` · live-match behaviour · window titles
at runtime · outbound destination names.
