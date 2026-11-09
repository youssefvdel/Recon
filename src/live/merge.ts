/* The live board's merge and fill rules — pure functions, no I/O.
 *
 * Moved verbatim out of utils/tracker.ts. These are the rules that produced
 * tonight's regressions (latched rank, two fill waves), so they live in their
 * own module where a check can drive them with plain objects: no caches, no
 * transport, no React. */

import type { LiveMatchPlayer, LiveMatchState } from '../types';

export function mergeLiveMatchStateNonRegressing(
  prev: LiveMatchState | null,
  incoming: LiveMatchState
): LiveMatchState {
  if (!prev) return incoming;
  const byPuuid = new Map<string, LiveMatchPlayer>();
  for (const p of [...prev.blueTeam, ...prev.redTeam]) byPuuid.set(p.puuid.toLowerCase(), p);
  const mergeTeam = (team: LiveMatchPlayer[]): LiveMatchPlayer[] =>
    team.map((p) => {
      const was = byPuuid.get(p.puuid.toLowerCase());
      if (!was) return p;
      return {
        ...p,
        kd: p.kd ?? was.kd,
        acs: p.acs ?? was.acs,
        hsPct: p.hsPct ?? was.hsPct,
        winPct: p.winPct ?? was.winPct,
        trnScore: p.trnScore ?? was.trnScore,
        // Sticky-true, NOT a `??` latch: the row build resolves isTrnPrivate as
        // `?? false`, so a nullish latch here can never fire — and a realm that
        // has not fetched the player yet emits that `false`, clobbering a correct
        // `true` from the realm that has. A `false` with no `kd` is a `?? false`
        // default, not a verdict, so keep the lock. Real incoming data still
        // wins: a public profile (kd present, isTrnPrivate false) un-latches.
        isTrnPrivate: was.isTrnPrivate === true && p.kd == null ? true : p.isTrnPrivate,
      };
    });
  return { ...incoming, blueTeam: mergeTeam(incoming.blueTeam), redTeam: mergeTeam(incoming.redTeam) };
}

export interface SpreadPlayer {
  puuid: string;
  name: string;
  tag: string;
  /** True for own-team players — they fire before enemies. */
  mine: boolean;
}

/** Own-team-first ordering. Pure — checked by scripts/trn-spread-check.ts. */
export function orderSpreadQueue(players: SpreadPlayer[]): SpreadPlayer[] {
  return players.slice().sort((a, b) => Number(b.mine) - Number(a.mine));
}

/** Split a budgeted fill into its two visible waves: OUR squad first, then
 *  theirs. `mine` is the flag the live roster already carries (the same one
 *  `orderSpreadQueue` sorts on) — no new source is invented. A player whose
 *  flag says own-team but lands past the wave-1 slot goes to the FRONT of
 *  wave 2, so nobody is dropped and own-team still all precedes enemies.
 *  Pure — asserted by scripts/trn-spread-check.ts. */
export const TRN_FILL_WAVE_SIZE = 5;
export function splitFillWaves(players: SpreadPlayer[]): [SpreadPlayer[], SpreadPlayer[]] {
  const own = players.filter((p) => p.mine);
  const theirs = players.filter((p) => !p.mine);
  const wave1 = own.slice(0, TRN_FILL_WAVE_SIZE);
  const wave2 = [...own.slice(TRN_FILL_WAVE_SIZE), ...theirs];
  return [wave1, wave2];
}

/** Bounded gap between the two fill waves. The fill is fire-and-forget, so
 *  there is no settle event to await; this is long enough for wave 1 to be in
 *  flight (and visible in the UI) without holding back the enemy batch. */
export const TRN_FILL_WAVE_GAP_MS = 700;

export interface MmrRow {
  tier: number;
  rr: number;
  peakTier: number;
  peakSeasonId?: string;
  actWins?: number;
  actGames?: number;
  leaderboardRank?: number;
  isRankHidden?: boolean;
}

export function mergeMmrRow(
  fresh: MmrRow | null | undefined,
  prev: MmrRow | null | undefined
): MmrRow {
  const takeNum = (f?: number, p?: number): number | undefined =>
    f != null && f > 0 ? f : p;
  return {
    tier: takeNum(fresh?.tier, prev?.tier) ?? 0,
    rr: takeNum(fresh?.rr, prev?.rr) ?? 0,
    peakTier: takeNum(fresh?.peakTier, prev?.peakTier) ?? 0,
    peakSeasonId:
      (fresh && fresh.peakTier > 0 ? fresh.peakSeasonId : undefined) ??
      prev?.peakSeasonId,
    actWins: takeNum(fresh?.actWins, prev?.actWins),
    actGames: takeNum(fresh?.actGames, prev?.actGames),
    leaderboardRank: takeNum(fresh?.leaderboardRank, prev?.leaderboardRank),
    isRankHidden:
      fresh?.isRankHidden === true || prev?.isRankHidden === true
        ? true
        : (fresh?.isRankHidden ?? prev?.isRankHidden),
  };
}
