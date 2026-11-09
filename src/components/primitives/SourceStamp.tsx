import React from 'react';

export interface SourceStampProps {
  /** Observation time (epoch ms). Renders nothing when null — no timestamp, no claim. */
  at: number | null;
  /** Shown before the age, e.g. "TRN". */
  source?: string;
  className?: string;
}

function age(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
}

/** One timestamp renderer. A cached value without one must not be printed. */
export const SourceStamp: React.FC<SourceStampProps> = ({ at, source, className = '' }) => {
  if (at == null) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 text-micro font-mono text-m3-outline ${className}`}
      title={new Date(at).toLocaleString()}
    >
      {source && <span className="uppercase tracking-wide">{source}</span>}
      <time dateTime={new Date(at).toISOString()}>{age(at)}</time>
    </span>
  );
};
