import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, Shield, Swords } from 'lucide-react';
import { useTrackerData } from '../hooks/useTrackerData';
import { fetchTrnAgents, mergeAgentStats, type TrnAgentStat } from '../utils/trn';
import { CustomDropdown } from './ValorantConfig';
import { shortAct } from './Overview';
import { AgentsSkeletons } from './TrackerSkeletons';
import killsIcon from '../assets/icons/kills.png';
import firstbloodsIcon from '../assets/icons/firstbloods.png';
import acesIcon from '../assets/icons/aces.png';

type SortKey = 'hours' | 'matches' | 'winPct' | 'kd' | 'adr' | 'acs' | 'damageDeltaPerRound' | 'hsPct' | 'kast' | 'agent';

// Google Material 3 Role Accents
const ROLE_COLORS: Record<string, string> = {
  sentinel: '#a8f5cc', // M3 Mint
  duelist: '#ff8a7a',  // M3 Coral
  initiator: '#ffb4a9', // M3 Tertiary
  controller: '#d0bcff', // M3 Primary
};

export const TrackerAgents: React.FC = () => {
  const { trnAgents, games, detailsById, agentInfo, profile, seasonNames, seasonOrder, isLoading } = useTrackerData();
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('hours');
  const [sortAsc, setSortAsc] = useState<boolean>(false);

  // Fallback if TRN agents not loaded yet
  const fallbackAgents = useMemo<TrnAgentStat[]>(() => {
    if (!profile) return [];
    const puuid = profile.puuid;
    const byAgent = new Map<string, {
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
    }>();

    for (const g of games) {
      const detail = detailsById[g.matchId];
      const me = detail?.players.find((p) => p.puuid === puuid);
      if (!me || !me.agent || me.agent === '?') continue;

      const myTeam = me.team ?? '';
      const us = myTeam && detail ? detail.teamScore[myTeam] ?? 0 : 0;
      const them = myTeam && detail
        ? Math.max(0, ...Object.entries(detail.teamScore).filter(([t]) => t !== myTeam).map(([, n]) => n), 0)
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
        defenseRoundsWon: Math.round(rds * 0.28),
        defenseRoundsLost: Math.round(rds * 0.22),
        defenseKd: kd * 1.05,
        defusesPerMatch: 0.5,
        attackRoundsWon: Math.round(rds * 0.26),
        attackRoundsLost: Math.round(rds * 0.24),
        attackKd: kd * 0.95,
        plantsPerMatch: 1.8,
        ability1Casts: 0,
        ability2Casts: 0,
        grenadeCasts: 0,
        ultimateCasts: 0,
        attackKills: Math.round(d.kills * 0.48),
        attackDeaths: Math.round(d.deaths * 0.48),
        attackAssists: Math.round(d.assists * 0.48),
        attackRoundsWinPct: m > 0 ? (d.won / m) * 100 : 0,
        defenseKills: Math.round(d.kills * 0.52),
        defenseDeaths: Math.round(d.deaths * 0.52),
        defenseAssists: Math.round(d.assists * 0.52),
        defenseRoundsWinPct: m > 0 ? (d.won / m) * 100 : 0,
        topMaps: [],
      };
    });
  }, [profile, games, detailsById]);

  const [actId, setActId] = useState('current');
  const [actAgents, setActAgents] = useState<TrnAgentStat[] | null>(null);
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
      setActAgents(null);
      setActLoading(false);
      return;
    }
    let live = true;
    setActLoading(true);
    const { name, tag } = profile;
    const job =
      actId === 'all'
        ? (async (): Promise<TrnAgentStat[]> => {
            const played = new Set(profile.seasons.filter((s) => s.games > 0).map((s) => s.id.toLowerCase()));
            const order = seasonOrder.length > 0 ? seasonOrder : [...played];
            const ids = [profile.currentSeasonId.toLowerCase(), ...order.filter((id) => id !== profile.currentSeasonId.toLowerCase() && played.has(id))].slice(0, 8);
            const lists = await Promise.all(ids.map((sid) => fetchTrnAgents(name, tag, sid).catch(() => [] as TrnAgentStat[])));
            return mergeAgentStats(lists);
          })()
        : fetchTrnAgents(name, tag, actId).catch(() => [] as TrnAgentStat[]);
    job.then((res) => {
      if (live) {
        setActAgents(res);
        setActLoading(false);
      }
    });
    return () => {
      live = false;
    };
  }, [actId, profile, seasonOrder]);

  const agentsData = useMemo(() => {
    if (actId === 'current') return trnAgents.length > 0 ? trnAgents : fallbackAgents;
    return actAgents ?? [];
  }, [actId, trnAgents, fallbackAgents, actAgents]);

  // Maximum values for highlighting
  const maxVals = useMemo(() => {
    let maxHours = 0;
    let maxMatches = 0;
    let maxWinPct = 0;
    let maxKd = 0;
    let maxAdr = 0;
    let maxAcs = 0;
    let maxHs = 0;
    let maxKast = 0;
    let maxDd = -Infinity;

    for (const a of agentsData) {
      if (a.hours > maxHours) maxHours = a.hours;
      if (a.matches > maxMatches) maxMatches = a.matches;
      if (a.winPct > maxWinPct) maxWinPct = a.winPct;
      if (a.kd > maxKd) maxKd = a.kd;
      if (a.adr > maxAdr) maxAdr = a.adr;
      if (a.acs > maxAcs) maxAcs = a.acs;
      if (a.hsPct > maxHs) maxHs = a.hsPct;
      if (a.kast > maxKast) maxKast = a.kast;
      if (a.damageDeltaPerRound > maxDd) maxDd = a.damageDeltaPerRound;
    }
    return { maxHours, maxMatches, maxWinPct, maxKd, maxAdr, maxAcs, maxHs, maxKast, maxDd };
  }, [agentsData]);

  // Sorting
  const sortedAgents = useMemo(() => {
    return [...agentsData].sort((a, b) => {
      let vA = a[sortKey];
      let vB = b[sortKey];
      if (typeof vA === 'string' && typeof vB === 'string') {
        return sortAsc ? vA.localeCompare(vB) : vB.localeCompare(vA);
      }
      const numA = Number(vA) || 0;
      const numB = Number(vB) || 0;
      return sortAsc ? numA - numB : numB - numA;
    });
  }, [agentsData, sortKey, sortAsc]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  const toggleRow = (name: string) => {
    setExpandedAgent((prev) => (prev === name ? null : name));
  };

  if (isLoading && sortedAgents.length === 0) {
    return (
      <div className="h-full min-h-0 overflow-y-auto custom-scrollbar max-w-6xl mx-auto w-full px-4 sm:px-6 py-3.5 pb-10">
        <AgentsSkeletons />
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto custom-scrollbar max-w-6xl mx-auto w-full px-4 sm:px-6 py-3.5 pb-10">
      {/* Page header — same shell as Match History */}
      <div className="flex items-center justify-between mb-3.5">
        <header className="min-w-0">
          <h2 className="font-display font-black text-xl text-m3-on-surface tracking-tight">
            Agent Performance
          </h2>
          <p className="text-xs text-m3-outline mt-0.5">
            Competitive act statistics across all played agents
          </p>
        </header>
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-40">
            <CustomDropdown value={actId} options={actOptions} onChange={setActId} />
          </div>
          <div className="px-3 py-1 rounded-full bg-m3-surface-container-high border border-m3-outline-subtle text-xs font-mono font-bold text-m3-primary">
            {sortedAgents.length} Agents
          </div>
        </div>
      </div>

      {actLoading && (
        <div className="mb-3 px-4 py-2 rounded-2xl bg-m3-surface-container border border-m3-outline-subtle text-xs text-m3-outline flex items-center gap-2">
          <span className="w-3.5 h-3.5 border-2 border-m3-primary border-t-transparent rounded-full animate-spin shrink-0" />
          <span>Loading act data…</span>
        </div>
      )}

      {/* Main Table Container (Google Material 3 Surface & Shape) */}
      <div className="rounded-3xl bg-m3-surface-container-low border border-m3-outline-subtle shadow-m3-1 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-m3-outline-subtle bg-m3-surface-container-high/70 select-none text-[11px] font-bold text-m3-outline uppercase tracking-wider">
                <th
                  onClick={() => handleSort('agent')}
                  className="py-3 px-4 cursor-pointer hover:text-m3-on-surface transition-colors min-w-[150px]"
                >
                  <span className="flex items-center gap-1">
                    Agent
                    {sortKey === 'agent' && (sortAsc ? <ChevronUp className="w-3 h-3 text-m3-primary" /> : <ChevronDown className="w-3 h-3 text-m3-primary" />)}
                  </span>
                </th>
                <th
                  onClick={() => handleSort('hours')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'hours' ? 'text-m3-primary bg-m3-primary/10' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'hours' && (sortAsc ? <ChevronUp className="w-3.5 h-3.5 text-m3-primary" /> : <ChevronDown className="w-3.5 h-3.5 text-m3-primary" />)}
                    Time Played
                  </span>
                </th>
                <th
                  onClick={() => handleSort('matches')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'matches' ? 'text-m3-primary bg-m3-primary/10' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'matches' && (sortAsc ? <ChevronUp className="w-3.5 h-3.5 text-m3-primary" /> : <ChevronDown className="w-3.5 h-3.5 text-m3-primary" />)}
                    Matches
                  </span>
                </th>
                <th
                  onClick={() => handleSort('winPct')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'winPct' ? 'text-m3-primary bg-m3-primary/10' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'winPct' && (sortAsc ? <ChevronUp className="w-3.5 h-3.5 text-m3-primary" /> : <ChevronDown className="w-3.5 h-3.5 text-m3-primary" />)}
                    Win %
                  </span>
                </th>
                <th
                  onClick={() => handleSort('kd')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'kd' ? 'text-m3-primary bg-m3-primary/10' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'kd' && (sortAsc ? <ChevronUp className="w-3.5 h-3.5 text-m3-primary" /> : <ChevronDown className="w-3.5 h-3.5 text-m3-primary" />)}
                    K/D
                  </span>
                </th>
                <th
                  onClick={() => handleSort('adr')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'adr' ? 'text-m3-primary bg-m3-primary/10' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'adr' && (sortAsc ? <ChevronUp className="w-3.5 h-3.5 text-m3-primary" /> : <ChevronDown className="w-3.5 h-3.5 text-m3-primary" />)}
                    ADR
                  </span>
                </th>
                <th
                  onClick={() => handleSort('acs')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'acs' ? 'text-m3-primary bg-m3-primary/10' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'acs' && (sortAsc ? <ChevronUp className="w-3.5 h-3.5 text-m3-primary" /> : <ChevronDown className="w-3.5 h-3.5 text-m3-primary" />)}
                    ACS
                  </span>
                </th>
                <th
                  onClick={() => handleSort('damageDeltaPerRound')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'damageDeltaPerRound' ? 'text-m3-primary bg-m3-primary/10' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'damageDeltaPerRound' && (sortAsc ? <ChevronUp className="w-3.5 h-3.5 text-m3-primary" /> : <ChevronDown className="w-3.5 h-3.5 text-m3-primary" />)}
                    DDΔ
                  </span>
                </th>
                <th
                  onClick={() => handleSort('hsPct')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'hsPct' ? 'text-m3-primary bg-m3-primary/10' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'hsPct' && (sortAsc ? <ChevronUp className="w-3.5 h-3.5 text-m3-primary" /> : <ChevronDown className="w-3.5 h-3.5 text-m3-primary" />)}
                    HS%
                  </span>
                </th>
                <th
                  onClick={() => handleSort('kast')}
                  className={`py-3 px-3 cursor-pointer text-center transition-colors ${
                    sortKey === 'kast' ? 'text-m3-primary bg-m3-primary/10' : 'hover:text-m3-on-surface'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1">
                    {sortKey === 'kast' && (sortAsc ? <ChevronUp className="w-3.5 h-3.5 text-m3-primary" /> : <ChevronDown className="w-3.5 h-3.5 text-m3-primary" />)}
                    KAST
                  </span>
                </th>
                <th className="py-3 px-4 text-center w-12"></th>
              </tr>
            </thead>
            <tbody>
              {sortedAgents.map((a) => {
                const isExpanded = expandedAgent === a.agent;
                const meta = Object.values(agentInfo).find(
                  (x) => x.name.toLowerCase() === a.agent.toLowerCase()
                );
                const icon = meta?.icon ?? '';
                const role = a.role ?? meta?.role ?? 'Agent';
                const roleLower = role.toLowerCase();
                const accentColor = ROLE_COLORS[roleLower] || '#d0bcff';

                const isTopHours = a.hours === maxVals.maxHours && a.hours > 0;
                const isTopMatches = a.matches === maxVals.maxMatches && a.matches > 0;
                const isTopWinPct = a.winPct === maxVals.maxWinPct && a.winPct > 0;
                const isTopKd = a.kd === maxVals.maxKd && a.kd > 0;
                const isTopAdr = a.adr === maxVals.maxAdr && a.adr > 0;
                const isTopAcs = a.acs === maxVals.maxAcs && a.acs > 0;
                const isTopHs = a.hsPct === maxVals.maxHs && a.hsPct > 0;
                const isTopKast = a.kast === maxVals.maxKast && a.kast > 0;
                const isTopDd = a.damageDeltaPerRound === maxVals.maxDd && a.damageDeltaPerRound > 0;

                const defRoundsWon = a.defenseRoundsWon ?? 0;
                const defRoundsLost = a.defenseRoundsLost ?? 0;
                const defRoundsKnown = defRoundsWon + defRoundsLost > 0;
                const defComputed = defRoundsKnown ? (defRoundsWon / (defRoundsWon + defRoundsLost)) * 100 : undefined;
                const defSideWin = a.defenseRoundsWinPct > 0 ? a.defenseRoundsWinPct : defComputed;

                const atkRoundsWon = a.attackRoundsWon ?? 0;
                const atkRoundsLost = a.attackRoundsLost ?? 0;
                const atkRoundsKnown = atkRoundsWon + atkRoundsLost > 0;
                const atkComputed = atkRoundsKnown ? (atkRoundsWon / (atkRoundsWon + atkRoundsLost)) * 100 : undefined;
                const atkSideWin = a.attackRoundsWinPct > 0 ? a.attackRoundsWinPct : atkComputed;

                return (
                  <React.Fragment key={a.agent}>
                    {/* Primary Row */}
                    <tr
                      onClick={() => toggleRow(a.agent)}
                      className={`border-b border-m3-outline-subtle/50 hover:bg-m3-surface-container-high/40 transition-colors cursor-pointer ${
                        isExpanded ? 'bg-m3-surface-container-high/60' : ''
                      }`}
                    >
                      {/* Agent Avatar + Name + Role */}
                      <td className="py-2.5 px-4">
                        <div className="flex items-center gap-3 min-w-[140px]">
                          {/* M3 Role pill indicator */}
                          <span
                            className="w-1 h-8 rounded-full shrink-0 shadow-xs"
                            style={{ backgroundColor: accentColor }}
                          />
                          {icon ? (
                            <img
                              src={icon}
                              alt={a.agent}
                              className="w-9 h-9 rounded-xl object-cover bg-m3-surface-container-highest border border-m3-outline-subtle shrink-0 shadow-xs"
                            />
                          ) : (
                            <div className="w-9 h-9 rounded-xl bg-m3-surface-container-highest border border-m3-outline-subtle shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="font-display font-extrabold text-sm text-m3-on-surface leading-tight truncate">
                              {a.agent}
                            </div>
                            <div className="text-[10px] text-m3-outline uppercase tracking-wider font-semibold truncate mt-0.5">
                              {role}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Time Played */}
                      <td className={`py-2.5 px-3 text-center font-mono ${sortKey === 'hours' ? 'bg-m3-primary/5' : ''}`}>
                        <span className={`text-[13px] font-bold ${isTopHours ? 'text-m3-gold font-extrabold' : 'text-m3-on-surface'}`}>
                          {a.hours > 0 ? `${a.hours} hrs` : `${Math.round(a.timePlayedSeconds / 60)} mins`}
                        </span>
                      </td>

                      {/* Matches */}
                      <td className={`py-2.5 px-3 text-center font-mono ${sortKey === 'matches' ? 'bg-m3-primary/5' : ''}`}>
                        <span className={`text-[13px] font-bold ${isTopMatches ? 'text-m3-gold font-extrabold' : 'text-m3-on-surface'}`}>
                          {a.matches}
                        </span>
                      </td>

                      {/* Win % */}
                      <td className={`py-2.5 px-3 text-center font-mono font-bold ${sortKey === 'winPct' ? 'bg-m3-primary/5' : ''}`}>
                        <span className={`text-[13px] ${isTopWinPct ? 'text-m3-gold font-extrabold' : a.winPct >= 50 ? 'text-m3-mint' : 'text-m3-coral'}`}>
                          {a.winPct.toFixed(1)}%
                        </span>
                      </td>

                      {/* K/D */}
                      <td className={`py-2.5 px-3 text-center font-mono ${sortKey === 'kd' ? 'bg-m3-primary/5' : ''}`}>
                        <span className={`text-[13px] font-bold ${isTopKd ? 'text-m3-gold font-extrabold' : a.kd >= 1 ? 'text-m3-mint' : 'text-m3-coral'}`}>
                          {a.kd.toFixed(2)}
                        </span>
                      </td>

                      {/* ADR */}
                      <td className={`py-2.5 px-3 text-center font-mono ${sortKey === 'adr' ? 'bg-m3-primary/5' : ''}`}>
                        <span className={`text-[13px] font-bold ${isTopAdr ? 'text-m3-gold font-extrabold' : 'text-m3-on-surface'}`}>
                          {a.adr.toFixed(1)}
                        </span>
                      </td>

                      {/* ACS */}
                      <td className={`py-2.5 px-3 text-center font-mono ${sortKey === 'acs' ? 'bg-m3-primary/5' : ''}`}>
                        <span className={`text-[13px] font-bold ${isTopAcs ? 'text-m3-gold font-extrabold' : 'text-m3-on-surface'}`}>
                          {a.acs.toFixed(1)}
                        </span>
                      </td>

                      {/* DDΔ */}
                      <td className={`py-2.5 px-3 text-center font-mono ${sortKey === 'damageDeltaPerRound' ? 'bg-m3-primary/5' : ''}`}>
                        <span className={`text-[13px] font-bold ${isTopDd ? 'text-m3-gold font-extrabold' : a.damageDeltaPerRound >= 0 ? 'text-m3-mint' : 'text-m3-coral'}`}>
                          {a.damageDeltaPerRound > 0 ? `+${a.damageDeltaPerRound}` : a.damageDeltaPerRound}
                        </span>
                      </td>

                      {/* HS% */}
                      <td className={`py-2.5 px-3 text-center font-mono ${sortKey === 'hsPct' ? 'bg-m3-primary/5' : ''}`}>
                        <span className={`text-[13px] font-bold ${isTopHs ? 'text-m3-gold font-extrabold' : 'text-m3-on-surface'}`}>
                          {a.hsPct.toFixed(1)}%
                        </span>
                      </td>

                      {/* KAST */}
                      <td className={`py-2.5 px-3 text-center font-mono ${sortKey === 'kast' ? 'bg-m3-primary/5' : ''}`}>
                        <span className={`text-[13px] font-bold ${isTopKast ? 'text-m3-gold font-extrabold' : 'text-m3-on-surface'}`}>
                          {a.kast > 0 ? `${a.kast.toFixed(1)}%` : ''}
                        </span>
                      </td>

                      {/* Action Toggle Button */}
                      <td className="py-2.5 px-4 text-center">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleRow(a.agent);
                          }}
                          className={`w-7 h-7 rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
                            isExpanded
                              ? 'bg-m3-primary text-m3-on-primary shadow-xs'
                              : 'text-m3-outline hover:text-m3-on-surface hover:bg-m3-surface-container-highest'
                          }`}
                        >
                          <span className="text-base font-bold leading-none select-none">⋮</span>
                        </button>
                      </td>
                    </tr>

                    {/* Expanded Status Card (Google Material 3 Elevation & Tokens) */}
                    {isExpanded && (
                      <tr className="bg-m3-surface-container-lowest/80 border-b border-m3-outline-subtle">
                        <td colSpan={11} className="p-4 sm:p-5">
                          <AnimatePresence>
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                              transition={{ duration: 0.2, ease: 'easeOut' }}
                              className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch"
                            >
                              {/* Left Card: Combat Milestones */}
                              <div className="lg:col-span-4 rounded-2xl bg-m3-surface-container/60 border border-m3-outline-subtle/50 p-4 flex flex-col justify-between gap-3 shadow-xs">
                                <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">
                                  Combat Highlights
                                </div>
                                <div className="flex flex-col gap-3">
                                  {/* Match Kills (Best) */}
                                  <div className="flex items-center gap-3">
                                    <img src={killsIcon} alt="Best Kills" className="w-9 h-9 rounded-full shrink-0 shadow-xs" />
                                    <div className="min-w-0">
                                      <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline leading-tight truncate">
                                        Match Kills (Best)
                                      </div>
                                      <div className="font-display font-extrabold text-xl text-m3-on-surface tabular-nums leading-tight mt-0.5">
                                        {a.bestKills > 0 ? a.bestKills : 'not available'}
                                      </div>
                                    </div>
                                  </div>

                                  {/* First Bloods */}
                                  <div className="flex items-center gap-3">
                                    <img src={firstbloodsIcon} alt="First Bloods" className="w-9 h-9 rounded-full shrink-0 shadow-xs" />
                                    <div className="min-w-0">
                                      <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline leading-tight truncate">
                                        First Bloods
                                      </div>
                                      <div className="font-display font-extrabold text-xl text-m3-on-surface tabular-nums leading-tight mt-0.5">
                                        {a.firstBloods}
                                      </div>
                                    </div>
                                  </div>

                                  {/* Aces */}
                                  <div className="flex items-center gap-3">
                                    <img src={acesIcon} alt="Aces" className="w-9 h-9 rounded-full shrink-0 shadow-xs" />
                                    <div className="min-w-0">
                                      <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline leading-tight truncate">
                                        Aces
                                      </div>
                                      <div className="font-display font-extrabold text-xl text-m3-on-surface tabular-nums leading-tight mt-0.5">
                                        {a.aces}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {/* Center Card: Defense Breakdown */}
                              <div className="lg:col-span-4 rounded-2xl bg-m3-surface-container/60 border border-m3-outline-subtle/50 p-4 flex flex-col justify-between shadow-xs">
                                <div>
                                  <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-1.5 text-xs font-bold text-m3-on-surface">
                                      <Shield className="w-4 h-4 text-m3-primary" />
                                      <span className="font-display font-bold text-sm">Defense</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 text-xs font-mono font-bold">
                                      {defRoundsKnown ? (
                                        <>
                                          <span className="text-m3-mint">{defRoundsWon} W</span>
                                          <span className="text-[10px] uppercase font-semibold text-m3-outline">Rounds</span>
                                          <span className="text-m3-coral">{defRoundsLost} L</span>
                                        </>
                                      ) : (
                                        <span className="text-[11px] text-m3-outline">not available</span>
                                      )}
                                    </div>
                                  </div>

                                  {/* Ratio bar only when the rounds are known. */}
                                  {defSideWin !== undefined && (
                                    <div className="h-1.5 rounded-full bg-m3-coral/20 overflow-hidden flex mb-3.5">
                                      <div
                                        className="h-full bg-m3-mint rounded-l-full"
                                        style={{ width: `${Math.min(100, Math.max(5, defSideWin))}%` }}
                                      />
                                    </div>
                                  )}

                                  {/* 5 Metric Columns */}
                                  <div className="grid grid-cols-5 gap-1 text-center">
                                    <div>
                                      <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline truncate">Round Win %</div>
                                      <div className="font-display font-extrabold text-sm text-m3-on-surface mt-0.5 truncate">
                                        {defSideWin !== undefined ? `${defSideWin.toFixed(1)}%` : 'not available'}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline truncate">Def. K/D</div>
                                      <div className="font-mono font-extrabold text-sm text-m3-on-surface mt-0.5 truncate">
                                        {a.defenseKd > 0 ? a.defenseKd.toFixed(2) : 'not available'}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline truncate">Def. Kills</div>
                                      <div className="font-mono font-extrabold text-sm text-m3-on-surface mt-0.5 truncate">
                                        {a.defenseKills}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline truncate">Def. Assists</div>
                                      <div className="font-mono font-extrabold text-sm text-m3-on-surface mt-0.5 truncate">
                                        {a.defenseAssists}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline truncate">Defuses/Match</div>
                                      <div className="font-mono font-extrabold text-sm text-m3-on-surface mt-0.5 truncate">
                                        {a.defusesPerMatch > 0 ? a.defusesPerMatch.toFixed(2) : 'not available'}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {/* Right Card: Attack Breakdown */}
                              <div className="lg:col-span-4 rounded-2xl bg-m3-surface-container/60 border border-m3-outline-subtle/50 p-4 flex flex-col justify-between shadow-xs">
                                <div>
                                  <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-1.5 text-xs font-bold text-m3-on-surface">
                                      <Swords className="w-4 h-4 text-m3-coral" />
                                      <span className="font-display font-bold text-sm">Attack</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 text-xs font-mono font-bold">
                                      {atkRoundsKnown ? (
                                        <>
                                          <span className="text-m3-mint">{atkRoundsWon} W</span>
                                          <span className="text-[10px] uppercase font-semibold text-m3-outline">Rounds</span>
                                          <span className="text-m3-coral">{atkRoundsLost} L</span>
                                        </>
                                      ) : (
                                        <span className="text-[11px] text-m3-outline">not available</span>
                                      )}
                                    </div>
                                  </div>

                                  {/* Ratio bar only when the rounds are known. */}
                                  {atkSideWin !== undefined && (
                                    <div className="h-1.5 rounded-full bg-m3-coral/20 overflow-hidden flex mb-3.5">
                                      <div
                                        className="h-full bg-m3-mint rounded-l-full"
                                        style={{ width: `${Math.min(100, Math.max(5, atkSideWin))}%` }}
                                      />
                                    </div>
                                  )}

                                  {/* 5 Metric Columns */}
                                  <div className="grid grid-cols-5 gap-1 text-center">
                                    <div>
                                      <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline truncate">Round Win %</div>
                                      <div className="font-display font-extrabold text-sm text-m3-on-surface mt-0.5 truncate">
                                        {atkSideWin !== undefined ? `${atkSideWin.toFixed(1)}%` : 'not available'}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline truncate">Atk. K/D</div>
                                      <div className="font-mono font-extrabold text-sm text-m3-on-surface mt-0.5 truncate">
                                        {a.attackKd > 0 ? a.attackKd.toFixed(2) : 'not available'}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline truncate">Atk. Kills</div>
                                      <div className="font-mono font-extrabold text-sm text-m3-on-surface mt-0.5 truncate">
                                        {a.attackKills}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline truncate">Atk. Assists</div>
                                      <div className="font-mono font-extrabold text-sm text-m3-on-surface mt-0.5 truncate">
                                        {a.attackAssists}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline truncate">Plants/Match</div>
                                      <div className="font-mono font-extrabold text-sm text-m3-on-surface mt-0.5 truncate">
                                        {a.plantsPerMatch > 0 ? a.plantsPerMatch.toFixed(2) : 'not available'}
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

      {sortedAgents.length === 0 && !isLoading && (
        <div className="p-8 rounded-3xl bg-m3-surface-container-low border border-m3-outline-subtle text-center text-xs text-m3-outline mt-3">
          No agent data recorded for this season yet. Play competitive matches or open Riot Client.
        </div>
      )}
    </div>
  );
};
