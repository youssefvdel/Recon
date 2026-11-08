# Per-round data — how TRN does it, and whether Riot match-details is enough

Short answer: **yes.** Every per-round number TRN displays comes from data Riot's
`match-details/v1/matches/{id}` already returns. TRN's contribution is a normalised
segment model plus caching — not extra data. Recon already fetches that endpoint
(`src/utils/tracker.ts:1078`) and already parses rounds, kills and damage from it
(`:1267-1310`).

There are two round UIs, with different sources:

| UI | Window / chunk | Source |
| --- | --- | --- |
| In-game round timeline overlay (kills/deaths/headshots per round, live DMG/RND/DDΔ) | `windows/timeline.html` → `js/windows/Cw9odwNh.js` | **GEP live events**, accumulated in the background page |
| Post-match round table (per-player rounds, round result, damage, duels, economy) | `windows/desktop.html` → `js/windows/D4rg-gIm.js` (`RoundsTimeline`, `RoundWeaponsStats`, `EconomyHeading`) | **TRN backend match segments** (normalised Riot match-details) |

## 1. Live path — GEP → background state → overlay

The background service (`js/windows/BSj0SAG_.js`) keeps the session state that every
window reads. Round fields, in order of the handler:

```js
if (e.match_info.round_number) {
  if (!this.match.isRoundBased) return;
  this.round.id = Number(e.match_info.round_number);
  this.#h(); this.round.id !== 1 && this.#x(); return; }        // new round
if (e.match_info.team)      { this.round.sideId = e.match_info.team; ... }
if (e.match_info.round_phase) { this.round.phaseId = e.match_info.round_phase; return; }
if (e.match_info.round_report) {
  let t = JSON.parse(e.match_info.round_report),
      n = Number(t.headshot) + Number(t.final_headshot),
      r = Number(t.bodyshots), i = Number(t.legshots),
      a = Number(t.damage) + Number(t.ability_damage),
      o = Number(t.damage_received);
  this.match.isRoundBased
    ? (this.stats.headHits += n, this.stats.bodyHits += r, this.stats.legsHits += i,
       this.stats.damageDealt += a, this.stats.damageReceived += o)
    : (this.stats.headHits = n, ...); return; }
if (e.match_info.score) {                       // {"won":n,"lost":n}
  let t = JSON.parse(e.match_info.score),
      n = this.rounds.find(e => e.id === this.round.id);
  n && ((t.won > 0 || t.lost > 0) && (n.resultId = this.score.wins < t.won ? `victory` : `defeat`), ...);
  this.score.wins = t.won; this.score.losses = t.lost; return; }
if (!e.match_info.ui_team_order_allies && e.match_info.kill_feed) {
  let t = JSON.parse(e.match_info.kill_feed),        // attacker, victim, weapon, ult, headshot,
      ...                                            // assist1..4, is_attacker_teammate, is_victim_teammate
  this.#l(t.weapon); if (t.headshot) i.scoreboard.headshots++; a.scoreboard.deaths++;
  if (i && a) { i.duels?.[a.id] && i.duels[a.id].kills++; a.duels?.[i.id] && a.duels[i.id].deaths++; }
}
```

Round objects carry `{ id, sideId, phaseId, resultId, stats: { kills, deaths, assists,
headshots } }`. The overlay's `Round` component consumes exactly that:

```js
// js/windows/Cw9odwNh.js  (component `Round`)
kills:     Math.max(0, round.stats.kills - round.stats.headshots)
headshots: round.stats.headshots
deaths:    round.stats.deaths
result:    round.resultId        // used as a CSS class: victory / defeat
id:        round.id              // displayed, "OT" when isOvertime
```

and `MatchTimeline` computes layout purely client-side:

```js
maxRounds = { competitive/premier/unrated: 25, skirmish*: 19,
              swiftplay/replication/aros/retake: 9, spikerush: 7, default: 0 }[playlistId]
timeline = rounds + zero-padded rounds up to maxRounds, then .slice(-27)   // 27 cap
rounds1  = timeline.filter(r => r.id <= maxRounds / 2)                    // halves
rounds2  = timeline.filter(r => r.id >  maxRounds / 2)
isOvertime = maxRounds > 0 && r.id >= maxRounds
```

Stats bar: `Hits = headHits+bodyHits+legHits`; `Head Hit %`; round-based adds
`DMG = damageDealt`, `DMG/RND = damageDealt / roundsWithResult`,
`DDΔ/RND = (damageDealt − damageReceived) / roundsWithResult` (non-round-based divides by
rounds with deaths). Visibility: for `deathmatch`/`escalation` only during
`shopping`/`combat`; otherwise as soon as `rounds.length > 0`.

**This live path is fully known to Recon**: GEP `kill_feed`/`round_report`/`score`/`round_number`
are the same events we already read from the Riot client's log/presence, and the same
"rounds with kills/deaths/headshots" model can be accumulated from local match events.

## 2. Post-match path — TRN segments (and what they actually contain)

`js/Cu_khBDY.js`, method `fetchMatchDetails(matchId)`:

```js
let e = n.MATCHES + t;                        // https://api.tracker.network/api/v2/valorant/standard/matches/{matchId}
let r = { method: `GET`, headers: { "Content-Type": `application/json`, "TRN-API-Key": n.KEY } };
```

Response is `{ data: { metadata, segments[] } }`. The app maps **four segment types**:

| Segment type | Fields read | Mapped to |
| --- | --- | --- |
| `player-round` | `attributes.round`, `attributes.platformUserIdentifier`; `metadata.hasWon`, `teamId`, `teamSide`; `stats.kills`, `deaths`, `assists`, `headshots`, `remainingCredits`, `loadoutValue` | `player.rounds[]` (`{id, overtime, result, teamId, teamSide, stats}`) |
| `round-summary` | `attributes.round`; `stats.roundResult`, `stats.winningTeam` | `match.rounds[]` header (`{id, stats:{roundResult, winningTeam}}`) |
| `player-round-damage` | `attributes.round`; `metadata.platformInfo.platformUserIdentifier`, `metadata.opponentPlatformInfo…`; `stats.damage` | `rounds[].damageSummary[]` (`{player, opponent, stats.damage}`) |
| `player-round-kills` | `attributes.round`; `metadata.gameTime`, `roundTime`, `finishingDamage.{damageType,damageItem}`, `weaponName`, `platformInfo`, `opponentPlatformInfo`, `playerLocations`, `opponentLocation`; `stats.damage` | `duelsSummary` + `player.kills[]` (`{type, time, round, weapon, ability, stats.damage, victim}`) |

Kill distance is computed client-side, not supplied:

```js
let a = t.metadata.playerLocations.find(e => e.platformUserIdentifier === n)?.location,
    o = t.metadata.opponentLocation;
let c = a && o ? Math.sqrt((a.x-o.x)**2 + (a.y-o.y)**2) * .01 : null;   // metres
```

Overtime flag: `attributes.round >= data.metadata.modeMaxRounds`.
Duels are aggregated per `(player:::opponent)` with `killedOpponent`, `opponentDeaths`,
`killDistanceInMeters`.

**What TRN does *not* show per round:** plants/defuses are not in the round model. The
only plant/defuse handling in the whole app is *aggregate* profile stats
(`stats.plants`, `plantsPerRound`, `stats.defuses`, `defusesPerRound`,
`defusesPerMatch` in `Cu_khBDY.js`). There is no per-round bomb-site/plant timeline in the
package.

## 3. Does Riot `match-details/v1` supply all of it? — field by field

Riot schema (`valapidocs.techchrism.me/endpoint/match-details`, verified) for each
`roundResults[]`:

- `roundNum`, `roundResult` (`Eliminated | Bomb detonated | Bomb defused | Surrendered |
  Round timer expired`), `roundCeremony`, `winningTeam`
- `bombPlanter`, `bombDefuser`, `plantRoundTime`, `plantPlayerLocations`, `plantLocation`,
  `plantSite`, `defuseRoundTime`, `defusePlayerLocations`, `defuseLocation`
- `playerStats[]`: `subject`; `kills[]` (`gameTime`, `roundTime`, `killer`, `victim`,
  `victimLocation`, `assistants[]`, `playerLocations[]`,
  `finishingDamage.{damageType,damageItem,isSecondaryFireMode}`); `damage[]`
  (`receiver`, `damage`, `legshots`, `bodyshots`, `headshots`); `score`;
  `economy.{loadoutValue,weapon,armor,remaining,spent}`; `ability`;
  `wasAfk`, `wasPenalized`, `stayedInSpawn`
- `playerEconomies[]`, `playerScores[]`
- plus a top-level `kills[]` array carrying `round`.

| TRN field | Riot match-details source | Derivable? |
| --- | --- | --- |
| `player-round.stats.kills` | count `playerStats[].kills[]` where `killer === subject` for that round | ✅ direct |
| `player-round.stats.deaths` | count `kills[]` where `victim === subject` (invert) | ✅ direct |
| `player-round.stats.assists` | count `kills[]` where `subject ∈ assistants[]` | ✅ direct |
| `player-round.stats.headshots` | `damage[]` headshots for that round (per-shot matrices) | ✅ direct |
| `player-round.stats.remainingCredits` | `economy.remaining` | ✅ direct |
| `player-round.stats.loadoutValue` | `economy.loadoutValue` | ✅ direct |
| `player-round.metadata.hasWon/teamId/teamSide` | `winningTeam` + `players[].teamId` | ✅ direct |
| `round-summary.stats.roundResult` | `roundResult` / `roundResultCode` | ✅ direct |
| `round-summary.stats.winningTeam` | `winningTeam` | ✅ direct |
| `damageSummary[]` (player→opponent damage) | `playerStats[].damage[]` (`receiver`, `damage`) or `players[].roundDamage[]` | ✅ direct |
| `duelsSummary`: kill pairs, `gameTime`, `roundTime`, weapon, `finishingDamage` | `kills[]`: `killer`, `victim`, `gameTime`, `roundTime`, `finishingDamage`, `assistants` | ✅ direct |
| `killDistanceInMeters` | `playerLocations[]` + `victimLocation`, same formula ×0.01 | ✅ direct |
| plants/defuses per round | `bombPlanter`, `bombDefuser`, `plantSite`, `plantRoundTime`, `defuseRoundTime` | ✅ **better than TRN** (Riot has them; TRN's round table does not show them) |
| per-kill exact `stats.damage` | not in the kill entry itself; derivable by joining `damage[]` per round/receiver | ⚠️ approximate join |
| `player.rounds[].overtime` | `roundNum >= matchInfo` mode max (playlist table is client-side) | ✅ computed |

So the **entire TRN round table is reconstructable from one Riot call**, plus a playlist
max-rounds table (already written above) and a small aggregation layer. Recon already
parses `roundResults` (`winningTeam`, `roundResult`, `roundCeremony`) and `kills[]`
(`killer`, `victim`, `roundTime`, `finishingDamage.damageItem`, `assistants`) — the
missing pieces are the per-round per-player counters and economy, which sit in the same
payload.

## 4. Recommended Recon implementation (no TRN)

1. One cached `match-details/v1/matches/{id}` fetch (immutable, already the pattern in
   `fetchMatchDetailDirect`).
2. Build `rounds[]` from `roundResults`: `{round, result: roundResultCode, winningTeam,
   planter, defuser, plantSite, plantTime, defuseTime}`.
3. Build `playerRounds[puuid][round]`: count kills/deaths/assists from
   `roundResults[].playerStats[].kills[]`, sum `damage[]` for damage + headshots, copy
   `economy.{remaining,loadoutValue}`.
4. Build `kills[]` (already done) and compute duels + distance if desired:
   `sqrt((x1−x2)²+(y1−y2)²)*0.01`.
5. Render a timeline: playlist max rounds, halves, OT flag, DMG/RND and DDΔ/RND from the
   sums. All UI-only, no network.

## 5. Off-limits

- The hardcoded `TRN-API-Key` (do not use, do not ship, do not redistribute).
- `ow-bulk-lookup`, `insights`, `privacy`, `premier/roster` and the Socket.IO topics —
  private/undocumented routes of another company.
- TRN's assets/branding/UI files: ideas (timeline layout, metric definitions) are
  reusable; the files are not.
