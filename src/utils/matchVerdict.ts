/** WIN/LOSS/DRAW from MY score and theirs. Unknown either side -> null: the
 *  verdict is omitted rather than guessed. Pure so a check can drive it. */
export function matchVerdict(
  mine: number | undefined,
  theirs: number | undefined
): 'WIN' | 'LOSS' | 'DRAW' | null {
  if (typeof mine !== 'number' || typeof theirs !== 'number') return null;
  if (mine > theirs) return 'WIN';
  if (mine < theirs) return 'LOSS';
  return 'DRAW';
}
