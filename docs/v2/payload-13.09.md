# Match-details payload, patch 13.09 — captured shape

Fixture: `src/dev/fixtures/matches/real-13.09.json` (~693 KB, compact JSON).

## Provenance

- **What:** a real `GET pd.{shard}/match-details/v1/matches/{id}` response from the
  local Riot client, captured read-only on 2026-11-10.
- **Patch:** `release-13.09-shipping-18-5804228` (the live client version at capture).
- **Match:** one competitive game on Plummet, 28 rounds, 10 players, 207 kills.
- **Sanitized:** every account PUUID, Riot ID, party ID, the match ID and any IPs were
  replaced with deterministic placeholders (`10000000-…`, `90000000-…`,
  `PlayerN#NNNN`). Party IDs used as JSON *keys* (`matchInfo.partyRRPenalties`) were
  remapped too. No original identifier survives — verified by search.
- **Untouched:** structure, scores, damage, rounds, kills, coordinates, timings.

## Shape that matters

Top-level keys: `matchInfo, players, bots, coaches, teams, roundResults, matchMvp,
hasTempValues, kills`.

### `players[]` (10)

`subject` (placeholder PUUID), `gameName`/`tagLine` (placeholders), `platformInfo`,
`teamId`, `teamNumber`, `partyId` (placeholder), `characterId`, `stats`, `scores`,
`roundDamage`, `competitiveTier`, `accountLevel`, `sessionPlaytimeMinutes`,
`playerCard`, `playerTitle`, `premierPrestige`, `behaviorFactors`, …
`stats` = `{ score, roundsPlayed, kills, deaths, assists, TempValueA/B/C,
playtimeMillis, abilityCasts }`.

- `stats.score` is the match-total combat score — the field our ACS is computed from
  (`score ÷ roundsPlayed`). Fixture example: 5,147 / 28 = **183.8 ACS**.
- `TempValueA/B/C` are internal score components; do not surface them.
- Score range across the 10 players: 3,968–7,853.

### `roundResults[]` (28)

`roundNum, roundResult, roundCeremony, winningTeam, winningTeamRole,
firstBloodPlayer, plantRoundTime, plantPlayerLocations, plantLocation, plantSite,
defuseRoundTime, defusePlayerLocations, defuseLocation, playerStats, roundResultCode,
playerEconomies, playerScores`.

- `playerStats[]` (10 per round): `subject, kills, damage, score, economy, ability,
  wasAfk, wasPenalized, stayedInSpawn`.
  - `playerStats[].score` is **per-round** combat score (not ACS).
  - `kills` here is a list of kill events (subject-level), and `damage[]` carries
    `receiver`, `damage`, `headshots`, `bodyshots`, `legshots` per event.
- `plantSite` present on 14 of 28 rounds; `plantLocation` is `{x,y}` (0,0 when absent).
- `roundResults[]` does **not** contain a `kills` array — kill events live top-level.

### `kills[]` (207, top level)

`gameTime, roundTime, killer, victim, victimLocation, assistants, playerLocations,
finishingDamage, round`.

- `victimLocation` = `{x, y}` integers.
- `playerLocations[]` = per alive player at the moment:
  `{ subject, viewRadians, location: {x, y} }` (9 entries is normal).
- `finishingDamage` = `{ damageType, damageItem, isSecondaryFireMode }`.
- `round` is 0-based (0…27).
- Grouping for a round table = filter `kills[]` by `round`.

### Coordinates

Integers in **Unreal world units (centimetres)**, not normalised 0–1 and not screen
pixels. Fixture ranges: victim `x` −49,388…11,089, `y` 169…12,474; a plant at
`{x:7070,y:10983}`. Divide by 100 for metres; a minimap still needs a per-map
affine transform (map image bounds ↔ world bounds) that we do not have yet.

**Do not put these in any UI yet** — parser change + per-map transform first.

## Absent fields

There is **no** `performance`, `acs`, `mmr`, `rank` or "hidden rating" field at any
level. The only combat score is `score` (match and per-round). Riot's own scoreboard
label changed to Performance Score in 13.06, but the payload did not add a number:
the field we read is still `score`, and our `score ÷ rounds` is our own ACS.

## Using it in tests

```ts
import match from '../fixtures/matches/real-13.09.json';
// players: 10, rounds: 28, kills: 207
// match ACS: match.players[i].stats.score / stats.roundsPlayed
// per-round: roundResults[r].playerStats[].score
// kill events: kills.filter(k => k.round === r)
// coordinates: kills[].victimLocation / playerLocations[].location (cm)
```

Assertions should read only these fields; do not assert on `_meta`.
