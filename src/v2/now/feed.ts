/**
 * The Now surface's recent-match feed, as a pure selector.
 *
 * Zero React, zero Tauri: the component owns the JSX, this module owns the
 * derivation (sort, limit, detail lookup, team scores, result). One source of
 * truth so a second consumer cannot grow a subtly different feed.
 */
import type { TrackerMatchDetail, TrackerMmrPoint } from '../../types';

export interface NowFeedRow {
  id: string;
  map: string;
  /** `mine–theirs`, or `''` when either side is missing — never `0–0`. */
  score: string;
  /** W/L/D, or `''` when the score is unknown — a missing score is not a draw. */
  result: '' | 'W' | 'L' | 'D';
  agent: string;
}

/** Newest first. Equal `when` is broken by matchId (ascending, code-unit order)
 *  so the order is deterministic and does not depend on the input array order or
 *  on anything that changed between polls. */
function newestFirst(a: TrackerMmrPoint, b: TrackerMmrPoint): number {
  const byTime = (b.when ?? 0) - (a.when ?? 0);
  if (byTime !== 0) return byTime;
  const ai = String(a.matchId ?? '');
  const bi = String(b.matchId ?? '');
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

export function nowFeed(
  games: TrackerMmrPoint[] | null | undefined,
  mapById: Record<string, string> | null | undefined,
  detailsById: Record<string, TrackerMatchDetail> | null | undefined,
  puuid: string | null | undefined,
  limit = 5
): NowFeedRow[] {
  const me = puuid?.toLowerCase() ?? '';
  return [...(games ?? [])]
    .sort(newestFirst)
    .slice(0, Math.max(0, limit))
    .map((g) => {
      const detail = detailsById?.[g.matchId];
      const player = me ? detail?.players?.find((p) => p.puuid?.toLowerCase() === me) : undefined;
      const team = player?.team;
      const mine = team ? detail?.teamScore?.[team] : undefined;
      const theirs = team ? detail?.teamScore?.[team === 'Blue' ? 'Red' : 'Blue'] : undefined;
      const scored = typeof mine === 'number' && typeof theirs === 'number';
      return {
        id: g.matchId,
        map: mapById?.[g.matchId] ?? '',
        score: scored ? `${mine}–${theirs}` : '',
        result: scored ? (mine > theirs ? 'W' : mine < theirs ? 'L' : 'D') : '',
        agent: player?.agent ?? '',
      };
    });
}
