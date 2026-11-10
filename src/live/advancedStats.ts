import type { TrackerMatchDetail } from '../types';

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

/** Round numbers are 0-based in the round timeline and 1-based in Riot's
 *  payload; `detail.kills[].round` follows the kill feed, which is 1-based. */
const sameRound = (duelRound: number, roundNum: number): boolean =>
  duelRound === roundNum || duelRound === roundNum + 1;

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
    }
    out.tradedDeaths = kills.filter(
      (k) => k.victimPuuid?.toLowerCase() === me && wasTraded(detail, me, k.round)
    ).length;
  }

  return out;
}

/** True when this player died in that round and the killer was then killed by a
 *  teammate of the victim in the same round. */
function wasTraded(detail: TrackerMatchDetail, puuid: string, roundNum: number): boolean {
  const kills = detail.kills;
  if (!Array.isArray(kills)) return false;
  const myTeam = detail.players?.find((p) => p.puuid?.toLowerCase() === puuid)?.team;
  if (!myTeam) return false;
  for (const death of kills) {
    if (death.victimPuuid?.toLowerCase() !== puuid) continue;
    if (!sameRound(death.round, roundNum)) continue;
    const killer = death.killerPuuid?.toLowerCase();
    if (!killer) continue;
    const avenged = kills.some(
      (k) =>
        k.killerPuuid?.toLowerCase() !== killer &&
        k.victimPuuid?.toLowerCase() === killer &&
        k.killerTeam === myTeam &&
        sameRound(k.round, death.round)
    );
    if (avenged) return true;
  }
  return false;
}
