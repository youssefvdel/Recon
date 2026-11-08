# TRN Valorant app — reverse-engineering map and verdict

Source: `docs/overwolf/captures/opk/extracted/` — the official Overwolf package
`Valorant Tracker 1.32.14` (189 files), pulled from
`appsdl.overwolf.com/prod/apps/ipmlnnogholfmdmenfijjifldcpjoecappfccceh/1.32.14/app.opk`.
All statements below are traced to chunk code; file inventory in `inventory.md`,
endpoint table in `endpoints.md`, per-round detail in `rounds.md`.

## What the app is

An Overwolf **WebApp** (manifest type `WebApp`, `minimum-gep-version 290.0`,
`game_targeting.game_ids: [21640]` = VALORANT, `game_events: [21640]`) with 10 windows:

| Window | Entry chunk | Role |
| --- | --- | --- |
| `background` | `js/windows/BSj0SAG_.js` (102,413 B) | The brain: GEP service, Riot Client Service, Socket.IO, Discord RPC, window manager, OAuth |
| `desktop` (also `ingame`) | `js/windows/D4rg-gIm.js` (214,532 B) | Main UI: home, match page, profile, rounds timeline, economy, duels |
| `second_screen` | `js/windows/BABgp3Wf.js` (102,433 B) | Second-monitor UI: HighImpactAd, SubscriptionStatus, match views |
| `duels` | `js/windows/D-GTq3ef.js` | Compact live duels overlay |
| `teammates` | `js/windows/BzjOSqAi.js` | CareerStats / PlayerInfo / TeammateCareerStats |
| `timeline` | `js/windows/Cw9odwNh.js` | **In-game round timeline overlay** (see `rounds.md`) |
| `guides` | `js/windows/DIXWZmPO.js` | Lineup (agent/map guide) window |
| `assistant` | `js/windows/DOdzI-fU.js` | Coaching/reminder assistant |
| `verification` | `js/windows/1NrW1_TY.js` | Account verification / auth handoff |
| `uninstall` | `js/windows/ej4RcvaA.js` | Uninstall survey |

Windows never own game state. Each secondary window boots, waits for the main window
(up to 5 s), then reads `overwolf.windows.getMainWindow().background`:

```js
// js/windows/Cw9odwNh.js (timeline)
for (let e = 0; e < 50 && !overwolf.windows.getMainWindow()?.background; e++)
  await new Promise(e => setTimeout(e, 100));
n.prototype.$background = overwolf.windows.getMainWindow()?.background;
...
computed: { rounds() { return this.background.game.session.rounds } }
```

So live per-round state lives once in the background page.

## Data sources (four, not one)

1. **Overwolf GEP** — `overwolf.games.events.*` with required features
   `[me, game_info, match_info, premier_info, career_stats]`
   (`BSj0SAG_.js`, class `he`). Fields consumed: 17 `match_info.*`
   (`game_mode, isCustom, isRanked, kill_feed, map, mapId, matchId, match_outcome,
   playlistId, pseudo_match_id, resultId, round_number, round_phase, round_report,
   score, team, ui_team_order_allies`) and `me.*` (`agent, agentId, id, isLocked,
   membersIds, nickname, partyId, playerId, region, ...`).
2. **A custom GEP fallback** — the same class extends to a "Custom" provider that tails
   `%LOCALAPPDATA%\VALORANT\Saved\Logs\ShooterGame.log` (file listener), parses
   `CI server version: …` and `glz-(\w+)-1.(\w+).a.pvp.net` for region/shard, and reads
   `Riot Client\Config\lockfile` for port/password. It declares the same five features and
   uses a native helper `Overwolf.Plugins.Valorant.dll` (`getEntitlementsToken`).
3. **Riot Client API (pd/glz)** — the app's own `Riot Client Service` (class `F`) calls
   party, pregame/core-game player+match, `match-details`, `match-history` and `mmr`
   with `Authorization: Bearer`, `X-Riot-Entitlements-JWT`, `X-Riot-ClientPlatform`,
   `X-Riot-ClientVersion` — the exact pattern Recon already ships.
4. **Tracker Network backend** — `api.tracker.network` v2 profile/matches and v1
   insights/seasons/guides/bulk/premier, plus Socket.IO `realtime-events.tracker.network`
   (`subscribe` / `valorant.profile.updates`). Every call carries a hardcoded
   `TRN-API-Key` in `js/Cu_khBDY.js` (key redacted here; see `endpoints.md`).

Plus a public GEP health check: `https://game-events-status.overwolf.com/{game}_prod.json`
(polls feature state, maps to green/yellow/red).

## Live vs post-match

| Data | Source |
| --- | --- |
| Round number, phase, side, score, round result, kill feed, round report, match outcome | **GEP** `match_info.*` → background session state |
| Roster, agents, ranks, levels, incognito, premier prestige, party | **Riot GLZ** pregame/core-game match (`SeasonalBadgeInfo.CompetitiveTier`, `RankedRating`, `PremierPrestige`) + GEP `player_*` |
| MMR per lobby player | **Riot PD** `mmr/v1/players/{puuid}` (batched `Promise.all`) |
| Match list, match stats, rounds segments, insights, seasons, guides, bulk lobby lookup | **TRN backend** |
| DMG/RND, DDΔ/RND, head-hit %, clutch counts, duels aggregation, kill distance, timeline halves/OT padding | **computed client-side** |
| Post-match round table, per-round kills/damage/economy | **TRN segments**, normalised from Riot `match-details` (see `rounds.md`) |

## Verdict

- The **per-round data is not proprietary**. TRN renders it from its own backend's
  `player-round` / `round-summary` / `player-round-damage` / `player-round-kills` segment
  model, and every field in that model has a direct source in Riot's
  `match-details/v1/matches/{id}` — which Recon already fetches and partially parses
  (`src/utils/tracker.ts:1078`, `:1267-1310`). Details and the field-by-field mapping:
  `rounds.md`.
- What TRN adds is normalisation, caching/archive and a clean UI model — reusable as
  design, not stealable as data.
- Off-limits: the hardcoded `TRN-API-Key`, the private `ow-bulk-lookup` / `insights` /
  `privacy` / `premier` routes, the realtime topics, and their assets/branding.

## Reusable ideas for Recon (ranked)

1. **Per-round model from Riot match-details** — one fetch gives rounds, kills with
   killer/victim/time/weapon/positions, damage matrices, economy, plants and defuses.
   Build `player-round` and `round-summary` tables client-side; no TRN needed.
2. **Derived metrics that need no extra data** — DMG/RND = damageDealt / rounds with a
   result; DDΔ/RND = (damageDealt − damageReceived) / rounds; duel kill distance =
   `sqrt((x1−x2)² + (y1−y2)²) × 0.01` m from `playerLocations`/`victimLocation`;
   per-round headshot counts from `damage[]`.
3. **Timeline layout rules** — playlist max-round table (25 competitive/premier/unrated,
   19 skirmish, 9 swiftplay/replication/aros/retake, 7 spikerush), pad missing rounds,
   cap at 27, split at half, mark OT when `round.id >= maxRounds`. Pure UI logic.
4. **Bulk lobby lookup shape** — TRN sends one POST per lobby
   (`{phaseId, matchId, playlistId, mapId, players[]}`) instead of N profile calls; the
   batching idea is reusable even though their endpoint is not.
5. **GEP health probe** — `game-events-status.overwolf.com/{game}_prod.json` so the UI can
   say "provider degraded" instead of silently failing.
