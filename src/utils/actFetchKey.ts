/** Identity of one past-act fetch.
 *
 *  The fetch effect re-runs when this string changes, so a Retry that "does
 *  nothing" is impossible by construction: the nonce is part of the key, and
 *  bumping it makes the key differ from the one that failed. The alternative —
 *  a button that clears the error and waits for the user to toggle the act — is
 *  worse than no button, because it tells the user the app heard them.
 */
export const actFetchKey = (
  isDefault: boolean,
  seasonId: string,
  playlist: string,
  nonce: number
): string => `${isDefault ? 'current' : 'past'}|${seasonId}|${playlist}|${nonce}`;
