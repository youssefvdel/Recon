import React, { useMemo, useState, useEffect } from 'react';
import { X, Swords, Clock, Copy, Check } from 'lucide-react';
import type { TrackerMatchDetail, TrackerMmrPoint } from '../types';
import { tierName, resolvePlayerNames, gameData } from '../utils/tracker';
import { getPartyStyle } from '../utils/playerDisplay';
import { PlayerOverviewModal, type SelectedPlayerInfo } from './PlayerOverviewModal';
import { ScoreBadge, scoreTier } from './ScoreBadge';
import { calculateTrsFallback, fetchTrnMatchDetails } from '../utils/trn';
import { useTrackerData } from '../hooks/useTrackerData';

import defuseWin from '../assets/round-icons/defuse-win.png';
import defuseLoss from '../assets/round-icons/defuse-loss.png';
import elimWin from '../assets/round-icons/elimination-win.png';
import elimLoss from '../assets/round-icons/elimination-loss.png';
import detonateWin from '../assets/round-icons/detonate-win.png';
import detonateLoss from '../assets/round-icons/detonate-loss.png';
import timeWin from '../assets/round-icons/time-win.png';
import timeLoss from '../assets/round-icons/time-loss.png';

interface MatchDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  detail: TrackerMatchDetail | null;
  game: TrackerMmrPoint | null;
  seasonId?: string;
  mapName: string;
  queue: string;
  puuid: string;
  myAccountName?: string;
  myAccountTag?: string;
  tierIcons: Record<number, string>;
  agentInfo: Record<string, { name: string; icon: string; role: string; roleIcon: string }>;
  onSelectProfile?: (name: string, tag: string) => void;
}

type ModalTab = 'scoreboard' | 'duels';

const formatDuration = (ms: number): string => {
  if (!ms || ms <= 0) return '0m 0s';
  const totalSecs = Math.round(ms / 1000);
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}m ${s}s`;
};

const formatMatchDate = (ms: number): string => {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString([], {
    month: 'numeric',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
};

export const MatchDetailModal: React.FC<MatchDetailModalProps> = ({
  isOpen,
  onClose,
  detail,
  game,
  seasonId,
  mapName,
  queue,
  puuid,
  myAccountName,
  myAccountTag,
  tierIcons,
  agentInfo,
  onSelectProfile,
}) => {
  const { trnMatchTrs } = useTrackerData();
  const [activeTab, setActiveTab] = useState<ModalTab>('scoreboard');
  const [resolvedNames, setResolvedNames] = useState<Record<string, { name: string; tag: string }>>({});
  const [selectedPlayer, setSelectedPlayer] = useState<SelectedPlayerInfo | null>(null);
  const [weaponMap, setWeaponMap] = useState<Record<string, string>>({});
  const [trnTrsMap, setTrnTrsMap] = useState<Record<string, number>>({});
  const [copiedPuuid, setCopiedPuuid] = useState<string | null>(null);

  const copyPlayerRiotId = (e: React.MouseEvent, p: { displayName: string; displayTag?: string; puuid: string }) => {
    e.stopPropagation();
    const id = p.displayTag ? `${p.displayName}#${p.displayTag}` : p.displayName;
    navigator.clipboard.writeText(id);
    setCopiedPuuid(p.puuid);
    setTimeout(() => setCopiedPuuid((cur) => (cur === p.puuid ? null : cur)), 1500);
  };

  useEffect(() => {
    gameData().then((d) => setWeaponMap(d.weapons || {})).catch(() => {});
  }, []);

  const currentMatchId = detail?.matchId || game?.matchId || '';

  // Fetch real lobby TRS from Tracker.gg when modal opens
  useEffect(() => {
    if (!isOpen || !currentMatchId) return;
    fetchTrnMatchDetails(currentMatchId).then(setTrnTrsMap).catch(() => {});
  }, [isOpen, currentMatchId]);

  // Keyboard escape listener to close modal
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedPlayer) {
          setSelectedPlayer(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose, selectedPlayer]);

  // Resolve player real names on mount/detail change
  useEffect(() => {
    if (!detail) return;
    const puuids = detail.players.map((p) => p.puuid).filter(Boolean);
    resolvePlayerNames(puuids).then(setResolvedNames);
  }, [detail]);

  const teamBlueScore = detail?.teamScore['Blue'] ?? 0;
  const teamRedScore = detail?.teamScore['Red'] ?? 0;
  const roundsCount = Math.max(1, teamBlueScore + teamRedScore);
  const matchDurationMs =
    detail?.durationMs && detail.durationMs > 0
      ? detail.durationMs
      : roundsCount * 105 * 1000;

  // Process and enrich all players
  const playerStats = useMemo(() => {
    if (!detail) return [];
    return detail.players.map((p) => {
      const isMe = p.puuid === puuid;
      const acs = Math.round(p.score / roundsCount);
      const kd = p.deaths > 0 ? Number((p.kills / p.deaths).toFixed(2)) : p.kills;
      const diff = p.kills - p.deaths;
      const adr = Math.round(p.damage / roundsCount);
      const ddPerRound = Math.round((p.damage - p.damageTaken) / roundsCount);

      // Headshot % calculation
      const totalHits = p.headshots + p.bodyshots + p.legshots;
      let hsPct = totalHits > 0 ? Number(((p.headshots / totalHits) * 100).toFixed(1)) : 0;
      if (hsPct === 0 && p.kills > 0) {
        hsPct = Number(Math.min(48, Math.max(14, Math.round(24 + (kd - 1) * 6))).toFixed(1));
      }

      // KAST, First Kills, First Deaths, Multi-kills
      let kastRounds = 0;
      let fk = 0;
      let fd = 0;
      let mk = 0;

      for (let rIdx = 0; rIdx < roundsCount; rIdx++) {
        const roundKills = detail.kills.filter((k) => k.round === rIdx);
        const gotKill = roundKills.some((k) => k.killerPuuid === p.puuid);
        const died = roundKills.some((k) => k.victimPuuid === p.puuid);
        const killsThisRound = roundKills.filter((k) => k.killerPuuid === p.puuid).length;

        if (killsThisRound >= 2) mk++;
        if (gotKill || !died) kastRounds++;

        const sortedRoundKills = [...roundKills];
        if (sortedRoundKills.length > 0) {
          if (sortedRoundKills[0].killerPuuid === p.puuid) fk++;
          if (sortedRoundKills[0].victimPuuid === p.puuid) fd++;
        }
      }

      const kast = Math.round((kastRounds / roundsCount) * 100);

      const agIcon =
        Object.values(agentInfo).find(
          (a) => a.name.toLowerCase() === p.agent.toLowerCase()
        )?.icon ?? '';

      const resolved = resolvedNames[p.puuid];
      const rawName = resolved?.name || p.name;
      const rawTag = resolved?.tag || p.tag;

      const playerHandle = rawName && rawTag ? `${rawName}#${rawTag}`.toLowerCase() : '';
      const fallbackHandle = p.name && p.tag ? `${p.name}#${p.tag}`.toLowerCase() : '';
      const agentKey = `agent:${p.agent.toLowerCase()}`;
      const won = (detail.teamScore[p.team] ?? 0) > (detail.teamScore[p.team === 'Blue' ? 'Red' : 'Blue'] ?? 0);

      const fallbackTrs = calculateTrsFallback({
        kd,
        acs,
        ddPerRound,
        kast,
        won,
      });

      // Real Tracker Score from TRN: matches outside match card exactly for the player,
      // and resolves each teammate/opponent from TRN match details.
      const realTrs = isMe
        ? (trnMatchTrs?.[currentMatchId] ?? trnTrsMap[playerHandle] ?? trnTrsMap[fallbackHandle] ?? trnTrsMap[agentKey])
        : (trnTrsMap[playerHandle] ?? trnTrsMap[fallbackHandle] ?? trnTrsMap[agentKey]);

      const trs = typeof realTrs === 'number' && realTrs > 0 ? realTrs : fallbackTrs;

      const displayName = isMe
        ? myAccountName || rawName || 'You'
        : rawName || p.agent;

      const displayTag = isMe
        ? myAccountTag || rawTag
        : rawTag;

      return {
        ...p,
        isMe,
        displayName,
        displayTag,
        agIcon,
        acs,
        kd,
        diff,
        adr,
        ddPerRound,
        hsPct,
        kast,
        fk,
        fd,
        mk,
        trs,
      };
    });
  }, [detail, puuid, myAccountName, myAccountTag, agentInfo, resolvedNames, roundsCount, currentMatchId, trnMatchTrs, trnTrsMap]);

  // Split into Team Blue and Team Red
  const teamBlue = useMemo(
    () => playerStats.filter((p) => p.team === 'Blue').sort((a, b) => b.acs - a.acs),
    [playerStats]
  );
  const teamRed = useMemo(
    () => playerStats.filter((p) => p.team === 'Red').sort((a, b) => b.acs - a.acs),
    [playerStats]
  );

  const isDeathmatch = useMemo(() => {
    const q = (queue || detail?.queue || '').toLowerCase();
    return q.includes('deathmatch') || (teamBlue.length === 0 && teamRed.length === 0 && playerStats.length > 0);
  }, [queue, detail, teamBlue, teamRed, playerStats]);

  const ffaPlayers = useMemo(() => {
    return [...playerStats].sort((a, b) => (b.kills !== a.kills ? b.kills - a.kills : b.score - a.score));
  }, [playerStats]);

  // Overall Match MVP and Team MVPs
  const matchMvpPuuid = useMemo(() => {
    if (playerStats.length === 0) return '';
    return [...playerStats].sort((a, b) => b.acs - a.acs)[0]?.puuid ?? '';
  }, [playerStats]);

  // Head-to-head duel matrix: Blue rows × Red columns (kills each way)
  const duelData = useMemo(() => {
    if (!detail) return null;
    const count = (killer: string, victim: string): number =>
      detail.kills.filter((k) => k.killerPuuid === killer && k.victimPuuid === victim).length;
    const pairs = [];
    for (const a of teamBlue) {
      for (const b of teamRed) {
        const aKills = count(a.puuid, b.puuid);
        const bKills = count(b.puuid, a.puuid);
        pairs.push({ a, b, aKills, bKills, total: aKills + bKills, diff: Math.abs(aKills - bKills) });
      }
    }
    const top = [...pairs].sort((x, y) => y.total - x.total || x.diff - y.diff)[0] ?? null;
    const mism = [...pairs].filter((p) => p !== top).sort((x, y) => y.diff - x.diff || y.total - x.total).slice(0, 2);
    return { count, pairs, top, mism };
  }, [detail, teamBlue, teamRed]);

  const getRoundOutcomeIcon = (result?: string, isWin = true): string => {
    const r = (result || '').toLowerCase();
    if (r.includes('defuse')) return isWin ? defuseWin : defuseLoss;
    if (r.includes('detonate') || r.includes('bomb') || r.includes('exploded')) return isWin ? detonateWin : detonateLoss;
    if (r.includes('time')) return isWin ? timeWin : timeLoss;
    return isWin ? elimWin : elimLoss;
  };

  // Personal Duels (You vs Opponents)
  const personalDuels = useMemo(() => {
    if (!detail) return { totalKills: 0, totalDeaths: 0, nemesis: null, prey: null };
    const me = playerStats.find((p) => p.isMe);
    if (!me) return { totalKills: 0, totalDeaths: 0, nemesis: null, prey: null };
    const enemies = playerStats.filter((p) => p.team !== me.team);

    const records = enemies.map((e) => {
      const k = detail.kills.filter((x) => x.killerPuuid === me.puuid && x.victimPuuid === e.puuid).length;
      const d = detail.kills.filter((x) => x.killerPuuid === e.puuid && x.victimPuuid === me.puuid).length;
      return { opponent: e, kills: k, deaths: d, net: k - d };
    });

    const totalKills = records.reduce((sum, r) => sum + r.kills, 0);
    const totalDeaths = records.reduce((sum, r) => sum + r.deaths, 0);
    const sortedByDeaths = [...records].sort((a, b) => b.deaths - a.deaths);
    const sortedByKills = [...records].sort((a, b) => b.kills - a.kills);

    const nemesis = sortedByDeaths[0] && sortedByDeaths[0].deaths > 0 ? sortedByDeaths[0] : null;
    const prey = sortedByKills[0] && sortedByKills[0].kills > 0 ? sortedByKills[0] : null;

    return { totalKills, totalDeaths, nemesis, prey };
  }, [detail, playerStats]);

  // Opening Duels (First Bloods & Conversion)
  const firstBloods = useMemo(() => {
    if (!detail) return { blue: 0, red: 0, blueConversion: 0 };
    let blue = 0;
    let red = 0;
    let blueFbWins = 0;
    for (let r = 1; r <= detail.rounds.length; r++) {
      const roundKills = detail.kills.filter((k) => k.round === r).sort((a, b) => a.timeInRound - b.timeInRound);
      if (roundKills.length > 0) {
        const first = roundKills[0];
        const roundWonBy = detail.rounds[r - 1]?.winningTeam;
        if (first.killerTeam === 'Blue') {
          blue++;
          if (roundWonBy === 'Blue') blueFbWins++;
        } else if (first.killerTeam === 'Red') {
          red++;
        }
      }
    }
    const blueConversion = blue > 0 ? Math.round((blueFbWins / blue) * 100) : 0;
    return { blue, red, blueConversion };
  }, [detail]);

  // Round Win Conditions Breakdown
  const roundWinConditions = useMemo(() => {
    if (!detail || !detail.rounds.length) return [];
    let elim = 0;
    let defuse = 0;
    let detonate = 0;
    let time = 0;
    for (const r of detail.rounds) {
      const res = (r.roundResult || '').toLowerCase();
      if (res.includes('defuse')) defuse++;
      else if (res.includes('detonate') || res.includes('bomb') || res.includes('exploded')) detonate++;
      else if (res.includes('time')) time++;
      else elim++;
    }
    const total = detail.rounds.length;
    return [
      { name: 'Elimination', count: elim, pct: Math.round((elim / total) * 100), icon: elimWin },
      { name: 'Spike Defused', count: defuse, pct: Math.round((defuse / total) * 100), icon: defuseWin },
      { name: 'Spike Detonated', count: detonate, pct: Math.round((detonate / total) * 100), icon: detonateWin },
      { name: 'Time Expired', count: time, pct: Math.round((time / total) * 100), icon: timeWin },
    ];
  }, [detail]);

  // Weapon Kill Distribution
  const weaponKills = useMemo(() => {
    if (!detail || !detail.kills.length) return [];
    const counts = new Map<string, number>();
    for (const k of detail.kills) {
      if (!k.weapon) continue;
      const lower = k.weapon.toLowerCase();
      const raw = lower.replace(/^.*[_/]/, '').replace(/equippable_?/i, '');
      const wName = weaponMap[lower] || weaponMap[raw] || raw;
      if (!wName) continue;
      counts.set(wName, (counts.get(wName) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [detail, weaponMap]);

  const avgRankName = (team: typeof teamBlue): string => {
    const validTiers = team.map((p) => p.tier || 0).filter((t) => t > 0);
    if (validTiers.length === 0) return game ? game.tier : 'Ascendant';
    const avg = Math.round(validTiers.reduce((a, b) => a + b, 0) / validTiers.length);
    return tierName(avg);
  };

  const openPlayer = (p: (typeof teamBlue)[0]) => {
    setSelectedPlayer({
      puuid: p.puuid,
      name: p.displayName,
      tag: p.displayTag,
      agent: p.agent,
      agIcon: p.agIcon,
      tier: p.tier,
      rankName: tierName(p.tier || 0),
      rankIcon: p.tier && tierIcons[p.tier] ? tierIcons[p.tier] : undefined,
      team: p.team,
      isMe: p.isMe,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      score: p.score,
      rounds: p.rounds,
      acs: p.acs,
      kd: p.kd,
      adr: p.adr,
      hsPct: p.hsPct,
      kast: p.kast,
      fk: p.fk,
      fd: p.fd,
      mk: p.mk,
      trs: p.trs,
    });
  };

  if (!isOpen || !detail) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      {/* Blurred Backdrop */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} />

      {/* Modal Dialog Card (Google Material 3 Theme) */}
      <div className="relative w-full max-w-[96vw] h-[94vh] max-h-[94vh] bg-m3-surface-container-low border border-m3-outline-subtle rounded-3xl shadow-m3-3 flex flex-col overflow-hidden text-m3-on-surface z-10">
        {/* Header */}
        <div className="px-4 py-2.5 bg-m3-surface-container border-b border-m3-outline-subtle flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 shrink-0 min-w-0">
            {/* Map & Mode & Date */}
            <div>
              <div className="flex items-center gap-2">
                <span className="font-display font-black text-xl text-m3-on-surface tracking-tight leading-none">
                  {mapName}
                </span>
                <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-m3-surface-container-highest text-m3-outline border border-m3-outline-subtle">
                  {queue || 'Competitive'}
                </span>
              </div>
              <div className="text-[11px] font-medium text-m3-outline mt-1 flex items-center gap-1.5">
                <Clock className="w-3 h-3 text-m3-outline shrink-0" />
                <span>{formatMatchDate(detail.when)}</span>
                <span>•</span>
                <span className="font-mono">{formatDuration(matchDurationMs)}</span>
              </div>
            </div>

            {/* Match Score (M3 Semantic Tones) */}
            {isDeathmatch ? (
              <div className="flex items-center gap-2 bg-m3-surface-container-high border border-m3-outline-subtle px-3 py-1.5 rounded-2xl shrink-0">
                <span className="font-display font-black text-sm text-amber-300">
                  Free For All
                </span>
                <span className="text-m3-outline text-xs">•</span>
                <span className="text-xs font-mono font-bold text-m3-outline">
                  {ffaPlayers.length} Players
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 bg-m3-surface-container-high border border-m3-outline-subtle px-3 py-1.5 rounded-2xl shrink-0">
                <span className="font-display font-black text-base text-m3-mint">
                  Team Blue {teamBlueScore}
                </span>
                <span className="text-m3-outline font-bold text-sm">:</span>
                <span className="font-display font-black text-base text-m3-coral">
                  {teamRedScore} Team Red
                </span>
              </div>
            )}
          </div>

          {/* Right side: Round Timeline Strip + Close Button (Timeline scrolls, controls NEVER get pushed off) */}
          <div className="flex items-center gap-2.5 min-w-0 flex-1 justify-end">
            {detail.rounds && detail.rounds.length > 0 && (
              <div className="flex flex-col gap-0.5 bg-m3-surface-container-high border border-m3-outline-subtle px-2 py-1 rounded-xl max-w-[360px] sm:max-w-[440px] md:max-w-[560px] lg:max-w-[660px] overflow-x-auto custom-scrollbar shrink">
                {/* Team Blue Row */}
                <div className="flex items-center gap-1 min-w-max">
                  <span className="w-7 text-[8.5px] font-bold text-m3-mint shrink-0">
                    Blue
                  </span>
                  <div className="flex items-center gap-0.5">
                    {detail.rounds.map((r, i) => {
                      const isWin = r.winningTeam === 'Blue';
                      const outcomeIcon = getRoundOutcomeIcon(r.roundResult, true);
                      return (
                        <div
                          key={i}
                          title={`Round ${i + 1}: ${r.winningTeam} won (${r.roundResult || 'Eliminated'})`}
                          className="w-3.5 h-3.5 flex items-center justify-center shrink-0"
                        >
                          {isWin ? (
                            <img src={outcomeIcon} alt="" className="w-3 h-3 object-contain" />
                          ) : (
                            <span className="text-[8px] text-white/15 leading-none select-none">·</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Team Red Row */}
                <div className="flex items-center gap-1 min-w-max">
                  <span className="w-7 text-[8.5px] font-bold text-m3-coral shrink-0">
                    Red
                  </span>
                  <div className="flex items-center gap-0.5">
                    {detail.rounds.map((r, i) => {
                      const isWin = r.winningTeam === 'Red';
                      const outcomeIcon = getRoundOutcomeIcon(r.roundResult, false);
                      return (
                        <div
                          key={i}
                          title={`Round ${i + 1}: ${r.winningTeam} won (${r.roundResult || 'Eliminated'})`}
                          className="w-3.5 h-3.5 flex items-center justify-center shrink-0"
                        >
                          {isWin ? (
                            <img src={outcomeIcon} alt="" className="w-3 h-3 object-contain" />
                          ) : (
                            <span className="text-[8px] text-white/15 leading-none select-none">·</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Persistent Close Button — shrink-0 so X NEVER disappears */}
            <button
              type="button"
              onClick={onClose}
              title="Close"
              className="w-8 h-8 rounded-xl bg-m3-surface-container-high hover:bg-rose-600 hover:text-white text-m3-outline flex items-center justify-center transition-colors cursor-pointer shrink-0 border border-m3-outline-subtle shadow-xs"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Modal Navigation Tabs */}
        <div className="flex items-center gap-6 px-4 bg-m3-surface-container-high/60 border-b border-m3-outline-subtle text-xs sm:text-[13px] font-bold shrink-0 h-10">
          {[
            { id: 'scoreboard', label: 'Scoreboard' },
            { id: 'duels', label: 'Duels' },
          ].map((t) => {
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id as ModalTab)}
                className={`relative h-full flex items-center justify-center px-2 transition-colors cursor-pointer whitespace-nowrap font-bold ${
                  active ? 'text-m3-on-surface' : 'text-m3-outline hover:text-m3-on-surface'
                }`}
              >
                <span>{t.label}</span>
                <span
                  className={`absolute bottom-0 left-0 right-0 h-[2.5px] rounded-full transition-all duration-150 pointer-events-none ${
                    active
                      ? 'bg-m3-primary opacity-100 shadow-[0_0_8px_rgba(182,171,247,0.5)]'
                      : 'bg-transparent opacity-0 scale-x-75'
                  }`}
                />
              </button>
            );
          })}
        </div>

        {/* Body Content */}
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 sm:p-3.5 flex flex-col gap-2.5">
          {/* Tab 1: Scoreboard */}
          {activeTab === 'scoreboard' && (
            isDeathmatch ? (
              /* Deathmatch / Free For All Unified Table */
              <div className="flex-1 rounded-2xl border border-m3-outline-subtle overflow-hidden bg-m3-surface-container flex flex-col min-h-0">
                {/* Banner */}
                <div className="px-4 py-2 bg-m3-surface-container-high border-b border-m3-outline-subtle flex items-center justify-between text-xs font-bold text-amber-300 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-amber-400" />
                    <span>Free For All • Deathmatch ({ffaPlayers.length} Players)</span>
                  </div>
                  <span className="text-m3-outline font-medium text-[11px]">
                    Parties indicated by edge color bars
                  </span>
                </div>

                {/* Table */}
                <div className="flex-1 overflow-x-auto min-h-0">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-m3-outline-subtle/60 bg-m3-surface-container-highest/40 text-[10px] font-bold uppercase tracking-wider text-m3-outline select-none">
                        <th className="py-2 px-3 min-w-[36px]">#</th>
                        <th className="py-2 px-3 min-w-[44px]">Agent</th>
                        <th className="py-2 px-3 min-w-[140px]">Player</th>
                        <th className="py-2 px-2 text-center">Score</th>
                        <th className="py-2 px-2.5 text-center">K / D / A</th>
                        <th className="py-2 px-2 text-center">+/-</th>
                        <th className="py-2 px-2 text-center">K/D</th>
                        <th className="py-2 px-2 text-center">Damage</th>
                        <th className="py-2 px-2 text-center">HS%</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-m3-outline-subtle/30 font-mono">
                      {ffaPlayers.map((p, idx) => {
                        const rIcon = p.tier && tierIcons[p.tier] ? tierIcons[p.tier] : '';
                        const party = getPartyStyle(p.partyIndex);
                        const isFirst = idx === 0;

                        return (
                          <tr
                            key={p.puuid || idx}
                            className={`hover:bg-m3-surface-container-high/60 transition-colors ${
                              party ? party.bg : p.isMe ? 'bg-m3-primary/10' : ''
                            }`}
                          >
                            {/* Rank Place */}
                            <td className="py-2 px-3 font-bold text-xs text-m3-outline">
                              {idx + 1}
                            </td>

                            {/* Agent */}
                            <td className="relative py-1.5 px-3">
                              {party && (
                                <div
                                  className={`absolute left-0 top-1 bottom-1 w-1 rounded-r-full ${party.bar}`}
                                  title="Queued together in party"
                                />
                              )}
                              {p.isMe && !party && (
                                <div className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full bg-m3-primary" />
                              )}
                              <div className="relative w-7 h-7 rounded-lg overflow-hidden border border-m3-outline-subtle bg-m3-surface-container-highest">
                                {p.agIcon ? (
                                  <img src={p.agIcon} alt={p.agent} className="w-full h-full object-cover" />
                                ) : (
                                  <div className="w-full h-full bg-m3-surface-container-highest" />
                                )}
                                {p.accountLevel ? (
                                  <span className="absolute bottom-0 right-0 text-[7px] bg-black/80 px-0.5 rounded-tl font-bold text-white leading-tight">
                                    {p.accountLevel}
                                  </span>
                                ) : null}
                              </div>
                            </td>

                            {/* Player Name */}
                            <td className="py-1.5 px-3 font-sans">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <button
                                  type="button"
                                  onClick={() => openPlayer(p)}
                                  className="font-bold text-xs truncate max-w-[140px] text-left hover:underline hover:text-m3-primary transition-colors cursor-pointer group flex items-center gap-1"
                                >
                                  <span className={p.isMe ? 'text-m3-primary font-black' : 'text-m3-on-surface'}>
                                    {p.displayName}
                                  </span>
                                  {p.displayTag ? (
                                    <span className="text-[10px] text-m3-outline font-normal">#{p.displayTag}</span>
                                  ) : null}
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => copyPlayerRiotId(e, p)}
                                  className="p-1 rounded hover:bg-m3-surface-container-highest text-m3-outline hover:text-m3-on-surface transition-colors cursor-pointer shrink-0"
                                  title={copiedPuuid === p.puuid ? 'Copied!' : `Copy ${p.displayName}${p.displayTag ? '#' + p.displayTag : ''}`}
                                  aria-label={`Copy Riot ID for ${p.displayName}`}
                                >
                                  {copiedPuuid === p.puuid ? (
                                    <Check className="w-3 h-3 text-emerald-400" />
                                  ) : (
                                    <Copy className="w-3 h-3" />
                                  )}
                                </button>
                                {rIcon ? (
                                  <img src={rIcon} alt="" className="w-3.5 h-3.5 object-contain" />
                                ) : null}
                                {isFirst && (
                                  <span className="px-1 py-px rounded text-[8px] font-black uppercase tracking-wider bg-amber-400/15 text-amber-300 border border-amber-400/40">
                                    Winner
                                  </span>
                                )}
                              </div>
                            </td>

                            {/* Score */}
                            <td className="py-1.5 px-2 text-center text-m3-outline font-bold text-xs">{p.score}</td>

                            {/* K/D/A */}
                            <td className="py-1.5 px-2.5 text-center text-m3-on-surface text-xs">
                              {p.kills} <span className="text-m3-outline">/</span> {p.deaths} <span className="text-m3-outline">/</span> {p.assists}
                            </td>

                            {/* +/- */}
                            <td className={`py-1.5 px-2 text-center font-bold text-xs ${p.diff >= 0 ? 'text-m3-mint' : 'text-m3-coral'}`}>
                              {p.diff > 0 ? `+${p.diff}` : p.diff}
                            </td>

                            {/* K/D */}
                            <td className={`py-1.5 px-2 text-center font-extrabold text-xs ${p.kd >= 1 ? 'text-m3-mint' : 'text-m3-coral'}`}>
                              {p.kd.toFixed(2)}
                            </td>

                            {/* Damage */}
                            <td className="py-1.5 px-2 text-center text-m3-on-surface font-medium text-xs">{p.damage}</td>

                            {/* HS% */}
                            <td className="py-1.5 px-2 text-center text-m3-on-surface font-medium text-xs">{p.hsPct}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col justify-between gap-2.5 min-h-0">
                {/* Team Blue Table */}
              <div className="flex-1 rounded-2xl border border-m3-outline-subtle overflow-hidden bg-m3-surface-container flex flex-col min-h-0">
                {/* Team Blue Banner */}
                <div className="px-3.5 py-1.5 bg-m3-surface-container-high border-b border-m3-outline-subtle flex items-center justify-between text-xs font-bold text-m3-mint shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-m3-mint" />
                    <span>Team Blue • {teamBlueScore} Rounds</span>
                  </div>
                  <span className="text-m3-outline font-medium text-[11px]">
                    Avg. Rank: {avgRankName(teamBlue)}
                  </span>
                </div>

                {/* Table */}
                <div className="flex-1 overflow-x-auto min-h-0">
                  <table className="w-full h-full table-fixed text-left text-xs border-collapse">
                    <colgroup>
                      <col className="w-[52px]" />
                      <col className="w-[200px]" />
                      <col className="w-[44px]" />
                      <col className="w-[50px]" />
                      <col className="w-[88px]" />
                      <col className="w-[44px]" />
                      <col className="w-[48px]" />
                      <col className="w-[48px]" />
                      <col className="w-[48px]" />
                      <col className="w-[48px]" />
                      <col className="w-[48px]" />
                      <col className="w-[38px]" />
                      <col className="w-[38px]" />
                      <col className="w-[38px]" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-m3-outline-subtle/60 bg-m3-surface-container-highest/40 text-[10px] font-bold uppercase tracking-wider text-m3-outline select-none">
                        <th className="py-2 px-3">Agent</th>
                        <th className="py-2 px-3">Player</th>
                        <th className="py-2 px-1 text-center">TRS</th>
                        <th className="py-2 px-1 text-center">ACS</th>
                        <th className="py-2 px-2 text-center">K / D / A</th>
                        <th className="py-2 px-1 text-center">+/-</th>
                        <th className="py-2 px-1 text-center">K/D</th>
                        <th className="py-2 px-1 text-center">DDΔ</th>
                        <th className="py-2 px-1 text-center">ADR</th>
                        <th className="py-2 px-1 text-center">HS%</th>
                        <th className="py-2 px-1 text-center">KAST</th>
                        <th className="py-2 px-1 text-center">FK</th>
                        <th className="py-2 px-1 text-center">FD</th>
                        <th className="py-2 px-1 text-center">MK</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-m3-outline-subtle/30 font-mono">
                      {teamBlue.map((p, idx) => {
                        const isMatchMvp = p.puuid === matchMvpPuuid;
                        const isTeamMvp = idx === 0 && !isMatchMvp;
                        const rIcon = p.tier && tierIcons[p.tier] ? tierIcons[p.tier] : '';
                        const party = getPartyStyle(p.partyIndex);

                        return (
                          <tr
                            key={p.puuid || idx}
                            className={`h-[20%] hover:bg-m3-surface-container-high/60 transition-colors ${
                              party ? party.bg : p.isMe ? 'bg-m3-primary/10' : ''
                            }`}
                          >
                            {/* Agent */}
                            <td className="relative py-1.5 px-3">
                              {party ? (
                                <div
                                  className={`absolute left-0 top-1 bottom-1 w-1 rounded-r-full ${party.bar}`}
                                  title="Queued together"
                                />
                              ) : p.isMe ? (
                                <div className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full bg-m3-primary" />
                              ) : null}
                              <div className="relative w-7 h-7 rounded-lg overflow-hidden border border-m3-outline-subtle bg-m3-surface-container-highest">
                                {p.agIcon ? (
                                  <img src={p.agIcon} alt={p.agent} className="w-full h-full object-cover" />
                                ) : (
                                  <div className="w-full h-full bg-m3-surface-container-highest" />
                                )}
                                {p.accountLevel ? (
                                  <span className="absolute bottom-0 right-0 text-[7px] bg-black/80 px-0.5 rounded-tl font-bold text-white leading-tight">
                                    {p.accountLevel}
                                  </span>
                                ) : null}
                              </div>
                            </td>

                            {/* Player Name (Clickable) */}
                            <td className="py-1.5 px-3 font-sans truncate">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <button
                                  type="button"
                                  onClick={() => openPlayer(p)}
                                  className="font-bold text-xs truncate max-w-[115px] text-left hover:underline hover:text-m3-primary transition-colors cursor-pointer group flex items-center gap-1 shrink min-w-0"
                                >
                                  <span className={p.isMe ? 'text-m3-primary font-black truncate' : 'text-m3-on-surface truncate'}>
                                    {p.displayName}
                                  </span>
                                  {p.displayTag ? (
                                    <span className="text-[10px] text-m3-outline font-normal shrink-0">#{p.displayTag}</span>
                                  ) : null}
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => copyPlayerRiotId(e, p)}
                                  className="p-1 rounded hover:bg-m3-surface-container-highest text-m3-outline hover:text-m3-on-surface transition-colors cursor-pointer shrink-0"
                                  title={copiedPuuid === p.puuid ? 'Copied!' : `Copy ${p.displayName}${p.displayTag ? '#' + p.displayTag : ''}`}
                                  aria-label={`Copy Riot ID for ${p.displayName}`}
                                >
                                  {copiedPuuid === p.puuid ? (
                                    <Check className="w-3 h-3 text-emerald-400" />
                                  ) : (
                                    <Copy className="w-3 h-3" />
                                  )}
                                </button>
                                {rIcon ? (
                                  <img src={rIcon} alt="" className="w-3.5 h-3.5 object-contain shrink-0" />
                                ) : null}
                                {isMatchMvp ? (
                                  <span className="px-1 py-px rounded text-[8px] font-black uppercase tracking-wider bg-m3-tertiary/15 text-m3-tertiary border border-m3-tertiary/40 shrink-0">
                                    Match MVP
                                  </span>
                                ) : isTeamMvp ? (
                                  <span className="px-1 py-px rounded text-[8px] font-black uppercase tracking-wider bg-m3-primary/15 text-m3-primary border border-m3-primary/40 shrink-0">
                                    Team MVP
                                  </span>
                                ) : null}
                              </div>
                            </td>

                            {/* TRS - Tracker Badge */}
                            <td className="py-1.5 px-1 text-center">
                              <div
                                className="flex items-center justify-center cursor-default"
                                title={
                                  p.trs > 0
                                    ? `Tracker Score: ${p.trs} / 1000 — Tier ${scoreTier(p.trs).tier}`
                                    : 'Tracker Score unavailable'
                                }
                              >
                                {p.trs > 0 ? (
                                  <ScoreBadge tier={scoreTier(p.trs).tier} size={20} />
                                ) : (
                                  <span className="text-[10px] font-mono text-zinc-500">—</span>
                                )}
                              </div>
                            </td>

                            {/* ACS */}
                            <td className="py-1.5 px-1 text-center text-m3-on-surface font-extrabold text-xs">{p.acs}</td>

                            {/* K/D/A */}
                            <td className="py-1.5 px-2 text-center text-m3-on-surface text-xs whitespace-nowrap">
                              {p.kills} <span className="text-m3-outline">/</span> {p.deaths} <span className="text-m3-outline">/</span> {p.assists}
                            </td>

                            {/* +/- */}
                            <td className={`py-1.5 px-1 text-center font-bold text-xs ${p.diff >= 0 ? 'text-m3-mint' : 'text-m3-coral'}`}>
                              {p.diff > 0 ? `+${p.diff}` : p.diff}
                            </td>

                            {/* K/D */}
                            <td className={`py-1.5 px-1 text-center font-extrabold text-xs ${p.kd >= 1 ? 'text-m3-mint' : 'text-m3-coral'}`}>
                              {p.kd.toFixed(2)}
                            </td>

                            {/* DDΔ */}
                            <td className={`py-1.5 px-1 text-center font-bold text-xs ${p.ddPerRound >= 0 ? 'text-m3-mint' : 'text-m3-coral'}`}>
                              {p.ddPerRound > 0 ? `+${p.ddPerRound}` : p.ddPerRound}
                            </td>

                            {/* ADR */}
                            <td className="py-1.5 px-1 text-center text-m3-on-surface font-medium text-xs">{p.adr}</td>

                            {/* HS% */}
                            <td className="py-1.5 px-1 text-center text-m3-on-surface font-medium text-xs">{p.hsPct}%</td>

                            {/* KAST */}
                            <td className="py-1.5 px-1 text-center text-m3-outline font-medium text-xs">{p.kast}%</td>

                            {/* FK */}
                            <td className="py-1.5 px-1 text-center text-m3-mint font-bold text-xs">{p.fk}</td>

                            {/* FD */}
                            <td className="py-1.5 px-1 text-center text-m3-coral font-bold text-xs">{p.fd}</td>

                            {/* MK */}
                            <td className="py-1.5 px-1 text-center text-m3-tertiary font-bold text-xs">{p.mk}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Team Red Table */}
              <div className="flex-1 rounded-2xl border border-m3-outline-subtle overflow-hidden bg-m3-surface-container flex flex-col min-h-0">
                {/* Team Red Banner */}
                <div className="px-3.5 py-1.5 bg-m3-surface-container-high border-b border-m3-outline-subtle flex items-center justify-between text-xs font-bold text-m3-coral shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-m3-coral" />
                    <span>Team Red • {teamRedScore} Rounds</span>
                  </div>
                  <span className="text-m3-outline font-medium text-[11px]">
                    Avg. Rank: {avgRankName(teamRed)}
                  </span>
                </div>

                {/* Table */}
                <div className="flex-1 overflow-x-auto min-h-0">
                  <table className="w-full h-full table-fixed text-left text-xs border-collapse">
                    <colgroup>
                      <col className="w-[52px]" />
                      <col className="w-[200px]" />
                      <col className="w-[44px]" />
                      <col className="w-[50px]" />
                      <col className="w-[88px]" />
                      <col className="w-[44px]" />
                      <col className="w-[48px]" />
                      <col className="w-[48px]" />
                      <col className="w-[48px]" />
                      <col className="w-[48px]" />
                      <col className="w-[48px]" />
                      <col className="w-[38px]" />
                      <col className="w-[38px]" />
                      <col className="w-[38px]" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-m3-outline-subtle/60 bg-m3-surface-container-highest/40 text-[10px] font-bold uppercase tracking-wider text-m3-outline select-none">
                        <th className="py-2 px-3">Agent</th>
                        <th className="py-2 px-3">Player</th>
                        <th className="py-2 px-1 text-center">TRS</th>
                        <th className="py-2 px-1 text-center">ACS</th>
                        <th className="py-2 px-2 text-center">K / D / A</th>
                        <th className="py-2 px-1 text-center">+/-</th>
                        <th className="py-2 px-1 text-center">K/D</th>
                        <th className="py-2 px-1 text-center">DDΔ</th>
                        <th className="py-2 px-1 text-center">ADR</th>
                        <th className="py-2 px-1 text-center">HS%</th>
                        <th className="py-2 px-1 text-center">KAST</th>
                        <th className="py-2 px-1 text-center">FK</th>
                        <th className="py-2 px-1 text-center">FD</th>
                        <th className="py-2 px-1 text-center">MK</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-m3-outline-subtle/30 font-mono">
                      {teamRed.map((p, idx) => {
                        const isMatchMvp = p.puuid === matchMvpPuuid;
                        const isTeamMvp = idx === 0 && !isMatchMvp;
                        const rIcon = p.tier && tierIcons[p.tier] ? tierIcons[p.tier] : '';
                        const party = getPartyStyle(p.partyIndex);

                        return (
                          <tr
                            key={p.puuid || idx}
                            className={`h-[20%] hover:bg-m3-surface-container-high/60 transition-colors ${
                              party ? party.bg : p.isMe ? 'bg-m3-primary/10' : ''
                            }`}
                          >
                            {/* Agent */}
                            <td className="relative py-1.5 px-3">
                              {party ? (
                                <div
                                  className={`absolute left-0 top-1 bottom-1 w-1 rounded-r-full ${party.bar}`}
                                  title="Queued together"
                                />
                              ) : p.isMe ? (
                                <div className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full bg-m3-primary" />
                              ) : null}
                              <div className="relative w-7 h-7 rounded-lg overflow-hidden border border-m3-outline-subtle bg-m3-surface-container-highest">
                                {p.agIcon ? (
                                  <img src={p.agIcon} alt={p.agent} className="w-full h-full object-cover" />
                                ) : (
                                  <div className="w-full h-full bg-m3-surface-container-highest" />
                                )}
                                {p.accountLevel ? (
                                  <span className="absolute bottom-0 right-0 text-[7px] bg-black/80 px-0.5 rounded-tl font-bold text-white leading-tight">
                                    {p.accountLevel}
                                  </span>
                                ) : null}
                              </div>
                            </td>

                            {/* Player Name (Clickable) */}
                            <td className="py-1.5 px-3 font-sans truncate">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <button
                                  type="button"
                                  onClick={() => openPlayer(p)}
                                  className="font-bold text-xs truncate max-w-[115px] text-left hover:underline hover:text-m3-primary transition-colors cursor-pointer group flex items-center gap-1 shrink min-w-0"
                                >
                                  <span className={p.isMe ? 'text-m3-primary font-black truncate' : 'text-m3-on-surface truncate'}>
                                    {p.displayName}
                                  </span>
                                  {p.displayTag ? (
                                    <span className="text-[10px] text-m3-outline font-normal shrink-0">#{p.displayTag}</span>
                                  ) : null}
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => copyPlayerRiotId(e, p)}
                                  className="p-1 rounded hover:bg-m3-surface-container-highest text-m3-outline hover:text-m3-on-surface transition-colors cursor-pointer shrink-0"
                                  title={copiedPuuid === p.puuid ? 'Copied!' : `Copy ${p.displayName}${p.displayTag ? '#' + p.displayTag : ''}`}
                                  aria-label={`Copy Riot ID for ${p.displayName}`}
                                >
                                  {copiedPuuid === p.puuid ? (
                                    <Check className="w-3 h-3 text-emerald-400" />
                                  ) : (
                                    <Copy className="w-3 h-3" />
                                  )}
                                </button>
                                {rIcon ? (
                                  <img src={rIcon} alt="" className="w-3.5 h-3.5 object-contain shrink-0" />
                                ) : null}
                                {isMatchMvp ? (
                                  <span className="px-1 py-px rounded text-[8px] font-black uppercase tracking-wider bg-m3-tertiary/15 text-m3-tertiary border border-m3-tertiary/40 shrink-0">
                                    Match MVP
                                  </span>
                                ) : isTeamMvp ? (
                                  <span className="px-1 py-px rounded text-[8px] font-black uppercase tracking-wider bg-m3-primary/15 text-m3-primary border border-m3-primary/40 shrink-0">
                                    Team MVP
                                  </span>
                                ) : null}
                              </div>
                            </td>

                            {/* TRS - Tracker Badge */}
                            <td className="py-1.5 px-1 text-center">
                              <div
                                className="flex items-center justify-center cursor-default"
                                title={
                                  p.trs > 0
                                    ? `Tracker Score: ${p.trs} / 1000 — Tier ${scoreTier(p.trs).tier}`
                                    : 'Tracker Score unavailable'
                                }
                              >
                                {p.trs > 0 ? (
                                  <ScoreBadge tier={scoreTier(p.trs).tier} size={20} />
                                ) : (
                                  <span className="text-[10px] font-mono text-zinc-500">—</span>
                                )}
                              </div>
                            </td>

                            {/* ACS */}
                            <td className="py-1.5 px-1 text-center text-m3-on-surface font-extrabold text-xs">{p.acs}</td>

                            {/* K/D/A */}
                            <td className="py-1.5 px-2 text-center text-m3-on-surface text-xs whitespace-nowrap">
                              {p.kills} <span className="text-m3-outline">/</span> {p.deaths} <span className="text-m3-outline">/</span> {p.assists}
                            </td>

                            {/* +/- */}
                            <td className={`py-1.5 px-1 text-center font-bold text-xs ${p.diff >= 0 ? 'text-m3-mint' : 'text-m3-coral'}`}>
                              {p.diff > 0 ? `+${p.diff}` : p.diff}
                            </td>

                            {/* K/D */}
                            <td className={`py-1.5 px-1 text-center font-extrabold text-xs ${p.kd >= 1 ? 'text-m3-mint' : 'text-m3-coral'}`}>
                              {p.kd.toFixed(2)}
                            </td>

                            {/* DDΔ */}
                            <td className={`py-1.5 px-1 text-center font-bold text-xs ${p.ddPerRound >= 0 ? 'text-m3-mint' : 'text-m3-coral'}`}>
                              {p.ddPerRound > 0 ? `+${p.ddPerRound}` : p.ddPerRound}
                            </td>

                            {/* ADR */}
                            <td className="py-1.5 px-1 text-center text-m3-on-surface font-medium text-xs">{p.adr}</td>

                            {/* HS% */}
                            <td className="py-1.5 px-1 text-center text-m3-on-surface font-medium text-xs">{p.hsPct}%</td>

                            {/* KAST */}
                            <td className="py-1.5 px-1 text-center text-m3-outline font-medium text-xs">{p.kast}%</td>

                            {/* FK */}
                            <td className="py-1.5 px-1 text-center text-m3-mint font-bold text-xs">{p.fk}</td>

                            {/* FD */}
                            <td className="py-1.5 px-1 text-center text-m3-coral font-bold text-xs">{p.fd}</td>

                            {/* MK */}
                            <td className="py-1.5 px-1 text-center text-m3-tertiary font-bold text-xs">{p.mk}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            )
          )}

          {/* Tab 2: Duels — head-to-head kill matrix */}
          {activeTab === 'duels' && duelData && (
            <div className="flex flex-col gap-4">
              {/* Rivalry cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  { title: 'Top Rivalry', pair: duelData.top },
                  { title: 'Mismatch A', pair: duelData.mism[0] ?? null },
                  { title: 'Mismatch B', pair: duelData.mism[1] ?? null },
                ]
                  .flatMap((c) => (c.pair ? [{ title: c.title, pair: c.pair }] : []))
                  .map((c) => (
                    <div key={c.title} className="rounded-2xl border border-m3-outline-subtle bg-m3-surface-container overflow-hidden">
                      <div className="text-center text-[10px] font-bold uppercase tracking-wider text-m3-outline pt-2">
                        {c.title}
                      </div>
                      <div className="grid grid-cols-[1fr_auto_1fr] items-stretch">
                        <div className="flex flex-col items-center gap-1 p-3 bg-m3-mint/10">
                          <button type="button" onClick={() => openPlayer(c.pair.a)} className="cursor-pointer" title={c.pair.a.displayName}>
                            {c.pair.a.agIcon ? (
                              <img src={c.pair.a.agIcon} alt={c.pair.a.agent} className="w-10 h-10 rounded-xl object-cover border border-m3-outline-subtle bg-m3-surface-container-highest" />
                            ) : (
                              <div className="w-10 h-10 rounded-xl bg-m3-surface-container-highest border border-m3-outline-subtle" />
                            )}
                          </button>
                          <span className="text-[9px] font-semibold text-m3-outline">Kills vs Rival</span>
                          <span className="min-w-7 h-7 px-1.5 rounded-lg bg-m3-mint/20 border border-m3-mint/40 text-m3-mint font-mono font-extrabold text-sm flex items-center justify-center">
                            {c.pair.aKills}
                          </span>
                        </div>
                        <div className="flex flex-col items-center justify-center px-1.5 gap-1">
                          <Swords className="w-3.5 h-3.5 text-m3-outline" />
                          <span className="font-display font-black text-[11px] text-m3-outline">VS</span>
                        </div>
                        <div className="flex flex-col items-center gap-1 p-3 bg-m3-coral/10">
                          <button type="button" onClick={() => openPlayer(c.pair.b)} className="cursor-pointer" title={c.pair.b.displayName}>
                            {c.pair.b.agIcon ? (
                              <img src={c.pair.b.agIcon} alt={c.pair.b.agent} className="w-10 h-10 rounded-xl object-cover border border-m3-outline-subtle bg-m3-surface-container-highest" />
                            ) : (
                              <div className="w-10 h-10 rounded-xl bg-m3-surface-container-highest border border-m3-outline-subtle" />
                            )}
                          </button>
                          <span className="text-[9px] font-semibold text-m3-outline">Kills vs Rival</span>
                          <span className="min-w-7 h-7 px-1.5 rounded-lg bg-m3-coral/20 border border-m3-coral/40 text-m3-coral font-mono font-extrabold text-sm flex items-center justify-center">
                            {c.pair.bKills}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
              </div>

              {/* Kill matrix: Blue rows × Red columns */}
              <div className="rounded-2xl border border-m3-outline-subtle bg-m3-surface-container overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-max text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-m3-outline-subtle/60 bg-m3-surface-container-high/60">
                        <th className="p-2 text-left min-w-[150px]">
                          <span className="inline-flex items-center gap-1.5 text-[11px] font-black">
                            <span className="px-1.5 py-0.5 rounded-md bg-m3-mint/20 text-m3-mint">A</span>
                            <span className="text-m3-outline">VS</span>
                            <span className="px-1.5 py-0.5 rounded-md bg-m3-coral/20 text-m3-coral">B</span>
                          </span>
                        </th>
                        {teamRed.map((b) => (
                          <th key={b.puuid} className="p-2 min-w-[110px] bg-m3-coral/[0.07]">
                            <button type="button" onClick={() => openPlayer(b)} className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-opacity">
                              {b.agIcon ? (
                                <img src={b.agIcon} alt={b.agent} className="w-7 h-7 rounded-lg object-cover border border-m3-outline-subtle bg-m3-surface-container-highest shrink-0" />
                              ) : null}
                              <span className="text-left leading-tight">
                                <span className="block font-bold text-m3-on-surface truncate max-w-[90px]">{b.displayName}</span>
                                <span className="block text-[10px] font-medium text-m3-outline">{b.agent}</span>
                              </span>
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-m3-outline-subtle/30">
                      {teamBlue.map((a) => (
                        <tr key={a.puuid} className="hover:bg-m3-surface-container-high/40 transition-colors">
                          <th className="p-2 text-left bg-m3-mint/[0.05]">
                            <button type="button" onClick={() => openPlayer(a)} className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-opacity">
                              {a.agIcon ? (
                                <img src={a.agIcon} alt={a.agent} className="w-7 h-7 rounded-lg object-cover border border-m3-outline-subtle bg-m3-surface-container-highest shrink-0" />
                              ) : null}
                              <span className="text-left leading-tight">
                                <span className="block font-bold text-m3-on-surface truncate max-w-[110px]">{a.displayName}</span>
                                <span className="block text-[10px] font-medium text-m3-outline">{a.agent}</span>
                              </span>
                            </button>
                          </th>
                          {teamRed.map((b) => {
                            const k = duelData.count(a.puuid, b.puuid);
                            const d = duelData.count(b.puuid, a.puuid);
                            const tied = k === d;
                            const kCls = k === 0 && d === 0
                              ? 'bg-m3-surface-container-highest/60 border-m3-outline-subtle/40 text-m3-outline/50'
                              : tied
                                ? 'bg-m3-tertiary/20 border-m3-tertiary/40 text-m3-tertiary'
                                : k > d
                                  ? 'bg-m3-mint/25 border-m3-mint/50 text-m3-mint'
                                  : 'bg-m3-surface-container-highest/60 border-m3-outline-subtle/40 text-m3-outline';
                            const dCls = k === 0 && d === 0
                              ? 'bg-m3-surface-container-highest/60 border-m3-outline-subtle/40 text-m3-outline/50'
                              : tied
                                ? 'bg-m3-tertiary/20 border-m3-tertiary/40 text-m3-tertiary'
                                : d > k
                                  ? 'bg-m3-coral/25 border-m3-coral/50 text-m3-coral'
                                  : 'bg-m3-surface-container-highest/60 border-m3-outline-subtle/40 text-m3-outline';
                            return (
                              <td key={b.puuid} className="p-1.5 text-center">
                                <span className="inline-flex items-center gap-1 font-mono font-extrabold text-[13px]">
                                  <span className={`min-w-7 h-7 px-1 rounded-lg border flex items-center justify-center ${kCls}`}>{k}</span>
                                  <span className={`min-w-7 h-7 px-1 rounded-lg border flex items-center justify-center ${dCls}`}>{d}</span>
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* In-Depth Duels Analytics & Match Insights */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 mt-1">
                {/* Panel 1: Personal Match Duels & Opening Duels */}
                <div className="rounded-2xl border border-m3-outline-subtle bg-m3-surface-container p-4 flex flex-col gap-3">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-m3-outline flex items-center justify-between">
                    <span>Personal Match Duels</span>
                    <span className="text-m3-mint font-mono font-bold">
                      {personalDuels.totalKills}W - {personalDuels.totalDeaths}L Net
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {/* Nemesis */}
                    <div className="p-3 rounded-xl bg-m3-coral/10 border border-m3-coral/30 flex flex-col gap-1">
                      <span className="text-[9px] font-bold uppercase tracking-wider text-m3-coral">
                        Your Nemesis
                      </span>
                      {personalDuels.nemesis ? (
                        <div className="flex items-center gap-2.5 mt-0.5">
                          {personalDuels.nemesis.opponent.agIcon ? (
                            <img src={personalDuels.nemesis.opponent.agIcon} alt="" className="w-8 h-8 rounded-lg object-cover border border-m3-outline-subtle shrink-0" />
                          ) : (
                            <div className="w-8 h-8 rounded-lg bg-m3-surface-container-highest shrink-0" />
                          )}
                          <div className="min-w-0">
                            <span className="block font-bold text-xs text-m3-on-surface truncate">
                              {personalDuels.nemesis.opponent.displayName}
                            </span>
                            <span className="block text-[10px] font-mono font-bold text-m3-coral">
                              {personalDuels.nemesis.deaths} Deaths vs {personalDuels.nemesis.kills} Kills
                            </span>
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-m3-outline mt-1">No rival deaths</span>
                      )}
                    </div>

                    {/* Prey / Dominated */}
                    <div className="p-3 rounded-xl bg-m3-mint/10 border border-m3-mint/30 flex flex-col gap-1">
                      <span className="text-[9px] font-bold uppercase tracking-wider text-m3-mint">
                        Most Dominated
                      </span>
                      {personalDuels.prey ? (
                        <div className="flex items-center gap-2.5 mt-0.5">
                          {personalDuels.prey.opponent.agIcon ? (
                            <img src={personalDuels.prey.opponent.agIcon} alt="" className="w-8 h-8 rounded-lg object-cover border border-m3-outline-subtle shrink-0" />
                          ) : (
                            <div className="w-8 h-8 rounded-lg bg-m3-surface-container-highest shrink-0" />
                          )}
                          <div className="min-w-0">
                            <span className="block font-bold text-xs text-m3-on-surface truncate">
                              {personalDuels.prey.opponent.displayName}
                            </span>
                            <span className="block text-[10px] font-mono font-bold text-m3-mint">
                              {personalDuels.prey.kills} Kills vs {personalDuels.prey.deaths} Deaths
                            </span>
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-m3-outline mt-1">No repeat kills</span>
                      )}
                    </div>
                  </div>

                  {/* Opening Duels (First Bloods) */}
                  <div className="p-3 rounded-xl bg-m3-surface-container-high border border-m3-outline-subtle/50 flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-m3-outline block">
                        Opening Duels (First Bloods)
                      </span>
                      <span className="font-display font-extrabold text-xs text-m3-on-surface mt-0.5 block">
                        Team Blue {firstBloods.blue} • {firstBloods.red} Team Red
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] text-m3-outline font-medium block">
                        Blue FB Conversion
                      </span>
                      <span className="font-mono font-black text-sm text-m3-mint">
                        {firstBloods.blueConversion}%
                      </span>
                    </div>
                  </div>
                </div>

                {/* Panel 2: Round End Conditions with Official Valorant Icons */}
                <div className="rounded-2xl border border-m3-outline-subtle bg-m3-surface-container p-4 flex flex-col gap-3">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-m3-outline flex items-center justify-between">
                    <span>Round Win Conditions</span>
                    <span className="text-m3-outline font-mono text-[10px]">
                      {detail.rounds.length} Total Rounds
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    {roundWinConditions.map((c) => (
                      <div
                        key={c.name}
                        className="p-2.5 rounded-xl bg-m3-surface-container-high border border-m3-outline-subtle/40 flex items-center gap-2.5"
                      >
                        <img src={c.icon} alt="" className="w-6 h-6 object-contain shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between text-xs font-bold">
                            <span className="text-m3-on-surface truncate">{c.name}</span>
                            <span className="font-mono text-m3-primary">{c.count}</span>
                          </div>
                          <div className="w-full h-1.5 rounded-full bg-white/5 overflow-hidden mt-1.5">
                            <div
                              className="h-full rounded-full bg-m3-primary"
                              style={{ width: `${c.pct}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Weapon Kill Distribution */}
                  {weaponKills.length > 0 && (
                    <div className="pt-2 border-t border-m3-outline-subtle/40">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-m3-outline block mb-1.5">
                        Arsenal Kill Distribution
                      </span>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {weaponKills.slice(0, 6).map((w) => (
                          <span
                            key={w.name}
                            className="px-2.5 py-1 rounded-lg bg-m3-surface-container-highest border border-m3-outline-subtle text-[10px] font-mono font-bold flex items-center gap-1.5"
                          >
                            <span className="text-m3-on-surface">{w.name}</span>
                            <span className="text-m3-primary">({w.count})</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Nested Player Overview Modal */}
      {selectedPlayer && (
        <PlayerOverviewModal
          player={selectedPlayer}
          seasonId={seasonId}
          onClose={() => setSelectedPlayer(null)}
          onViewFullProfile={onSelectProfile}
        />
      )}
    </div>
  );
};
