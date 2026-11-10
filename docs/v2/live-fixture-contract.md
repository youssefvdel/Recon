# Live-lobby fixture contract (what the strip actually needs)

Sources, in order of authority:

1. **Code paths** — `src/components/live/useLiveLobby.ts`, `src/utils/tracker.ts`
   (`fetchLiveMatchState`), `src/sources/riot.ts` (`readLivePlayer`, `readLiveMatchById`,
   `getEntitlements`), `src/sources/gameData.ts`, `src/types.ts` (`LiveMatchState`,
   `LiveMatchPlayer`).
2. **Recorded log lines** from the live PC (alpha30 run 2026-11-10 06:37–06:56; alpha32 launch
   12:44) — quoted verbatim in §4.
3. The harness fixtures that already exist (`Recon-live/src/dev/fixtures/tracker.ts`,
   `liveStateFixture()`).

**Honesty note.** No VALORANT match ran while logging was enabled on alpha25–alpha32, so the
*wire* payloads of `/core-game/v1/matches/...` and `/pregame/v1/matches/...` were never captured.
Field **names** below come from the parser that consumes them; **values** are synthetic. Anything
unknown is marked **not recorded** rather than filled in.

## 1. Command sequence of one poll

`useLiveLobby` starts from `peekLiveMatchState()` (seeded cache), then:

| # | Call | Args | Notes |
| --- | --- | --- | --- |
| 0 | `fetchLiveMatchState(undefined, true)` | `forceRefresh=true` | first load; **skips** the 1 s dedup and the cached-state early-return |
| 1 | `invoke('local_entitlements')` | – | `{access_token, entitlements, puuid}`; cached 5 min on success; a throw ends the whole fetch |
| 2 | region | – | decode JWT `pp.c` from `access_token`; else `aspect_tracker_shard` (7 d); else `eu` |
| 3 | `gameData()` | – | **no IPC**: `fetch` to valorant-api.com, cached 30 d under `aspect_game_data_v3` |
| 4 | `invoke('local_presences')` | – | queue id from `matchPresenceData.sessionLoopState` (`PREGAME`/`INGAME`) + `queueId` |
| 5 | `invoke('riot_direct_get')` | `{host: 'glz-eu-1.eu.a.pvp.net', path: '/core-game/v1/players/<puuid>', accessToken, entitlements, clientPlatform, clientVersion}` | `{MatchID}`; 404 → `null` (not a match); other errors throw |
| 6 | `invoke('riot_direct_get')` | same host, `/core-game/v1/matches/<matchId>` | payload; 404 → `null`; legacy `/coregame/...` retry exists after a 404 |
| 7 | `invoke('riot_direct_get')` | `/pregame/v1/players/<puuid>`, then `/pregame/v1/matches/<id>` | only when step 5–6 produced no phase |
| 8 | `invoke('local_presences')` again | – | party ids, live Riot IDs, ally/enemy score (`private` blob base64) |
| 9 | `invoke('riot_local_namesets')`, `invoke('riot_resolve_names')` | puuids | names; a miss falls back to "Player N" |
| 10 | `invoke('riot_direct_get')` on `pd.eu.a.pvp.net` | `/mmr/v1/players/<puuid>` | only for players not cached <15 min, in chunks of 4 |
| 11 | write `recon_live_match_state_v2` = `{at, state}` and `emit('recon:live-match-sync', state)` | – | newest-execution-wins guard before writing |

Retries/back-off that are in the code and visible in logs: entitlement failures are logged at most
once per 60 s (`ENT_FAIL_LOG_WINDOW_MS`); a *failed* probe (throw) never declares idle — it keeps
the last live state for up to **10 min** (`LIVE_MATCH_FAILED_PROBE_KEEP_MS`); the 3 s poll is
skipped while the tab is hidden and fires immediately on focus/visibility change.

## 2. What makes the hook report idle vs live

- **live** requires both: `readLivePlayer` returns a non-empty `MatchID` **and**
  `readLiveMatchById` returns a payload **without** an `httpStatus` field. `phase` is set to
  `coregame` first, `pregame` only if coregame stayed idle.
- **idle** when: entitlements throw / no `access_token` (returns
  `{...idleState, error: String(err)}`, and does **not** write the cache); Riot answers 404 on the
  player or match route (treated as `null`, i.e. "nothing here"); payload carries `httpStatus`.
- The UI predicate is stricter than the fetch: `isLive` also requires
  `!isPreviousMatch` and `blueTeam.length + redTeam.length > 0`
  (`src/hooks/useLiveMatchActive.ts:8-13`, `src/components/live/LiveStrip.tsx`).
- **Populated → null**: a Riot 404 after a populated state is the only path that drops to idle, and
  only after a presence check (`local_presences`) fails to show `INGAME`/`PREGAME`. A *failed* read
  keeps the old board for 10 min. **Recorded instance: not recorded** — no match ran.

## 3. Timings

| Thing | Value | Status |
| --- | --- | --- |
| Intended lobby poll | **3000 ms** (`useLiveLobby.ts:102`) | code |
| Poll when tab hidden | none; immediate poll on focus/visibilitychange (`:88-95`) | code |
| Same-state dedup | <1000 ms returns last result | code |
| Entitlements cache | 5 min on success (`riot.ts:105`) | code |
| Failed-probe keep | 10 min (`tracker.ts:1463`) | code |
| Entitlement failure lines observed | **60–90 s apart** (06:37:52→06:38:52→06:39:52→06:41:22→06:42:52→06:43:52→06:45:22→06:46:52→06:47:52→06:49:22→06:50:22) | recorded |
| glz probe attempts observed | 06:52:20 → 06:55:13 (**173 s**) → 06:56:16 (**63 s**) | recorded |
| Client detected → first populated lobby | — | **not recorded** (no match) |
| 3 s cadence observed | — | **not observed**: both logged runs were tray-only (main window hidden), where the live surface was not mounted, so the interval never ran at 3 s |

## 4. Recorded log evidence (verbatim, timestamps local)

```
06:52:20.549 warn [riot] read failed {"host":"glz-eu-1.eu.a.pvp.net","path":"/core-game/v1/players/:uuid","status":404,"kind":"RESOURCE_NOT_FOUND"}
06:52:20.707 warn [riot] read failed {"host":"glz-eu-1.eu.a.pvp.net","path":"/coregame/v1/players/:uuid","status":0,"kind":"transport"}
06:52:20.967 warn [riot] read failed {"host":"glz-eu-1.eu.a.pvp.net","path":"/pregame/v1/players/:uuid","status":404,"kind":"RESOURCE_NOT_FOUND"}
06:55:13.518 / 06:55:13.705  same trio (core-game 404, /coregame transport, then pregame at 06:56:34)
06:56:16.052 / 06:56:34.633  core-game 404 + /coregame transport + pregame 404
12:44:05.569 warn [riot] entitlements failed {"kind":"Riot Client not responding — launch it and retry."}
12:44:07.616 warn [tracker] detail unavailable (signed out) {"host":"pd.eu.a.pvp.net","path":"/match-details/v1/matches/:uuid"}
```

Read: a 404 on `/core-game/...` is Riot saying "no match", and the reader then tries the legacy
`/coregame/...` spelling, which fails as `status 0 / transport` (wrong route, not a 404). The
pregame 404 confirms the idle path. A signed-out client never gets past entitlements.

## 5. Fixture per phase

The mock must be **arg-aware** (`invoke(cmd, args)`), not a flat command table: the harness today
answers `riot_direct_get` with a blanket 404 and throws for entitlement commands, which is exactly
why the strip resolves idle.

### Common answers (all phases)

```json
// invoke('local_entitlements')
{"access_token":"<any JWT-shaped string with pp.c=eu>","entitlements":"<jwt>","puuid":"11111111-2222-3333-4444-555555555555"}
// invoke('local_client_version')
"release-13.09-shipping-18-5804228"
// invoke('local_presences')  — string containing JSON
{"presences":[{"puuid":"11111111-2222-3333-4444-555555555555","game_name":"Youssef","game_tag":"EUW","private":"<base64 of {\"matchPresenceData\":{\"sessionLoopState\":\"PREGAME|INGAME\",\"queueId\":\"competitive\",\"partyOwnerMatchScoreAllyTeam\":6,\"partyOwnerMatchScoreEnemyTeam\":4},\"partyId\":\"party-1\"}>"}]}
```

### Phase A — pregame (agent select)

Wire answers:
```json
// /core-game/v1/players/<puuid>      -> {"httpStatus":404,"errorCode":"RESOURCE_NOT_FOUND"}
// /pregame/v1/players/<puuid>        -> {"MatchID":"b2f0c1d2-0000-4000-8000-000000000001"}
// /pregame/v1/matches/<MatchID>      -> {"MatchID":"...0001","MapID":"/Game/Maps/Ascent/Ascent",
//     "ModeID":"/Game/GameModes/Bomb/BombGameMode.BombGameMode_C","QueueID":"competitive",
//     "Teams":[{"TeamID":"Blue","Players":[{"Subject":"<puuid>","CharacterID":"<agent-uuid>","CharacterSelectionState":"selected","PlayerIdentity":{"AccountLevel":214,"PlayerCardID":"","Incognito":false,"partyId":"party-1"}}]}]}
```
Post-parse state (what the strip renders — any `LiveMatchState` with these fields):
```json
{"phase":"pregame","matchId":"...0001","mapId":"ascent","mapName":"Ascent","mode":"Competitive",
 "isDeathmatch":false,"queueId":"competitive","startingSide":"Defense","allyScore":0,"enemyScore":0,
 "blueTeam":[{"puuid":"<puuid>","name":"Youssef","tag":"EUW","team":"Blue","agentName":"Jett",
   "selectionState":"selected","tier":20,"rank":"Diamond 2","rr":47,"isMe":true,"partyId":"party-1"}],
 "redTeam":[], "updatedAt": 1794307440000}
```
Note: pregame often has **allies only** (`AllyTeam`); `EnemyTeam` is populated in custom games. A
strip that requires 10 players will look empty in normal agent select — that is real behaviour, not
a fixture bug.

### Phase B — coregame (in match)

```json
// /core-game/v1/players/<puuid> -> {"MatchID":"...0002"}
// /core-game/v1/matches/<MatchID> -> {"MatchID":"...0002","MapID":"/Game/Maps/Ascent/Ascent",
//   "ModeID":"/Game/GameModes/Bomb/BombGameMode.BombGameMode_C","GamePodID":"aresriot.aws-euc1-prod.eu-gp-frankfurt-1",
//   "Players":[{"Subject":"<puuid>","TeamID":"Blue","CharacterID":"<agent-uuid>",
//     "PlayerIdentity":{"AccountLevel":214,"PlayerCardID":"","Incognito":false,"partyId":"party-1"}}]}
```
Post-parse state: same shape as `liveStateFixture()` already in the harness
(`Recon-live/src/dev/fixtures/tracker.ts`, `phase:"coregame"`, 5 blue + 5 red, `allyScore`/`enemyScore`
from presence, `serverName:"Frankfurt"`).

### Phase C — previous match

No live IPC at all. `peekLiveMatchState()` falls back to `getLastActiveMatch()`
(`recon_last_active_match_v1`) and returns `{...lastActive, isPreviousMatch:true}`; the strip shows
"Last match" and `useLiveMatchActive` stays false. Seed a `LiveMatchState` with `phase:"coregame"`,
the real `matchId`/`mapId`, both teams, `updatedAt` within 6 h, plus `isPreviousMatch:true`.

## 6. Why the strip shows idle today, and the smallest fix

- `useLiveLobby` mounts with the seeded state, then immediately calls
  `fetchLiveMatchState(undefined, true)`. **`forceRefresh=true` deliberately bypasses both the
  seeded-cache return and the 1 s dedup**, so the seeded `recon_live_match_state_v2` is never used
  by that first call.
- In the harness, `invoke('local_entitlements')` is unknown → returns `null` → `getEntitlements()`
  throws → the outer catch returns `{...idleState, error}` → `setState(idle)` replaces the seeded
  lobby. `localStorage` still holds the fixture; only React state lost it.
- Fix A (fixture, preferred): answer `local_entitlements`, `local_client_version`,
  `local_presences`, and route `riot_direct_get` by host+path as in §5. Then the real pipeline
  produces `pregame`/`coregame` from the fixture.
- Fix B (hook, defence in depth): when the forced fetch resolves with `phase:"idle"` **and**
  `error` set, keep the seeded state instead of replacing it — an unreachable client is not
  "no match". This also protects production from the same first-paint wipe.

## 7. Explicitly not recorded

- Wire payloads of `core-game/v1/matches/*` and `pregame/v1/matches/*` (no match ran while logging
  existed). Field names in §5 are the parser's contract, not a capture.
- Client-detected → first-populated-lobby latency.
- A populated→idle transition with timestamps (and therefore the real cause in the field).
- Presence `private` blob contents (only the field names the parser reads are known).
