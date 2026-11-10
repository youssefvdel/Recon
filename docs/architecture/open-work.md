# Open work — 2026-11-10 08:46

Rewritten after the UI direction was chosen (**B — Season Stream**) and the first
two migration steps landed. The previous version of this file (06:09) described a
state that no longer exists; this one is the live picture.

## Shipping state

- `v0.5.0-alpha31` (tag on `0aee253`) — Tab show-path fix (`d0f221d`), Retry fix,
  2a (match body extracted). **Published, not mirrored, recorded as superseded.**
- `v0.5.0-alpha30` — last build on the LAN mirror.
- `alpha32` is **cut-ready but blocked** on the 2b/2c rework below, not on CI.
  Notes are finalised at `/home/youssefvdel/tmp/recon-alpha32-notes.md`.

## In flight — Matches (migration step 2)

2b and 2c are implemented in worktree `Recon-live` (`refactor/live-stats`,
rebased onto main: `46983dd` one-expansion, `4855d5a` modal deleted) and the
design judge **failed two of four rules**:

1. **Dialog semantics survived the move.** `MatchDetailBody` still carries
   `role="dialog" aria-modal="true"`, a focus move into a close X, and a close
   button. In a ledger row that is a modal docked in a list, not an expansion.
2. **Nested dialog.** It still mounts `PlayerOverviewModal` as a dialog;
   migration step 2 says drawer.
3. **The feed→ledger hand-off is lost.** `Overview` dispatches
   `recon:goto-match` before `App` switches tab, `App` keeps no id, and
   `MatchHistory` only registers its listener on mount — so the click lands on
   Matches with **nothing expanded**.

Fix owner: ts-client. Judge: ui-audit. Merge, then cut alpha32.

**Rule worth keeping from this:** a green build is not a UX verdict — the CI was
green while the behaviour was wrong.

## Done and verified (do not re-open)

- **UI direction chosen: B (Season Stream).** Boards A/B/C are on disk as
  rendered HTML (`design/board-{a,b,c}.html`) with screenshots in
  `docs/design/shots/`. B is the one being built.
- **Overview rebuilt** — 815 → 373 lines, 27 card tokens → 0, eight cards and
  five local components deleted. Judged PASS twice; Retry proven by request
  count (`actFetchKey` + nonce), not by reading code.
- **Unrated playlist restored** after a redesign commit had quietly deleted it.
- **Colour contract** — mint/coral mean a resolved outcome only; the HUD, the
  board and `primitives/colors.ts` all obey it.
- **Overlay Tab-lag fix** (`d0f221d`) — style pass and cursor-events only on
  change, duplicate `set_shadow` gone, occlusion flags added, visibility-return
  fetch deferred 300 ms. Logs `[perf] overlay show Nms` above 5 ms.
- **Data layer** — single validated transport in `sources/riot.ts`; tracker has
  zero raw call sites; `ranked` privacy is `ready`.
- `docs/design/{audit,migration-b,overview-b-spec}.md` hold the full reasoning.

## Next after Matches

Migration steps 3–9 from `docs/design/migration-b.md`: live strip → Prep (Agents +
Maps fold) → Tools as anchored sections → shell (act scrubber, ⌘K, sidebar
removal) → Settings dialog → cleanup → **HUD last**.

## Still unverified — the only item needing him

**The live board during a real match, and the Pre-Round panel during agent
select.** Both are built and wired; nobody has seen either in a live game on a
current build. Everything else has been measured.

## Known gaps, deliberately not fixed

- `riotPut`/`riotPost`: prepick converted; **storefront in progress** (rust-proxy);
  `crosshair.ts` remains raw (real write, needs read-back — its own session).
- Agent portraits blank ~1–2 s on cold load while `media.valorant-api.com`
  resolves. Cosmetic.
- `detailsById` is excluded from the account snapshot (quota), so a match never
  opened stays `not cached` while Riot is closed. Intended.

## Environment

`/tmp` is disk-backed since the 06:14 reboot (`tmp.mount` masked, 2-day cleanup,
`TMPDIR=/home/youssefvdel/tmp`). RAM went from 5.8 GB used to 1.2 GB. Bulk temp
belongs on `/home` or `/mnt/data`, never `/tmp` — a full `/tmp` kills every shell
tool with `EDQUOT (-122)`.
