import type { TrackerMatchDetail } from '../types';

export interface AgentStatSummary {
  agent: string;
  role?: string;
  matches: number;
  wins: number;
  losses: number;
  winPct: number;
  kd: number;
  hsPct: number;
}

/** Human label for the rank bracket the live meta is tuned to. */
export function getRankTierLabel(tier = 21): string {
  if (tier <= 11) return 'Silver & Below';
  if (tier <= 17) return 'Gold / Plat';
  if (tier <= 23) return 'Diamond / Ascendant';
  return 'Immortal+';
}

/**
 * Filter match history by the active map to compute real per-agent performance on this map
 */
export function computeMapAgentStats(
  activeMapName: string,
  detailsById: Record<string, TrackerMatchDetail>,
  mapById: Record<string, string>,
  myPuuid?: string
): AgentStatSummary[] {
  if (!activeMapName || !myPuuid) return [];
  const normMap = activeMapName.toLowerCase().replace(/[^a-z0-9]/g, '');

  const statsMap: Record<
    string,
    { name: string; matches: number; wins: number; losses: number; kills: number; deaths: number; headshots: number; totalShots: number }
  > = {};

  for (const match of Object.values(detailsById)) {
    const rawMap = (mapById[match.mapId?.toLowerCase()] || match.mapId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    // Exact match only: substring matching collides (ice ↔ icebox), and when
    // both sides miss the lookup both strings are '' — and ''.includes('')
    // is true, attributing EVERY unknown-map game to the active map.
    if (!rawMap || !normMap || rawMap !== normMap) continue;

    const me = match.players?.find((p) => p.puuid === myPuuid);
    if (!me || !me.agent) continue;

    const myTeam = me.team;
    const teamScore = match.teamScore?.[myTeam] ?? 0;
    const enemyTeam = Object.keys(match.teamScore || {}).find((t) => t !== myTeam);
    const enemyScore = enemyTeam ? match.teamScore[enemyTeam] ?? 0 : 0;
    const won = teamScore > enemyScore;
    const tied = teamScore === enemyScore;

    const aName = me.agent.trim();
    const key = aName.toLowerCase();
    if (!statsMap[key]) {
      statsMap[key] = { name: aName, matches: 0, wins: 0, losses: 0, kills: 0, deaths: 0, headshots: 0, totalShots: 0 };
    }
    statsMap[key].matches += 1;
    // Draws are neither — counting them as losses fabricates the record.
    if (!tied) {
      if (won) statsMap[key].wins += 1;
      else statsMap[key].losses += 1;
    }
    statsMap[key].kills += me.kills || 0;
    statsMap[key].deaths += me.deaths || 0;
    statsMap[key].headshots += me.headshots || 0;
    statsMap[key].totalShots += (me.headshots || 0) + (me.bodyshots || 0) + (me.legshots || 0);
  }

  return Object.entries(statsMap)
    .map(([, s]) => {
      const winPct = s.matches > 0 ? (s.wins / s.matches) * 100 : 0;
      const kd = s.deaths > 0 ? s.kills / s.deaths : s.kills;
      const hsPct = s.totalShots > 0 ? (s.headshots / s.totalShots) * 100 : 0;
      return {
        agent: s.name,
        matches: s.matches,
        wins: s.wins,
        losses: s.losses,
        winPct: Number(winPct.toFixed(1)),
        kd: Number(kd.toFixed(2)),
        hsPct: Number(hsPct.toFixed(0)),
      };
    })
    .sort((a, b) => b.matches - a.matches || b.winPct - a.winPct);
}
