# Parity checklist — what is proven, and by what

Every row is a feature a user can reach, and the command that fails if it breaks.
"Proven" means a command exits non-zero when the thing stops working — not that it
looked fine once.

Run everything: `bun run verify` (build · lint · 22 script checks · pure-Rust tests
· bun tests) and `bun run uicheck` (every route, rendered in Chromium).

Current result: **`verify` PASS** and **`uicheck` 10/10 shipped routes pass**.
The legacy shell is still measured — `legacy fallback (?legacy=1): 9/10 — measured,
not shipped` — because it ships for one release as an escape hatch, and its known
Matches page is information rather than a regression in the app people run.

## Destinations (uicheck route → landmark)

| Surface | Reached by | Landmark asserted |
| --- | --- | --- |
| Now | bar, ⌘K | `EPISODE` / `RECENT MATCHES` |
| Matches | bar, ⌘K | `Match History` + 20 rows |
| Prep | bar, ⌘K | `Agents ·` / `Maps ·` |
| Store | ⌘K, menu, `#store` | `STORE` |
| Crosshair | ⌘K, menu, `#crosshair` | `CROSSHAIR` |
| Pre-Picker | ⌘K, menu, `#prepick` | `Map-Specific Agent Lineup` |
| Resolution | ⌘K, menu, `#resolution` | `Stretch` / `Native 16:9` |
| Riot Chat | ⌘K, menu, `#chat` | `Friends` / `Requests` / `Blocked` |
| Accounts | ⌘K, menu, `#accounts` | `ACCOUNTS` |
| Settings | ⌘K, menu | `Application Settings` |

`uicheck` also asserts, per route: no `ViewErrorBoundary`, no cell containing
`NaN` / `undefined` / `Infinity` / a bare `—`, and page height ≤ one viewport
except where a written reason allows otherwise.

## Behaviour with its own assertion

| Behaviour | Where it is pinned |
| --- | --- |
| Four-way KAST (kill OR assist OR survive OR traded) | `tests/advanced-stats.test.ts` against the real 13.09 capture: 4 / 6 / 14 traded, KAST 82.14 / 75 / 71.43 |
| Traded death = same round, teammate, ≤5 s, per death | same file: 5 000 ms yes, 5 001 no, adjacent round no, enemy avenger no, multi-death round counts once |
| One Escape owner per surface | `devqa-check.ts`: keydown counts per file; palette opens and closes without collapsing a row |
| Absent is absent | `devqa-check.ts` + `scripts/honesty-check.ts`: 27 checks banning every fabrication removed tonight |
| Write path validated + read back | `tests/crosshair-codec.test.ts`, `tests/storefront.test.ts` |
| TRN host/path allowlist, status mapping | `cargo test --manifest-path src-tauri/pure/Cargo.toml` (37 tests) |
| Updater ordering (`alpha9 < alpha10`) | same suite |
| One destination registry | `tests/nav.test.ts` — six anchors in sheet order, settings separate, unique ids, unmatched query → empty |
| One act selection shared by Now and Prep | `devqa-check.ts` |
| Rank-point movement over the recent games | `tests/rr-trend.test.ts` — net, W/L, best/worst, newest-20 cut, unpriceable games skipped, nothing priced ⇒ no strip at all |
| One destination registry | `tests/nav.test.ts` |

## Not proven, and why — do not read these as green

| Claim | Why it is unverified |
| --- | --- |
| The live lobby strip renders | The Tauri live path (`tracker.ts:1675`) is unreachable without a Windows client; the harness takes the preview branch, so the strip's slot renders nothing. First real match is its first test. |
| Crosshair read-back matches after a write | Type-checked only; needs a signed-in client to confirm GET-after-PUT. |
| Overlay HUD after the v2 flip | The overlay window loads `index.html#overlay` and is routed to the old tree (checked in `tauri.conf.json`), but no Windows run has exercised it since the flip. |
| Display facts (native resolution, refresh) | Marked UNVERIFIED in the UI when the read fails — by design, not a test. |
| Resolution section container count | 18 on the sheet vs 9 on the legacy route: the legacy route showed one tab of four, the sheet stacks all four. Different measurement, not a regression. |

## Player features added from the evidence pack

The research (`docs/v2/player-features.md`) ranked what players actually ask for
against what our read-only data can support. Both items at the top of that list
that were cheap and honest are in:

- **Advanced scoreboard** — KAST (corrected to four-way), ADR, traded deaths,
  first bloods, average loadout, each naming its derivation and each absent when
  the payload cannot support it (`tests/advanced-stats.test.ts`).
- **Rank-point movement** — net RR, W/L, best and worst over the last 20 ranked
  games, from the competitive-updates rows the app already fetched
  (`tests/rr-trend.test.ts`, rendered on Now).

Deliberately **not** added, with the reason: hidden MMR (no source), a "smurf
score" (a heuristic dressed as a verdict), a 0–1000 tracker score (someone else's
population formula), win probability (no validated model — a number would be
invented), minimaps/heatmaps (the payload carries kill coordinates in Unreal world
units, but our parser drops them and each map needs a transform).

## The two numbers that justify the rebuild

```
legacy matches  1825px tall   21 rounded bordered containers
v2 matches       900px tall    0
```

Everything else was already inside one viewport; Matches was the route that had
never been designed.
