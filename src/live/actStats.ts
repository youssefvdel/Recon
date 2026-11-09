/* Act-window aggregation against the local Riot client.
 *
 * Moved verbatim out of utils/tracker.ts. It lives in live/ because it is the
 * live board's data path, and it imports only sources/ — the move was blocked
 * until rank, the transport helpers and gameData were sourced, because any one
 * of them would have made this module import tracker back. */

import { aggregateActStats, type ActAggregate, type ActMatchSample } from '../utils/actStats';
import { getTrnMatchPhase } from '../utils/trn';
import {
  fetchLocalRank,
  readMatchDetailsRaw,
  readMatchHistoryPage,
  shardFor,
  mapLimit,
  normTeam,
} from '../sources/riot';
import type { LocalRankRow, LocalRiotCtx } from '../sources/riot';
import type { LivePlayerStatsEntry } from './playerStats';

/** Matches read per player per fill. The act must be COVERED COMPLETELY or we
 *  report nothing, so this is the largest act we will aggregate (see
 *  `fetchLocalActStats`). 50 covers a normal act — a 10 was starving every
 *  active player, since almost everyone is past 10 competitive games by
 *  mid-act. Riot's own history is seen capped near 95 rows, so 50 stays well
 *  inside what the endpoint will page. */
export const LOCAL_ACT_MAX_MATCHES = 50;

/** Wall-clock budget for ONE player's act aggregation. A poll must never be
 *  held hostage by a slow client, so the aggregation gives up (reports
 *  nothing) rather than overrunning this. */
export const LOCAL_ACT_BUDGET_MS = 20_000;

/** Immutable per (match, player) sample cache: match details never change, so
 *  a second fill of the same lobby costs zero requests. */
const actSampleCache = new Map<string, ActMatchSample | null>();
const ACT_SAMPLE_CACHE_MAX = 300;

/** One player's scoreboard line + the team result, from local match details. */
async function loadActSample(
  region: string,
  matchId: string,
  puuid: string
): Promise<ActMatchSample | null> {
  const key = `${matchId}:${puuid.toLowerCase()}`;
  if (actSampleCache.has(key)) return actSampleCache.get(key) ?? null;
  let out: ActMatchSample | null = null;
  try {
    // Validated reader: a failed read throws and surfaces as local-failed,
    // rather than returning null and being reported as incomplete data.
    const j = await readMatchDetailsRaw(matchId, shardFor(region));
    const scores: Record<string, number> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const t of (Array.isArray(j?.teams) ? j.teams : []) as any[]) {
      scores[normTeam(t?.teamId)] = Number(t?.roundsWon ?? 0);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const me = ((Array.isArray(j?.players) ? j.players : []) as any[]).find(
      (p) => String(p?.subject ?? '').toLowerCase() === puuid.toLowerCase()
    );
    if (me) {
      const st = me?.stats ?? {};
      const mine = normTeam(me?.teamId);
      // FFA modes have no two-sided result: unknown, never a guessed win.
      const opp = Object.keys(scores).length === 2 ? Object.keys(scores).find((k) => k !== mine) : undefined;
      const a = scores[mine] ?? 0;
      const b = opp ? scores[opp] ?? 0 : 0;
      out = {
        won: opp && a !== b ? a > b : null,
        kills: Number(st?.kills ?? 0),
        deaths: Number(st?.deaths ?? 0),
        score: Number(st?.score ?? 0),
        rounds: Number(st?.roundsPlayed ?? 0),
      };
    }
  } catch {
    out = null;
  }
  actSampleCache.set(key, out);
  if (actSampleCache.size > ACT_SAMPLE_CACHE_MAX) {
    const first = actSampleCache.keys().next().value;
    if (first !== undefined) actSampleCache.delete(first);
  }
  return out;
}

/** Act K/D, ACS and win rate for ANY puuid, computed from local Riot data.
 *
 *  The act window is exact, not guessed: /mmr/v1 tells us how many games this
 *  act holds (`NumberOfGames`), and we aggregate precisely that many newest
 *  queue-scoped matches. If any of them is unreadable the whole aggregate is
 *  refused — a partial window under an "act" label would be a wrong number,
 *  and this app does not print wrong numbers. Throws instead.
 *
 *  NOT computed here, because the payload does not carry them: headshot %,
 *  KAST, damage delta, percentiles, Tracker Score. They stay blank. */
/** Everything one act scan needs. `preloadedRank` skips a duplicate /mmr read
 *  when the caller already has the row (the lobby fill always does). */
export interface LocalActCtx extends LocalRiotCtx {
  puuid: string;
  preloadedRank?: LocalRankRow;
}

export async function fetchLocalActStats(
  ctx: LocalActCtx,
  opts?: { allowAct?: boolean }
): Promise<ActAggregate> {
  const puuid = ctx.puuid;
  const region = ctx.region;
  const queue = ctx.queue || 'competitive';
  // In-game guard, second line of defence: the fill already returns early for
  // every automatic caller, but this is the choke point, so an explicit
  // `allowAct: true` is the ONLY way past it while the game is in coregame.
  if (opts?.allowAct !== true && getTrnMatchPhase() === 'coregame') {
    throw new Error('LOCAL_ACT_IN_MATCH');
  }
  const r = ctx.preloadedRank ?? (await fetchLocalRank(puuid, region));
  const want = Number(r.actGames) || 0;
  if (want <= 0) throw new Error('LOCAL_NO_ACT_GAMES');
  if (want > LOCAL_ACT_MAX_MATCHES) throw new Error('LOCAL_ACT_TOO_LONG');
  const q = queue.toLowerCase().trim();
  const startedAt = Date.now();
  const ids: string[] = [];
  for (let page = 0; page < 5 && ids.length < want; page++) {
    if (Date.now() - startedAt > LOCAL_ACT_BUDGET_MS) throw new Error('LOCAL_ACT_TIMEOUT');
    const start = page * 20;
    // Validated reader: a Riot error payload THROWS here instead of parsing as
    // an empty page. That is the difference between "we could not read" and
    // "there is less data", and the two must not collapse into one label.
    const rows = await readMatchHistoryPage(puuid, shardFor(region), start, start + 20);
    if (rows.length === 0) break;
    for (const row of rows) if (row.id && row.queue === q) ids.push(row.id);
  }
  const picked = ids.slice(0, want);
  if (picked.length < want) throw new Error('LOCAL_ACT_INCOMPLETE');
  if (Date.now() - startedAt > LOCAL_ACT_BUDGET_MS) throw new Error('LOCAL_ACT_TIMEOUT');
  const samples = (
    await mapLimit(picked, 4, (id) => loadActSample(region, id, puuid))
  ).filter((s): s is ActMatchSample => s !== null);
  if (samples.length < want) throw new Error('LOCAL_ACT_INCOMPLETE');
  return aggregateActStats(samples);
}

/** Why an act aggregate was not produced. Pure — checked by
 *  scripts/act-aggregate-check.ts. Anything we cannot name is a local read
 *  failure, never a "private profile". */
export function actStateFor(
  msg: string
): NonNullable<LivePlayerStatsEntry['actState']> {
  if (msg.includes('LOCAL_ACT_TOO_LONG')) return 'too-long';
  if (msg.includes('LOCAL_ACT_TIMEOUT')) return 'timeout';
  if (msg.includes('LOCAL_ACT_INCOMPLETE') || msg.includes('LOCAL_NO_ACT_GAMES')) return 'incomplete';
  return 'local-failed';
}
