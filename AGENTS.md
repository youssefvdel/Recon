# AGENTS.md — Recon

Instructions for AI coding agents (opencode and Kilo both auto-load this file). Human docs: `README.md`, `ROADMAP.md`, `RELEASING.md`.

## Project overview

Recon is a Windows desktop VALORANT companion + competitive display toolkit. Tauri v2 app: live lobby scouting (rank, RR, parties, incognito resolution), in-game HUD overlays, true stretched resolution (1.45:1), sensitivity matcher, resolution switcher with safe-mode watchdog, VALORANT config editor, GPU scaling report.

Safety rules (non-negotiable): read-only. No memory reading, no injection, no mutating Riot calls. Hovering an agent is fine; locking one is not. Never claim raw/hidden MMR — Riot does not expose it (see `ROADMAP.md`). Never display a GPU/display state that was not read back from the machine — mark unverifiable rows UNVERIFIED.

Note: "agents" in this codebase means VALORANT game characters (`TrackerAgents.tsx`, `tracker.rs`), not AI agents.

## Tech stack

- Frontend: TypeScript, React 19, Vite, Tailwind CSS 3, Framer Motion, Lucide icons. Material Design 3 dark violet theme.
- Backend: Rust (edition 2021, `rust-version 1.77.2`), Tauri v2, Win32 via `windows-rs` + `winreg`, tokio runtime.
- Graphics: DirectComposition GPU pipeline. Do not use `WS_EX_LAYERED` or CSS backdrop blur.
- Package manager / runner: Bun. Target: `x86_64-pc-windows-msvc`, Windows 10/11 only.
- Separate `website/` Vite site (reconlab.app), independent package.

## Directory map

- `src/` — React frontend: `App.tsx`, `main.tsx`, `types.ts`, `components/` (~35 views: tracker, overlay, stretch, config), `hooks/`, `utils/` (ipc, tracker, trn, riotChat, store, updater), `assets/`.
- `src-tauri/src/` — Rust backend: `lib.rs` (commands/state), `main.rs`, `display.rs`, `custom_res.rs`, `gpu.rs`, `game_config.rs`, `tracker.rs`, `trn_proxy.rs`, `calculator.rs`, `accounts.rs`, `perf.rs`, `shortcuts.rs`, `window_manager.rs`, `updater.rs`.
- `src-tauri/` — `Cargo.toml` (crate `recon`, version must match root `package.json`), `tauri.conf.json` (windows: `main`, `overlay`, `dev`), `icons/`, `capabilities/`.
- `scripts/` — Bun/Node checks: `bump-version.js`, `*-check.ts` (loadout, devqa, perf, trn-*, match-server, party-color, consent, live-poll, cooldown-chrome).
- `website/` — standalone Vite + React + Tailwind marketing site. Own `package.json`, `bun.lock`.
- `dist/` — Vite frontend output (Tauri `frontendDist`). Generated, never edit.

## Setup / build / dev / test

Prerequisites: Bun, Rust stable (`x86_64-pc-windows-msvc`), VS 2022 Build Tools with C++ desktop workload.

```bash
bun install                  # install root deps
bun run tauri dev            # app with hot-reload UI (Vite on 127.0.0.1:5173, strictPort)
bun run build:ui             # type-check (tsc -b) + vite build -> dist/
bun run build                # UI + Rust, no installer -> src-tauri/target/release/recon.exe
bun run build:bundle          # full release -> src-tauri/target/release/bundle/
bun run lint                 # oxlint
bun run bump -- X.Y.Z        # bump version in BOTH package.json and Cargo.toml (always use this)
bun scripts/loadout-check.ts # example check; see scripts/*-check.ts run with bun
```

- `website/` commands run from `website/`: `bun install`, `bun run dev`, `bun run build` (`tsc && vite build`).
- Dev server port 5173 is `strictPort` — a conflict fails fast rather than shifting; do not change the port to work around it, kill the stale process.
- Updater reads crate version (`Cargo.toml`); bundle version comes from `package.json`. Keep them in sync via `bun run bump`.

## Code conventions

TypeScript / React:

- Strict TS (`tsc -b` must pass). Prefer existing `src/utils/` helpers (`ipc.ts`, `logger.ts`, `version.ts`) over new one-offs.
- Tauri IPC via `@tauri-apps/api`; backend commands defined in `src-tauri/src/lib.rs`. Keep command signatures `-> Result<_, String>`.
- Tailwind for styling; Lucide icons; Framer Motion for animation. No CSS backdrop blur.
- Overlay windows (`overlay` label) must stay click-through except in edit mode (`OVERLAY_EDIT_MODE` in `lib.rs`).

Rust:

- `cargo fmt` clean; no new warnings. Use named constants for registry/magic values (e.g. WDDM scaling values, not bare `3`/`4`).
- Windows-only code paths: guard platform assumptions, handle missing registry keys gracefully.
- GPU/display module rule: read back every claimed state; expose `verified` + `detail` rather than asserting writes succeeded.
- Never add memory-read, injection, input-automation, or mutating Riot-client dependencies or calls.

General:

- `ROADMAP.md` records verified dead-ends (MMR, live-data sources, Overwolf sidecar). Read it before re-investigating data-source questions.
- Keep changes minimal and scoped; do not reformat unrelated files.

## Do NOT touch

- Generated / deps: `dist/`, `dist-ssr/`, `node_modules/`, `website/node_modules/`, `.opencode/node_modules/`, `src-tauri/target/`, `*.tsbuildinfo`, `*.local`.
- Secrets / local: `.env`, `bot/.env`, `vault/`, `logs/`, `*.log`.
- Tooling state: `.hermes/`, `.kilo/worktrees/`, `.kilo/agent-manager.json` (diagnostic UI state, never edit for config), `.opencode/` (not loaded by Kilo — do not put project config here).
- Kilo project config lives in `.kilo/command/*.md`, `.kilo/agent/*.md`, and `kilo.json` — not in this file.

## Git / worktrees

- Windows repo, PowerShell shell. Default branch workflow: small focused commits; do not commit secrets.
- Never use `git stash` (including autostash on merge/rebase) — stashes are shared across worktrees and leak unrelated changes into other sessions. Commit, or use a temp branch / worktree-local patch instead.
- When merging a worktree branch with conflicts, merge or rebase the base branch inside that worktree, resolve there, run `bun run build:ui` + `bun run lint`, then integrate.
- Respect root `.gitignore` (covers `.opencode/`, `opencode.json`, `vault/`, `.hermes/`, `node_modules`, `dist`, `src-tauri/target/`).
