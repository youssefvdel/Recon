import React from 'react';
import { Lock as LockIcon, Shield, Swords } from 'lucide-react';
import type { LiveMatchState, LiveMatchPlayer } from '../../types';
import { ServerChip } from '../ServerChip';
import { VerticalSquadColumn } from './TeamBoard';

export interface MatchPanelProps {
  isEditMode: boolean;
  matchState: LiveMatchState | null;
  showStartingSide?: boolean;
  liveBlue: LiveMatchPlayer[];
  yourTeam: LiveMatchPlayer[];
  enemyTeam: LiveMatchPlayer[];
  tierIcons: Record<number, string>;
}

/* Match-status plate: header, column titles and team stacks moved verbatim
 * from OverlayView (split 7/8). Drag chrome stays in the canvas.
 *
 * No backdrop-filter on any HUD plate: this is a DirectComposition surface
 * over a live game and AGENTS.md bans CSS backdrop blur. Legibility comes
 * from the 0.85 plate, not from re-blurring the game every frame. */

export const MatchPanel: React.FC<MatchPanelProps> = ({
  isEditMode,
  matchState,
  showStartingSide,
  liveBlue,
  yourTeam,
  enemyTeam,
  tierIcons,
}) => (
<div
  className={`rounded-2xl border p-2.5 shadow-2xl flex flex-col gap-2 transition-all ${
    isEditMode
      ? 'bg-m3-surface-container/[0.85] border-m3-outline-variant/50 shadow-[0_12px_40px_rgba(0,0,0,0.85)] ring-1 ring-m3-outline-variant/30'
      : 'bg-m3-surface-container/[0.85] border-m3-outline-variant/50 shadow-2xl'
  }`}
>
  {/* Header: Map • Mode • Phase + live game status */}
  <div className="flex items-center justify-between px-1 gap-1.5">
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-xs font-display font-black text-m3-on-surface truncate min-w-0">
        {matchState?.mapName || 'Live Match Status'}
      </span>
      {matchState?.mode && (
        <span className="text-[10px] font-mono text-m3-on-surface-variant truncate">
          • {matchState.mode}
        </span>
      )}
    </div>
    <div className="flex items-center gap-1.5 shrink-0">
      {/* Side we start on — only Riot tells us this before the game */}
      {showStartingSide && matchState?.startingSide && !matchState?.isDeathmatch && (
        <span
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-extrabold uppercase border ${
            matchState.startingSide === 'Defense'
              ? 'bg-m3-mint/15 text-m3-mint border-m3-mint/30'
              : 'bg-m3-coral/15 text-m3-coral border-m3-coral/30'
          }`}
          data-tip={`Starting side: ${matchState.startingSide}`}
        >
          {matchState.startingSide === 'Defense' ? (
            <Shield className="w-2.5 h-2.5" />
          ) : (
            <Swords className="w-2.5 h-2.5" />
          )}
          {matchState.startingSide === 'Defense' ? 'DEF' : 'ATK'}
        </span>
      )}
      <span className="px-1.5 py-0.5 rounded bg-m3-primary/25 text-m3-primary text-[9px] font-mono font-extrabold uppercase shrink-0">
        {matchState?.phase === 'coregame' ? 'LIVE' : matchState?.phase === 'pregame' ? 'SELECT' : 'PREVIEW'}
      </span>
      {/* Match server — hides when Riot reports none (menus / no match) */}
      <ServerChip serverName={matchState?.serverName} />
    </div>
  </div>

  {/* Column Titles */}
  <div className="grid grid-cols-[18px_22px_26px_24px_minmax(32px,1fr)_minmax(30px,1fr)_minmax(32px,1fr)_minmax(32px,1fr)] items-center gap-x-1.5 px-2 text-[8.5px] font-mono text-m3-on-surface-variant uppercase tracking-wider border-b border-m3-outline-subtle/55 pb-1 shrink-0 whitespace-nowrap">
    <span className="text-center" data-tip="Tracker Score tier">TS</span>
    <span className="text-center" data-tip="Agent">Agent</span>
    <span className="text-center">Rank</span>
    <span className="text-center">Peak</span>
    <span className="text-right" data-tip="Act-wide average combat score — the column this board is sorted by">ACS</span>
    <span className="text-right">K/D</span>
    <span className="text-right" data-tip="Act-wide win rate">Win%</span>
    <span className="text-right" data-tip="Act-wide headshot %">HS%</span>
  </div>

  {/* Vertical Compact Teams / Player Stack */}
  <div className="flex flex-col gap-2">
    {matchState?.isDeathmatch ? (
      /* FFA / Deathmatch — Single unified leaderboard, NOT grouped by teams or groups */
      <VerticalSquadColumn
        title="Deathmatch"
        tagColor="text-m3-gold"
        players={liveBlue}
        tierIcons={tierIcons}
      />
    ) : (
      /* Standard Match Stack — Your Team vs Enemy Team */
      <>
        <VerticalSquadColumn
          title="Your Team"
          tagColor="text-m3-primary"
          players={yourTeam}
          tierIcons={tierIcons}
        />
        {enemyTeam.length > 0 ? (
          <VerticalSquadColumn
            title="Enemy Team"
            tagColor="text-rose-400"
            players={enemyTeam}
            tierIcons={tierIcons}
          />
        ) : matchState?.phase === 'coregame' ? (
          <div className="rounded-xl bg-m3-surface-container/[0.60] border border-m3-outline-subtle/55 p-2 flex items-center justify-center gap-2 text-center">
            <LockIcon className="w-3.5 h-3.5 text-m3-on-surface-variant" />
            <span className="text-[10px] font-semibold text-m3-on-surface-variant">Enemy Team Hidden</span>
            <span className="text-[9px] text-m3-outline">• Visible on match start</span>
          </div>
        ) : null}
      </>
    )}
  </div>
</div>
);

