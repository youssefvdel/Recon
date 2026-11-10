# Recon v2 — information architecture

Status: proposal, defended below. Three destinations, one top bar, no sidebar. Live is a state of the
default surface, never a destination. Tools are a sheet, not a nav tree.

## The model

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Recon v2        Now        Matches        Prep         LIVE  ⌘K   ⋯  – □ × │
├──────────────────────────────────────────────────────────────────────────┤
│ [ live strip — only while a lobby exists, 40px, sticky under the bar ]    │
│                                                                          │
│   Now — act record + metrics + recent matches                            │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

| Destination | Job | Default |
| --- | --- | --- |
| **Now** | what is happening / how the act is going / the live lobby | **yes** |
| **Matches** | the season ledger; open one match in place | no |
| **Prep** | agent pool + map pool for the selected act | no |

- **Now is the default.** It answers the question the app is opened for: “where am I right now?” A live
  lobby is the top of Now (sticky strip + optional lobby rows), not a separate page. A previous match is
  the same surface with an attention label, not a second destination.
- **Matches and Prep are the two deep-work surfaces.** Both are tables/feeds with in-place expansion; no
  cards, no sub-tabs. Act scope is chosen in each surface’s header, not duplicated in a global control.
- **Tools and Settings are sheets.** `⋯` and `⌘K` open one Tools sheet with anchored sections: Store,
  Crosshair, Pre-Picker, Resolution, Riot Chat, Accounts. Settings is its own sheet via `⌘K`/`⋯`, because
  it is configuration, not a daily surface. There is no sidebar and no tools destination.

## Why this count

1. **Three recurring jobs, not twelve.** Tracker, Store, Crosshair, Pre-Picker, Resolution, Chat and
   Accounts were peers in the sidebar, but only Now/Matches/Prep are used every session. Making utilities
   peers of the main task was the old IA’s core mistake.
2. **Live is a state, not a place.** A destination you visit to find out whether you are live is a step
   the app can remove. The strip is present when the state exists and gone when it does not.
3. **Tools are occasional and anchored.** Store/Chat/Accounts are visited in bursts. One sheet with
   anchors keeps their state, keeps discovery through search, and removes six permanent nav rows.
4. **No sidebar = data width.** The old 288px rail cost more than navigation; the top bar + palette covers
   every destination, and the content column gains the space.
5. **A command layer scales without becoming a tree.** `⌘K` searches destinations and tools; `⋯` lists
   the same registry. Adding a tool later means one registry entry, not one more sidebar group.

## Shell and keyboard

- Top bar: brand, three destinations, live indicator, `⌘K`, `⋯`, window controls. Drag region is the bar
  background, not the controls.
- `⌘K` / `Ctrl+K` opens the palette; `⋯` opens the menu. One `CommandLayer` owns the only keydown listener
  for both, in capture phase; Escape closes it without reaching a match expansion. Nothing else owns
  Escape for overlays.
- Matches keeps its in-place expansion (one at a time); the match body owns Escape only while it is the
  focused inline state. No modal for match detail.
- Tools sheet owns no keydown. Section anchors are normal page anchors; the palette is the fast path.

## What dies

Sidebar and its groups; the five Tracker tabs; the six tool destinations as pages; the `live` tab; the
settings page shell (becomes a sheet); the old Overview cards and the old MatchDetailModal. Legacy routes
map to the new destination/anchor rather than dead-ending.

## Rebuild order (after the theme pick)

1. tokens + shell (top bar, palette/menu, destination switching)
2. Now (act header, live strip/lobby, feed)
3. Matches (ledger + in-place body from the current components)
4. Prep (two tables, shared expansion)
5. Tools sheet + Settings sheet; delete sidebar
6. surface-by-surface polish, then remove legacy code

The data layer (`src/sources/`, `src/live/`, `src/cache/`, Rust) is untouched throughout.
