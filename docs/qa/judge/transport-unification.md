# Judge prep — transport unification in `sources/riot.ts`

Prepared before ts-client lands the move. Run after the merge; server-only (dev mocks), PC optional.
Baseline today: **two transports** (`utils/tracker.ts:353`, `sources/riot.ts:126`), **13** `await riotGet(`
sites in tracker (lines 562, 697, 1087, 1261, 1494, 1933, 1938, 1950, 1953, 1985, 1991, 2240, 2341),
and the `sources/riot.ts` header claims **14** sites — a drift to fix in the same commit.

## A. Structural checks — one transport, one validation boundary

| # | Check | PASS means |
|---|---|---|
| A1 | `grep -rn "async function riotGet" src/` | exactly one hit: `src/sources/riot.ts`; tracker imports it. Repeat for `getEntitlements`, `clearEntitlements`, `resolveVersion`, `withRiotSlot`, `assertRiotOk`, `riotPut`, `riotPost`: one definition each, all in `sources/riot.ts`. |
| A2 | `grep -rn "await riotGet(" src/ \| grep -v "src/sources/riot.ts"` | empty. `grep -rn "riotGet(" src/utils/tracker.ts` empty except an import line. |
| A3 | Header ↔ count. `scripts/devqa-check.ts` must be **retargeted in the same commit**: "tracker keeps it private" becomes "tracker imports the one transport"; the header check still computes `rawSites` and now requires `rawSites === 0` **and** the header string "the ONLY place a raw"; the header's number must read 0/13, never 14. | devqa green, and the old assertion is not deleted to make it green. |
| A4 | Every read validated. `grep -n "Promise<any>" src/sources/riot.ts` empty; each exported reader returns `Validated<…>`; every reader calls `assertRiotOk` (or a shared validated wrapper) before parsing. | No reader can return a raw payload; `rankFromPayload`-style parsers accept only `Validated`. |
| A5 | Source parameter. `grep -rn "withOverwolfSource" src/` | one definition (`trn.ts:184`), one call (`trn.ts:963`); `grep -rn "source=overwolf-2" src/` appears only inside that function. |
| A6 | No credential anywhere. `grep -rniE "access_token\|entitlements\|password\|lockfile" src/` | only `invoke('local_entitlements')`, type names and comments; no literals. `git grep -nE "eyJ[A-Za-z0-9_-]{10,}"` empty; no `.env` tracked; no `TRN-Api-Key`. |
| A7 | Symbol diff before deletion: `getEntitlements`, `clearEntitlements`, `resolveVersion`, `withRiotSlot`, `assertRiotOk`, `riotGet`, `riotPut`, `riotPost`. | Every duplicate is byte-identical to tracker's original; any drift is reported as a bug, not reconciled silently. |
| A8 | One entitlement/version reader. `grep -rn "local_entitlements\|local_client_version" src/` | only `sources/riot.ts` invokes them. |
| A9 | Build and checks. `bun run build:ui`, `bun run lint`, every `scripts/*-check.ts`. `git diff --stat`. | All green; diff touches only the tracker transport block, `sources/riot.ts`, and the retargeted checks — nothing else. |
| A10 | Poll step (after this one). `grep -n "riotGet" src/live/poll.ts` | empty; the poll imports readers. Its order names → rank → fill is unchanged (assert the call order in a check). |

## B. Behaviour-change list — 13 sites, error payload must throw

For each: a Riot error payload currently produces an empty/short value (sometimes cached); after
conversion it must throw `RiotError`, the caller keeps last-known-good, and the UI shows a failed
read or stale data — never a smaller number, zero, or an empty list.

| # | Site today | Endpoint | Current on error | UI to verify after |
|---|---|---|---|---|
| 1 | `tracker.ts:562` | `/mmr/v1/players/{puuid}` (`fetchMmrDirect`) | already guarded; throws | profile keeps cached rank, never tier 0 |
| 2 | `:697` | `/mmr/.../competitiveupdates` | guarded; throws | trend/rows keep last-known or mark failed, not empty |
| 3 | `:1087` | routed `glz` loadouts (3 namespaces) | per-route catch, returns `[]` | only 404 may fall through; real error surfaces as failed loadout, not "no skins" |
| 4 | `:1261` | `/match-details/v1/matches/{id}` lite result | try/catch → `null` | never records a loss; shows unknown/failed |
| 5 | `:1494` | match-history paging (24h) | no guard → empty `History` → `0W-0L` | `failed: true` / stale, never `0W-0L` |
| 6 | `:1933` | `/core-game/v1/players/{puuid}` (+`coregame` fallback) | catch → phase idle | live game not shown as "waiting"; keep last phase or mark unknown |
| 7 | `:1938` | `/core-game/v1/matches/{id}` (+fallback) | catch → idle | same |
| 8 | `:1950` | `/pregame/v1/players/{puuid}` | catch → idle | same |
| 9 | `:1953` | `/pregame/v1/matches/{id}` | catch → idle | same |
| 10 | `:1985` | presence retry player | `.catch(() => null)` → idle | same |
| 11 | `:1991` | presence retry match | same | same |
| 12 | `:2240` | `/mmr/v1/players/{puuid}` per lobby row | guarded; per-player catch | stale last-known rank, never Unrated |
| 13 | `:2341` | match-history per player (party detection) | no guard → empty history → party collapse | keep last-known/unknown parties, not everyone solo |

Also verify **no error is cached**: after an injected 403, the per-player cache/localStorage entries
must not be written with `acs: null`/`tier: 0`/`wins: 0`; a retry must re-request.

## C. Runbook (server-only)

1. Start the Vite dev server, open the app in Brave (CDP), set `aspect_dev_mock_match = coregame`.
2. Inject a Riot error: `Page.addScriptToEvaluateOnNewDocument` stubs `window.__TAURI_INTERNALS__.invoke`
   so `riot_direct_get` returns `{"httpStatus":403,"errorCode":"SCHEDULED_DOWNTIME"}` (and a second run
   with `500`), then reload.
3. Walk: Live Match board, Overview profile, Matches, Agents/Maps, Pre-Picker, Store loadouts.
   Each must show failed/stale or last-known — never `Unrated`, `0W-0L`, an empty party board, or a
   vanished rank. Screenshot each surface.
4. Storage audit after the run: no cache entry gained from the error payload; `recon_live_rank_v1`
   keeps the previous rank; `recon_live_player_stats_v3` keeps `fetchedAt` and values.
5. If the PC is on, repeat the live protocol as a sanity check; the error injection above is the
   decisive test and does not need the game.

**Verdict line:** A1–A10 PASS/FAIL, B1–B13 PASS/FAIL with the surface screenshot or check output,
plus the no-error-cached assertion. Any FAIL names the file:line and the surface that showed a
smaller number.
