/* Absent is absent.
 *
 * One place for the arithmetic that must NOT invent a number when its input is
 * missing. A per-round stat with no rounds, a K/D with no deaths and a win rate
 * with no matches are all `null` — never 0 (which reads as "you never win") and
 * never a made-up divisor (which inflates a stat 10-30x and still looks real).
 *
 * Renderers turn `null` into "—" through formatPct/formatKd, or hide the row.
 */

/** total / rounds, or null when there are no rounds (or no finite total). */
export function perRound(
  total: number | null | undefined,
  rounds: number | null | undefined
): number | null {
  if (rounds == null || rounds <= 0) return null;
  if (total == null || !Number.isFinite(total)) return null;
  return total / rounds;
}

/** num / den, or null when the denominator is zero/absent. */
export function safeRatio(
  num: number | null | undefined,
  den: number | null | undefined
): number | null {
  if (den == null || den <= 0) return null;
  if (num == null || !Number.isFinite(num)) return null;
  return num / den;
}

/** 100 * num / den, or null when the denominator is zero/absent. */
export function pctOf(
  num: number | null | undefined,
  den: number | null | undefined
): number | null {
  const r = safeRatio(num, den);
  return r == null ? null : r * 100;
}
