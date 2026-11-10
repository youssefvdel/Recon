import React from 'react';
import { Shield, Swords } from 'lucide-react';
import type { LiveMatchState, LiveMatchPlayer } from '../../types';
import { ServerChip } from '../ServerChip';
import { queueLabel } from '../../utils/playerDisplay';
import { PregameTeamColumn } from './TeamBoard';

export interface PregamePanelProps {
  isEditMode: boolean;
  matchState: LiveMatchState | null;
  isPregame: boolean;
  showStartingSide?: boolean;
  yourTeam: LiveMatchPlayer[];
  tierIcons: Record<number, string>;
  seasonNames: Record<string, string>;
}

/* Agent-select plate: header + your-team scouting column. Moved verbatim from
 * OverlayView (split 5/8); drag chrome stays in the canvas. */

export const PregamePanel: React.FC<PregamePanelProps> = ({
  isEditMode,
  matchState,
  isPregame,
  showStartingSide,
  yourTeam,
  tierIcons,
  seasonNames,
}) => (
<div
  className={`rounded-2xl border p-3 shadow-2xl flex flex-col gap-2 transition-all ${
    isEditMode
      ? 'bg-m3-surface-container/[0.85] border-m3-outline-variant/50 shadow-[0_16px_50px_rgba(0,0,0,0.9)] ring-1 ring-m3-outline-variant/30'
      : 'bg-m3-surface-container/[0.85] border-m3-outline-variant/50 shadow-2xl'
  }`}
>
  {/* Header: Map • Starting Side Badge */}
  <div className="flex items-center justify-between px-1">
    <div className="flex items-center gap-2 min-w-0">
      <span className="w-2 h-2 rounded-full bg-m3-primary" />
      <span className="font-display font-black text-m3-on-surface text-xs tracking-wider uppercase">
        {matchState?.mapName || 'Ascent'} • Team Scout
      </span>
      {/* Precise queue when Riot tells us (Competitive vs Unrated share
          a ModeID, so `mode` alone can't distinguish them). */}
      {(queueLabel(matchState?.queueId) || matchState?.mode) && (
        <span
          className="text-[10px] font-mono text-m3-on-surface-variant truncate"
          data-tip={matchState?.queueId ? `Queue: ${matchState.queueId}` : undefined}
        >
          • {queueLabel(matchState?.queueId) || matchState?.mode}
        </span>
      )}
    </div>
    <div className="flex items-center gap-2">
      {/* Match server — hides when Riot reports none (menus / no match) */}
      <ServerChip serverName={matchState?.serverName} />
      {showStartingSide && matchState?.startingSide && (
        <span
          className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-mono font-extrabold uppercase shrink-0 border bg-m3-surface-container-high/60 text-m3-on-surface-variant border-m3-outline-subtle/55"
        >
          {matchState.startingSide === 'Defense' ? (
            <>
              <Shield className="w-3 h-3 text-m3-on-surface-variant" />
              <span>Starting Defense</span>
            </>
          ) : (
            <>
              <Swords className="w-3 h-3 text-m3-on-surface-variant" />
              <span>Starting Attack</span>
            </>
          )}
        </span>
      )}
      <span className="px-2 py-0.5 rounded-full bg-m3-surface-container-high/60 border border-m3-outline-subtle/55 text-m3-on-surface-variant text-[9px] font-mono font-bold uppercase shrink-0">
        {isPregame ? 'Agent Select' : 'Preview'}
      </span>
    </div>
  </div>

  <PregameTeamColumn
    title="Your Team"
    tagColor="text-m3-primary"
    players={yourTeam}
    tierIcons={tierIcons}
    seasons={seasonNames}
    queueId={matchState?.queueId}
  />
</div>
);

