import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Copy, Check, Lock } from 'lucide-react';
import { ScoreBadge, scoreTier } from './ScoreBadge';
import { fetchTrnActStats, fetchTrnAgents, isTrnPrivateError, trnNegativeKind, type TrnActStats, type TrnAgentStat } from '../utils/trn';
import { fetchMmrDirect, gameData } from '../utils/tracker';
import { getCountryName, getTrackerUrls, TRN_PRIVATE_TOOLTIP } from '../utils/playerDisplay';
import { openExternalUrl } from '../utils/ipc';
import type { TrackerProfile } from '../types';

export interface SelectedPlayerInfo {
  puuid: string;
  name: string;
  tag: string;
  agent: string;
  agIcon?: string;
  tier?: number;
  rankName?: string;
  rankIcon?: string;
  team: string;
  country?: string;
  isMe?: boolean;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  rounds: number;
  acs: number;
  kd: number;
  adr: number;
  hsPct: number;
  kast: number;
  fk: number;
  fd: number;
  mk: number;
  trs: number;
}

interface Props {
  player: SelectedPlayerInfo | null;
  seasonId?: string;
  onClose: () => void;
  onViewFullProfile?: (name: string, tag: string) => void;
}

export const PlayerOverviewModal: React.FC<Props> = ({
  player,
  seasonId,
  onClose,
  onViewFullProfile,
}) => {
  const [trnStats, setTrnStats] = useState<TrnActStats | null>(null);
  const [trnAgents, setTrnAgents] = useState<TrnAgentStat[]>([]);
  const [agentIconMap, setAgentIconMap] = useState<Record<string, string>>({});
  const [mmrProfile, setMmrProfile] = useState<TrackerProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    gameData().then((d) => {
      const map: Record<string, string> = {};
      Object.values(d.agentInfo).forEach((a) => {
        map[a.name.toLowerCase()] = a.icon;
      });
      setAgentIconMap(map);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!player || !player.name || player.name === player.agent) {
      setTrnStats(null);
      setTrnAgents([]);
      setMmrProfile(null);
      setIsPrivate(false);
      return;
    }

    let active = true;
    setIsLoading(true);
    setIsPrivate(false);

    const name = player.name;
    const tag = player.tag || '';

    // MMR (rank + RR) comes from the LOCAL client's session, so it is only
    // valid for the logged-in player — never fetch it for lobby opponents.
    const mmrJob = player.isMe
      ? fetchMmrDirect('eu', name, tag)
      : Promise.resolve(null);
    Promise.allSettled([
      fetchTrnActStats(name, tag, seasonId),
      fetchTrnAgents(name, tag, seasonId || ''),
      mmrJob,
    ]).then(([trnRes, agentsRes, mmrRes]) => {
      if (!active) return;
      if (trnRes.status === 'fulfilled') {
        setTrnStats(trnRes.value.stats);
      } else {
        setTrnStats(null);
        // Proven private (fresh 451 or registry) → lock panel, not spinner/error.
        if (isTrnPrivateError(trnRes.reason) || trnNegativeKind(name, tag) === 'private') {
          setIsPrivate(true);
        }
      }
      if (agentsRes.status === 'fulfilled') {
        setTrnAgents(agentsRes.value);
      } else {
        setTrnAgents([]);
      }
      if (mmrRes.status === 'fulfilled') {
        setMmrProfile(mmrRes.value);
      } else {
        setMmrProfile(null);
      }
      setIsLoading(false);
    });

    return () => {
      active = false;
    };
  }, [player, seasonId]);

  if (!player) return null;

  // Strict: RR + local rank belong to the logged-in player only (player.isMe
  // is set from puuid match at open time — never by name comparison).
  const isMe = player.isMe === true;
  const currentRank = player.rankName || (isMe ? mmrProfile?.rank : undefined) || 'Unranked';
  const currentRr = isMe ? mmrProfile?.rr ?? 0 : 0;
  const countryName = getCountryName(player.country);
  const trackerUrls = getTrackerUrls(player.name, player.tag);

  const handleCopyRiotId = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!player.name) return;
    const fullId = `${player.name}${player.tag ? '#' + player.tag : ''}`;
    navigator.clipboard.writeText(fullId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-5">
        {/* Blurred Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-black/80 backdrop-blur-md"
        />

        {/* Modal Container (Google Material 3) */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 10 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="relative w-full max-w-2xl rounded-3xl bg-m3-surface-container-low border border-m3-outline-subtle shadow-m3-3 overflow-hidden flex flex-col z-10 max-h-[90vh]"
        >
          {/* Header */}
          <div className="p-5 border-b border-m3-outline-subtle bg-m3-surface-container flex items-center justify-between gap-4">
            <div className="flex items-center gap-3.5 min-w-0">
              {/* Agent Avatar */}
              <div className="relative w-12 h-12 rounded-2xl overflow-hidden border border-m3-outline-subtle bg-m3-surface-container-highest shrink-0 shadow-xs">
                {player.agIcon ? (
                  <img src={player.agIcon} alt={player.agent} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-m3-surface-container-highest flex items-center justify-center font-display font-black text-sm text-m3-primary">
                    {player.agent.slice(0, 2)}
                  </div>
                )}
                <span
                  className={`absolute bottom-0 inset-x-0 h-1 ${
                    player.team === 'Blue' ? 'bg-m3-mint' : 'bg-m3-coral'
                  }`}
                />
              </div>

              {/* Name & Tag */}
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-display font-black text-lg text-m3-on-surface truncate">
                    {player.name}
                  </h3>
                  {player.tag && (
                    <span className="text-xs font-mono font-bold text-m3-outline">
                      #{player.tag}
                    </span>
                  )}
                  {player.name && (
                    <button
                      type="button"
                      onClick={handleCopyRiotId}
                      className="p-1 rounded-md hover:bg-white/10 text-m3-outline hover:text-white cursor-pointer transition-colors"
                      title={copied ? 'Copied!' : `Copy ${player.name}#${player.tag}`}
                    >
                      {copied ? <Check className="w-3.5 h-3.5 text-m3-mint" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  )}
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                      player.team === 'Blue'
                        ? 'bg-m3-mint-container/40 text-m3-mint border border-m3-mint/30'
                        : 'bg-m3-coral-container/40 text-m3-coral border border-m3-coral/30'
                    }`}
                  >
                    {player.team} Team
                  </span>
                </div>
                <div className="text-xs text-m3-outline mt-0.5 flex items-center gap-2 flex-wrap">
                  <span>Played {player.agent}</span>
                  {player.rankIcon && (
                    <span className="flex items-center gap-1 font-medium text-m3-on-surface-variant">
                      • <img src={player.rankIcon} alt="" className="w-3.5 h-3.5 object-contain inline" />
                      {currentRank} {currentRr > 0 ? `(${currentRr} RR)` : ''}
                    </span>
                  )}
                  {countryName && (
                    <span className="flex items-center gap-1 text-zinc-300 font-medium">
                      • {countryName}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              {player.name && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openExternalUrl(trackerUrls.trn)}
                    className="px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-white/5 hover:bg-[#b6abf7]/25 hover:text-[#b6abf7] border border-white/10 text-zinc-300 transition-colors cursor-pointer"
                    title="Open on Tracker.gg (TRN)"
                  >
                    TRN
                  </button>
                  <button
                    type="button"
                    onClick={() => openExternalUrl(trackerUrls.blitz)}
                    className="px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-white/5 hover:bg-red-500/25 hover:text-red-300 border border-white/10 text-zinc-300 transition-colors cursor-pointer"
                    title="Open on Blitz.gg"
                  >
                    Blitz
                  </button>
                </div>
              )}
              {onViewFullProfile && player.name && (
                <button
                  type="button"
                  onClick={() => {
                    onViewFullProfile(player.name, player.tag);
                    onClose();
                  }}
                  className="px-3.5 py-1.5 rounded-full bg-m3-primary text-m3-on-primary text-xs font-display font-bold flex items-center gap-1.5 shadow-xs hover:opacity-95 transition-opacity cursor-pointer"
                >
                  <span>View Matches</span>
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="w-8 h-8 rounded-full bg-m3-surface-container-high hover:bg-m3-surface-bright text-m3-outline hover:text-m3-on-surface flex items-center justify-center transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Body Content */}
          <div className="p-5 overflow-y-auto custom-scrollbar flex flex-col gap-4">
            {/* Match Performance Snapshot */}
            <div className="rounded-2xl bg-m3-surface-container-low border border-m3-outline-subtle p-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline mb-3 flex items-center justify-between">
                <span>Match Scoreboard Snapshot</span>
                <span className="text-m3-primary font-mono font-bold">TRS: {player.trs}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-center">
                <div className="p-2.5 rounded-xl bg-m3-surface-container border border-m3-outline-subtle/50">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">K / D / A</div>
                  <div className="font-display font-extrabold text-base text-m3-on-surface mt-0.5">
                    {player.kills} / {player.deaths} / {player.assists}
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-m3-surface-container border border-m3-outline-subtle/50">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">K/D Ratio</div>
                  <div className={`font-display font-extrabold text-base mt-0.5 ${player.kd >= 1 ? 'text-m3-mint' : 'text-m3-coral'}`}>
                    {player.kd.toFixed(2)}
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-m3-surface-container border border-m3-outline-subtle/50">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">ACS</div>
                  <div className="font-display font-extrabold text-base text-m3-on-surface mt-0.5">
                    {player.acs}
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-m3-surface-container border border-m3-outline-subtle/50">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">HS%</div>
                  <div className="font-display font-extrabold text-base text-m3-on-surface mt-0.5">
                    {player.hsPct.toFixed(1)}%
                  </div>
                </div>
              </div>
            </div>

            {/* Act-Wide TRN Overview */}
            {isLoading ? (
              <div className="p-8 rounded-2xl bg-m3-surface-container-low border border-m3-outline-subtle text-center text-xs text-m3-outline">
                <div className="w-6 h-6 border-2 border-m3-primary border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                <span>Fetching act statistics for {player.name}...</span>
              </div>
            ) : trnStats ? (
              <div className="rounded-2xl bg-m3-surface-container-low border border-m3-outline-subtle p-4 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">
                      Act-Wide Competitive Stats
                    </div>
                    <div className="font-display font-black text-base text-m3-on-surface mt-0.5">
                      {trnStats.wins}W - {trnStats.losses}L ({trnStats.winPct.toFixed(1)}% Win Rate)
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <ScoreBadge tier={scoreTier(trnStats.trnScore).tier} size={36} />
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">
                        Tracker Score
                      </div>
                      <div className="font-display font-extrabold text-sm text-m3-on-surface">
                        {trnStats.trnScore} / 1,000
                      </div>
                    </div>
                  </div>
                </div>

                {/* Metric Strip */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs font-mono">
                  <div className="p-2 rounded-xl bg-m3-surface-container border border-m3-outline-subtle/40">
                    <div className="text-[10px] text-m3-outline uppercase font-semibold">Damage/Round</div>
                    <div className="font-bold text-sm text-m3-on-surface mt-0.5">{trnStats.adr.toFixed(1)}</div>
                  </div>
                  <div className="p-2 rounded-xl bg-m3-surface-container border border-m3-outline-subtle/40">
                    <div className="text-[10px] text-m3-outline uppercase font-semibold">K/D Ratio</div>
                    <div className={`font-bold text-sm mt-0.5 ${trnStats.kd >= 1 ? 'text-m3-mint' : 'text-m3-coral'}`}>
                      {trnStats.kd.toFixed(2)}
                    </div>
                  </div>
                  <div className="p-2 rounded-xl bg-m3-surface-container border border-m3-outline-subtle/40">
                    <div className="text-[10px] text-m3-outline uppercase font-semibold">Headshot %</div>
                    <div className="font-bold text-sm text-m3-on-surface mt-0.5">{trnStats.hsPct.toFixed(1)}%</div>
                  </div>
                  <div className="p-2 rounded-xl bg-m3-surface-container border border-m3-outline-subtle/40">
                    <div className="text-[10px] text-m3-outline uppercase font-semibold">KAST</div>
                    <div className="font-bold text-sm text-m3-on-surface mt-0.5">{trnStats.kast.toFixed(1)}%</div>
                  </div>
                </div>

                {/* Top Agents Played */}
                {trnAgents.length > 0 && (
                  <div className="pt-2 border-t border-m3-outline-subtle/40 flex flex-col gap-2">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline flex items-center justify-between">
                      <span>Top Agents This Act</span>
                      <span className="text-[10px] font-mono text-m3-outline">{trnAgents.length} Agents</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {trnAgents.slice(0, 3).map((ag) => {
                        const icon = agentIconMap[ag.agent.toLowerCase()];
                        return (
                          <div
                            key={ag.agent}
                            className="p-2 rounded-xl bg-m3-surface-container border border-m3-outline-subtle/50 flex items-center gap-2"
                          >
                            {icon ? (
                              <img src={icon} alt={ag.agent} className="w-8 h-8 rounded-lg object-cover border border-m3-outline-subtle shrink-0" />
                            ) : (
                              <div className="w-8 h-8 rounded-lg bg-m3-surface-container-highest flex items-center justify-center font-bold text-xs shrink-0">
                                {ag.agent.slice(0, 2)}
                              </div>
                            )}
                            <div className="min-w-0 flex-1 leading-tight">
                              <span className="block font-bold text-xs text-m3-on-surface truncate">
                                {ag.agent}
                              </span>
                              <div className="flex items-center gap-1.5 text-[10px] font-mono mt-0.5">
                                <span className={ag.winPct >= 50 ? 'text-m3-mint font-bold' : 'text-m3-coral font-bold'}>
                                  {ag.winPct.toFixed(0)}% WR
                                </span>
                                <span className="text-m3-outline">•</span>
                                <span className="text-m3-outline">{ag.kd.toFixed(2)} KD</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : isPrivate ? (
              <div className="p-6 rounded-2xl bg-m3-surface-container-low border border-m3-outline-subtle text-center text-xs text-m3-outline flex flex-col items-center gap-2">
                <Lock className="w-5 h-5 text-zinc-400" />
                <span title={TRN_PRIVATE_TOOLTIP}>Private tracker profile — sign in on tracker.gg to make it public.</span>
              </div>
            ) : (
              <div className="p-6 rounded-2xl bg-m3-surface-container-low border border-m3-outline-subtle text-center text-xs text-m3-outline">
                Act profile is private or unavailable on TRN for this player.
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
