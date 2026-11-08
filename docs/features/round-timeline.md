# Round Timeline — build spec

Source of truth: Riot's local `match-details/v1/matches/{id}` (already fetched by
`tracker.ts`). No Tracker Network call, no GEP, no new network surface.
Evidence: `docs/trn-re/rounds.md`, `docs/trn-re/riot-local.md`.

## 1. Data model (owner: ts-client)

Extend `src/types.ts`. Names are frozen once merged — the UI builds against them.

```ts
/** One player's line inside one round. */
export type MatchRoundPlayer = {
  puuid: string;
  kills: number;
  deaths: number;        // derived: times this player appears as a victim this round
  assists: number;       // derived: appearances in another killer's assistants[]
  headshots: number;     // damage[].headshots summed for this round
  bodyshots: number;
  legshots: number;
  damageDealt: number;   // damage[] where the player is the attacker
  damageTaken: number;   // damage[] where the player is the receiver
  economy: {
    loadoutValue: number;
    remaining: number;
    spent: number;
    weapon?: string;     // economy.weapon, resolved to a readable name if the table exists
    armor?: string;
  };
  killsDetail: {
    victimPuuid: string;
    weapon?: string;       // finishingDamage.damageItem
    roundTimeMs: number;   // roundTime
    gameTimeMs: number;    // gameTime
    assistantPuuids: string[];
  }[];
};

/** One round, complete. */
export type MatchRoundDetail = {
  roundNum: number;
  winningTeam: string;
  roundResult?: string;    // Elimination | Bomb defused | Bomb detonated | …
  ceremony?: string;
  bombPlanter?: string;    // puuid
  bombDefuser?: string;    // puuid
  plantSite?: string;      // 'A' | 'B' | 'C'
  plantRoundTimeMs?: number;
  defuseRoundTimeMs?: number;
  players: MatchRoundPlayer[];
};
```

`MatchDetail` gains `roundDetails: MatchRoundDetail[]` — **additive**, so nothing
that reads `rounds` today changes.

Parser rules:
- Build from `roundResults[]` only. If a field is absent, omit it — never invent.
- `plantSite` is derived from `plantSite` when present, else from
  `plantLocation.x/y` buckets only if a map calibration already exists. If
  neither, omit it.
- Puuid keys are normalized lowercase exactly like the rest of `tracker.ts`.
- A round with no `playerStats` still yields an entry with `players: []`.

## 2. Metrics (owner: ts-client, pure functions in `src/utils/roundTimeline.ts`)

- `roundsForPlaylist(playlistId)` → first-half length (25/19/9/7 games), halves, 27 cap, OT.
- `perRoundAverages(rounds)` → ACS, ADR, DDΔ/RND, KAST%, HS% — each must match the
  existing modal numbers for the same match, or state the difference in a comment.
- `economyTimeline(rounds, puuid)` → per-round loadout value + remaining, for the
  economy strip.
- All pure; no React, no IPC.

## 3. UI (owner: ui-audit)

Where: inside `MatchDetailModal.tsx`, as a new section below the scoreboard —
"Round by round". Collapsed by default, one click to expand (the modal is already
dense).

Required elements, in this order:
1. **Round strip**: one cell per round, ordered left→right, coloured by winning
   team, marked with plant/defuse icon when `bombPlanter`/`bombDefuser` exist,
   and the round number under each cell.
2. **Selected round panel**: when a cell is clicked, show that round's details —
   winner + win condition, plant/defuse with site and seconds, and both teams'
   kill lines (killer → victim with weapon and round clock).
3. **Player selector**: choose one of the ten players to highlight their line in
   each round; defaults to the subject player.
4. **Economy strip**: the selected player's loadout value + remaining, per round.

Rules: dark violet language, no new colours, keyboard navigable (arrow keys move
the round selection), `prefers-reduced-motion` respected, empty and partial data
render a clear "no round data" state rather than a broken strip.

## 4. Acceptance (owner: qa-verify)

1. Open a real competitive match from history → round strip shows exactly the
   number of rounds played, in order, with correct winners.
2. Click round 5 → kill lines match the same round in the Riot payload.
3. Select an enemy player → their per-round economy and kills show.
4. A match with a plant shows the plant marker on the right round and the site.
5. No new network requests beyond the existing match-details fetch (verify in the
   webview console).
6. Numbers: ACS/ADR shown in the new section agree with the existing scoreboard
   for the same match.

## 5. Out of scope

Live in-game round overlay (needs `core-game`, not captured yet), Tracker-style
kill-distance, heatmaps, and anything requiring GEP.
