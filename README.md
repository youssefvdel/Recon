# Recon

<div align="center">
  <img src="src-tauri/icons/icon.png" width="96" height="96" alt="Recon" />
  <h3>VALORANT esports companion &amp; competitive display toolkit</h3>
  <p>Live lobby scouting, in-game HUD widgets and true stretched resolution — read-only, zero injection.</p>

  [![Website](https://img.shields.io/badge/website-recon.qd.je-a8f5cc?style=flat-square)](https://recon.qd.je)
  [![GitHub Release](https://img.shields.io/github/v/release/youssefvdel/Recon?style=flat-square&color=d0bcff)](https://github.com/youssefvdel/Recon/releases)
  [![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-blue?style=flat-square)](https://github.com/youssefvdel/Recon)
  [![Tauri](https://img.shields.io/badge/tauri-v2-orange?style=flat-square)](https://tauri.app)
  [![TypeScript](https://img.shields.io/badge/typescript-3178c6?style=flat-square)](https://www.typescriptlang.org)
  [![License](https://img.shields.io/badge/license-Source--Available-blue?style=flat-square)](LICENSE)
</div>

---

## What it is

Two tools in one Windows desktop app.

**1. A competitive display toolkit.** True stretched resolution (1.45:1) with no
letterboxing, a two-way sensitivity matcher, a resolution switcher with a safe-mode
watchdog, a VALORANT config editor, and GPU/display scaling controls that are **read
back and verified** rather than assumed.

**2. A VALORANT companion.** Scout a lobby before the game starts — rank, peak, RR,
act and per-map performance, party grouping, country, and players who are playing
incognito — then keep a HUD over the game itself with the same per-player detail.

---

## Features

### Display & performance
- **True stretch, no black bars** — unlocks the 1.45:1 aspect floor and configures
  full-screen hardware scaling, expanding horizontal model width by **≈ +22.6%** while
  keeping 100% vertical FOV.
- **Sensitivity matcher** — bidirectional converter that compensates for the horizontal
  FOV change (`stretch_sens = native_sens ÷ 1.226`) so crosshair feel stays native.
- **Resolution switch** — 1.45:1, 4:3, 5:4, 16:10, 4:5, 5:3 or custom, with
  Win32 CCD switching that avoids a full display re-handshake.
- **Safe-mode watchdog** — testing a custom mode starts a **15-second countdown**; if
  you don't confirm, it reverts the display *and* removes the injected override.
- **GPU scaling panel** — reports what your machine *actually* has set (WDDM scaling,
  DWM DirectFlip, vendor keys), and marks each row **VERIFIED** or **UNVERIFIED**. It
  never claims a state it could not read back.
- **Borderless window handling** — opt-in, never automatic.

### VALORANT companion
- **Lobby scouting** — per-player rank emblem, peak rank with the act it was earned in,
  live RR, act W/L, K/D, win %, HS %, last-24h record, tracker.gg score tier, country
  flag, and party grouping coloured so stacks are obvious.
- **Incognito unmasked** — players hiding their name are resolved from their account
  UUID and shown, flagged as hidden.
- **Mode-aware stats** — the 24h column is scoped to the queue being played, so a
  ranked lobby never shows Deathmatch and Swiftplay results next to a rank.
- **In-game HUD widgets** — Agent Select and Top Agents over VALORANT, with an
  edit/play mode so the overlay stays click-through during a match.
- **Match history & breakdowns** — recent competitive games, per-match detail, act
  comparisons, per-agent and per-map performance, and true accuracy split by hit
  location (head / body / legs).

---

## The mathematics of true stretch

### The 1.45:1 aspect floor

Modern tactical shooters lock horizontal FOV and pillarbox once the rendered aspect
ratio drops below **29:20 (1.45:1)**:

$$\text{Min Width} = \text{Height} \times \frac{29}{20} = \text{Height} \times 1.45$$

| Native display | Native 16:9 | 1.45:1 stretched | Hitbox width gain |
| :--- | :--- | :--- | :--- |
| **1440p** | $2560 \times 1440$ | **$2088 \times 1440$** | **+22.6%** |
| **1080p** | $1920 \times 1080$ | **$1568 \times 1080$** | **+22.6%** |

> Widths are **8-pixel aligned** — display timing generators (AMD Adrenalin CVT in
> particular) reject modes whose horizontal resolution isn't divisible by 8. That is
> why the target is 2088, not the mathematically exact 2090.

### Sensitivity compensation

Stretched pixels span a wider visual angle per millimetre of screen, so sensitivity is
scaled by the width ratio:

$$k = \frac{\text{Width}_{\text{native}}}{\text{Width}_{\text{stretched}}} = \frac{2560}{2088} \approx 1.226$$

$$\text{stretched\_sens} = \frac{\text{native\_sens}}{k}$$

---

## Install

Grab the newest build from the [releases page](https://github.com/youssefvdel/Recon/releases):

| Asset | Notes |
| :--- | :--- |
| `Recon_<version>_x64-setup.exe` | Recommended. Standard Windows installer. |
| `Recon_<version>_x64_en-US.msi` | For managed/enterprise deployment. |

### Updates

Recon updates itself. It fetches a signed manifest from the latest release, **verifies
the download against its signing key**, installs quietly and relaunches — no browser,
no installer wizard. An update that fails signature verification is refused.

> Builds before **0.3.0** used an older update path and cannot self-update; install
> 0.3.0 or newer once by hand and it takes over from there.

---

## Development

### Prerequisites
- [Bun](https://bun.sh) — package manager and script runner
- [Rust](https://rustup.rs) (stable, `x86_64-pc-windows-msvc`)
- [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/downloads/) with the C++ desktop workload

### Setup

```bash
git clone https://github.com/youssefvdel/Recon.git
cd Recon
bun install
```

### Commands

| Command | Purpose |
| :--- | :--- |
| `bun run tauri dev` | Run the app with hot-reloading UI |
| `bun run build:ui` | Type-check and build the frontend |
| `bun run build` | Frontend + Rust build, no installer |
| `bun run build:bundle` | Full release with installers |
| `bun run lint` | Lint |
| `bun run bump -- X.Y.Z` | Bump the version in **both** `package.json` and `Cargo.toml` |

Rust builds land in `src-tauri/target/release/recon.exe`; installers in
`src-tauri/target/release/bundle/`.

> Always bump with `bun run bump`. The updater reads the *crate* version
> (`Cargo.toml`) while the bundle version comes from `package.json` — if they drift,
> update checks misbehave.

---

## Where the data comes from — and what isn't obtainable

Recon deliberately documents its data sources, because some of them are dead ends.
[`ROADMAP.md`](ROADMAP.md) records each finding, with evidence, so nobody
re-investigates them:

| Data | Source | Status |
| :--- | :--- | :--- |
| Lobby roster, agents, ranks, incognito | Riot local client API | available |
| Act / agent / map stats, ratings | tracker.gg (rate-limited, throttled) | available |
| Live round score, map, queue | local presence blob | available |
| Hidden MMR behind your rank | — | **Riot does not expose it** |
| Live per-player K/D/A in a match | — | **not in any API**; screen-read only |

**No memory reading. No injection. No input automation. No mutating Riot calls.**
Hovering an agent is fine; locking one is not. The overlay is a normal, click-through
window — nothing is attached to the game process.

---

## Tech stack

| Layer | Technology |
| :--- | :--- |
| Frontend | TypeScript, React 19, Tailwind CSS, Framer Motion, Lucide icons |
| Design system | Material Design 3 (dark, violet) |
| Backend | Rust, Tauri v2, Win32 via `windows-rs`, `winreg` |
| Display engine | Win32 CCD + GDI display settings |
| Graphics | DirectComposition GPU pipeline (no `WS_EX_LAYERED`, no CSS backdrop blur) |

---

## Documentation

- [`RELEASING.md`](RELEASING.md) — how to cut a release, and the signed-updater pipeline
- [`ROADMAP.md`](ROADMAP.md) — product direction and the verified data-source findings

---

## License

Copyright © 2026 Youssef Adel. All rights reserved. Source-available for personal auditing and evaluation. No redistribution or unauthorized commercial use permitted. See [LICENSE](LICENSE).
