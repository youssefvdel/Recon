import React from 'react';
import { Crosshair } from 'lucide-react';

export interface PrepickBadgeProps {
  /** Agent icon URL; empty string renders the Crosshair fallback. */
  icon: string;
  agent: string;
}

/* Safe Pre-Pick reminder plate: moved verbatim from OverlayView (split 8/8). */

export const PrepickBadge: React.FC<PrepickBadgeProps> = ({ icon, agent }) => (
<div className="rounded-2xl border border-m3-outline-variant/50 bg-m3-surface-container/[0.85] shadow-m3-2 px-3 py-2.5 flex items-center gap-2.5">
  {icon ? (
    <img
      src={icon}
      alt=""
      draggable={false}
      className="w-9 h-9 rounded-xl object-cover shrink-0 border border-m3-outline-variant/50 bg-m3-surface-container-high/60 pointer-events-none select-none"
    />
  ) : (
    <div className="w-9 h-9 rounded-xl shrink-0 border border-m3-outline-variant/50 bg-m3-surface-container-high/60 flex items-center justify-center">
      <Crosshair className="w-4 h-4 text-m3-primary" />
    </div>
  )}
  <div className="flex flex-col leading-tight min-w-0">
    <span className="font-display font-bold text-[11px] text-m3-on-surface-variant tracking-wider uppercase">
      Pre-Pick
    </span>
    <span className="font-mono text-[11px] text-m3-on-surface font-bold truncate">
      {agent}
      <span className="text-m3-outline font-normal"> • hover only</span>
    </span>
  </div>
  <span className="ml-1 w-1.5 h-1.5 rounded-full bg-m3-mint shrink-0" />
</div>
);

