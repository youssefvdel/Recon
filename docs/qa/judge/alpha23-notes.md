# alpha23 judge notes — hotfix unjudged, plus finding A23-1

Build: `v0.5.0-alpha23`, sha256 `92d8fc66…`, embedded runtime intact, firewall rule present.
This launch could not judge the shard hotfix because the Riot client is at the **launcher surface**:
its local API answers 404 for every authenticated endpoint while the unauthenticated root answers
401, and `local_entitlements` returns `Riot Client not responding — launch it and retry`. The
aggregation code never ran, so "empty Matches" on this launch is a login-state observation, not
evidence against `23c40da fix(sources): match details dial the shard again, not https://eu`.

## A23-1 (ours): a logged-out Riot client hides history that is on disk

**Symptom.** Riot client logged out/at launcher: Matches shows every row as `SCORE — Score not
fetched yet`, `K/D — Match detail not fetched yet`; clicking a row opens nothing. Overview keeps
cached profile numbers, but the history list refuses to render.

**Evidence (this launch).**
- `localStorage` holds **11 valid `recon_match_v7_*` entries**; sample: 10 players, 23 rounds,
  23 roundDetails, `teamScore {Red:13, Blue:10}`. The bytes needed for the list are on disk.
- `useTrackerData.refresh()` fetches entitlements/profile first; when that throws, control jumps to
  the catch **before** `aggregateDetails` is queued (`src/hooks/useTrackerData.ts:611-637`).
  `aggregateDetails` is the only path that merges `fetchMatchDetailDirect` results into
  `detailsById`, so the cache is never consulted.
- `fetchMatchDetailDirect` itself is cache-first and would have returned those entries without a
  network call (`src/sources/matchDetails.ts:116-130`).
- `local_entitlements` failure and the 404/401 split recorded above; `MainWindowTitle` empty.

**Why it matters.** Every byte of history is local and immutable; a login expiry makes the whole
Matches/Overview history disappear. This is the same class as the regressions catalogue rule
"a failed read is not incomplete data" — here a failed *auth* is being rendered as "no history".

**Suggested fix direction (lead decides).** Render cached `detailsById` / `games` before requiring
entitlements, with a banner such as "Riot client not signed in — showing cached results"; only the
live/rank reads should be gated on auth. Do not clear or overwrite the caches on that path.

## Authenticode note

`Get-AuthenticodeSignature` returns `UnknownError` with signer `CN=Youssef Adel, O=Recon, C=EG`.
That is the expected self-signed chain on this machine, not a release failure — minisign is the
release signature. Recorded so the next reader does not mistake it for a broken build.

## Still to judge when the login lands

1. Matches/Overview aggregation populates from existing history (the `23c40da` hotfix).
2. Ranks, peak and Tracker values unchanged.
3. Live board during a real match.

## After the Riot login (03:47) — hotfix PASS

The login landed and a manual "Refresh all data" immediately populated everything:

- **Matches: PASS.** 0 occurrences of "not fetched yet"; all rows show `SCORE 13 : 10`, K/D/A, DDΔ,
  HS%, ACS (sample: Summit 13:10 · 13/17/13 · −949 · 31.4% · 151; Sunset 13:7 · 17/13/8 · +513 ·
  28.3% · 230). Header now reads `11W - 9L (55%) · 0.8 K/D | 115 ADR`. Screenshot:
  `docs/qa/judge/a23-matches-after-login.png`.
- **Overview: PASS.** `WIN % 45% · K/D 0.8 · HS 30.0% · ADR 116`, Previous Acts, and
  `Tracker Score as of Nov 10 03:47 AM — 148` with percentiles. Screenshot:
  `a23-overview-after-login.png`.
- **Storage: PASS.** `recon_live_player_stats_v3`, `recon_live_rank_v1`, `recon_trn_cache_v2` present;
  11 `recon_match_v7_*`; zero v5/v6/v1.
- **Static integrity: PASS.** `riotGet` exists only in `sources/riot.ts`; tracker has 0 raw sites;
  `devqa-check.ts` all green (header count + exclusivity + import checks); build and lint green;
  both `build-windows.yml:53` and `release.yml:74` run `cargo test --lib` before bundling.

**Recon.log is not yet a usable instrument for this class.** This launch's log contains only
window/display/overlay lines (`[window] main frame delta …`, display bridges); there are no
transport, match-detail, or Riot-read entries at all. The hotfix failure could not have been
diagnosed from it — the 404/401 probe and the bridge did that work. Worth instrumenting the
transport/reader boundary before relying on the log in release triage.

## alpha24 — A23-1 partial PASS (board survives, details do not)

Two runs, same result: a stubbed `local_entitlements` failure and the **real signed-out client**
(user quit Riot at 04:14:53; refresh immediately after):

- Banner: **"Riot client not signed in — showing cached results"** — PASS.
- The 11 cached match rows **stay** (no empty list) — PASS.
- Every row still reads `SCORE — Score not fetched yet`, `K/D — Match detail not fetched yet`,
  `DDΔ/HS%/ACS — … not fetched yet` (55 placeholders = 11 × 5) — **details are not merged**.
  This is the open part of A23-1: `detailsById` stays empty even though 11 valid `recon_match_v7_*`
  entries are on disk; the merge is swallowed by `.catch(() => {})` in the hydration path.
- `Recon.log` during the real signed-out run gained **no `[riot]` line at all**; the tail still holds
  only window/display lines (`04:13:34`, `04:13:42`). The instrumentation did not fire on the
  entitlement failure or on the swallowed merge throw.

Screenshots: `docs/qa/judge/a24-stub-signedout.png` (stub) and `a24-signedout.png` (real).

## alpha24 startup defect — windowless process on first launch after install

First launch right after the installer: `recon.exe` PID 13136 started 04:12:23, version
`0.5.0-alpha24`, `Responding=True`, **`MainWindowTitle` empty**, no new startup line in `Recon.log`
(last was alpha23's 03:31:48). Bridge `list_windows` returned `[]` for ~90 s. Killing it and running
`ReconLaunch22` again produced the main window immediately (`list_windows` showed `main` + `overlay`).
Sequence: install → task launch → windowless process; kill → task launch → window. Reproduce on the
next installer to confirm.

## alpha25 — cold start PASS, signed-out still FAIL

**Cold start (install → launch, no kill): PASS.** Launch 04:36:40; `[boot] setup reached - config
windows exist` at 04:36:58, frame delta 04:36:59. Bridge `list_windows` showed
`[('main', True)]` at **T+45 s (04:37:28), T+120, T+180 and T+300 s** — the window exists early; the
alpha24 windowless process did **not** reproduce. `Get-Process recon | MainWindowTitle` stayed
**empty even while the bridge showed a visible `main`**, so PowerShell's property is unreliable for
this test; the bridge is the metric. The alpha24 event is closed as a one-off cold init on the
freshly installed runtime.

**Signed-out test (user quit Riot 04:14:53, still signed out): FAIL.** On alpha25 the banner
(`Riot client not signed in — showing cached results`) and 11 rows survive, but **all 11 rows still
show 55 placeholders** (`SCORE — Score not fetched yet`, `K/D — Match detail not fetched yet`, …).
11 `recon_match_v7_*` entries on disk; snapshot has 20 games; intersection 11. Screenshot:
`docs/qa/judge/a25-signedout.png`.

What the exported log bundle shows (the only place our new instrumentation is visible):

```
[2026-11-10T02:39:09.505Z] warn [riot] entitlements failed {"kind":"Riot Client not responding — launch it and retry."}
[2026-11-10T02:39:11.537Z] warn [riot] read failed {"host":"pd.eu.a.pvp.net","path":"/match-details/v1/matches/:uuid","status":0,"kind":"transport"}
```

No `[tracker] cached merge` line — neither `merged-nothing` nor `threw`. The merge started (it dialled
an uncached id and logged the transport failure) but never reported a result within the ~90 s the
test observed; the cached 11 were never applied. Candidate causes: a refresh race overwriting
`detailsById`, or `aggregateDetails`' `Promise.all` waiting on the uncached ids (each behind the Riot
gate) before returning any `byId`. Not yet proven; the next build should log the completion path.

## A23-2 — the JS logger cannot write to `Recon.log`

`logger.warn` in `src/utils/logger.ts` pushes to the in-memory ring buffer only; in production it
does not write a file and does not console. Rust `log_line` writes `Recon.log`. So `[riot] read
failed`, `[riot] entitlements failed` and `[tracker] cached merge` are **invisible in `Recon.log`**
— the file we use for triage — and only appear in Settings → Download logs. The instrumentation is
correct in content; the sink is missing. Recorded as its own finding; the judge record expects the
log file to be the triage surface.
