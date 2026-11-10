# v2 rebuild — pre-change UI baseline

Captured from the Linux dev build at `http://192.168.100.2:5173/` (alpha33, `?fixture=lobby`).
Viewport **1440×900**, DPR 1; Overview also at **1920×1080**. Existing Brave page only: no user
tabs were used, no extra window was opened. A transient "Support on Ko-fi" card was dismissed before
capture.

The dev harness seeds fixture data by default, so these are the **populated** current UI, not the
IPC-absent empty shell. Per-route notes below say where a fixture command is still missing.

## Files

| File | Route | What it shows |
|---|---|---|
| `before-overview.png` | Tracker → Overview | Act header, KPI row, match feed, Previous Acts; cached-results banner from the fixture |
| `before-overview-1920.png` | Overview at 1920×1080 | Same page at the larger viewport |
| `before-matches.png` | Tracker → Matches | Ledger with 20 matches, filters, expanded match body |
| `before-prep.png` | Tracker → Prep | Agent and map tables for the current act |
| `before-store.png` | Store | **Empty:** "Open Valorant to load your daily shop." (storefront fixture missing) |
| `before-crosshair.png` | Crosshair | **Empty:** "Open Riot Client or Valorant to edit your crosshair." |
| `before-resolution.png` | Resolution Switch | Stretch/visualizer/setup/GPU tabs; native display from fixture |
| `before-chat.png` | Riot Chat | Friends/Requests/Blocked shell; friend list empty because the presence fixture is empty |
| `before-prepicker.png` | Pre-Picker | Auto-hover, fallback agent, map lineup; zero custom picks |
| `before-accounts.png` | Accounts | **View error:** "This view failed to load liveId.toLowerCase is not a function" |
| `before-settings.png` | Settings | Updates/startup/overlay/data/about sections; build string blank |
| `before-dev.png` | Dev Dashboard (`?dev`) | Dev-only route; overlay/tracker simulators (not part of the player UI) |

## Measurements (1440×900)

Definitions: **column** = the route's computed max-width column (else the main content area);
**rounded+bordered** = elements with computed `border-top-width > 0`, `border-top-left-radius > 0`
and area > 10,000 px² (buttons/badges and hairlines excluded); **page height** = document
`scrollHeight`; **main scroll** = the inner scroller's `scrollHeight / clientHeight`.

| Route | Column (px) | Rounded+bordered containers | Page height | Main scroll | Scrolls > 1 viewport | Notes |
|---|---:|---:|---:|---:|---|---|
| Overview | 940 | 0 | 900 | 844 / 844 | no | cached-results banner (2 h) |
| Overview 1920 | 940 | 0 | 1080 | 1024 / 1024 | no | main area 1632 px wide |
| Matches | 1152 | 21 | **1825** | 844 / 844 | **yes (~2.0×)** | internal list scrolls |
| Prep | 940 | 0 | 900 | 844 / 844 | no | 2 agents, map table |
| Store | 1152 | 1 | 900 | 852 / 844 | no | empty state, no fixture storefront |
| Crosshair | 1152 | 1 | 900 | 852 / 844 | no | empty state, no crosshair command |
| Resolution | 1104 | 12 | 900 | 852 / 844 | no | GPU settings "not read back" in fixture |
| Chat | 1152 | 0 | 900 | 852 / 844 | no | friend list empty (presence fixture) |
| Pre-Picker | 1024 | 14 | 900 | 852 / 844 | no | defaults only, 0 custom picks |
| Accounts | 1152 | 1 | 900 | 844 / 844 | no | view crashed on `liveId` |
| Settings | 896 | 17 | 900 | 844 / 844 | no | build/version string blank |
| Dev | 1440 | not counted | 900 | 900 / 900 | no | dev-only, full-width |

## Empty / failed surfaces the fixtures must cover

- **Store** — storefront command returns nothing: "Open Valorant to load your daily shop."
- **Crosshair** — crosshair read command missing: "Open Riot Client or Valorant to edit your crosshair."
- **Accounts** — account fixture shape breaks the view: `liveId.toLowerCase is not a function`; the
  view is replaced by its error boundary. This is a fixture/contract bug, not a copy choice.
- **Chat** — renders, but the presence fixture has no friends; it needs populated friends/requests.
- **Settings** — renders, but `local_client_version` is unanswered, so the build string is blank.
- **Resolution** — display fixture works; GPU settings report `Linux harness: not read back`.
- **Overview / Matches / Prep** — render from the seeded snapshot; no command-failure empty state.

Reproduce the empty shell instead with `?fixture=error` (every command throws) or `?fixture=empty`
(clears storage); those were not the baseline because the UI they produce is not the rebuild target.
