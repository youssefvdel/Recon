# Recon v2 — design system

Status: proposal for the v2 rebuild. Tokens first; components are derived from these rules, not from the
old screens. The implementation contract is `src/v2/tokens.css` (**Nocturne is the chosen theme** — `data-theme='nocturne'` by default, persisted in `localStorage`; Graphite stays a second set, one attribute away);
that is the only file allowed to contain raw colour literals. The engine (`src/sources/`, `src/live/`, `src/cache/`, Rust) is out of scope and unchanged.

This file defines **roles**, not one palette. The three theme boards (`design/v2/board-a|b|c.html`) map
these roles to three different visual languages; v2 ships the chosen mapping.

---

## 1. Colour — semantic roles only

One role, one meaning. A role may be re-coloured by a theme; its meaning may not change.

| Token | Meaning | May be used for | Must never mean |
| --- | --- | --- | --- |
| `surface-0` | the page/desk | app background, scroll canvas | cards, controls |
| `surface-1` | a raised working plane | earned cards, sheets, popovers | page background |
| `surface-2` | a control or inset plane | inputs, segmented controls, sub-rows | an entire page |
| `on-surface` | primary text | headings, values, labels | disabled text |
| `on-surface-muted` | secondary text | captions, units, metadata | disabled text |
| `outline` | separation | hairlines, card borders, dividers | focus |
| `outline-strong` | strong separation | selected card edge, sheet edge | decoration |
| `accent` | **the one interactive/selected thing** | focus ring, active destination, primary action, selected row | a win, a rank, a team, a metric |
| `on-accent` | text on accent | button labels | body text |
| `positive` | a **resolved positive outcome** | win, positive delta, success confirmation | “good stat”, “high rank”, team blue |
| `negative` | a **resolved negative outcome** | loss, error, destructive confirmation | “low stat”, team red, warning |
| `attention` | stale / pending / needs action | archived data, pending fetch, unread indicator | win/loss, selection |
| `live` | an **in-progress** match | live chip, live strip state, live dot | a loss, a warning, a selection |
| `focus` | keyboard focus | 2px ring, always visible | hover |

Rules:
- An accent is one meaning. v2 has **one** accent role; no second “secondary accent” for decoration.
- Positive/negative are outcomes, not valence. A high K/D is not positive; a win is.
- Never encode meaning by colour alone: pair it with a word, shape, or icon.
- Contrast: body text ≥ 4.5:1, large text ≥ 3:1; focus ring ≥ 3:1 against both adjacent colours.

## 2. Type — a scale with jobs

| Role | Size / line | Weight | Family | Use |
| --- | --- | --- | --- | --- |
| display | 48 / 52 | 600 | display | page title / major page heading |
| display-hero | 64 / 66 | 600 | display | act record, one per page; the only 64px text |
| headline | 28 / 34 | 600 | display | sheet/section hero |
| title | 20 / 26 | 600 | body | section titles, card names |
| body | 14 / 20 | 400 | body | prose, labels with sentences |
| body-strong | 14 / 20 | 600 | body | emphasis inside body |
| label | 11 / 14 | 600 | body or mono, uppercase, +0.12em | column heads, eyebrows, metadata |
| data | 12 / 16 | 500 | mono, tabular | every number |
| data-large | 16 / 20 | 600 | mono, tabular | scores, currency, timers |

- **Mono is mandatory for every numeral**: scores, K/D/A, ACS, RR, prices, timers, IDs, percentages, dates.
  Prose may use the body face; a number never does.
- No arbitrary sizes. The smallest text is 11px; the only 11px is label/caption.
- Themes choose the families, not the scale. A serif display belongs to a theme; the role still applies.

## 3. Space, grid, radius

- **Space scale:** 2, 4, 8, 12, 16, 24, 32, 48, 64. No other values; no `13px`.
- **Grid:** 12 columns, 24px gutter, max content **1280px**; page padding 24/32/48; the reading column may be 760px.
- **Card padding:** 16 or 20 only; sheet padding 24; row height 36 or 44.
- **Page padding:** 24, 32 or 48; a theme picks one.
- **Radius scale:** 0, 2, 6, 10, 14, 999. Shell 0; controls 2 or 6; cards 2, 10 or 14; pills 999. A theme
  picks one value per family from that scale. Nested surfaces use the **same** radius as their parent or 0;
  never a bigger inner radius.

## 4. Elevation — one emphasis channel

| Level | Form | Use |
| --- | --- | --- |
| 0 | fill + hairline | cards, rows, sheets in flow |
| 1 | fill + hairline + no shadow | the default working plane |
| 2 | fill + shadow, **no border** | transient overlays only: menu, palette |

- **Never border + fill + shadow together.** A card earns one surface treatment.
- No card inside a card; no inner surface with its own elevation. If a block needs separation inside a card,
  use a hairline or a label, not a second card.
- No backdrop blur anywhere. Overlays use a solid scrim.

## 5. Motion — never in front of data

| Token | Duration | Use |
| --- | --- | --- |
| `motion-fast` | 120ms | hover, focus, press |
| `motion-base` | 180ms | disclosure, drawer, menu |
| `motion-slow` | 240ms | sheet/page transition |
| `motion-large` | 320ms | rare full-surface change |

Easing: `cubic-bezier(.2,.8,.2,1)` for enter/reveal; `cubic-bezier(.4,0,1,1)` for exit. No bounce, no
spring on data, no looping decorative motion. Loading is a skeleton or a stated status, never an animation
that makes the user wait. Respect `prefers-reduced-motion`: durations collapse to 0, no opacity loops.

## 6. Card policy — a card must earn its border

**Allowed when** the card groups something that is genuinely **one object or one decision**: a store
bundle, a crosshair profile with its preview, a settings group, a live match as one “now” object.

**The test:** delete the border. If the content still reads as one thing, the border is decoration — remove
the card. If the content falls apart into unrelated fragments, the card is doing work.

**Placement rules**
- Cards sit on the 12-column grid; equal gutters from the space scale; no ragged card widths.
- One spacing scale inside and between cards; padding 16/20, gap 16, section gap 32.
- Cards never nest. A card’s children are rows, fields, media, or controls, not cards.
- No card whose only content is another card.
- Choose **one** emphasis: fill + hairline **or** fill + shadow — never fill + border + shadow.
- Radius consistent with the card family; a card inside a sheet uses the sheet’s card radius.
- A card must have a job in the hierarchy: if it is removed, the page loses grouping, not “a box”.

**Banned regardless**
- card-in-card, cards used as list rows, decorative gradient wrappers;
- any container added only to fill empty space or to make a screenshot look structured;
- shadow + border + fill on the same element; nested elevation;
- cards whose border encloses one number that could be a line in a table.

**Reference example — the store featured bundle (good)**
- **Before (slop):** bundle art in one card, a second “contents” card inside it, each item in its own bordered
  tile, a gradient wrapper around the whole thing, shadow + border + fill. Delete the borders and the
  structure is unchanged; the borders were decoration.
- **After (earned):** one `surface-1` card holds the art, name, timer and price as one buy decision; the item
  disclosure opens inside the same card as rows, not tiles. Border + fill only; radius 10; padding 16; one
  timer in mono. Delete the border and the bundle still reads as one object — but it is the only object on
  that rail, so the border is allowed to mark the decision boundary, not to decorate.

The old Overview stat cards fail the test: Combat Highlights, Top Agent and Accuracy each had border + fill +
shadow, and deleting the borders leaves three groups of stats that already read as separate facts. They were
decoration, which is why v2 does not bring them back.

## 7. Component rules that follow

- **Rows** are the default list primitive; cards are for objects/decisions, not for lists.
- **Sheets** are one surface with a title, a hairline, and sections; never a stack of cards.
- **Command palette / menu** are transient overlays: fill + shadow, no border, no blur; one keydown owner,
  Escape closes, data never waits for animation.
- **Buttons:** primary = accent fill + on-accent text; secondary = surface-2 + hairline; destructive =
  negative text/outline, never a full red fill unless confirming.
- **Focus:** 2px focus ring, 2px offset; never removed; visible on dark and light themes.

## 8. Token contract for themes

```css
--surface-0 --surface-1 --surface-2
--on-surface --on-surface-muted --outline --outline-strong
--accent --on-accent --positive --negative --attention --live --focus
--font-display --font-body --font-mono
--radius-card --radius-control --space-unit
--shadow-overlay
```

A theme is a mapping of these roles plus three families. It cannot add a semantic role; if a new meaning is
needed, the design system gets a new token, not a recolour of an existing one.
