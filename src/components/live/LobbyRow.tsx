import React from 'react';
import { EyeOff, Lock } from 'lucide-react';
import type { LiveMatchPlayer } from '../../types';
import { trnPlayerState } from '../../utils/trn';
import { peekLivePlayerStatsAsOf } from '../../live/playerStats';
import { formatKd, formatPct } from '../../utils/format';
import { shortAct } from '../Overview';

/** One lobby row: player, rank, peak, party, level, Tracker · act.
 *
 *  Six columns, 36px, hairline separator, no card. Every cell is optional and
 *  absent when its source is absent — never a dash, never a zero. */
export interface LobbyRowProps {
  player: LiveMatchPlayer;
  partyCount: number;
  tierIcons: Record<number, string>;
  seasonNames: Record<string, string>;
  now: number;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

const ageLabel = (asOf: number, now: number): string => {
  const d = now - asOf;
  if (d < 3_600_000) return `${Math.max(1, Math.round(d / 60_000))}m`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`;
  return `${Math.round(d / 86_400_000)}d`;
};

/** The four honest Tracker states. `null` means "say nothing yet". */
export function trackerCell(
  p: LiveMatchPlayer,
  now: number
): { text: string; muted: boolean } | null {
  // A transient read is not a state word.
  if (p.trnState === 'pending') return null;
  const state = trnPlayerState(p.name, p.tag);
  if (state === 'fetching') return null;

  if (p.isTrnPrivate || state === 'private') return { text: 'private', muted: true };
  if (state === 'missing') return { text: 'no profile', muted: true };

  const asOf = peekLivePlayerStatsAsOf(p.puuid);
  // Values we cannot age are not shown at all: "not cached" is the honest word.
  if (!asOf || now - asOf > WEEK_MS) return { text: 'not cached', muted: true };

  const parts: string[] = [];
  const kd = Number(p.kd);
  if (Number.isFinite(kd) && kd > 0) parts.push(`${formatKd(kd)} K/D`);
  if (typeof p.hsPct === 'number' && p.hsPct > 0) parts.push(`${formatPct(p.hsPct, 0)} HS`);
  /* A fresh timestamp with no values is not a fifth state: an age on its own
   * tells the reader nothing about the player. "not cached" is the honest word
   * even though we know *when* the empty cache was written. */
  if (parts.length === 0) return { text: 'not cached', muted: true };
  parts.push(ageLabel(asOf, now));
  return { text: parts.join(' · '), muted: false };
}

export const LobbyRow: React.FC<LobbyRowProps> = ({ player, partyCount, tierIcons, seasonNames, now }) => {
  const tracker = trackerCell(player, now);
  const peakAct = player.peakSeasonId
    ? seasonNames[player.peakSeasonId.toLowerCase()] ?? shortAct(player.peakSeasonId)
    : '';

  return (
    <div className="grid grid-cols-[minmax(0,1.7fr)_120px_120px_56px_52px_minmax(0,1.5fr)] items-center gap-3 py-1.5 border-b border-m3-outline-subtle/50">
      {/* Player */}
      <span className="flex items-center gap-2 min-w-0">
        {player.agentIcon && (
          <img src={player.agentIcon} alt={player.agentName} className="w-6 h-6 object-contain shrink-0" />
        )}
        <span className="text-xs text-m3-on-surface truncate">
          {player.name}
          {player.tag ? <span className="text-m3-outline">#{player.tag}</span> : null}
        </span>
        {player.isMe && (
          <span className="text-micro font-mono uppercase tracking-wider text-m3-primary shrink-0">You</span>
        )}
        {player.isIncognito && <EyeOff className="w-3 h-3 text-m3-outline shrink-0" aria-hidden="true" />}
      </span>

      {/* Rank */}
      <span className="flex items-center gap-1.5 min-w-0">
        {player.isRankHidden ? (
          <span className="flex items-center gap-1 text-micro font-mono text-m3-outline">
            <Lock className="w-3 h-3" aria-hidden="true" /> Rank hidden
          </span>
        ) : player.rank ? (
          <>
            {tierIcons[player.tier] && (
              <img src={tierIcons[player.tier]} alt="" className="w-[18px] h-[18px] object-contain shrink-0" />
            )}
            <span className="text-micro text-m3-on-surface truncate">{player.rank}</span>
            {player.tier > 2 && player.rr > 0 && (
              <span className="text-micro font-mono text-m3-outline tabular-nums">{player.rr}</span>
            )}
          </>
        ) : null}
      </span>

      {/* Peak */}
      <span className="flex items-center gap-1.5 min-w-0">
        {player.peakTier > 0 && (
          <>
            {tierIcons[player.peakTier] && (
              <img src={tierIcons[player.peakTier]} alt="" className="w-4 h-4 object-contain shrink-0" />
            )}
            <span className="text-micro text-m3-outline truncate">{player.peakRank}</span>
            {peakAct && <span className="text-micro font-mono text-m3-outline/70">{peakAct}</span>}
          </>
        )}
      </span>

      {/* Party */}
      <span className="text-micro font-mono text-m3-outline">
        {partyCount > 1 ? `[×${partyCount}]` : ''}
      </span>

      {/* Level */}
      <span className="text-micro font-mono text-m3-outline tabular-nums">
        {player.accountLevel > 0 ? `Lv ${player.accountLevel}` : ''}
      </span>

      {/* Tracker · act */}
      <span
        className={`text-micro font-mono truncate ${
          tracker?.muted ? 'text-m3-outline' : 'text-m3-on-surface-variant'
        }`}
      >
        {tracker?.text ?? ''}
      </span>
    </div>
  );
};
