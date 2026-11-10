import { useEffect, useMemo, useState } from 'react';
import type { TrnAgentStat, TrnMapStat } from '../../utils/trn';
import { fetchTrnAgents, fetchTrnMaps, mergeAgentStats, mergeMapStats } from '../../utils/trn';
import { useTrackerData } from '../../hooks/useTrackerData';
import { shortAct } from '../Overview';

/** Data for both Prep sections: one act selection, two fetches, and the local
 *  fallbacks derived from cached match details.
 *
 *  The fallbacks used to invent side-splits (attack/defense kills as a fixed
 *  48/52 of the total, side K/D as the overall K/D times a constant, plants and
 *  defuses as 1.8/0.5). Those are zeroed here: a value that looks derived is
 *  worse than a missing one, because the reader cannot tell. Everything that is
 *  genuinely computable — K/D, ADR, ACS, HS%, DDΔ, hours, W/L — is unchanged. */

export interface ActOption {
  value: string;
  label: string;
}

export function usePrepData() {
  const { trnAgents, trnMaps, games, detailsById, mapById, agentInfo, profile, seasonNames, seasonOrder, isLoading } =
    useTrackerData();
  const [actId, setActId] = useState('current');
  const [actAgents, setActAgents] = useState<TrnAgentStat[] | null>(null);
  const [actMaps, setActMaps] = useState<TrnMapStat[] | null>(null);
  const [actLoading, setActLoading] = useState(false);

  const actOptions = useMemo<ActOption[]>(() => {
    const base: ActOption[] = [
      { value: 'current', label: 'Current Act' },
      { value: 'all', label: 'All Acts' },
    ];
    if (!profile) return base;
    const played = new Set(profile.seasons.filter((s) => s.games > 0).map((s) => s.id.toLowerCase()));
    const order = seasonOrder.length > 0 ? seasonOrder : [...played];
    const ids = order.filter((id) => played.has(id) && id !== profile.currentSeasonId.toLowerCase());
    return [...base, ...ids.map((id) => ({ value: id, label: seasonNames[id] ?? shortAct(id) }))];
  }, [profile, seasonOrder, seasonNames]);

  /* Both sections read this one selection; the fetch below fills both. */
  useEffect(() => {
    if (actId === 'current' || !profile) {
      setActAgents(null);
      setActMaps(null);
      setActLoading(false);
      return;
    }
    let live = true;
    setActLoading(true);
    const { name, tag } = profile;
    const idsFor = (): string[] => {
      const played = new Set(profile.seasons.filter((s) => s.games > 0).map((s) => s.id.toLowerCase()));
      const order = seasonOrder.length > 0 ? seasonOrder : [...played];
      return [
        profile.currentSeasonId.toLowerCase(),
        ...order.filter((id) => id !== profile.currentSeasonId.toLowerCase() && played.has(id)),
      ].slice(0, 8);
    };

    const agentJob =
      actId === 'all'
        ? Promise.all(idsFor().map((sid) => fetchTrnAgents(name, tag, sid).catch(() => [] as TrnAgentStat[]))).then(
            mergeAgentStats
          )
        : fetchTrnAgents(name, tag, actId).catch(() => [] as TrnAgentStat[]);
    const mapJob =
      actId === 'all'
        ? Promise.all(idsFor().map((sid) => fetchTrnMaps(name, tag, sid).catch(() => [] as TrnMapStat[]))).then(
            mergeMapStats
          )
        : fetchTrnMaps(name, tag, actId).catch(() => [] as TrnMapStat[]);

    Promise.all([agentJob, mapJob]).then(([agents, maps]) => {
      if (!live) return;
      setActAgents(agents);
      setActMaps(maps);
      setActLoading(false);
    });
    return () => {
      live = false;
    };
  }, [actId, profile, seasonOrder]);

  const fallbackAgents = useMemo<TrnAgentStat[]>(() => {
    if (!profile) return [];
    const puuid = profile.puuid;
    const byAgent = new Map<
      string,
      {
        agent: string;
        won: number;
        lost: number;
        kills: number;
        deaths: number;
        assists: number;
        damage: number;
        damageTaken: number;
        rounds: number;
        score: number;
        headshots: number;
        hits: number;
        timeMs: number;
      }
    >();

    for (const g of games) {
      const detail = detailsById[g.matchId];
      const me = detail?.players.find((p) => p.puuid === puuid);
      if (!me || !me.agent || me.agent === '?') continue;

      const myTeam = me.team ?? '';
      const us = myTeam && detail ? detail.teamScore[myTeam] ?? 0 : 0;
      const them =
        myTeam && detail
          ? Math.max(
              0,
              ...Object.entries(detail.teamScore)
                .filter(([t]) => t !== myTeam)
                .map(([, n]) => n),
              0
            )
          : 0;
      const won = detail && us !== them ? us > them : g.change > 0;

      const e = byAgent.get(me.agent) ?? {
        agent: me.agent,
        won: 0,
        lost: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        damage: 0,
        damageTaken: 0,
        rounds: 0,
        score: 0,
        headshots: 0,
        hits: 0,
        timeMs: 0,
      };

      if (won) e.won++;
      else e.lost++;

      e.kills += me.kills;
      e.deaths += me.deaths;
      e.assists += me.assists;
      e.damage += me.damage;
      e.damageTaken += me.damageTaken;
      e.rounds += me.rounds;
      e.score += me.score;
      e.headshots += me.headshots;
      e.hits += me.headshots + me.bodyshots + me.legshots;
      e.timeMs += me.playtimeMs || me.rounds * 100 * 1000;

      byAgent.set(me.agent, e);
    }

    return Array.from(byAgent.entries()).map(([name, d]): TrnAgentStat => {
      const m = d.won + d.lost;
      const rds = Math.max(1, d.rounds);
      const kd = d.deaths > 0 ? d.kills / d.deaths : d.kills;

      return {
        agent: name,
        agentKey: name.toLowerCase(),
        matches: m,
        wins: d.won,
        losses: d.lost,
        winPct: m > 0 ? (d.won / m) * 100 : 0,
        kd,
        kda: d.deaths > 0 ? (d.kills + d.assists) / d.deaths : d.kills + d.assists,
        kills: d.kills,
        deaths: d.deaths,
        assists: d.assists,
        adr: d.damage / rds,
        acs: d.score / rds,
        damageDeltaPerRound: Math.round((d.damage - d.damageTaken) / rds),
        hsPct: d.hits > 0 ? (d.headshots / d.hits) * 100 : 0,
        timePlayedSeconds: Math.round(d.timeMs / 1000),
        hours: Math.round((d.timeMs / (3600 * 1000)) * 10) / 10,
        /* No KAST from a local fallback: it has no derivation here. */
        kast: 0,
        aces: 0,
        clutches: 0,
        flawless: 0,
        firstBloods: 0,
        firstDeaths: 0,
        bestKills: 0,
        /* Side splits are NOT derivable from a match detail: zeroed, not
         * approximated (they used to be 0.28/0.22/0.26/0.24 of the rounds). */
        defenseRoundsWon: 0,
        defenseRoundsLost: 0,
        defenseRoundsWinPct: 0,
        defenseKd: 0,
        defenseKills: 0,
        defenseDeaths: 0,
        defenseAssists: 0,
        defusesPerMatch: 0,
        attackRoundsWon: 0,
        attackRoundsLost: 0,
        attackRoundsWinPct: 0,
        attackKd: 0,
        attackKills: 0,
        attackDeaths: 0,
        attackAssists: 0,
        plantsPerMatch: 0,
        ability1Casts: 0,
        ability2Casts: 0,
        grenadeCasts: 0,
        ultimateCasts: 0,
        topMaps: [],
      };
    });
  }, [profile, games, detailsById]);

  const fallbackMaps = useMemo<TrnMapStat[]>(() => {
    if (!profile) return [];
    const puuid = profile.puuid;
    const byMap = new Map<
      string,
      {
        name: string;
        won: number;
        lost: number;
        kills: number;
        deaths: number;
        assists: number;
        damage: number;
        damageTaken: number;
        rounds: number;
        score: number;
        headshots: number;
        hits: number;
        timeMs: number;
        agentCounts: Map<string, { matches: number; wins: number }>;
      }
    >();

    for (const g of games) {
      const name = mapById[g.matchId] || 'Map';
      const detail = detailsById[g.matchId];
      const me = detail?.players.find((p) => p.puuid === puuid);
      const myTeam = me?.team ?? '';
      const us = myTeam && detail ? detail.teamScore[myTeam] ?? 0 : 0;
      const them =
        myTeam && detail
          ? Math.max(
              0,
              ...Object.entries(detail.teamScore)
                .filter(([t]) => t !== myTeam)
                .map(([, n]) => n),
              0
            )
          : 0;
      const won = detail && us !== them ? us > them : g.change > 0;

      const e = byMap.get(name) ?? {
        name,
        won: 0,
        lost: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        damage: 0,
        damageTaken: 0,
        rounds: 0,
        score: 0,
        headshots: 0,
        hits: 0,
        timeMs: 0,
        agentCounts: new Map<string, { matches: number; wins: number }>(),
      };

      if (won) e.won++;
      else e.lost++;

      if (me) {
        e.kills += me.kills;
        e.deaths += me.deaths;
        e.assists += me.assists;
        e.damage += me.damage;
        e.damageTaken += me.damageTaken;
        e.rounds += me.rounds;
        e.score += me.score;
        e.headshots += me.headshots;
        e.hits += me.headshots + me.bodyshots + me.legshots;
        e.timeMs += me.playtimeMs || me.rounds * 100 * 1000;

        if (me.agent && me.agent !== '?') {
          const a = e.agentCounts.get(me.agent) ?? { matches: 0, wins: 0 };
          a.matches++;
          if (won) a.wins++;
          e.agentCounts.set(me.agent, a);
        }
      }
      byMap.set(name, e);
    }

    return Array.from(byMap.entries()).map(([name, d]): TrnMapStat => {
      const played = d.won + d.lost;
      const rds = Math.max(1, d.rounds);
      const topAgents = Array.from(d.agentCounts.entries())
        .map(([agName, agStat]) => {
          const icon =
            Object.values(agentInfo).find((x) => x.name.toLowerCase() === agName.toLowerCase())?.icon ?? '';
          return {
            name: agName,
            icon,
            matches: agStat.matches,
            winPct: agStat.matches > 0 ? (agStat.wins / agStat.matches) * 100 : 0,
          };
        })
        .sort((a, b) => b.matches - a.matches)
        .slice(0, 3);

      return {
        key: name.toLowerCase(),
        name,
        imageUrl: '',
        matchesPlayed: played,
        matchesWon: d.won,
        matchesLost: d.lost,
        winPct: played > 0 ? (d.won / played) * 100 : 0,
        kd: d.deaths > 0 ? d.kills / d.deaths : d.kills,
        adr: d.damage / rds,
        acs: d.score / rds,
        damageDeltaPerRound: Math.round((d.damage - d.damageTaken) / rds),
        kills: d.kills,
        deaths: d.deaths,
        assists: d.assists,
        headshotsPct: d.hits > 0 ? (d.headshots / d.hits) * 100 : 0,
        timePlayedSeconds: Math.round(d.timeMs / 1000),
        aces: 0,
        clutches: 0,
        thrifty: 0,
        flawless: 0,
        plants: 0,
        defuses: 0,
        /* Side splits: zeroed, not invented (were 48/52 of the totals). */
        attackKills: 0,
        attackDeaths: 0,
        attackAssists: 0,
        attackRoundsWinPct: 0,
        defenseKills: 0,
        defenseDeaths: 0,
        defenseAssists: 0,
        defenseRoundsWinPct: 0,
        topAgents,
      };
    });
  }, [profile, games, detailsById, mapById, agentInfo]);

  const agents = actId === 'current' ? (trnAgents.length > 0 ? trnAgents : fallbackAgents) : actAgents ?? [];
  const maps = actId === 'current' ? (trnMaps.length > 0 ? trnMaps : fallbackMaps) : actMaps ?? [];

  return { actId, setActId, actOptions, actLoading, agents, maps, isLoading, agentInfo };
}
