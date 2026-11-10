import type { TrackerDuel, TrackerMatchDetail } from '../types';

/** Post-match advanced stats, computed only from data the payload carries.
 *
 *  Every value names its derivation in one line, and every one is `undefined`
 *  when the match cannot support it — never zero, never a fallback. A match
 *  cached before `roundDetails` existed has none of these, and a match whose
 *  payload lacks kill times has no first blood. */
export interface AdvancedStats {
  /** KAST%: rounds where the player got a kill, an assist, survived, or was
   *  traded — divided by rounds played. */
  kastPct?: number;
  /** ADR: total damage dealt ÷ rounds played, from round playerStats. */
  adr?: number;
  /** First bloods: kills whose `timeInRound` is the earliest in their round. */
  firstBloods?: number;
  /** Traded deaths: deaths where the killer was killed by a teammate in the
   *  same round. */
  tradedDeaths?: number;
  /** Average loadout value per round, from each round's economy block. */
  avgLoadout?: number;
}

/** Rounds and the kill feed share one base: the round mapper copies
 *  `roundResults[].roundNum` verbatim into both `roundDetails[].roundNum` and
 *  `kills[].round`, so this comparison is exact. The old `|| roundNum + 1`
 *  merged adjacent rounds and inflated every trade count derived from it. */
const sameRound = (a: number, b: number): boolean => a === b;

/** Community KAST trade window: the avenger's kill within 5 s of the death
 *  (Riptide uses 3 s; 5 s is the THESPIKE/tracker convention). */
const TRADE_WINDOW_MS = 5000;

export function computeAdvancedStats(
  detail: TrackerMatchDetail | null | undefined,
  puuid: string
): AdvancedStats {
  const out: AdvancedStats = {};
  if (!detail || !puuid) return out;
  const me = puuid.toLowerCase();
  const roundDetails = detail.roundDetails;
  const rounds = roundDetails?.length ?? 0;

  if (rounds > 0 && roundDetails) {
    let damage = 0;
    let loadout = 0;
    let loadoutRounds = 0;
    let kastRounds = 0;
    for (const r of roundDetails) {
      const line = r.players?.find((p) => p.puuid?.toLowerCase() === me);
      if (!line) continue;
      damage += line.damageDealt ?? 0;
      if (line.economy && typeof line.economy.loadoutValue === 'number') {
        loadout += line.economy.loadoutValue;
        loadoutRounds += 1;
      }
      /* Survived, killed, or assisted in this round. */
      const gotKill = (line.kills ?? 0) > 0;
      const gotAssist = (line.assists ?? 0) > 0;
      const survived = (line.deaths ?? 0) === 0;
      const traded = wasTraded(detail, me, r.roundNum);
      if (gotKill || gotAssist || survived || traded) kastRounds += 1;
    }
    out.adr = damage / rounds;
    out.kastPct = (kastRounds / rounds) * 100;
    if (loadoutRounds > 0) out.avgLoadout = loadout / loadoutRounds;
  }

  /* Kill-feed facts need kill times; without them the counts stay absent. */
  const kills = detail.kills;
  if (Array.isArray(kills) && kills.length > 0) {
    const timed = kills.every((k) => typeof k.timeInRound === 'number');
    if (timed) {
      const firstByRound = new Map<number, number>();
      for (const k of kills) {
        const t = k.timeInRound;
        const cur = firstByRound.get(k.round);
        if (cur === undefined || t < cur) firstByRound.set(k.round, t);
      }
      out.firstBloods = kills.filter(
        (k) => k.killerPuuid?.toLowerCase() === me && k.timeInRound === firstByRound.get(k.round)
      ).length;
      /* Counted per death, not per round: a multi-death round with one traded
       * death must not count twice. Needs both times, which `timed` guarantees. */
      out.tradedDeaths = kills.filter(
        (k) => k.victimPuuid?.toLowerCase() === me && deathTraded(detail, me, k)
      ).length;
    }
  }

  return out;
}

/** True when this specific death was avenged: same round exactly, and the
 *  killer was killed by a teammate of the victim within the window. Times come
 *  from `timeInRound`; without them the trade cannot be proven, so it does not
 *  count (the caller only counts trades when the feed is timed). */
function deathTraded(detail: TrackerMatchDetail, puuid: string, death: TrackerDuel): boolean {
  const kills = detail.kills;
  if (!Array.isArray(kills)) return false;
  const myTeam = detail.players?.find((p) => p.puuid?.toLowerCase() === puuid)?.team;
  if (!myTeam) return false;
  if (death.victimPuuid?.toLowerCase() !== puuid) return false;
  const killer = death.killerPuuid?.toLowerCase();
  if (!killer || killer === puuid) return false;
  const diedAt = death.timeInRound;
  if (typeof diedAt !== 'number') return false;
  return kills.some((k) => {
    // Teammate of the victim — never the killer avenging themselves.
    if (k.killerTeam !== myTeam) return false;
    if (k.killerPuuid?.toLowerCase() === killer) return false;
    if (k.victimPuuid?.toLowerCase() !== killer) return false;
    if (!sameRound(k.round, death.round)) return false;
    if (typeof k.timeInRound !== 'number') return false;
    const delta = k.timeInRound - diedAt;
    return delta >= 0 && delta <= TRADE_WINDOW_MS;
  });
}

/** Round-level KAST: any of this player's deaths in the round was traded. */
function wasTraded(detail: TrackerMatchDetail, puuid: string, roundNum: number): boolean {
  const kills = detail.kills;
  if (!Array.isArray(kills)) return false;
  return kills.some(
    (k) =>
      k.victimPuuid?.toLowerCase() === puuid &&
      sameRound(k.round, roundNum) &&
      deathTraded(detail, puuid, k)
  );
}
