# Open work — 2026-11-10 06:09

Written immediately before a planned reboot (06:14) that completes the `/tmp`
RAM→SSD switch. Everything here survived the reboot: it is committed, pushed,
and written down rather than remembered.

## Shipping state

- `v0.5.0-alpha28` (tag `903f4b2`) — toast notices, PreRoundPanel, one
  `not cached` vocabulary, window floor 1360×850.
- `alpha27` — snapshot TTL no longer deletes (age shown instead), act names
  cached, single `Not cached` row.
- Main is clean and pushed. Worktree `Recon-live` is clean at `5bfa4fb`.

## In flight (design phase, not code)

**Full UI refactor — three independent directions.**
`ui-audit` is producing **A** and **B**, `overlay-audit` **C**, each as a
rendered board (`design/board-*.html`) showing Overview · Matches · Match
detail, plus type scale, colour-role table, card policy, nav/tab model and
build cost. The user picks from screenshots. Do not start implementing a
direction before one is picked.

The match-detail audit that prompted it stands on its own and should be read
first: one scroll does three jobs, two round navigations, flat hierarchy
(the map name is the largest thing, the result is a small chip), 14 cramped
columns, and mint/coral carrying four meanings (team, win/loss, K/D sign,
ATK/DEF).

## Next units of work, in order

1. **Four direction-independent modal fixes** (ui-audit's list, one commit):
   delete the header mini-strip, verdict hero `WIN 11–13`, sticky scoreboard
   header, single sticky round rail hoisted out of `RoundTimeline`.
2. **Design direction pick** → implement across surfaces.
3. **PreRoundPanel in-match verification** — the widget exists and is wired
   (`showPreRound`, `positions.preRound`), but nobody has seen it in a real
   agent select. Score renders only when both sides are numeric; round number
   is absent by design (the payload has no such field).
4. **The live board during a real match — still the only unverified claim in
   the project.** Everything upstream is measured.

## Known gaps, deliberately not fixed

- `riotPut`/`riotPost` are still exported and used raw by `crosshair.ts`,
  `prepick.ts`, `store.ts`. GET is fully validated; PUT/POST is not.
- Agent portraits blank ~1–2 s on cold load while `media.valorant-api.com`
  resolves. Cosmetic, logged as such — do not treat as a regression.
- `detailsById` is deliberately excluded from the account snapshot (928 kB vs
  quota), so a match never opened before stays `not cached` while Riot is
  closed. That is intended behaviour.

## Environment fact worth remembering

`/tmp` was a 12 GB **RAM** disk that filled twice and pushed the box into
6.6 GB of swap; filling it kills every shell tool with `EDQUOT (-122)`.
`tmp.mount` is now masked, `/etc/tmpfiles.d/tmp.conf` deletes files older than
2 days, and the harness runs with `TMPDIR=/home/youssefvdel/tmp`. Bulk temp
belongs on `/home` or `/mnt/data`, never `/tmp`. Post-boot verification is
written to `/var/log/postboot-check.log` by `postboot-check.service`.
