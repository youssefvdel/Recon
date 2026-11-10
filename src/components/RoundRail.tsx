import React, { useCallback, useRef } from 'react';
import { Bomb, Wrench } from 'lucide-react';
import type { MatchRoundDetail } from '../types';

/* The one round selector. Hoisted out of RoundTimeline so it can stay pinned
 * above the round content while kills and economy scroll beneath it — a rail
 * that scrolls away from the round you are reading is worse than no rail.
 *
 * Selection is STATE, not markup: this component only reports which round was
 * chosen. RoundTimeline renders the detail and economy panes from that value,
 * so a click here visibly changes both. */

export interface RoundRailProps {
  rounds: MatchRoundDetail[];
  selectedRound: number | null;
  onSelect: (roundNum: number) => void;
}

const displayRound = (roundNum: number): number => roundNum + 1;

const TONE: Record<string, { box: string; text: string; label: string }> = {
  Blue: {
    box: 'border-m3-mint/40 bg-m3-mint/10',
    text: 'text-m3-mint',
    label: 'Blue',
  },
  Red: {
    box: 'border-m3-coral/40 bg-m3-coral/10',
    text: 'text-m3-coral',
    label: 'Red',
  },
};

const toneFor = (team: string | undefined) => TONE[team ?? ''] ?? TONE.Blue;

export const RoundRail: React.FC<RoundRailProps> = ({ rounds, selectedRound, onSelect }) => {
  const tabRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const current = selectedRound ?? rounds[0]?.roundNum ?? null;

  const select = useCallback(
    (roundNum: number) => {
      onSelect(roundNum);
      requestAnimationFrame(() => {
        tabRefs.current.get(roundNum)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    },
    [onSelect]
  );

  const move = useCallback(
    (delta: 1 | -1 | 'first' | 'last') => {
      if (rounds.length === 0) return;
      const idx = Math.max(0, rounds.findIndex((r) => r.roundNum === current));
      const nextIdx =
        delta === 'first'
          ? 0
          : delta === 'last'
            ? rounds.length - 1
            : (idx + delta + rounds.length) % rounds.length;
      const next = rounds[nextIdx];
      onSelect(next.roundNum);
      requestAnimationFrame(() => tabRefs.current.get(next.roundNum)?.focus());
    },
    [rounds, current, onSelect]
  );

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move('first');
    } else if (e.key === 'End') {
      e.preventDefault();
      move('last');
    }
  };

  if (rounds.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <div
        role="tablist"
        aria-label="Rounds"
        onKeyDown={onKeyDown}
        className="flex items-end gap-1 overflow-x-auto custom-scrollbar pb-1"
      >
        {rounds.map((r) => {
          const tone = toneFor(r.winningTeam);
          const isSelected = r.roundNum === current;
          const label = `Round ${displayRound(r.roundNum)}: ${tone.label} won${
            r.roundResult ? ` (${r.roundResult})` : ''
          }${r.bombPlanter ? ', bomb planted' : ''}${r.bombDefuser ? ', bomb defused' : ''}`;
          return (
            <button
              key={r.roundNum}
              ref={(el) => {
                if (el) tabRefs.current.set(r.roundNum, el);
                else tabRefs.current.delete(r.roundNum);
              }}
              type="button"
              role="tab"
              id={`round-tab-${r.roundNum}`}
              aria-selected={isSelected}
              aria-controls="round-detail-panel"
              tabIndex={isSelected ? 0 : -1}
              aria-label={label}
              onClick={() => select(r.roundNum)}
              className="shrink-0 flex flex-col items-center gap-1 rounded-lg p-0.5 cursor-pointer"
            >
              <span
                className={`relative flex h-8 w-9 items-center justify-center rounded-md border ${tone.box} ${
                  isSelected
                    ? 'ring-2 ring-m3-primary ring-offset-1 ring-offset-m3-surface-container'
                    : ''
                }`}
              >
                {r.bombPlanter && <Bomb className={`w-3 h-3 ${tone.text}`} aria-hidden="true" />}
                {r.bombDefuser && <Wrench className={`w-3 h-3 ${tone.text}`} aria-hidden="true" />}
              </span>
              <span
                className={`text-micro font-mono tabular-nums ${
                  isSelected ? 'text-m3-primary font-bold' : 'text-m3-outline'
                }`}
              >
                {displayRound(r.roundNum)}
              </span>
            </button>
          );
        })}
      </div>

      {/* The strip icons are not self-explanatory. */}
      <div className="flex items-center gap-3 text-micro text-m3-outline">
        <span className="inline-flex items-center gap-1">
          <Bomb className="w-3 h-3" aria-hidden="true" /> planted
        </span>
        <span className="inline-flex items-center gap-1">
          <Wrench className="w-3 h-3" aria-hidden="true" /> defused
        </span>
      </div>
    </div>
  );
};
