# Theme contrast — measured, not judged

Measured on the v2 boards **as rendered**: Nocturne (`board-a.html`), Graphite (`board-b.html`),
Ledger (`board-c.html`), served by `recon-v2-boards.service` at `http://192.168.100.2:8110/`.
Nothing in the boards was edited.

The measurement is a committed check, not a one-off: [`scripts/theme-contrast.ts`](../scripts/theme-contrast.ts).
When the v2 shell exists, the same command runs against the app instead of the boards.

## Method

- Headless Chromium 156 (`--headless=new`), viewport 1600×1000, pages loaded from the live service.
- Every value comes from `getComputedStyle`, not the source CSS: computed `color`, `font-size`,
  `font-weight`, and the **effective background** (ancestor backgrounds composited in order, with
  `rgba` alpha resolved against what sits behind it).
- Ratio is WCAG 2.1 relative luminance, computed in-page on the final composited colours.
- Thresholds: normal text **4.5:1**, large text (≥24px, or ≥18.66px at weight ≥700) **3:1**,
  non-text UI **3:1**.
- **Decorative marks are measured but do not count as failures**: anything under `aria-hidden="true"`
  or carrying a `stamp`/`watermark`/`decor` class. They are listed so nobody "fixes" them by accident.
- Focus was tested by focusing the first four focusable elements and diffing the computed outline
  before and after, then counting `:focus` rules across every stylesheet.

```bash
bun scripts/theme-contrast.ts http://127.0.0.1:8110/board-a.html http://127.0.0.1:8110/board-b.html http://127.0.0.1:8110/board-c.html
bun scripts/theme-contrast.ts <url...> --fail     # exit 1 on any non-decorative failure
bun scripts/theme-contrast.ts <url...> --json     # machine-readable
```

## Summary

| Board | Non-decorative failures | Worst passing info pair | Accent as text | Accent as fill | Focus ring | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **A — Nocturne** | **0** | secondary 7.17 (card) | 11.15 ✓ | 10.13 ✓ | **1.04 ✗** | Text usable as shipped; keyboard focus invisible. |
| **B — Graphite** | **0** | secondary 5.67 (high card) | 14.33 ✓ | 14.43 ✓ | **1.03 ✗** | Same as A; healthiest accent of the three. |
| **C — Ledger** | **31** (29 × 4.48, 1 × 4.13, 1 × 4.49) | 5.41 (button on red) | 4.49–5.56 | 5.41 ✓ | 14.65 ✓ | Muted layer fails AA across the theme; accents fine; focus works by accident. |

No board has a single `:focus` / `:focus-visible` rule (`:focus` rule count: 0 / 0 / 0). A and B pass
only in the sense that the UA default outline is painted — in near-black.

---

## A — Nocturne (dark violet, page `rgb(11, 8, 17)`)

### Failures

**None that carry information.** The three marks below threshold are decorative:

| Ratio | Size | Foreground | Background | Element | Content | Excluded because |
| --- | --- | --- | --- | --- | --- | --- |
| 1.54 | 38px | `rgb(57, 52, 67)` | `rgb(21, 16, 32)` | `span.stamp` | `P//2` | class `stamp` |
| 2.27 | 18px | `rgb(84, 68, 104)` | `rgb(11, 8, 17)` | `span.chev` | `›` | `aria-hidden="true"` |
| 2.27 | 26px | `rgb(84, 68, 104)` | `rgb(11, 8, 17)` | `span.empty-mark` | `∅` | `aria-hidden="true"` |

### Passing pairs that carry information

| Ratio | Size | Foreground | Background | Role |
| --- | --- | --- | --- | --- |
| 17.47 | 11px | `rgb(244, 238, 251)` | `rgb(11, 8, 17)` | primary text, table numerals (n=27) |
| 16.13 | 11px | `rgb(244, 238, 251)` | `rgb(22, 19, 31)` | primary on raised surface |
| 16.39 | 11px | `rgb(244, 238, 251)` | `rgb(21, 16, 32)` | map / score line |
| 7.64 | 11px | `rgb(169, 155, 185)` | `rgb(11, 8, 17)` | secondary text, labels, table headers (n=30) |
| 7.17 | 11px | `rgb(169, 155, 185)` | `rgb(21, 16, 32)` | secondary on card |
| 6.66 | 11px | `rgb(169, 155, 185)` | `rgb(30, 23, 43)` | secondary on high surface |
| 14.20 | 11px | `rgb(168, 232, 197)` | `rgb(11, 8, 17)` | `WIN` |
| 9.91 | 11px | `rgb(255, 157, 144)` | `rgb(11, 8, 17)` | `LOSS` |
| 7.93 | 11px | `rgb(255, 122, 134)` | `rgb(11, 8, 17)` | `LIVE` chip |
| 10.49 | 11px | `rgb(229, 189, 107)` | `rgb(21, 16, 32)` | countdown timer |

### Accents

| Colour | As text | As fill | Could be used for numbers? |
| --- | --- | --- | --- |
| violet `rgb(201, 184, 255)` | **11.15** | **10.13** with `rgb(27, 16, 48)` text on it | Yes, both ways. |
| coral `rgb(255, 122, 134)` | 7.93 (`LIVE`) | — | Yes as text. |
| mint `rgb(168, 232, 197)` | 14.20 (`WIN`) | — | Yes as text. |

### Type

Smallest text is **11px** (61 of 85 text nodes); next 12px (6). Nothing below 11px. 11px is the
default, not the exception, and every one of those rows measures ≥7.17.

### Focus

No `:focus` rules. UA default outline `auto 1px rgb(16, 16, 16)` = **1.04:1** on the page:
invisible.

### Verdict

**Text: usable as shipped. Focus: not usable.** The palette is sound for reading and for numbers —
the violet accent works as text *and* as a fill. The blocker is keyboard navigation, not colour.

---

## B — Graphite (dark green-grey, page `rgb(10, 13, 11)`)

### Failures

**None that carry information.** Two decorative marks:

| Ratio | Size | Foreground | Background | Element | Content | Excluded because |
| --- | --- | --- | --- | --- | --- | --- |
| 1.93 | 26px | `rgb(61, 74, 36)` | `rgb(17, 21, 18)` | `span.stamp` | `P//2` | class `stamp` |
| 2.37 | 18px | `rgb(69, 82, 71)` | `rgb(10, 13, 11)` | `span.empty-mark` | `∅` | `aria-hidden="true"` |

### Passing pairs that carry information

| Ratio | Size | Foreground | Background | Role |
| --- | --- | --- | --- | --- |
| 16.96 | 11px | `rgb(233, 241, 234)` | `rgb(10, 13, 11)` | primary text (n=30) |
| 15.26 | 11px | `rgb(233, 241, 234)` | `rgb(21, 27, 16)` | primary on raised surface |
| 6.53 | 11px | `rgb(138, 153, 141)` | `rgb(10, 13, 11)` | secondary text (n=24) |
| 6.16 | 11px | `rgb(138, 153, 141)` | `rgb(17, 21, 18)` | secondary, table cells |
| 5.67 | 11px | `rgb(138, 153, 141)` | `rgb(24, 30, 25)` | secondary on high surface |
| 10.80 | 11px | `rgb(99, 214, 154)` | `rgb(10, 13, 11)` | `WIN` |
| 6.78 | 11px | `rgb(255, 102, 88)` | `rgb(10, 13, 11)` | `LOSS` |
| 7.55 | 11px | `rgb(255, 122, 69)` | `rgb(10, 13, 11)` | `LIVE` chip |
| 9.97 | 11px | `rgb(231, 184, 77)` | `rgb(17, 21, 18)` | countdown timer |

### Accents

| Colour | As text | As fill | Numbers? |
| --- | --- | --- | --- |
| lime `rgb(201, 242, 92)` | **15.19** (nav active) | **14.43** with `rgb(16, 21, 6)` text | Yes, both ways. |
| orange `rgb(255, 122, 69)` | 7.55 (`LIVE`) | — | Yes. |
| mint `rgb(99, 214, 154)` | 10.80 (`WIN`) | — | Yes. |
| coral `rgb(255, 102, 88)` | 6.78 (`LOSS`) | — | Yes. |

### Type

Smallest **11px** (73 of 85 nodes); one at 12px, four at 13–14px. Nothing below 11px.

### Focus

No `:focus` rules. UA outline `rgb(16, 16, 16)` on `rgb(10, 13, 11)` = **1.03:1**, invisible.

### Verdict

**Text: usable as shipped; the best-behaved accent. Focus: not usable.** Same blocker as A.

---

## C — Ledger (light warm paper, page `rgb(233, 225, 210)`)

### Failures first — the finding of the audit

The entire **secondary/muted layer** is a shade under AA:

| Ratio | Size | Foreground | Background | Count / examples |
| --- | --- | --- | --- | --- |
| **4.48** | 11px, 12px, 15px, 20px | `rgb(109, 100, 87)` | `rgb(233, 225, 210)` | **29 nodes** — nav items, `synced 2m`, eyebrow, `10 players`, *all* table headers, `#EUW` tags, match sub-lines, `54%` |
| **4.13** | 11px | `rgb(109, 100, 87)` | `rgb(230, 215, 200)` | `#EGY` on the tinted card |
| **4.49** | 16px | `rgb(180, 59, 40)` | `rgb(233, 225, 210)` | theme name `C — Ledger` (red on paper, 0.01 short) |

4.48 against 4.5 is 0.4% short — but it is short on 29 nodes of the largest information layer, and
4.13 on the tinted surface is not rounding. One token change fixes it; nothing else in the theme moves.

Decorative marks, excluded:

| Ratio | Size | Foreground | Background | Element | Excluded because |
| --- | --- | --- | --- | --- | --- |
| 1.44 | 32px | `rgb(208, 202, 192)` | `rgb(247, 241, 229)` | `span.stamp` | class `stamp` |
| 2.46 | 28px | `rgb(157, 142, 120)` | `rgb(233, 225, 210)` | `span.empty-mark` | `aria-hidden="true"` |

### Passing pairs that carry information

| Ratio | Size | Foreground | Background | Role |
| --- | --- | --- | --- | --- |
| 13.24 | 11–64px | `rgb(29, 27, 23)` | `rgb(233, 225, 210)` | primary ink (n=37) |
| 12.21 | 11px | `rgb(29, 27, 23)` | `rgb(230, 215, 200)` | primary on tinted card |
| 15.28 | 11px | `rgb(29, 27, 23)` | `rgb(247, 241, 229)` | primary on raised card |
| 4.84 | 11px | `rgb(47, 107, 79)` | `rgb(233, 225, 210)` | `WIN` |
| 5.56 | 11px | `rgb(158, 48, 39)` | `rgb(233, 225, 210)` | `LOSS` |
| 5.12 | 11px | `rgb(168, 50, 42)` | `rgb(233, 225, 210)` | `LIVE` chip |
| 5.41 | 11px | `rgb(251, 246, 234)` | `rgb(180, 59, 40)` | button text on the red fill |
| 4.53 | 11px | `rgb(151, 99, 28)` | `rgb(247, 241, 229)` | timer on a card (on the page bg it is **3.93** — fails) |

### Accents

| Colour | As text | As fill | Numbers? |
| --- | --- | --- | --- |
| red `rgb(168, 50, 42)` | **5.12** | **5.41** with cream text | Yes as text; fill is safe. |
| green `rgb(47, 107, 79)` | 4.84 (`WIN`) | — | Yes, little headroom. |
| coral `rgb(158, 48, 39)` | 5.56 (`LOSS`) | — | Yes. |
| ochre `rgb(151, 99, 28)` | 4.53 on a card, **3.93 on the page** | — | **No** — card only, or darken. |

### Type

Smallest **11px** (66 of 85 nodes); one 12px, the rest 13–64px. Nothing below 11px.

### Focus

No `:focus` rules. UA outline `rgb(16, 16, 16)` on `rgb(233, 225, 210)` = **14.65:1** — visible,
but by luck of the light background, not by design.

### Verdict

**Accents and primary ink: usable. Secondary text: fails AA on 31 nodes, by 0.02 (page) and 0.37
(tinted card).** Darkening the muted ink to about `rgb(100, 92, 79)` measures 5.07 on the page and
4.68 on the tinted card, which turns C into the only row of the table with no text failures at all.

---

## Cross-board findings

1. **None of the three boards has any focus styling.** `:focus` rule count 0 / 0 / 0. A and B inherit
   a near-black UA outline at ~1.0:1 — a keyboard user sees nothing. C inherits the same outline and
   it lands on light paper (14.65:1), so it works by accident. Focus must be a token
   (`outline: 2px solid <accent>; outline-offset: 2px`) before any theme ships.
2. **11px is the default body size in all three** (61 / 73 / 66 of 85 nodes). None goes below 11px, so
   there is no sub-11px hazard — but 11px at 4.48 (C) is the least forgiving combination in the set.
3. **Every accent passes as text *and* as fill** except C's ochre. Violet (11.15 / 10.13), lime
   (15.19 / 14.43) and red (5.12 / 5.41) are all usable for numbers; none of the three themes needs
   "fills only".
4. **The decorative marks are the only sub-3:1 elements, and all but the stamp declare themselves**
   (`aria-hidden`). The `P//2` stamp is excluded from `--fail` by its class name, not by markup —
   adding `aria-hidden="true"` to it would make the exclusion honest instead of a naming convention.

## What would change the verdicts

- **A and B:** add a focus token. Nothing else blocks them; they are the closer pair to shippable.
- **C:** darken the muted ink to `rgb(100, 92, 79)` (≥4.5 on every measured surface) and keep the ochre
  on the card only. Then C passes text, focus and accents.
- **All three:** define the focus ring as a token, and mark the stamp decorative in markup.

## Next measurement

When ts-client's shell step 1 is up, this same script runs against the app (`bun run dev` or the built
app) instead of the boards, including the focus ring once ui-audit adds the token. The boards are
illustrations; the app is what ships.
