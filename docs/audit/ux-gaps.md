# Recon — product / UX gap audit

Read-only audit, 2026-11-07, branch `fix/trn-captcha` (HEAD `d648050`). No app run:
Recon is Windows-only and this host has no Windows toolchain, so every finding is
evidence from source, not a live reproduction. Scope: the gaps that make a player
stop using the app or never start it — not visual polish.

Ranked by value ÷ effort. `H/M/L` = value to the player; `S/M/L` = implementation
effort. Findings 10 and 12 are the biggest *absolute* risks; they sit lower only
because they cost more than a copy/state fix.

---

## 1. The app tells users "Nothing leaves this PC" — then sends their Riot ID to a hardcoded IP over plain HTTP — H / S

**Breaks:** a privacy-conscious player reads the consent copy, trusts it, and is wrong.
`sendPulse` POSTs `{ riot_id, ts, version }` on every launch to
`http://154.176.122.255:9736/pulse` — cleartext, fixed IP, no consent gate.

**Evidence:** `src/components/ConsentModal.tsx:26` ("Local game data + public
tracker.gg stats. Nothing leaves this PC.") · `src/utils/ops.ts:22` (PULSE_URL) ·
`src/utils/ops.ts:79-99` (payload) · `src/App.tsx:158` (called every launch) ·
`src/App.tsx:143` ("The first-run consent popup is gone") · `hasConsented()` at
`src/utils/consent.ts:15` is never called.

**Fix:** re-arm the first-run modal (wire `hasConsented()`), say exactly what the
heartbeat sends and to whom, add a Privacy toggle, switch the URL to HTTPS (or drop
the pulse). Update the modal's stale "tracker.gg stats" line at the same time.

## 2. "Riot Client is open" is only "a lockfile exists" — logged-out or crashed client leaves Overview as skeletons forever — H / S

**Breaks:** first launch after installing Riot Client but before logging in (or after
a crash leaves a stale lockfile) — Overview shows loading skeletons forever. The
error toast appears once and self-dismisses; there is no button and no explanation.

**Evidence:** `src-tauri/src/tracker.rs:26-34` (`lockfile.exists()` only; the comment
at `:36-37` admits a stale lockfile is possible) · `src/hooks/useTrackerData.ts:323-399`
(`running` true → `detectLocalAccount()` throws → the catch at `:593` sets only
`banner`; `clientClosed` stays false) · `src/components/Overview.tsx:266-295`
(`!profile && !clientClosed` → `OverviewSkeletons`, no timeout) · toast at
`Overview.tsx:129-134`.

**Fix:** after one failed detection, render the existing "Riot Client is closed"
card with a "Sign in to Riot Client" line + Refresh; keep skeletons only for the
first in-flight attempt. Same for a stale lockfile.

## 3. Switching accounts can kill a live VALORANT match with no guard — H / S

**Breaks:** a player in a ranked match clicks Switch (the confirm copy mentions the
game only in passing) and the app closes Riot Client + VALORANT — a leaver penalty.
The updater already refuses to install during a live match; account switch does not.

**Evidence:** `src-tauri/src/accounts.rs:825-828` (`kill_clients()` after resolving
the exe, no live check) · `src/components/AccountsView.tsx:303` and `:559` (copy:
"closes Riot Client + game") · the updater's guard lives at `src/App.tsx:216`
(`getInstallBlocker`), unused here.

**Fix:** call `getInstallBlocker()` / `peekLiveMatchState()` before `account_switch`;
refuse with the same "finish the match first" copy.

## 4. Stale tracker.gg promises remain in the UI — M / S

**Breaks:** a player follows instructions for a data source that no longer exists.
The private-profile panel tells them to sign in on tracker.gg; the consent modal
promises tracker.gg stats; the TS column is permanently "unavailable".

**Evidence:** `src/components/PlayerOverviewModal.tsx:410` ("Private tracker
profile — sign in on tracker.gg to make it public.") · `ConsentModal.tsx:26` ·
`src/components/LiveMatchView.tsx:816-824` ("Tracker Score: unavailable" for every
player) · `src/components/MatchHistory.tsx:758` promises the tab fills from the
Riot Client while the Tracker Score column still depends on TRN.

**Fix:** delete the tracker.gg instruction; hide the TS column/badge when TRN is
cold; rewrite the empty-state copy around local data.

## 5. No in-app way to reset local data or caches — M / S

**Breaks:** a stuck snapshot, a bad cached account, or corrupt TRN cache can only be
cleared by hand-deleting `%APPDATA%\Recon`. Settings has five sections and none of
them is data.

**Evidence:** `src/components/AppSettingsView.tsx` sections at `:413` (updates),
`:622` (startup/tray), `:716` (in-game), `:857` (overlay monitor), `:900` (about) ·
snapshot TTL 24 h at `src/hooks/useTrackerData.ts:37` · `clearAccountSnapshot` is
only called on account switch (`useTrackerData.ts:398`).

**Fix:** a "Reset local data" section: snapshots, TRN file cache, dismissed notices,
crash log; confirm-then-clear and relaunch.

## 6. A pinned overlay monitor that disappears is silently ignored — M / S

**Breaks:** a player unplugs the second monitor; the overlay jumps to the game
monitor while Settings still shows the missing monitor selected (blank control).
Nothing says the pin was dropped.

**Evidence:** `src-tauri/src/window_manager.rs:528-546` (`overlay_monitor_rect`
returns `None` when the device is not attached/enabled → `overlay_target_rect`
falls back to the game/nearest monitor) · `src/components/AppSettingsView.tsx:882-886`
(select keeps the stale device name).

**Fix:** on settings load, if the saved device is absent, reset to `auto` and show
"Monitor disconnected — overlay is back on the Valorant window."

## 7. Auto-borderless toggle silently no-ops when the backend refuses — M / S

**Breaks:** the checkbox flips on, the player expects borderless automation, and
nothing happens and nothing is said.

**Evidence:** `src/components/UnifiedStretch.tsx:89-95` — localStorage write and
`setAutoBorderlessIpc(enabled).catch(() => {})`; the UI state is already flipped.

**Fix:** await the IPC, revert the toggle and show the error on failure.

## 8. First run has no orientation — every feature explains itself only after you find it — M / S

**Breaks:** a new user lands on Overview and has to discover that Riot must be
logged in, that the Live tab needs Valorant in a match, that a global hotkey drives
stretch, and that the overlay has a monitor setting. There is no welcome card,
checklist, or "what to start first".

**Evidence:** `src/App.tsx:97` (default tab; no onboarding component exists) · the
only proactive guidance is the Riot-closed card at `Overview.tsx:270-283` · passive
per-tab hints at `src/components/LiveMatchView.tsx:316` and
`src/components/MatchHistory.tsx:758`.

**Fix:** one-time "Getting started" card on first launch (4 steps: open Riot Client
and sign in → queue → the Live tab → hotkey/overlay settings), dismissible and
re-openable from Settings.

## 9. Synthetic "Tracker Rating Score" is presented as a measured value — H / M

**Breaks:** every match card shows "Tracker Rating Score: N / 1000 — Tier X" that
is now generated by a formula, not measured. Since TRN died, `realTrs` is never
present, so the fallback is the only value users ever see. This contradicts the
repo's own "never invent a number" rule.

**Evidence:** `src/utils/trn.ts:1803-1822` (`calculateTrsFallback`, commented
"Harmonized fallback formula") · `src/components/MatchHistory.tsx:470-477`
(`fallbackTrs` wins whenever `realTrs` is missing) and `:229-235` (rendered as the
real score) · `src/components/MatchDetailModal.tsx:846` (same claim).

**Fix:** hide the score or label it plainly ("estimated, not Tracker Score") and
remove the fallback path from user-visible copy.

## 10. The in-app updater has no automated publisher; updates depend on one manual signing ritual — H / M

**Breaks:** if a release is cut without the minisign `.sig` + `latest.json`, every
installed app silently stops offering updates (the failure only shows in Settings).
CI cannot produce a releasable updater payload at all today.

**Evidence:** `.github/workflows/build-windows.yml:52` (`tauri build --no-bundle`)
and `:84` (uploads `recon.exe` only); there is no release workflow (only
`build-windows.yml` + `deploy-website.yml`) · updater endpoint is
`plugins.updater.endpoints` in `src-tauri/tauri.conf.json`
(`releases/latest/download/latest.json`) · `RELEASING.md` "Cutting a release"
requires a manual `TAURI_SIGNING_PRIVATE_KEY` and warns a missing `.sig` means
updates are refused; losing `recon.key` strands every install.

**Fix:** tag-triggered release workflow: build the NSIS bundle, sign with
`TAURI_SIGNING_PRIVATE_KEY` from secrets, assemble `latest.json` with
`scripts/make-latest-json.mjs`, and fail the job if `*.sig` is absent. Keep the
Authenticode step (it is a separate signature and does not satisfy Tauri).

## 11. Acts longer than 10 games blank the lobby K/D, ACS and win% — with the wrong reason on hover — M / M

**Breaks:** by mid-act most players have more than 10 competitive games, so the
local scan refuses and the lobby row shows no K/D / ACS / win%. Hovering a blank
cell reports a TRN pending/unavailable reason, not the real "act too long" one.

**Evidence:** `src/utils/tracker.ts:2305` (`LOCAL_ACT_MAX_MATCHES = 10`), `:2374-2377`
(throws `LOCAL_ACT_TOO_LONG` before fetching), `:2430-2439` (rank only + 5-minute
retry, `actState: 'too-long'`) · `src/components/PlayerOverviewModal.tsx:433`
explains the cap correctly, but `src/components/LiveMatchView.tsx:612,890` renders
`trnBlank(p.trnState)` (TRN state), so the row-level tooltip names the wrong cause.

**Fix:** surface the real reason in the row ("act too long to scan — rank only"),
and/or page past 10 matches with a bounded budget so normal acts get numbers.

---

### Also worth flagging, not ranked

- `src/components/TrackerMini.tsx:163` returns `null` when Riot is closed and no
  cache exists — the sidebar card silently disappears instead of saying why.
- `src/components/ConsentModal.tsx:26` will stay wrong even after the pulse decision
  unless the copy is rewritten with it (tracked in finding 1/4).
- Updater errors are only visible in Settings (`src/utils/updater.ts:263,282`);
  nothing tells a player whose auto-update failed unless they open the page.
