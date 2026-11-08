# Riot local client: per-round data without Tracker Network

Captured 2026-11-09 ~00:50–00:55 (Africa/Cairo) on `Youssef-PC` (192.168.100.3), read-only.
Method: read `%LOCALAPPDATA%\Riot Games\Riot Client\Config\lockfile` (name:pid:port:password:protocol)
→ Basic auth `riot:{password}` on `https://127.0.0.1:{port}` → `GET /entitlements/v1/token`
(`accessToken` + `token`, the latter is the `X-Riot-Entitlements-JWT`) → remote GETs on
`pd.eu.a.pvp.net` with `X-Riot-ClientPlatform` (PC/Windows blob) and
`X-Riot-ClientVersion: release-13.09-shipping-18-5804228` (read from the newest
`%LOCALAPPDATA%\VALORANT\Saved\Logs\ShooterGame*.log`). No writes, no tokens stored, no secrets logged.

## Per-round data that EXISTS locally

`GET /match-details/v1/matches/{matchId}` — one competitive match, 18 rounds, 414,768 B JSON.

Top level: `matchInfo, players, bots, coaches, teams, roundResults, matchMvp, hasTempValues, kills`

- `matchInfo`: `matchId, mapId, gamePodId, gameLoopZone, gameServerAddress, gameVersion,
  gameLengthMillis, gameStartMillis, provisioningFlowID, isCompleted, isEarlyCompletion,
  customGameName, forcePostProcessing, queueID, gameMode, isRanked, isMatchSampled, seasonId,
  completionState, platformType, premierMatchInfo, partyRRPenalties, shouldMatchDisablePenalties,
  newMapLossReductionModifier, isReplayRecorded`
- `teams[]`: `teamId, won, roundsPlayed, roundsWon, numPoints, mvp, tempR`
- `players[]`: `subject, gameName, tagLine, platformInfo, teamId, teamNumber, partyId, characterId,
  stats, scores, roundDamage, competitiveTier, isObserver, playerCard, playerTitle, accountLevel,
  sessionPlaytimeMinutes, premierPrestige, behaviorFactors, newPlayerExperienceDetails,
  participationPeriods` — `stats` = `score, roundsPlayed, kills, deaths, assists, playtimeMillis,
  abilityCasts`; `roundDamage[]` = `round, receiver, damage`
- `roundResults[i]` scalars: `roundNum, roundResult, roundResultCode, roundCeremony, winningTeam,
  winningTeamRole, firstBloodPlayer, plantRoundTime, plantSite, defuseRoundTime,
  plantPlayerLocations, defusePlayerLocations`
  objects/arrays: `plantLocation, defuseLocation, playerStats, playerEconomies, playerScores`
- `roundResults[i].playerStats[j]`: `subject, kills[], damage[], score, economy, ability, wasAfk,
  wasPenalized, stayedInSpawn`
  - `kills[k]`: `gameTime, roundTime, killer, victim, victimLocation, assistants, playerLocations,
    finishingDamage{damageType, damageItem, isSecondaryFireMode}`
  - `damage[k]`: `receiver, damage, legshots, bodyshots, headshots`
  - `economy`: `loadoutValue, weapon, armor, remaining, spent`
  - `ability`: `grenadeEffects, ability1Effects, ability2Effects, ultimateEffects`
- `roundResults[i].playerEconomies[k]`: same economy fields; `playerScores[k]`: `subject, score`
- `kills[]` at match level: 116 entries, same kill shape **plus `round`**

Practical reading: per round you get the winning condition and side, first blood, plant/defuse
site + time + location, and for all 10 players their kills (weapon + assist names), damage events
with body-part hit counts, score, and full economy. Weapon usage is usable from
`economy.weapon` (loadout) and `finishingDamage.damageItem` (killing weapon).

## What is MISSING (compared to a TRN per-round view)

- No per-round assist rows — assists exist only as a match total plus `kill.assistants` names.
- No per-round headshot-kill flag; only hit counts (`damage[].headshots`) and
  `finishingDamage.damageType`/`damageItem`, whose values were not inspected (shape-only rule).
- No spike-carrier or objective progress per round; only site/time/location of the plant/defuse.
- No team economy totals — sum `loadoutValue` across `playerEconomies` yourself.
- No utility usage counts or ability damage attribution — `ability` is boolean effect flags only.
- `players[].scores` is obfuscated (`TempValueA..TempValueL`), not usable.
- `matchMvp` is a `Length` field, not an MVP subject.

## Depth of history

- `GET /match-history/v1/history/{puuid}?startIndex=0&endIndex=20` → `Total: 94`, 20 per page.
- Newest: 2026-11-08 02:25 · oldest: 2026-10-06 21:26 (last page 90–100 held 4 entries).
- All 94 entries are `queueID: competitive` (this player never queues unranked/deathmatch).
- **Live `core-game`: not captured.** `GET glz-eu-1.eu.a.pvp.net/core-game/v1/players/{puuid}` →
  HTTP 404 `RESOURCE_NOT_FOUND` (player idle, no VALORANT process at capture time). The host
  resolves and answers, so the endpoint exists, but its key set is unknown and is not guessed here.
  A capture during a live match is still needed for that half of the question.
