import React from 'react';
import type { LiveMatchState } from '../../types';

/** The 44px live strip: state, map, queue, score, moment, players, server.
 *
 *  Every slot is optional and disappears when the payload has nothing to say —
 *  the same rule as the rest of the B surfaces. Moment rules are duplicated
 *  from the HUD rather than imported (this step keeps `components/hud/` out of
 *  the diff); step 9 may converge them. */
export interface LiveStripProps {
  state: LiveMatchState;
  queueLabel?: string;
}

const scoreOf = (s: LiveMatchState): string | null =>
  typeof s.allyScore === 'number' && typeof s.enemyScore === 'number'
    ? `${s.allyScore}–${s.enemyScore}`
    : null;

const momentOf = (s: LiveMatchState): string | null => {
  if (s.isPreviousMatch) return 'Last match';
  if (s.phase === 'pregame') return 'Agent select';
  if (s.phase === 'coregame') return 'Live';
  return null;
};

export const LiveStrip: React.FC<LiveStripProps> = ({ state, queueLabel }) => {
  const players = (state.blueTeam?.length ?? 0) + (state.redTeam?.length ?? 0);
  const score = scoreOf(state);
  const moment = momentOf(state);
  const previous = Boolean(state.isPreviousMatch);

  return (
    <div className="sticky top-0 z-20 -mx-6 px-6 h-11 flex items-center gap-4 bg-m3-bg border-b border-m3-outline-subtle">
      <span className="flex items-center gap-1.5 text-micro font-mono font-bold uppercase tracking-[0.14em]">
        <span
          aria-hidden="true"
          className={`w-1.5 h-1.5 rounded-full ${previous ? 'bg-amber-400' : 'bg-m3-primary'}`}
        />
        <span className={previous ? 'text-amber-400' : 'text-m3-primary'}>
          {previous ? 'Previous match' : 'Live'}
        </span>
      </span>

      {state.mapName && (
        <span className="font-display text-base font-bold text-m3-on-surface truncate">{state.mapName}</span>
      )}
      {queueLabel && (
        <span className="text-micro font-mono text-m3-outline uppercase tracking-wider">{queueLabel}</span>
      )}
      {score && (
        <span className="font-mono text-base tabular-nums text-m3-on-surface whitespace-nowrap">{score}</span>
      )}
      {moment && (
        <span className="text-micro font-mono text-m3-outline uppercase tracking-wider">{moment}</span>
      )}

      <span className="ml-auto flex items-center gap-4 text-micro font-mono text-m3-outline">
        {players > 0 && <span className="tabular-nums">{players} players</span>}
        {state.serverName && <span className="truncate">{state.serverName}</span>}
      </span>
    </div>
  );
};
