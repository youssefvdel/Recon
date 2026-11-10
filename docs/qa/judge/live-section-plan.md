# Live section — first-live QA runbook (step 3)

`docs/design/live-b-spec.md` replaces the never-verified `LiveMatchView` with `LiveSection` at the
top of the Overview feed. **The first real lobby after that merge is the verdict**, not a routine
check. This is the one-pass runbook for it.

**Precondition check first.** At `6516a15` the replacement has **not landed** (`src/components/live/`
does not exist; `LiveMatchView.tsx` is still the surface). Run `ls src/components/live` — if it is
missing, stop and re-run this plan when step 3 ships. The selectors below are the spec names; adjust
only the DOM lookup, never the expected behaviour.

## Setup

- Server-only mock pass: `bun run dev:ui`, Brave CDP, `aspect_dev_mock_match` on `127.0.0.1:5173`:
  `off` (idle), `pregame`, `coregame`, `deathmatch`.
- Previous-match is not a dev mock: use a real match that just ended (`live.isPreviousMatch` comes from
  the last active state), or inject a synthetic `recon_live_match_state_v2` with `isPreviousMatch:true`
  and label the result synthetic in the notes.
- Real pass: app on the PC with Riot signed in; this is the pass that matters.

Screenshots live in `docs/qa/judge/` with these exact names:
`live-01-idle.png`, `live-02-pregame.png`, `live-03-coregame.png`, `live-04-previous.png`,
`live-05-strip-sticky.png`, `live-06-tracker-values-age.png`, `live-07-tracker-private.png`,
`live-08-tracker-no-profile.png`, `live-09-tracker-not-cached.png`, `live-10-fail-blank.png`,
`live-11-sort-poll-a.png`, `live-12-sort-poll-b.png`.

## A. Moment / placement — one screenshot each

| # | State | Expected | PASS |
|---|---|---|---|
| A1 | **Idle** (`off`, no client) | Nothing renders above the act header. No `Waiting for Valorant Match` card, no empty team box. | `live-01-idle.png`; `grep` no old waiting copy |
| A2 | **Pregame** | Strip: `Agent select`; **no score**; `10 players`; map/queue per payload; no round timer/number. Team headings and rows visible. | `live-02-pregame.png` |
| A3 | **Live** (`coregame`) | Strip: violet `LIVE` dot, map, queue, `6–4`, `Live`, `10 players`; no `Agent select`. | `live-03-coregame.png` |
| A4 | **Previous match** | Strip: gold dot, `PREVIOUS MATCH`, `Last match` beside map; **no `LIVE` word, no violet dot**; rows stay readable. | `live-04-previous.png` |

Also assert once: strip height **44 px**, solid `bg-m3-bg`, `position: sticky`, `top: 0`, no
`backdrop-blur`, no shadow, and it is a normal-flow first child of the Overview column — never a fixed
overlay.

## B. No layout push

1. Idle: record `ActHeader.getBoundingClientRect().top`, feed row tops, `scrollHeight`, `scrollY`.
2. Switch to `coregame` (mock key + refresh). Record the same. The delta must equal the live section's
   own height in normal flow; no horizontal shift, same column set, no fixed/absolute strip.
3. Scroll page 200 px: strip must remain sticky at `top: 0` inside the column, rows scroll under it,
   and the strip must not cover the act header (it sits above it in flow).
4. During three poll refreshes, row order, column count and row heights must not change; a state
   update must not re-sort.

Screenshot `live-05-strip-sticky.png` after scrolling.

## C. Four honest Tracker states (one row each, one screenshot each)

Tracker cell is `Tracker · act`, 11 px mono, never a dash/zero/placeholder.

| # | State | Expected cell | Screenshot |
|---|---|---|---|
| C1 | values + age | `1.24 K/D · 27% HS · 4h` — only fields that exist; age from `peekLivePlayerStatsAsOf` ≤ 7 d | `live-06-tracker-values-age.png` |
| C2 | private | `private` + lock (no values) | `live-07-tracker-private.png` |
| C3 | no profile | `no profile` (distinct word, no lock) | `live-08-tracker-no-profile.png` |
| C4 | not cached | `not cached` (unknown age, missing, >7 d, or unavailable) | `live-09-tracker-not-cached.png` |

`fetching`/`pending` is transient: the cell is **blank**, but it must resolve to one of C1–C4. A row
that is blank after the fetch settles, or any blank strip/row with **no stated reason at all**, is
the explicit FAIL. Capture it as `live-10-fail-blank.png` and quote the row's state inputs
(`isTrnPrivate`, `trnPlayerState`, `peekLivePlayerStatsAsOf`).
No value may be shown without an age; a zero or a dash is a failure even when it looks tidy.

## D. Stable row order across polls

1. Capture the visible player order (name#tag) plus party marks and team grouping at poll A.
2. Wait ≥ 2 poll ticks (~6 s), let TRN values land, capture poll B (`live-11-sort-poll-a.png`,
   `live-12-sort-poll-b.png`).
3. Order must be the payload/team order from both captures; only a lobby roster change may add/remove
   a row. Party marks move with their row; TRN arrival must not re-sort.
4. If order changes without a roster change: FAIL, attach both captures and the two arrays.

## E. Explicit fail cases (stop and report)

- Blank strip or blank Tracker cell with **no state word** after the fetch settled.
- Any invented value (zero, dash, guessed score, raw season id) in a missing slot.
- Strip is fixed/overlay, causes a horizontal shift, or covers the act header.
- Idle renders the old waiting card or an empty box.
- Row order changes across polls without a lobby change.

## Report

One PASS/FAIL line per A1–A4, B1–B4, C1–C4, D; screenshots named above; for each FAIL the exact DOM
text/state inputs and the log line if present. The real-match pass is the verdict; mock passes only
prove the geometry and state words.
