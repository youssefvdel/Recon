import React from 'react';
import { outcomeTone, type Outcome } from './colors';

export interface FeedRowProps {
  /** Relative age ("2h", "1d"). Absent when the timestamp is unknown. */
  age?: string;
  map?: string;
  /** Resolved verdict only. Unknown renders no word at all. */
  verdict?: Outcome | null;
  score?: string;
  /** Agent + KDA + ACS, already composed by the caller. */
  sub?: string;
  spark?: React.ReactNode;
  onOpen?: () => void;
}

const VERDICT_LABEL: Record<Outcome, string> = {
  win: 'WIN',
  loss: 'LOSS',
  draw: 'DRAW',
  unknown: '',
};

/** One match in the season feed. Every segment is optional and simply does not
 *  render when the source is missing — a row with only a map and an age is a
 *  truthful row, not a broken one. */
export const FeedRow: React.FC<FeedRowProps> = ({ age, map, verdict, score, sub, spark, onOpen }) => {
  const body = (
    <>
      <span className="text-micro font-mono text-m3-outline tabular-nums">{age ?? ''}</span>
      <span className="min-w-0 flex items-baseline gap-3">
        {map && <span className="font-display text-base font-bold text-m3-on-surface truncate">{map}</span>}
        {verdict && verdict !== 'unknown' && (
          <span className={`text-micro font-mono font-bold uppercase tracking-[0.14em] ${outcomeTone(verdict)}`}>
            {VERDICT_LABEL[verdict]}
          </span>
        )}
        {score && <span className="font-mono text-lg tabular-nums text-m3-on-surface">{score}</span>}
      </span>
      <span className="min-w-0 flex items-center justify-end gap-3">
        {sub && <span className="text-micro font-mono text-m3-outline truncate">{sub}</span>}
        {spark}
      </span>
      <span className="text-m3-outline text-sm leading-none">{onOpen ? '›' : ''}</span>
    </>
  );

  const className =
    'w-full text-left grid grid-cols-[64px_minmax(0,1fr)_auto_14px] items-center gap-4 py-3.5 border-b border-m3-outline-subtle/60';

  return onOpen ? (
    <button type="button" onClick={onOpen} className={`${className} cursor-pointer hover:bg-m3-surface-container-high/30`}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
};
