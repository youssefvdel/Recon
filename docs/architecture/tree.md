# The tree as it is

A map of the code as it exists today, not the target in `target.md` / `design-data-layer.md`.
As of 2026-11-10, HEAD `998f36b`. Some directories are moving (the HUD/window ownership
change was in flight while this was written); trust the folder names here, not line counts.

## Read these three first

1. `src/App.tsx` — window/view composition: which surface mounts where, lazy views, overlay/dev entry.
2. `src/hooks/useTrackerData.ts` — the UI↔data contract: snapshot store, refresh, TRN broadcast.
3. `src-tauri/src/lib.rs` — Rust module list, window setup, command registration.

The rules live in `docs/architecture/{target,design-data-layer}.md`, but those describe the intended
layout. This file is the only map of what actually exists; it supersedes them for navigation.

## TypeScript

| Folder | Files | Owns today |
| --- | --- | --- |
| `src/sources/` | riot 762, matchDetails 280, gameData 105, presence 63 | Validated Riot reads (riot), match-details + round parser with its own cache, valorant-api metadata, presence decoding. TRN is not here. |
| `src/live/` | fill 379, playerStats 238, actStats 154, merge 105, fillPolicy 56, lobbyScope 25 | Live-lobby fill orchestration, the live-stats cache, local act scan, merge/order rules, fill budgets, lobby membership. |
| `src/cache/` | namespace 163 | `writeLocalSafe`, oldest-first eviction, the persisted rank cache, and a superseded-key promise list. No other live cache lives here. |
| `src/utils/` | tracker 2600, trn 2255, plus format/loadout/store/updater/etc. | The two front doors: `tracker.ts` imports 28 symbols from the new layer and re-exports 16 blocks; `trn.ts` still owns the TRN transport, pacing, negative registry and cache pruning. |
| `src/components/hud/` | HudCanvas 1075 + 10 parts/hooks | The overlay window: config state, drag/resize, live poll, edit chrome, panel/tile widgets. Entry is `HudCanvas`. |
| `src/hooks/` | useTrackerData, useLiveMatchActive, useCountUp | React seams over `utils/tracker`. |

Import direction today: 22 files import `utils/tracker`, 16 import `utils/trn`, and exactly one UI file
(`LiveMatchView`) imports the new layer directly (`live/playerStats`). The new folders are mostly
implementation behind the old front doors.

## Rust (`src-tauri/src/`)

| Folder | Files | Owns today |
| --- | --- | --- |
| `commands/` | 8 files, 445 lines | Thin Tauri command surface, one concern per file (borderless, config, display, gpu, settings, shell, window). |
| `win/` | daemons, memory, overlay, tray, mod (692) | Window construction for overlay/tray; also background threads (`daemons`) and working-set trim (`memory`), which are not window-scoped. |
| `window_manager/` | borderless, enumeration, overlay_window, mod (1,345) | Win32 window work: finding the game window, borderless reshaping, HUD styles/subclass/placement/edit. |
| `display/` | 12 files, 2,966 | Monitor identity/modes/registry/writes, plus `shortcut` bindings and `hotkey_listener` (input, not display). |
| `trn_proxy/` | 14 files | Hidden same-origin WebView2 transport for tracker.gg. |
| `trn_cache/` | 10 files | File-backed TRN response cache (bodies moved off localStorage quota). |
| root | tracker 664, trn_http 263, shortcuts 120, plus lib/main/state/settings | Unmoved Rust pieces: direct TRN HTTP, root shortcut model, MMR commands, setup. |

Three places say "window": `commands/window.rs` (chrome commands), `win/` (construction + platform),
`window_manager/` (Win32 window manipulation). Two say "shortcut/hotkey": root `shortcuts.rs` and
`display/{shortcut,hotkey_listener}.rs`.

## Names that mean more than one thing

- **`fill` ×3.** `live/fill.ts` is the stateful queue/orchestrator; `live/fillPolicy.ts` is pure budgets
  and predicates; `live/merge.ts` also owns fill-wave splitting (`splitFillWaves`, `TRN_FILL_WAVE_SIZE`)
  and MMR merge. A fill bug means opening three files.
- **`merge`** underclaims: it is the live-match merge *and* fill-wave/MMR rules, not just merging states.
- **`playerStats` in `live/`.** It is a TTL + persistence + eviction cache with a match-ID guard. The
  `cache/` folder does not own it.
- **`cache/`.** The folder name promises the cache layer; the file owns cache primitives, the rank cache,
  and a list of other modules' superseded keys.
- **`sources/riot.ts`.** Reads as "the Riot source", but `matchDetails` and `presence` are also Riot reads
  and `gameData` is valorant-api. There is no `sources/trn.ts`; the TRN source is `utils/trn.ts`.
- **`win/` vs `window_manager/` vs `commands/window.rs`.** Construction, Win32 manipulation, and chrome
  commands respectively — the names do not carry that split.
- **`win/overlay.rs` vs `window_manager/overlay_window.rs`.** Both document HUD window styling/placement:
  `win/overlay.rs` claims creation, visibility, styles, edit mode, placement, then delegates styles,
  placement and edit mechanics to `window_manager::` (10 calls). One HUD, two headers.
- **`utils/tracker.ts` / `utils/trn.ts`** are front doors now, not the single sources their names imply.

## Cache keys are not owned by their folder

`src/cache/namespace.ts:42-47` prunes `recon_match_v6_`, `recon_match_v5_`, `aspect_match_v5_` and
`recon_live_player_stats_v2`. Those prefixes belong to `sources/matchDetails` (match cache) and
`live/playerStats` (live stats), so one module names and deletes generations it does not own. The design's
rule — "a module cannot prune a key it cannot name" — is not true in this tree; there is no
`createNamespace`/`pruneAll` registry. `recon_` literals also live in `utils/{trn,tracker,store,loadout,
prepick,updater,consent,blitzMeta}`, `live/playerStats`, `sources/matchDetails`, `hooks/useTrackerData`, and
the overlay config files.

## Known debts

1. `utils/tracker.ts` (2,600) and `utils/trn.ts` (2,255) are front doors with 16 re-export blocks; the new
   layer is mostly internal. Target-only paths — `src/model/`, `src/transport.ts`, `cache/{live,rank,matches}.ts`,
   `sources/trn.ts` — do not exist yet. Acceptance in the design doc: `tracker.ts < 800`.
2. HUD/window ownership is split (three window homes, two HUD files); the consolidation was in flight when
   this page was written.
3. Cache ownership is not enforced; the superseded list names other owners' keys and there is no registry.
4. `display/` holds input (hotkeys) and `win/` holds non-window platform code (daemons, memory).
5. Until this file existed, the only architecture docs described the target layout; a cold reader had no
   map of the current tree.
