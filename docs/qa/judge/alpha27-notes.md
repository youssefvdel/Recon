# alpha27 — visual fixes, signed-out pass

Build `v0.5.0-alpha27` (sha256 `2f9a287f…`), Riot at the login window (signed out).

## UUIDs in Previous Acts — PASS (no ids), names still fallback

Whole Overview page UUID count **0**; Previous Acts renders three `ACT` labels, no raw ids.
`ACT` is the unknown-act fallback, not a name: the snapshot's `seasonNames` is **empty (`{}`)** —
this snapshot was written before names loaded. `saveSnapshot` persists `seasonNames` from the store,
so one signed-in refresh should populate it; verify the names survive the next offline load.
Screenshot: `a27-overview.png`.

## Banner — PASS, age included when the snapshot is old

Fresh snapshot: `Riot client not signed in — showing cached results` (age empty under 1 h, by design).
Aged the snapshot to 4 d and reloaded: **`Riot client not signed in — showing cached results from 4d ago`**.
Screenshot: `a27-banner-4d.png` (the snapshot timestamp was edited in localStorage for this test).

## Unached rows — PASS, one honest cell

9 rows with no `recon_match_v7_*` entry each render a single **`NOT CACHED`** cell; zero dashes in
those rows. The 11 cached rows are unchanged and show real scores (sample
`Bind 10th · 2:13 · 5/13/2 · −1244 · 41.7% · ACS 92`). Screenshot: `a27-matches.png`.

## Still to do

- Signed-in full feature sweep: Overview, Matches + match modal round timeline, Agents, Maps, Store,
  Crosshair, Resolution Switch, Pre-Picker, Settings — screenshots + log lines.
- Re-check act names after that signed-in write, then confirm they survive signed out.
- Live board during a real match remains the only unverified claim.

## Full feature sweep — signed in data, Riot client closed (login window)

Ran after the client returned to the login surface; data came from the cache/snapshot. Every surface
opened and rendered:

- **Overview** — no UUIDs (`uuidCount 0`); Previous Acts now **`V26:A6 · V26:A5 · V26:A4`** once
  `gameData`/seasonNames loaded (the first paint after a cold snapshot shows the `ACT` fallback until
  then). Screenshot `a27-overview-final.png`.
- **Matches** — 9 rows without a v7 entry showed a single **`NOT CACHED`** cell (zero dashes); after
  the details fetch completed all 20 rows carried real scores (`a27-matches-stable.png`). Opening a
  cached match gives the full scoreboard and **Round by round R1–R23 with loadout economics**
  (`a27-match-timeline.png`).
- **Agents** — 5 agents with time/matches/WR/K/D/ADR/ACS; portraits **blank for ~1–2 s while the CDN
  images load**, then correct (`sweep-agents-late.png`; the earlier frame showed empty portrait pills).
- **Maps** — 7 maps, win %, K/D, ADR, ACS; agent icons in Top Agents load the same way
  (`sweep-maps.png`).
- **Store** — featured bundle, daily offers with prices, accessories (`sweep-store.png`).
- **Crosshair** — full editor, profile list, imported crosshairs, live preview
  (`sweep-crosshair.png`).
- **Resolution Switch** — native/stretch panels and current display mode
  (`sweep-resolution-switch.png`).
- **Pre-Picker** — map cards, auto-hover controls (`sweep-picker.png` → `sweep-pre-picker.png`).
- **Settings** — updater/build/startup sections (`sweep-settings.png`).

Findings:
1. **Known cosmetic, not a defect:** agent portraits are blank on first paint for ~1–2 s while
   `media.valorant-api.com` resolves cold; the images then load correctly (`sweep-agents-late.png`).
   Do not file this as a regression.
2. **Stale legend copy**: Matches still says `— = match detail not fetched yet` while rows now read
   `NOT CACHED`; wording should match the new cell.
3. During the sweep the Riot client was closed, so live purchase / live-client actions were not
   exercised; panels used the cached data correctly and the log only shows the expected
   `[riot] … not responding / lockfile missing` lines.

Screenshots are in `docs/qa/judge/sweep-*.png`. Live board during a real match remains the only
unverified claim.
