# Recon v2 — theme contrast measurements

Method: WCAG 2.1 relative luminance, `(L1 + 0.05) / (L2 + 0.05)`. UI threshold for a focus indicator is
**3:1** against the adjacent surface; AA text is 4.5:1. Values are hex-in, ratio-out, no eyeballing.

## Focus ring — the single rule

`tokens.css` defines one shape for both shipping themes:

```css
:where(:focus:not(:focus-visible)) { outline: none; }
:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
```

`--focus-ring: #ffffff`, width 2px, offset 2px for Graphite and Nocturne. White is used, not the theme
accent, because the ring must read against the surface *and* not disappear into a lime/violet control. The
2px offset leaves the ring on the surface, so the surface is the adjacent colour being measured. No component
may re-declare this rule or invent its own focus style.

| Theme | Focus | surface-0 | surface-1 | surface-2 | Min | 3:1 |
| --- | --- | --- | --- | --- | --- | --- |
| Graphite | `#ffffff` | `#0a0d0b` **19.53** | `#111512` **18.42** | `#181e19` **16.95** | 16.95 | PASS |
| Nocturne | `#ffffff` | `#0b0811` **19.87** | `#151020` **18.64** | `#1e172b` **17.32** | 17.32 | PASS |

Keyboard-only proof: with a board reloaded, Tab focuses the first control with a 2px white outline at 2px
offset; a pointer click leaves the same control without an outline. The rule is `:focus-visible`, and the
boards carry the same token/rule so the screenshots cannot hide a missing focus state.

## Accent — Graphite lime

Graphite accent `#c9f25c` measures **15.19:1** as text on `surface-0` and **14.43:1** as fill on its control
surface. It clears AA as text, AA as a large fill, and the 3:1 UI threshold by a wide margin, so it is used
for numbers and actions without restriction. No accent needs a fill-only restriction.

## Ledger — measured, not shippable as-is

Ledger is the light board only. Its muted ink `#6d6457` measures **4.48:1** on the page and **4.13:1** on
cards; it fails AA in **30 of 36 uses**, including every table header. The one-token fix is **`#645c4f`**,
which measures **5.07:1** on the page and **4.68:1** on cards. Until that replacement is applied and
re-measured, Ledger is a theme to choose knowingly, not a shippable light theme.

Ledger's board focus ring is ink `#1d1b17` (13.24 / 15.28 / 12.08 on its surfaces) because white is only
1.3:1 on paper. This is board-only; the token contract ships Graphite and Nocturne.
