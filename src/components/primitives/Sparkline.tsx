import React from 'react';

import { outcomeTone, type Outcome } from './colors';

export interface SparklineProps {
  /** One outcome per bar, oldest first. Empty means "no sparkline at all" —
   *  the caller omits it rather than drawing a placeholder strip. */
  values: Outcome[];
  /** Accessible description; the bars themselves are decorative. */
  label?: string;
}

/** Round-outcome bars for one match: no axis, no gradient, no tooltip, one
 *  colour. A trend curve would need a per-day series the app does not have;
 *  this is a per-round strip and nothing more. */
export const Sparkline: React.FC<SparklineProps> = ({ values, label }) => {
  if (values.length === 0) return null;
  /* Outcome colour is the contract, not decoration: a round won is mint, a
   *  round lost is coral, anything unresolved stays neutral. Bars are a fixed
   *  height — this is a result strip, not a magnitude chart. */
  return (
    <div className="flex items-end gap-[2px] h-4" aria-hidden="true" data-label={label}>
      {values.map((v, i) => (
        <span
          key={i}
          className={`w-[3px] rounded-[1px] bg-current ${outcomeTone(v)}`}
          style={{ height: '12px' }}
        />
      ))}
    </div>
  );
};
