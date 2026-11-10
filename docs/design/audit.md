# UI audit — cards and information architecture

As of 2026-11-10, HEAD `998f36b`. Scope: the main window's tracker, store, setup and settings
surfaces, plus the match-detail modal. Method: a **card** is a rounded (≥12px) bordered or filled
container that groups content. Counts are from source (`rounded-xl|2xl|3xl` containers per view) and
checked against the rendered structure; a repeated row counts once in source but once per row on screen.

## 1. Card census

| Surface | Rounded containers (source) | What is actually on screen | Worst nesting |
| --- | ---: | --- | --- |
| Overview | 15 | 6 content cards + 4 stat tiles nested inside those cards + filter row + hero wrapper | A card wraps a card at `Overview.tsx:871` (2px gradient wrapper) |
| Match History | 6 | 2 section cards + **one card per match row** (up to 20) + filter card + empty card | Match row card inside the list section card |
| Agents | 9 | 3 stat cards + table card + empty card | Table gets card chrome, then its own header/footer blocks |
| Maps | 11 | 3 cards + table card + per-map tiles | Tiles inside the table card |
| Store | 7 | Wallet card + bundle cards + daily-shop cards | Bundle card inside the section card |
| Settings | 37 | 6 section cards, each holding 3–6 group cards | Section → group → row: three card levels |
| Crosshair | 6 | Profile rows + preview card | Row cards inside the profile card |
| Pre-Picker | 12 | Map rows as cards + agent cards | Card per map row |
| Accounts | 13 | Account cards + per-account panels | Panel inside account card |
| Riot Chat | 16 | Friend rows + conversation pane | Row cards inside the pane |
| Live Match | 5 | Two team cards + board card + strip | Team card inside the board card |

**Total source rounded containers in these 11 views: 137.** Overview and Settings alone account for 52.

## 2. Containers that exist only because a card was the easy answer

1. `Overview.tsx:433–715` — five sibling cards (Combat Highlights, Top Agent, Accuracy, Previous Acts,
   Tracker Score) for five numbers that belong in one table row each. Combat Highlights is a card
   containing three stat rows, each already a tile.
2. `Overview.tsx:871` — a rounded gradient wrapper around another rounded card. Purely decorative
   card-on-card.
3. `MatchHistory.tsx:179` — every match is a rounded-xl card inside the list's rounded-2xl card. The
   list has no other row primitive; the card is the row.
4. `AppSettingsView.tsx` — 6 section cards × 3–6 group cards × row cards (37 rounded containers).
   The group card adds no boundary the section header did not already give.
5. `TrackerAgents.tsx` / `TrackerMaps.tsx` — the table is wrapped in a card, then its toolbar and
   empty state are separate blocks; the card chrome is doing no grouping the page header isn't.
6. `LiveMatchView.tsx` — each team is a card inside the board card; the outer card exists only to hold
   two cards and a status strip.
7. `PrepickView.tsx` — each map row is a card. A table row with a hover state would do the same job.

## 3. Information architecture census

| Layer | Count | Items |
| --- | ---: | --- |
| Top-level nav | **8** | Tracker, Store, Crosshair, Pre-Picker, Riot Chat, Accounts, Resolution Switch, Settings |
| Hidden destination | 1 | Valorant Config (only reachable via Accounts → Video) |
| Tracker tabs | **5** | Overview, Matches, Agents, Maps, Live Match |
| Resolution tabs | **4** | Switch, Stretch Preview, Stretch Setup, GPU Scaling |
| Settings sections | **6** | Updates, Session/HUD, Display, Data, Consent, About/logs |
| Match-detail tabs | **2** | Scoreboard, Duels |
| Nested modal | 1 | Player Overview opens on top of match detail |

**19 navigable destinations** (8 + 4 extra tracker + 4 utility + 2 modal + config). Nothing has a
search or command palette; the only filters are in Match History.

## 4. What the user opens the app to learn, and what the nav answers

The three recurring questions are: *how am I doing this act*, *what happened in my last match*, and
*who is in my lobby right now*.

- **How am I doing** is split across Overview, Agents, Maps and the match-detail tables; the same ACS,
  K/D, win% and HS% appear in four surfaces with different layouts.
- **What happened last match** is three clicks deep: Tracker → Matches → row → modal; the modal then
  hides rounds below the scoreboard and breakdown.
- **Who is in my lobby** is the fifth tab under Tracker (Live Match), i.e. the most time-sensitive
  surface has the least reachable position. The pre-game panel work is adding a fourth place where
  lobby data appears.
- The eight top-level destinations give equal weight to daily data (Tracker), a rotating shop (Store),
  a setup tool (Crosshair), a setup tool (Pre-Picker), chat, account switching, a display tool
  (Resolution Switch) and settings. Four of the eight are visited rarely and never during a match.

## 5. Measured friction

- Match detail: **94vh modal**, one scroll holding two 14-column team tables + a breakdown + the full
  RoundTimeline; the interactive round strip sits at the bottom, the read-only one in the header.
- Scoreboard: **14 columns** at 10–11px; player cell carries name, tag, copy button, rank icon and MVP
  badge inside 115px.
- Two round navigations: header strip (18 cells at 3.5px, two rows) and body tablist (18 cells, 32px).
- Two modal levels: match detail → player overview, each with its own Escape/focus trap.
- Colour: mint/coral currently mean team (header/banners), win/loss (round icons), positive/negative
  K/D, and DEF/ATK side (HUD) — **four meanings for two hues**.
- Every view owns its own skeleton/error/empty pattern; the signed-out banner still renders in the
  layout on Match History.

## 6. What the three directions must decide

1. **One place per question**: where “act performance”, “last match” and “lobby” live, and how many
   clicks each takes.
2. **A row/table primitive** that replaces the per-item card, and a written rule for when a card is
   allowed at all.
3. **One colour contract** that survives teams, outcomes, sides and deltas without a hue doing two jobs.
