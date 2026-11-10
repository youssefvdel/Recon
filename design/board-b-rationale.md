# Direction B — Season Stream

**The season is one feed.** A third position: not a console (A) and not a document (C). There are no
destinations, no tabs and no pages — time is the navigation, and a match opens in the place it already
occupies. Rendered board: [`design/board-b.html`](board-b.html).

## Intent

The complaint was "too many cards, tabs and pages". Stream answers it by deleting the *container* and
the *destination*: the app is one chronological surface. The act header is the only summary; every
match is a row in the feed; clicking a row expands its rounds, kills, economy and scoreboard **in
place**. Nothing is a modal, nothing is a second page, and the back button is never needed.

Three positions worth arguing about:

1. **Zero destinations.** The top bar holds the brand, an act scrubber (time), ⌘K and a `⋯` menu for
   tools. Everything the old sidebar held is either in the feed or behind the menu. There is no
   "current page" to get lost in.
2. **One expansion at a time.** The feed is a reading state: one match is open, the rest are
   one-line summaries with a 22-bar round sparkline. Opening a match never covers the feed.
3. **A band, not a card.** The expanded match is a full-bleed tonal band (one surface step), not a
   bordered/rounded container. There is no card anywhere on the board; separation is a hairline plus
   the feed's date gutter.

## Type scale

| Role | Size / line | Use |
|---|---|---|
| Act record | 46/1, Outfit 800 | `34–29` at the top of the feed — one per page |
| Verdict | 24/1, Outfit 800 | the expanded match's score |
| Row title | 16/1.2, Outfit 700 | map name |
| Data | 11.5–12 mono, tabular | K/D/A, ACS, ADR, HS%, economy |
| Micro | 10 mono, .14em uppercase | gutter dates, labels, team marks |

## Colour roles

| Token | Value | The only thing it may mean |
|---|---|---|
| Mint | `#a8f5cc` | a win — nothing else |
| Coral | `#ff8a7a` | a loss — nothing else |
| Violet | `#d0bcff` | now / live / selection (act tab, selected round, your row) |
| Gold | `#e8b73a` | stale, missing or attention-required |
| Neutral | `#e6e0e9 … #cac4d0` | teams, sides, K/D sign, rank, identity |

The four-meanings problem is solved by removal: team identity is a text label, side is a word, K/D
sign is a sign, and mint/coral are spent only on outcome.

## Card policy

- **No cards.** Rows, bands and hairlines only. No radius on content surfaces, no shadows, no
  `backdrop-filter` anywhere.
- One tonal band is allowed for the open match because it is a *state* (expanded), not a container;
  it carries no border and no radius.
- A dialog may exist for destructive/consent actions only; nothing in the feed is a dialog.

## Nav / tab model

| Surface | How it is reached |
|---|---|
| Act feed | the default; scroll is the navigation |
| Matches | scroll to the list anchor — no separate page |
| Match detail | expand the row in place — no modal |
| Tools, settings, chat, accounts | `⋯` menu / ⌘K |

Net: **8 sidebar destinations + 5 tracker tabs + 4 utility tabs = 0 destinations, 0 tabs.**

## Build cost

**Medium.** One feed component, one accordion expansion, an act scrubber and scroll anchoring. The
match list/detail data already exists (`TrackerMatch` / `TrackerMatchDetail`); no new IPC fields. The
expensive part is deleting the page/tab shell and rehoming the tools menu.

## Data honesty

Every rendered field exists today: `TrackerProfile` (rank/RR, act record), `TrackerMatch` (map, queue,
score, duration, K/D/A, ACS, HS%), `TrackerMatchDetail.rounds[].winningTeam/roundResult` (the 22-cell
rail), `MatchRoundPlayer.killsDetail/economy` (kill lines and `loadoutValue/remaining/weapon/armor`),
and `LiveMatchState` (`allyScore`/`enemyScore`, roster count). The board omits fields the payload does
not carry — no round timer, no post-swap side, no invented rank percentiles.
