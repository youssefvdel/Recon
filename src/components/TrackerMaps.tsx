import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Swords, Shield, ChevronDown, ChevronUp } from 'lucide-react';
import { useTrackerData } from '../hooks/useTrackerData';
import { fetchTrnMaps, mergeMapStats, type TrnMapStat } from '../utils/trn';
import { CustomDropdown } from './ValorantConfig';
import { shortAct } from './Overview';
import { MapsSkeletons } from './TrackerSkeletons';

type SortKey = 'winPct' | 'matchesWon' | 'matchesLost' | 'kd' | 'adr' | 'acs' | 'damageDeltaPerRound' | 'name';

const formatTime = (totalSeconds: number): string => {
  if (!totalSeconds || totalSeconds <= 0) return '0m';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

export const TrackerMaps: React.FC = () => {
  const { trnMaps, games, detailsById, mapById, agentInfo, profile, seasonNames, seasonOrder, isLoading } = useTrackerData();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('winPct');
  const [sortAsc, setSortAsc] = useState<boolean>(false);

  // Fallback: derive map stats from Riot Client matches if TRN is empty
  const fallbackMaps = useMemo<TrnMapStat[]>(() => {
    if (!profile) return [];
    const puuid = profile.puuid;
    const byMap = new Map<string, {
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
    }>();

    for (const g of games) {
      const name = mapById[g.matchId] || 'Map';
      const detail = detailsById[g.matchId];
      const me = detail?.players.find((p) => p.puuid === puuid);
      const myTeam = me?.team ?? '';
      const us = myTeam && detail ? detail.teamScore[myTeam] ?? 0 : 0;
      const them = myTeam && detail
        ? Math.max(0, ...Object.entries(detail.teamScore).filter(([t]) => t !== myTeam).map(([, n]) => n), 0)
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
        agentCounts: new Map(),
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
          const icon = Object.values(agentInfo).find((x) => x.name.toLowerCase() === agName.toLowerCase())?.icon ?? '';
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
        attackKills: Math.round(d.kills * 0.48),
        attackDeaths: Math.round(d.deaths * 0.48),
        attackAssists: Math.round(d.assists * 0.48),
        attackRoundsWinPct: played > 0 ? (d.won / played) * 100 : 0,
        defenseKills: Math.round(d.kills * 0.52),
        defenseDeaths: Math.round(d.deaths * 0.52),
        defenseAssists: Math.round(d.assists * 0.52),
        defenseRoundsWinPct: played > 0 ? (d.won / played) * 100 : 0,
        topAgents,
      };
    });
  }, [profile, games, detailsById, mapById, agentInfo]);

  const [actId, setActId] = useState('current');
  const [actMaps, setActMaps] = useState<TrnMapStat[] | null>(null);
  const [actLoading, setActLoading] = useState(false);

  const actOptions = useMemo(() => {
    const base = [
      { value: 'current', label: 'Current Act' },
      { value: 'all', label: 'All Acts' },
    ];
    if (!profile) return base;
    const played = new Set(profile.seasons.filter((s) => s.games > 0).map((s) => s.id.toLowerCase()));
    const order = seasonOrder.length > 0 ? seasonOrder : [...played];
    const ids = order.filter((id) => played.has(id) && id !== profile.currentSeasonId.toLowerCase());
    return [...base, ...ids.map((id) => ({ value: id, label: seasonNames[id] ?? shortAct(id) }))];
  }, [profile, seasonOrder, seasonNames]);

  useEffect(() => {
    if (actId === 'current' || !profile) {
      setActMaps(null);
      setActLoading(false);
      return;
    }
    let live = true;
    setActLoading(true);
    const { name, tag } = profile;
    const job =
      actId === 'all'
        ? (async (): Promise<TrnMapStat[]> => {
            const played = new Set(profile.seasons.filter((s) => s.games > 0).map((s) => s.id.toLowerCase()));
            const order = seasonOrder.length > 0 ? seasonOrder : [...played];
            const ids = [profile.currentSeasonId.toLowerCase(), ...order.filter((id) => id !== profile.currentSeasonId.toLowerCase() && played.has(id))].slice(0, 8);
            const lists = await Promise.all(ids.map((sid) => fetchTrnMaps(name, tag, sid).catch(() => [] as TrnMapStat[])));
            return mergeMapStats(lists);
          })()
        : fetchTrnMaps(name, tag, actId).catch(() => [] as TrnMapStat[]);
    job.then((res) => {
      if (live) {
        setActMaps(res);
        setActLoading(false);
      }
    });
    return () => {
      live = false;
    };
  }, [actId, profile, seasonOrder]);

  const mapsData = useMemo(() => {
    if (actId === 'current') return trnMaps.length > 0 ? trnMaps : fallbackMaps;
    return actMaps ?? [];
  }, [actId, trnMaps, fallbackMaps, actMaps]);

  // Highlights: find highest numbers in each column across maps
  const maxVals = useMemo(() => {
    let maxWinPct = 0;
    let maxWon = 0;
    let maxKd = 0;
    let maxAdr = 0;
    let maxAcs = 0;
    let maxDd = -Infinity;

    for (const m of mapsData) {
      if (m.winPct > maxWinPct) maxWinPct = m.winPct;
      if (m.matchesWon > maxWon) maxWon = m.matchesWon;
      if (m.kd > maxKd) maxKd = m.kd;
      if (m.adr > maxAdr) maxAdr = m.adr;
      if (m.acs > maxAcs) maxAcs = m.acs;
      if (m.damageDeltaPerRound > maxDd) maxDd = m.damageDeltaPerRound;
    }
    return { maxWinPct, maxWon, maxKd, maxAdr, maxAcs, maxDd };
  }, [mapsData]);

  // Sort rows
  const sortedMaps = useMemo(() => {
    return [...mapsData].sort((a, b) => {
      let vA = a[sortKey];
      let vB = b[sortKey];
      if (typeof vA === 'string' && typeof vB === 'string') {
        return sortAsc ? vA.localeCompare(vB) : vB.localeCompare(vA);
      }
      const numA = Number(vA) || 0;
      const numB = Number(vB) || 0;
      return sortAsc ? numA - numB : numB - numA;
    });
  }, [mapsData, sortKey, sortAsc]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  const toggleRow = (key: string) => {
    setExpandedKey((prev) => (prev === key ? null : key));
  };

  if (isLoading && sortedMaps.length === 0) {
    return (
      <div className="h-full min-h-0 overflow-y-auto custom-scrollbar max-w-6xl mx-auto w-full px-4 sm:px-6 py-4 pb-12">
        <MapsSkeletons />
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto custom-scrollbar max-w-6xl mx-auto w-full px-4 sm:px-6 py-4 pb-12">
      {/* Title */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display font-black text-xl text-m3-on-surface uppercase tracking-wider">
          MAPS
        </h2>
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-40">
            <CustomDropdown value={actId} options={actOptions} onChange={setActId} />
          </div>
          <span className="text-xs text-m3-outline font-mono">
            {sortedMaps.length} Maps Recorded
          </span>
        </div>
      </div>

      {actLoading && (
        <div className="mb-3 px-4 py-2 rounded-2xl bg-m3-surface-container border border-m3-outline-subtle text-xs text-m3-outline flex items-center gap-2">
          <span className="w-3.5 h-3.5 border-2 border-m3-primary border-t-transparent rounded-full animate-spin shrink-0" />
          <span>Loading act data…</span>
        </div>
      )}

      {/* Main Table Container */}
      <div className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle shadow-m3-1 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-m3-outline-subtle bg-m3-surface-container-high/50 select-none text-[11px] font-bold text-m3-outline uppercase tracking-wider">
                <th
                  onClick={() => handleSort('name')}
                  className="py-3 px-3.5 cursor-pointer hover:text-m3-on-surface transition-colors min-w-[150px]"
                >
                  <span className="flex items-center gap-1">
                    Map Name
                    {sortKey === 'name' && (sortAsc ? <ChevronUp className="w-3 h-3 text-m3-coral" /> : <ChevronDown className="w-3 h-3 text-m3-coral" />)}
                  </span>
                </th>
                <th className="py-3 px-3 text-center min-w-[130px]">Top Agents</th>
                <th
                  onClick={() => handleSort('winPct')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'winPct' ? 'text-m3-coral bg-m3-primary/5' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'winPct' && (sortAsc ? <ChevronUp className="w-3.5 h-3.5 text-m3-coral" /> : <ChevronDown className="w-3.5 h-3.5 text-m3-coral" />)}
                    Win %
                  </span>
                </th>
                <th
                  onClick={() => handleSort('matchesWon')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'matchesWon' ? 'text-m3-coral bg-m3-primary/5' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'matchesWon' && (sortAsc ? <ChevronUp className="w-3 h-3 text-m3-coral" /> : <ChevronDown className="w-3 h-3 text-m3-coral" />)}
                    Wins
                  </span>
                </th>
                <th
                  onClick={() => handleSort('matchesLost')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'matchesLost' ? 'text-m3-coral bg-m3-primary/5' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'matchesLost' && (sortAsc ? <ChevronUp className="w-3 h-3 text-m3-coral" /> : <ChevronDown className="w-3 h-3 text-m3-coral" />)}
                    Losses
                  </span>
                </th>
                <th
                  onClick={() => handleSort('kd')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'kd' ? 'text-m3-coral bg-m3-primary/5' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'kd' && (sortAsc ? <ChevronUp className="w-3 h-3 text-m3-coral" /> : <ChevronDown className="w-3 h-3 text-m3-coral" />)}
                    K/D
                  </span>
                </th>
                <th
                  onClick={() => handleSort('adr')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'adr' ? 'text-m3-coral bg-m3-primary/5' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'adr' && (sortAsc ? <ChevronUp className="w-3 h-3 text-m3-coral" /> : <ChevronDown className="w-3 h-3 text-m3-coral" />)}
                    ADR
                  </span>
                </th>
                <th
                  onClick={() => handleSort('acs')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'acs' ? 'text-m3-coral bg-m3-primary/5' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'acs' && (sortAsc ? <ChevronUp className="w-3 h-3 text-m3-coral" /> : <ChevronDown className="w-3 h-3 text-m3-coral" />)}
                    ACS
                  </span>
                </th>
                <th
                  onClick={() => handleSort('damageDeltaPerRound')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'damageDeltaPerRound' ? 'text-m3-coral bg-m3-primary/5' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'damageDeltaPerRound' && (sortAsc ? <ChevronUp className="w-3 h-3 text-m3-coral" /> : <ChevronDown className="w-3 h-3 text-m3-coral" />)}
                    DDΔ
                  </span>
                </th>
                <th className="py-3 px-3 text-center w-10"></th>
              </tr>
            </thead>
            <tbody>
              {sortedMaps.map((m) => {
                const isExpanded = expandedKey === m.key;
                const isTopWinPct = m.winPct === maxVals.maxWinPct && m.winPct > 0;
                const isTopWon = m.matchesWon === maxVals.maxWon && m.matchesWon > 0;
                const isTopKd = m.kd === maxVals.maxKd && m.kd > 0;
                const isTopAdr = m.adr === maxVals.maxAdr && m.adr > 0;
                const isTopAcs = m.acs === maxVals.maxAcs && m.acs > 0;
                const isTopDd = m.damageDeltaPerRound === maxVals.maxDd && m.damageDeltaPerRound > 0;

                // Total attack & defense rounds for progress bars
                const atkTotal = Math.max(1, m.attackKills + m.attackDeaths);
                const defTotal = Math.max(1, m.defenseKills + m.defenseDeaths);

                return (
                  <React.Fragment key={m.key}>
                    {/* Primary Row */}
                    <tr
                      onClick={() => toggleRow(m.key)}
                      className={`border-b border-m3-outline-subtle/40 hover:bg-m3-surface-container-high/40 transition-colors cursor-pointer ${
                        isExpanded ? 'bg-m3-surface-container-high/60' : ''
                      }`}
                    >
                      {/* Map Thumbnail & Name */}
                      <td className="py-2.5 px-3.5">
                        <div className="relative h-11 w-36 rounded-lg overflow-hidden flex items-center px-3 border border-m3-outline-subtle bg-m3-surface-container-highest shrink-0 shadow-xs">
                          {m.imageUrl && (
                            <img
                              src={m.imageUrl}
                              alt=""
                              className="absolute inset-0 w-full h-full object-cover object-center"
                            />
                          )}
                          <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/60 to-black/30" />
                          <span className="relative z-10 font-display font-extrabold text-sm text-white tracking-wide truncate">
                            {m.name}
                          </span>
                        </div>
                      </td>

                      {/* Top Agents */}
                      <td className="py-2.5 px-3">
                        <div className="flex items-center justify-center gap-2">
                          {m.topAgents.map((ag) => (
                            <div key={ag.name} className="flex flex-col items-center">
                              {ag.icon ? (
                                <img
                                  src={ag.icon}
                                  alt={ag.name}
                                  data-tip={ag.name}
                                  className="w-7 h-7 rounded-md object-cover bg-m3-surface-container-high border border-m3-outline-subtle"
                                />
                              ) : (
                                <div className="w-7 h-7 rounded-md bg-m3-surface-container-high border border-m3-outline-subtle" />
                              )}
                              <span className="text-[10px] font-mono text-m3-outline mt-0.5 tabular-nums">
                                {Math.round(ag.winPct)}%
                              </span>
                            </div>
                          ))}
                        </div>
                      </td>

                      {/* Win % */}
                      <td className={`py-2.5 px-3 text-center font-mono font-bold ${sortKey === 'winPct' ? 'bg-m3-primary/5' : ''}`}>
                        <span className={`text-[13px] ${isTopWinPct ? 'text-m3-gold font-extrabold' : 'text-m3-on-surface'}`}>
                          {m.winPct.toFixed(1)}%
                        </span>
                      </td>

                      {/* Wins */}
                      <td className={`py-2.5 px-3 text-center font-mono ${sortKey === 'matchesWon' ? 'bg-m3-primary/5' : ''}`}>
                        <span className={`text-[13px] font-bold ${isTopWon ? 'text-m3-gold font-extrabold' : 'text-m3-on-surface'}`}>
                          {m.matchesWon}
                        </span>
                      </td>

                      {/* Losses */}
                      <td className={`py-2.5 px-3 text-center font-mono ${sortKey === 'matchesLost' ? 'bg-m3-primary/5' : ''}`}>
                        <span className="text-[13px] font-bold text-m3-outline">
                          {m.matchesLost}
                        </span>
                      </td>

                      {/* K/D */}
                      <td className={`py-2.5 px-3 text-center font-mono ${sortKey === 'kd' ? 'bg-m3-primary/5' : ''}`}>
                        <span className={`text-[13px] font-bold ${isTopKd ? 'text-m3-gold font-extrabold' : m.kd >= 1 ? 'text-m3-mint' : 'text-m3-coral'}`}>
                          {m.kd.toFixed(2)}
                        </span>
                      </td>

                      {/* ADR */}
                      <td className={`py-2.5 px-3 text-center font-mono ${sortKey === 'adr' ? 'bg-m3-primary/5' : ''}`}>
                        <span className={`text-[13px] font-bold ${isTopAdr ? 'text-m3-gold font-extrabold' : 'text-m3-on-surface'}`}>
                          {m.adr.toFixed(1)}
                        </span>
                      </td>

                      {/* ACS */}
                      <td className={`py-2.5 px-3 text-center font-mono ${sortKey === 'acs' ? 'bg-m3-primary/5' : ''}`}>
                        <span className={`text-[13px] font-bold ${isTopAcs ? 'text-m3-gold font-extrabold' : 'text-m3-on-surface'}`}>
                          {m.acs.toFixed(1)}
                        </span>
                      </td>

                      {/* DDΔ */}
                      <td className={`py-2.5 px-3 text-center font-mono ${sortKey === 'damageDeltaPerRound' ? 'bg-m3-primary/5' : ''}`}>
                        <span className={`text-[13px] font-bold ${isTopDd ? 'text-m3-gold font-extrabold' : m.damageDeltaPerRound >= 0 ? 'text-m3-mint' : 'text-m3-coral'}`}>
                          {m.damageDeltaPerRound > 0 ? `+${m.damageDeltaPerRound}` : m.damageDeltaPerRound}
                        </span>
                      </td>

                      {/* Action Button */}
                      <td className="py-2.5 px-3 text-center">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleRow(m.key);
                          }}
                          className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
                            isExpanded
                              ? 'bg-[#ff4655] text-white shadow-xs'
                              : 'text-m3-outline hover:text-m3-on-surface hover:bg-m3-surface-container-high'
                          }`}
                        >
                          <span className="text-base font-bold leading-none select-none">⋮</span>
                        </button>
                      </td>
                    </tr>

                    {/* Detail Drawer (Expanded) */}
                    {isExpanded && (
                      <tr className="bg-m3-surface-container-low border-b border-m3-outline-subtle/60">
                        <td colSpan={10} className="p-4 sm:p-5">
                          <AnimatePresence>
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                              transition={{ duration: 0.25, ease: 'easeOut' }}
                              className="flex flex-col gap-4 overflow-hidden"
                            >
                              {/* Tier 1: 6 Primary Metric Cards */}
                              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                                <div className="rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle/50 p-3 flex flex-col justify-between shadow-xs">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">Kills</span>
                                  <span className="font-display font-extrabold text-xl text-m3-on-surface tabular-nums mt-1">{m.kills}</span>
                                </div>
                                <div className="rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle/50 p-3 flex flex-col justify-between shadow-xs">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">Deaths</span>
                                  <span className="font-display font-extrabold text-xl text-m3-on-surface tabular-nums mt-1">{m.deaths}</span>
                                </div>
                                <div className="rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle/50 p-3 flex flex-col justify-between shadow-xs">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">Assists</span>
                                  <span className="font-display font-extrabold text-xl text-m3-on-surface tabular-nums mt-1">{m.assists}</span>
                                </div>
                                <div className="rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle/50 p-3 flex flex-col justify-between shadow-xs">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">Headshot %</span>
                                  <span className="font-display font-extrabold text-xl text-m3-primary tabular-nums mt-1">{m.headshotsPct.toFixed(1)}%</span>
                                </div>
                                <div className="rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle/50 p-3 flex flex-col justify-between shadow-xs">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">Matches Played</span>
                                  <span className="font-display font-extrabold text-xl text-m3-on-surface tabular-nums mt-1">{m.matchesPlayed}</span>
                                </div>
                                <div className="rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle/50 p-3 flex flex-col justify-between shadow-xs">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">Time Played</span>
                                  <span className="font-display font-extrabold text-xl text-m3-on-surface tabular-nums mt-1">{formatTime(m.timePlayedSeconds)}</span>
                                </div>
                              </div>

                              {/* Tier 2: 6 Event & Objective Metrics */}
                              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 pt-2 border-t border-m3-outline-subtle/40">
                                <div className="flex flex-col">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">Aces</span>
                                  <span className="font-mono font-bold text-base text-m3-on-surface mt-0.5 tabular-nums">{m.aces}</span>
                                </div>
                                <div className="flex flex-col">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">Clutches</span>
                                  <span className="font-mono font-bold text-base text-m3-on-surface mt-0.5 tabular-nums">{m.clutches}</span>
                                </div>
                                <div className="flex flex-col">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">Thrifty Rounds</span>
                                  <span className="font-mono font-bold text-base text-m3-on-surface mt-0.5 tabular-nums">{m.thrifty}</span>
                                </div>
                                <div className="flex flex-col">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">Flawless Rounds</span>
                                  <span className="font-mono font-bold text-base text-m3-on-surface mt-0.5 tabular-nums">{m.flawless}</span>
                                </div>
                                <div className="flex flex-col">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">Plants</span>
                                  <span className="font-mono font-bold text-base text-m3-on-surface mt-0.5 tabular-nums">{m.plants}</span>
                                </div>
                                <div className="flex flex-col">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">Defuses</span>
                                  <span className="font-mono font-bold text-base text-m3-on-surface mt-0.5 tabular-nums">{m.defuses}</span>
                                </div>
                              </div>

                              {/* Tier 3: Attack vs Defense Split Breakdown */}
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-m3-outline-subtle/40">
                                {/* Attack Card */}
                                <div className="rounded-xl bg-m3-surface-container border border-m3-outline-subtle/60 p-4 shadow-xs">
                                  <div className="flex items-center justify-between mb-3">
                                    <div className="flex items-center gap-2">
                                      <div className="w-7 h-7 rounded-lg bg-m3-coral/15 border border-m3-coral/30 flex items-center justify-center text-m3-coral">
                                        <Swords className="w-4 h-4" />
                                      </div>
                                      <span className="font-display font-extrabold text-sm text-m3-on-surface">Attack</span>
                                    </div>
                                    <span className="font-mono font-bold text-xs text-m3-outline">
                                      Round Win % <strong className="text-m3-mint font-extrabold">{m.attackRoundsWinPct.toFixed(1)}%</strong>
                                    </span>
                                  </div>

                                  <div className="flex flex-col gap-2.5 text-xs font-mono">
                                    {/* Kills bar */}
                                    <div>
                                      <div className="flex justify-between text-[11px] mb-1">
                                        <span className="text-m3-outline">Kills</span>
                                        <span className="font-bold text-m3-mint">{m.attackKills}</span>
                                      </div>
                                      <div className="h-2 rounded-full bg-m3-surface-container-high overflow-hidden">
                                        <div
                                          className="h-full bg-m3-mint rounded-full"
                                          style={{ width: `${Math.min(100, Math.max(5, (m.attackKills / atkTotal) * 100))}%` }}
                                        />
                                      </div>
                                    </div>

                                    {/* Deaths bar */}
                                    <div>
                                      <div className="flex justify-between text-[11px] mb-1">
                                        <span className="text-m3-outline">Deaths</span>
                                        <span className="font-bold text-m3-coral">{m.attackDeaths}</span>
                                      </div>
                                      <div className="h-2 rounded-full bg-m3-surface-container-high overflow-hidden">
                                        <div
                                          className="h-full bg-m3-coral rounded-full"
                                          style={{ width: `${Math.min(100, Math.max(5, (m.attackDeaths / atkTotal) * 100))}%` }}
                                        />
                                      </div>
                                    </div>

                                    {/* Assists bar */}
                                    <div>
                                      <div className="flex justify-between text-[11px] mb-1">
                                        <span className="text-m3-outline">Assists</span>
                                        <span className="font-bold text-m3-tertiary">{m.attackAssists}</span>
                                      </div>
                                      <div className="h-2 rounded-full bg-m3-surface-container-high overflow-hidden">
                                        <div
                                          className="h-full bg-m3-tertiary rounded-full"
                                          style={{ width: `${Math.min(100, Math.max(5, (m.attackAssists / atkTotal) * 100))}%` }}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                </div>

                                {/* Defense Card */}
                                <div className="rounded-xl bg-m3-surface-container border border-m3-outline-subtle/60 p-4 shadow-xs">
                                  <div className="flex items-center justify-between mb-3">
                                    <div className="flex items-center gap-2">
                                      <div className="w-7 h-7 rounded-lg bg-m3-primary/15 border border-m3-primary/30 flex items-center justify-center text-m3-primary">
                                        <Shield className="w-4 h-4" />
                                      </div>
                                      <span className="font-display font-extrabold text-sm text-m3-on-surface">Defense</span>
                                    </div>
                                    <span className="font-mono font-bold text-xs text-m3-outline">
                                      Round Win % <strong className="text-m3-mint font-extrabold">{m.defenseRoundsWinPct.toFixed(1)}%</strong>
                                    </span>
                                  </div>

                                  <div className="flex flex-col gap-2.5 text-xs font-mono">
                                    {/* Kills bar */}
                                    <div>
                                      <div className="flex justify-between text-[11px] mb-1">
                                        <span className="text-m3-outline">Kills</span>
                                        <span className="font-bold text-m3-mint">{m.defenseKills}</span>
                                      </div>
                                      <div className="h-2 rounded-full bg-m3-surface-container-high overflow-hidden">
                                        <div
                                          className="h-full bg-m3-mint rounded-full"
                                          style={{ width: `${Math.min(100, Math.max(5, (m.defenseKills / defTotal) * 100))}%` }}
                                        />
                                      </div>
                                    </div>

                                    {/* Deaths bar */}
                                    <div>
                                      <div className="flex justify-between text-[11px] mb-1">
                                        <span className="text-m3-outline">Deaths</span>
                                        <span className="font-bold text-m3-coral">{m.defenseDeaths}</span>
                                      </div>
                                      <div className="h-2 rounded-full bg-m3-surface-container-high overflow-hidden">
                                        <div
                                          className="h-full bg-m3-coral rounded-full"
                                          style={{ width: `${Math.min(100, Math.max(5, (m.defenseDeaths / defTotal) * 100))}%` }}
                                        />
                                      </div>
                                    </div>

                                    {/* Assists bar */}
                                    <div>
                                      <div className="flex justify-between text-[11px] mb-1">
                                        <span className="text-m3-outline">Assists</span>
                                        <span className="font-bold text-m3-tertiary">{m.defenseAssists}</span>
                                      </div>
                                      <div className="h-2 rounded-full bg-m3-surface-container-high overflow-hidden">
                                        <div
                                          className="h-full bg-m3-tertiary rounded-full"
                                          style={{ width: `${Math.min(100, Math.max(5, (m.defenseAssists / defTotal) * 100))}%` }}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </motion.div>
                          </AnimatePresence>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {sortedMaps.length === 0 && !isLoading && (
        <div className="p-8 rounded-2xl bg-m3-surface-container border border-m3-outline-subtle text-center text-xs text-m3-outline mt-3">
          No map data recorded for this season yet. Play competitive matches or open Riot Client.
        </div>
      )}
    </div>
  );
};
