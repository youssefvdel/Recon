import React, { useEffect, useState } from 'react';
import type { LiveMatchState, LiveMatchPlayer } from '../../types';

export interface PreRoundPanelProps {
  isEditMode: boolean;
  matchState: LiveMatchState | null;
  /** The local player's row, when resolved. Absent is normal, not an error. */
  you: LiveMatchPlayer | null;
  yourTeam: LiveMatchPlayer[];
  enemyTeam: LiveMatchPlayer[];
  tierIcons: Record<number, string>;
}

/** How long the plate may hold the screen after a match update. Long enough to
 *  read at agent select or a round start, short enough that it never becomes a
 *  permanent HUD element. Edit mode always shows it. */
const PREROUND_HOLD_MS = 15_000;

type Moment = 'agent-select' | 'round-start';

/** Which moment this is, and which focal segments the payload can honestly
 *  support.
 *
 *  It carries `phase`, `mapName`, `startingSide`, `allyScore`, `enemyScore` —
 *  and nothing else. There is no round number and no live side after a swap, so
 *  those are simply not rendered. A guess wearing the costume of data is the
 *  same bug class as the raw hostname. */
function preRoundMoment(state: LiveMatchState | null): {
  moment: Moment;
  showScore: boolean;
  showSide: boolean;
  side: 'Attack' | 'Defense' | null;
} {
  const empty = { showScore: false, showSide: false, side: null as null };
  if (!state || state.phase === 'idle') return { moment: 'agent-select', ...empty };
  if (state.phase === 'pregame') return { moment: 'agent-select', ...empty };

  const hasScore = typeof state.allyScore === 'number' && typeof state.enemyScore === 'number';
  const sum = hasScore ? (state.allyScore as number) + (state.enemyScore as number) : -1;
  // startingSide is the side we STARTED on. It is only the CURRENT side at 0-0.
  const sideKnown = Boolean(state.startingSide) && sum === 0;
  return {
    moment: 'round-start',
    showScore: hasScore,
    showSide: sideKnown,
    side: sideKnown ? (state.startingSide as 'Attack' | 'Defense') : null,
  };
}

const Crest: React.FC<{ tier: number; tierIcons: Record<number, string> }> = ({ tier, tierIcons }) =>
  tierIcons[tier] ? (
    <img
      src={tierIcons[tier]}
      alt=""
      className="w-3.5 h-3.5 object-contain absolute -bottom-0.5 -right-0.5"
    />
  ) : null;

/** One team strip: five agent portraits, rank crests overlapping. Names stay out
 *  on purpose — icons and crests are the glance, the name lives in the pick chip. */
const TeamStrip: React.FC<{
  label: string;
  labelClass: string;
  players: LiveMatchPlayer[];
  tierIcons: Record<number, string>;
}> = ({ label, labelClass, players, tierIcons }) => {
  if (players.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className={`text-[9px] font-mono uppercase tracking-[0.14em] ${labelClass}`}>{label}</span>
      <div className="flex items-center gap-1.5">
        {players.slice(0, 5).map((p) => (
          <div key={p.puuid} className="relative w-6 h-6 shrink-0">
            {p.agentIcon ? (
              <img src={p.agentIcon} alt={p.agentName} className="w-6 h-6 object-contain" />
            ) : null}
            <Crest tier={p.tier} tierIcons={tierIcons} />
          </div>
        ))}
      </div>
    </div>
  );
};

export const PreRoundPanel: React.FC<PreRoundPanelProps> = ({
  isEditMode,
  matchState,
  you,
  yourTeam,
  enemyTeam,
  tierIcons,
}) => {
  const phase = matchState?.phase ?? 'idle';
  const [holdUntil, setHoldUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  /* Re-arm the hold on a new match, a new phase or a score change: the panel
   * appears at the moments that matter and then gets out of the way.
   * The setter is the point of the effect — this is a hold deadline, not
   * derived state — so the lint rule that forbids setState in an effect is
   * silenced here with the project's inline idiom. */
  useEffect(() => {
    if (phase === 'idle') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHoldUntil(Date.now() + PREROUND_HOLD_MS);
  }, [phase, matchState?.matchId, matchState?.allyScore, matchState?.enemyScore]);

  const holding = isEditMode || now < holdUntil;
  useEffect(() => {
    if (!holding || isEditMode) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [holding, isEditMode]);

  if (!matchState || phase === 'idle') return null;
  if (!holding) return null;

  const { moment, showScore, showSide, side } = preRoundMoment(matchState);
  const isSelect = moment === 'agent-select';
  const mapName = matchState.mapName?.trim() ?? '';

  return (
    <div
      className={`flex flex-col gap-1.5 w-[340px] rounded-2xl border p-2.5 select-none pointer-events-none bg-m3-surface-container/85 border-m3-outline-subtle/70 shadow-m3-1 ${
        isEditMode ? 'border-m3-primary/45 ring-1 ring-m3-primary/40' : ''
      }`}
    >
      {/* Eyebrow: phase chip, your pick. Nothing above 15px in this widget. */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span className="text-[9px] font-mono font-bold uppercase tracking-[0.14em] px-1.5 py-0.5 rounded border bg-m3-primary/25 text-m3-primary border-m3-primary/30 whitespace-nowrap">
          {isSelect ? 'AGENT SELECT' : 'ROUND START'}
        </span>
        {you?.agentIcon && (
          <span className="flex items-center gap-1 min-w-0 px-1.5 py-0.5 rounded border bg-m3-primary/15 border-m3-primary/30">
            <img src={you.agentIcon} alt={you.agentName} className="w-5 h-5 object-contain shrink-0" />
            <span className="text-[10px] font-semibold text-m3-on-surface truncate">
              {you.agentName}
            </span>
          </span>
        )}
      </div>

      {/* Focal line: exactly one line, fixed height, segments omitted when the
          payload cannot support them. */}
      <div className="flex items-baseline gap-1.5 min-w-0 text-[15px] leading-none font-display font-black tracking-wide">
        {mapName && <span className="truncate min-w-0 text-m3-on-surface">{mapName}</span>}
        {mapName && (showScore || showSide) && <span className="text-m3-outline/60">·</span>}
        {showScore && (
          <span className="font-mono tabular-nums whitespace-nowrap">
            <span className="text-m3-on-surface">{matchState.allyScore}</span>
            <span className="text-m3-on-surface-variant">–</span>
            <span className="text-m3-on-surface-variant">{matchState.enemyScore}</span>
          </span>
        )}
        {showScore && showSide && <span className="text-m3-outline/60">·</span>}
        {showSide && side && (
          <span
            className={`text-[11px] font-mono font-bold uppercase tracking-wider ${
              side === 'Defense' ? 'text-m3-mint' : 'text-m3-coral'
            }`}
          >
            {side === 'Defense' ? 'DEF' : 'ATK'}
          </span>
        )}
      </div>

      <TeamStrip
        label="YOUR TEAM"
        labelClass="text-m3-primary/80"
        players={yourTeam}
        tierIcons={tierIcons}
      />
      <TeamStrip
        label="ENEMY"
        labelClass="text-m3-coral/80"
        players={enemyTeam}
        tierIcons={tierIcons}
      />
    </div>
  );
};
