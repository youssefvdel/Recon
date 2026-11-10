/** Table cells that must never crash a view.
 *
 *  A TRN row can arrive without one of its stats: the payload is private,
 *  partial, or the row was derived from a match we could not enrich. Calling
 *  `.toFixed` on that undefined threw inside `<AgentTable>` and the error
 *  boundary replaced the whole Prep view with "This view failed to load" —
 *  which is a worse failure than a blank cell.
 *
 *  Absent is absent: a non-finite value renders as nothing, never `0` and never
 *  a dash, because both of those read as a measurement.
 */
export const num = (v: unknown, digits: number, suffix = ''): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(digits)}${suffix}` : '';

/** A signed whole number, or nothing.
 *
 *  `String(Math.round(NaN))` renders the literal text "NaN" in a table cell,
 *  which a reader takes as broken data — worse than a blank. Non-finite values
 *  are absent here for the same reason as in `num`.
 */
export const signedInt = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) ? (v > 0 ? `+${Math.round(v)}` : String(Math.round(v))) : '';
