import React from 'react';
import { Lock } from 'lucide-react';
import { SourceStamp } from './SourceStamp';

export type FieldState = 'fresh' | 'stale' | 'missing' | 'private' | 'error';
export type FieldSource = 'riot' | 'snapshot' | 'tracker' | 'derived';

export interface FieldViewProps {
  /** Accessible name of the datum, used by tooltip/screen readers. */
  label: string;
  value?: React.ReactNode;
  state: FieldState;
  source: FieldSource;
  asOf: number | null;
  className?: string;
}

/** The only component allowed to turn a data state into a visible claim.
 *  Rules (design-ui.md §2): lock only for source-reported Tracker privacy,
 *  stale values always carry their timestamp, and nothing renders without a
 *  value except an explicit missing/error label. */
export const FieldView: React.FC<FieldViewProps> = ({
  label,
  value,
  state,
  source,
  asOf,
  className = '',
}) => {
  if (state === 'private') {
    if (source !== 'tracker') {
      return (
        <span className={`text-m3-outline ${className}`} data-tip={`${label}: no data`}>
          —
        </span>
      );
    }
    return (
      <span
        className={`inline-flex items-center justify-center text-zinc-500 ${className}`}
        data-tip={`${label}: private Tracker profile`}
      >
        <Lock className="h-2.5 w-2.5" aria-hidden="true" />
        <span className="sr-only">{label} is private</span>
      </span>
    );
  }

  if (state === 'missing') {
    return (
      <span className={`text-micro font-mono text-m3-outline ${className}`} data-tip={`${label}: no data`}>
        no data
      </span>
    );
  }

  if (state === 'error' || value == null) {
    return (
      <span className={`text-m3-outline ${className}`} data-tip={`${label}: unavailable`}>
        —
        <span className="sr-only">{label} unavailable</span>
      </span>
    );
  }

  return (
    <span className={`inline-flex items-baseline gap-1.5 ${className}`} data-tip={label}>
      <span>{value}</span>
      {state === 'stale' && <SourceStamp at={asOf} source={source === 'tracker' ? 'TRN' : undefined} />}
    </span>
  );
};
