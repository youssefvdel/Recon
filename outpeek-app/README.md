# outpeek-app

The native Outpeek app: **one process, two Slint windows**.

| Window | What it is | Native style |
| --- | --- | --- |
| Tracker | Decorated, resizable, taskbar-visible shell with the live tracker | none — a normal window |
| HUD overlay | Transparent, topmost, click-through layer over VALORANT | the proven `win_style` recipe from the sidecar |

The overlay is **not** a spawned binary here. It is the same `OverlayWindow`
component compiled from `outpeek-overlay`'s `ui/overlay.slint`, created hidden at
startup and shown only while VALORANT is focused and the HUD toggle is on. Facts
travel in memory as Slint properties on one event loop — there is no NDJSON
pipe, no `--parent-pid`, no second executable on the happy path.

The standalone `outpeek-overlay` binary still exists unchanged
(`--probe` / `--health` / `--show-test` / `--soak` / `--mcp-port`, stdin-driven
HUD). It is the headless gate harness and the fallback HUD for the Tauri app.

## Crate wiring

```
outpeek-overlay            lib + bin
├─ src/lib.rs              force_femtovg, register_fonts, EDIT_MODE/PRESENT,
│                          `ui` (generated Slint), `hud`, `roles`, `win_style`
├─ src/hud.rs              FactsMsg + apply_facts + sync_visibility (shared)
├─ src/roles.rs            which window may get click-through (App never)
├─ src/win_style.rs        Win32 recipe + foreground/game-window discovery
└─ src/main.rs             thin binary: gate modes + stdin NDJSON fallback

outpeek-app                lib + bin (depends on outpeek-overlay by path)
├─ src/lib.rs              path-includes the pure Tauri modules:
│                          fs_migrate, live_facts, paths, riot_http,
│                          overlay_renderer — no logic copied
├─ src/model.rs            pure view model (formatting, states, gates)
├─ src/identity.rs         loopback lockfile/identity/presences/entitlements
├─ src/rank.rs             /mmr parse + one-shot rank read (on demand only)
├─ src/hud.rs              platform capability + foreground gate + loop probe
├─ src/worker.rs           the single poller (2.5 s, 30 s idle backoff)
├─ ui/                     app shell; imports tokens + Plate from the overlay UI
└─ src/main.rs             two windows, toggle, foreground watcher, bench
```

Shared UI is imported, never copied: `outpeek-app/build.rs` adds
`../outpeek-overlay/ui` to Slint's include path, so `tokens.slint` and
`components/plate.slint` are the overlay's own files.

## How the two HWNDs get different styles

In the app, `win_style::apply()` is reached from exactly one place:
`hud::sync_visibility`,
using the HWND returned by the **overlay component's** `window().window_handle()`.
The app window is never passed to it. `roles::wants_clickthrough()` encodes the
rule (`Overlay` only) and is unit-tested; `window_role` is the type-level answer
to "can this window receive WS_EX_TRANSPARENT / the HTTRANSPARENT subclass".

On the overlay HWND the recipe is the proven one: `WS_POPUP | WS_CLIPSIBLINGS`,
`TOPMOST | TOOLWINDOW | TRANSPARENT | NOACTIVATE | LAYERED`, LWA_ALPHA 255,
DWM strip, HTTRANSPARENT subclass, `SWP_NOACTIVATE`. The app window keeps
winit's decorated/resizable window.

## What the tracker shows (real data only)

| Panel | Source | States |
| --- | --- | --- |
| Player | `/player-account/aliases/v1/active` + PUUID from `/entitlements/v1/token` | not signed in / signed in |
| Live match | `/chat/v4/presences` decoded by `live_facts` (phase, map, mode, ally/enemy score) | loading / no match / live / error |
| Rank | `/mmr/v1/players/{puuid}` (public tier + RR) | waiting / loading / ranked / unranked / error |
| Recent matches | **not ported** | explicit "not ported" panel |

Rules enforced by tests: an error payload never renders as Unrated, an empty
name never renders as `#TAG`, and no panel shows a dash as a value. Rank is a
remote read with the entitlement triple, so it runs once when the account
resolves and on **Refresh rank** — never on the 2.5 s presence tick.

The poller copies the Tauri live service's cadence: 2.5 s while a match is
active, 30 s after 30 s of idle phase, and a lockfile `stat` gate so a closed
client costs no TLS handshakes. A failed presence read is retried; eight
consecutive failures surface "Lost the Riot Client".

## Run / build

From the repo root:

```bash
# dev (Linux/Windows; the HUD is inert off Windows, the tracker still runs)
cargo run --manifest-path outpeek-app/Cargo.toml

# Windows release (the shipping artefact), run on the Windows PC
cargo build --release --manifest-path outpeek-app/Cargo.toml
# -> outpeek-app/target/release/outpeek-app.exe
# (with an explicit --target, add that triple under target/<triple>/release/)

# check the Windows build from Linux
cargo xwin check --manifest-path outpeek-app/Cargo.toml --target x86_64-pc-windows-msvc
```

The standalone gate harness still builds on its own:

```bash
cargo build --manifest-path outpeek-overlay/Cargo.toml
cargo xwin check --manifest-path outpeek-overlay/Cargo.toml --target x86_64-pc-windows-msvc
```

### Flags and dev hooks

| Flag / env | Effect |
| --- | --- |
| `--mcp-port PORT` | Slint's embedded MCP server (only when `SLINT_MCP_PORT` is unset) |
| `OUTPEEK_LOOP_PROBE=1` | log max event-loop dispatch latency every 5 s |
| `OUTPEEK_BENCH_REPAINTS=1` | run the 200-update event-loop bench once, after warm-up |
| `OUTPEEK_SMOKE_EXIT_MS=N` | close the app through the normal shutdown path after N ms (CI smoke) |

The HUD toggle persists in `%APPDATA%\Outpeek\overlay_renderer.txt`
(`native` / `ts`). Missing file = on: this app's own HUD is the point. This is
app-local for now; the Tauri app's `settings.json` `overlay_renderer` key is not
read until Settings is ported (writing a partial settings.json from here would
race the shipping app's save).

## How to A/B the overlay toggle

1. Start VALORANT (windowed or borderless) and this app.
2. Focus VALORANT. Within ~1 s the HUD layer shows (status: "Live over
   VALORANT"). The tracker's chip switches to `live`/`select` when a presence
   says so.
3. Alt-tab back to the tracker. The HUD hides within ~1 s (foreground rule);
   status becomes "Armed — waiting for VALORANT".
4. Click the HUD toggle off. The overlay hides immediately even with VALORANT
   focused, and the status reads "Off — HUD will not show". Click it on again
   while VALORANT is focused: the HUD returns.
5. Restart the app: the toggle state is the same as when you left it.

Because the toggle is handled on the UI thread, switching it off isolates any
suspected HUD hitch from tracker rendering without restarting the app.

## Shared event loop: the accepted trade-off

Both windows share one winit event loop. That is the price of deleting the
sidecar spawn/kill/respawn, the NDJSON protocol, the parent-pid watchdog and a
second shipped binary. It is **not** free: a heavy tracker layout can delay the
HUD's next frame, and a HUD repaint can delay tracker input feedback.

What this slice does to keep the risk small:

* the poller publishes only on change (2.5 s / 30 s), never per frame;
* the tracker has no `animate` loops and no backdrop blur; the HUD keeps its
  repaint-on-demand contract (no `animation-tick`, no timers);
* turns are short: property writes on the UI thread, no I/O on it.

### Measurement: what was actually run

Measured on the Linux development host under `xvfb-run` (no GPU, debug build) —
**these are not Windows numbers**:

```
OUTPEEK_BENCH_REPAINTS=1 OUTPEEK_LOOP_PROBE=1 xvfb-run -a ./outpeek-app
[bench] 200/200 tracker updates: total=0ms max_dispatch=0ms
[loop-probe] max≈1.0–1.1s n=100 (first 5 s, renderer/window init)
```

Reading: after warm-up the 200 updates coalesce into one loop iteration and
dispatch is sub-millisecond; the first seconds are dominated by window/renderer
creation, not by tracker work. This host cannot answer the question that
matters — a Windows D3D/FemtoVG frame gap while both windows composite.

### Exact Windows procedure (needs the PC)

1. Build the release exe (command above) and start it.
2. Run the event-loop probe in one console:
   `set OUTPEEK_LOOP_PROBE=1&& outpeek-app.exe`
   Focus VALORANT until the HUD shows, then scroll/click the tracker for 30 s.
   Read `[loop-probe] max=…ms` lines: that is the worst UI-thread dispatch
   delay caused by either window.
3. Measure real frames with PresentMon on the same session:
   `PresentMon --process_name outpeek-app.exe --output_file hud.csv`
   Compare `msBetweenPresents` / `msCPUBusy` over 30 s with the HUD **on** vs
   **off** (toggle) while doing the same tracker scrolling.
4. Run `OUTPEEK_BENCH_REPAINTS=1` once for the batch number:
   `[bench] 200/200 tracker updates: total=…ms max_dispatch=…ms`.
5. Report the four numbers (probe max, PresentMon p95/p99 with HUD on/off,
   bench total) before calling parity. Until then, treat the shared loop as
   **unmeasured on Windows**.

## Deliberately not ported yet

* Settings, Stretch and Overlay views — sidebar rows are marked `SOON`.
* HUD edit mode (drag/scale/lock chrome) — the callbacks exist in the sidecar;
  the app does not wire them.
* Rosters / agent icons in the HUD — they need the core-game payload.
* Recent matches — needs `/match-history/v1` + `/match-details/v1`.
* TRN enrichment, config editor, resolution switcher, updater, tray.
* Any Tauri webview path. The app does not link Tauri.

## Safety

Read-only. Loopback GETs with lockfile credentials, certificate validation off
only for 127.0.0.1, one remote `/mmr` GET on demand. No memory reads, no
injection, no input automation, no mutating Riot calls. Rank is public rank +
RR; raw/hidden MMR is never read or claimed.

## Tests

```bash
cargo test --manifest-path outpeek-overlay/Cargo.toml   # 11
cargo test --manifest-path outpeek-app/Cargo.toml       # 36
```

Coverage that matters here: partial facts frames, roster → Slint facts, app
never click-through / overlay always click-through, lockfile shape errors,
name/tag formatting, tier labels (Unrated→Radiant), phase titles, no-client
state, transient-error recovery, rank error ≠ Unrated, region from the access
token, rank payload parsing, and the four-condition HUD visibility gate.
