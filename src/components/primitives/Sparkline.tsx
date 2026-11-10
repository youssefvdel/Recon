import React from 'react';

export interface SparklineProps {
  /** One value per bar, oldest first. Empty means "no sparkline at all" — the
   *  caller omits it rather than drawing a placeholder strip. */
  values: number[];
  /** Accessible description; the bars themselves are decorative. */
  label?: string;
}

/** Round-outcome bars for one match: no axis, no gradient, no tooltip, one
 *  colour. A trend curve would need a per-day series the app does not have;
 *  this is a per-round strip and nothing more. */
export const Sparkline: React.FC<SparklineProps> = ({ values, label }) => {
  if (values.length === 0) return null;
  const max = Math.max(...values, 1);
  return (
    <div className="flex items-end gap-[2px] h-4" aria-hidden="true" data-label={label}>
      {values.map((v, i) => (
        <span
          key={i}
          className="w-[3px] rounded-[1px] bg-m3-outline/60"
          style={{ height: `${Math.max(2, Math.round((v / max) * 16))}px` }}
        />
      ))}
    </div>
  );
};
