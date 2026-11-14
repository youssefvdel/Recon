# Slint overlay design spec — Recon HUD sidecar

Owner: designer (UI/UX only). Rust host, tracker, and TS overlay untouched.
Date: 2026-11-14. Status: sidecar UI defined; Rust integration is the fixer's job.

## 0. What this is

A Slint replacement skin for the five-element Lite HUD defined in
`docs/trn-re/overlay-and-fetching.md` §5, running as an additive sidecar
behind a flag. The TS overlay (`src/components/hud/`) keeps shipping until
the fixer wires the Rust host; when it does, both skins render the same
facts — only the presentation layer changes.

Non-negotiable user bar: stock Slint widgets look like a debug tool. This
spec bans them — every surface is a custom `Plate` (layered gradient +
sheen + 1px inner stroke + shadow), Outfit/DM Sans/JetBrains Mono type,
no default widget chrome anywhere.

## 1. Tokens (`recon-overlay/ui/tokens.slint`)

M3 dark-violet, ported 1:1 from `tailwind.config.ts`:

- Surfaces: dim `#0e0813` → highest `#3a2a4c`; plates paint glass-top/bottom at `0xD9` (~85% alpha, same legibility as the TS `0.85` plates).
- Glass-without-blur recipe: `@linear-gradient(135deg, glass-top, glass-bottom)` + 30%-height top sheen (`#ffffff14`) + 1px inner stroke (`#ffffff12`) + `0/12/32 #000000b8` drop shadow. No `backdrop-filter` anywhere.
- Accents: primary `#d0bcff`, mint `#a8f5cc` (live/winning), amber `#e8b73a` (meta/warn), coral `#ff8a7a` (foe), party spines sky/gold/pink.
- Type: Outfit display 800/900 for titles, DM Sans body, JetBrains Mono micro/caption for data. Floor 11px (audit/ui.md #3).
- Radii 8/12/16/24 + pill; portraits pinned to the **72px** band (64–96px brief).
- Motion: fast 120ms, mid 200ms, slow 400ms; `ease-in-out` standard, `ease-out` for entrances. No springs, no loops, no `animation-tick()`.

## 2. Facts contract (`ui/facts.slint`)

Rust owns every value; `.slint` only renders. Key properties:

- `phase` (`idle|pregame|coregame`), `tab-held`, `edit-mode`, `lite`.
- Match strip: map, mode, phase-label, live, side, server, blue/red score.
- Rosters as `[PlayerFact]` (name, agent, icon, crest, locked, isme, party, rr with `-1` = unknown). Icons/crests arrive as `<image>` already resolved — the UI never touches a URL.
- `hint-line/source/win01/games` (Rust picks personal-vs-meta), `whisper/tone` (Rust times out).
- `cluster-x/y`, `ui-scale`, `display-key` (per-display layout, mirrors the TS `layouts` map).

## 3. Layout — two anchors, one cluster

Unlike the TS HUD's five free-floating widgets, the Slint sidecar renders
**one top-center cluster** (560px × scale) with two densities:

- **Agent-select** (`selecting`): MatchStrip + YourFive + MapHint.
- **In-match Tab-peek** (`peeking`): MatchStrip (score line fades in) + YourFive + EnemyGlance. Enemy glance paints *only* here or in edit — never ambient.
- StatusWhisper sits bottom-center, independent of the cluster; fades via a 400ms opacity anim.
- Per-display: Rust clamps + persists `cluster-x/y` keyed by `display-key` (bounds + DPI), same rule as the TS clamp (24px resize-handle floor). Scale steps (0.9/1.1) replace pixel resize-drag.

## 4. Edit mode

Dimmer (40% black fade) + bounds frame with display-key tag + top-center
toolbar (Lite/Full toggle, scale −/+, reset, lock). One `DragHandle` moves
the whole cluster via TouchArea deltas → `nudge-cluster` → Rust clamps.
Esc/lock returns to click-through; the `.slint` never captures input itself.

## 5. Components

| File | Renders | Notes |
|---|---|---|
| `components/plate.slint` | shared glass plate | hot spine, inner stroke, noise hook |
| `components/match_strip.slint` | 1/5 match strip | live dot animates mint/primary; score row fades in-match |
| `components/your_five.slint` | 2/5 your-five | 72px portraits, 28px crest overlap, fallback `?` tile under images, party spine, is-me 2px ring |
| `components/enemy_glance.slint` | 3/5 enemy glance | dimmed + coral edge; 64px cells; Tab-only caption |
| `components/map_hint.slint` | 4/5 pick hint | source chip (personal=primary, meta=amber) + 3px win bar |
| `components/status_whisper.slint` | 5/5 whisper | pill, tone-colored, 400ms fade, empty = invisible |

## 6. Motion map (all `animate`, no timers)

- Cluster + dimmer opacity: mid/ease-in-out on phase/edit flips.
- Score row, whisper: fast–slow fades only when text changes.
- Live dot color: fast fade. Win bar width: mid ease-out.
- Porter/drag feedback is the fixer's Rust-side clamp, not a UI anim.

## 7. Image pipeline (fixer implements)

URL → disk cache (keyed by content hash, capped ~50MB, LRU) → `slint::Image`
via `image` crate → set into `Facts.your-five/enemy-five` → `invoke_from_event_loop`.
Missing icon = fallback tile stays visible; never an empty hole, never layout shift.

## 8. Known Slint/Windows risks (verified 2026-11-14)

- **Transparency is not free** (upstream #722 open on Windows): `background: transparent` needs the fixer's DirectComposition wiring; `WS_EX_LAYERED` stays banned per AGENTS.md.
- **No OS click-through abstraction** (#6021): fully transparent pixels still hit-test — Rust must set hit-test passthrough outside edit mode.
- Portraits at 72px + `image-rendering: smooth` keep the Skia/Winit path cheap; no blur layer keeps repaint-on-demand honest.

## Open visual questions

1. Enemy glance density — portraits-only (current) or agent names under each?
2. Lite as fresh-install default vs opt-in (carries the §5 open question)?
3. Accent spine on your-five rows in Lite, or keep the cluster edge clean?
