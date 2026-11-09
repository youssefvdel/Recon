# Regression catalogue — the eleven bugs of 2026-11-09

Written after the alpha9→alpha16 marathon. Each entry is the user-visible symptom, the one-sentence root cause, where it lived, why our tests did not catch it, and the check that must exist from now on. Keep this file ahead of the next refactor.

## 1. Bundled WebView2 runtime was incomplete → zero windows
**Symptom.** Installer succeeds, app launches, no window ever appears and no `msedgewebview2.exe` child exists.
**Root cause.** The NuGet `webview2.runtime.x64` payload ships `msedge.dll.sig` but not the 341 MiB `msedge.dll`, so the loader cannot start a browser and Tauri's fixedRuntime has no fallback.
**Where.** `scripts/fetch-webview2.mjs:5-6` (the note) and `:39-40` (size-gated `REQUIRED` list); `docs/overwolf/webview2-runtime.md:99-100`; `src-tauri/tauri.conf.json` `bundle.windows.webviewInstallMode`.
**Why missed.** CI builds on runners with a system WebView2; nothing asserted the runtime folder's contents or launched the packaged app on a clean machine.
**Check.** Bundle assertion: `msedge.dll` ≥ 300 MB plus every fixed-runtime file; clean-VM smoke launch must observe a `msedgewebview2.exe` child of `recon.exe` and at least one window within a bound.

## 2. `fixedRuntime` path with a `./` prefix → loader rejects the folder
**Symptom.** Same silent zero-window startup, with a valid runtime folder sitting next to the exe.
**Root cause.** The config pointed at `./Microsoft.WebView2…/`; that spelling was not resolved to the folder shipped beside the exe, so WebView2 environment construction failed with the runtime present on disk.
**Where.** `docs/overwolf/webview2-runtime.md:130-136` (the bad config quoted); current good config uses `"path": "webview2-runtime"` in `src-tauri/tauri.conf.json`.
**Why missed.** The build machine happened to resolve the path; no test asserted the config value or the installed layout.
**Check.** Config test rejects any `fixedRuntime.path` containing `./` or `..`, and the installer test asserts the folder exists beside `recon.exe` and starts a webview.

## 3. MCP bridge bound to all interfaces in a release build
**Symptom.** Any device on the LAN can execute JS inside Recon and invoke its commands — an unauthenticated remote control.
**Root cause.** `tauri-plugin-mcp-bridge` defaults to `0.0.0.0` and was registered unconditionally, so shipping builds opened `9223` to the network.
**Where.** `src-tauri/src/lib.rs:1039-1040` (loopback builder); the earlier bug was the same init without `bind_address`; fixed in `d3d8daf`.
**Why missed.** The bridge was treated as a dev-only tool; no test asserted the listener address, and nobody probed from another machine.
**Check.** Release launch asserts every listener owned by the recon PID is loopback, and an off-box `curl`/WS attempt against `9223` must fail.

## 4. Direct transport says `TRN_NO_DATA`, negative cache only knew `HTTP 404`
**Symptom.** The board sits on "fetching" forever; the fill spends its budget re-asking for players Tracker does not have.
**Root cause.** Two transports report a missing player differently; the negative registry matched only `HTTP 404`, so direct-transport misses were never cached as terminal.
**Where.** `src/utils/trn.ts:515-521` (both shapes) and `:371-383` (versioned registry).
**Why missed.** Error-path fixtures only used the edge shape; the direct path had no "missing" fixture at all.
**Check.** Table-driven test: `HTTP 404` and `TRN_NO_DATA` both settle as terminal "missing"; one fill per lobby, no re-query on the next poll.

## 5. Fullscreen pause written for the webview was applied to the Rust transport
**Symptom.** The board is empty during matches and fills before/after — exactly when it is needed most.
**Root cause.** The pause existed because the edge transport evaluates JS in a window; it was applied to both transports, so the reqwest path refused too.
**Where.** `src/utils/trn.ts:200` (`canServeDirect`) and `:286` (`transportGet`); the Rust-side pause is `src-tauri/src/trn_proxy.rs:791`.
**Why missed.** No test ran a transport during a simulated fullscreen, and the gate was tested against one transport only.
**Check.** Integration test: during fullscreen a direct path must proceed, an edge-only path must return `EDGE_PAUSED`; the decision must come from one shared predicate.

## 6. `/mmr` skipped `assertRiotOk` → an error parsed as "Unrated"
**Symptom.** Mid-match every row renders "Unrated", wiping known ranks.
**Root cause.** The live coregame MMR read fed the response straight into the rank parser, so a 403 or downtime payload became tier 0.
**Where.** `src/utils/tracker.ts:694` (guard) and `:3794` (live read now guarded); fix `6757061`.
**Why missed.** Rank-parser tests only used valid payloads; no error shape ever reached it.
**Check.** Parser test with `{httpStatus: 403}` / `{errorCode: …}` must throw or keep the last known rank (marked stale), never emit tier 0.

## 7. Updater could offer a downgrade
**Symptom.** Running alpha10, "New Version Available: 0.5.0-alpha9" with an Install button.
**Root cause.** The picker trusted the order of a stale, unauthenticated release list (alpha10 missing from it) and the comparator accepted any version difference as an update.
**Where.** `src-tauri/src/updater.rs:159` (`pick_highest_manifest_tag`), `:36` (`cmp_versions`), `:292` (strictly-newer comparator).
**Why missed.** Tests covered only the happy path; no fixture had an older manifest, unordered releases, or alpha9/alpha10 text ordering.
**Check.** Fixture: unordered releases including an older manifest and single-identifier prereleases; only a strictly newer version is offered, and the picker must agree with `releases/latest`.

## 8. The pruner ate the live cache
**Symptom.** TRN profiles refetch on every launch; the board is empty for the first seconds; a "cache" that never survives a restart.
**Root cause.** `recon_trn_cache_v1` was listed as superseded while still being the live prefix, so alpha16 deleted the whole TRN cache on launch.
**Where.** `src/utils/tracker.ts:1730-1736` (superseded list) and `:1749-1753` (guard that skips the live prefix); live prefix is now `recon_trn_cache_v2` (`src/utils/trn.ts:1207`).
**Why missed.** The prune test asserted deletions, never that live keys survive.
**Check.** Seed a superseded key and the live prefix; prune removes only the former; a cache entry must round-trip across two simulated launches.

## 9. localStorage at quota → cache writes silently failed
**Symptom.** Cache-version bumps are no-ops, stale generations persist, fresh data is fetched but never saved.
**Root cause.** The store sat at 4.76–5.24 MB against a ~5 MB quota; `setItem` threw `QuotaExceededError` inside a swallowed catch, so every write looked successful.
**Where.** `src/utils/tracker.ts:1763` (`writeLocalSafe`), `src/hooks/useTrackerData.ts:231-248`, `src/utils/trn.ts:805-806` (measured 256 KiB ok / 512 KiB throws).
**Why missed.** Dev and CI machines had empty storage; no test filled the quota.
**Check.** Fill localStorage to its limit in a test; every cache write path must evict-and-retry or return `false`, and boot with a full store must still fetch and persist the newest state.

## 10. Overlay built eagerly from config → a HUD failure aborted startup
**Symptom.** If the overlay/HUD window fails, the app does not open at all; no main window, no error.
**Root cause.** Tauri built both config windows with `.build()?`, so an overlay failure returned from setup before the main window was usable.
**Where.** `src-tauri/tauri.conf.json` overlay `"create": false`; `src-tauri/src/lib.rs:973` (`build_overlay_window`) and `:1074-1080` (setup logs the failure and keeps the app running with `OVERLAY_AVAILABLE=false`); fix `a1b7ef9`.
**Why missed.** The overlay was always valid in dev; no failure injection existed.
**Check.** Fault-inject overlay creation (bad URL/config) and assert the main window, commands and tray still work, overlays report unavailable, and the app starts normally.

## 11. A state guard that nothing called

**Symptom.** The board can still settle on the previous match's rows after a new match starts; the live snapshot is never re-stamped.
**Root cause.** `setLiveSnapshotMatch` was defined, exported and unit-tested, but no production code called it, so the match-id guard it feeds never fired.
**Where.** `setLiveSnapshotMatch(` — the call-site grep must find it outside its definition and outside tests; fixed in alpha20.
**Why missed.** The test invoked the setter itself, so it proved the callee worked, not that the application wired it in. The bug surfaced when the code was moved, not when it was tested.
**Check.** For every exported state guard/setter, grep a production call site (exclude `*.test.*`, `scripts/`, and the definition). A guard with zero call sites is a build failure; the error message names the missing wiring.

## Rules that follow

1. **One validated parse per external payload.** `assertRiotOk` (or equivalent) runs before any field is read; an error is never allowed to look like a zero/unranked/empty value.
2. **A transport owns its gate.** Pause, auth and retry belong to the transport that needs them; never gate a different transport because they share a caller.
3. **A cache key is either live or superseded, never both.** Pruning is idempotent, versioned, and the live prefix is skipped by construction, not by a list someone might edit.
4. **Negative facts are versioned.** A verdict written before a semantic fix cannot outlive it; store the version in the key and ignore old generations.
5. **Quota is a first-class failure.** Cache writes return success/failure, evict before retrying, and the boot path is tested with full storage — never assume `setItem` worked.
6. **Only strictly newer is an update.** Never trust release-list order; compare natural versions and cross-check the authoritative "latest".
7. **Startup order is a design decision.** Nothing optional (overlay, tray, HUD) may be constructed in a way that can abort the main window; degrade, log once, report through the UI.
8. **Release artifacts are asserted structurally and launched once.** File set, minimum sizes, signatures, and a clean-machine smoke test that sees a window and a webview child.
9. **Privileged listeners are proven loopback.** A release launch asserts the bind address and an off-box probe must fail.
10. **Tests must include error shapes and boundary data.** A suite that only feeds valid payloads is a demo, not a test; every parser/transport test carries at least one real failure payload.
11. **A test asserts the call site, not the callee.** A state guard is not shipped until production code calls it; the check greps for the call, and a missing wiring fails with the function name.
