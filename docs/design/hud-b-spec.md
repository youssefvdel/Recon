# HUD — Direction B spec (step 9)

The HUD is not one surface: it is **five independently placed widgets** the player drags and scales
(`overlayConfig.ts`), drawn over a game at 260 Hz. Direction B changes their **interior** — the row
language of the feed — and touches neither the widget model, the drag/resize layer, nor the crosshair.

Rendered reference: the feed rows in `design/board-b.html`. Nothing here is implemented yet; step 9 runs
only after the window is stable.

## Hard constraints

1. **Glanceable mid-round.** A widget must be readable in one look without leaving the crosshair. That is
   the constraint every other rule here answers to; where it conflicts with "no cards", glanceability wins
   (see §1).
2. **No layout push.** A data refresh never changes a widget's width or height. Rows are fixed height,
   text truncates, cells keep their slot when empty.
3. **No invented values.** Every cell is a field on `LiveMatchState` / `LiveMatchPlayer` /
   `TrackerMatch`. Riot exposes no live combat data; do not add timers, round numbers, or post-swap side.
4. **No new motion.** Widgets fade in/out at most 120 ms opacity. No slide, scale, stagger, or pulse.
5. **No Win32 in this step.** The Tab peek and click-through are Rust (`win/overlay.rs`); the HUD keeps
   zero keydown handlers.
6. `bun run build:ui`, `bun run lint`, and every `scripts/*-check.ts` stay green; the overlay still boots
   with no match running.

## 1. The one surface the HUD keeps

The main window deletes every card. The HUD keeps **one plate per widget** — and only that one:

```
┌─ 1px rule · 2px radius · solid token bg at 82% ────────────┐
│ header line: map · queue · moment · stale marker           │  28px
├────────────────────────────────────────────────────────────┤
│ row │ row │ row │ row │ row                                │  34px each
└────────────────────────────────────────────────────────────┘
```

A plate is a legibility device, not decoration: text over a bright wall or a muzzle flash is unreadable
without it. What is banned inside the plate is everything B bans elsewhere: `rounded-2xl`, shadows,
glows, gradient fills, nested cards, and any secondary container. One plate, one rule, one radius value.

Radius stays at 2px (not 0): the game is 1440p and square corners read as a rendering artifact at that
pixel density. This is the only radius in the product.

## 2. Widgets: survive, fold, die

| Config key | Component today | Verdict | B form |
| --- | --- | --- | --- |
| `lobby` | `MatchPanel` (125) | **Survives**, rewritten | Live board: header line + two team columns of rows |
| `pregame` | `PregamePanel` (91) | **Survives**, merged with `lobby` | Same board, `Agent select` moment |
| `preRound` | `PreRoundPanel` (179) | **Survives** | Compact plate: one focal line + two team strips |
| `topAgents` | `MetaTiles` (334) | **Folds** | One prep line; the tile grid dies |
| — | `TeamBoard` (513) | **Survives as the row factory** | The only place a player row is built |
| — | `EditChrome` (404) | **Survives** | Same controls, violet actives, no glow |
| — | `PrepickBadge` | **Survives** | Neutral/violet dot, no mint |
| — | `HudCanvas` (1114) | **Survives as the shell** | Drag, resize, config, crosshair, notices |

**Dies:**
- `MetaTiles`' 334-line tile grid: the map/agent stat table, the K/D colour bands, the per-agent rows.
  Its one useful number (top agent win% on this map) becomes a clause in the prep line.
- `MatchPanel`'s rounded card shell and crest-sized row chrome.
- `PregamePanel`'s duplicate header — it and `MatchPanel` are the same board at two moments, so they
  merge into one component with a `moment` prop.
- `PreRoundPanel`'s coloured side chip (`DEF`/`ATK`) and coloured team labels.
- `TeamBoard`'s mint/rose K/D and win% colouring (already removed in `d81f051`); its row geometry is
  what the other panels must adopt.

**Does not change:** `OverlayCrosshair`, `useDrag`, `useOverlayConfig`, `overlayConfig`, the Rust show
path, the edit-mode transport.

## 3. Colour contract — every state

The contract is fixed (commit `d81f051`): **mint and coral mean a resolved outcome and nothing else.**
In the HUD that leaves them unused until a round or match result exists — and a live overlay never shows
one. Violet means *now*. Gold means *stale / needs attention*. Everything else is ink.

| State | Allowed | Banned |
| --- | --- | --- |
| No match (`phase: idle`) | — widget unmounts | empty plate, "waiting" text |
| Agent select (`pregame`) | violet: `AGENT SELECT` chip, your pick; ink everywhere else | side in colour; team in colour |
| Round start, 0–0 | ink `ATK`/`DEF` text; violet on the moment chip | mint/coral side badge, coloured team strips |
| Coregame | violet on your row marker and the live dot; ink values | any outcome colour (nothing is resolved yet) |
| Previous match (`isPreviousMatch`) | **mint/coral allowed**: result line and round marks only | mint/coral on ranks, names, or team identity |
| Team identity | ink step: `YOUR TEAM` on-surface, `ENEMY` on-surface-variant; column position separates them | mint, coral, violet, or any hue |
| K/D, win%, ACS | ink; emphasis by weight (`font-semibold`), never hue | emerald/rose bands, mint for ≥50% |
| Stale poll (`updatedAt` old) | **gold**: one dot + `stale 12s` in the header | per-row staleness, blinking, red |
| TRN pending | cell empty | "loading", shimmer, skeleton |
| TRN unavailable | cell empty | dash, zero, spinner |
| TRN 451 private | neutral lock glyph | gold, "error", dashes |
| Rank hidden (`isRankHidden`) | neutral `Rank hidden` + lock | fake tier, gold |
| Incognito / name unresolved | neutral `Player N` + eye; `nameResolved: false` never guessed | violet or gold on the name |
| Pick pending / locked | gold `Clock` when pending; **violet** check when locked | mint "ready" |
| Error notice (poll/transport) | gold text on the plate, one line | rose banner, toast stack |

Two hard consequences:

- A coregame screenshot contains **zero mint and zero coral**. If one appears, something is claiming an
  outcome that has not happened — the exact bug the contract exists to prevent.
- Violet is a positional signal: your row, the current moment, the active control. More than three violet
  marks in one widget is a defect.

## 4. Missing and stale, mid-match

The rule is the app's honesty rule, applied at 260 Hz:

- **A missing value is absent, not faked.** No `—`, no `0`, no placeholder shape. The cell's grid slot
  stays (no layout push); its content is empty.
- **The board never blanks on a failed poll.** Keep the last good state and mark it stale. Blanking is a
  bigger lie than a stale number, because it reads as "the match ended".
- **One staleness marker per widget, in the header.** Gold dot + `stale Ns`, computed from
  `LiveMatchState.updatedAt`. It clears on the next state that differs from the previous one.
- **Structural absence is not staleness.** `isTrnPrivate`, `isRankHidden` and unresolved names are
  permanent properties of a player, not alarms: neutral lock/eye marks, never gold.
- **Phase transitions own visibility.** `idle` → the widget unmounts (the window hides). No "no data"
  state is ever rendered.
- **Edit mode overrides stale.** While editing, the plate shows its content and the violet edit border;
  staleness is suppressed so layout work is not interrupted by a warning.

## 5. Glanceability budget

| Item | Budget | Why |
| --- | --- | --- |
| Widget width | 340–420 CSS px (today: 340) | one row of 10 players fits without wrap |
| Row height | 34px, fixed | thumb-readable; never grows with content |
| Header height | 28px | one line: map · queue · moment · stale |
| Type sizes per widget | exactly 3: 12 name, 11.5 meta, 11 mono number | fewer sizes = faster scan |
| Smallest text | 10px | below that it is unreadable over a game |
| Colours per widget | ≤ 3 (paper, ink, one signal) | a fourth means the contract is broken |
| Rows per team | 5 (Deathmatch: 6, two columns) | payload's own shape |

## 6. Acceptance — checkable from a screenshot

A judge opens a 1440p screenshot of each widget state and answers yes/no. All ten must pass.

1. **No cards:** no radius > 2px, no shadow, no glow, no gradient, no nested container in any widget.
2. **No outcome colour in a live state:** a coregame screenshot has zero mint and zero coral pixels
   (sample the pixels; do not trust the code).
3. **Outcome colour, when resolved:** a previous-match state uses mint/coral **only** on the result line
   and round marks — nowhere on ranks, names, or team labels.
4. **Violet is positional:** at most three violet marks per widget, and each one is "your row", "the
   current moment", or "the active control".
5. **Gold is diagnostic only:** gold appears exactly when a source is stale or a pick is pending, at most
   one mark per widget besides the pick state.
6. **Nothing wraps:** every row is one line; the widest name truncates with an ellipsis, never pushes a
   column.
7. **No fake values:** no `—`, no `0`, no skeleton, no shimmer where a field is missing.
8. **Geometry is stable:** the widget's bounding box is identical before and after a data refresh
   (`getBoundingClientRect` width and height unchanged).
9. **Numbers align:** every numeric column is mono, tabular, right-aligned; a column of values lines up
   on the decimal.
10. **Edit mode reads as edit:** the Lock control is violet, the plate border is violet, and no mint is
    used for "ready/locked".

## 7. Order of work (when step 9 runs)

1. Extract the row into `TeamBoard` (one component, three sizes) and prove it in `MatchPanel`.
2. Merge `PregamePanel` into `MatchPanel` as a `moment` prop; delete the duplicate header.
3. Flatten `PreRoundPanel` to the compact plate; keep its position and scale keys.
4. Fold `MetaTiles` into the prep line; delete the tile grid.
5. Restyle `EditChrome` and `PrepickBadge` to the contract.
6. Run the ten acceptance checks against screenshots of all five widget states plus edit mode.

Each step is one commit; the overlay keeps working after every one, because no step removes a widget
before its replacement renders.
