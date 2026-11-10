# alpha30 verification plan (run when the PC is free)

Build: **alpha30**, sha256 `930b5c65…` (mirrored; minisign verified). Do **not** install alpha29.
Starting state is unknown: the alpha30 install was abandoned mid-run when the user started playing.
**First action on resume: read the installed version. If it is not `v0.5.0-alpha30`, install alpha30
again before anything else.**

Baselines to diff against: `a28-modal.png`, `a28-modal-timeline.png`, and the alpha28 notes.

## 0. Setup

1. PC free; start the bridge tunnel `ssh -N -L 9223:127.0.0.1:9223 youssef-pc`.
2. Launch the app; confirm `v0.5.0-alpha30` in the sidebar.
3. Open Tracker → Matches and click a row **with a score** (cached detail). The modal must open.

## 1. Modal — four checks

| # | Check | How | PASS |
|---|---|---|---|
| M1 | Verdict hero | Read the modal header. `WIN 13–11` (or the actual score) must be the largest element: computed `font-size` **26px** on the verdict word and score; map/queue/date line computed **11px**. | 26px verdict, 11px meta line |
| M2 | One round navigation | The old read-only header mini-strip must be **absent**; only the interactive RoundRail exists above the round content. | exactly one round selector |
| M3 | Sticky scoreboard header | Set the tabpanel scrollTop to ~400; read `thead.getBoundingClientRect().top` against the panel top. It must stay pinned; background must be opaque (`bg-m3-surface-container-highest`, alpha 1) with no rows ghosting through. | thead pinned, opaque |
| M4 | Sticky RoundRail + shared selection | Click `#round-tab-3`, `#round-tab-9`, `#round-tab-16` (0-based ids; labels Round 4/10/17). After each click read: `#round-detail-panel` text (round heading/kills) **and** the economy line `Loadout $… · remaining $…`. Both must change and match the selected round; the rail must remain pinned while the content scrolls. | 3/3 both panes follow |

Also capture the modal **before** scrolling (`a30-modal.png`) and the timeline expanded
(`a30-modal-timeline.png`), then the scrolling state (`a30-modal-sticky.png`), and one frame per rail
click (`a30-round-4.png`, `a30-round-10.png`, `a30-round-17.png`).

## 2. Log checks

Read `C:\Users\youssefvdel\AppData\Local\com.recon.utility\logs\Recon.log` directly.

1. **Each line appears once** — no duplicate consecutive lines; the 500 ms body-dedupe at the sink
   must suppress double writes. Count occurrences of a repeated shape over the last 50 lines.
2. **Signed-out detail read** — with Riot at the login window, click a `NOT CACHED` row (or a match
   whose detail read fails) and read the log: it must say
   `[tracker] detail unavailable (signed out)`, not `[riot] read failed` on
   `/match-details/v1/matches/:uuid`.
3. Quote the exact lines in the report.

## 3. Regression spot-checks (were PASS on alpha28)

- Toast: bottom-right 24 px, main content does not move, auto-dismiss ~6 s.
- Window floor: interactive drag refuses below outer 1376×859 / inner 1360×850
  (bridge `resize_window` bypasses the floor — do not use it for this check).

## 4. Still blocked on the user

- Live board during a real match.
- Pre-Round panel.
- Signed-in sweep diff (two of the four modal fixes can be judged signed out; the verdict/side
  honesty spot-check needs a match with a missing side and a deathmatch row, neither of which the
  cache is guaranteed to contain — record what is available, never invent it).

## Output

One PASS/FAIL row per M1–M4 and per log check, screenshots named exactly as above, plus the exact log
lines. If any modal check fails, name it and stop — the modal is the user's "not good" surface.
