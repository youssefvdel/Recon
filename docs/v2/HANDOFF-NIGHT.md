# Night handoff — 2026-11-10, 22:11

Written because the line has no WAN right now (peak hours). `github.com` resolves
but TCP 443 hangs, so `git push` and any release are blocked. **Nothing here is
lost** — it is committed locally and needs one push when the line is back.

## State

- Branch `main`, **6 commits ahead of `origin/main`**, working tree clean.
- `alpha36` (released, mirrored, sha `3b7b46c9…`) is the last build anyone can
  install. Everything below is newer and unbuilt.

## What is in those 6 commits

| commit | what |
| --- | --- |
| `c5c3aeb` | **Nocturne is the theme** — `data-theme='nocturne'` by default, persisted in localStorage; Graphite stays one attribute away |
| `f9150a3` | Tools sheet: one heading per section (Store and Crosshair bring their own, so the page said STORE twice) |
| `a0062aa` | docs: Nocturne recorded as the chosen theme |
| `35362a1` | **legacy palette bridge** — the six old surfaces (match body, store, crosshair, chat, accounts, settings) now inherit the theme; 24 `m3-*` colours became CSS variables with their old hex as fallback, so nothing outside the shell changed |
| `352adb5` | Prep detail grid no longer prints `undefined / undefined / undefined`; empty rows are dropped, an empty expansion draws nothing |
| `24b20f6` | contrast: `m3-outline` used as text maps to the muted text role; the contrast script now skips `<button disabled>` (WCAG 1.4.3 exempts inactive components) |

## The HUD is provably untouched by the palette bridge

The bridge only applies inside the v2 shell (`[data-theme]`). Checked on the
legacy entry (`?legacy=1`, which is what the overlay window renders): the page has
**no `[data-theme]` element**, a `m3-surface-container` card computes
`rgb(35, 25, 47)` and the body `rgb(20, 14, 27)` — the original hexes, exactly as
before. So the overlay keeps its own palette and the bridge cannot reach it.

## Verified locally, without the network

- `bun run build:ui` → **0 TS errors**
- `bun run lint` → **0 errors** (56 warnings, pre-existing classes)
- **20/21** `scripts/*-check.ts` pass — the one that fails is `loadout-check`,
  and it fails only because it resolves the weapon catalog over the network.
- `bun test tests/` → **46 tests, 0 fail**
- `bun run uicheck` → **10/10 shipped routes pass**; legacy fallback 9/10,
  measured and not gated (it ships only as `?legacy=1`).
- `bun scripts/theme-contrast.ts` on Now and the Tools sheet → **no failures**
  after the two fixes above.

`bun run verify` is red **only** at the `check scripts` stage, on `loadout-check`,
because there is no WAN. That is the whole reason — not a code regression.

## When the line is back

```
cd ~/Projects/Recon
git push origin main                       # the 6 commits
bun run verify                             # must be fully green now
```

Then cut `alpha37` (the release gate runs `verify` on Linux, which will also
exercise the network-dependent check).

## Still unverified, and only the PC can settle it

1. The **live lobby strip** does not paint headless — the Tauri live path needs a
   real client, so its first match is its first test.
2. **Crosshair read-back** is type-checked only; a signed-in client is needed to
   prove GET-after-PUT matches.
3. The **HUD after the flip** is config-verified (`index.html#overlay` routes to
   the old tree) but has not run on Windows since the shell became the default.
