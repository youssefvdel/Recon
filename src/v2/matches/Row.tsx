import React from 'react';

/** One ledger row: hairline, no card, no radius. Day/time · map · score ·
 *  result · agent. Everything optional renders as nothing. */
export interface RowProps {
  when: number;
  map?: string;
  score?: string;
  result?: 'W' | 'L' | 'D';
  agent?: string;
  open: boolean;
  onToggle: () => void;
}

const relDay = (when: number): string => {
  if (!when) return '';
  const d = Math.floor((Date.now() - when) / 86_400_000);
  if (d <= 0) return 'Today';
  if (d === 1) return 'Yesterday';
  return `${d}d ago`;
};

export const Row: React.FC<RowProps> = ({ when, map, score, result, agent, open, onToggle }) => (
  <button
    type="button"
    onClick={onToggle}
    aria-expanded={open}
    className="w-full grid grid-cols-[72px_1fr_auto_24px_120px_16px] items-center gap-4 py-1.5 text-left border-b cursor-pointer"
    style={{ borderColor: 'var(--outline)', color: 'var(--on-surface)' }}
  >
    <span className="text-xs tabular-nums" style={{ color: 'var(--on-surface-muted)' }}>
      {relDay(when)}
    </span>
    <span className="text-sm truncate">{map ?? ''}</span>
    <span className="text-sm tabular-nums" style={{ color: 'var(--on-surface-muted)' }}>
      {score ?? ''}
    </span>
    <span
      className="text-xs font-bold"
      style={{
        color:
          result === 'W' ? 'var(--positive)' : result === 'L' ? 'var(--negative)' : 'var(--on-surface-muted)',
      }}
    >
      {result ?? ''}
    </span>
    <span className="text-xs truncate" style={{ color: 'var(--on-surface-muted)' }}>
      {agent ?? ''}
    </span>
    <span style={{ color: 'var(--on-surface-muted)' }}>{open ? '▾' : '›'}</span>
  </button>
);
