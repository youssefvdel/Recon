import React from 'react';

export interface StatusLineProps {
  /** Why the page is showing cached or partial data. Absent -> no line. */
  reason?: string | null;
  retryLabel?: string;
  onRetry?: () => void;
}

/** One 11px line under the act header: the situation, and a way out of it.
 *  No card, no icon block, no amber banner — the reason is a sentence, not a
 *  surface. */
export const StatusLine: React.FC<StatusLineProps> = ({ reason, retryLabel = 'Retry', onRetry }) => {
  if (!reason) return null;
  return (
    <p className="mt-2 text-micro font-mono text-m3-outline flex items-center gap-2 min-w-0">
      <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
      <span className="truncate">{reason}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="text-m3-primary hover:underline cursor-pointer shrink-0"
        >
          {retryLabel}
        </button>
      )}
    </p>
  );
};
