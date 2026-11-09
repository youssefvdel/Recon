# Recon v0.5.0-alpha9 — 10/10 quality judgement

Judge: qa-verify, 2026-11-09 00:59–01:15 (Africa/Cairo). Live app on the user's
Windows PC, driven through the app's own MCP bridge (`ws://192.168.100.3:9223`,
`execute_js` + native screenshots) in session 1 — i.e. the real renderer, not a
mock. Repo: `/home/youssefvdel/Projects/Recon` @ `c47f03a`. No Valorant match was
running, so lobby-specific behaviour is marked BLOCKED instead of guessed.

## Surface verdicts

| Surface | Verdict | Evidence |
|---|---|---|
| Launch (detached) | **PASS** | warm: process→first paint **0.64 s**; cold first run after install **~6–7 s**; own WebView2 child `…\Recon\webview2-runtime\msedgewebview2.exe`; 2 windows (main + hidden overlay); zero #32770 dialogs |
| Tracker tabs (Overview/Matches/Agents/Maps) | **PASS** | content switch **336–339 ms**, all show real cached data |
| Tool views (Store/Crosshair/Resolution/Pre-Picker/Accounts/Riot Chat) | **PASS** | 390–535 ms first visit; no empty states |
| Stretch sub-tabs (Preview/Setup/GPU Scaling) | **PASS** | 801–804 ms first visit; GPU Scaling honestly says `0 verified · 3 requested` |
| Overlay toggle | **PASS w/ polish** | open → visible in **402 ms**; auto-hides; Settings label stays "Close Overlay" while hidden |
| Settings / updater | **PASS w/ polish** | "You are on the latest version v0.5.0-alpha9"; clicking Check for Updates shows no "checking" or result transition |
| Lobby TRN fill (two waves) | **BLOCKED** | no VALORANT process; code verified in shipped chunk |
| Console / spam | **PASS** | 0 JS errors, 0 console warnings, 0 toasts, 0 dialogs in 10 min |
| Security | **FAIL** | bridge reachable from the LAN with no auth (below) |

## Two-wave TRN fill (task question 1)

Not measurable live without a lobby, but the shipped `tracker-B5FLJ6E5.js`
contains the feature verbatim: `function Pt(e){let t=e.filter(e=>e.mine),n=e.filter(e=>!e.mine);return[t.slice(0,5),[...t.slice(5),...n]]}`
plus export table `TRN_FILL_WAVE_GAP_MS: 700`, `TRN_FILL_WAVE_SIZE: 5`,
`TRN_FILL_JITTER_MIN/MAX_MS: 200/400`. So wave 1 = up to 5 own-team players
fired at t0+200–400 ms, wave 2 = remaining own + all enemies at t0+700 ms+200–400 ms;
own team provably lands first. Actual wave latency to pixels needs a real match.

## Ranked defects

1. **BUG — critical security: unauthenticated remote control on the LAN.**
   `tauri-plugin-mcp-bridge` is initialised unconditionally in release
   (`src-tauri/src/lib.rs:1034`, dep `Cargo.toml:43`) and binds `0.0.0.0:9223`
   (netstat confirms). From the server, with no credential, `execute_js` ran JS in
   the app and `window.__TAURI_INTERNALS__.invoke('get_start_minimized')`
   returned `true` — any LAN device can drive Recon. Fix: gate the plugin behind
   `debug_assertions` (or `bind_address("127.0.0.1")` + token) before shipping.
2. **BUG — stale TRN data presented as current.** Overview still shows
   "Tracker Score 139 · Tier D", percentiles, HS% and ADR from the cached TRN
   blob, even though tracker.gg has been dead since 2026-11-02 and every live
   fetch fails silently (`src/hooks/useTrackerData.ts:183` restores `snap.trn`;
   snapshot rewrites keep the old blob alive; `src/components/Overview.tsx:675-703`
   renders it). No age/stale marker. Either expire/exclude TRN-only fields or
   label them "as of".
3. **BUG — misleading "live" indicator.** The "Live Match" tab always renders a
   glowing red dot, even with no game running (`src/components/TrackerView.tsx:88-90`);
   the TopBar LIVE pill is correctly conditional. Users read it as "match live".
4. **POLISH — Settings overlay label desync.** `overlayOpen` only re-syncs on
   window focus (`AppSettingsView.tsx:314-321`), so after the overlay auto-hides
   the button still reads "Close Overlay" while the window is hidden.
5. **POLISH — updater click has no visible acknowledgement.** "Check for Updates"
   leaves the static up-to-date card untouched (no checking spinner/result
   transition), so the user cannot tell the click ran.
6. **WARN — idle cost.** 10 min after launch: 9 processes, **288.7 MB** working
   set, **39.9 CPU-s** (~6.6 % of one core) with overlay hidden; memory grew
   115→289 MB while automation poked the UI, so re-measure clean before acting.
7. **BLOCKED — lobby/poll behaviour** (two-wave timing to pixels, in-match HUD)
   could not be exercised: VALORANT not running on the PC at test time.

## Top 5 between us and 10/10

1. Remove/gate the MCP bridge from release builds (security — ship blocker).
2. Stop serving stale TRN numbers as live data; expire or mark them.
3. Make "Live Match" and any live badge reflect actual state.
4. Fix overlay toggle state sync (label toggles with the window).
5. Give the updater check visible feedback, and verify idle CPU/memory on a
   clean 10-minute run.
