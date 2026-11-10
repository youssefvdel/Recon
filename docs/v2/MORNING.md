# Good morning — what is waiting for you

Written overnight while the PC was off. Everything below was verified from this
server, not from memory.

## Open these first

| What | URL |
| --- | --- |
| **The app, running on Linux, with data** | http://192.168.100.2:5174/?fixture=lobby |
| **All three, one page** | http://192.168.100.2:8110/ |
| Theme A — Nocturne (editorial dark, serif display, violet) | http://192.168.100.2:8110/board-a.html |
| Theme B — Graphite (near-black, lime, condensed) | http://192.168.100.2:8110/board-b.html |
| Theme C — Ledger (warm paper, ink, red — the light one) | http://192.168.100.2:8110/board-c.html |

**Latest installable build (verified, mirrored):**
`http://192.168.100.2:8099/Recon_0.5.0-alpha33_x64-setup.exe` —
sha256 `b1b9f753…25c225ce`, Authenticode + minisign checked against
`77FD5160E2EB15E6`. This is the last checkpoint before the shell changes, so if
v2 misbehaves you roll back here.

The boards are served by `recon-v2-boards.service` (systemd user unit, enabled,
serving `~/Services/recon-v2-boards`), so they survive a reboot. I removed my own
duplicate copy on :8100 — one server for one thing. The app harness is a Vite server and needs restarting
with `bun run dev:ui --host 0.0.0.0 --port 5174` in `~/Projects/Recon-live`.

## The one thing I need from you

**Pick a theme: A, B or C.** The build is running on **Graphite (B)** as the
default so the night was not blocked, with **Nocturne (A)** as a second token
set. Switching is a token swap, not a rewrite — that is why it was safe to
proceed.

My reasoning, so you can overrule it in one word: Graphite has the best numeral
contrast on dark (you read this mid-match), it is the most distinctive of the
three, and it does not look like the violet MMR language every other tracker
uses. Ledger is the most striking but it is a light theme, which is a product
decision I did not want to make for you at 3am.

## The themes were measured, not eyeballed

Contrast ratios taken through the DOM on the live boards (`docs/v2/theme-contrast.md`):

| | info text | worst fail | accent as text / fill | focus |
| --- | --- | --- | --- | --- |
| A Nocturne | 17.47 / 7.64 | watermark 1.54 | violet 11.15 / 10.13 | **1.04** |
| **B Graphite** | 16.96 / 6.53 | watermark 1.93 | lime **15.19 / 14.43** | **1.03** |
| C Ledger | ink 13.24 | muted fails **30 of 36 uses** | red 5.12 / 5.41 | 14.65 |

So: **Graphite's lime is the strongest accent of the three** — that is why it is the
default. **A and B had no focus styles at all (1.03–1.04)** — they were keyboard-
unusable, which is now a token-level fix, not a preference. **C cannot ship as-is**:
one muted ink a touch darker fixes it. Every accent is usable as text *and* fill, so
no theme is limited to decorative dots.

## What was built overnight

- **The app now runs on Linux** with mocked Riot data — real Overview, Matches
  and Prep populated from fixtures (20 matches, 11 with full details, a 10-player
  lobby with incognito / unresolved name / no rank / hidden rank / private /
  not-cached cases). Production bundles are unaffected: `dist` contains zero
  harness strings.
- **Backend tests that run without Windows**: `src-tauri/pure` includes
  production files by path and runs **37 tests, 0 failed** —
  `cargo test --manifest-path src-tauri/pure/Cargo.toml`. The two extraction
  slices are the ones that could bite silently: the **TRN host/path allowlist**
  (suffix, userinfo, scheme-relative, `..`, 300/301 boundary) and the **updater's
  natural version order** (`alpha9 < alpha10`, which a string compare gets
  backwards).
- **Three theme boards**, rendered and served.

## Also landed overnight

- **A real 13.09 match payload** captured read-only, sanitized, committed
  (`src/dev/fixtures/matches/real-13.09.json`, 693 KB) with a shape doc
  (`docs/v2/payload-13.09.md`). The advanced-scoreboard tests now run against real
  Riot data instead of numbers I typed.
- **A token contract** (`src/v2/tokens.css`) — Graphite is the root set, Nocturne
  is `[data-theme='nocturne']`, and raw hex is legal nowhere else. Switching theme
  is one attribute, which is why choosing in the morning is cheap.
- **A shell spec** (`docs/v2/shell-b-spec.md`) with the IA: three destinations
  (Now / Matches / Prep), no sidebar, `⌘K` palette, `⋯` for tools.
- **`bun run verify` — the whole tree in one command, 11.7 s**: build, lint, all
  21 script checks, the 37 pure-Rust tests and the 16 bun tests, failing fast with
  the stage name. Proven red: a deliberately broken assertion exits 1 at the check
  stage and never reaches the Rust stage. Both CI workflows now call it, so the
  list cannot drift.
- **`bun test tests/` — 16 tests** on the write path (payload builder, deflate
  round-trip and canonical compare, storefront gate, write response contract).
  Those are the functions where a bug writes garbage into your config.

## A real bug found in the shipped app

**The KAST column has been wrong.** `MatchDetailBody.tsx:174` computed
`if (gotKill || !died)` — that is **two-way** KAST (kill or survive), so assists
and traded deaths earned nothing. Riot's KAST is four-way, so the column
systematically **under-reports**: five assisted rounds with no deaths scored zero.

Replaced with the four-way definition, with the number change called out in the
commit body — a silently corrected stat is worse than the wrong one, because
screenshots get compared across versions.

## Decisions I made overnight (all reversible)

1. **Engine stays, presentation is rebuilt.** `src/sources/`, `src/live/`,
   `src/cache/` and the Rust backend are untouched — that is where the app's
   real value is (validated transport, zero raw writes, twelve fabricated values
   deleted). Everything above the hook line is being rebuilt.
2. **Theme is data, not code.** Colour/type/space/radius live in one token file;
   a theme is a set of values.
3. **We do not copy the industry's lies.** No hidden MMR, no "smurf score", no
   0–1000 tracker score, no win probability. The evidence pack
   (`docs/v2/player-features.md`) quotes the demand for each and explains why a
   number would be invented rather than measured.

## Still unanswered — your call, not mine

- **Theme pick** (A / B / C).
- **IA**: should the app stay Now / Matches / Prep + ⌘K + ⋯, or go further — no
  sidebar at all, live-first?
- **Anything you specifically hate** in the current UI. One concrete complaint is
  worth ten "make it better".

## Honest status

The rebuild is **not finished** — the shell and the surfaces are being built from
the tokens tonight, with a parity checklist (`docs/qa/judge/parity-checklist.md`)
tracking every existing feature and the test that proves it. Anything that cannot
be verified without your PC is marked **UNVERIFIED** with the reason, never
silently passed.
