# Migration to Direction B — Season Stream

The target language is `design/board-b.html`. This is the order that gets there without a broken app.
Rules for every step: `bun run build:ui`, `bun run lint`, all `scripts/*-check.ts` green; the app boots;
the surface in that step matches its spec; nothing links to a deleted file; no HUD changes until the
final step. Each step is one mergeable commit.

## Order

| # | Step | Ships | Deletes | Acceptance |
| --- | --- | --- | --- | --- |
| 0 | Foundations | Tokens + primitives: `FeedRow`, `Sparkline`, `RoundRail`, `ActHeader`, `StatusLine`; colour contract documented | Nothing | Build/lint/scripts; primitives unused but compiled; no visual change |
| 1 | **Overview** | Act header + metrics + match feed + act history (`overview-b-spec.md`) | 8 cards, 4 KPI tiles, 5 local components, per-card motion, placeholder geometry | Screenshot matches spec; `Overview.tsx` < 450 lines; no `rounded-2xl`/`shadow-m3-1` in the file |
| 2 | Matches | One ledger + in-place match detail; round rail sticky; Duels toggle | `MatchDetailModal.tsx`, header mini round-strip, nested player modal as a modal (becomes drawer) | Open a match without a dialog; rail stays visible; Escape closes expansion only |
| 3 | Play / live | Live strip pinned at feed top + lobby rows; pre-round panel joins it | `LiveMatchView` page shell, its team cards | Live mock renders in the feed; no layout push; HUD untouched |
| 4 | Prep | Agents + Maps fold into one "Prep" sheet (agent pool, map pool) | Tracker's Agents/Maps tabs and their card shells | One route, two sections, no tabs; numbers unchanged |
| 5 | Tools | Store, Crosshair, Pre-Picker, Resolution, Chat, Accounts as anchored sections behind `⋯`/⌘K | Sidebar groups, per-page wrappers where possible | Every old destination reachable in ≤2 actions; no dead nav |
| 6 | Shell | Act scrubber + ⌘K + `⋯`; remove sidebar/topbar tab model | `Sidebar.tsx` tab groups, `TopBar` tab metadata, `TrackerView` tab shell | Deep-link by act/match works; back/forward sane |
| 7 | Settings | Settings as ⌘, dialog + tools section | Settings page shell; section cards | Every setting still reachable and persisted |
| 8 | Cleanup | Delete dead styles/tokens/components; update checks | `rounded-3xl` if unused, `shadow-m3-2/3` if unused, `BigTile`/`SmallStat`/`BodyFigure`/`RiotClientNotice`, old skeletons, empty-state card wrappers | `grep` for deleted imports empty; bundle size drops; all checks green |
| 9 | HUD (later) | Only after the window is stable; it already follows the colour rule | Nothing now | `hud-b-spec.md`; no mid-match regression |

## Why this order

- **Overview first** proves the language on the one surface every user sees, without touching navigation.
  If the feed feels wrong, nothing else has been rewritten.
- **Matches second** removes the modal and the duplicate round strip, which is the largest single block
  of deleted UI and the source of the deepest scroll.
- **Live third** keeps the in-game path working while the window is still old; the HUD is untouched.
- **Prep, Tools, Shell** come after the content surfaces, so no destination disappears before its
  replacement exists. Until step 6 the sidebar stays; after step 6 the tools menu is the only door.
- **Cleanup last** so dead-token deletion is evidence-based, not speculative.

## Data rules (from ts-client's prep)

- `games` is a list of matches (`TrackerMatch`), not a daily series. The feed draws one row per match.
  Sparklines come only from `detailsById[matchId].rounds`; no detail → no sparkline, never a fake one.
- Signed out: cached `profile`, `trn`, `trnPrev`, `trnAgents`, `detailsById` may render. Anything that
  needs the live client and has no cache is **absent**. No zeros, no dashes, no shape-holding boxes.
- Act record: `wins/games` from cached `profile`; `S.wins/losses` from `trn` when present. Win% absent
  if neither exists. RR/rank only from `profile` (cached profile is allowed).
- Past acts: `trnPrev` + `profile.seasons`; no live fetch implied by rendering.
- No round timer, no post-swap side, no per-day trend — the payload has none.

## Deletions by the end

- Components: `Sidebar` tab groups, `TopBar` tab metadata, `TrackerView` tab shell, `MatchDetailModal`,
  `MatchHistory` row cards, `LiveMatchView` team cards, `BigTile`, `SmallStat`, `BodyFigure`,
  `RiotClientNotice`, `OverviewSkeletons` (replace with one line), old empty-state cards.
- Styles/tokens to audit after step 8: `rounded-3xl` (only if no user), `shadow-m3-2`, `shadow-m3-3`,
  `m3-gold` (keep only if a stale/attention role remains), `m3-coral-container`, `m3-mint-container`,
  the card gradient wrappers. Remove only after `grep` shows zero use.
- Checks: update any source-grep invariant that references a deleted file, the same follow-the-seam
  rule used for the HUD split.

## Rollback

Each step is a commit on `main`; reverting step N leaves steps 0..N-1 working because no step removes a
surface before its replacement is merged. The old `Overview` is the only file replaced wholesale in
step 1, so its revert is one file.

## Step 2 — split into 2a / 2b / 2c (decided 2026-11-10)

The step is three commits, not one. 2a is banked: `MatchDetailBody` extracted, the
modal wrapper is 19 lines of chrome and no behaviour changed.

**2b — the ledger expansion. The decision this step needs, recorded here so it is
not re-litigated:**

> **One expansion at a time. Opening another row collapses the previous. Escape
> collapses the open row, and does nothing when none is open.**

Reasons: the expanded body is tall (scoreboard + sticky rail + round detail +
economy), so two open at once makes the ledger unreadable and "which match am I
looking at" ambiguous. The round rail is a single controlled `selectedRound`, so a
second expansion would require per-row selection state — the exact duplication this
refactor keeps deleting. `openIds: Set` becomes `expandedId: string | null`, and the
row's existing summary stays inside that one expansion.

**2c — delete `MatchDetailModal.tsx`** (19 lines) and update both importers: Matches,
and Overview, whose feed currently opens the modal.

**2c — Overview's feed needs a decision, not an import swap** (flagged during 2a).
The feed row calls `setOpenMatch` and renders `<MatchDetailModal>` at the bottom of
the page. When the modal is deleted, the row must either navigate to Matches with
that match expanded, or stop being clickable.

**Decision: navigate.** A row that looks clickable and does nothing is the same
defect as the chevron we just hid. Implementation: a small cross-tab event
(`recon:goto-match` with the match id) plus a listener in the ledger that sets
`expandedId` and switches the tab — `App` already listens for `recon:goto-live`, so
the pattern exists. Estimated five lines on the Overview side plus the listener.
Do **not** silently drop the affordance, and do not point it at the outgoing modal.

### Step 2 — closed 2026-11-10 09:09 (`d7a99ef`)

2a, 2b and 2c are all on main and the design judge passed **all five rules**:

| Rule | Evidence |
| --- | --- |
| One expansion | single `expandedId`, toggle id-or-null, one body under its own row |
| Escape scoped | listener counts — ledger 0, drawer 0, body **1**; body closes the drawer first |
| No dialog semantics | body root is `role="region"`; `role="dialog"`/`aria-modal` count 0 |
| Drawer, not modal | right-side fixed region, no backdrop, no Tab trap |
| Feed → ledger hand-off | the id survives the tab switch and is consumed once on mount |

**The rule this step earned:** *one keydown owner per surface.* Three handlers were
live at once — the ledger collapsed the row, the body closed drawer-or-row, and the
drawer closed itself — so one Escape did two things. The body now owns the only
handler and devqa asserts the counts, so the collision cannot come back silently.

`MatchDetailModal` is deleted; `MatchDetailBody` is the sole host. Step 3 (live) is next.
