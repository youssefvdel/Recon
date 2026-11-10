# Prep — Direction B spec (step 4)

One route, two sections, no sub-tabs: **Agents** then **Maps**, stacked in the same 940px column/pagescroll.
This step moves surfaces; it does not change the numbers they compute. Every current column and expanded
metric is listed below with the field it keeps. The few values that were never data are named and dropped.

## Route and controls

- Replace the `agents` + `maps` destinations with one `prep` destination. `TrackerSubTab` = `overview |
  matches | prep`; `TABS` loses `Agents`/`Maps` and gains `Prep`. No tab strip inside Prep.
- Page header: `Prep` 20px Outfit 800; under it two section headings (`AGENTS · 12`, `MAPS · 7`) in 11px
  mono, hairline under each. No count pills, no subtitle.
- **One act selector.** The existing `CustomDropdown` (same options: Current act / All acts / past acts)
  is lifted once into the Prep header, top-right, at the anchor the old per-page controls occupied. Both
  sections read the same `actId`; no selector inside either section; Overview's selector is untouched.
  This is the only arrangement that keeps one route without a duplicate control per section.
- Column headers sort exactly as today: click toggles asc/desc, new key starts desc. Active header is
  violet (`text-m3-primary`, 2px underline/arrow), no cell tinting. Remove the gold “max value”
  highlighting: gold is stale/attention, not “best”.
- One expansion at a time across both sections (`{section, key} | null`). Row click opens/closes in place;
  a chevron replaces the `⋮` button. No modal, no dialog, no keydown handler.

## Agents section

Table, no container card: `w-full border-collapse text-left`, 11px mono header, 36px rows, hairline
separators, hover `bg-m3-surface-container-high/25`, expanded row `bg-m3-surface-container-low/40`.

| Column | Value today | Keep |
| --- | --- | --- |
| Agent | icon 24px, name, role label | `agent`, `role ?? agentInfo.role`; icon from `agentInfo` |
| Time | `4.2 hrs` or `38 mins` | `hours`, `timePlayedSeconds` (same formatting) |
| Matches | integer | `matches` |
| Win % | `toFixed(1)%` | `winPct` |
| K/D | `toFixed(2)` | `kd` |
| ADR | `toFixed(1)` | `adr` |
| ACS | `toFixed(1)` | `acs` |
| DDΔ | signed integer | `damageDeltaPerRound` |
| HS % | `toFixed(1)%` | `hsPct` |
| KAST | `toFixed(1)%`, or today a dash | `kast`; **absent when 0/undefined — no dash** |
| — | expand affordance | chevron, row click |

Expanded body — a definition grid (`grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3 pt-4 mt-1 border-t`),
no cards, no icons, no bars:

| Group | Values kept |
| --- | --- |
| Combat | `bestKills`, `firstBloods`, `aces` |
| Defense | `defenseRoundsWon` / `defenseRoundsLost`, `defenseRoundsWinPct` (or computed from the two counts), `defenseKd`, `defenseKills`, `defenseAssists`, `defusesPerMatch` |
| Attack | `attackRoundsWon` / `attackRoundsLost`, `attackRoundsWinPct` (or computed from the two counts), `attackKd`, `attackKills`, `attackAssists`, `plantsPerMatch` |

**Named non-reproductions — fabricated values that are dropped, not moved:**

- `bestKills || 30` showed 30 when the field was missing. Keep `bestKills` only when > 0; otherwise absent.
- `defusesPerMatch || 0.58` and `plantsPerMatch || 2.09` were invented defaults. Show only when > 0.
- `defenseKd || kd` / `attackKd || kd` substituted the overall K/D under a side label. Show `defenseKd` /
  `attackKd` only; absent when 0/undefined.
- `kast: 72` in the local fallback fabricated a KAST value. Fallback keeps `kast: 0`; the row shows no
  KAST rather than 72.
- KAST’s `'—'` becomes absence, per the honesty rule.

## Maps section

| Column | Value today | Keep |
| --- | --- | --- |
| Map | 144×44 thumbnail card with gradient overlay + name | plain image 48×28 (no border/radius card) + name 13px; name only if no image |
| Top agents | up to 3 icons + rounded win % under each | `topAgents[].name/icon/winPct`; omit if empty |
| Win % | `toFixed(1)%` | `winPct` |
| Wins | integer | `matchesWon` |
| Losses | integer | `matchesLost` |
| K/D | `toFixed(2)` | `kd` |
| ADR | `toFixed(1)` | `adr` |
| ACS | `toFixed(1)` | `acs` |
| DDΔ | signed integer | `damageDeltaPerRound` |
| — | expand affordance | chevron, row click |

Expanded body — definition grids separated by hairlines, no cards/bars:

| Group | Values kept |
| --- | --- |
| Primary | `kills`, `deaths`, `assists`, `headshotsPct`, `matchesPlayed`, `timePlayedSeconds` |
| Events | `aces`, `clutches`, `thrifty`, `flawless`, `plants`, `defuses` |
| Attack | `attackRoundsWinPct`, `attackKills`, `attackDeaths`, `attackAssists` |
| Defense | `defenseRoundsWinPct`, `defenseKills`, `defenseDeaths`, `defenseAssists` |

The attack/defense bar charts are deleted; their widths were derived from the kill/death/assist counts,
which are all still printed. No number is lost.

## Deleted

| Surface | Deleted |
| --- | --- |
| Both pages | `h-full overflow-y-auto` page shells, `max-w-6xl` wrappers, page `h2` + subtitles, count pill/text, per-page act dropdowns (one survives in Prep header), loading banner cards, empty-state cards, `motion`/`AnimatePresence` expansion wrappers |
| Agents | `rounded-3xl` table container + border/shadow, `ROLE_COLORS` accent bars, role-coloured agent strip, `⋮` buttons, three expanded cards (Combat/Defense/Attack icons), `kills/firstbloods/aces` image imports, `AgentsSkeletons` |
| Maps | `rounded-2xl` table container + border/shadow, thumbnail card/gradient overlay, `⋮` buttons, six metric cards, two attack/defense cards and their bars, `MapsSkeletons` |
| Navigation | `agents`/`maps` from `TrackerSubTab`, `TABS`, localStorage guard; `MapsSkeletons`/`AgentsSkeletons` imports; 8–10px labels (raise to 11px floor) |

Keep: `fetchTrnAgents`/`fetchTrnMaps`, `mergeAgentStats`/`mergeMapStats`, fallback derivation, sort keys
and defaults, `CustomDropdown`, `shortAct`, `Skeleton` primitive. No HUD files.

## Build shape

- `src/components/Prep.tsx` — route header, single act selector, two sections.
- `src/components/prep/AgentTable.tsx`, `prep/MapTable.tsx` — tables + definition-grid expansion.
- `TrackerAgents.tsx` / `TrackerMaps.tsx` deleted; their fetch/merge logic moves into the tables (or a
  `usePrepData` hook) without changing computation.
- `TrackerView.tsx` — `prep` replaces `agents`/`maps`; no `live` after step 3.

## Acceptance

- One route, no inner tabs: `Prep` renders two `section`s only; `grep -n 'role="tab' src/components/Prep.tsx
  src/components/prep` → none.
- Exactly one act selector: one `CustomDropdown` in `Prep.tsx`; none in `AgentTable`/`MapTable`.
- No card tokens in Prep: `rounded-2xl`, `rounded-3xl`, `shadow-m3-1`, `bg-m3-surface-container` as a
  container fill → none; no `motion`.
- Numbers preserved against a fixture: all 10 agent columns + 3+7+7 detail values, and all 9 map columns
  + 6+6+4+4 detail values, equal to the old implementation. Named exceptions above are absent, not
  substituted.
- No `'—'` or fabricated constants: `grep -nE "\\|\\| 30|\\|\\| 0\\.58|\\|\\| 2\\.09|kast: 72|'—'"` in
  `components/prep` → none.
- Loading: `Skeleton lines={4}` once per section; empty: one 11px line per section, no card.
- `bun run build:ui` 0, `bun run lint` 0, all `scripts/*-check.ts` pass; no HUD file in the diff.
