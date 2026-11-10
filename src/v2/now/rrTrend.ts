import type { TrackerMmrPoint } from '../../types';

/** Ranked-point movement over the recent games.
 *
 *  `games` already carries one row per competitive match with the RR it earned
 *  (`change`), so this is arithmetic over data the app has already fetched — no
 *  extra Riot call, no guessing.
 *
 *  Honesty rules, same as everywhere else in v2:
 *  - an entry with no numeric `change` is skipped, never counted as 0 — a game we
 *    cannot price is not a game that moved us by nothing;
 *  - if nothing qualifies the whole trend is `null`, and the surface renders
 *    nothing rather than "0 RR over 0 games".
 */

export interface RrEntry {
  matchId: string;
  change: number;
  when: number;
}

export interface RrTrend {
  /** Sum of the qualifying changes. */
  net: number;
  /** Games that gained points. */
  wins: number;
  /** Games that lost points. */
  losses: number;
  entries: RrEntry[];
  /** Largest single gain, or null when there is none. */
  best: number | null;
  /** Largest single loss, or null when there is none. */
  worst: number | null;
}

export function rrTrend(games: TrackerMmrPoint[] | undefined, limit = 20): RrTrend | null {
  if (!Array.isArray(games) || games.length === 0) return null;

  const priced: RrEntry[] = [];
  for (const g of games) {
    const change = Number(g?.change);
    if (g?.matchId === undefined || !Number.isFinite(change)) continue;
    priced.push({ matchId: g.matchId, change, when: Number(g.when ?? 0) });
  }
  if (priced.length === 0) return null;

  // Newest first, then trim: the strip is "recent form", not "the whole act".
  priced.sort((a, b) => b.when - a.when);
  const entries = priced.slice(0, Math.max(1, limit));

  let net = 0;
  let wins = 0;
  let losses = 0;
  let best: number | null = null;
  let worst: number | null = null;
  for (const e of entries) {
    net += e.change;
    if (e.change > 0) wins++;
    else if (e.change < 0) losses++;
    if (e.change > 0 && (best === null || e.change > best)) best = e.change;
    if (e.change < 0 && (worst === null || e.change < worst)) worst = e.change;
  }

  return { net, wins, losses, entries, best, worst };
}
