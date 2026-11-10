# Next session — finish the data layer

Written at the end of the 2026-11-09 refactor, at the point where the last piece
was deliberately not started. `tracker.ts` is 2810 lines; the live layer is out.

## Where it stands

```
src/live/     actStats · fill · fillPolicy · lobbyScope · merge · playerStats
src/sources/  gameData · matchDetails · presence · riot
```

Everything is moves-only and byte-identical, every module re-exports what it
used to own, and all 20 `scripts/*-check.ts` pass. `sources/riot.ts` owns the
*validated* reads. It does **not** yet own the transport.

## Read this as "unfinished", not "wrong"

`sources/riot.ts` currently carries a **duplicate** transport — its own copy of
`getEntitlements` / `withRiotSlot` / `riotGet` — while `utils/tracker.ts` keeps
the original and its **13 raw `riotGet(` call sites**. The header of
`sources/riot.ts` says so in writing, and a check asserts that it may not claim
to be the only place a raw payload exists while those 13 sites remain. That
check flips automatically when the count reaches zero, so the header must be
upgraded in the same commit that deletes the last one.

This duplication is why the poll did not move: `fetchLiveMatchStateInner` calls
`riotGet` directly ten times, so it is a raw poller, not an orchestrator.

## The three steps, and why the order is forced

**1. Unify the transport in `sources/riot.ts`.**
Move `getEntitlements`, `clearEntitlements`, `resolveVersion`, `withRiotSlot`,
`assertRiotOk`, `riotGet`, `riotPut`, `riotPost` out of tracker; delete the
duplicate in `sources/riot.ts`; tracker imports the one implementation.
*Touches:* tracker's transport block (~250 lines) and `sources/riot.ts`.
*Behaviour:* none — the two copies are the same code today.
*Pass first:* list every symbol in the duplicate and diff it against tracker's
original; they were typed from the same source but drifted nowhere that a diff
will not show. Any difference is a bug to report, not to reconcile silently.

**2. Convert the 13 raw call sites to validated readers.**
Grouped by endpoint, all in tracker:

| endpoint | sites | reader |
| --- | --- | --- |
| `/mmr/v1/players/{puuid}` | 2 | `rankFromPayload` via `fetchLocalRank` |
| `/match-details/v1/matches/{id}` | 2 | `readMatchDetailsRaw` |
| `/core-game/v1/players/{puuid}` | 1 | new `readLivePlayer` |
| `/core-game/v1/matches/{id}` | 2 | new `readLiveMatchById` |
| `/pregame/v1/players/{puuid}` | 1 | same reader, pregame |
| `/pregame/v1/matches/{id}` | 1 | same reader, pregame |
| match history pages | 2 | `readMatchHistoryPage` (exists) |
| routed `glz` calls | 2 | decide: typed reader per route |

*Behaviour change, and every one of them must be listed in the commit:* a Riot
error payload currently parses into an empty result (0 matches, empty roster,
no rank) and is sometimes **cached**. After this step each one throws
`RiotError`, the caller's existing catch keeps the last-known-good value, and
the UI shows a failed read rather than a smaller number. The same rule as
`local-failed` in act stats — a failed read is not incomplete data.
*Pass first:* for each of the 13, write down what the current code does with an
error payload and what the UI shows afterwards.

*Done after the swaps:* `assertRiotOk` now throws `RiotError` with the same
message text the checks already match (`Riot <what> unavailable (<code>)...`), and
`.code` carries the `errorCode` or `HTTP <status>`. No caller string-matches that
message, so `.code` adoption stays available rather than forced; the message text
is the compatibility contract and must not change without retargeting the checks.

**3. Move the poll to `live/poll.ts`.**
`fetchLiveMatchState`, `fetchLiveMatchStateInner` and the enrichment
orchestration. With the transport gone from tracker this is a normal move.
*Pass first:* the write-site pass from the fill move — the poll writes
`setTrnMatchPhase`, `setTrnLobbyKey`, `setLiveSnapshotMatch` and calls the three
fill accessors; confirm each is a call, not an assignment to an imported
binding.
*Assertion to add:* the poll must keep its order — names before rank before
fill — because the fill reads what the earlier steps wrote.

## Write path — the remaining raw PUT/POST surface

GET is validated end to end; `riotPut`/`riotPost` are still exported and called
raw. The call sites are pinned by devqa (file + function + count), so this list can
only change deliberately:

- `src/utils/crosshair.ts:639` — `riotPut(host, '/playerPref/v3/savePreference', payload)`
- **Converted:** `src/utils/prepick.ts` → `riotPostValidated`; `src/utils/store.ts`
  → `readStorefront`. The devqa pin now lists only the crosshair PUT.

A validated write means **two** validations, not one:

1. **Before send** — the payload comes from a typed builder and is refused unless it
   matches what the route accepts (non-empty ids, expected envelope, size cap). A
   bad write is worse than a failed one: it persists.
2. **After send** — `assertRiotOk` on the response, then a check of the success
   shape the route promises. Never report success from a 200 alone.

No retries for writes: a call that failed may already have landed.

### Per site

**1. `prepick.ts` — converted.** POST, no body, fire-and-forget. `matchId` and
`agentId` are validated as UUIDs before they are interpolated into the path (a
path-injection guard as much as a correctness one), the call goes through
`riotPostValidated` (which runs `assertRiotOk` after the send), and the silent
`.catch(() => {})` stays — a failed hover is not user-facing. The devqa pin
shrinking by one site is the receipt.

**2. `store.ts` — converted.** A read-shaped POST (empty body) whose response is
the shop. `readStorefront(puuid, host)` validates the transport (`assertRiotOk`)
and requires at least one of `SkinsPanelLayout` / `AccessoryStore` /
`FeaturedBundle`, so an error payload or a non-shop shape throws instead of
parsing into an empty store and overwriting the cache. The caller's existing
catch still returns the memory/localStorage snapshot, so a failed read keeps the
last known shop. The deep offer model stays with the caller for now.

**3. `crosshair.ts:639` — convert last, with read-back.** A true write: deflated
`Ares.PlayerSettings` envelope, response must be `{ data: string }`, and a wrong
payload silently overwrites the player's preferences. Conversion: typed payload
builder (validate `type`, non-empty deflate, size cap) before send; `assertRiotOk`
+ envelope check after; on success read the preference back and compare before
reporting `true`. Keep the 30 s timeout race and the `catch → false` contract.

### Order and receipts

Only the crosshair PUT remains: a real write with a deflated payload and a
read-back requirement, so it gets its own session. Each is its own commit, with the devqa pin updated in the same
write; the pin's expected list shrinking is the receipt that raw writes converted.

## Rules that carried this refactor and should carry the next one

- One seam per commit, moves only, bodies byte-identical; a bug gets its own
  commit with its own check.
- If a check greps the old location, retarget it **in the same write** — a
  split that turns a check red is reverted, never "fixed forward".
- Write the dependency/write-site pass down **before** the move. Twice tonight
  that pass changed the plan for the better, and once it caught a hole that
  would have cost a retry.
- A move that has to land as three writes leaves the tree broken in between.
  One write per move, build immediately after.

## Checks that must stay green

`bun run build:ui`, `bun run lint`, every `scripts/*-check.ts` (20 today), and
the header↔call-site assertion in `scripts/devqa-check.ts`.
