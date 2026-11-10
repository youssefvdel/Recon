# Overview — Direction B spec (build this first)

Reference: `design/board-b.html`. This is the only surface in scope. Do not touch the HUD, Matches,
Live, the shell or the sidebar. Ship Overview behind the existing Tracker tab, stop, and let QA
screenshot it before anything else moves.

## What the page is now, and what it becomes

Current `Overview.tsx`: 815 lines, 8 bordered cards, 4 KPI tiles, a filter bar, 2 banner cards, a
shape-holding placeholder for every card, and 6 local components/helpers (`BodyFigure`, `shortAct`,
`pctLabel`, `BigTile`, `SmallStat`, `RiotClientNotice`). Target: one act header, one status line, one
match feed, one act-history list, no cards.

| Current container | Fate |
| --- | --- |
| Page header (`h2 Overview` + subtitle) | **Replaced** by the act header (eyebrow + record) |
| Playlist/Act filter bar with 11px labels above two dropdowns | **Replaced** by two inline text buttons on the act-header row; no labels, no card |
| Archived-TRN banner (`rounded-xl`) | **Replaced** by one 11px status line under the header |
| Riot-client notice (`rounded-xl`) | **Replaced** by the same status line stack (reason + Retry) |
| 4 × `BigTile` KPI cards (`rounded-2xl` + shadow) | **Replaced** by one inline metric row: Win% · K/D · HS% · ADR |
| Secondary stats card (`rounded-2xl`, 8 `SmallStat`) | **Replaced** by one Act detail block below the feed |
| Combat Highlights card | **Replaced** by one Act detail line (best kills, first kills/deaths, aces) |
| Top Agent card (role chip + 4-stat grid) | **Replaced** by one line in the act header (icon + agent + games + win%) |
| Accuracy card (`BodyFigure` + 3 hit rows) | **Replaced** by HS% in the metric row + head/body/legs in Act detail |
| Previous Acts card (3 emblem columns) | **Replaced** by act-history rows at the end of the feed |
| Tracker Score card (badge, score, 4 percentile columns) | **Deleted.** Tracker Score is retired; nothing replaces it |
| Every shape-holding placeholder (`—` slots, fake 44px badges, fake columns) | **Deleted.** Missing data is absent, never a shape |
| `BodyFigure`, `pctLabel`, `BigTile`, `SmallStat`, `RiotClientNotice` | **Deleted** |
| `shortAct` | **Keep exported** — `TrackerAgents`/`TrackerMaps` import it. Move to `utils/playerDisplay` in the Prep step |
| `useCountUp`, per-card `motion.section`/`rise` wrappers | **Deleted** from Overview; numbers render instantly |
| `StatValue` import and every dash/`0` fallback | **Deleted** from Overview |

## Layout (desktop, 940px column)

```
Episode 9 · Act 3 · Competitive                  Competitive ▾   Act 3 ▾
34–29   54%
Diamond 2 · 47 RR · 218 ACS · 1.24 K/D · 27% HS
Jett · 34 games · 54% win
[one status line: Riot Client closed — cached results · Retry]

Matches                                                           63
2h   Ascent   WIN 13–9    Jett 24/14/6 · 241 ACS   ▁▂▃… 22 bars   ›
1d   Haven    LOSS 11–13  Omen 18/17/9 · 196 ACS   ▁▂▃… 24 bars   ›
…

Act 2 · ended 6d ago
Diamond 1 · 42 games · 1.18 K/D
Act 1 · ended 41d ago
Platinum 3 · 38 games
```

- Container: `max-w-[940px] mx-auto w-full px-6 pt-6 pb-10 flex flex-col`.
- Act header: `pb-6 border-b border-m3-outline-subtle`.
- Feed rows: `grid grid-cols-[64px_minmax(0,1fr)_auto_14px] items-center gap-4 py-3.5 border-b border-m3-outline-subtle/60`.
- Act history: `grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-4 py-2.5 border-b border-m3-outline-subtle/50`.
- No `rounded-2xl`, no `rounded-3xl`, no `shadow-m3-1`, no `bg-m3-surface-container` container fills.
  The only radius on the page is the 1px on sparkline bars; no surface fill except the sparkline bars.

## Type scale (in-app floor: 11px)

| Element | Classes |
| --- | --- |
| Act eyebrow | `text-micro font-mono uppercase tracking-[0.18em] text-m3-outline` |
| Act record | `font-display font-black text-[46px] leading-none tracking-[-0.04em] text-m3-on-surface` |
| Win % | `font-mono text-xl text-m3-outline` (baseline beside the record) |
| Metric row | `mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-micro font-mono text-m3-on-surface-variant` |
| Rank/RR + top agent line | `mt-2 text-micro font-mono text-m3-outline` (agent icon 20px) |
| Status line | `mt-2 text-micro font-mono` + amber dot / Retry text button |
| Feed map | `font-display text-base font-bold text-m3-on-surface` |
| Verdict | `text-micro font-mono font-bold uppercase tracking-[0.14em]` mint/coral |
| Score | `font-mono text-lg tabular-nums` |
| Row sub | `text-micro font-mono text-m3-outline` |
| Act history | `text-xs` label, `text-micro font-mono` facts |

Spacing scale: 4 / 8 / 12 / 16 / 24 / 32 only. No gaps above 32 on this page.

## Data mapping (no invented fields)

| Display | Source |
| --- | --- |
| Act label | `seasonNames[profile.currentSeasonId] ?? 'Current Act'` |
| Record `W–L` | `S ? S.wins/S.losses : profile.wins / (profile.games − profile.wins)` for the current act; selected act uses `selStats` |
| Win % | `S.winPct`, else `profile.wins / profile.games`; **absent** if no games |
| Rank · RR | `profile.rank`; RR only when `profile.tier > 2` (an unranked 0 RR is not a value) |
| ACS | `S.acs` only (no `agg` field); absent if undefined |
| K/D · ADR | `S.kd ?? agg.kd`, `S.adr ?? agg.adr` |
| HS % | `S.hsPct` only |
| Top agent | `agents[0]` (`agent`, `matches`, `winPct`) + `agentInfo` icon; absent if no agents |
| Head/body/legs | `recentHit` (last ≤20 cached details) else `S.headHits/bodyHits/legHits`; absent if no hits |
| Feed rows | `games` sorted by `startedAt` desc, first 5: `map`, `result`, `scoreUs–scoreThem`, `agent`, `kills/deaths/assists`, `acs`, `startedAt` |
| Sparkline | `detailsById[g.id].rounds` + your team from `detailsById[g.id].players.find(p => p.puuid === profile.puuid)?.team`; if either missing, **no sparkline** (never a placeholder strip) |
| Act history | `profile.seasons` (`tier`, `games`), `seasonOrder` for order, `trnPrev[id].kd` optional; omit K/D when absent |
| Status | `trnStale` + `trnAsOfLabel`; `riotClient/riotClientDetail/clientClosed`; `selError` |

Rules:
- **Absent, not zero.** No `0`, no `—`, no ellipsis placeholders. If a value has no source, omit the
  segment and the separator that would precede it.
- **No per-day series.** Feed rows are individual matches; never draw a trend curve.
- **Signed out:** cached `profile`, `trn`, `trnPrev`, `trnAgents`, `detailsById` may render. Anything
  requiring the live client with no cache is absent. Do not invent an act record from nothing.
- Feed row click keeps opening the existing `MatchDetailModal` until the Matches step; do not build
  inline detail here.
- Selected past act: keep the existing fetch; while loading show no numbers (not zeros); on failure
  one 11px line with `selError` + Retry.

## Loading / empty

- `!profile` + client ok → `<Skeleton lines={3} />` from `components/primitives/Skeleton` (delete
  `OverviewSkeletons` import).
- `!profile` + client not ok → plain centred block: reason + Retry. No rounded card, no shadow.
- `profile` but no cached games → feed heading + one line `No matches cached — open Riot Client to refresh.`
  No card, no empty-state box.
- `profile` but no act stats → act header with record from profile; metric row only the fields that
  exist; no placeholder columns.

## Deletion checklist for this step

- Delete local components: `BodyFigure` (33–51), `pctLabel` (69), `BigTile` (71–101), `SmallStat`
  (103–110), `RiotClientNotice` (115–159). Keep `shortAct` exported.
- Delete imports only they used: `motion`, `useCountUp`, `ScoreBadge`, `scoreTier`, `gradeFor`,
  `tierColor`, `StatValue`, `OverviewSkeletons`, `Lock`, `Gamepad2`, card icons.
- Delete the 8 card sections, the 4-tile KPI grid, the filter labels, the two banner cards and every
  shape-holding placeholder block.
- Delete `rounded-2xl|rounded-3xl|shadow-m3-1|bg-m3-surface-container` from this file.
- Acceptance: `bun run build:ui` 0, `bun run lint` 0, all 20 scripts pass; `Overview.tsx` < 450 lines;
  `grep -E 'rounded-2xl|rounded-3xl|shadow-m3-1|StatValue' src/components/Overview.tsx` returns nothing;
  screenshot shows one focal record and no card borders; signed-out run shows no zeros and no dashes.

Stop after Overview. Matches (step 2) does not start until QA has seen the screenshot.
