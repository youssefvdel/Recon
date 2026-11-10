# Live / Play — Direction B spec (step 3)

One surface: the live lobby becomes the **top of the Overview feed**, not a destination. Same 940px
column, same page scroll. Rendered reference: the live strip in `design/board-b.html`; the row density
is new but every field already exists on `LiveMatchPlayer`.

Hard constraints: no new invented values (Riot exposes no live combat data); no keydown handler on this
surface; no dialogs; HUD untouched until step 9.

## Placement

`Overview` renders a `LiveSection` as its **first child**, above `ActHeader`, only when the effective
state has teams:

```
[ sticky 44px live strip ]        ← pinned while the page scrolls
[ YOUR TEAM · 5 ]
[ row ] [ row ] [ row ] [ row ] [ row ]     ← normal feed flow
[ ENEMY · 5 ]
[ row ] [ row ] [ row ] [ row ] [ row ]
────────────────────────────────────
Episode 9 · Act 3 · Competitive
34–29   54%
…act header + match feed as today
```

- No `Live` tab, no page shell, no separate scroll container, no cards.
- Strip: `sticky top-0 z-20 -mx-6 px-6 bg-m3-bg border-b border-m3-outline-subtle`, `h-11`.
  Solid background only — no `backdrop-blur`, no shadow.
- Lobby rows stay in normal flow. The page scrolls; nothing inside the section scrolls.
- No layout push: the section is normal flow (no fixed/absolute overlay), and a state refresh never re-sorts
  rows or changes the column set. It grows only when the lobby itself gains players.
- Idle / no teams: render nothing. The old “Waiting for Valorant Match” card is deleted.
- Previous match (`isPreviousMatch`): strip shows `PREVIOUS MATCH` with the gold attention dot and
  `Last match` beside the map; rows stay for reading. No `LIVE` word and no violet dot.
- No row re-sorting while TRN values land: keep payload/team order; party marks move with the row.

## The strip (44px, one line)

| Slot | Content | Rule |
| --- | --- | --- |
| State | `LIVE` violet dot, or `PREVIOUS MATCH` gold dot | Never both |
| Map | map name, 16px Outfit 700 | Absent if `mapName` empty |
| Queue | queue label, 11px mono outline | From `queueId`, absent if unknown |
| Score | `6–4`, 16px mono tabular | Only when both `allyScore` and `enemyScore` are numbers |
| Moment | `Agent select` / `Live` / `Last match` | From `phase`; no round number |
| Players | `10 players` | `blueTeam.length + redTeam.length`, absent at 0 |
| Server | city, 11px mono | Only `serverName`; never raw `serverId` |

Moment rules are the same as `PreRoundPanel`’s, duplicated here rather than importing the HUD:

- `pregame` → `Agent select`, no score.
- `coregame` → `Live`; score if both; starting side only at 0–0 (the one moment it is still current).
- `isPreviousMatch` → `Last match`; score if both.
- No round timer, no round number, no post-swap side. If the payload lacks it, the line lacks it.

## Lobby rows

Two neutral team headings (`YOUR TEAM · 5`, `ENEMY · 5`; `DEATHMATCH` / `THE RANGE` flat when
`isFfa`/`isRange`), then one row per player. No crest/team accent colours: mint and coral remain outcome
only, violet remains now/selection, gold remains stale/attention.

Row grid, 36px, hairline separator, no radius, no card:

`grid grid-cols-[minmax(0,1.7fr)_120px_120px_56px_52px_minmax(0,1.5fr)] items-center gap-3 py-2 border-b border-m3-outline-subtle/50`

| Column | Shows | Source | Absent rule |
| --- | --- | --- | --- |
| Player | agent icon 24px, `name#tag` 12px, `You` violet marker, incognito eye | `agentIcon/agentName/name/tag/isMe/isIncognito/nameResolved` | Unresolved name stays `Player N`; no guessed identity |
| Rank | crest 18px + rank 11.5px + RR 11px mono | `tierIcons[tier]`, `rank`, `rr` | `isRankHidden` → `Rank hidden` + lock; RR only `tier > 2`; absent if no rank |
| Peak | crest 16px + peak rank 11px, act 10px mono | `tierIcons[peakTier]`, `peakRank`, `peakSeasonId` → `seasonNames` | Entire cell absent when `peakTier = 0`; no raw season id |
| Party | neutral 2px left bracket + `×N` | `partyId` count across both teams | Solo (`partyIndex` 0/undefined) → nothing; no invented party colour |
| Level | `Lv 214` 11px mono | `accountLevel` | Absent when `accountLevel = 0` |
| Tracker · act | summary or state word | table below | Never a dash, zero, or placeholder |

Tracker cell is **act-wide**, not live (Riot exposes no live combat data). Header says `Tracker · act`
on the section; values show age. One line, 11px mono:

- Fresh values with a known age ≤ 7d: `1.24 K/D · 27% HS · 4h` (only fields that exist; age from
  `peekLivePlayerStatsAsOf(puuid)`).
- `isTrnPrivate` **or** `trnPlayerState(...) === 'private'` → `private` (lock icon, neutral).
- `trnPlayerState === 'missing'` → `no profile`.
- `unknown`, `unavailable`, no known age, or age > 7d → `not cached` (never print values that cannot be
  aged).
- `fetching` / `trnState === 'pending'` → blank; a transient read is not a state word.
- No values at all → the state word only; no zero and no dash.

Deathmatch/Range: one flat list, no team headings, same row columns. Agent select with no enemy team:
one 11px line `Enemy picks hidden during agent select`, not a card or an empty table.

## Deleted

| Current | Fate |
| --- | --- |
| `LiveMatchView` page shell (`h-full`, `max-w-6xl`, waiting card, empty state, team wrappers) | Deleted; content becomes `LiveSection` at the top of Overview |
| `MatchStatusStrip` section card | Deleted; replaced by the 44px strip |
| `PlayerTable` rounded-2xl bordered sections | Deleted; team headings + hairline rows |
| `PlayerRow` rounded-xl bordered row, party SVG, external TRN/Blitz buttons, Skins button, separate ACS/K/D/Win%/HS%/Level columns | Deleted; compact six-column row |
| `LoadoutViewer` mount on this surface | Deferred, not deleted; the component owns a dialog + keydown, which this surface must not add. Rehome it after step 9 |
| Tracker tab `live` (`TrackerSubTab`, `TABS`, localStorage guard), `liveRequest` plumbing, `App.liveNonce` | Deleted; TopBar LIVE pill routes to Overview, where the strip lives |
| TopBar tooltip “jump to Live Match tab” | Copy changes to “jump to the live lobby”; no tab |
| 8.5–10px labels, `overflow-hidden` on team sections, fixed height h-10 rows | Deleted; 11px floor, natural page scroll |

Keep: the live fetch/poll/merge/harvest logic (extract to `useLiveLobby`), `splitTeams`, `tierIcons`,
`useLiveMatchActive` (TopBar only), `trnPlayerState`, `peekLivePlayerStatsAsOf`. Do **not** edit
`components/hud/*`; the moment helper is duplicated locally, and step 9 can converge it.

## Build shape

- `src/components/live/useLiveLobby.ts` — current fetch/poll/listen/merge/harvest logic, no visuals.
- `src/components/live/LiveSection.tsx` — strip + team groups + rows; no keydowns, no dialogs.
- `src/components/live/LiveStrip.tsx`, `LobbyRow.tsx` — pure presentational.
- `Overview.tsx` — `<LiveSection />` first child, before `ActHeader`.
- `TrackerView.tsx` — remove `live` tab, `liveRequest`; `App.tsx` — remove `liveNonce` and the
  `goto-live` subtab behavior (tab becomes overview); `TopBar.tsx` — tooltip copy only.

## Acceptance

- `grep -rn 'LiveMatchView\\|liveRequest\\|liveNonce' src` → no matches; `TrackerSubTab` has no `live`;
  the top bar has no Live tab.
- `grep -rn "addEventListener('keydown'\\|role=\\"dialog\\"\\|aria-modal\\|LoadoutViewer" src/components/live`
  → no matches.
- No card tokens in `src/components/live`: `rounded-2xl`, `rounded-3xl`, `shadow-m3-1`,
  `bg-m3-surface-container` as a section fill. No `backdrop-blur`.
- Overview column stays 940px; strip is 44px and sticky; only the page scrolls.
- Mock states render honestly: pregame, coregame 6–4, previous match, idle, private, no profile,
  not cached, hidden rank, unresolved name, 0 level, 0 peak. A missing value is absent; the three
  Tracker words are distinct.
- `bun run build:ui` 0, `bun run lint` 0, all `scripts/*-check.ts` pass; no HUD file in the diff.
