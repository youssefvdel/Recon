# TRN fetching + in-game overlay — consolidated review

Date: 2026-11-14. Sources: static forensics of `Valorant Tracker - Installer.exe`
(sha256 `09638afc…15909dee`), the repo's OPK capture (app v1.32.14), and Recon's
own transports. Key values are never reproduced in this repo — `KEY_PRESENT`
is as far as any report goes.

## 1. What the installer is

A generic Overwolf bootstrapper, **not** the app. 105 files under `$PLUGINSDIR/`:
NSIS-3 Unicode stub + plugins, `OWInstaller.exe` (379,208 B) with
`BuildDownloadUrl` / `DownloadFileAsync` symbols — it downloads the real
package at install time. Its JS talks only to Overwolf infra
(`storeapi/content/features.overwolf.com`); **zero `tracker` string hits** in
all 105 files. Byte-identical to the existing capture in
`docs/overwolf/captures/installer/extracted/` (same 105 names, same hashes).
PE FileVersion 2.316.0.1 = installer manifest `app_version` 316.0.1.
All API truth lives in the OPK: `docs/overwolf/captures/opk/extracted/js/Cu_khBDY.js`
(the whole TRN REST service is one minified line).

## 2. Fetching matrix (what each side uses)

| # | Transport | Endpoints | Auth | Rate behavior |
|---|-----------|-----------|------|---------------|
| 1 | TRN direct (Recon primary, keyless) | `GET https://api.tracker.network/api/v2/valorant/standard/…` (profile `riot/{name}%23{tag}`, matches, recent-matches) | `User-Agent: OverwolfClient` + `Accept: application/json`, `?source=overwolf-2`. No key, no cookies. Code: `src-tauri/src/trn_http.rs:113-145`; TS allowlist + direct-first `src/utils/trn.ts:193-204,297-340` | TRN can still 429 (`TRN_RATE_LIMITED`); no Cloudflare/Warden wall |
| 2 | WebView2 proxy (Recon fallback) | hidden `tracker.gg`-origin window, same-site fetch | real Edge TLS/cookies | lobby=30 / hourly=900 ceilings; 6–8 s serial gap, 25 s→60 s cooldown ladder on 429/403/1015; Warden captcha → `TRN_CAPTCHA_REQUIRED`, never retried. `src-tauri/src/trn_proxy/` |
| 3 | Riot local loopback (Recon authoritative, **no rate limit**) | `127.0.0.1` + lockfile creds: entitlements, aliases, batched namesets (25-chunk), presences, chat/social, `CI server version:` from `ShooterGame.log` | lockfile port/password, cert validation off. `src-tauri/src/tracker.rs:36-56,106-159`; "no rate limit on 127.0.0.1" (`src/utils/tracker.ts:1639-1640`) | unrate-limited; 6-slot concurrency |
| 4 | Riot pd/glz remote (Recon authed) | `pd.{shard}.a.pvp.net` (mmr, match-details/history, name-service PUT, storefront), `glz-{region}-1.…` (live, loadouts) | 4 headers: `Authorization: Bearer`, `X-Riot-Entitlements-JWT`, `X-Riot-ClientPlatform` (base64 PC blob), `X-Riot-ClientVersion` + `ShooterGame/…` UA. `tracker.rs:185-218` | 401→refetch; remote quotas unquantified (gap §6.3) |
| 5 | TRN app backend (reference only) | same `api.tracker.network` v2 + v1 (`insights`, `guides`, `db/seasons`, `premier`, `ow-bulk-lookup` POST `{phaseId,matchId,playlistId,mapId,players[]}`), Socket.IO `realtime-events.tracker.network` | `TRN-API-Key` on all 10 fetch methods; only insights/guides/bulk also send `User-Agent: OverwolfClient`; `?source=overwolf-2` on 4 GETs (each with a `source=web` fallback branch). `Cu_khBDY.js:3` | key = quota/attribution, not the gate (see §4) |
| 6 | GEP + log tail (TRN only, **not a Recon transport**) | `overwolf.games.events` features `[me, game_info, match_info, premier_info, career_stats]` (game 21640), Custom provider tails `%LOCALAPPDATA%\VALORANT\Saved\Logs\ShooterGame.log`, native `Overwolf.Plugins.Valorant.dll` (9 KB, `getEntitlementsToken`) | whitelisted + signed Overwolf app, per-game PROD rollout, Riot approval | rejected for Recon: injection-adjacent, terms-barred (`docs/overwolf/findings.md:93-110`) |

## 3. Overlay mechanics

**TRN (reference):** Overwolf WebApp, 10 windows. Background page owns session
state; secondaries read `getMainWindow().background`. Live rounds: GEP
`match_info.*` (`round_number/phase/report/score/kill_feed`, ×72 refs in
`BSj0SAG_.js`) → background `game.session.rounds` → `timeline` window.
Post-match: TRN segment model (`player-round / round-summary / damage / kills`)
rendered by the desktop window. Hotkeys Alt+T / Alt+L / Tab. No game-process
injection anywhere — native side is one small plugin + Support + DiscordRPC.

**Recon:** Tauri `overlay` window (`create:false`, transparent `#00000000`,
alwaysOnTop, skipTaskbar, hidden — `tauri.conf.json:26-41`), built deferred and
non-fatal (`lib.rs:439-457`). Styling: `WS_POPUP/TOPMOST/TOOLWINDOW` +
`TRANSPARENT|NOACTIVATE`, `HTTRANSPARENT` subclass, DWM chrome stripped,
`WS_EX_LAYERED` banned, blur-behind no-op (`window_manager/overlay_window.rs`).
Boot asserts click-through; edit mode captures input without stealing focus
(`win/overlay.rs:29-139`). Daemons: 2 s show/hide on Valorant-foreground ∧
present ∧ ¬edit; 100 ms guard (Ctrl+Shift+H exit, 90 s idle force-exit, Tab-peek
via `GetAsyncKeyState`). UI: `HudCanvas` + `useLivePoll` (2.5 s Riot-local poll,
idle ~30 s backoff, cross-realm sync merge); roster composites only while Tab is
physically held; `hudPresent → set_overlay_present` lets Rust drop the
fullscreen layer otherwise. Rules: read-only, no memory/injection/mutating Riot
calls, never claim raw/hidden MMR, click-through except edit mode, no
backdrop-blur.

## 4. What the API key is actually for — and why we still won't use it

Per-route (from the OPK): the key rides `TRN-API-Key` on all 10 TRN REST methods
(profile, match detail, recent matches, insights, seasons, guides, bulk
lookup). The privacy toggle uses `Authorization: Verification <token>` instead;
realtime is Socket.IO. It is an **app-attribution/quota marker**, not an access
gate. Live probes (2026-11-08) proved it:

- `User-Agent: OverwolfClient` → 200; Chrome / `Recon/0.5` / curl → 403.
- With key vs without → **byte-identical** (883,272 B).
- Payload size comes from `source=`: none 883 kB (1 season), `web` 1.57 MB,
  `overwolf-2` 2.19 MB (full: 3 season segments + weapon/map/map-agent).
- `ow-bulk-lookup` answers **405** to every method/shape tried — not reachable.

Reusing TRN's embedded key would be credential misuse: another company's
secret tied to their Overwolf app, violating Overwolf developer terms and
Riot's data rules, revocable on sight — for zero measured gain on the routes we
use. The key stays redacted (`<redacted: hardcoded TRN-API-Key>` in
`docs/trn-re/endpoints.md:14`) and out of the codebase. This decision is
unanimous across `docs/overwolf/findings.md`, `docs/trn-re/README.md`,
`docs/trn-re/rounds.md`, and `trn_http.rs`.

## 5. Safe lite overlay for Recon (concept)

Five elements, one glanceable job per phase, nothing to read mid-fight:

1. **Match strip** (agent-select header only: Map • Mode • SELECT/LIVE + side +
   server) — Riot-local pregame/coregame session + loadouts.
2. **Your-five roster** (agent icons + rank crests, no names/stats) — same
   Riot-local roster + static `gameData()`.
3. **Enemy-five glance** (agent-select + Tab-hold only) — same roster;
   incognito via existing name-service harvest.
4. **Map pick hint** (one line: personal TRN map record or rank-tuned meta
   fallback) — collapses today's `MetaTiles` table to one row.
5. **Status whisper** (one self-hiding line: score, notices) — `LiveMatchState`
   + existing notice ring.

Layout: two anchors (agent-select top-center, in-match Tab-only), per-display
layouts and clamp stay; Lite/Full toggle in edit chrome; edit contract
unchanged (click-through always except edit mode). Perf: no backdrop-filter
(`0.85` plates), Tab-peek gate, 2.5 s Riot-local polling with idle backoff,
serial TRN gate — no per-second timers. Anti-list: no injection/memory/hook,
no GEP/DLL, no new transports, no keys, no hidden MMR, no GPU state not read
back, no click/key capture in-game.

Open questions for the user: (1) Lite as fresh-install default vs opt-in?
(2) Tab-peek roster in Lite, or truly nothing in-match? (3) Personal TRN map
record first, or rank-tuned meta first, for the pick hint?

## 6. Gaps (unknown — not guessed)

1. Freshness of the `api.tracker.network` UA bypass under Warden today (last
   measured 2026-11-08).
2. Whether any v1 private route answers keyless with UA + source (bulk proven
   405 only).
3. Riot remote rate-limit thresholds / 1015 conditions / per-route quotas.
4. Full GEP field catalogue beyond the 17 `match_info.*` + `me.*` fields quoted.
5. Overwolf/Riot approval SLA for a scout-style VALORANT app.
6. Measured overlay FPS/CPU cost on target hardware (mechanisms exist, no
   posted budget).
7. Name-service edge cases for strict-incognito mids (only match-end harvest
   documented).
8. `match-details` availability delay for the just-finished match.
