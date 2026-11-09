/* When and how much the live-lobby TRN fill may fetch.
 *
 * Moved verbatim out of utils/tracker.ts. Policy only: constants, two pure
 * functions, one cache read, and the hidden-window rule. The mutable spread
 * state (which lobby, how much spent, when refilled) stays with the
 * orchestrator until `enqueueTrnSpread` moves, because a module cannot assign
 * to an imported binding. */

import { getTrnMatchPhase } from '../utils/trn';
import { getCachedLivePlayerStats } from './playerStats';

/** De-sync per firing so a concurrent lobby fill isn't lockstep (NOT 6s). */
export const TRN_FILL_JITTER_MIN_MS = 200;
export const TRN_FILL_JITTER_MAX_MS = 400;
/** Uniform 200-400ms jitter. Pure — checked by scripts/trn-spread-check.ts. */
export function trnFillJitterMs(): number {
  return TRN_FILL_JITTER_MIN_MS + Math.random() * (TRN_FILL_JITTER_MAX_MS - TRN_FILL_JITTER_MIN_MS);
}

/** Hard per-lobby budget: at most 10 players per match drain through
 *  TRN (own-team-first order means enemies drop first when spent). Bounds the
 *  worst case to 10 fetchTrnStatsNow; overflow waits for the next match
 *  or a manual refresh instead of extending the firing window mid-game. */
export const TRN_SPREAD_MAX_PLAYERS = 10;
/** Deathmatch lobbies run 12 players — same one-fill rule, roomier cap. */
export const TRN_SPREAD_MAX_PLAYERS_DM = 12;
/** Budget for this lobby: 12 in deathmatch, 10 everywhere else. Pure. */
export function trnSpreadBudget(isDeathmatch: boolean): number {
  return isDeathmatch ? TRN_SPREAD_MAX_PLAYERS_DM : TRN_SPREAD_MAX_PLAYERS;
}

/** Views poll every 2.5–3s; no live poll for this long = phase went idle
 *  or the views unmounted → skip the firing, never fetch for a dead lobby. */
export const TRN_SPREAD_STALE_MS = 10_000;

/** True when the lobby fill may fetch for this player now. Reads the
 *  same caches the poll loop reads, so enqueue and firing always agree. */
export function playerNeedsTrnStats(puuid: string): boolean {
  const cached = getCachedLivePlayerStats(puuid);
  return (
    !cached ||
    (cached.kd == null && cached.acs == null && Date.now() > (cached.retryAfter ?? 0))
  );
}

/** One refill window per lobby: long enough that a wall cannot be hammered,
 *  short enough that a 35-minute match gets several honest attempts. */
export const TRN_SPREAD_REFILL_MS = 5 * 60 * 1000;

/** A hidden window must not stop a live match's fill: mid-game the main window
 *  is minimised and the overlay is the surface showing this data. Idle work
 *  still parks when hidden - that is the case this guard was written for. */
export function skipHiddenWork(): boolean {
  if (typeof document === 'undefined' || !document.hidden) return false;
  return getTrnMatchPhase() === 'idle';
}
