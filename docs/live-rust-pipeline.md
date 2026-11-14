# Rust-first live pipeline — build plan

Date: 2026-11-14. Decision: **all facts in Rust, TS renders.** Architecture
advisory (oracle) and pipeline mapping (explorer) agree: the current TS hot path
is already cheap per-call, but polling from two realms plus cross-window merge
is where lag and ping-pong live. This plan kills the TS poll loops and replaces
them with pushed Rust events.

## Current pipeline (what exists today)

```
TS useLivePoll (2.5s tick) ──invoke──▶ Rust tracker.rs (riot_local → 127.0.0.1)
        │                                        lockfile re-read per call
        │                                        local_presences, riot_direct_*
        ▼
setMatchState → HudCanvas (phase gates, Tab 500ms probe, storage sync)
        │  recon:live-match-sync (main ↔ overlay, merge non-regressing)
        ▼
   TRN enrichment (transportGet direct-first, serial cooldown ladder)
```

Cost centers: two TS pollers, 500 ms Tab probe IPC, 2 s daemon + 100 ms guard
threads, cross-realm sync merge, full re-render on each tick.

## Target pipeline

```
Rust live service (tokio task, one poller)
 ├─ presences watcher: local 127.0.0.1 unrate-limited, 2.5s idle → fast on transition
 ├─ log tailer: notify, offset-based, #p(line) parser (patterns §5 of overwolf-trust-chain.md)
 └─ emits: recon:live-score / recon:live-phase / recon:live-transition (facts + seq + source + confidence)
        │
        ▼  (Tauri events, only on change)
TS: thin subscriber → setMatchState path unchanged → HudCanvas renders
        fallback: one-shot TS fetch if no event in ~10s; TS fetchLiveMatchState kept for dev:ui
```

## Phases

### Phase 0 — Rust presences watcher (first slice, 1–2 files)

- New `src-tauri/src/live.rs`: tokio task spawned at startup, reads
  `local_presences` equivalent via existing `riot_local`, parses
  `sessionLoopState` + `partyOwnerMatchScore*` (+ map/queue), hashes, emits
  `recon:live-score` / `recon:live-phase` only on change.
- TS: subscribe in `useLivePoll`, feed existing `setMatchState`; keep interval
  behind a flag as fallback.
- Accept: overlay updates with TS timer removed; no overlapping polls;
  hidden-tab quiet; `recon:live-match-sync` ping-pong gone; `cargo fmt` clean,
  no new warnings.
- Rollback: flip flag, TS interval resumes.

### Phase 1 — Rust log tailer (phase gating)

- Extend `live.rs`: `notify` watcher on
  `%LOCALAPPDATA%/VALORANT/Saved/Logs/ShooterGame.log`, offset-based
  (reset on shrink/replace; backfill last ~64 KB on start; replay through same
  `#p` parser).
- Regex inventory: `Broadcasting state changed to`; `Loopstate changed from`;
  heartbeat `glz-…/session/v1/sessions/…/heartbeat`; `LogMapLoadModel`;
  `Party_(FetchParty|Enter|Leave)MatchmakingQueue`; `Pregame_SelectCharacter`;
  `AShooterGameState::OnRoundEnded for round 'N'` (roundId = N+2);
  `Gameplay started at local time`; `Winning Team: '(Blue|Red)'`;
  `LogMenuStackManager: Opening`.
- Gating (copy theirs): match events only while match active; party 5 s dedup;
  round only for known playlists; emit `recon:live-transition`.
- Effect: presences poll goes fast only on transition, ~1/round otherwise.
  In-match TS timers die.

### Phase 2 — Event-driven TS overlay (interim)

- `useLivePoll`: delete the interval; subscribe-only + 10 s stale-guard.
- `HudCanvas`: visibility gates consume `phase`/`score` facts; Tab probe stays
  (OS-level, 500 ms, already gated to coregame); in-match polling widgets →
  Tab-peek roster fed by events.
- TRN enrichment keeps its TS serial gate (not reimplemented in Rust).
- This phase is the fallback surface: kept working while Phase 4 matures.

### Phase 3 — OCR (deferred, gated on demand)

NOT built until: proven user demand + ROI pinning across stretched modes
(2088/1568 widths shift every HUD anchor) + confidence-gated display.
Design on file: `windows-capture` → 1–2 fps → GPU crop → `Windows.Media.Ocr`,
state-gated (score on round transition, scoreboard on Tab, health in combat).
Re-enable dormant log kill/death regexes first (VO lines, free).

### Phase 4 — Native overlay widgets (sidecar, behind flag)

Main app stays Tauri/React (config, control, views). Overlay widgets go
native: separate `recon-overlay` sidecar binary (Slint, retained declarative
UI, dirty-region partial rendering, repaint-on-demand), launched/killed by
the main app, reading the same Rust facts (score, phase, roster over a local
channel). TS writes config, never frames. Decision recorded 2026-11-14:
if not Tauri, Slint is the pick (best designer workflow, ~30-50 MB real
apps, $0 royalty-free desktop with attribution; blocked only by the
transparency repro). Ranked above Dioxus/GPUI/themed-egui/iced for this job.

Why: no second Chromium (no JS GC, no cross-realm sync, no per-tick
re-render); native idles near ~0 and repaints only dirty regions; drag/resize/hit-test
becomes window behavior instead of the pointer-events dance in `HudCanvas`.

- Window owner: sidecar creates its own topmost transparent click-through
  window via `winit` backend + `renderer-femtovg` (first candidate;
  `renderer-skia` second; NEVER `renderer-software` — transparency gated
  off — and never any `wgpu` variant per Slint #9507) with `no-frame +
  always-on-top + background: transparent`. NO `WS_EX_LAYERED`. Manual HWND
  click-through via `Window::window_handle()` (`raw-window-handle-06`) +
  `WS_EX_TRANSPARENT | NOACTIVATE | TOOLWINDOW | TOPMOST` + HTTRANSPARENT
  subclass + DWM-strip logic reused from `overlay_window.rs`. Pin
  `slint ~1.18` (floor >=1.15.1).
- Renderer: Slint (retained declarative + dirty-region partial rendering;
  NOT iced/GPUI for the HUD — heavier or unproven click-through). Designer owns
  `recon-overlay/ui/*.slint`: one top-center cluster with two densities
  (agent-select full, in-match Tab-peek), tokens in `tokens.slint`, facts
  contract in `facts.slint`. Rust owns every value; `.slint` renders.
  Raw D2D/DirectComposition only if Slint's text/image limits ever bite.
- Images: agent icons / rank crests need a URL→disk cache (`image` crate);
  compile-time `@image-url` literals for static chrome only, runtime
  `Image::load_from_path` for portraits/crests pushed as `<image>` props;
  the only unglamorous part.
- Flag-gated: TS overlay stays the fallback until the sidecar proves equal;
  edit mode mirrored first (drag/resize chrome, Lite/Full toggle), then locked mode.
- Deps to add (Phase 4 only): `slint` (+ `raw-window-handle-06`), `image` for icon decode.
- Gate before any repo code changes: 1-day transparency repro on Win10/11 +
  NVIDIA/AMD (transparent + topmost + passthrough toggle + present path over
  live VALORANT, pass/fail screenshots).

Renderer decision record: TS overlay = interim (Phase 2); Slint sidecar =
end-state (Phase 4). egui is NOT the end-state (superseded 2026-11-14:
stock egui vetoed as debug-tool look; premium "cool asf" visuals required).

Renderer decision record: TS overlay = interim (phases 2); egui sidecar =
end-state (phase 4); D2D = escape hatch only.

NOT built until: proven user demand + ROI pinning across stretched modes
(2088/1568 widths shift every HUD anchor) + confidence-gated display.
Design on file: `windows-capture` → 1–2 fps → GPU crop → `Windows.Media.Ocr`,
state-gated (score on round transition, scoreboard on Tab, health in combat).
Re-enable dormant log kill/death regexes first (VO lines, free).

## Rules (non-negotiable)

- Read-only: no memory read, no injection, no mutating Riot calls; hover-only,
  never lock/select; no `WS_EX_LAYERED` / backdrop blur; click-through except
  edit mode (AGENTS.md).
- Never claim hidden MMR; never real-time coaching ("go here now"); never
  de-anonymize beyond visible info (Riot VALORANT policy).
- Remote `pd/glz` stays on-demand; never on a Rust timer.
- Every event carries `source` + `seq` + `confidence`; TS keeps display merge
  until Rust proves stable.

## Risks

1. **Log rotation/truncation** → reset offset on shrink/replace; backfill 64 KB.
2. **Lockfile churn** → re-read per call (existing behavior); clear
   "relaunch client" error; never cache creds across restarts.
3. **Two state machines diverge** → Rust emits facts, TS keeps merge/harvest;
   stale-guard one-shot fetch.

## Dependencies to add

- Phase 0: none (tokio/sync/time already in tree).
- Phase 1: `notify` (file watcher).
- Phase 3 (later): `windows-capture` + WinRT OCR surface via `windows 0.58`.
