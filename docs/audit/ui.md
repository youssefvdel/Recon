# Recon UI audit — states, hierarchy, consistency, accessibility, motion

Read-only audit, 2026-11-07, branch `fix/trn-captcha`, audited at HEAD `1122719`
(the docs commit `0263cfe` that captured this file adds only `docs/audit/`). The
app is Windows-only, so nothing here was reproduced live: every finding is evidence
from source and from the Tailwind tokens in `tailwind.config.ts`. Contrast ratios
were computed from those token values (WCAG 2.x relative-luminance formula).

Criteria: `impeccable` (Operate mode — scanability, consistency, native
expectations outrank expression) plus the Vercel Web Interface Guidelines.

Sibling audits already cover the overlay (`overlay.md`), performance (`perf.md`)
and product gaps (`ux-gaps.md`). This file is the app-UI layer. Where a sibling
already owns a site, I say so instead of re-counting it.

Per the audit README convention, findings that need a live Windows box are marked
**VERIFY**. Only finding 8 qualifies: its perceived delay is derived from the
configured Framer durations, so measure it on Windows before quoting it.

Legend — Effort: **S** < 2 h, **M** ≈ 0.5–1 day, **L** > 1 day. Value: player impact.
Ranked by value ÷ effort.

---

## 1. Missing data is rendered as a fake `0` or as an unexplained dash — S / High

**Problem.** A match row whose detail has not been fetched shows `0/0/0`, `ACS 0`,
`DDΔ 0`, `K/D 0.0` exactly like a real bad game, and a TRN stat that was never
requested shows a bare `—` whose meaning exists only in a code comment.

**Evidence.**
- `src/components/MatchHistory.tsx:435-441` — `k`, `d`, `a`, `acs`, `dd` are
  defaulted to `0` when `detailsById[matchId]` is missing; the row renders those
  zeros at `:261-279`. Only HS% falls back to `—` (`:275`).
- `src/components/LiveMatchView.tsx:612-621` — `trnBlank` shows a plain dash for
  any state other than `'pending'`; `src/types.ts:299` defines only
  `'pending' | 'unavailable'`, so a stat that was never requested gets a dash with
  **no** `data-tip`.
- The three cell states (3 px pending dot, dash, lock) are explained only in a
  comment at `LiveMatchView.tsx:608-611`; nothing in the UI decodes them.
- `LiveMatchView.tsx:913` — account-level dash, tooltip says only "Account level".
- `src/components/Overview.tsx:92`, `:202` — KPI cards show `—` for an act that
  failed to load, with no reason on the card.

**Fix.** One `<StatValue state="…" reason="…">` used by tracker, match history and
the overlay: renders the number, or `—` with an accessible reason, or the pending
dot. Render `—` (never `0`) whenever the source row has no match detail. Add a
one-line legend under the live table: `— not fetched · ● fetching · 🔒 private`.
This is the UI half of the project's data-honesty rule; the backend already keeps
the same discipline.

---

## 2. Every animation ignores `prefers-reduced-motion` — S / High

**Problem.** The only reduced-motion rule in the app covers the CSS modal
keyframes. Every Framer animation, the count-up tween, skeleton pulse and smooth
scrolling still run for users who asked the OS to reduce motion.

**Evidence.**
- `src/index.css:224-229` — the app's only `prefers-reduced-motion` block, and it
  only shortens `.m3-modal-*`.
- No `useReducedMotion`, no `MotionConfig` anywhere in `src/` (no matches for
  either).
- `src/App.tsx:467-474` (tab transition), `src/components/TrackerView.tsx:89-119`
  and `src/components/UtilityView.tsx:79-121` (sub-tab fades),
  `src/components/TopBar.tsx:572-582` (`repeat: Infinity` bob),
  `src/hooks/useCountUp.ts:5-20` (rAF number tween),
  `src/components/TrackerSkeletons.tsx:4` (`animate-pulse`),
  `src/index.css:11-19` (`scroll-behavior: smooth` everywhere).
- Motion-sensitive players are a real share of a gaming audience, and the overlay
  runs over a moving 3D scene.

**Fix.** Wrap the app tree in `<MotionConfig reducedMotion="user">` (one import in
`src/App.tsx`); add a CSS block disabling `animate-pulse` and smooth scroll under
`prefers-reduced-motion: reduce`; pass the same check into `useCountUp` so numbers
snap instead of tweening.

---

## 3. Type has no floor, and the smallest text is also the lowest-contrast text — M / High

**Problem.** On an Operate surface read at arm's length, table headers, link chips
and secondary stats are set at 7–9 px, and the muted tokens used for placeholders
fall to 1.9–3.5:1 contrast — the two failures compound.

**Evidence.**
- `src/components/LiveMatchView.tsx:553` — 11-column header row at `text-[8.5px]`;
  `:790`, `:806` — TRN/Blitz buttons at `text-[7px]`; `:869` — peak-act caption at
  `text-[7px]`.
- `src/components/TrackerMini.tsx:206-209`, `:228-233` — account level and RR at
  `text-[8px]`.
- 610 arbitrary `text-[Npx]` declarations below 12 px across `src/components/`;
  59 of them are 7–8.5 px.
- Computed ratios: `#938f99` (`m3-outline/70`) on `#23192f` = **3.29:1**;
  `m3-outline/40` = **1.93:1**; `zinc-500` = **3.47:1**; base `m3-outline` =
  5.30:1 and `m3-on-surface-variant` = 9.84:1.
- Failing sites: `src/components/Overview.tsx:456-459`, `:597-616`
  (`m3-outline/40` placeholder numbers); `src/components/OverlayView.tsx:1891`,
  `:2274` (`m3-outline/70`); `src/components/MatchDetailModal.tsx:863`
  (`zinc-500`).

**Fix.** Add a `fontSize` scale to `tailwind.config.ts` — `label` 10 px /
`data` 12 px / `number` 14 px — and delete arbitrary values below 10 px. For
text, use `m3-outline` (5.3:1) or `m3-on-surface-variant` (9.8:1); reserve the
`/70` and `/40` steps for icons and dividers. Start with the 59 sub-9 px cells:
they are the unreadable ones.

---

## 4. Every modal is invisible to assistive tech and lets Tab escape behind it — M / High

**Problem.** Dialogs are plain fixed `<div>`s: no dialog role, no `aria-modal`, no
focus trap, no focus restoration, no initial focus. Keyboard users can tab into
the page behind an open modal and get no announcement that it opened.

**Evidence.**
- `src/components/MatchDetailModal.tsx:413-420` — wrapper and backdrop, no
  `role="dialog"` / `aria-modal` / `aria-labelledby` anywhere in `src/` (zero
  matches for those strings). Escape is handled at `:105-116`, but the close
  button at `:526-531` is icon-only with no `aria-label`.
- `src/components/PlayerOverviewModal.tsx:164-180` — same, and **no** Escape
  handler at all. Close button at `:285-290` is icon-only.
- `src/components/LoadoutViewer.tsx:323` — same pattern (Escape exists at `:257-263`).

**Fix.** One shared `<Modal>` primitive: `role="dialog"`, `aria-modal="true"`,
`aria-labelledby`, focus trap (or `inert` on the app root), focus the close button
on open, restore focus on close, Escape always closes, and `aria-label` on the
icon close button. These modals already share identical styling, so this is a
mechanical extraction.

---

## 5. Half the toggles and all three tab bars hide their state from screen readers — S / Med

**Problem.** Five settings switches and the consent ON/OFF pair are bare
`<button>`s with no checked state, and the sidebar plus both tab rows are ordinary
buttons with no selected state — even though five other files already implement
switches correctly.

**Evidence.**
- No state: `src/components/AppSettingsView.tsx:649-661`, `:674-686`, `:699-711`,
  `:800-812`, `:825-837`; `src/components/ConsentModal.tsx:31-44`; the release
  channel picker `AppSettingsView.tsx:456-502` (radio semantics missing).
- Navigation state: `src/components/Sidebar.tsx:234-264`,
  `src/components/TrackerView.tsx:62-83`, `src/components/UtilityView.tsx:56-71` —
  no `aria-current`, `aria-selected`, `role="tablist"` or `role="tab"` anywhere.
- Already correct (use as the template): `src/components/CrosshairView.tsx:67-68`,
  `src/components/HardwareScaling.tsx:238-239`,
  `src/components/PrepickView.tsx:174-175`,
  `src/components/UnifiedStretch.tsx:618-619`,
  `src/components/ValorantConfig.tsx:542-543`.

**Fix.** Extract the existing switch markup into `components/ui/Toggle.tsx`
(`role="switch"`, `aria-checked`, visible label) and replace the five bare ones
plus Consent's pair. Add `aria-current="page"` to the active sidebar item and
`role="tablist"`/`role="tab"`/`aria-selected` to the two tab rows.

---

## 6. Backdrop blur leaks into main-window chrome, not just the HUD — S / Med

**Problem.** The overlay-specific blur is covered in `overlay.md`; what that
document does not count is the same banned effect on the main window's header,
toast and every modal backdrop, where it is pure GPU cost over a static surface.

**Evidence.** `src/components/TopBar.tsx:390` (header), `src/App.tsx:593` (toast),
`src/components/MatchDetailModal.tsx:418`,
`src/components/PlayerOverviewModal.tsx:171`,
`src/components/LoadoutViewer.tsx:323`, `:121`, `:399`,
`src/components/CustomResolution.tsx:304`, `src/components/PrepickView.tsx:388`,
`src/components/StorePanel.tsx:263`, `src/components/TopBar.tsx:531`.
`AGENTS.md` bans CSS backdrop blur outright.

**Fix.** Delete `backdrop-blur-*`; raise the tint (`/85`–`/90`) where the plate
needs separation. The header sits over a solid `m3-surface`, so the blur has
nothing to sample — removing it is a no-op visually.

---

## 7. The themed tooltip is mouse-only, and it carries explanations found nowhere else — S / Med

**Problem.** `data-tip` is the only place the app explains why a stat is a dash,
what the incognito eye means, which act a peak rank came from, and what a table
column measures — but the tooltip never opens for keyboard or screen-reader users.

**Evidence.** `src/components/ReconTooltip.tsx:39-73` listens to `mouseover` /
`mouseout` only — no `focusin`/`focusout`, and targets get no
`aria-describedby`. Consumers include `LiveMatchView.tsx:556-564` (column
meanings), `:704-710` (incognito), `:856` (peak act), `:618` (dash reason), and
the icon-only copy buttons in `MatchHistory.tsx:342-353`. The
`mouseout` handler also hides on child-to-child movement, so tooltips on nested
spans flicker and re-wait the 280 ms delay (`:14`, `:35-37`, `:61`).

**Fix.** Add `focusin`/`focusout` (delegated, same pattern) and mirror the
attribute into `aria-describedby` on focus; switch the hide handler to
`pointerout` with a `relatedTarget` containment check. Keep any information the
user needs to trust a number out of hover-only territory (see finding 1).

---

## 8. Every tab switch blanks the pane for ≈0.4–0.6 s (**VERIFY**) — S / Med

**Problem.** Nested `AnimatePresence mode="wait"` layers force the old view to
finish fading out before the new one mounts; on a tool people tab through
constantly, navigation feels heavy.

**Evidence.** `src/App.tsx:467-474` — top-level switch, explicit `duration: 0.2`
for exit **and** enter; `TrackerView.tsx:89-119` and `UtilityView.tsx:79-121` —
sub-tabs, no `transition` prop, so Motion's default tween plays on each half.
A tracker sub-tab switch pays the inner pair (≈0.6 s); a top-level switch pays the
outer pair (0.4 s).

**Fix.** Keep one 120–150 ms opacity cross-fade, drop the exit (`mode="sync"` or
no `exit`), and remove the animation entirely for in-page sub-tabs. Pair with
finding 2 so reduced-motion users get an instant swap.

---

## 9. Status copy states implementation facts the app never verifies — S / Med

**Problem.** Two status readouts describe internals rather than outcomes, and one
asserts a GPU state that is hardcoded — which the project's own rules forbid.

**Evidence.**
- `src/components/AppSettingsView.tsx:844-852` — "Native Win32 GDI &
  DirectComposition GPU pipeline enabled." plus a literal `ACTIVE` badge, no
  read-back. `AGENTS.md`: "Never display a GPU/display state that was not read
  back from the machine — mark unverifiable rows UNVERIFIED."
- `src/components/TopBar.tsx:443-448` — "APIs Ready", truthful only of the dev
  kill-switch.
- Internal phrasing: `src/components/Overview.tsx:330` ("Nothing is shown rather
  than the current act's numbers"), `src/components/TrnStatusBanner.tsx:94-100`
  ("...Riot-direct data stays available meanwhile").

**Fix.** Replace with outcomes and a source: "Hardware acceleration — active
(Windows reports GPU acceleration)" or mark `UNVERIFIED`; "Live stats — connected";
"Couldn't load this act. Retry — the current act's numbers stay hidden until it
loads." Keep the specific, good copy elsewhere (`PlayerOverviewModal.tsx:421-435`
is a model for honest error states).

---

## 10. The same metric is formatted three or four different ways — S / Med

**Problem.** K/D and HS% change precision between views, so the same number looks
different depending on where you read it.

**Evidence.** K/D: `src/components/Overview.tsx:350` (3 decimals),
`src/components/MatchHistory.tsx:661` (2), `:262` (1), `:707` (1). HS%:
`Overview.tsx:520` (2), `MatchHistory.tsx:310` (1), `:275` (integer),
`src/components/MatchDetailModal.tsx:704` (raw `{p.hsPct}%`).

**Fix.** `src/utils/format.ts` with `kd()`, `pct()`, `rr()`; one decimal for K/D,
one for per-match HS%, whole number for aggregate HS%; use them everywhere
(including the overlay, which already builds its own strings).

---

## 11. Tracker sub-views disagree on page chrome — M / Med

**Problem.** The five tracker sub-tabs have three different page shells: some
start with a title, some with filters; padding, card radius and table-header tint
all differ, so the section feels assembled from different apps.

**Evidence.**
- Titles: `src/components/TrackerAgents.tsx:266-270` — `h2` "Agent Performance" +
  subtitle; `src/components/TrackerMaps.tsx:259-263` — uppercase "MAPS", no
  subtitle; `Overview.tsx:298` and `MatchHistory.tsx:615` — no page title at all.
  Only `AppSettingsView.tsx:405` uses an `h1`, so heading level depends on the tab.
- Padding: `Overview.tsx:298` `px-6 pt-3 pb-3`; `MatchHistory.tsx:615`
  `px-4 sm:px-6 py-3.5 pb-8`; `TrackerAgents.tsx:255` `py-3.5 pb-10`;
  `TrackerMaps.tsx:251` `py-4 pb-12`.
- Shell: `TrackerAgents.tsx:291` `rounded-3xl bg-m3-surface-container-low` vs
  `TrackerMaps.tsx:282` `rounded-2xl bg-m3-surface-container`; header tint
  `bg-m3-surface-container-high/70` vs `/50`.
- No shared primitives: 62 `h-8` vs 40 `h-9` vs 25 `h-10` height utilities;
  200 `rounded-xl`, 105 `rounded-2xl`, 26 `rounded-3xl` across `src/components/`.

**Fix.** `<PageShell title subtitle actions>` + `<TableCard>` used by all five
sub-tabs; one padding scale and one radius step for content cards. This also
gives every view a real `h1` again.

---

## 12. The support popover's close button runs away, and the sticker never stops bobbing — S / Low

**Problem.** Three minutes into a session an unprompted Ko-fi popover appears; its
close button teleports 26–56 px away from the cursor up to three times, the
sticker loops forever, and Escape/outside-click do not dismiss it.

**Evidence.** `src/components/TopBar.tsx:265-272` (3-minute timer),
`:247-256` (random dodge offset), `:536-546` (close button moves on hover,
`aria-label="Dismiss"`), `:572-582` (`animate` with `repeat: Infinity`). No
`Escape` or outside-click handler for `showClove`.

**Fix.** Static close button, one entrance animation, no infinite loop, close on
Escape and outside click. Keep the popover if the team likes it — it is the only
personality in the chrome — but it must not fight the user or burn frames while
queueing.

---

## What is already good (do not regress)

- Skeleton coverage is exceptional: 1:1 shapes for Overview, History, Agents and
  Maps (`TrackerSkeletons.tsx:8-503`), with shape-holding placeholders that stop
  reflow (`Overview.tsx:450-461`, `:597-616`).
- Empty and error copy is specific and actionable where it exists:
  `Overview.tsx:266-289`, `AccountsView.tsx:448`, `PlayerOverviewModal.tsx:421-435`.
- Tab restore and visibility-aware polling are done properly
  (`App.tsx:97-107`, `Sidebar.tsx:135-163`).
- The M3 token set is complete and consistent in `tailwind.config.ts`; the drift
  is in usage, not in the palette.

## Top 3 to do this week

1. **Make missing data honest** — kill the fake zeros, give the dash a reason and
   a legend (finding 1). ≈2–3 hours including the shared component.
2. **Honor reduced motion** — `<MotionConfig reducedMotion="user">` + one CSS
   block (finding 2). ≈1 hour, whole-app effect.
3. **Fix the text floor** — token scale + retire the 7–9 px cells and raise muted
   text to 5:1+ (finding 3). ≈1 day, biggest readability win on the tracker.

Smaller one-liners, not counted as findings: add `color-scheme: dark` to
`index.html:2` (native selects and pickers render light on Windows today); give the
app toast `role="status"` (`App.tsx:586-598`) so save confirmations are announced;
stack the three fixed `bottom-6 right-6` surfaces (`App.tsx:557`, `:593`,
`Overview.tsx:768`) so they cannot cover each other; add a "no matches for these
filters" state to `MatchHistory.tsx:692-760`.
