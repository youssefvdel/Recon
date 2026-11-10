# Surface inventory — the contract the v2 shell must satisfy

Written before the shell rebuild, from the code at `ff9a901`. Every surface below is
presentation over data that already exists; the rebuild changes the first and must not
change the second.

**Engine that stays:** `src/sources/`, `src/live/`, `src/cache/`, `src-tauri/`.
**Hook line:** `useTrackerData` (the store) and the feature hooks under it.

## Tracker surfaces

### Overview — `components/Overview.tsx`
Consumes: `profile, seasonNames, seasonOrder, agentInfo, tierIcons, agg, trn, trnPrev,
trnAgents, trnFetchedAt, games, mapById, detailsById, isLoading, clientClosed, refresh`.
Owns locally: act record and win% (TRN blob, else `profile.wins/games`); metric row
(ACS from `trn.acs`, K/D and ADR with `agg` fallbacks, HS from `trn.hsPct` only); rank
line (RR only `tier > 2`); top-agent line (`trnAgents[0]` + `agentInfo` by name); the
five-row feed (`games` + `mapById` + `detailsById[matchId]` for verdict/score/agent/KDA,
ACS computed as `score/rounds`); sparkline outcomes from `detail.rounds` + my team; act
history (`profile.seasons` ordered by `seasonOrder`, K/D from `trnPrev[id.toLowerCase()]`);
a one-minute clock for relative ages; `actFetchKey` nonce so Retry re-issues the fetch.

### Matches — `components/MatchHistory.tsx`
Consumes: `profile, games, queueById, mapById, detailsById, agentInfo, tierIcons,
trnMatchTrs, isLoading`.
Owns locally: row derivation (map, verdict, score, agent/KDA/ACS, HS/KAST), agent and map
filters, sorting, **one** `expandedId` (opening another row collapses the previous),
Escape-to-collapse, the in-place `MatchDetailBody`, and the `recon:goto-match` hand-off
(id survives the tab switch through `initialExpandedId`).

### Match detail body — `components/matches/MatchDetailBody.tsx`
Consumes: `detail` (a `TrackerMatchDetail`), `game`, `tierIcons`, `agentInfo`, `puuid`.
Owns locally: verdict (`matchVerdict`, null unless both scores and a side are known),
scoreboard, section tabs, one `RoundRail` (controlled `selectedRound`), `RoundTimeline`
(detail + economy), duels, and the player drawer (`role="region"`, no aria-modal, no
focus trap, no keydown of its own — Escape is the body's).

### Prep — `components/Prep.tsx` + `prep/*`
Consumes: via `prep/usePrepData` → `useTrackerData` (`trnAgents, trnMaps, games,
detailsById, mapById, agentInfo, profile, seasonNames, seasonOrder, isLoading`) plus
`fetchTrnAgents/fetchTrnMaps/mergeAgentStats/mergeMapStats`.
Owns locally: **one** act selection shared by both sections, both local fallbacks (now
with every invented value zeroed), column sort, one expansion across both tables, and the
definition grids.

### Live — `components/live/LiveSection.tsx`
Consumes: via `live/useLiveLobby` → `fetchLiveMatchState, peekLiveMatchState, gameData,
matchEndHarvest, harvestMatchNames, isMatchStateEqual, mergeLiveMatchStateNonRegressing`,
`useSeasonNames`, `peekLivePlayerStatsAsOf`, `trnPlayerState`.
Owns locally: the 44px sticky strip (moment rules duplicated from the HUD), team grouping
and party counts by `partyId`, the four honest Tracker states, and a one-minute clock.

## Tool surfaces

| Surface | Data it reads | Local derivation |
| --- | --- | --- |
| Store — `StoreView` | `StorePanel` + IPC | filters/sort only |
| Crosshair — `CrosshairView` | local settings + IPC | 18 pieces of editor state, live preview |
| Pre-Picker — `PrepickView` | local config + IPC | 10 pieces of state, preview |
| Resolution — `UtilityView` | `displayInfo`, `gpuInfo`, `shortcut` props from App | sub-tab routing (switcher/visualizer/gpu/borderless) |
| Riot Chat — `RiotChatView` | IPC | 21 pieces of state (threads, input, presence) |
| Accounts — `AccountsView` | IPC | 12 pieces of state, per-account edit |
| Valorant Config — `ValorantConfig` | IPC + file reads | 22 pieces of state, sensitivity math |
| Settings — `Settings` | IPC + localStorage | 9 pieces of state |
| Dev Dashboard — `DevDashboard` | IPC, dev-only | 21 pieces of state |

## Shell-level contracts (do not lose these in the rebuild)

1. **Escape has exactly one owner per layer**: the match body for a ledger expansion, the
   player drawer above it. No surface may add its own `keydown`.
2. **Absent is absent**: no dash, no zero, no ellipsis for an unknown value — the twelve
   fabrication removals are the precedent.
3. **One page scroll.** No nested scroll containers; sticky elements only where named.
4. **`recon:goto-match`** must keep working across a tab switch (App keeps the id).
5. **Act selection** is a single value shared by Overview's feed and both Prep sections.
