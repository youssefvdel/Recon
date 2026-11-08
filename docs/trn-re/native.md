# TRN native surface — RE notes (task-48)

Method: source/binary inspection of the captured artifacts only. No download, no PC
access, no install. Artifacts: `docs/overwolf/captures/opk/extracted/` (9.5 MB webapp
package, manifest v1 `"type": "WebApp"`, version 1.32.14) and
`docs/overwolf/captures/installer/trn-installer.exe`.

## 1. Non-JS payloads (what the JS cannot tell you)

| Payload | Size | Implication |
|---|---|---|
| `assets/img/{agents,weapons,maps,ranks,medals,flags,avatars,sidebar,timeline}` + `welcome.png` | 3.5 MB total | Static game art only; no captured data ships in the package. |
| `assets/fonts/{Rajdhani,Roboto}/*.woff2` | ~0.6 MB | UI typography only. |
| `css/*.css` (16 files) | 200 KB | Bundled styles. |
| `windows/*.html` (10) | small | assistant, background, desktop, duels, guides, second_screen, teammates, timeline, uninstall, verification — the overlay pages. |
| `_metadata/verified_contents.json` | — | Chrome Web Store content-verification manifest: the package is a **CRX/WebApp**, not a native app. |
| `plugins/*.dll` (5) | 812 KB | The only native code in the package — see §3. |
| **No** `.wasm`, `.node`, `.exe` | — | Nothing executable ships in the webapp payload. |

The single `WebAssembly` reference (`js/uYJbzOEK.js`, a Sentry bundle) is Sentry's
`WebAssembly.Exception` type check (`typeof WebAssembly < "u" && WebAssembly.Exception
!== void 0`). It is a symbolication guard, not a WASM payload.

## 2. Installer — bootstrapper verdict

`trn-installer.exe` = **PE32 i386 NSIS self-extracting archive** (3,035,416 B; 105 files,
6.37 MB uncompressed). `$PLUGINSDIR` holds the installer UI and its dependencies:

- `OWInstaller.exe` (379,208 B, .NET), `OverWolf.Client.CommonUtils.dll`, `Microsoft.Web.WebView2.Core.dll` + `WebViewer2Loader.dll`, `websocket-sharp.dll`, `DotNetZip.dll`, `Microsoft.Win32.TaskScheduler.dll`, `log4net.dll`, `Newtonsoft.Json.dll`, and an embedded `app/` UI (`js/libs/cmp.bundle.js`, Montserrat fonts).
- URLs embedded: `content.overwolf.com/cmp/v3` (+`gac/gac.json`, `vendor-list.json`), `content.overwolf.com/downloads/setup/latest/regular.html`, `content.overwolf.com/Installer/webapp5/progress.html`, `content.overwolf.com/Installer/promo/`, `features.overwolf.com/experiments*`, `legal.overwolf.com`, support articles. No app-package URL.
- Extension id (only id in this binary): `ipmlnnogholfmdmenfijjifldcpjoecappfccceh`, carried as `Sel=1&Partner=3973&Extension=ipmlnnogholfmdmenfijjifldcpjoecappfccceh&Name=Valorant%20Tracker&Referer=tracker.gg&Browser=chrome`.

**Verdict: it is only a downloader/registration shim.** It shows consent (CMP), opens the
Overwolf install flow for that extension id, and hands off to `OWInstaller.exe`. The ~133 MB
app payload is fetched by Overwolf's installer infrastructure with server-issued URLs after
the handoff; nothing in the 3 MB binary names it, so it cannot be fetched by URL guessing.

## 3. Native surface (the actual native code)

- `Overwolf.Plugins.Valorant.dll` (9,216 B, .NET `net48`; debug path `C:\Users\lostblood\Desktop\overwolf\overwolf-plugins\Overwolf.Plugins.Valorant\obj\Release\net48\...pdb`). Visible member: `getEntitlementsToken`. This is the Valorant GEP plugin: it reads the **local Riot entitlements token** — the same lockfile/local-API capability Recon already implements read-only.
- `Overwolf.Plugins.Support.dll` (10,240 B): `Process` helper for the plugin host.
- `DiscordRPC.dll` + `discord-rich-presence.dll` (90 KB): Discord presence.
- `Newtonsoft.Json.dll` (702 KB): serializer.

No game-memory hook, no capture module, no injection code ships here — those live in the
Overwolf client/ow-electron runtime, not in the app package.

## 4. Webapp package vs standalone ow-electron build

- **Webapp (what we have): 9.5 MB.** Runs inside the Overwolf client, which supplies the Chromium runtime, GEP, overlay compositor and capture engine. The package is HTML/JS + 5 DLLs.
- **Standalone: 133.3 MB, platform Electron 0.23.0, app id `ekmbhgikmjbagjojiebkkbgghcedofnobpajodoi`** (captured 2026-11-05). Installer URL pattern: `https://download.overwolf.com/install/Download?Name=Tracker.gg&ExtensionId=ekmbh…&Channel=web_dl_btn…` → `…/installer/prod/<hash>/Tracker.gg - Installer.exe` (3,013,313 B). The 133 MB is therefore **Electron runtime + the same web bundle + `ow-electron` native modules** (GEP client, overlay compositor, capture hooks) that implement the `overwolf.*` API inside the app. The payload URL is server-issued/expiring after install handoff → **not fetchable without installing**, and it would not run standalone outside their signed Electron shell in any supported way.

## 5. JS → native bridge calls (named)

- `overwolf.games.getGameInfo`, `getRunningGameInfo`, `getRecentlyPlayedGames`, `onGameInfoUpdated` (one chunk: `js/Cd0_c1Nz.js`). **Presence only** — no `setRequiredFeatures`, no `onInfoUpdates`, so the app does not consume per-feature game events.
- `overwolf.windows.getMainWindow/getCurrentWindow/onStateChanged/restore`: overlay window management.
- `overwolf.media.replays.turnOn/turnOff/getState/getHighlightsFeatures/onHighlightsCaptured` and `overwolf.media.videos.getVideosSize/deleteVideo/deleteOldVideos`: the native capture/replay engine.
- `overwolf.settings.hotkeys.*`, `overwolf.profile.*`, `overwolf.extensions.*`: host services (hotkeys, login/profile, app lifecycle).
- No `chrome.*` API usage anywhere in the bundle.

## 6. Tauri reality check

| Capability | Native sidecar needed? | Verdict for Recon |
|---|---|---|
| GEP game info/events | Yes in general; **no** for what this app uses | Recon's local Riot lockfile/API path already covers live match + entitlements; skip GEP. |
| Overlay windows (transparent, in-game-only, focus takeover `ReleaseOnHidden`) | No | Recon already has a topmost transparent Tauri overlay; their focus-takeover semantics are Overwolf-specific (we use NOACTIVATE + click-through, which is the anti-cheat-safe shape). |
| Capture / streaming / replay highlights (`Streaming`, `DesktopStreaming`, `VideoCaptureSettings`, `overwolf.media.replays`) | **Yes** (Windows Graphics Capture / DXGI duplication) | Out of scope and anti-cheat-adjacent; not worth a sidecar. |
| Hotkeys / file system / profile | No | Tauri equivalents exist (global hotkey, fs, local settings). |
| Discord RPC | Yes (Discord IPC) | Irrelevant to Recon. |

**Impossible for us without Overwolf:** their injected overlay compositor, their capture
pipeline, and any `overwolf.*` runtime API. All of it is their client, not the app.

## 7. The one thing Recon could realistically do

Replicate their only overlay capability that does not need their native stack: the
**in-game teammates / timeline panel**, driven by Riot-local live-match data (which Recon
already reads read-only) plus `api.tracker.network` for names/stats. No GEP, no capture, no
sidecar — a new page in the existing transparent overlay window.
