/* Cache primitives and namespace owners.
 *
 * Split out of src/utils/tracker.ts (stage 1 of the data-layer split, design
 * docs/architecture/design-data-layer.md §3). MOVES ONLY: every body below is
 * byte-identical to the code that lived in tracker.ts; tracker re-exports the
 * public names so no importer changes.
 *
 * Ownership: this module owns `recon_live_rank_*` and the superseded-key list.
 * It prunes ONLY what it owns or what is provably dead. */

// No source-module keys here any more: trn.ts prunes its own generations
// (pruneTrnCaches), so this layer only knows prefixes it owns.

/** Oldest-first eviction down to `cap`. Never evicts a protected key.
 * Moved verbatim out of utils/tracker.ts: three caches use it, so it is a cache
 * primitive, not one module's internal. */
export function evictOldest<K, V>(
  map: Map<K, V>,
  cap: number,
  at: (v: V) => number,
  protect?: (key: K) => boolean
): void {
  if (map.size <= cap) return;
  const drop = [...map.entries()].sort((a, b) => at(a[1]) - at(b[1]));
  for (const [k] of drop) {
    if (map.size <= cap) break;
    if (protect?.(k)) continue;
    map.delete(k);
  }
}

/* ------------------------------------------------------------------ *
 * Quota-safe local storage
 *
 * QA measured this machine at ~5.24 M chars against the ~5 MB quota, with 11
 * `recon_match_v6_*` entries and ZERO `recon_match_v7_*`. Storage was full, so
 * every cache version bump we shipped silently did nothing — and the stale
 * `recon_live_player_stats_v2` survived for the same reason.
 * ------------------------------------------------------------------ */

/** Superseded key generations: we no longer read them, so they are ballast. */
const SUPERSEDED_PREFIXES = [
  'recon_match_v6_',
  'recon_match_v5_',
  'aspect_match_v5_',
  'recon_live_player_stats_v2',
];

/** Delete every superseded generation. Idempotent, cheap, never throws. */
export function pruneSupersededCaches(): number {
  if (typeof localStorage === 'undefined') return 0;
  let removed = 0;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && SUPERSEDED_PREFIXES.some((p) => k.startsWith(p))) doomed.push(k);
    }
    for (const k of doomed) {
      try {
        localStorage.removeItem(k);
        removed++;
      } catch {}
    }
  } catch {}
  return removed;
}

/** setItem that never throws: on quota, drop the oldest entries of the same
 *  family and retry ONCE. A cache write must never surface to a caller. */
export function writeLocalSafe(key: string, value: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    try {
      const family = key.replace(/[0-9a-f]{6,}.*$/i, '');
      const victims: { k: string; at: number }[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k !== key && k.startsWith(family)) {
          victims.push({ k, at: 0 });
        }
      }
      // Oldest first is unknowable here; drop a batch so one retry can win.
      for (const v of victims.slice(0, Math.max(5, victims.length - 10))) {
        try {
          localStorage.removeItem(v.k);
        } catch {}
      }
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Rank/peak live OUTSIDE the TRN live-stats block.
 *
 * A TRN rebuild can reset the stats snapshot; it must never blank a rank we
 * already resolved. This map is written on every successful /mmr read and read
 * back when the live read fails, so the board keeps the last-known-good rank
 * (marked stale) instead of flipping every row to "Unrated".
 * ------------------------------------------------------------------ */
const LIVE_RANK_KEY = 'recon_live_rank_v1';
const LIVE_RANK_MAX = 200;

export interface PersistedRank {
  tier: number;
  rr: number;
  peakTier: number;
  peakSeasonId?: string;
  at: number;
}

function readPersistedRanks(): Record<string, PersistedRank> {
  try {
    if (typeof localStorage === 'undefined') return {};
    return JSON.parse(localStorage.getItem(LIVE_RANK_KEY) ?? '{}') as Record<string, PersistedRank>;
  } catch {
    return {};
  }
}

/** Remember a resolved rank. NEVER writes a zero tier over a known one: a zero
 *  means "not read", not "unranked", and erasing a rank is a regression. */
export function persistLiveRank(
  puuid: string,
  row: { tier: number; rr: number; peakTier: number; peakSeasonId?: string }
): void {
  if (!puuid || !(row.tier > 0)) return;
  try {
    if (typeof localStorage === 'undefined') return;
    const all = readPersistedRanks();
    const key = puuid.toLowerCase();
    const prev = all[key];
    all[key] = {
      tier: row.tier,
      rr: row.rr,
      peakTier: Math.max(row.peakTier || 0, prev?.peakTier ?? 0),
      ...(row.peakSeasonId ?? prev?.peakSeasonId
        ? { peakSeasonId: row.peakSeasonId ?? prev?.peakSeasonId }
        : {}),
      at: Date.now(),
    };
    const keys = Object.keys(all);
    if (keys.length > LIVE_RANK_MAX) {
      keys
        .sort((a, b) => (all[a]?.at ?? 0) - (all[b]?.at ?? 0))
        .slice(0, keys.length - LIVE_RANK_MAX)
        .forEach((k) => delete all[k]);
    }
    writeLocalSafe(LIVE_RANK_KEY, JSON.stringify(all));
  } catch {}
}

/** Last known rank for a puuid, or null. Survives a stats rebuild. */
export function readPersistedRank(puuid: string): PersistedRank | null {
  return readPersistedRanks()[String(puuid ?? '').toLowerCase()] ?? null;
}
