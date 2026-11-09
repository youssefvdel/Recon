import React from 'react';

export interface SkeletonProps {
  /** Height/width utilities for one bar, e.g. "h-3 w-24". */
  className?: string;
  /** Render a stack of bars instead of one. */
  lines?: number;
}

/** The single loading placeholder. One shape everywhere; reduced-motion CSS
 *  in index.css drops the pulse, so it never becomes a strobe. */
export const Skeleton: React.FC<SkeletonProps> = ({ className = 'h-3 w-24', lines = 1 }) => (
  <div aria-hidden="true" className="flex flex-col gap-1.5">
    {Array.from({ length: Math.max(1, lines) }, (_, i) => (
      <div key={i} className={`animate-pulse rounded bg-m3-surface-container-high ${className}`} />
    ))}
  </div>
);
