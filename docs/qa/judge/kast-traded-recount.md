# KAST traded deaths — independent recount

Fixture: `src/dev/fixtures/matches/real-13.09.json` (28 rounds, 207 kills, patch 13.09).
Recount done from the raw payload **before** reading `src/live/advancedStats.ts`.
Subject PUUIDs are the fixture placeholders; teams are Blue/Red.

## Method

A death is traded when **the killer is killed by a teammate of the victim in the same round**.
Three definitions were counted separately because the sources disagree:

- **A — lead's stated definition (no time window):** killer dies before the round ends.
- **B — community 5 s:** killer dies to a teammate within **5,000 ms** of the victim's death.
- **C — community 3 s:** same, within **3,000 ms** (Riptide's window).

Deaths are counted, not rounds: a player can die twice in a round (the fixture has such rounds for
Player2 in rounds 6, 11 and 19, 1-based).

## Totals for the first three players

| Player | Deaths | A: no window | B: ≤5 s | C: ≤3 s |
|---|---:|---:|---:|---:|
| Player1 `…0007` (Blue) | 17 | **9** | **4** | **3** |
| Player2 `…0008` (Red) | 24 | **13** | **6** | **6** |
| Player3 `…0001` (Red) | 24 | **20** | **14** | **10** |

`computeAdvancedStats` (same fixture, same players) returns **15 / 23 / 23** traded deaths.
It matches **none** of A, B or C.

## Player1 — per-round working (A, no window)

Traded rounds are bold. `Δ` is avenger kill time minus death time; avenger is always Player1's
teammate (Blue) in this fixture.

| Round | Death t (ms) | Killer | Avenger t (ms) | Δ | Traded? |
|---:|---:|---|---:|---:|---|
| 3 | 320,317 | Player7 | — | — | no |
| 4 | 398,126 | Player3 | — | — | no |
| 6 | 566,246 | Player8 | 572,855 | +6,609 | **yes** |
| 8 | 722,501 | Player2 | — | — | no |
| 9 | 795,941 | Player2 | 797,539 | +1,598 | **yes** |
| 12 | 1,000,600 | Player4 | 1,027,629 | +27,029 | **yes** |
| 13 | 1,109,950 | Player3 | 1,110,857 | +907 | **yes** |
| 14 | 1,184,314 | Player2 | 1,188,734 | +4,420 | **yes** |
| 16 | 1,370,895 | Player2 | — | — | no |
| 17 | 1,498,005 | Player7 | — | — | no |
| 18 | 1,565,791 | Player3 | 1,585,818 | +20,027 | **yes** |
| 19 | 1,642,175 | Player4 | 1,664,661 | +22,486 | **yes** |
| 23 | 2,130,789 | Player2 | — | — | no |
| 24 | 2,176,355 | Player3 | — | — | no |
| 25 | 2,295,884 | Player2 | — | — | no |
| 26 | 2,383,511 | Player4 | 2,391,607 | +8,096 | **yes** |
| 28 | 2,533,035 | Player2 | 2,535,318 | +2,283 | **yes** |

Traded deaths: **9** (rounds 6, 9, 12, 13, 14, 18, 19, 26, 28). The 5-second definition keeps only
rounds **9, 13, 14, 28** (4). Rounds 6, 12, 18, 19, 26 fall outside 5 s.

## Why the implementation reports 15 / 23 / 23

Two independent defects in `advancedStats.wasTraded` / `tradedDeaths`:

1. **Adjacent-round leak.** `sameRound(a, b)` is `a === b || a === b + 1`, intended for a 1-based
   kill feed. But the mapper copies `roundResults[].roundNum` into both `kills[].round` and
   `roundDetails[].roundNum`, and this fixture is **0-based (0…27)**. A killer who dies in round
   `r+1` therefore counts as avenging a death in round `r`.
2. **Per-round amplification.** `tradedDeaths` counts every death whose **round** is traded, not the
   specific death; `wasTraded` also matches deaths one round apart in both directions. Multi-death
   rounds then count both deaths, and a traded death in `r` can mark a death in `r+1`.

Player1: strict traded rounds are 6, 9, 12, 13, 14, 18, 19, 26, 28; the implementation adds
**8, 16, 17, 23, 24, 25** — every extra is a next-round avenger. Player2 adds **2, 6, 9, 10, 12, 15,
20, 22, 27**; Player3 adds **21, 22, 27**. There are **no strict-only rounds** — the implementation is
a strict superset, never misses a real trade.

## Definition and verdict

Riot does not publish KAST as an official stat; it is a community metric, so "how Riot defines it"
is not available. Community sources differ on the window:

- Riptide Stats: traded when the killer dies to your team within **3 seconds**
  ([source](https://riptidestats.com/guides/valorant-trade-kills-explained)).
- THESPIKE.GG (KAST definition) uses **5 seconds**
  ([source](https://note.com/execut1ve/n/nb37ddc15c9f1?hl=en)); KAST itself is defined as
  kill / assist / survive / traded ([esports.net](https://www.esports.net/wiki/guides/what-is-kast-valorant/)).

**Verdict: the implementation is wrong, not the recount.** Pick **5 s + same round + teammate only**
(the most common tracker convention, and the definition the eventual test should encode). Correct
values for this fixture are **4 / 6 / 14**; using the lead's no-window definition gives **9 / 13 / 20**
— the implementation's 15 / 23 / 23 is wrong under both.

**Change the code, not the test:** make `sameRound` an exact equality (or normalize both sources to
the same base first) and add the 5 s window to the teammate avenger check. Then assert the 5 s values
(4 / 6 / 14); if the team chooses no-window, assert 9 / 13 / 20 instead. Do not ship 15 / 23 / 23
under any definition.
