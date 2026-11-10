/**
 * Pure round/kill mapping for a Riot match-details payload.
 *
 * Moved out of `matchDetails.ts` / `riot.ts` by moving code only, so the
 * mapper that decides the round base (and the team labels) can be tested on a
 * real capture without Tauri. No I/O, no Tauri.
 *
 * Base note: this mapper copies `roundResults[].roundNum` verbatim. The fixture
 * and production payloads are 0-based, and every consumer must compare rounds
 * with strict equality — the old `a === b || a === b + 1` in advancedStats
 * merged adjacent rounds because of that assumption.
 */

import type { MatchRoundDetail, MatchRoundPlayer, TrackerDuel } from '../types';

export const normTeam = (t: unknown): string => {
  const s = String(t ?? '').toLowerCase();
  if (s === 'blue') return 'Blue';
  if (s === 'red') return 'Red';
  return String(t ?? '');
};

/** Parse Riot's `roundResults[]` into the frozen round-timeline model.
 *  PURE and exported: the check script drives it with synthetic payloads, and
 *  `fetchMatchDetailDirect` is its only production caller. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseRoundDetails(roundsSrc: unknown[]): MatchRoundDetail[] {
  /* Round timeline (docs/features/round-timeline.md §1).
   * Built from roundResults[] ONLY. Deaths and assists are cross-player facts,
   * so they are tallied across the whole round before each player line is
   * emitted; damage taken is the mirror of another player's damage dealt. Every
   * field that is not literally in the payload is omitted, never defaulted into
   * a fake value. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (roundsSrc as any[]).map((r, rIdx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pstats: any[] = Array.isArray(r?.playerStats) ? r.playerStats : [];
    const deaths = new Map<string, number>();
    const assists = new Map<string, number>();
    const taken = new Map<string, number>();
    for (const ps of pstats) {
      for (const k of Array.isArray(ps?.kills) ? ps.kills : []) {
        const v = String(k?.victim ?? '').toLowerCase();
        if (v) deaths.set(v, (deaths.get(v) ?? 0) + 1);
        for (const a of Array.isArray(k?.assistants) ? k.assistants : []) {
          const au = String(a ?? '').toLowerCase();
          if (au) assists.set(au, (assists.get(au) ?? 0) + 1);
        }
      }
      // damageTaken is the mirror: whoever this damage hit took it.
      for (const d of Array.isArray(ps?.damage) ? ps.damage : []) {
        const rec = String(d?.receiver ?? '').toLowerCase();
        if (rec) taken.set(rec, (taken.get(rec) ?? 0) + Number(d?.damage ?? 0));
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roundPlayers: MatchRoundPlayer[] = pstats.map((ps: any) => {
      const puuid = String(ps?.subject ?? '').toLowerCase();
      let hs = 0;
      let bs = 0;
      let ls = 0;
      let dealt = 0;
      for (const d of Array.isArray(ps?.damage) ? ps.damage : []) {
        hs += Number(d?.headshots ?? 0);
        bs += Number(d?.bodyshots ?? 0);
        ls += Number(d?.legshots ?? 0);
        dealt += Number(d?.damage ?? 0);
      }
      const eco = ps?.economy ?? {};
      const line: MatchRoundPlayer = {
        puuid,
        kills: Array.isArray(ps?.kills) ? ps.kills.length : 0,
        deaths: deaths.get(puuid) ?? 0,
        assists: assists.get(puuid) ?? 0,
        headshots: hs,
        bodyshots: bs,
        legshots: ls,
        damageDealt: dealt,
        damageTaken: taken.get(puuid) ?? 0,
        economy: {
          loadoutValue: Number(eco?.loadoutValue ?? 0),
          remaining: Number(eco?.remaining ?? 0),
          spent: Number(eco?.spent ?? 0),
          ...(eco?.weapon ? { weapon: String(eco.weapon) } : {}),
          ...(eco?.armor ? { armor: String(eco.armor) } : {}),
        },
        killsDetail: (Array.isArray(ps?.kills) ? ps.kills : []).map((k: any) => ({
          victimPuuid: String(k?.victim ?? '').toLowerCase(),
          ...(k?.finishingDamage?.damageItem
            ? { weapon: String(k.finishingDamage.damageItem) }
            : {}),
          roundTimeMs: Number(k?.roundTime ?? 0),
          gameTimeMs: Number(k?.gameTime ?? 0),
          assistantPuuids: (Array.isArray(k?.assistants) ? k.assistants : []).map((a: unknown) =>
            String(a ?? '').toLowerCase()
          ),
        })),
      };
      return line;
    });

    const detail: MatchRoundDetail = {
      // Fallback shares the kill mapper's base (0-based); a payload with no
      // roundNum must not mix 1-based details with 0-based kills.
      roundNum: Number(r?.roundNum ?? rIdx),
      winningTeam: normTeam(r?.winningTeam),
      players: roundPlayers,
    };
    if (r?.roundResult) detail.roundResult = String(r.roundResult);
    if (r?.roundCeremony) detail.ceremony = String(r.roundCeremony);
    if (r?.bombPlanter) detail.bombPlanter = String(r.bombPlanter).toLowerCase();
    if (r?.bombDefuser) detail.bombDefuser = String(r.bombDefuser).toLowerCase();
    // plantSite: only from the payload's own field. The plantLocation x/y
    // buckets need a per-map calibration table we do not have here, so an
    // absent plantSite stays absent rather than being guessed.
    if (r?.plantSite) detail.plantSite = String(r.plantSite);
    if (r?.plantRoundTime != null) detail.plantRoundTimeMs = Number(r.plantRoundTime);
    if (r?.defuseRoundTime != null) detail.defuseRoundTimeMs = Number(r.defuseRoundTime);
    return detail;
  });
}

/** Kill feed in the model's shape. `teamOf` resolves a PUUID to its team label
 *  (the caller already built its player list). */
export function mapRoundKills(
  roundsSrc: unknown[],
  teamOf: (puuid: string) => string
): TrackerDuel[] {
  const kills: TrackerDuel[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (roundsSrc as any[]).forEach((r, rIdx) => {
    const num = Number(r?.roundNum ?? rIdx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pstats: any[] = Array.isArray(r?.playerStats) ? r.playerStats : [];
    for (const ps of pstats) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kl: any[] = Array.isArray(ps?.kills) ? ps.kills : [];
      for (const k of kl) {
        const kp = String(k?.killer ?? ps?.subject ?? '');
        const vp = String(k?.victim ?? '');
        kills.push({
          round: num,
          killerPuuid: kp,
          victimPuuid: vp,
          killerTeam: teamOf(kp),
          victimTeam: teamOf(vp),
          timeInRound: Number(k?.roundTime ?? 0),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          weapon: String((k as any)?.finishingDamage?.damageItem ?? ''),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          assists: Array.isArray((k as any)?.assistants) ? (k as any).assistants.map((a: unknown) => String(a)) : [],
        });
      }
    }
  });
  return kills;
}
