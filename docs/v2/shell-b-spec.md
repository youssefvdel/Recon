# Recon v2 shell spec — Graphite default

The shipped visual language is **Graphite**; **Nocturne** is a second token set selected by
`data-theme="nocturne"`. Ledger does not ship until the user chooses a light theme awake. This spec is
against `src/v2/tokens.css` and `docs/v2/ia.md`; the static boards are theme specimens, not the final
layout.

## 1. Frame

```
top bar 56px: brand · Now / Matches / Prep · live · ⌘K · ⋯ · window controls
content: max 1280px, page padding var(--page-padding), one page scroll
```

- No sidebar. The top bar is the only permanent chrome. Window controls sit at the far right; `⌘K` and
  `⋯` before them. The drag region is the empty bar area, never a button.
- Content is 12-column grid with `--layout-gutter`; the reading column is 760px. A sheet may use the full
  1280.
- Graphite is the default (`:root`); Nocturne is `[data-theme='nocturne']` on the app root. A theme switch
  changes `data-theme` only; no component branches on theme, no raw hex outside tokens.
- Motion uses tokens; nothing animates before data. Reduced motion collapses durations to 0.

## 2. Destinations and overlays

| Surface | Entry | Notes |
| --- | --- | --- |
| Now | default / `Now` | live strip + act record + recent matches |
| Matches | `Matches` | ledger; one row expands in place |
| Prep | `Prep` | agents + maps tables; one expansion across both |
| Tools | `⋯` / `⌘K` | one sheet; anchors `#store #crosshair #prepick #resolution #chat #accounts` |
| Settings | `⋯` / `⌘K` | its own sheet; configuration, not a destination |
| Command palette | `⌘K` / `Ctrl+K` | destinations + tools; one registry |

`CommandLayer` owns the single overlay keydown listener in capture phase. Escape closes the palette/menu
and calls `stopImmediatePropagation`; while closed it never stops propagation, so the match body keeps its
Escape. No sheet, section, card or row registers a keydown.

## 3. Now

- Header: eyebrow (`Episode 9 · Act 3 · Competitive`), page title `Now`, act selector on the right. No
  subtitle, no filter bar.
- Act record: `34–29` in `--text-display-hero-*` mono tabular, win % in data-large, metrics on one line
  (`Diamond 2 · 47 RR · 218 ACS · 1.24 K/D · 27% HS · 63 games`). Only present fields render.
- **Live strip:** 40px, sticky directly under the top bar, `surface-1`, hairline bottom, no radius, no
  shadow, no blur. Graphite rendering: `LIVE` in `--live`, map name in display font, score in data-large,
  phase/player count in label; `View lobby` is a text button at the right. States: live (`live`), previous
  (`attention`), agent select (no score), idle (nothing at all — no empty strip). Viewing the lobby opens a
  disclosure below the strip (36px rows, bracket/party mark, rank, peak, level, Tracker state) — not a
  modal, not a destination. One disclosure at a time with the match feed.
- Recent matches: hairline rows (age, map, verdict, score, agent/KDA, 22-bar sparkline, chevron). No cards.
  Row click opens the existing in-place match body; Escape belongs to that body while it is open.

## 4. Matches and Prep

- **Matches:** one ledger, hairline rows, filters in the header as inline controls; one row expanded at a
  time; the body is inline (no dialog). Round navigation is one sticky rail; player detail is a drawer,
  not a second modal. Cards: none in the ledger; the scoreboard is a table.
- **Prep:** one route, two stacked sections (Agents, Maps), one act selector in the header, no inner tabs.
  Hairline tables, one expansion across both, definition-grid details. Cards: none.

## 5. Tools sheet — the card policy in a real surface

Tools is one 1280px sheet, one scroll, no tabs. Sections are anchors; menu/palette deep-links to them.
Each surface keeps its own state when visited.

| Section | Card treatment |
| --- | --- |
| Store | **Featured bundle is one earned card**: art, name, timer, price and item disclosure in one `surface-1` object; border + fill, `--radius-card`, no shadow; items open as rows inside it. Daily offers are **rows** (skin, price, timer), not cards. |
| Crosshair | **Profile card is earned**: name/selector, preview, colors, save/status in one card, one profile/decision. Color controls inside are rows/fields, not nested cards. |
| Pre-Picker | map rows + one agent field; no card per map. |
| Resolution | grouped controls; groups are hairline sections, not cards. A single confirm/safe-mode block may be one card because it is one decision. |
| Riot Chat | conversation list rows + thread; no cards. |
| Accounts | account rows; snapshot details as fields inside the drawer, not a card grid. |
| Settings | one sheet; groups are hairline sections. A group that is one decision may use a card; never a card per toggle. |

The card test is the delete-the-border test from `design-system.md`: if removing the border leaves one
coherent object/decision, the card is allowed; if it leaves unrelated facts, use a row/table. No
card-in-card, no cards as rows, no decorative gradient wrappers, no shadow + border + fill.

## 6. Theme and tokens

- Components read only `var(--…)` from `src/v2/tokens.css`; raw colours are allowed only in that file.
- Graphite: `Space Grotesk` + `IBM Plex Mono`, acid `--accent` for interaction, `--live` for live state,
  positive/negative only for outcomes. Nocturne maps the same roles to Fraunces/Inter/JetBrains and violet.
- The act record, every score, KDA, ACS, RR, price, timer and percentage use `--font-mono` and
  `font-variant-numeric: tabular-nums`. Prose never uses mono for numbers.
- The theme switch lives in Settings; it writes `data-theme` and stores the choice. Ledger is not an
  option until explicitly approved.

## 7. Acceptance

- No sidebar; exactly three destinations; `⌘K` and `⋯` open the same registry; every old tool reachable via
  Tools anchors; legacy routes map.
- Now renders with no live strip when idle, with `LIVE`/`previous`/agent-select states when present, and no
  invented score/side/round.
- Matches expansion is inline and one-at-a-time; Escape closes the palette first and nothing else while it
  is open; no sheet owns a keydown.
- Store/Crosshair cards pass the delete-the-border test; no card-in-card; no raw hex in components.
- Build/lint/scripts green; data layer untouched; Graphite/Nocturne swap without component edits.
