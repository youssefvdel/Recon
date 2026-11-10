/** The colour contract for the B surfaces. Read this before adding a colour to
 *  a feed, a header or a status line — it is the rule two days of decisions
 *  produced, and it is cheap to follow once it is written down.
 *
 *  mint  = a RESOLVED positive outcome (a win, a positive delta)
 *  coral = a RESOLVED negative outcome (a loss, a negative delta)
 *  outline / on-surface-variant = a fact with no valence (a score, an age, a
 *          count) — colour here would imply an outcome that does not exist
 *  absent = nothing. Not a dash, not a zero, not a dimmed placeholder.
 *
 *  Two consequences worth stating because they get violated first:
 *  - a DRAW is not a win: it uses the neutral tone, never mint.
 *  - an UNKNOWN result (no detail cached) is neutral and silent; it never
 *    borrows the loss colour, because "we could not ask" is not "you lost".
 */
export const OUTCOME_TONE = {
  win: 'text-m3-mint',
  loss: 'text-m3-coral',
  draw: 'text-m3-on-surface',
  unknown: 'text-m3-outline',
} as const;

export type Outcome = keyof typeof OUTCOME_TONE;

/** Map a resolved verdict to its tone. Anything unresolved is neutral. */
export const outcomeTone = (outcome: Outcome | null | undefined): string =>
  outcome ? OUTCOME_TONE[outcome] : OUTCOME_TONE.unknown;
