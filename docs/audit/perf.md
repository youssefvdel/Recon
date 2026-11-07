# Recon performance audit

Branch `fix/trn-captcha` @ `96ac7e4`-era tree. Read-only audit; nothing in this
document has been implemented.

**How to read the evidence column.** `measured` = I ran it here (Linux).
`code-proven` = the cost is structural in the source and cannot be argued with.
`Windows-only` = cannot be measured from this box; named so nobody assumes I did.

## Ranked by value per effort

### 1. The dead TRN file cache still costs disk reads on every refresh — S / High

`tracker.gg` is cold (Warden captcha; see `docs/upstream/`), but the cache it
left behind is neither pruned nor bypassed.

- **Disk (code-proven):** `src-tauri/src/trn_cache.rs:114` `MAX_BODY_BYTES = 4 MB`,
  `:125` `MAX_ENTRIES = 100` → a worst case of **400 MB**, and the observed
  install held **~67 MB / ~100 files**. Eviction only runs on **write**
  (`trn_cache_put`), and with TRN dead there are no writes, so 67 MB stays
  forever.
- **Read path still live (code-proven):** `src/utils/trn.ts:729` calls
  `trnCacheLookup` before every gate; `:665` invokes `trn_cache_get`. The
  enrichment block fires ~7 TRN calls per refresh, each paying an IPC round
  trip plus a disk header probe to learn "miss" again.
- **Fix:** (a) skip the lookup entirely when `getTrnHealth().status !== 'ok'`;
  (b) add a total-bytes cap (8 MB is ample) plus an age sweep on startup;
  (c) one-time migrate: delete the directory on first run of the next version.
- **Effort S. Value High** (67 MB of a user's disk + ~7 futile disk stats per
  refresh; tidy and low-risk).

### 2. In-game: the local-Riot act scan multiplies the drain window ~25x — M / High

**This one is mine and it is a real regression in cost, not correctness.**

- The fill is gated by `trnProxyPaused()` at `src/utils/tracker.ts:2174` — that
  gate is honoured. But a **dispatched** fill carries `drain: true` and is
  explicitly exempt from the pause for the rest of the run
  (`trn_proxy.rs` `should_pause`, `drain => false`).
- That exemption was sized for **~2 requests per player** (root profile + one
  season segment). `fetchLocalActStats` (`src/utils/tracker.ts:2383-2420`) now
  does **up to 3 history pages + up to 50 match-detail GETs per player**, times
  up to 10 players in a fill = **~530 local Riot GETs** that may land with
  VALORANT in the foreground.
- The immutable `actSampleCache` (`:2324`) makes repeat fills free, so this is
  the **first fill of a lobby** cost — which is exactly the loading screen.
- **Fix:** skip act aggregation when the phase is `coregame` (rank only, one
  request); or drop the fill's cap to ~10 and keep 50 for the modal/self path.
- **Effort M. Value High** (this is the only finding that spends work while the
  game owns the screen; the rest are idle/boot).

### 3. 1,012 kB main chunk, zero code splitting — M / High

- **Measured here** (`bun run build:ui`): `dist/assets/index-CvrxwfP5.js`
  **1,012.56 kB** (gzip **273.41 kB**), next-largest chunk 57 kB. Vite warns at
  500 kB.
- **code-proven:** `src/App.tsx` statically imports **18** components; `grep -r "lazy(" src/`
  returns nothing. Every view — Store, Chat, Config, Crosshair, Accounts, Dev
  Dashboard — is parsed and instantiated before the user sees the first tab.
- **Fix:** `React.lazy` + one `<Suspense>` around the view switch; keep App,
  Sidebar, TopBar, LiveMatchView eager. Expected **~35-45% off** the initial
  parse (~350-450 kB raw, ~100 kB gzip) and a proportional cut in boot JS.
- **Effort M. Value High** (boot time on every launch, including boot-to-tray).

### 4. Tray-idle: a 2 s poll that never stops — S / Med-High

- `src/App.tsx:309-318`: `setInterval(…, 2000)` calling
  `invoke('check_requested_tab')` (`src/utils/ipc.ts:623`), guarded only by
  `document.hidden`.
- `src/components/DevDashboard.tsx:1034` documents the trap in this very
  codebase: *"`document.hidden` is always false in this window — even
  native-hidden — so the Tauri focus events are the real visibility gate."*
  So a tray-resident Recon issues **~30 IPC calls per minute, forever**, waking
  both the backend and the renderer.
- **Fix:** wire the poll to Tauri focus/visibility events instead of
  `document.hidden`, and stop it while the window is hidden and no request is
  pending.
- **Effort S. Value Med-High** (the app is advertised to live in the tray).

### 5. The hidden TRN proxy renderer costs ~100 MB and ~5.6% CPU when it exists — S / High

- **code-proven lifetime:** `src-tauri/src/trn_proxy.rs:117`
  `PROXY_IDLE_TTL = 5 min`; the renderer is torn down only after that idle
  window. While alive it is a full WebView2 tree.
- **measured elsewhere in this repo:** `src-tauri/src/perf.rs:19-22` records a
  live 5 s window where the 10-process tree burned **3,359 ms CPU = 5.59% of a
  12-core box**, one renderer alone accounting for **2,469 ms**. That is the
  cost class of a resident hidden renderer.
- With the local-Riot path shipped, the proxy exists **only** for the captcha
  fallback, which is usually cold — so it is pure overhead in the common case.
- **Fix:** do not create the window unless `getTrnHealth()` is `ok` once and a
  TRN request is actually demanded (i.e. after the local path has failed), and
  shorten `PROXY_IDLE_TTL` to ~60 s.
- **Effort S/M. Value High** (largest single memory line item).

### 6. The 3 s lobby poll and 938 kB snapshot writes — M / Med

- `src/components/LiveMatchView.tsx:159` polls every **3 s**
  (`src/components/OverlayView.tsx:683`: 2.5 s). Gated on `document.hidden`
  (`LiveMatchView.tsx:132`) — same trap as #4, so it keeps polling in tray.
- Each enrichment settle calls `saveSnapshot()` (`src/hooks/useTrackerData.ts:477`),
  which serializes the whole snapshot. The code documents that this snapshot is
  **938 kB** and that `localStorage.setItem` on it **throws** on quota
  (`useTrackerData.ts:217-219`) — so every refresh builds ~1 MB of JSON that is
  then rejected by the browser.
- **Fix:** stop writing snapshots whose size is known to exceed quota (gate on
  `detailsById` size or drop it from the snapshot); gate the poll on the real
  Tauri visibility event.
- **Effort M. Value Med.**

### 7. The overlay's 150 ms in-match probe — S / Med

- `src/components/OverlayView.tsx:730`: `setInterval(probe, 150)` while
  `phase === 'coregame'` and not editing — **6.7 IPC/s** for the whole match,
  each one a Win32 key-state read via `isTabDown()`.
- Correctly gated (no timer when hidden/idle/pregame/edit — `:715-720`), so
  this is a *rate* problem, not a leak.
- **Fix:** 400-500 ms poll, or a Rust-side key hook that pushes an event.
- **Effort S. Value Med** (it fires exactly when FPS matters most).

### 8. Startup: first paint waits on store init and 18 parsed views — M / Med

- `src/hooks/useTrackerData.ts:184` runs `store = initStore()` **at module
  load**; `initStore` (`:150`) does synchronous `localStorage` reads and a
  `JSON.parse` of the cached snapshot before React can paint.
- Combined with #3 (no splitting), first paint waits for the full module graph.
- **Fix:** same lazy split as #3; move `initStore` into the hook's initializer
  so the first paint is not blocked by a cold-storage parse.
- **Effort M. Value Med.**

## Verified as already bounded (no action)

`logger.ts:19` ring buffer capped at 500 lines, no disk growth; `perf.rs` is a
dev-only command; `liveMmrCache` (tracker.ts:1540) and the live-stats store (tracker.ts:2014) are capped at 200, `actSampleCache`
300, `recent24hCache` and the live-stats store all evict oldest-first;
`trn_cache` entries are individually capped at 4 MB.

## What I could not measure

Real memory/CPU numbers for this app on Windows. Everything above marked
`measured` was taken on Linux (bundle sizes only); the WebView2 tree costs are
quoted from the repo's own 2026-09-26 measurement in `perf.rs`. A Windows run of
the Dev Dashboard (`perf_poll`) with the app idling in tray would confirm or
refute #4, #5 and #6 in one sitting.
