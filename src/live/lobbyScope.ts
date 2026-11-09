/* Which players are in the lobby right now.
 *
 * Moved verbatim out of utils/tracker.ts (stage 2b, step 1 of the data-layer
 * split, docs/architecture/design-data-layer.md). Its own module because BOTH
 * the live-player stats cache and the MMR cache protect lobby members from
 * eviction — shared state, not one cache's internal.
 *
 * Coupling note for the reviewer: `inCurrentLobby` keeps identical semantics
 * through the import, so tracker's MMR cache and live-stats cache need no
 * change at all. The one difference is the setter — it stores `new Set(puuids)`,
 * so the poll's local roster array can no longer leak mutations into the lobby
 * scope after the call. */

/** Puuids in the lobby as of the last completed poll (lower-cased). */
let currentLobbyPuuids = new Set<string>();

/** Replace the lobby set. Called once per poll, with the roster it just built. */
export function setCurrentLobbyPuuids(puuids: Iterable<string>): void {
  currentLobbyPuuids = new Set(puuids);
}

/** True for a key naming a player who is in the lobby right now. */
export function inCurrentLobby(key: string): boolean {
  return currentLobbyPuuids.has(key);
}
