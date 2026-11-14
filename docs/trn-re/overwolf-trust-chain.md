# Overwolf trust chain — RE findings + reuse map

Date: 2026-11-14. All binary claims verified locally with `osslsigncode` /
`objdump` / `strings` against `docs/overwolf/captures/` (OPK v1.32.14 +
identical installer). Policy claims cited from primary docs. Secret values are
never reproduced here — `KEY_PRESENT` is as far as reports go.

## 1. The trust chain, bottom to top

```
Riot (accepts Overwolf's signed client as a non-hostile observer)
 └─ Authenticode: DigiCert G4 code-signing cert, CN=Overwolf Ltd
     ├─ Overwolf client runtime (owns GEP, overlay compositor, capture)
     └─ OPK package: plain ZIP + _metadata/verified_contents.json (SHA-256/file)
         ├─ manifest.json (permissions, game_events [21640], extra-objects)
         ├─ app plugin: Overwolf.Plugins.Valorant.dll (UNSIGNED .NET net48, 9,216 B)
         └─ JS: Riot Client Service (class F) + GEP service (class he)
             ├─ lockfile → port/password → 127.0.0.1 local API
             ├─ ShooterGame.log → version, region/shard, live events
             └─ valorant-plugin.getEntitlementsToken(port, password) → entitlements
```

Verified anchors:

| # | Claim | Evidence |
|---|-------|----------|
| 1 | Overwolf binaries Authenticode-signed, DigiCert G4, RFC3161 countersigned | `osslsigncode verify`: `installer/trn-installer.exe`, `$PLUGINSDIR/OWInstaller.exe`, `OverWolf.Client.CommonUtils.dll` → Subject `CN=Overwolf Ltd`, Issuer `DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1`, timestamps Oct 2026 |
| 2 | OPK is a plain ZIP (starts `PK\x03\x04`), content-hash-pinned per file | `_metadata/verified_contents.json` (80+ lines, SHA-256 per asset); mirrors Chromium content-verification; no `.exe`/`.wasm`/`.node` in the package |
| 3 | App plugin DLL is UNSIGNED, loaded by the signed host | `osslsigncode verify` on `Overwolf.Plugins.Valorant.dll` → "No signature found"; manifest `extra-objects.valorant-plugin` → file + class; only native import is `mscoree.dll::_CorDllMain` (pure .NET shim) |
| 4 | The plugin does one thing: entitlements from lockfile creds | Strings: `getEntitlementsToken`, `EntitlementsTokenResponse`, `https://127.0.0.1:{0}/entitlements/v1/token`, `riot:` + `Basic`; version stamp `1.0.0+fe03bada…`, `Copyright Tracker Network 2026`. No d3d/dxgi/hook/inject/memory APIs anywhere in its strings |
| 5 | VALORANT events are parsed from the game log, not memory | JS class `he` (`BSj0SAG_.js`): `setRequiredFeatures` → `addFileListener` on `%LOCALAPPDATA%\VALORANT\Saved\Logs\ShooterGame.log` → `#p(line)` parser. Matches: `Broadcasting state changed to`, `Loopstate changed from X to Y`, `Session_Heartbeat … heartbeat`, `LogMapLoadModel: Update:` (self puuid/name), `Party_* … Response Code: [200]`, `AShooterGameState::OnRoundEnded for round 'N'`, `Gameplay started at local time`, `Winning Team:` |
| 6 | Riot Client Service = lockfile + localhost + remote pd/glz | `F` class: lockfile path, `CI server version:` regex, `glz-(\w+)-\d+\.(\w+).a.pvp.net` region/shard regex, `https://127.0.0.1:{port}/entitlements/v1/token` (Basic riot), then `pd.{shard}` / `glz-{region}` remote with the 4-header auth |
| 7 | TRN key rides `TRN-API-Key` on 10/10 REST methods (redacted) | `Cu_khBDY.js`: `KEY_PRESENT` on profile/match/recent/bulk/insights/seasons/guides; only insights/guides/bulk also send `User-Agent: OverwolfClient`; `?source=overwolf-2` on 4 GETs (each with `source=web` fallback); privacy toggle uses `Authorization: Verification` instead |

## 2. Why Riot trusts Overwolf (the actual mechanism)

There is no secret handshake. Trust = **identity + approval + mechanism**:

1. **Identity**: a standard-CA code-signing certificate (DigiCert, explicitly
   not documented as EV-only) chains the client runtime to a legal entity
   (Overwolf Ltd, Ramat Gan IL). Both the gaming packages AND (for ow-electron)
   the app exe must verify, or GEP/Overlay/Recorder refuse to load.
2. **Approval**: whitelisted developer account via app proposal; store
   distribution; per-game GEP PROD rollout by DevRel; **formal Riot approval
   required for public VALORANT apps** ("must now receive formal approval from
   both Riot Games and Overwolf"). Since 2026-11-01, Overwolf monetization is
   also mandatory. No private/headless apps, ever.
3. **Mechanism**: the app touches no game memory. It reads a log file Riot
   itself writes, calls Riot's own local HTTP API with the user's own lockfile
   creds, and renders in its own compositor. Riot's 2026-10-06 policy blocks
   *memory access* by unknown apps — none of this pipeline is memory access,
   which is why "overlays and internal tools using the API, game client, and
   in-game APIs should continue to function."

UNVERIFIED / denied (do not claim): `verified_contents.json` enforcement is
Overwolf-internal (no official doc; consistent with CEF lineage but unproven);
there is no local "signed allowlist of app ids"; **Vanguard has explicitly no
allowlist** ("There is absolutely no allow list"); no Riot statement names
Overwolf as safe — the line is mechanism-based, never identity-based.

## 3. What we can inherit (copy the shape, need no permission)

| Layer | Their mechanism | Our equivalent (already owned or buildable) |
|-------|-----------------|----------------------------------------------|
| Entitlements | `valorant-plugin.getEntitlementsToken(port, pw)` | `tracker.rs:36-56` lockfile auth + `riot_local` (`:106-159`) — same bytes, no plugin needed |
| Version/shard discovery | `ShooterGame.log` regexes | `tracker.rs:438-458` (`CI server version:`); add the `glz-(\w+)` regex — same file, same read |
| Live events | `#p(line)` parser on `ShooterGame.log` | **New: Rust log tailer** — `notify` crate, offset-based, line → event (`match_start/end`, `roundId`, `roundPhaseId`, `score`, `game_info.screenId/phaseId/menuId`, party/heartbeat). Log lines are per-line; GEP shapes are documented (`match_info.*` fields) so mapping is 1:1 |
| Live data API | lockfile `127.0.0.1` + pd/glz 4-header | `tracker.rs` `riot_direct_get/post/put`, `sources/riot.ts` readers — same surface |
| Enrichment | TRN backend profile/match/history | Keyless direct transport (`trn_http.rs`, UA + `?source=overwolf-2`) — proven byte-identical to keyed on these routes |
| Overlay | transparent windows, exclusive-mode focus takeover | Tauri `overlay` window (transparent, alwaysOnTop, click-through; edit mode only for input) — same shape, anti-cheat-safe (`NOACTIVATE` + click-through) |
| Content integrity | signed + hash-pinned package | Our updater channel (Tauri updater + minisign) — analogous guarantee for our own bytes |

## 4. What we cannot take (and must not try)

- **GEP handle**: `overwolf.games.events.setRequiredFeatures` exists only
  inside their runtime, gated by manifest + whitelist + per-game PROD. No
  bridge API is published. Relaying GEP out to a non-Overwolf surface is a ToS
  grey area at best; headless-relay apps are explicitly unapprovable (§3.5(c)/(d)).
- **Their identity**: TRN key / Overwolf app id / origin — credential misuse,
  revocable, gains nothing (keyless route proven equivalent).
- **Memory/capture paths**: banned by Riot policy and our own AGENTS.md.
- **Official live-match endpoint**: Riot's VALORANT API has none (content,
  match history, ranked, status only; personal keys unsupported; scouting /
  real-time-coaching use cases unapproved). The lockfile path is local APIs,
  not the official API — keep it read-only and non-coaching.

## 5. Reuse checklist (when building the log tailer)

1. Regex inventory from `#p(line)`: `Broadcasting state changed to (\w+)`;
   `Loopstate changed from (\w+) to (\w+)`; heartbeat `glz-…/session/v1/sessions/…/heartbeat`;
   `LogMapLoadModel: Update: … ?Name= ?SubjectBase64= …#`;
   `Party_(FetchParty|SetMemberReady|ChangeQueue|…).*Response Code: [200]`;
   `Party_(Enter|Leave)MatchmakingQueue`; `Pregame_SelectCharacter|Pre…`;
   `AShooterGameState::OnRoundEnded for round '(\d+)'` (their roundId = N+2);
   `Gameplay started at local time (\d+\.\d+)`; `Winning Team: '(Blue|Red)'`;
   `LogMenuStackManager: Opening (\w+)`; `Session_Heartbeat … Response Code: [200]`.
2. Reuse THEIR 4-field platform blob (`PC, Windows, 10.0.19042.1.256.64bit,
   Unknown`) and region/shard extraction — already in our tree.
3. Match `#p`'s phase gating: only emit match events while a match is active;
   party events only with 5 s dedup; round events only for known playlists.
4. Never claim hidden MMR, never de-anonymize, never draw real-time
   conclusions during play ("go here now") — Riot's unapproved list.
