/* The live-lobby TRN fill: who to fetch, in what order, and the budget.
 *
 * Moved verbatim out of utils/tracker.ts. The spread state is private here and
 * the poll drives it through three named decisions instead of assigning it:
 * `noteLivePollAt`, `trySpendManualRefresh`, `settleDrainIfQuiesced`. Each is
 * one atomic answer — the manual-refresh path is the user's "Refresh all data"
 * button, and a check-and-increment split across two lines is how a silent
 * "refresh stopped working" happens. */

import { trnLog, trnNoteNegative, trnNegativeBlocked, trnProxyPaused, isTrnPrivateError,
         markTrnFetching, clearTrnFetching, getTrnMatchPhase, openTrnDrainJob, closeTrnDrainJob } from '../utils/trn';
import { getCachedLivePlayerStats, setCachedLivePlayerStats } from './playerStats';
import type { LivePlayerStatsEntry } from './playerStats';
import { fetchLocalRank } from '../sources/riot';
import { fetchLocalActStats, actStateFor } from './actStats';
import { warmTrnPhaseFromPresence } from '../sources/presence';
import {
  playerNeedsTrnStats,
  skipHiddenWork,
  trnSpreadBudget,
  trnFillJitterMs,
  TRN_SPREAD_STALE_MS,
  TRN_SPREAD_REFILL_MS,
} from './fillPolicy';
import { splitFillWaves, orderSpreadQueue, TRN_FILL_WAVE_GAP_MS } from './merge';
import type { SpreadPlayer } from './merge';
import type { LocalRiotCtx } from '../sources/riot';

const trnInFlightLive = new Set<string>();

let trnSpreadKey = '';
let trnSpreadLastPollAt = 0;
/** TRN fetches fired for the current match key (fill + immediate).
 *  Resets on match change — the budget is per lobby, not per session and
 *  not per phase (a fill dispatched pre-flip drains across it). */
let trnSpreadSpent = 0;
/** When this lobby's budget last refilled. A spent budget used to strand the
 *  rest of the lobby for the WHOLE match (a captcha wall or one flaky window
 *  could eat all 10 firings), leaving those players on the "still loading"
 *  dot forever. It now refills on a timer instead; the real ceiling is the
 *  Rust per-lobby request cap, which this does not touch. */
let trnSpreadRefilledAt = 0;
/** Owning generation of the open drain job for this lobby (0 = none). Only
 *  the owner settles it, so a stale settle can never kill a newer job. */
let trnDrainGen = 0;
/** Match the open job belongs to — a stale poll for another match settles nothing. */
let trnDrainMatchId = '';

/** MMR row shape shared by the live map, the previous row, and the merge below. */

/** Monotonic MMR merge: a present-but-empty fresh entry (unrevealed teammate,
 *  degraded payload, failed refetch) must NEVER erase a rank we already show
 *  — that erase/re-resolve cycle is the rank flicker (Unrated ↔ real) and it
 *  reshuffles byAcsDesc rows every poll. Real fresh values win; placeholders
 *  keep the previous row. RR is static within a lobby, and a new match
 *  rebuilds rows from a fresh result object, so cross-match staleness can't
 *  stick. Pure — checked by scripts/live-poll-check.ts. */


export async function enqueueTrnSpread(
  matchId: string,
  phase: string,
  players: SpreadPlayer[],
  isDeathmatch = false,
  ctx: LocalRiotCtx = { region: '', queue: 'competitive' }
): Promise<void> {
  if (skipHiddenWork()) return;
  const budget = trnSpreadBudget(isDeathmatch);
  // Per-LOBBY key (match, not match+phase): a fill dispatched pre-flip keeps
  // its budget and drains to completion across the phase flip.
  const key = matchId;
  const firstFill = key !== trnSpreadKey;
  if (firstFill) {
    // New match: stale firings must never fetch for the old lobby.
    trnSpreadKey = key;
    trnSpreadSpent = 0;
    trnSpreadRefilledAt = Date.now();
    // Warm the pause hint from Riot-local BEFORE dispatching (don't wait for
    // the next poll): the full poll can arrive already in coregame while
    // presences still show agent-select — that race missed whole lobbies.
    await warmTrnPhaseFromPresence().catch(() => {});
  } else if (trnSpreadRefilledAt > 0 && Date.now() - trnSpreadRefilledAt >= TRN_SPREAD_REFILL_MS) {
    // Same lobby, refill window elapsed: whoever is still statless gets
    // another budget. Bounded by the Rust per-lobby ceiling, so this cannot
    // turn into a request storm even if the lobby sits here for an hour.
    trnSpreadSpent = 0;
    trnSpreadRefilledAt = Date.now();
    if (import.meta.env.DEV) trnLog('budget refilled', `budget=${budget}`);
  }
  // Drain-vs-new split: only NEW fills gate here — nothing fresh enqueues
  // while paused. Already-dispatched firings carry drain:true below and run
  // to completion (bounded, ladder-guarded).
  if (await trnProxyPaused()) {
    if (import.meta.env.DEV) trnLog('fill paused', 'no fresh enqueue while paused (dispatched drains)');
    return;
  }
  // Own-team-first, budgeted, deduped — then ONE concurrent fill (each firing
  // de-synced 200-400ms, NOT 6s). The trn.ts serial gate + cooldown ladder
  // below still pace the wire; budget is spent only on fire.
  if (import.meta.env.DEV) trnLog('fill start', `phase=${phase} candidates=${players.length} budget=${trnSpreadSpent}/${budget}`);
  const budgeted = orderSpreadQueue(players)
    .filter(
      (p) =>
        !trnInFlightLive.has(p.puuid.toLowerCase()) &&
        playerNeedsTrnStats(p.puuid) &&
        // A proven terminal negative (404 missing / 451 private) must never
        // spend budget: that is what kept the board reading "fetching".
        !trnNegativeBlocked(p.name, p.tag)
    )
    .slice(0, Math.max(0, budget - trnSpreadSpent));
  // Atomic job: everything dispatched here — plus descendant detail calls
  // those players fan out with no explicit token — inherits drain until the
  // job settles. Opened only when actually dispatching.
  if (budgeted.length > 0) {
    trnDrainGen = openTrnDrainJob(players.map((p) => `${p.name}#${p.tag}`));
    trnDrainMatchId = matchId;
    if (import.meta.env.DEV) trnLog('job opened', `gen=${trnDrainGen} players=${players.length}`);
  }
  const fire = (p: SpreadPlayer, fireKey: string): void => {
    const { puuid, name, tag } = p;
    setTimeout(() => {
      // Match moved on, tab hidden, polls stale, already filled/fetching,
      // cooling, or budget spent → skip without firing. No paused check by
      // design: dispatch-time budgeting already decided, and drain:true
      // below exempts the run across the phase flip.
      if (fireKey !== trnSpreadKey || !playerNeedsTrnStats(puuid)) return;
      if (skipHiddenWork()) return;
      if (Date.now() - trnSpreadLastPollAt > TRN_SPREAD_STALE_MS) return;
      if (trnInFlightLive.has(puuid.toLowerCase())) return;
      if (trnSpreadSpent >= budget) return;
      import('../utils/trn')
        .then(async ({ trnCooldownRemainingMs, isTrnDeadQuiet }) => {
          // Fail fast like trnGet: touch no network during cooldown. Budget
          // unspent, so the next visible poll re-enqueues whoever is stale.
          // Same for the dead-quiet breaker: spend nothing while the page's
          // network is down; the next poll retries after it reopens.
          if (fireKey !== trnSpreadKey || trnCooldownRemainingMs() > 0 || isTrnDeadQuiet()) return;
          if (!playerNeedsTrnStats(puuid) || trnInFlightLive.has(puuid.toLowerCase())) return;
          if (trnSpreadSpent >= budget) return;
          trnSpreadSpent++;
          fetchTrnStatsNow(puuid, name, tag, { ...ctx, drain: true, fill: true });
        })
        .catch(() => {});
    }, trnFillJitterMs());
  };

  // WAVE 1 = our squad, now. WAVE 2 = theirs, once wave 1 is away. Sequential
  // by construction: the UI shows your own team filling first, and the two
  // batches never overlap.
  const [wave1, wave2] = splitFillWaves(budgeted);
  for (const p of wave1) fire(p, key);
  if (wave2.length > 0) {
    setTimeout(() => {
      for (const p of wave2) fire(p, key);
      if (import.meta.env.DEV) trnLog('fill wave 2', `scheduled=${wave2.length}`);
    }, TRN_FILL_WAVE_GAP_MS);
  }
  if (import.meta.env.DEV) {
    trnLog(
      'fill dispatched',
      `wave1=${wave1.length} wave2=${wave2.length} budget=${trnSpreadSpent}/${budget}`
    );
  }
}

/** Immediate single-player stats fetch. LOCAL Riot first (rank + act stats
 *  read through the client's own token); tracker.gg only as a last resort and
 *  only while its health is ok. The manual-refresh path calls this directly
 *  (gated); the fill passes drain:true for already-budgeted players running
 *  across the phase flip. Never throws into the poll loop. */
/** Retry-after for a 451-private profile: it stays private until its owner
 *  acts on tracker.gg, so refetching every lobby is pure rate-limit burn. */
export const TRN_PRIVATE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Retry-after for an HTTP 404 (no tracker page yet): the page may be
 *  created later, so retry daily, not every lobby. */
export const TRN_MISSING_RETRY_MS = 24 * 60 * 60 * 1000;

/** Context every local read needs; carried from the poll that already has it. */
export function fetchTrnStatsNow(
  puuid: string,
  realName: string,
  realTag: string,
  ctx: LocalRiotCtx
): void {
  const inFlightKey = puuid.toLowerCase();
  if (trnInFlightLive.has(inFlightKey)) return;
  trnInFlightLive.add(inFlightKey);
  // Same fact for the UI: trn.trnPlayerState reads this set to say "fetching".
  markTrnFetching(realName, realTag);

  // 1. LOCAL FIRST. Rank/RR always; act K/D + ACS + win% when the act is
  //    small enough to be covered completely. Every field written is one Riot
  //    literally reported — the entry shape leaves anything else blank.
  const local = (async (): Promise<Partial<LivePlayerStatsEntry>> => {
    const rank = await fetchLocalRank(puuid, ctx.region);
    const update: Partial<LivePlayerStatsEntry> = {
      fetchedAt: Date.now(),
      retryAfter: 0,
      lastFetchFailed: false,
      // A successful recompute clears any previous verdict.
      actState: null,
    };
    // IN-GAME GATE (perf #2). The act window costs up to 53 local Riot GETs
    // per player. A dispatched fill is drain-exempt, so without this it ran
    // with VALORANT in the foreground — the one time the game must own the
    // machine. During coregame we take the rank only (ONE /mmr read, already
    // paid above) and leave the act window to the next out-of-game fill; the
    // rank row still renders, and no retry gate is armed so the act data
    // lands as soon as the match ends.
    if (ctx.allowAct !== true && getTrnMatchPhase() === 'coregame') {
      if (import.meta.env.DEV) trnLog('act deferred', `in-match ${puuid.slice(0, 8)}`);
      return update;
    }
    const agg = await fetchLocalActStats(
      { ...ctx, puuid, preloadedRank: rank },
      { allowAct: ctx.allowAct === true }
    ).catch((e: unknown) => {
      update.actState = actStateFor(String(e));
      // Rank read fine, act window not. Back off so this does not re-run one
      // mmr read per poll; a too-long act cannot shrink, so it backs off far
      // harder than a transient miss.
      update.retryAfter = Date.now() + (update.actState === 'too-long' ? 60 : 5) * 60 * 1000;
      return null;
    });
    if (agg) {
      if (agg.kd != null) update.kd = agg.kd;
      if (agg.winPct != null) update.winPct = agg.winPct;
      if (agg.acs != null) update.acs = agg.acs;
    }
    return update;
  })();

  local
    .then((update) => {
      setCachedLivePlayerStats(puuid, update);
    })
    .catch(() => {
      // 2. TRN LAST RESORT. Only while the transport is healthy: a captcha
      //    wall or a spent ladder can never be fixed by retrying, and the
      //    whole point of the health gate is that this path stays cold.
      void import('../utils/trn')
        .then(({ fetchTrnActStats, trnCooldownRemainingMs, getTrnHealth }) => {
          if (getTrnHealth().health !== 'ok' || trnCooldownRemainingMs() > 0) return;
          return fetchTrnActStats(realName, realTag, '', 'competitive', {
            ...(ctx.drain ? { drain: true } : {}),
            ...(ctx.fill ? { fill: true } : {}),
          })
            .then((res) => {
              const realCountry =
                res?.countryCode &&
                res.countryCode.length === 2 &&
                !['EU', 'NA', 'AP', 'KR'].includes(res.countryCode.toUpperCase())
                  ? res.countryCode.toUpperCase()
                  : undefined;

              const update: Partial<LivePlayerStatsEntry> = {
                fetchedAt: Date.now(),
                // 0, not undefined: the merge below skips undefined/null so callers
                // can do partial updates, which made `undefined` a silent no-op and
                // let a stale backoff survive a successful fetch. 0 is this file's
                // established "no backoff" value (`cached.retryAfter ?? 0`) and is
                // falsy, so the poison self-heal ignores it.
                retryAfter: 0,
                lastFetchFailed: false,
              };
              if (realCountry) update.country = realCountry;
              if (res?.stats?.kd != null) update.kd = Number(res.stats.kd.toFixed(2));
              if (res?.stats?.winPct != null) update.winPct = Math.round(res.stats.winPct);
              if (res?.stats?.hsPct != null) update.hsPct = Math.round(res.stats.hsPct);
              if (res?.stats?.trnScore != null) update.trnScore = Math.round(res.stats.trnScore);
              if (res?.stats?.acs != null) update.acs = Math.round(res.stats.acs);
              // Public profile with real stats clears a previously latched private flag.
              if (res?.stats?.kd != null) update.isTrnPrivate = false;
              // If private or no stats found, set short backoff (5 min) so we can retry later
              if (!res || !res.stats || res.stats.kd == null) {
                update.retryAfter = Date.now() + 5 * 60 * 1000;
              }
              setCachedLivePlayerStats(puuid, update);
            })
            .catch((e) => {
              // Align retry with the live cooldown expiry (+2s) so a player
              // never sleeps through availability; floor 30s for transient errors.
              // A 451-private profile latches the flag so rows show a lock, not breakage.
              // Permanent negatives: 451 stays private until its owner acts (7d),
              // 404 may gain a page later (24h) — refetching either every lobby
              // is pure rate-limit burn, so back them off hard.
              const cool = trnCooldownRemainingMs();
              const backoff = isTrnPrivateError(e)
                ? TRN_PRIVATE_RETRY_MS
                : String(e).includes('HTTP 404')
                  ? TRN_MISSING_RETRY_MS
                  : Math.max(30 * 1000, cool + 2000);
              setCachedLivePlayerStats(puuid, {
                retryAfter: Date.now() + backoff,
                // Marks the entry as a FAILURE, not a successful empty answer — see
                // LivePlayerStatsEntry.lastFetchFailed.
                lastFetchFailed: true,
                ...(isTrnPrivateError(e)
                  ? { isTrnPrivate: true, negative: 'private' as const }
                  : String(e).includes('HTTP 404')
                    ? { negative: 'missing' as const }
                    : {}),
              });
              // Central registry (trn.ts): every fetch fn consults it first, so
              // Overview/modals/maps/tabs/enrichment can never refire a proven
              // private/missing account — not just the lobby fill.
              if (isTrnPrivateError(e)) trnNoteNegative(realName, realTag, 'private');
              else if (String(e).includes('HTTP 404')) trnNoteNegative(realName, realTag, 'missing');
            });
        })
        .catch(() => {})
        // Nothing local AND tracker.gg cold: stay blank, back off 5 minutes
        // like a statless answer, and never latch "private" on a transport
        // failure — that is the copy bug this path exists to stop causing.
        .then(() => {
          const cur = getCachedLivePlayerStats(puuid);
          if (cur && cur.kd == null && cur.acs == null) {
            setCachedLivePlayerStats(puuid, {
              retryAfter: Date.now() + 5 * 60 * 1000,
              lastFetchFailed: true,
            });
          }
        });
    })
    .finally(() => {
      trnInFlightLive.delete(inFlightKey);
      clearTrnFetching(realName, realTag);
    });
}

/* ---- the three named decisions the poll uses instead of assigning state ---- */

/** Stamp "a live poll just ran". Without a fresh stamp the fill decides the
 *  poll is dead and skips the lobby (site 9 of the write-site pass). */
export function noteLivePollAt(): void {
  trnSpreadLastPollAt = Date.now();
}

/** True when the last live poll is too old to trust. */
export function isLivePollStale(): boolean {
  return Date.now() - trnSpreadLastPollAt > TRN_SPREAD_STALE_MS;
}

/** Check-and-increment as ONE answer: true means a firing was budgeted and
 *  spent; false means the lobby is out of budget and the caller joins the fill.
 *  Two touching lines used to do this; one decision cannot drift from itself. */
export function trySpendManualRefresh(isDeathmatch: boolean): boolean {
  if (trnSpreadSpent >= trnSpreadBudget(isDeathmatch)) return false;
  trnSpreadSpent++;
  return true;
}

/** Settle the open drain job only when we own it AND it belongs to this
 *  lobby. A stale poll for another match settles nothing. */
export function settleDrainIfQuiesced(matchId: string): boolean {
  if (trnDrainGen === 0 || matchId !== trnDrainMatchId) return false;
  closeTrnDrainJob(trnDrainGen);
  trnDrainGen = 0;
  trnDrainMatchId = '';
  return true;
}

/** Test seam: pretend a drain job is open for this lobby, so a check can drive
 *  `settleDrainIfQuiesced` without the Rust call that opens a real one. */
export function __seedDrainForCheck(gen: number, matchId: string): void {
  trnDrainGen = gen;
  trnDrainMatchId = matchId;
}

/** Test seam: reset the fill's timing state so a check can drive the three
 *  accessors from a known zero. Not used by the app. */
export function __resetFillStateForCheck(): void {
  trnSpreadKey = '';
  trnSpreadLastPollAt = 0;
  trnSpreadSpent = 0;
  trnSpreadRefilledAt = 0;
  trnDrainGen = 0;
  trnDrainMatchId = '';
}
