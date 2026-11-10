# riotGet → validated read conversion

Checklist for moving the 13 raw `riotGet` reads in `src/utils/tracker.ts` onto the
validated surface in `src/sources/riot.ts`. Owner: rust-proxy (analysis only —
the edits are ts-client step 2). Base: `tracker.ts` as of **75f16b4**.

## What "validated" means here

`riotGet` (`tracker.ts:353`) is the private raw transport. It returns `any` and —
this is the trap — **it does not throw on Riot error payloads**. A 403
`SCHEDULED_DOWNTIME`, a 404 or a 5xx arrives as a normal object whose `httpStatus`
/ `errorCode` fields the caller may or may not check. Every "error parsed as empty
data" bug in this file starts there.

`src/sources/riot.ts` validates:

- **Typed readers** — `readMmr`, `readMatchDetails`, `readLiveMatch`,
  `readPlayer24h`, `readHistoryMeta`, `readMatchHistoryPage`,
  `readMatchDetailsRaw`. They parse a model and validate before the parse.
- **`readRiotValidated(host, path)`** — validated transport, caller still parses.
  Correct only where no typed reader exists.

Both levels call `assertRiotOk` (`riot.ts:178`), which throws `RiotError` when
`errorCode` is set or `httpStatus >= 400`. A *successful* Riot payload carries no
`httpStatus`, so `status === 0` is normal — do not "fix" that.

Note: `tracker.ts:548` has a second, local `assertRiotOk` that throws a plain
`Error`. It is a duplicate of `riot.ts:178`; delete it only after the last raw
site is gone.

## Summary — 13 logical sites

15 `riotGet(` expressions; #6 and #7 are primary→fallback pairs on one logical
read. "Reader" is the real deliverable: does a typed reader exist today, is it
present but insufficient, or must one be written.

| # | line | endpoint | current behaviour on Riot error | with validated read | typed reader |
|---|------|----------|--------------------------------|---------------------|--------------|
| 1 | 562 | `/mmr/v1/players/{puuid}` (shard) | local `assertRiotOk` throws `Error`; transport errors throw; callers keep cache | throws `RiotError` (same catch surface) | **write** — `readMmr` only returns `LocalRank`, this site parses a full profile |
| 2 | 697 | `/mmr/v1/players/{puuid}/competitiveupdates` | local `assertRiotOk` throws; empty `Matches` → `[]` | throws `RiotError` | **write** — no reader for competitive-update rows |
| 3 | 1087 | loadout routes, pregame/coregame × 3 names | never throws: per-route `catch` + outer `catch` → `[]`; 404 is an expected phase miss | would throw on 404 unless the catch stays; same `[]` if kept | **write** — `readMatchLoadouts`, 404→null per route |
| 4 | 1261 | `/match-details/v1/matches/{matchId}` | `try/catch` → `null`; FFA/draw → `null` | `readMatchDetails` throws `RiotError`, caller catch → `null` | **exists** — `readMatchDetails` |
| 5 | 1494 | `/match-history/v1/history/{puuid}?start…` (5 pages) | outer catch → previous record + `failed: true` | `readMatchHistoryPage` throws `RiotError`, same catch | **exists but insufficient** — no `at` (`GameStartTime`); see decision record, recommend dedicated reader |
| 6 | 1933/1934 | `/core-game/v1/players/{puuid}` → `/coregame/…` | 404 payload has no `MatchID` → skip; transport error → fallback; both fail → outer catch → idle | throws on 404 → an exception on every menu tick unless the reader maps 404→null | **write** — `readLivePlayer(phase, puuid)`, 404→null |
| 7 | 1938/1939 | `/core-game/v1/matches/{id}` → `/coregame/…` | same; phase entered only when `!matchData.httpStatus` | validation replaces the `httpStatus` sniff | **write** — `readLiveMatchById(phase, matchId)`, 404→null |
| 8 | 1950 | `/pregame/v1/players/{puuid}` | 404 → no `MatchID` → skip; transport error → outer catch | same as #6 | **write** — `readLivePlayer('pregame', puuid)` |
| 9 | 1953 | `/pregame/v1/matches/{matchId}` | same as #7 | same as #7 | **write** — `readLiveMatchById('pregame', matchId)` |
| 10 | 1985/1988 | retry player, INGAME/PREGAME | `.catch(() => null)`; then last-good-state preservation | `readRiotValidated` + same `.catch` → identical | **escape hatch OK** (no reader needed) |
| 11 | 1991/1994 | retry match, INGAME/PREGAME | `.catch(() => null)` | same as #10 | **escape hatch OK** |
| 12 | 2240 | `/mmr/v1/players/{p}` (batch) | local `assertRiotOk` throws; catch keeps last-good + backoff | `readMmr(p, shard, parseLocalRank, seasonOrder)` throws `RiotError`; same backoff | **exists** — `readMmr`, `LocalRankRow` ≡ `LocalRank` |
| 13 | 2341 | `/match-history/v1/history/{puuid}?startIndex=0&endIndex=5` | `catch {}` → silent miss for party clustering | `readMatchHistoryPage(puuid, shard, 0, 5)` throws; same silent miss with a code | **exists** — `readMatchHistoryPage` (only ids are used) |

## Per-site notes

**1 — `fetchMmrDirect`.** Parses `LatestCompetitiveUpdate` + every
`QueueSkills.competitive.SeasonalInfoBySeasonID` row into `TrackerProfile` peaks,
then `assertRiotOk` (`tracker.ts:563`). The parse trusts `s?.NumberOfGames`,
`s?.CompetitiveTier`, `s?.Rank`, `s?.WinsByTier` and iterates them as `[string,
any]` — validated transport is not validated data here. `readMmr` cannot be used
because it forces the `LocalRank` shape. Either generalize `readMmr<T>(…, parse:
(j, order) => T)` or add `readMmrProfile`.

**2 — `fetchCompetitiveUpdates`.** `assertRiotOk` then `j?.Matches` mapped with
`g: any`. There is no reader for `/competitiveupdates`; a typed
`readCompetitiveUpdates` should return the mapped row (`tier`, `rr`, `change`,
`matchId`, `mapId`, `when`, `queueId`) so the TS never sees the raw fields.

**3 — `fetchMatchLoadouts`.** Deliberately never throws (`[]` on every miss) and
tries three endpoint spellings per phase; 404 is the expected wrong-namespace
answer. A validated read that throws on 404 would turn normal control flow into
exceptions. If converted, the reader must return `null` for 404 and the caller
keeps the route loop. Low value; do it last.

**4 — `fetchLiteMatchResult`.** `readMatchDetails(matchId, shard, parse)` fits
directly: parse builds `scores` from `teams[]` and the `1 | 0` row from
`players[]`, returning `null` for FFA/draw/no result. Still casts `teams`/
`players` elements as `any` — a typed match-detail model is a later step. Cache
write stays in the caller.

**5 — `fetchPlayer24hRecord`.** Pages 0–100 in steps of 20, needs
`GameStartTime` to stop at the 24h cutoff and to sort. `MatchHistoryRow` is
`{ id, queue }` only, so the typed reader cannot serve this today. Decision and
corrected cost: **Decision record — #5** below; the recommendation is the
dedicated reader, not widening the shared row.

**6/7/8/9 — live match probing.** These are the 404-as-control-flow sites. Today
a 404 payload is an object without `MatchID` (player routes) or with `httpStatus`
(match routes), so the code walks to the next phase. Any validated reader that
throws on 404 moves a normal "not in a match" tick onto the exception path (still
caught, but noisy and slower). The readers should mirror `readLiveMatch`'s
`httpStatus === 404 → null` rule. `/coregame/` (no hyphen) is a legacy alias Riot
still answers on some builds — keep the fallback ordering.

**10/11 — presence-driven retry.** These already `.catch(() => null)` and then
preserve `lastLiveMatchResult` when the phase cannot be confirmed. Convert with
`readRiotValidated` and keep the catch; the only gain is the `RiotError` code in
the log. Do not add a reader for this pair.

**12 — batch live rank.** The best fit: `parseLocalRank` already exists and is
the single parser for this payload (`riot.ts:406`), and `readMmr` wraps exactly
this endpoint. Today the site duplicates the guard — the comment at 2241 records
that this call *once* skipped `assertRiotOk` and produced the all-`Unrated`
board. Swap to `readMmr(p, shard, parseLocalRank, data.seasonOrder ?? [])` and
drop the local `assertRiotOk`; the last-good/backoff catch stays byte-identical.

**13 — party clustering recent matches.** Only `MatchID`s are needed, so
`readMatchHistoryPage(puuid, shardFor(region), 0, 5)` is sufficient; map
`rows.map(r => r.id.toLowerCase()).filter(Boolean)`. The `catch {}` should stay
(a failed party read must not fail the lobby), but the caught `RiotError` can be
traced instead of swallowed.

## Readers to write (in `src/sources/riot.ts`, same style)

### The no-match contract belongs in the signature

404 is **control flow**, not an error, at the live-probe and loadout sites
(#3, #6, #7, #8, #9). That fact must live in the type, not a comment: a shared
alias makes the contract visible at every call site and hard to "helpfully"
change into a throw later.

```ts
/** Riot said 404 — "nothing here", not "the read failed". Every other error
 *  (403/451/5xx included) throws RiotError. Only by-id lookups return this;
 *  list endpoints never return null. */
export type NoMatch<T> = Validated<T> | null;
```

```ts
// 1 — generic MMR payload (or generalize readMmr<T>)
export async function readMmrProfile<T>(
  puuid: string, shard: string,
  parse: (j: Validated<unknown>, seasonOrder: string[]) => T,
  seasonOrder: string[] = [],
): Promise<Validated<T>>

// 2 — competitive-update rows
export interface MmrUpdateRow { tier: string; rr: number; change: number;
  matchId: string; mapId: string; when: number; queueId: string }
export async function readCompetitiveUpdates(
  puuid: string, shard: string, count: number, queue: string,
): Promise<Validated<MmrUpdateRow[]>>

// 3 — loadouts: one route per call, no-match per route (caller keeps the
//     three-name loop and its per-route catch)
export async function readMatchLoadouts(
  host: string, route: string,
): Promise<NoMatch<unknown[]>>

// 6/8 — live player
export async function readLivePlayer(
  phase: 'pregame' | 'coregame', puuid: string,
): Promise<NoMatch<{ MatchID?: string }>>

// 7/9 — live match by id (caller keeps the legacy `/coregame/` fallback name)
export async function readLiveMatchById(
  phase: 'pregame' | 'coregame', matchId: string,
): Promise<NoMatch<unknown>>

// 5 — timestamped history page (see decision record; option B)
export type MatchHistoryTimeRow = MatchHistoryRow & { at: number };
export async function readHistoryPageWithTime(
  puuid: string, region: string, start: number, end: number,
): Promise<Validated<MatchHistoryTimeRow[]>>
```

Each reader checks `httpStatus === 404` **before** `assertRiotOk` and returns
`null` for it; every other error status throws `RiotError`; the parsed value is
wrapped in `validated()`. `readLiveMatch` already implements exactly this
contract — the new readers mirror it rather than reinvent it. `readLivePlayer`
and `readLiveMatchById` must also keep the 404 rule when the caller retries the
legacy `/coregame/` spelling: a 404 there is still "not in a match", never a
failure.

## Decision record — #5, the 24h record needs `GameStartTime`

**The choice:** extend the shared `MatchHistoryRow` with `at`, or add a
dedicated reader.

**Corrected cost of option A (extend the row):** the compile-level cost is lower
than the first draft claimed — `MatchHistoryRow` has **no object literals
anywhere** (only `riot.ts` constructs it; `src/live/actStats.ts:130` reads only
`id`/`queue`, and both scripts source-text match the call rather than the
shape). Adding `at: number` is two lines (`interface` + one field in
`readMatchHistoryPage`) and breaks no caller. The real cost is semantic: `at`
becomes part of a shared row type used by act-stats and the checks, with a
`GameStartTime ?? 0` fallback for rows that do not carry it — and the 24h pager
today treats a missing timestamp as the oldest possible row and stops paging.
Widening a shared type for one consumer also invites the next reader to assume
`at` is always meaningful.

**Cost of option B (dedicated reader):** ~20–25 lines: `MatchHistoryTimeRow =
MatchHistoryRow & { at: number }` plus `readHistoryPageWithTime`, with both
history readers delegating to one private `parseHistoryRows(j)` so the two
cannot drift. No shared type changes, no act-stats or script edits, and the
`GameStartTime ?? 0` semantics stay documented at the one caller that needs
them.

**Recommendation: B.** It keeps step 2 a pure swap for `tracker.ts`, adds no
cross-owner edit to `live/actStats.ts` or the check scripts, and keeps the
"timestamped row" contract local to the feature that needs it. A is only right
if a second consumer of `at` appears later — then fold the field into
`MatchHistoryRow` in its own commit.

**Acceptance criteria:** `readHistoryPageWithTime` returns
`Validated<MatchHistoryTimeRow[]>`; `at` is documented as `GameStartTime` with
`0` = unknown; the 24h pager keeps its current break rule (`oldest < cutoff`)
and its `failed: true` last-good catch; the scripts' `readMatchHistoryPage(`
text checks stay untouched.

## Suggested order for step 2

1. **One-line swaps, zero new code:** #12 (`readMmr`), #13
   (`readMatchHistoryPage`), #4 (`readMatchDetails`).
2. **Decision then swap:** #5 — the recommendation above is the dedicated
   reader; once `readHistoryPageWithTime` exists, the tracker site is a
   one-line swap.
3. **Escape-hatch batch:** #10, #11 (`readRiotValidated`, keep `.catch(() => null)`).
4. **Write readers then swap:** #6, #7, #8, #9 (404→null), #2 (typed rows),
   #1 (generic MMR payload).
5. **Last, optional:** #3 (loadouts; the catch loop is intentional).

## Behaviour change to expect (and to test)

- **User-visible outcomes should not change**: every site already has a catch or
  a phase fallback. What changes is *classification*: an error payload can no
  longer be mistaken for empty data, and the caught error carries a `RiotError`
  code instead of a message string.
- **#6/#7/#8/#9 are the regression risk**: if the new readers throw on 404, a
  menu-screen tick throws where it previously returned quietly. Test each phase
  transition (menus → agent select → in-game → menus) before and after.
- **#12 is the highest-value swap**: it protects the live rank board from the
  documented all-`Unrated` failure mode and deletes a duplicated guard.
- **#5**: a page that errors mid-way currently loses the whole read (outer catch)
  — that must stay true; do not "improve" it into partial results in the same
  commit.

## Deletion that follows step 2

When the last raw site is converted: delete `riotGet`'s `any` return path and the
local `assertRiotOk` (`tracker.ts:548`), keep the function private (its step-1
note at `tracker.ts:350` says exactly that), and let `readRiotValidated` be the
only door into the transport. That commit is tracker's "no raw reads left"
receipt — build it from the table above, not from grep.

## What an empty match row means (A23-1, settled)

An empty row means **there is no cached detail for this match** — not that the
read failed and not that the board is broken. The signed-out board shows 20
rows because the snapshot holds 20 games; the newest 9 have never been fetched,
so they are placeholders by design while the client is unreachable. The 11 with
a `recon_match_v7_*` entry carry real scores.

The log states it explicitly, which is the point:

```
[tracker] cached merge {"reason":"from-cache","ids":20,"ready":11}
```

`ids=20, ready=11` is the honest description: twenty rows known, eleven with
details. QA's first read sampled the top of the list (the 9 newest) and
concluded the whole board was empty; the fiber audit showed `rows=20 ·
withDetail=11 · cachedWithDetail=11`.

If you are chasing this again: read `ready` from that line before assuming a
render bug, and remember that the merge runs **before** any network attempt.
