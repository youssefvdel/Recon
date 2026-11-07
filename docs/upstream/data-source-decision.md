# Data-source decision — TRN official key vs HenrikDev vs local Riot client

2026-11-07 01:00–01:09 (Africa/Cairo). Follow-up to `tracker-gg-verdict.md`.
All probes read-only. Write scope: this file only.

## Bottom line

**Use the Riot client the app already talks to. No key, no third party, no captcha.**
The decisive find: Riot's PD endpoints, called with the local client's own token,
serve **arbitrary PUUIDs and arbitrary match IDs**, not just the logged-in account.
So rank/RR, match history and match details for *other lobby players* are available
offline-of-tracker.gg. Recon already does exactly this for other players' 24 h record.

## A. Official TRN API (api.tracker.gg + `TRN-Api-Key`)

| Question | Live answer |
|---|---|
| Keyed path bypasses Warden? | **Moot — and no.** VALORANT is not covered by the official API at all. |
| Key obtainable? | Yes for *supported titles*: create app on tracker.gg/developers → key issued immediately; production use needs Discord whitelisting (DM `rodex`). |
| Header | `TRN-Api-Key: <key>` ([README](https://github.com/TrackerNetwork/TRN.Developers), [docs](https://tracker.gg/developers/docs/authentication)) |
| Titles | Apex Legends, The Division 2, Splitgate (deprecated), CS:GO (deprecated). **No VALORANT.** |
| Verbatim (TRN Freshdesk FAQ, updated 2025-06-09) | *"We are not allowed to provide APIs for other games. Please do not ask for a key, it won't be granted."* and *"You do not have permission to use any TRN endpoints that are not listed on the documentation above."* |

Probe from the PC with a bogus `TRN-Api-Key` on the site path still returned
`429 Warden::Challenge` — the captcha gate sits in front of auth, so a key would not
rescue the site endpoint either. **Option A is dead for VALORANT.**

## B. HenrikDev (api.henrikdev.xyz)

| Question | Live answer |
|---|---|
| Keyless? | **No — key-only everywhere.** 401 on all four probes from this box: `/valorant/v3/matches/eu/Test/EUW`, `/v2/mmr/eu/Test/EUW`, `/v1/account/Test/EUW`, even `/v1/status/eu` → `{"errors":[{"code":0,"message":"Unauthorized","status":401}]}` |
| Key format | `Authorization: <key>` header (or `?api_key=`), per OpenAPI v4.6.0 spec |
| Obtain | dashboard [api.henrikdev.xyz/dashboard](https://api.henrikdev.xyz/dashboard/) → API Keys → Generate New Key; free tier exists, premium raises limits |
| Limits | Per key, global. v4 counts 1 per API call **+1 per background Riot request**; `RateLimit`/`X-RateLimit-*` headers; 429 with `Retry-After` |
| Coverage (spec, 67 paths) | account, mmr v1/v2/v3, mmr-history, matches v3/v4, match v2/v4, leaderboard, premier, stored-matches/stored-mmr-history — everything Recon needs, but each lookup is a third-party call with a key the user must hold |

Same trust model as before: **user-supplied key**, rate-limited, and it is a third
party that can itself gate or die (it already forced key-only at some point).

## C. Local Riot client / Riot-direct (no key) — WINNER

What the app already pulls (verified in code):
- Local loopback 127.0.0.1 (Riot Client lockfile): `/player-account/aliases/v1/active`,
  `/entitlements/v1/token`, `/player-account/lookup/v2/namesets-for-puuids`,
  `/chat/v4/presences`, `/chat/v6|v7/*`, `/social/*` (`src-tauri/src/tracker.rs:65-140,329-404,467-480`).
- Riot-direct PD/GLZ with that token: `mmr/v1/players/{self}`, `mmr/.../competitiveupdates`,
  `match-history/v1/history/{self}`, `match-details/v1/matches/{id}`, pregame/core-game
  match + loadouts (`src/utils/tracker.ts:215-225,631,773,831,1078,1470-1475,2755-2810`).
- **Already cross-player:** `fetchPlayer24hRecord(puuid)` pages
  `/match-history/v1/history/{puuid}` for lobby players and fetches their match details
  (`tracker.ts:1860-1935`, `fetchLiteMatchResult` at `1603-1618`).

Live probe (PC, own account (redacted), region eu, Riot Client running):

| Request (own token) | Result |
|---|---|
| `GET pd.eu.a.pvp.net/mmr/v1/players/<self>` | 200, rank/RR payload |
| `GET .../mmr/v1/players/2ef28c39-c342-55f0-a159-9cd0cae55f2d` (**another player**) | **200** — 27 seasons, `TierAfterUpdate 21`, `RankedRatingAfterUpdate 56`, `RankedRatingEarned 16` |
| `GET .../mmr/v1/players/1111…1111` (ghost) | 200, empty profile — no per-puuid 403 |
| `GET .../match-history/v1/history/<other>` | **200**, `Total 95` |
| `GET .../match-details/v1/matches/204feead-…` (match the local account never played) | **200**, 10 players, Bomb mode |

Party + incognito + account level are already local: presence `private` partyId,
core-game `Players[].partyId`/`PlayerIdentity` (`tracker.ts:2837-2932`; survey §3).

## Comparison

| Recon field | TRN (today) | Local Riot client | Riot-direct PD | HenrikDev |
|---|---|---|---|---|
| Own rank / RR / peak + per-act tiers | profile | — | ✅ `/mmr/v1/players/{puuid}` (already shipped) | ✅ key |
| Other lobby players rank / RR / peak | `fetchTrnActStats` per player | ❌ not exposed | ✅ verified 200 for arbitrary PUUID | ✅ key, 1 call/player |
| Match history (any player) | matches | — | ✅ verified 95 rows for another player | ✅ key |
| Match details (any match) | matches/{id} | — | ✅ verified foreign match, 10 players | ✅ key |
| KD / ACS / HS% / win% per act (lobby players) | ✅ precomputed by TRN | ❌ | ⚠️ computable from cached match details; cost = N matches/player | ✅ stored stats |
| Agent/map splits, previous acts (own profile) | ✅ | ❌ | ⚠️ computable from match details, heavier | ✅ stored/stats |
| Party grouping | was via match details | ✅ presence + core-game | ✅ match-details partyId | ⚠️ partial |
| Incognito / account level | ❌ (TRN refuses) | ✅ core-game `PlayerIdentity` | ✅ match-details `accountLevel` | ❌ |
| Needs a key | yes (and unavailable for VALORANT) | **no** | **no** | yes |
| Captcha / bot gate | **Warden 429** | no | no | no (but key-gated) |
| Third-party traffic | yes | no | Riot only | yes |

No TRN-derived field is *impossible* locally; the gap is **precomputed convenience**
(lifetime/act aggregates, agent & map splits). Riot's history window is the practical
limit (~95 recent matches seen; TRN keeps a longer archive).

## Recommendation — smallest change that restores fetching

1. **Lobby (highest value, smallest patch):** add `fetchMmrForPuuid(puuid, region)` —
   the existing `fetchMmrDirect` call with the puuid instead of `ent.puuid` — and in
   `fetchTrnStatsNow` (`tracker.ts:2216+`) replace `fetchTrnActStats` with it. Rank, RR,
   peak and per-act tiers then arrive with no key, no captcha, no third party.
2. **Recent form:** already local (`fetchPlayer24hRecord`); unchanged.
3. **Act KD/ACS/win% for lobby players:** compute from `fetchLiteMatchResult` source data
   (match details already fetched for the 24 h record, cached immutable). Extend the
   window from 24 h to the current act once, then reuse the cache.
4. **Own Tracker tab (agents/maps/prev acts):** same computation over cached match
   details, or keep TRN off until/unless it works again. `calculateTrsFallback` already
   covers TRS without TRN.
5. Keep the TRN toggle OFF by default; delete the Warden-path retries so users stop
   burning 25–60 s cooldowns.

No user-supplied key is required for this path. If a precomputed aggregate service is
wanted anyway, HenrikDev is the only working keyed option (free key from its dashboard);
official TRN API is not an option for VALORANT.

### What the user must do
- **Local Riot / Riot-direct:** nothing. Riot Client logged in (already required to launch).
- **HenrikDev:** create a free key at `api.henrikdev.xyz/dashboard` and paste it in settings.
- **Official TRN API:** nothing can be done — VALORANT is not licensed to TRN's developer API.

### ToS / safety note
Riot-direct calls are read-only GETs over the local client's own session, the same trust
boundary the app already ships (`mmr`, `match-history`, `match-details` for self). Extending
the same GETs to lobby PUUIDs adds no mutation, no injection, no memory access. The endpoints
are Riot's private client API — unofficial, and Riot may change or gate them; treat failures
as non-fatal like the current Riot-direct fallbacks. Do **not** call the TRN web endpoints to
"just get aggregates": that is exactly the scraping their captcha now blocks.

### Public tier/RR only — field-level check (2026-11-07 01:12)

The AGENTS.md / ROADMAP.md rule is "never claim raw/hidden MMR". Measured on the live
payload for a **different player** (`mmr/v1/players/2ef28c39-…`, 27 seasons, 97 distinct
JSON keys):

- **No `MMR` key, no `raw`, no hidden-MMR field.** `HAS_MMR=False HAS_RAW=False`.
- The only "hidden" match is `IsActRankBadgeHidden` — a *display* flag on the act badge.
- Present keys are the public competitive display set:
  `CompetitiveTier`, `Rank`, `RankedRating`, `LeaderboardRank`, `NumberOfGames`,
  `NumberOfWins`, `WinsByTier`, `TierBeforeUpdate`/`TierAfterUpdate`,
  `RankedRatingBefore/After/Earned`, `RankedRatingPerformanceBonus`,
  `RRPenalty`, `WasDerankProtected`, `IsPlacementMatch`, `CompetitiveMovement`,
  per-playlist blocks (`unrated`, `deathmatch`, `swiftplay`, `premier`, …).

That is exactly the tier + RR the game itself shows on the Act Rank / career / post-match
RR screens. So this read does **not** expose hidden MMR, and a tracker built on it must
keep saying "rank/RR from Riot", never "MMR". Still Riot's private client API: read back
what Riot returned, mark it unverifiable when absent, and treat gating/removal as a
non-fatal failure (same rule as every existing Riot-direct call).
