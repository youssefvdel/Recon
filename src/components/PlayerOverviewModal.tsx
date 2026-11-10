import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Copy, Check } from 'lucide-react';
import { actStateFor, fetchLocalActStats, fetchMmrDirect } from '../utils/tracker';
import type { ActAggregate } from '../utils/actStats';
import { getCountryName, getTrackerUrls } from '../utils/playerDisplay';
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
  kast?: number;
  fk: number;
  fd: number;
  mk: number;
  trs: number;
  /** True when TRS came from calculateTrsFallback, not tracker.gg. */
  trsEstimated?: boolean;
}

interface Props {
  player: SelectedPlayerInfo | null;
  seasonId?: string;
  onClose: () => void;
  onViewFullProfile?: (name: string, tag: string) => void;
}

/** Difficulty of the local act read, named so the copy can be exact. */
type ActFail = ReturnType<typeof actStateFor> | '';

/* Player detail modal, opened explicitly from the scoreboard.
 *
 * Data path (2026-11): the act numbers come from the LOCAL Riot client, not
 * tracker.gg (Warden captcha killed that source). The explicit open is the one
 * place allowed to scan a full act during a live game — hence allowAct: true;
 * no automatic caller may copy that option.
 *
 * Honesty: ActAggregate only carries games / K/D / ACS / win%. ADR, HS%,
 * KAST, Tracker Score and per-agent splits are NOT computed from local data,
 * so this modal does not render them at all — it does not print guesses. */
export const PlayerOverviewModal: React.FC<Props> = ({
  player,
  onClose,
  onViewFullProfile,
}) => {
  const [act, setAct] = useState<ActAggregate | null>(null);
  const [mmrProfile, setMmrProfile] = useState<TrackerProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [failKind, setFailKind] = useState<ActFail>('');
  const [copied, setCopied] = useState(false);

  const puuid = player?.puuid ?? '';
  const name = player?.name ?? '';
  const tag = player?.tag ?? '';
  const isMe = player?.isMe === true;

  useEffect(() => {
    if (!puuid) {
      setAct(null);
      setMmrProfile(null);
      setFailKind('');
      return;
    }
    let active = true;
    setIsLoading(true);
    setFailKind('');
    void (async () => {
      const [mmrRes, actRes] = await Promise.allSettled([
        // Rank + RR belong to the logged-in player only; lobby opponents
        // already carry their rank on the row.
        isMe ? fetchMmrDirect('eu', name, tag) : Promise.resolve(null),
        fetchLocalActStats(
          { puuid, region: 'eu', queue: 'competitive' },
          { allowAct: true }
        ),
      ]);
      if (!active) return;
      setMmrProfile(mmrRes.status === 'fulfilled' ? mmrRes.value : null);
      if (actRes.status === 'fulfilled') {
        setAct(actRes.value);
        setFailKind('');
      } else {
        setAct(null);
        setFailKind(
          actStateFor(String(actRes.reason instanceof Error ? actRes.reason.message : actRes.reason))
        );
      }
      setIsLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [puuid, name, tag, isMe]);

  /* A drawer, not a dialog: labelled region, no Tab trap, no focus return. */
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  /* No Escape listener here: the hosting MatchDetailBody owns one handler and
   * closes this drawer before the row, so a single keypress does one thing. */


  if (!player) return null;

  // Strict: RR + local rank belong to the logged-in player only (player.isMe
  // is set from puuid match at open time — never by name comparison).
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

  const failReason =
    failKind === 'too-long'
      ? 'This act has more games than one local scan can cover — act numbers are hidden rather than shown from a partial window.'
      : failKind === 'timeout'
        ? 'The local Riot client took too long to answer — reopen this player in a moment.'
        : failKind === 'incomplete'
          ? 'This act could not be read completely, so no act numbers are shown.'
          : 'Could not read this player\'s act stats from the local Riot client.';

  return (
    <AnimatePresence>
      /* A right-side drawer, not a dialog: no backdrop, no aria-modal, no focus
       * trap. It slides in beside the ledger, scrolls on its own, and Escape
       * (handled by the host) closes it before the row. */
      <div className="fixed inset-y-0 right-0 z-[60] flex pointer-events-none">
        <motion.div
          ref={dialogRef}
          role="region"
          aria-labelledby={titleId}
          tabIndex={-1}
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="pointer-events-auto w-[min(440px,92vw)] h-full bg-m3-surface-container-low border-l border-m3-outline-subtle shadow-m3-2 overflow-y-auto flex flex-col focus:outline-none"
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
                  <h3 id={titleId} className="font-display font-black text-lg text-m3-on-surface truncate">
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
                      data-tip={copied ? 'Copied!' : `Copy ${player.name}#${player.tag}`}
                      aria-label={copied ? 'Riot ID copied' : `Copy ${player.name}#${player.tag}`}
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
                    data-tip="Open this player's external Tracker.gg page"
                  >
                    TRN
                  </button>
                  <button
                    type="button"
                    onClick={() => openExternalUrl(trackerUrls.blitz)}
                    className="px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-white/5 hover:bg-red-500/25 hover:text-red-300 border border-white/10 text-zinc-300 transition-colors cursor-pointer"
                    data-tip="Open on Blitz.gg"
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
                aria-label="Close player overview"
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
                {player.trs > 0 && (
                  <span className="text-m3-primary font-mono font-bold">
                    TRS: {player.trs}
                    {player.trsEstimated ? ' (est.)' : ''}
                  </span>
                )}
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

            {/* This Act — read from the local Riot client */}
            {isLoading ? (
              <div className="p-8 rounded-2xl bg-m3-surface-container-low border border-m3-outline-subtle text-center text-xs text-m3-outline">
                <div className="w-6 h-6 border-2 border-m3-primary border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                <span>Reading this act from the local Riot client…</span>
              </div>
            ) : act ? (
              <div className="rounded-2xl bg-m3-surface-container-low border border-m3-outline-subtle p-4 flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline">
                      This Act — Local Riot Client
                    </div>
                    <div className="font-display font-black text-base text-m3-on-surface mt-0.5">
                      {act.games} {act.games === 1 ? 'game' : 'games'}
                      {act.winPct != null ? ` · ${act.winPct.toFixed(0)}% Win Rate` : ''}
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-m3-outline text-right">
                    current act only
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center text-xs font-mono">
                  <div className="p-2 rounded-xl bg-m3-surface-container border border-m3-outline-subtle/40">
                    <div className="text-[10px] text-m3-outline uppercase font-semibold">K/D Ratio</div>
                    <div className={`font-bold text-sm mt-0.5 ${act.kd != null && act.kd >= 1 ? 'text-m3-mint' : act.kd != null ? 'text-m3-coral' : 'text-m3-outline'}`}>
                      {act.kd != null ? act.kd.toFixed(2) : '—'}
                    </div>
                  </div>
                  <div className="p-2 rounded-xl bg-m3-surface-container border border-m3-outline-subtle/40">
                    <div className="text-[10px] text-m3-outline uppercase font-semibold">ACS</div>
                    <div className="font-bold text-sm text-m3-on-surface mt-0.5">
                      {act.acs != null ? act.acs.toFixed(1) : '—'}
                    </div>
                  </div>
                  <div className="p-2 rounded-xl bg-m3-surface-container border border-m3-outline-subtle/40">
                    <div className="text-[10px] text-m3-outline uppercase font-semibold">Win Rate</div>
                    <div className="font-bold text-sm text-m3-on-surface mt-0.5">
                      {act.winPct != null ? `${act.winPct.toFixed(0)}%` : '—'}
                    </div>
                  </div>
                </div>

                <p className="text-[10px] text-m3-outline leading-snug">
                  Computed only from matches your local Riot client could read for this act. A value it
                  could not prove stays <span className="font-mono">—</span> — never filled with a guess.
                  Headshot %, KAST and Tracker Score are not in the local payload, so they are not shown.
                </p>
              </div>
            ) : (
              <div className="p-6 rounded-2xl bg-m3-surface-container-low border border-m3-outline-subtle text-center text-xs text-m3-outline">
                {failReason}
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
