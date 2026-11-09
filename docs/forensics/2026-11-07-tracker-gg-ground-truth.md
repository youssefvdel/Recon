# tracker.gg fetch break — ground truth from the live Windows PC

Captured 2026-11-07 ~00:45–01:00 (Africa/Cairo) over SSH to `youssefvdel@192.168.100.3`
(read-only; no visible window, no relaunch, no config edits). App running: `recon.exe`
PID 17872, session 1 (console). SSH shell is session 0, so the app's session-1 UI cannot
be read from here.

## 1. Symptom

Tracker stats never leave the pending state. Exact UI strings in shipped 0.5.0-alpha:

- `src/utils/playerDisplay.ts:51` — `TRN_PENDING_TOOLTIP = 'Fetching tracker.gg stats…'`
- `src/components/PlayerOverviewModal.tsx:314` — `Fetching act statistics for {player}...`

Not observed live (session-0 limitation, screenshots forbidden). Corroborated by the app's
own TRN cache: **last successful tracker.gg response was 2026-11-02 16:28:38** local, and
nothing has been written since, including the current 2026-11-07 00:06 session.

## 2. settings.json (no secrets present)

`C:\Users\youssefvdel\AppData\Roaming\Recon\settings.json` — 173 B, mtime 2026-10-23 23:10
(install time), so never changed since install:

```json
{
  "auto_borderless": false,
  "start_minimized": true,
  "stretched_w": null,
  "stretched_h": null,
  "hotkey": null,
  "overlay_monitor": null,
  "shortcuts_raw": null
}
```

No API key, token, plan, entitlement or consent field exists in it — settings do not gate
tracker fetching.

## 3. PC reachability of api.tracker.gg (browser-realistic)

DNS: `api.tracker.gg` -> 104.18.22.224 / 104.18.23.224 (Cloudflare).

Request with the exact WebView2 UA `Mozilla/5.0 (Windows NT 10.0; Win64; x64)
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.4314.58`
plus `Origin: https://tracker.gg`, `Referer: https://tracker.gg/`,
`Accept: application/json`:

```
HTTP/1.1 429 Too Many Requests
server: cloudflare
access-control-allow-origin: https://tracker.gg
access-control-expose-headers: X-Warden-Challenge-Passed
{"errors":[{"code":"Warden::Challenge","message":"You are making too many requests and must solve a captcha to continue.","data":{}}]}
```

Reproduced twice, ~5 minutes apart, with the current WebView2 UA. The first probe of the
same URL returned `403 text/html` (4,400 B); its body prefix:

`<!doctypehtml><html lang=en>...<title>You've Been Blocked - Tracker Network</title>...`

`https://tracker.gg/` itself -> **403**, 5,603 B block page. Raw profile path
`.../profile/riot/lil%20ga7ed%23zngr` -> **403**, 5,839 B.

Conclusion: the PC's residential IP is walled by tracker.gg Warden (captcha challenge /
block page), independent of UA. The app's hidden same-origin WebView2 fetch cannot solve a
captcha, so the fetch fails. Matches the Lead's root cause; not an app-side network fault.

Key commands (run through `ssh ... "powershell -NoProfile -Command -" < script.ps1`):

```
curl.exe -sS -i --max-time 30 -A $ua -H "Accept: application/json" -H "Origin: https://tracker.gg" -H "Referer: https://tracker.gg/" "https://api.tracker.gg/api/v2/valorant/standard/profile/riot/Test%23EUW"
curl.exe -sS -o NUL -w "root_code=%{http_code} bytes=%{size_download} ip=%{remote_ip}\n" -A $ua "https://tracker.gg/"
```

(`curl -w "%{http_code}"` cannot be typed straight into cmd — `%20`/`%23` get eaten — so
the URL and format string were passed inside a PowerShell script.)

## 4. Installed version / build

| Item | Value |
| --- | --- |
| FileVersion / ProductVersion | 0.5.0-alpha |
| PE TimeDateStamp | 2026-10-14 10:50:57 local (UTC 07:50:57) |
| recon.exe mtime | 2026-10-14 10:50:56, 38,204,416 B |
| Uninstall entry | `Recon`, version 0.5.0-alpha, `C:\Users\youssefvdel\AppData\Local\Recon` |
| Installed | 2026-10-23 23:10 (uninstall.exe mtime) |
| WebView2 runtime | 156.0.4314.58 (`...\EdgeWebView\Application\156.0.4314.58`) |

Matches repo v0.5.0-alpha. Exe is from the 10-14 build; installer ran 10-23.

## 5. Logged errors: none exist by construction

- Application event log, 14 days, levels 1-3, matching `recon|WebView2|msedgewebview`: **0 events**.
- WER ReportArchive: no report for recon/WebView2.
- WebView2 Crashpad: only `settings.dat`, `metadata`, `throttle_store.dat`; no dumps.
- No `*.log` under `%APPDATA%\Recon` or `%APPDATA%\Local\com.recon.utility`.

Reason: the release build compiles out the only TRN diagnostics —
`src-tauri/src/trn_proxy.rs:134-152` gates `trn_trace!` on `#[cfg(debug_assertions)]`, and
the codebase initialises no logger backend (comment at `trn_proxy.rs:128-130`). A
`windows`-subsystem GUI's `eprintln!` goes nowhere. Production can never explain a TRN
failure — this incident left no trace. **This is itself a defect worth fixing**: ship one
release-visible TRN status line (or a bounded log file) so the next upstream break is
diagnosable without a debug build.

## 6. App process / sockets

- PID 17872, session 1, ~40 MB; one child `msedgewebview2.exe` PID 20444 (browser process,
  `--webview-exe-name=recon.exe --webview-exe-version=0.5.0-alpha --user-data-dir=...EBWebView`).
- 16 `msedgewebview2.exe` processes system-wide.
- One ESTABLISHED socket from PID 17872: `192.168.100.3:57814 -> 172.64.153.46:443`
  (Cloudflare, unattributed; tracker.gg resolves to 104.18.x, so most likely not TRN).

## 7. TRN cache — last good fetch

`C:\Users\youssefvdel\AppData\Roaming\com.recon.utility\trn-cache` (Tauri identifier dir, NOT
`%APPDATA%\Recon`): 100 files, 67,090,604 B. Newest file `40386a0619576b07.trn`, mtime
2026-11-02 16:28; header:

```
trn-cache-v1 1793629718266 /api/v2/valorant/standard/profile/riot/Ginger%20Tofu%231312
```

`1793629718266` ms = **2026-11-02 16:28:38 +02:00** — the last successful tracker.gg fetch,
4 d 8 h before capture. Directory mtime equals that same instant; nothing written since.

Break window: `2026-11-02 16:28` (last good) → first failure after. Combined with
upstream-api's parallel finding (the same Warden gate hits the server-side egress), the
gate is a **fresh upstream change in early November 2026**, not a long-standing state.

Also in the System event log: 2026-11-02 17:07:25, `Tcpip` id 4266 — "A request to allocate
an ephemeral port number from the global UDP port space has failed due to all such ports
being in use." 39 min after the last good fetch; suggestive of a UDP/QUIC retry storm, not
proven to be Recon.

## 8. Build toolchain on the PC (Lead request)

| Tool | Result |
| --- | --- |
| cargo | 1.99.1 (5f94df478 2026-08-27) |
| rustc | 1.99.1 (58cf8f9c3 2026-10-13) |
| rustup target | `x86_64-pc-windows-msvc` installed |
| bun | 1.4.4 (`~\.proto\shims\bun.exe`) |
| node | v24.22.1 |
| git | `C:\Program Files\Git\cmd\git.exe` |
| VS 2022 Build Tools | **absent** |
| VS 2019 Community | 16.11.60, MSVC 14.29.30133, `link.exe` present |
| Windows 10 SDK | **absent** — `C:\Program Files\Windows Kits\10` has only `Catalogs`; only Windows Kits 8.1 exists; no `kernel32.lib` anywhere usable |
| tauri CLI | not installed |

Source checkout on the PC: **none**. Checked `%USERPROFILE%\Projects` (ChessForKids,
einab-man-game, recommend), `Desktop` (Concat), `Documents`, `%USERPROFILE%\source\repos`
(absent), `C:\dev` (absent), `C:\src` (absent), plus a depth-3 scan of the profile for
`Recon`/`src-tauri\tauri.conf.json`: no hits.

Verdict: **cannot build the fix on the PC over SSH.** rustc/msvc target is ready but the
Windows 10 SDK is missing (link will fail), there is no source checkout, and no tauri CLI.
Installing the SDK would be a system change on the user's machine. Hand the build to a
machine that already has the Windows toolchain, or ship a recipe.

## 9. Limits of this capture

- Live UI text could not be read: sshd runs in session 0, the app window is session 1; UIA
  from session 0 returns 0 top-level windows for PID 17872. A session-1 helper task was not
  created (that edits PC state).
- The WebView2 cookie DB (`EBWebView\Default\Network\Cookies`) is exclusively locked; it
  could not be read to check for a leftover Warden/Cloudflare clearance cookie.
- A `--remote-debugging-port` relaunch would expose the app's exact HTTP status, but that
  requires killing the running app — prohibited, not attempted.
