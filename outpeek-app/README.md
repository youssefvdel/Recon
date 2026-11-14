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

### App window frame: rounded corners, no pale bar

The app window gets its own small DWM pass (`src/app_window.rs`); the HUD's
recipe is never applied to it, and `corner_preference()` is tested to keep the
two apart.

| Attribute | App window | HUD overlay |
| --- | --- | --- |
| `DWMWA_WINDOW_CORNER_PREFERENCE` (33) | `DWMWCP_ROUND` (2) | `DWMWCP_DONOTROUND` (1) |
| `DWMWA_BORDER_COLOR` (34) | `DWMWA_COLOR_NONE` | `DWMWA_COLOR_NONE` |
| `DWMWA_CAPTION_COLOR` (35) | `Theme.surface-dim` (`#0e0813`, read from the token at startup) | none |
| `DWMWA_USE_IMMERSIVE_DARK_MODE` (20) | `1` (light caption glyphs) | n/a |

Move and resize stay intact: this only colours the frame and asks for corners.
`DWMWA_NCRENDERING_POLICY` is deliberately never touched — in this repo that is
what turned a composited surface into the pale bar. Each attribute logs its
HRESULT once, so one Windows run proves what DWM accepted:

```
[Outpeek] app-window chrome: corner=ROUND hr=0x00000000 border=NONE hr=0x00000000 caption=#0E0813 hr=0x00000000 dark-mode hr=0x00000000
[Outpeek] app window 1180x780 physical
[Outpeek] nav -> settings        # debug builds only, one line per sidebar click
```

A refused attribute (negative HRESULT) adds a
`a DWM attribute was refused; that part keeps the system frame` line and the app
carries on. Off Windows the pass logs `skipped (non-Windows host)`.

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

### Drive the UI from an agent (Slint MCP)

Slint 1.18 ships an embedded MCP server over Streamable HTTP: list windows,
read the element tree, click/type, and capture screenshots. It is compiled in
and inert until a port is given.

```bash
outpeek-app.exe --mcp-port 8099
```

Then register it once in the agent's MCP config (OpenCode shown; needs a
restart to load):

```json
{
  "mcp": {
    "servers": {
      "outpeek-ui": { "type": "remote", "url": "http://127.0.0.1:8099/mcp" }
    }
  }
}
```

The same flag exists on the standalone `outpeek-overlay.exe`, so the HUD can be
driven headlessly (state injection still goes through stdin NDJSON there).

Build with `SLINT_EMIT_DEBUG_INFO=1` when an agent has to click by name: without
it the element tree exposes handles and geometry but no type names or accessible
labels, so there is nothing for "click the Settings row" to target. With it, the
sidebar rows report `accessibleRole: Button` and their labels.

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

## Settings view

`Settings` is a real view now (sidebar row 2 of 4); `Tracker` and `Settings`
switch in place, `Overlay` and `Stretch` stay marked `SOON`. The sidebar rows are
real buttons — hover and pressed backgrounds, a focus ring on Tab, Space/Return
activation, pointer cursor — and the header title plus the active-row spine
follow the selection (`navigate` goes through Rust, so the state has one owner).
Every row is a value resolved on this machine or a sentence saying why it is not:

| Row | Reads from |
| --- | --- |
| HUD overlay | the same `Tracker.hud-enabled` + `overlay_renderer.txt` toggle the rail uses; one line for the foreground rule, one for the file it persists to |
| Appearance | fixed dark — the page states it instead of rendering a dead switch |
| Data & logs | `paths::app_data_dir()`; log dir resolved as `%LOCALAPPDATA%\<identifier>\logs` (APPDATA, then temp fallback) — selectable text, Ctrl+C copies |
| Slint MCP | `SLINT_MCP_PORT` (set by `--mcp-port`); unset / valid / invalid are three distinct messages |
| Version | `CARGO_PKG_VERSION`, `debug`/`release`, and the compiler's own `TARGET` emitted by `build.rs` |
| Not ported yet | stretch/resolution, config editor, GPU report, updates, HUD edit mode — each with its reason |

All strings come from `src/settings_model.rs`, which is pure and unit-tested
(path fallbacks, MCP states, version formatting, non-empty not-ported list).

## Deliberately not ported yet

* Stretch and Overlay views — sidebar rows are marked `SOON`.
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
cargo test --manifest-path outpeek-app/Cargo.toml       # 45
```

Coverage that matters here: partial facts frames, roster → Slint facts, app
never click-through / overlay always click-through, lockfile shape errors,
name/tag formatting, tier labels (Unrated→Radiant), phase titles, no-client
state, transient-error recovery, rank error ≠ Unrated, region from the access
token, rank payload parsing, the four-condition HUD visibility gate, and the
Settings page's path fallbacks, MCP port states, version/build lines, and the
non-empty not-ported list.
