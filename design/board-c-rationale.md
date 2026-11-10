# Direction C — Ruled

**One page per question.** The app is a document you read, not a dashboard you scan: cards are deleted, hairline rules separate content, and the only accent colour means *now*. The rendered board is [`design/board-c.html`](board-c.html).

## Intent

The complaint was "too many cards, tabs and pages everywhere". Ruled is a subtraction, not a reskin: it removes the card as a unit, removes tabs inside pages, removes whole pages from the nav, and spends the saved structure on rules, space and type so the one number that matters is readable at a glance.

Three positions worth arguing about:

1. **No cards at all.** Content sits on the page. Separation is a 1px rule plus 24px of space. The only filled surface in the product is the HUD panel and transient overlays (⌘K, dialogs).
2. **Colour carries state, never sentiment.** Wins, losses, rank deltas and ranks are ink. Outcome is encoded by position and fill (the round strip fills a win, leaves a loss hollow). The accent is spent on "live/now" and nowhere else.
3. **Tools stop being pages.** Display, stretch, config editor, GPU, crosshair and sensitivity become anchored sections of one *Machine* sheet, reachable by ⌘K, instead of seven destinations.

## Type scale

| Role | Size / line | Use |
|---|---|---|
| Display | 56/1, −0.035em, 560 | rank, match result — never two per sheet |
| Hero | 34 mono | RR, score: the number the page is about |
| Title | 24/1.15 | section headlines, map name |
| Body | 15/1.55 | prose, labels |
| Data | 13.5 mono, tabular-nums | tables, right-aligned |
| Micro | 10.5, .13em uppercase, 600 | section marks, `dt` labels |

Two families: Inter (UI) and JetBrains Mono (every numeral). Numbers are mono and tabular everywhere, in the HUD too.

## Colour roles

| Token | Value | The only thing it may mean |
|---|---|---|
| Signal | `#FF4655` | now / live / the current round, page or row |
| Verified | `#46C46E` | a value read back and confirmed (sync OK, GPU state, config read-back) |
| Unverified | `#D9A441` | missing, hidden, private or unreadable — a gap that must stay visible |
| Ink ×3 / Paper ×3 | `#E9EBEE … #08090B` | everything else, including wins, losses and deltas |

Consequence: a LOSS is not red, it is the word `LOSS` in secondary ink; a +21 is not green, it is ink with a sign. Red is never decorative, so when it appears the user knows a match is live.

## Card policy

- **Zero cards** in the main window — no boxed widgets, no shadows, no glass, no `backdrop-filter` anywhere.
- **One elevation level**: rule + paper step. The overlay inherits it, which is why the HUD and the window are the same drawing at two opacities.
- **Radius 0.** No pills; the party marker is a mono glyph (`P2`), not a chip.

## Nav / tab model

| Destination | Holds |
|---|---|
| **Now** | rank line, live lobby band, last five matches — the default landing sheet |
| **Matches** | one ledger (sortable table) + the report sheet opened in place with a breadcrumb |
| **Machine** | every toolkit view as an anchored section of one sheet |

Settings is a dialog on ⌘,, not a page. ⌘K reaches any section by name. Net: 14 nav destinations → 3.

## Build cost

| Piece | Estimate |
|---|---|
| Tokens + rail | 1 day (CSS variables; delete the card components) |
| Now sheet | 2 days (live band reuses the existing lobby rows) |
| Matches ledger | 1.5 days (one table, client-side sort; no virtualisation under 500 rows) |
| Report sheet | 3 days (round strip, scoreboard, duels, economy — data already in `TrackerMatchDetail`) |
| Machine consolidation | 3 days (move 8 views into anchored sections, delete page wrappers) |
| **Total** | **≈ 10.5 dev-days**, no new dependencies, no new IPC fields |

## Data honesty

Every rendered field exists in `src/types.ts`: `TrackerProfile`, `TrackerMatch`, `TrackerMatchDetail` (players, rounds, kills, `roundDetails.economy`) and `LiveMatchState` (tier/rank/RR, `partyIndex`, `isIncognito`, `nameResolved`, `isTrnPrivate`, `trnState`). Values in the board are samples of those fields; no field is invented. Hidden names, 451-private and incognito keep their amber state in the board, the lobby and the report — the same honesty marker at every scale.
