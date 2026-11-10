# Tools — Direction B spec, split into 5a and 5b

Six destinations are re-homed behind `⋯` and `⌘K`, and the sidebar groups die. That is the same
shape as step 2, so it ships in two commits:

- **5a — plumbing only.** Menu + palette that navigate to the routes that exist today. Nothing is
  re-homed, nothing is deleted, the layout does not move.
- **5b — re-homing.** The six surfaces become anchored sections of one `Tools` sheet; the six sidebar
  groups are deleted and their routes become anchors.

`alpha33` (from `ec0b41b`) is the last checkpoint before the shell work; both steps branch from it.

---

# 5a — Menu + ⌘K palette, no re-homing

## One navigation registry

`src/components/command/destinations.ts` is the only list of destinations. Menu and palette both render
from it; no duplicated arrays. Shape:

```ts
type NavTarget = { tab: TabType; trackerSub?: 'overview' | 'matches' | 'prep' };
type Destination = {
  id: string;
  label: string;
  group: 'Tracker' | 'Tools' | 'App';
  icon: LucideIcon;
  keywords: string[];        // “shop”, “res”, “friends”, “sens”…
  target: NavTarget;
  devOnly?: boolean;
};
```

Current destinations, all reachable through **both** surfaces:

| Group | Items |
| --- | --- |
| Tracker | Overview (`overview`), Matches (`matches`), Prep (`overview` + `trackerSub:'prep'`) |
| Tools | Store, Crosshair, Pre-Picker, Resolution Switch, Riot Chat, Accounts (existing tabs) |
| App | Valorant Config (`game_config`), Settings, Dev Dashboard (`dev`, dev builds only) |

Sub-views that are already inside a destination (Sensitivity, Custom Resolution, Stretch Preview, GPU,
Borderless, Valorant-config aliases) are **not** separate destinations in 5a; they stay reachable inside
their host surface. Every item that currently has a sidebar row or a top-level route is listed.

`navigate(target)` lives in `App` (it already owns `setCurrentTab`). For `trackerSub`, it sets
`currentTab='overview'` and keeps a small `pendingTrackerSub` state that is passed to `TrackerView` as
`initialSubTab` (which already updates its subtab when the prop changes) — no new route. `matches` stays a
top-level tab. 5a adds no `TabType` member. Clear `pendingTrackerSub` when the user clicks a Tracker tab so
an old request cannot re-open a subtab later.

## The `⋯` menu

- One 32px `⋯` button in `TopBar`'s right-controls cluster, before the refresh button. `aria-haspopup="menu"`,
  `aria-expanded`, `aria-label="Open tools menu"`.
- One popover panel anchored under it: 280px, `bg-m3-surface-container`, `border border-m3-outline-subtle`,
  radius 2px, **no shadow, no blur**. Three group labels (11px mono, uppercase), items 36px, icon + label +
  optional `⌘K` hint. No cards inside.
- Outside click and Escape close it; selecting an item navigates and closes it. Opening the palette closes it.
- Focus moves to the first item on open and returns to the `⋯` button on close. Arrow keys move; Enter
  selects; Home/End jump.

## The ⌘K palette

- `⌘K` (macOS) / `Ctrl+K` opens; the same shortcut closes only if already open. One entry point.
- Full-width overlay: fixed scrim `bg-black/50` (solid, **no backdrop-blur**), panel 620×auto at 12vh,
  `bg-m3-surface-container`, hairline border, radius 2px, no shadow. Input 16px, results 36px rows.
- Results are the registry, filtered by label + keywords, grouped; arrow keys move, Enter navigates, Escape
  closes, click selects. Empty query shows all groups; empty result shows one 11px “Nothing matches” line.
- Focus goes to the input; Tab stays inside the palette (it is a real transient dialog); focus returns to
  the element that opened it. `role="dialog" aria-modal="true"`, input `role="combobox"`, list `role="listbox"`.

## Escape: exactly one owner

`CommandLayer` owns **the only** keydown listener for these overlays. It registers one `window` listener in
the **capture** phase:

- closed: only `⌘K`/`Ctrl+K` opens the palette; everything else is ignored;
- open: Escape closes and calls `preventDefault()` + `stopImmediatePropagation()`; arrows/Enter/Home/End are
  handled by the focused menu/palette.

Capture + `stopImmediatePropagation` is deliberate: the match body and ledger already own Escape in the
bubble phase. With the palette open, Escape must close the palette and **not** also collapse a match row or
close the player drawer. When the layer is closed it must not call `stopImmediatePropagation`, so those
surfaces keep working. TopBar’s existing support-popover Escape handler stays untouched and cannot see the
event while the command layer is open.

No menu item, input, list row or panel may call `addEventListener('keydown')`; components other than
`CommandLayer` must not own Escape.

## 5a deletions

None. Sidebar, all six tools surfaces, settings, and every route remain exactly as they are. The only new
UI is the `⋯` button and the overlay layer.

## 5a acceptance

- Every registry destination is reachable from the menu **and** the palette; selecting it lands on the same
  surface it does today (including Prep’s subtab), and the overlay closes.
- `⌘K` opens from any surface; Escape closes only the overlay; with a match expansion open underneath, the
  expansion stays open; with the player drawer open, the drawer stays open.
- Static: `grep -rn "addEventListener('keydown'" src/components/command` → exactly one match, in
  `CommandLayer`; palette/menu children → none. `grep -n 'Escape'` only in `CommandLayer` plus comments.
- No layout change: sidebar width, main content bounds, and TopBar height are unchanged apart from the new
  32px button in the right cluster; overlay is a portal, not in flow.
- `bun run build:ui` 0, `bun run lint` 0, all `scripts/*-check.ts` pass; no HUD files touched.
- `alpha33` remains recoverable; 5a changes no route or orphan.

---

# 5b — One Tools sheet, sidebar groups die

Only after 5a passes.

## One route, six anchored sections

- Add `tools` to `TabType`; `App` renders `ToolsSheet` for it. The six old tabs (`store`, `crosshair`,
  `prepick`, `switcher`, `chat`, `accounts`) become **anchors** on this route; legacy `currentTab` values
  (including the saved localStorage value) map to `tools` + the matching anchor instead of dead-ending.
- `ToolsSheet` is one 940px column, one page scroll, no inner tabs and no card container:
  `<section id="store">`, `#crosshair`, `#prepick`, `#resolution`, `#chat`, `#accounts` in that order.
  Each has an 11px mono section heading + hairline, then the surface’s existing content. The surface’s own
  page header, outer max-width and scroll shell are removed (the sheet owns them); internal content is not
  redesigned in this step.
- A section renders its surface only when it has been visited (or is first); visited sections stay mounted
  so Store/Chat state is not thrown away on scroll. Nothing polls just because the sheet URL is active for an
  unvisited section.
- Menu/palette registry entries for the six change from `{tab:'store'|…}` to `{tab:'tools', anchor:'store'|…}`.
  Navigate scrolls the section into view (`scroll-mt` under the top bar) and focuses its heading.
- The sheet owns no keydown. Escape remains solely `CommandLayer`’s; a palette opened over the sheet closes
  without moving the sheet.

## Sidebar deletions

Delete the six group arrays and their rendered entries from `Sidebar.tsx`: `STORE_TABS`, `CROSSHAIR_TABS`,
`PREPICK_TABS`, `CHAT_TABS`, `ACCOUNTS_TABS`, `UTILITY_TABS` (Resolution), and their imports/icons if no
longer used. Sidebar keeps Tracker, Settings, the version badge and the Active Display card until step 6
removes the shell. No sidebar group may remain that opens one of the six routes directly.

## 5b acceptance

- Sidebar has no Store/Crosshair/Pre-Picker/Resolution/Chat/Accounts entry; no dead `onSelectTab` values.
- All six are reachable through the sheet (anchors), the menu and the palette; deep link/legacy route lands on
  the correct section.
- Existing surface functionality is unchanged; the diff does not redesign their internals.
- One keydown owner still: `CommandLayer`; `ToolsSheet` and all six sections own none.
- `bun run build:ui` 0, `bun run lint` 0, all scripts; no HUD files touched. `alpha33` remains the rollback
  checkpoint for the shell changes that follow.
