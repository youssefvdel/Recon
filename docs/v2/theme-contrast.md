# Theme contrast — measured, not judged

Three boards were measured as rendered: `/board-a.html` (Nocturne), `/board-b.html` (Graphite),
`/board-c.html` (Ledger), served at `192.168.100.2:8100`. Nothing in the boards was edited.

## Method

- Headless Chromium 156 (`--headless=new`), viewport 1600×1000, page loaded from the live server.
- Every value comes from `getComputedStyle`, not the source CSS: computed `color`, `font-size`,
  `font-weight`, and the **effective background** (ancestor backgrounds composited in order, with
  `rgba` alpha resolved against what sits behind it).
- Ratio is WCAG 2.1 relative luminance, computed in-page on the final composited colours.
- Thresholds: normal text **4.5:1**, large text (≥24px, or ≥18.66px at weight ≥700) **3:1**,
  non-text UI (borders, glyph affordances, focus rings) **3:1**.
- Focus was tested by focusing the first six focusable elements and diffing their computed
  outline/shadow before and after, then scanning every stylesheet for `:focus` rules.
- Numbers below are rounded to two decimals; the raw dump is in `/tmp/theme.json` on the server.

One caveat: a colour that sits on a translucent overlay is measured against the composite, so a row
that can render over two different surfaces may pass on one and fail on the other. Where that matters
it is called out.

## Summary

| Board | Text failures (info-bearing) | Accent as text | Accent as fill | Focus ring | Verdict |
| --- | --- | --- | --- | --- | --- |
| **A — Nocturne** | 0 | 11.15 ✓ | 10.13 ✓ | **1.04 ✗** | Text is solid; keyboard focus is invisible. Usable as shipped only for pointer users. |
| **B — Graphite** | 0 | 14.33–15.19 ✓ | 14.43 ✓ | **1.03 ✗** | Same as A: text passes, focus does not. |
| **C — Ledger** | **30 muted rows (4.13–4.48) + 5 glyphs** | 4.49–5.56 ✓ | 5.41 ✓ | 14.65 ✓ | Muted text fails AA by a hair across the whole theme; accents are the only colour layer that works. |

No board has a single `:focus` / `:focus-visible` rule in its stylesheets (`:focus` rule count: 0, 0, 0).
A and B "pass" focus only in the sense that the UA default outline is painted — in near-black.

---

## A — Nocturne (dark violet, page `rgb(11, 8, 17)`)

### Failures first

| Ratio | Size / weight | Foreground | Background | Element | Content | Reading |
| --- | --- | --- | --- | --- | --- | --- |
| **1.54** | 38px / 400 | `rgb(57, 52, 67)` | `rgb(21, 16, 32)` | `span.stamp` | `P//2` | Decorative watermark, but it is the largest glyph on the page and is invisible. Needs 3:1 as large text. |
| **2.27** | 18px / 400 | `rgb(84, 68, 104)` | `rgb(11, 8, 17)` | `span.chev` | `›` | UI affordance; needs 3:1 as a non-text component. Fails. |
| **2.27** | 26px / 400 | `rgb(84, 68, 104)` | `rgb(11, 8, 17)` | `span.empty-mark` | `∅` | Empty-state glyph; 3:1 required as large text. Fails. |

No information-bearing text fails. The three failures are the watermark and two glyphs.

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
| violet `rgb(201, 184, 255)` | **11.15** on `rgb(11, 8, 17)` | **10.13** with `rgb(27, 16, 48)` text on it | Yes, both ways. |
| coral `rgb(255, 122, 134)` | 7.93 (`LIVE`) | — | Yes as text; it is the live/attention signal. |
| mint `rgb(168, 232, 197)` | 14.20 (`WIN`) | — | Yes as text. |

### Type

Smallest text is **11px** (61 of 85 text rows); next are 12px (6). Nothing below 11px, so the
"sub-11px" question is moot — but 11px is the *default*, not the exception, and every one of those
rows sits at 7.64 or higher, which is comfortably AA.

### Focus

No `:focus` rules exist. The UA default outline renders as `auto 1px rgb(16, 16, 16)` — **1.04:1**
against the page. Keyboard focus is effectively invisible.

### Verdict

**Text: usable as shipped. Focus: not usable.** The palette is sound for reading and for numbers —
the violet accent works as text *and* as a fill, which is the strictest test. The blocker is
keyboard navigation, not colour.

---

## B — Graphite (dark green-grey, page `rgb(10, 13, 11)`)

### Failures first

| Ratio | Size / weight | Foreground | Background | Element | Content |
| --- | --- | --- | --- | --- | --- |
| **1.93** | 26px / 400 | `rgb(61, 74, 36)` | `rgb(17, 21, 18)` | `span.stamp` | `P//2` (watermark; needs 3:1) |
| **2.37** | 18px / 400 | `rgb(69, 82, 71)` | `rgb(10, 13, 11)` | `span.empty-mark` | `∅` (UI glyph; needs 3:1) |

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
| lime `rgb(201, 242, 92)` | **15.19** (nav active) | **14.43** with `rgb(16, 21, 6)` text | Yes, both ways — the healthiest accent of the three. |
| orange `rgb(255, 122, 69)` | 7.55 (`LIVE`) | — | Yes as text. |
| mint `rgb(99, 214, 154)` | 10.80 (`WIN`) | — | Yes. |
| coral `rgb(255, 102, 88)` | 6.78 (`LOSS`) | — | Yes. |

### Type

Smallest text **11px** (73 of 85 rows); one row at 12px, four at 13–14px. Nothing below 11px.

### Focus

No `:focus` rules. UA default outline `rgb(16, 16, 16)` on `rgb(10, 13, 11)` = **1.03:1**, invisible.

### Verdict

**Text: usable as shipped; the best-behaved accent. Focus: not usable.** Same blocker as A, one
degree worse: the secondary text sits slightly lower (6.5 vs 7.6) and the watermark is darker.

---

## C — Ledger (light warm paper, page `rgb(233, 225, 210)`)

### Failures first — this is the finding of the audit

The entire **secondary/muted layer** is one shade under AA:

| Ratio | Size | Foreground | Background | Used for |
| --- | --- | --- | --- | --- |
| **4.48** | 11px, 12px, 15px, 20px | `rgb(109, 100, 87)` | `rgb(233, 225, 210)` | nav items, `synced 2m`, eyebrow, `10 players`, **all table headers**, `#EUW` tags, match sub-lines, field labels, `54%` |
| **4.13** | 11px | `rgb(109, 100, 87)` | `rgb(230, 215, 200)` | `#EGY` and anything on the tinted card |
| 4.13 | 20px | `rgb(109, 100, 87)` | `rgb(233, 225, 210)` | `54%` (20px is below the 24px large-text threshold) |
| **1.44** | 32px | `rgb(208, 202, 192)` | `rgb(247, 241, 229)` | `span.stamp` watermark |
| **2.46** | 28px | `rgb(157, 142, 120)` | `rgb(233, 225, 210)` | `∅` empty glyph |
| 4.49 | 16px | `rgb(180, 59, 40)` | `rgb(233, 225, 210)` | `›` chevron and `C — Ledger` theme name |

4.48 against a 4.5 requirement is 0.4% short — but it is short on **30 of its 36 uses**, on the
largest information layer in the theme, and `4.13` on the tinted surface is not a rounding error. The fix is a
one-token change (darken the muted ink by ~4–6%), not a redesign.

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
| 4.53 | 11px | `rgb(151, 99, 28)` | `rgb(247, 241, 229)` | countdown timer (card only — on the page bg it measures **3.93**, which fails) |

### Accents

| Colour | As text | As fill | Numbers? |
| --- | --- | --- | --- |
| red `rgb(168, 50, 42)` | **5.12** | **5.41** with cream text | Yes as text, just; fill is safe. |
| green `rgb(47, 107, 79)` | 4.84 (`WIN`) | — | Yes, but with little headroom. |
| coral `rgb(158, 48, 39)` | 5.56 (`LOSS`) | — | Yes. |
| ochre `rgb(151, 99, 28)` | 4.53 on card, **3.93 on page** | — | **No** — it passes only on the raised surface. Use it only there, or darken it. |

### Type

Smallest text **11px** (66 of 85 rows); one at 12px, the rest 13–64px. Nothing below 11px.

### Focus

No `:focus` rules either. The UA default outline happens to work here: `rgb(16, 16, 16)` on
`rgb(233, 225, 210)` = **14.65:1**. Visible by luck of the light background, not by design.

### Verdict

**Accents and primary ink: usable. Secondary text: fails AA on 30 of 36 uses, by 0.02 (page) and 0.37
(tinted card).** One token darkening fixes the theme; nothing else in it needs to move.

---

## Cross-board findings

1. **None of the three boards has any focus styling.** `:focus` rule count is 0 / 0 / 0. A and B
   inherit a near-black UA outline at ~1.0:1 — a keyboard user sees nothing. C inherits the same
   outline but it lands on light paper (14.65:1), so it accidentally works. Focus must be defined as
   a token (`outline: 2px solid <accent>; outline-offset: 2px`) before any theme ships.
2. **11px is the default body size in all three** (61 / 73 / 66 of 85 text rows). None goes below 11px,
   so there is no sub-11px hazard — but 11px at 4.48 (C) is the least forgiving combination in the set.
3. **The watermark `P//2` fails in all three** (1.54 / 1.93 / 1.44) and is the largest glyph on every
   page. Either mark it decorative (`aria-hidden`) and accept it, or give it 3:1 — it currently reads
   as a rendering artifact.
4. **The chevron / empty-state glyphs fail as UI components in all three** (2.27 / 2.37 / 2.46) against
   a 3:1 requirement. They are the only affordances that fail in every theme, so this is a system fix:
   one "muted glyph" token at ≥3:1 on each surface.
5. **Every accent in every board passes as text *and* as a fill.** That answers the accent question:
   none of the three needs "fills only". Violet (11.15/10.13), lime (15.19/14.43) and red (5.12/5.41)
   are all usable for numbers; C simply has the least headroom, and its ochre must stay off the page
   background.

## What would change the verdicts

- **A and B:** add a focus token. Nothing else blocks them; they are the closer pair to shippable.
- **C:** darken the muted ink until it reads ≥4.5 on every surface — from `rgb(109,100,87)` to about
  `rgb(100,92,79)`, which measures 5.07 on the page and 4.68 on the tinted card — and keep the ochre on
  the card only. Then C passes text, focus and accents.
- **All three:** one muted-glyph token at ≥3:1, and an `aria-hidden` decision on the watermark.
