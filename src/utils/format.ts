/* One source of truth for displayed stat precision (docs/audit/ui.md #10).
 *
 * K/D is always one decimal, percentages take an explicit decimal count:
 * one for per-match headshot %, zero for aggregates and win rates.
 * Views must call these instead of hand-rolling toFixed/Math.round, or the
 * same metric ends up rendered 3-4 different ways again.
 */

export const formatKd = (value: number | null | undefined): string =>
  value != null && Number.isFinite(value) ? value.toFixed(1) : '—';

export const formatPct = (value: number | null | undefined, decimals = 1): string =>
  value != null && Number.isFinite(value) ? `${value.toFixed(decimals)}%` : '—';
