/* Live-player stats: the per-puuid cache the lobby board reads.
 *
 * Moved verbatim out of utils/tracker.ts (stage 2b, step 2 of the data-layer
 * split, docs/architecture/design-data-layer.md). MOVES ONLY — every body is
 * byte-identical to the code that lived in tracker.ts; tracker re-exports the
 * public names so no importer changes.
 *
 * It owns `recon_live_player_stats_v3` and the snapshot's match id. Rank does
 * NOT live here — it has its own store in cache/namespace.ts, so a stats
 * rebuild can never blank a rank. */

import { evictOldest } from '../cache/namespace';
import { inCurrentLobby } from './lobbyScope';

export interface LivePlayerStatsEntry {
  kd?: number;
  winPct?: number;
  hsPct?: number;
  trnScore?: number;
  acs?: number;
  recentWon?: number;
  recentLost?: number;
  streak?: number;
  streakIsWin?: boolean;
  country?: string;
  fetchedAt: number;
  retryAfter?: number;
  /** True when TRN answered HTTP 451 CollectorResultStatus::Private for this
   *  player — dashes are expected, not breakage. */
  isTrnPrivate?: boolean;
  /** Deliberate long backoff marker: 'private' (451, retry in 7d) or
   *  'missing' (404, retry in 24h). The self-heal below must NEVER clear
   *  flagged entries — only unflagged poison from previous sessions. */
  negative?: 'private' | 'missing';
  /** True when the last lookup FAILED (cooldown, rate limit, blip) rather than
   *  succeeding with no stats. A failure is negative-cached like any other, but
   *  it must stay distinguishable: a failed entry is statless AND backoff-armed,
   *  which is byte-identical to a successful "no data" answer otherwise. */
  lastFetchFailed?: boolean;
  /** Why the act-stats cell has no number, when the reason is NOT "unknown".
   *  'too-long' = the act has more games than we will page (the honest answer
   *  is "not computed", not an empty cell); 'incomplete' = some match in the
   *  window was unreadable; 'timeout' = the aggregation time budget ran out;
   *  'local-failed' = the local Riot read itself failed. null/undefined means
   *  no verdict was recorded (blank for the ordinary "not fetched" reason). */
  actState?: 'too-long' | 'incomplete' | 'timeout' | 'local-failed' | null;
  /** The match this entry was written for. Absent on older writes. */
  matchId?: string;
  /** Last successful 24h-record refresh — decoupled from `fetchedAt`, which
   *  TRN updates also bump. Sharing one timestamp let each source suppress
   *  the other's refresh. */
  recFetchedAt?: number;
}

const livePlayerStatsCache = new Map<string, LivePlayerStatsEntry>();
// v3: v2 snapshots were written by builds that could settle a lobby with
// pre-match data; the version bump is the migration. The matchId stamp is the
// ongoing guard — a snapshot from a previous match must never describe this one.
const LIVE_STATS_CACHE_KEY = 'recon_live_player_stats_v3';

/** The match the persisted live-stats snapshot belongs to. Set by the poll. */
let liveSnapshotMatchId = '';

/** Stamp the live snapshot with the current match id. Called from the poll. */
export function setLiveSnapshotMatch(matchId: string): void {
  liveSnapshotMatchId = String(matchId ?? '');
}

const LIVE_STATS_TTL = 24 * 60 * 60 * 1000; // 24 hours — player act stats & country do not change every minute
/** Persisted-store cap: the in-memory `LIVE_STATS_CACHE_MAX` keys' worth. */
const LIVE_STATS_STORE_MAX = 200;
/** How many of the oldest keys one prune pass drops. Ample headroom above
 *  the cap so the store converges instead of oscillating 1-over-threshold. */
const LIVE_STATS_STORE_PRUNE = 40;

/** In-memory live-stats cap. This map is keyed by puuid and was never
 *  pruned, so a long session (every lobby you queue into adds up to 12
 *  strangers) grew one entry per distinct player forever. A live lobby is
 *  at most 12 players; 200 is ~16 lobbies of slack over anything the UI can
 *  show, and an evicted player is re-resolved by one TRN fetch next time
 *  they appear. The persisted mirror below keeps its own longer history,
 *  so eviction here loses nothing durable. */
const LIVE_STATS_CACHE_MAX = 200;

/** Drop the retry gate on every cached player so the next poll re-attempts
 *  them immediately. The TRN banner's "I finished" calls this: without it the
 *  button looks dead, because the 30s/5min `retryAfter` set by the failure
 *  paths holds every player exactly where they already are. */
export function clearLocalStatsRetry(): void {
  for (const [k, v] of livePlayerStatsCache) {
    livePlayerStatsCache.set(k, { ...v, retryAfter: 0, lastFetchFailed: false });
  }
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(LIVE_STATS_CACHE_KEY);
    if (!raw) return;
    const store = JSON.parse(raw) as Record<string, LivePlayerStatsEntry>;
    let touched = 0;
    for (const k of Object.keys(store)) {
      if (!store[k]) continue;
      store[k] = { ...store[k], retryAfter: 0, lastFetchFailed: false };
      touched++;
    }
    if (touched > 0) localStorage.setItem(LIVE_STATS_CACHE_KEY, JSON.stringify(store));
  } catch {}
}

export function getCachedLivePlayerStats(puuid: string): LivePlayerStatsEntry | undefined {
  if (!puuid) return undefined;
  const pU = puuid.toLowerCase();
  const mem = livePlayerStatsCache.get(pU);
  // The match guard applies to the IN-MEMORY copy too: after a match change the
  // map still holds the previous match's rows, and returning them was exactly
  // how a stale snapshot kept the board settled without fetching.
  const memIsCurrent = !mem?.matchId || !liveSnapshotMatchId || mem.matchId === liveSnapshotMatchId;
  if (mem && memIsCurrent && Date.now() - mem.fetchedAt < LIVE_STATS_TTL) return mem;

  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(LIVE_STATS_CACHE_KEY);
      if (raw) {
        const store = JSON.parse(raw) as Record<string, LivePlayerStatsEntry>;
        const entry = store[pU];
        // A snapshot describing a DIFFERENT match is not data about this one.
        if (entry?.matchId && liveSnapshotMatchId && entry.matchId !== liveSnapshotMatchId) {
          return undefined;
        }
        if (entry) {
          // Self-heal: clear poisoned multi-hour lockouts from previous sessions —
          // but NEVER deliberate negatives (flagged 451-private/404-missing carry
          // intentional 7d/24h backoffs; wiping them re-fetches privates forever).
          if (entry.retryAfter && !entry.negative && entry.retryAfter > Date.now() + 2 * 60 * 1000) {
            entry.retryAfter = undefined;
          }
          if (Date.now() - entry.fetchedAt < LIVE_STATS_TTL) {
            livePlayerStatsCache.set(pU, entry);
            return entry;
          }
        }
      }
    } catch {}
  }
  // TTL-expired with no fresh persisted copy: stale must not masquerade as
  // fresh. Callers treat a return value as valid stats.
  return undefined;
}

export function setCachedLivePlayerStats(puuid: string, entry: Partial<LivePlayerStatsEntry>): void {
  if (!puuid) return;
  const pU = puuid.toLowerCase();

  let existing: LivePlayerStatsEntry | undefined = livePlayerStatsCache.get(pU);
  let store: Record<string, LivePlayerStatsEntry> = {};

  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(LIVE_STATS_CACHE_KEY);
      if (raw) {
        store = JSON.parse(raw);
        if (store[pU]) {
          existing = { ...existing, ...store[pU] };
        }
      }
    } catch {}
  }

  // Non-destructive merge: NEVER overwrite existing valid fields with undefined
  const merged: LivePlayerStatsEntry = {
    ...existing,
    // Every write records which match it describes.
    ...(liveSnapshotMatchId ? { matchId: liveSnapshotMatchId } : {}),
    fetchedAt: entry.fetchedAt ?? existing?.fetchedAt ?? Date.now(),
  };
  for (const [k, v] of Object.entries(entry)) {
    if (v !== undefined && v !== null) {
      (merged as any)[k] = v;
    }
  }
  if (entry.retryAfter !== undefined) {
    merged.retryAfter = entry.retryAfter;
  }
  // Same explicit pass-through for the act verdict: `null` is a real value
  // here (it CLEARS a stale reason after a successful recompute), but the
  // generic loop above skips null.
  if (entry.actState !== undefined) {
    merged.actState = entry.actState;
  }

  livePlayerStatsCache.set(pU, merged);
  // Age-ordered eviction, never the current lobby: `mergeLiveMatchState-
  // NonRegressing` latches TRN enrichment out of this cache, so evicting a
  // live player would strip the row the other realm is still showing and
  // bring the flicker back.
  evictOldest(livePlayerStatsCache, LIVE_STATS_CACHE_MAX, (e) => e.fetchedAt, inCurrentLobby);

  if (typeof localStorage !== 'undefined') {
    try {
      store[pU] = merged;
      const keys = Object.keys(store);
      if (keys.length > LIVE_STATS_STORE_MAX) {
        // Oldest-first, and the CURRENT lobby is never a victim: the merge
        // latches enrichment from this store too, so dropping a live player's
        // entry would make the next cold realm re-fetch (and re-spend budget
        // on) a player we already resolved.
        const sorted = keys.sort((a, b) => store[a].fetchedAt - store[b].fetchedAt);
        let dropped = 0;
        for (const k of sorted) {
          if (dropped >= LIVE_STATS_STORE_PRUNE) break;
          if (inCurrentLobby(k)) continue;
          delete store[k];
          dropped++;
        }
      }
      localStorage.setItem(LIVE_STATS_CACHE_KEY, JSON.stringify(store));
    } catch {}
  }
}
