import React from 'react';

/* "Not fetched yet" cell, shared by the tracker tables (docs/audit/ui.md #1).
 *
 * A missing stat must never render as 0: that reads as a bad game the player
 * actually had. It renders the house dash, exposes the reason to screen
 * readers, and shows the same reason on hover. The visible legend lives under
 * the match list so keyboard-only users are not dependent on hover.
 */
export const StatValue: React.FC<{ reason?: string; className?: string }> = ({
  reason = 'Not fetched yet',
  className = '',
}) => (
  <span
    className={`inline-flex items-center justify-center text-m3-outline ${className}`}
    data-tip={reason}
  >
    <span aria-hidden="true">—</span>
    <span className="sr-only">{reason}</span>
  </span>
);
