# How the TRN app gets live VALORANT data, and whether Recon can

Research, 2026-11-08. Read-only: no PC access, no app install, no Overwolf app run.
Everything below is from public docs, the public Overwolf CDN, and the shipped package
metadata — not from a working Overwolf install.

## TL;DR

TRN has two delivery forms. The appstore form is an Overwolf **WebApp** inside the
Overwolf client; the current one is a **standalone ow-electron** app. Both get live
data from **GEP (Game Events Provider)**, which is Overwolf's own pipeline, not a Riot
API. GEP is only exposed to apps Overwolf has whitelisted and blessed, and every app
that integrates a Riot game must also be approved by Riot. There is no supported way
for a non-Overwolf process to subscribe. For Recon (standalone Tauri) the realistic
answer stays: **local Riot reads + official Riot API**, which is what the app already
does; GEP-level live data is the OCR/log layer already noted in ROADMAP.

## 1. Packaging — the Overwolf WebApp (appstore) form

- Appstore page: `https://www.overwolf.com/app/tracker_network-valorant_tracker`.
  Page metadata carries `ExtensionId=ipmlnnogholfmdmenfijjifldcpjoecappfccceh` —
  the Valorant Tracker app UID.
- Package: an **`.opk`** is a plain zip (Overwolf's own docs call it the app
  installation package). Public listing is available with no auth from two endpoints:
  - `https://apps.overwolf.com/prod/OWStoreExtentions.json.gz` — global catalog
    (note Overwolf's own typo "Extentions"); per-app `UID`, `Version`,
    `DownloadURL`, `Type`, `MinimalOWVersion`.
  - `https://install.overwolf.com/install/clean?partnerId=0&channel=0&extensionId=<UID>`
    — returns installer JSON with the app package URL (partnerId/channel are not
    required; placeholder values still resolve).
  - Direct CDN pattern: `https://appsdl.overwolf.com/prod/apps/<UID>/<VERSION>/app.opk`.
- **Verified live** for Valorant Tracker: catalog entry `1.32.14`, WebApp,
  MinimalOWVersion 0.290.0; `HEAD` on
  `https://appsdl.overwolf.com/prod/apps/ipmlnnogholfmdmenfijjifldcpjoecappfccceh/1.32.14/app.opk`
  → `HTTP 200`, `content-length: 3956766`, `last-modified: 2026-10-28`, first bytes
  `PK\x03\x04`. **The package downloads without the Overwolf client.**
- Structure of that opk (209 files): `manifest.json`, `_metadata/verified_contents.json`,
  `assets/`, `js/*.js` bundles, `windows/*.html`. `manifest.json` declares
  `type: WebApp`, `minimum-gep-version: 290.0`, permissions
  `Extensions, Streaming, DesktopStreaming, VideoCaptureSettings, Profile, GameInfo,
  Hotkeys, FileSystem`, windows `background/desktop/ingame/second_screen/duels/teammates`,
  `game_targeting.game_ids: [21640]` (Overwolf's VALORANT id), `game_events`,
  `launch_events` on GameLaunch, and `externally_connectable` for
  `*.overwolf.com`, `*.tracker.gg`, `*.tracker.network`, `*.pvp.net`, `trackercdn.com`.

This form still requires the Overwolf client to run the app — the package is a WebApp.

## 2. Packaging B — the standalone ow-electron build (the current TRN app)

pc-forensics observed a separate TRN Valorant installer that ships **ow-electron**,
not the Overwolf client: app id `ekmbhgikmjbagjojiebkkbgghcedofnobpajodoi`, v0.23.0,
~133 MB installed, ~3 MB installer. That size is a bundled Chromium plus the
Overwolf runtime — it is a self-contained desktop app.

What `@overwolf/ow-electron` is (official docs):

- A package based on the `electron` package "adding several new features to it";
  built with `@overwolf/ow-electron-builder`; `@overwolf/electron-is-overwolf`
  detects the runtime. It is a **fork of Electron**, not an addon you bolt onto any app.
- GEP in ow-electron is a runtime API on the app object:
  `app.overwolf.packages.gep.setRequiredFeatures(features)`,
  `.on('new-game-event', (e, gameId, ...))`, `.getInfo(gameId)`,
  `.on('new-info-update', ...)`. So the data arrives through the Overwolf runtime
  that ships inside the package — there is no user-installed Overwolf client involved.
- The docs do **not** document the wire transport (no public socket/pipe/HTTP contract).
  Public evidence for the Overwolf runtime's mechanism is `OWGameEventsConsumer.dll`
  plus shared-memory channels (see §3) — a private transport.

Gating (all from official docs, quotable):

- "Using Overwolf APIs requires your app idea to be **whitelisted**. Whitelisting is
  only granted to ideas submitted and approved via the App proposal process.
  **Unapproved apps won't have full access to the Overwolf Packages features.**"
- "Apps that haven't been approved are considered non-compliant or non-approved
  Overwolf apps."
- "**Overwolf doesn't approve private apps.** All apps must be listed and distributed
  through the Overwolf Appstore" — while ow-electron's own pitch is a white-label
  standalone app, so approved public apps are the only path for self-distribution.
- Code signing: "Without a **signed** exe, the gaming packages (**GEP**, Overlay,
  Recorder) do not load at runtime in a distributed build."
- GEP for ow-electron is rolled out **per game**: "Not all games are available in the
  PROD environment"; dev builds use `--owepm-package-channel=gep:dev`; "You must tell
  your DevRel once when you are ready to go live so that the game can be moved to PROD."

So: any Electron app **with** the package technically contains the API, but a
non-whitelisted app is explicitly "non-approved" and GEP is only enabled for approved
ids, signed builds, and games moved to PROD by Overwolf's DevRel. The TRN app is
therefore an approved, Riot-and-Overwolf-blessed build — that approval is what buys it
GEP, not the npm package.

## 3. Runtime bridge — can something outside consume GEP?

**No supported way.** GEP is an Overwolf-runtime API exposed only inside an Overwolf
app (WebApp or ow-electron). Overwolf publishes no local socket/pipe/HTTP contract, and
their docs even warn "Avoid logging GEP data to any of the log files" — so not even
logs are an intended source.

The one public project that does it is
[`SteveOberst/Overwolf-Hook`](https://github.com/SteveOberst/Overwolf-Hook) (MIT,
experimental): it injects a capture DLL into the main `Overwolf.exe` and reads the
runtime's private transports — "game provider -> Overwolf shared memory", targeting
`OWGameEventsConsumer.dll`, with up to 64 reader slots and a wire version that must
match. It requires Overwolf running with the provider active, is Windows-x64 only,
and says outright that "an untested build may crash the host" and that its shared
objects "are not a hostile-peer security boundary".

Plain answer: a separate process can consume GEP **only by reverse-engineering and
injecting into Overwolf's private transport**, which is unsupported, unsanctioned,
fragile, and (see §5) a breach of Overwolf's developer terms. It is not an
interoperability feature Overwolf offers.

## 4. TRN app behaviour — GEP plus their own backend

- The app is built to consume GEP: its JS bundle calls
  `overwolf.games.events.setRequiredFeatures / getInfo / onNewEvents / onInfoUpdates2
  / provider` (classic API) and the manifest declares `game_events` for game 21640.
  So in-match data (scoreboard, roster, round, kills) is **free from GEP**.
- It is not GEP-only. Career stats, leaderboards, match history and the profile pages
  are not GEP data. The bundle references their own backends — hostnames found in the
  shipped JS: `api.tracker.network` (8 refs), `tracker.gg` (23), `go.tracker.gg` (12),
  `account.tracker.gg` (3), `trackercdn.com` (32), plus `glz-*`/`pd.*` Riot hosts.
  `api.tracker.network` in particular is their app backend, not the captcha-gated
  `api.tracker.gg` site API.
- Public corroboration for an Overwolf-origin route: in 2026-09 a third-party fix
  ([RocketLaunchpad#120](https://github.com/Ghosty920/RocketLaunchpad/pull/120)) made
  tracker.gg calls work by copying the **Overwolf origin header and a `TRN-Api-Key`**
  used by Overwolf traffic. That strongly suggests the app/Overwolf route to TRN's API
  is keyed and origin-scoped, separate from the browser-facing captcha wall.
- We deliberately did **not** extract endpoints or credentials from the package:
  using another company's key would be credential misuse (and a breach of their terms).
  The distinction we can prove is: GEP supplies live match data; TRN's own backend
  supplies the stat history.

## 5. Legal

**(a) Reverse engineering for interoperability.** Overwolf Developer Terms §3.5: the
developer "shall not … (c) disassemble, reverse engineer, attempt to find the underlying
code of, or decompile the Platform or Platform API, or (d) circumvent any security
mechanisms of the Platform or API." §4.1.12 adds: "You will not access **undocumented
Platform API** or otherwise attempt to derive or use the underlying source code of
undocumented Platform API without Overwolf's prior written permission." The website
terms carry the same prohibition for the client. There is no interoperability carve-out.

**(b) A non-Overwolf app consuming GEP.** Nothing licenses it. GEP is part of the
Platform API and the documented route requires an approved, whitelisted, signed
Overwolf app. Reading it from outside means circumventing that API boundary — exactly
§3.5(c)/(d) — and Riot's side is moving the same direction: from **2026-10-06** Riot
"will begin proactively preventing game memory access by default for all unknown
third-party applications, for all titles, including … VALORANT", with approved tools on
grace until **April 2027** and everyone else told to move to the official APIs. A
Tauri process speaking Overwolf's private transport is the definition of "unknown".

**(c) Another company's credentials.** TRN's API key belongs to their registered app.
Shipping or using it is unauthorized access to their service and would break Riot's and
Overwolf's app-approval terms. This applies even if the key is visible in a public repo.

**(d) Riot approval.** Overwolf's Riot compliance page: "Due to recent updates to the
VALORANT Developer API Policy … **Private Apps are no longer accepted** regardless of
whether or not they utilize the game's API; **Public Apps must receive formal approval
from both Riot Games and Overwolf** before being hosted." It also states these rules
"hold even if you do not intend to use the Riot API itself", and bans spike timers in
live matches. Riot's own third-party policy bars apps that "expose information that's
intentionally obfuscated" and "draw conclusions for you during gameplay".

## 6. Verdict for Recon (standalone Tauri), ranked

1. **Keep local Riot reads + official Riot API (current design).** No approval, no
   key, no Overwolf runtime; already covers rank/RR, match history, match details,
   party/incognito. For GEP-only data (whole-lobby scoreboard/kill feed, precise
   health/shield/weapon) the existing plan stands: log tail + local client + OCR, all
   inside the Tauri process. **Realistic today.**
2. **Ship a second, ow-electron build of Recon.** Technically the supported path to
   GEP, but it means porting the shell from Tauri to a forked Electron, getting a
   whitelisted app idea approved by Overwolf DevRel, mandatory Overwolf monetization
   (ads and/or Tebex — third-party monetization is not allowed), a CA code-signing
   certificate, per-game PROD rollout by DevRel, and **formal Riot approval** for a
   VALORANT app. Months of calendar time plus a business relationship; do not start
   it unless the live-data feature is the product.
3. **Consume GEP from outside Overwolf** (Overwolf-Hook-style injection). Technically
   demonstrated by a third party, but breaches Overwolf's developer terms, is
   unversioned/fragile, and runs against Riot's 2026 memory-access direction. **Reject.**
4. **Use TRN's own backend with their key/origin.** Credential misuse; also ties Recon
   to a company already walling us with a captcha. **Reject.**

Approval cost, concretely: an app-idea form reviewed by Overwolf DevRel, a QA
submission round, Developer Console access only after QA passes, a signed build (a CA
certificate is now required), Overwolf monetization integrated, then Riot's separate
third-party application process. There is no stated SLA; the docs describe a
multi-round QA cycle, and Riot approval is a separate gate that can refuse.

## 7. What we could not verify

- Whether the TRN standalone ow-electron build would run GEP for an unapproved id
  (we assume no, from the docs; testing it would mean running an approved vendor's
  app with a modified id, which we did not do).
- The exact ow-electron wire transport (not documented; §3 describes the classic
  client's transport from a public reverse-engineering project).
- Whether `api.tracker.network` is currently captcha-free for Overwolf-origin traffic:
  we did not use their key/origin to test, by policy.
- Riot/Overwolf approval timelines and acceptance odds for a scout-style VALORANT app;
  the docs give no SLA and the compliance text is restrictive.

## Links

- GEP (ow-native): https://dev.overwolf.com/ow-native/live-game-data-gep/live-game-data-gep-intro
- GEP (ow-electron): https://dev.overwolf.com/ow-electron/reference/game-events/
- ow-electron technical overview: https://dev.overwolf.com/ow-electron/getting-started/onboarding-resources/ow-electron-technical-overview
- ow-electron app approval / whitelisting: https://dev.overwolf.com/ow-electron/getting-started/project-roadmap
- ow-electron release + signing: https://dev.overwolf.com/ow-electron/getting-started/release-your-app
- Riot compliance for Overwolf apps: https://dev.overwolf.com/ow-native/guides/game-compliance/riot-games/
- Overwolf Developer Terms: https://legal.overwolf.com/docs/overwolf/developers/developer-terms/
- Riot third-party apps: https://support.riotgames.com/en-us/riot/events/third-party-applications
- Riot memory-access removal: https://support.riotgames.com/en-us/riot/performance/game-memory-access-removed-for-third-party-apps
- Overwolf-Hook (unsanctioned GEP bridge): https://github.com/SteveOberst/Overwolf-Hook
- opk download notes: https://gist.github.com/0xdevalias/c5bd55b50f0e2da9d0c685163535d4c6

## Bundle analysis (2026-11-08) — how the TRN app actually gets live data

Source: `Valorant Tracker` webapp package v1.32.14, downloaded from
`appsdl.overwolf.com/prod/apps/ipmlnnogholfmdmenfijjifldcpjoecappfccceh/1.32.14/app.opk`
(3.96 MB, plain zip, no auth). Local copy under `docs/overwolf/captures/`
(git-ignored: it is proprietary and contains vendor credentials).

### Two layers, both required

1. **Live match telemetry: Overwolf GEP.** The bundle calls
   `overwolf.games.events.on(...)` for `match_info` and `kill`/`death`
   features, reads `roster_*` and `scoreboard_*`, and the manifest declares
   `game_ids: [21640]` with `minimum-gep-version: 290.0`. That is where player
   PUUIDs, agents, ranks, KDA, money, weapons and the real `match_id` come
   from — the game telemetry Overwolf is licensed to read.
2. **Enrichment: TRN's own backend.** One bulk call per match:
   `POST https://api.tracker.network/api/v1/valorant/overwolf/ow-bulk-lookup`
   with a JSON body `{phaseId, matchId, playlistId, mapId, players}`. Also
   present: `/api/v2/valorant/standard/profile/`, `/standard/matches/`,
   `/api/v1/valorant/db/seasons`, `/guides`, `/insights/`, `/premier/roster/`,
   and a socket.io channel at `realtime-events.tracker.network`.

### The gate — measured, 2026-11-08

The bundle sends `TRN-API-Key` (embedded in the app) plus
`User-Agent: OverwolfClient`, and adds `?source=overwolf-2` to profile calls.

Tested against the live API, the result was not what the code suggests:

| Request | Result |
|---|---|
| `User-Agent: OverwolfClient` | **200** |
| Chrome UA / `Recon/0.5` / `curl` | 403 |
| with the embedded key vs without | **byte-identical** (883,272 B both) |
| no `source` param | 883,272 B — 1 season segment, no map/weapon data |
| `?source=web` | 1,574,765 B |
| `?source=overwolf-2` | **2,186,636 B** — 3 season segments + 21 weapon + 7 map + map-agent breakdowns |

So the UA is the whole gate and `source=overwolf-2` is the data lever. The
embedded key changes nothing on these routes; it is an app-attribution/quota
marker. The route where it might matter,
`/api/v1/valorant/overwolf/ow-bulk-lookup`, answers **405** to POST, GET, with
the key, without it, and with every parameter shape tried — it is not reachable.

A `451` is not a block either: it is TRN's "this profile is private" state.

**Decision: Recon does not use that key.** It is another company's credential,
tied to their Overwolf app; using it is credential misuse, breaks Overwolf's
developer terms and Riot's data rules, and would be revoked the moment it is
noticed. The key is deliberately not reproduced anywhere in this repo.

### What this means for Recon

- The live-match experience (enemy ranks, live scoreboard, kill feed) is
  GEP-only. GEP loads only inside a whitelisted, signed Overwolf/ow-electron
  app; Riot additionally requires formal approval for public VALORANT apps.
- No keyless route exists: the public website is captcha-walled, the app
  backend is keyed, and the only "bridge" is DLL injection into Overwolf,
  which their terms forbid.
- Therefore Recon keeps the local-Riot path it already ships, and the bulk
  pattern worth copying is the *shape* — one batched lookup per match instead
  of per-player calls — not the transport.
