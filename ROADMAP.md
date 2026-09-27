# Product Roadmap & Feature Specification

## 1. Identity & Rebranding
*Current Name:* **Aspect** (too narrow; implies resolution only)  
*Candidate Names:*
- **Recon** (military tactical intel)
- **Catalyst** (performance enhancement & game companion)
- **Overhaul** (total game & display enhancement)
- **ApexTactics / V-Suite / Pulse**

---

## 2. Feature Workstreams

### Phase A: Local Game Enhancements (Zero-Ban Risk, Client API)
1. **Agent Pre-Picker (Safe Hover)**
   - **Mechanism:** Calls Riot Client internal endpoint (`/pregame/v1/matches/{matchId}/select/{agentId}`).
   - **Safety:** Hover only (`select`), NEVER calls `lockfile` instant lock (`/lock`). Safe from auto-lock detection.
2. **Crosshair Studio (ValorantCC Evolution)**
   - Custom hex color codes bypass game UI color restrictions.
   - Live canvas preview, profile storage, shareable crosshair export strings, quick-switch hotkeys.
3. **Inventory & Skin Manager (Ref: Recon Bolt / V-Skins)**
   - Read local player inventory (`/personalization/v2/players/{puuid}/playerloadout`).
   - Lobby skin scout: View weapons, buddies, and skins equipped by teammates and enemies in pregame/in-game.
   - Loadout presets & skin randomizer.

### Phase B: Cloud & Intelligence Services
4. **Toxic Player Warning & Community Karma Network**
   - **Backend:** Lightweight REST/WebSocket server (Bun/Elysia or Cloudflare Workers + D1/Supabase).
   - **Workflow:** Players submit reports with match PUUID + tag (toxicity, AFK, throwing).
   - **Verification:** Threshold-based karma score; flags repeat offenders with visual caution badges in lobby scout.
5. **AI Coach & Gameplay Analyst**
   - **Engine:** OpenCode Zen free LLM API integration.
   - **Inputs:** Round economy, combat stats, death locations, agent utility stats from completed matches.
   - **Outputs:** Bite-sized actionable coaching tips (e.g., eco mistakes, first-death frequency, positioning advice).

### Phase C: Ecosystem Expansion
6. **Product Landing & Distribution Website**
   - Modern landing page (Next.js / Astro / Vite) showcasing features, download links, auto-updater feed, and live community stats.
7. **Mobile Companion App**
   - Live lobby inspect on phone, custom crosshair vault, store checker, and remote notifications when match is found.

---

## 3. Deferred / Backlog

### MMR Signal (raw MMR is not obtainable)
*Status:* Deferred by Youssef — lower priority than the current widget work.

**Verified finding (do not re-litigate):** Riot does **not** expose the hidden/raw MMR
number that sits behind your rank. Confirmed two ways:
1. Scanned the full live `/mmr/v1/players/{puuid}` payload for any key matching
   `mmr|rating|elo|skill` — the only hits are `RankedRating` (= RR, 0-100 inside your
   current tier) and the `LatestCompetitiveUpdate` before/after deltas.
2. The official endpoint schema (`valapidocs.techchrism.me`, `PlayerMMR.ts`) enumerates
   every field the response can contain, and there is no MMR field. Riot removed it.

**So the UI must never claim to show raw MMR.** What we already surface instead:
live RR under the rank emblem, act W/L, leaderboard rank, peak act, per-map/per-agent records.

**If we ever build this**, the only honest option is an **MMR Signal** — a clearly
labelled *estimate*, not a number we pretend is Riot's. Basis: RR swing size and the
performance-bonus component of `/mmr/v1/players/{puuid}/competitiveupdates` (endpoint
verified live, returns 20 matches). Large gains signal MMR above your visible rank;
small gains signal MMR below it. Render as `MMR ↑ above rank` / `MMR ~ at rank` /
`MMR ↓ below rank`, never as a raw value.

### Live in-match data — available WITHOUT Overwolf (earlier conclusion was WRONG)
*Status:* **Deferred — decided we don't need it.** Research kept below so it is never
re-investigated. Nothing was built; there is no code to remove.

The free part is still on the table if it's ever wanted: the live round score, map,
queue and INGAME state cost one local HTTP GET per round and no screen capture at all.

An earlier revision of this file claimed no live in-match data was obtainable. That was
wrong — it came from grepping `ShooterGame.log` for the wrong strings and only reading
`/chat/v4/presences` for party IDs. Both sources carry live match data.

**How Overwolf actually does it** (three local techniques, no magic Riot feed):
1. **Log tailing** — `ShooterGame.log`.
2. **The local client API** — the same `127.0.0.1` endpoints we already call.
3. **OCR vision** — their native `vgep.dll` runs a capture+OCR pipeline (Windows
   Graphics Capture + Windows.Media.Ocr) over HUD regions. Confirmed by the
   `hoangvu12/gigi` project, which reconstructed it: *"Overwolf keeps the real
   digit-OCR rectangles in its native `vgep.dll`, not in any readable config."*
   Overwolf's own GEP docs corroborate — `scoreboard_screen` open/close, `kill_feed`,
   and `round_report` (damage/hits/headshots/bodyshots/legshots) are all screen-derived.

**Verified live on this machine** (competitive game in progress, Split):
```json
// GET /chat/v4/presences  →  private (base64)
"matchPresenceData": { "gameScoreType": "Rounds", "matchMap": "/Game/Maps/Bonsai/Bonsai",
                       "queueId": "competitive", "sessionLoopState": "INGAME" },
"partyOwnerMatchScoreAllyTeam": 10, "partyOwnerMatchScoreEnemyTeam": 12
```
That is the **live round score, map, and queue with zero screen capture**.

`ShooterGame.log` (3.9 MB, this box) also carries: `Reconcile … InGame/MainMenu` (match
lifecycle), `Map Name:` (89 hits), `OnRoundEnded`, round numbers, `glz-*`/`pd-*` hosts
(region/shard), mode codenames (`Bomb`, `swiftplay`), and agent voice-line lines
(approximate local kills/headshots).

**What each source yields:**

| Data | Source | Status |
| --- | --- | --- |
| Live round score (allies/enemies), map, queue, INGAME | presences `private` blob | verified live |
| Match lifecycle, round phase, round number, side, shop | `ShooterGame.log` tail | patterns confirmed |
| Roster, agents, ranks, incognito | local client API | already built |
| Local player K/D/HS | log voice-lines | approximate only |
| Whole-lobby KDA, precise health | OCR of HUD/scoreboard | not built |

**Cost:** log tailing is an in-process file reader (`notify`, offset-based, never
re-scans); the presences call is one local HTTP GET per round. Both are ~0 RAM and
~0 CPU. OCR would add GPU-side capture at ~2 fps (measured ~0.5-2.2 ms per ROI), still
inside the existing process — **no Overwolf, no sidecar, no second runtime.**

**So the Overwolf question is closed in our favour:** their GEP is replicable with
read-only local sources. Only whole-lobby KDA needs the OCR layer, and that is the last
piece, not the first.

### GPU / display scaling settings were reporting memory, not reality
*Status:* Fixed — the report now reads the machine.

`get_gpu_settings_report()` used to return `enabled: saved.<flag>`, where `saved` is
Recon's own `gpu_settings.json` (then at `%LOCALAPPDATA%\TrueStretchStudio\gpu_settings.json`,
now `%APPDATA%\Recon\gpu_settings.json`). It never inspected the
machine, so it echoed whatever Recon last wrote. If the driver ignored or reset the
value, the app still showed a green "enabled" — which is exactly what an AMD user
reported (Recon said on, AMD Software said off).

Two concrete defects, both verified on this box:

1. **Inverted scaling value.** Windows stores scaling per display path as a DWORD at
   `HKLM\...\Control\GraphicsDrivers\Configuration\<monitor>\00\00\Scaling`, documented as
   `1 = maintain display scaling, 2 = centre image, 3 = scale full screen,
   4 = maintain aspect ratio` (Intel's own guidance, corroborated by the CRU forum and
   StackOverflow). The module wrote **4** while labelling the row *"Full-Screen Hardware
   Scaling (0 Black Bars)"* — it requested black bars. Live read confirmed every display
   sat at `0x4`. Now writes **3**, via named constants.
2. **Unverifiable claims presented as fact.** AMD/Intel `Dal*` / `ScaleOption` values are
   driver-owned. ToastyX (CRU) notes driver settings live under
   `Class\{4d36e968-…}\####` and its `DAL3_DATA` subtrees, and AMD documents GPU Scaling
   as an **AMD Software** setting — the `DalGpuScaling`-style names have no public
   documentation (a quoted search returns no real hits). So a write there proves nothing.
   `GpuSettingItem` now carries `verified` + `detail`: only `full_screen_scaling` (WDDM)
   and `low_latency_scanout` (DWM `DirectFlipEnabled`) are read back and marked VERIFIED;
   the rest report UNVERIFIED with the exact key and value found. The header counter reads
   "N verified · M requested · T total" instead of "M / T Active".

Rule for this module: **never display a state we have not read back.** If a value cannot
be observed (vendor-managed), say so and link the user to the vendor panel — do not
assert it.

### "Can we spoof being Overwolf / Blitz to get live data?" — No.
*Status:* Ruled out. There is no handshake with VALORANT to imitate.

VALORANT never talks to a third-party app. Live data reaches commercial overlays by one
of two licensed routes, both of which terminate at the *partner's own backend*, not at
the game:

| Route | Who uses it | How the data actually arrives |
| --- | --- | --- |
| Overwolf Game Events Provider | Tracker.gg (an Overwolf app) | Overwolf's licensed pipeline. The `overwolf.games.events.*` API only exists inside the Overwolf runtime, authenticated to its client. |
| Direct Riot partnership | Blitz.gg (own standalone client, not Overwolf) | Blitz states it "works closely with Riot Games to ensure our app is fully compliant" — Riot serves the data to Blitz. |

Consequences:
- Impersonating Blitz to Riot = forging a licensed partner's credentials. Detection,
  account ban, and legal exposure; no legitimate path to obtain the keys.
- Impersonating an Overwolf app = circumventing Overwolf's auth and app review.
- Riot's public API is a dead end regardless: VAL-CONTENT-V1, VAL-MATCH-V1,
  VAL-RANKED-V1, VAL-STATUS-V1 only — **no live/in-progress match endpoint exists**,
  production keys are gated behind an application process, and Riot's policy bars
  "personal profiles, scouting tools, guides based on individual players, or
  personalized data of any kind" unless the player opts in via RSO.

Also worth noting for later: Riot's stated policy above is directly about a feature like
our lobby scout. Blitz and Tracker.gg both refuse to unmask incognito players; we do.
That is a real product advantage, but it is also the kind of thing the policy language
targets, so treat it as an accepted-risk decision to revisit before any public release,
not as settled.

**Realistic paths, ranked by effort:**
1. **Screen OCR** — the only standalone route. Capture the HUD/scoreboard read-only.
2. **Overwolf build** — ship a second target on the Overwolf platform. Needs
   Overwolf app approval; no Riot approval, as Overwolf holds that.
3. **Riot production key + app review** — slow, gated, and still no live endpoint.

#### Overwolf as a "sidecar" — evaluated, and the RAM cost is real
An Overwolf app is **not a standalone binary we can spawn next to Tauri**. It is an
HTML/JS app hosted by the Overwolf client, and per Overwolf's own SDK docs "each app is
hosted separately in its own web browser, and each web browser runs as a separate
process". So the user runs the whole Overwolf client regardless — there is no thin
sidecar shape.

Gating (all from Overwolf's docs):
- **Developer whitelisting is mandatory.** "Only whitelisted Overwolf developer accounts
  can load or install apps that are not available on the Overwolf store" — so even
  local testing needs an approved app proposal first (~4 business days for feedback).
- Release needs an OPK package plus a QA review cycle.
- Public apps must show at least one desktop window; **headless/background-only apps are
  explicitly not approvable**. A pure data-relay app is therefore a non-starter.
- Relaying GEP data out to a non-Overwolf surface is a ToS grey area on top of that.

Memory, measured/gathered rather than guessed:
| Component | RAM |
| --- | --- |
| Overwolf client alone | ~150-300 MB (its own support docs: 8 GB min / 16 GB recommended system) |
| + a single GEP app | ~500-700 MB combined |
| Recon today (Tauri + WebView2 children) | ~374 MB for 14 processes on this box; `recon.exe` itself is only 12.6 MB |
| Screen OCR | ~0 marginal (an on-demand capture in the existing process) |

So Overwolf would roughly add the cost of a second full Chromium runtime, permanently
resident, and hand a third party control of the live-data tap — for data we would still
have to proxy back into our own UI.

**What GEP would actually give us** (the upside, for completeness): `match_info.score`
and `round_number`, a `scoreboard` info item with per-player kills/deaths/assists/money/
alive, `round_report` with the local player's damage + headshots/bodyshots/legshots, and
a `kill_feed` event. That is the full live picture — round score, whole-lobby KDA, live
HS%.

**Decision:** OCR is the better fit for a standalone Tauri app. Overwolf only becomes
worth it if we deliberately ship a *separate Overwolf product* and accept the RAM tax,
the approval process, and the relay grey area — not as a sidecar to this app.
