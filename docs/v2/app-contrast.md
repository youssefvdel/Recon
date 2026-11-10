# The app, measured — v2 shell + Now

Measured against the running app, not a board: **http://192.168.100.2:5174/?v2=1**, 1440×900
(deviceScaleFactor 2), 2026-11-10.

`:5174` is served by ts-client's tree (`/home/youssefvdel/Projects/Recon-live`), so the source
references below are from that checkout. The rendered page is the v2 shell: 56px bar, act header,
`34–29`, `RECENT MATCHES`, five feed rows.

Tool: `bun scripts/theme-contrast.ts "http://192.168.100.2:5174/?v2=1"` (now waits for the rendered
text to stop changing — a Vite dev server compiles routes on first hit, and the old 600 ms wait
measured the wrong frame).

## Failures first

**No text/background pair fails.** All 26 rendered text nodes pass their threshold.

**One contract failure, not a contrast failure — the keyboard focus ring is not the theme token:**

| What | Measured | Where it comes from | Should be |
| --- | --- | --- | --- |
| Focus ring colour | `2px solid rgb(208, 188, 255)` (`#d0bcff`, Material violet) | `src/index.css:69` — a global `:focus-visible { outline: 2px solid #d0bcff; outline-offset: 2px }`, raw hex | `var(--focus)`, which in this theme resolves to `rgb(201, 242, 92)` (`#c9f25c`) |

The shell's own token is live — with `outline-style: none` (mouse focus) the computed
`outline-color` is `rgb(201, 242, 92)`, i.e. `--focus` resolves correctly. The legacy global shorthand
then overwrites the colour whenever the ring is actually painted. A theme swap would therefore leave a
violet ring on a lime shell.

Visible either way: the ring measures **11.11:1** against the bar. This is a token-contract defect, not
an accessibility failure.

## Every text/background pair

| Ratio | Need | Size / weight | Foreground | Background | Element | Text |
| --- | --- | --- | --- | --- | --- | --- |
| 5.67 | 4.5 | 12px / 400 | `rgb(138, 153, 141)` | `rgb(24, 30, 25)` | `span` chip | `Offline` |
| 5.67 | 4.5 | 12px / 400 | `rgb(138, 153, 141)` | `rgb(24, 30, 25)` | `button` | `⌘K` |
| 5.67 | 4.5 | 12px / 400 | `rgb(138, 153, 141)` | `rgb(24, 30, 25)` | `button` | `⋯` |
| 6.16 | 4.5 | 14px / 400 | `rgb(138, 153, 141)` | `rgb(17, 21, 18)` | nav `button` | `Matches` |
| 6.16 | 4.5 | 14px / 400 | `rgb(138, 153, 141)` | `rgb(17, 21, 18)` | nav `button` | `Prep` |
| 6.53 | 4.5 | 12px / 400 | `rgb(138, 153, 141)` | `rgb(10, 13, 11)` | act eyebrow | `Episode 9 · Act 3` |
| 6.53 | 4.5 | 12px / 400 | `rgb(138, 153, 141)` | `rgb(10, 13, 11)` | label | `as of 4h ago` |
| 6.53 | 4.5 | 12px / 400 | `rgb(138, 153, 141)` | `rgb(10, 13, 11)` | `h2` | `Recent matches` |
| 6.53 | 4.5 | 14px / 400 | `rgb(138, 153, 141)` | `rgb(10, 13, 11)` | feed score | `13–9` (×5) |
| 6.78 | 4.5 | 12px / 700 | `rgb(255, 102, 88)` | `rgb(10, 13, 11)` | feed mark | `L` (×2) |
| 10.80 | 4.5 | 12px / 700 | `rgb(99, 214, 154)` | `rgb(10, 13, 11)` | feed mark | `W` (×3) |
| 13.19 | 4.5 | 14px / 400 | `rgb(201, 242, 92)` | `rgb(24, 30, 25)` | nav active | `Now` |
| 16.00 | 3.0 | 16px / 600 | `rgb(233, 241, 234)` | `rgb(17, 21, 18)` | brand | `Recon` |
| 16.96 | 3.0 | 36px / 900 | `rgb(233, 241, 234)` | `rgb(10, 13, 11)` | act record | `34–29` |
| 16.96 | 4.5 | 14px / 400 | `rgb(233, 241, 234)` | `rgb(10, 13, 11)` | feed map | `Ascent`, `Haven`, `Lotus`, `Sunset`, `Abyss` |

Notes on the new elements:

- **Bar (56px).** Brand 16.00, nav links 6.16, active `Now` 13.19 (lime text on `--surface-2`, not a
  filled pill), the three chips 5.67. The bar's muted layer is the weakest thing in the app and still
  clears AA by 1.17.
- **Act header.** Eyebrow 6.53, `34–29` 16.96 at 36px/900 (large-text threshold 3.0), `as of 4h ago`
  6.53.
- **Feed rows.** Map `#E9F1EA` 16.96, score muted 6.53, `W`/`L` marks below.
- **Placeholder body text:** none rendered — the fixture has no empty state in this build, so there is
  nothing to measure there yet.

## W and L — the two marks that carry meaning

| Mark | Colour | Ratio | Size | Verdict |
| --- | --- | --- | --- | --- |
| `W` | `rgb(99, 214, 154)` = `--positive` | **10.80** | 12px / 700 | Passes AA with 6.3 to spare. |
| `L` | `rgb(255, 102, 88)` | **6.78** | 12px / 700 | Passes AA with 2.28 to spare. |

Both are bold 12px, so they need 4.5 (not the 3.0 large-text rule). Neither is close to failing — this
is the one part of the theme where the numbers are unambiguously safe.

## Focus in the real shell

Tested with real input events over CDP, not `element.focus()`:

| Interaction | `:focus-visible` | Computed outline | Offset | Ratio vs bar |
| --- | --- | --- | --- | --- |
| `Tab` ×1 → `Now` | true | `solid 2px rgb(208, 188, 255)` | 2px | 11.11 |
| `Tab` ×2 → `⌘K` / `⋯` | true | `solid 2px rgb(208, 188, 255)` | 2px | 11.11 |
| Mouse click on `Prep`, fresh page (no prior Tab) | **false** | **`none`** (computed `outline-color` still `rgb(201, 242, 92)`) | 0px | — |
| Mouse click on `Matches` after Tabbing | false | `none` | 0px | — |

So the behaviour is right in both directions: keyboard paints a 2px ring with a 2px offset, a mouse
click paints nothing. The colour is the defect above (`#d0bcff` instead of `--focus`).

## Raw hex and Tailwind colour classes

**`src/v2/` is clean.** `grep -rnE '#[0-9a-fA-F]{3,8}' src/v2/` returns hits **only** in
`src/v2/tokens.css` — 20 token definitions, which is where hex belongs. There are **zero** hits
outside it, and **zero** Tailwind colour utilities (`text-white`, `bg-black`, `border-zinc-*`, …) in
any `src/v2/` file.

The escape is outside that tree, in the shared sheet the shell inherits:

| File | Line | Value | Impact on the v2 shell |
| --- | --- | --- | --- |
| `src/index.css` | 69-70 | `outline: 2px solid #d0bcff; outline-offset: 2px` | **Yes** — overrides `--focus`, the focus-ring defect above |
| `src/index.css` | 62-63 | `::selection { background: #4f378b; color: #e8def8 }` | Yes — selection in the shell is Material violet |
| `src/index.css` | 128 | `input[type=range].m3-range` track `#3a2a4c` | Not yet — no range input in the shell |

## Verdict

**Does the shipped app meet AA? Yes** — every one of the 26 rendered text nodes passes, the weakest at
5.67, and both meaning-carrying marks (`W` 10.80, `L` 6.78) are safe.

**It does not yet meet the token contract**, and the fix is one token: `--focus`.

- Change `src/index.css:69` from `outline: 2px solid #d0bcff` to `outline: 2px solid var(--focus)`
  (keep `outline-offset: 2px`). That makes the ring lime in the graphite theme and follows any future
  theme swap.
- Scope the legacy rule if the old app must keep violet: `html:not([data-v2]) :focus-visible { … }`
  or apply the v2 ring inside `src/v2/`.
- `::selection` is the same class of leak and will show first when text selection becomes common in the
  shell.

No component in `src/v2/` needs to change for contrast. The only components that would change are the
two shared-stylesheet rules above.
