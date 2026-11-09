import React from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'mint' | 'warn' | 'danger';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: 'sm' | 'md';
}

const TONE: Record<BadgeTone, string> = {
  neutral: 'border-m3-outline-subtle/60 bg-m3-surface-container-high text-m3-on-surface-variant',
  accent: 'border-m3-primary/40 bg-m3-primary/15 text-m3-primary',
  mint: 'border-m3-mint/40 bg-m3-mint/15 text-m3-mint',
  warn: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  danger: 'border-rose-400/40 bg-rose-400/10 text-rose-300',
};

const SIZE = { sm: 'px-1.5 py-0.5 text-[9px]', md: 'px-2 py-0.5 text-micro' } as const;

/** One pill for every label. Tones map to existing tokens; no new colours. */
export const Badge: React.FC<BadgeProps> = ({ tone = 'neutral', size = 'sm', className = '', ...rest }) => (
  <span
    className={`inline-flex items-center gap-1 rounded-full border font-mono font-semibold uppercase tracking-wide ${TONE[tone]} ${SIZE[size]} ${className}`}
    {...rest}
  />
);
