import { useEffect, useSyncExternalStore } from 'react';
import type { TrackerMatchDetail, TrackerMmrPoint, TrackerProfile } from '../types';
import {
  aggregateDetails,
  clearAccountSnapshot,
  detectLocalAccount,
  detectRegion,
  fetchCompetitiveUpdates,
  fetchHistoryMeta,
  fetchLiveMatchState,
  fetchMmrDirect,
  gameData,
  isRiotClientRunning,
  readCachedAccount,
  shortMapName,
  type AggStats,
} from '../utils/tracker';
import { isTauri } from '../utils/ipc';
import {
  fetchTrnActStats,
  fetchTrnAgents,
  fetchTrnMaps,
  fetchTrnMatches,
  resetTrnCooldown,
  type TrnActStats,
  type TrnAgentStat,
  type TrnMapStat,
} from '../utils/trn';

/* Stale-while-revalidate singleton store:
   Cached data is loaded into memory on script load and shared across all
   tabs (Overview, Matches, Agents, Maps). Navigating between tabs is 100%
   instant (0ms) without any skeletons or reloading. */

const SNAPSHOT_PREFIX = 'recon_tracker_snapshot_v1';
const LEGACY_SNAPSHOT_KEY = 'recon_tracker_snapshot_v1';
const SNAPSHOT_TTL = 24 * 3600 * 1000;

const snapshotKey = (puuid: string): string =>
  `${SNAPSHOT_PREFIX}:${(puuid || 'anon').toLowerCase()}`;

type Snapshot = {
  savedAt: number;
  puuid: string;
  profile: TrackerProfile | null;
  games: TrackerMmrPoint[];
  agg: AggStats | null;
  mapById: Record<string, string>;
  queueById: Record<string, string>;
  trn: TrnActStats | null;
  trnAgents: TrnAgentStat[];
  trnMaps: TrnMapStat[];
  trnPrev: Record<string, { kd: number; matches: number }>;
  trnMatchTrs?: Record<string, number>;
  detailsById: Record<string, TrackerMatchDetail>;
  detailsReady: number;
};

function parseSnapshot(raw: string | null): Snapshot | null {
  if (!raw) return null;
  const s = JSON.parse(raw) as Snapshot;
  if (!s?.savedAt || !s?.profile) return null;
  if (Date.now() - s.savedAt > SNAPSHOT_TTL) return null;
  return s;
}

function readSnapshot(puuid?: string): Snapshot | null {
  try {
    if (puuid) return parseSnapshot(localStorage.getItem(snapshotKey(puuid)));
    const acc = readCachedAccount();
    if (acc?.puuid) {
      const owned = parseSnapshot(localStorage.getItem(snapshotKey(acc.puuid)));
      if (owned) return owned;
    }
    return parseSnapshot(localStorage.getItem(LEGACY_SNAPSHOT_KEY));
  } catch {
    return null;
  }
}

function writeSnapshot(s: Snapshot): void {
  try {
    localStorage.setItem(snapshotKey(s.puuid), JSON.stringify(s));
    if (!localStorage.getItem(`${LEGACY_SNAPSHOT_KEY}:migrated`)) {
      localStorage.removeItem(LEGACY_SNAPSHOT_KEY);
      localStorage.setItem(`${LEGACY_SNAPSHOT_KEY}:migrated`, '1');
    }
  } catch {
    /* Quota or private mode */
  }
}

export interface TrackerData {
  profile: TrackerProfile | null;
  games: TrackerMmrPoint[];
  queueById: Record<string, string>;
  mapById: Record<string, string>;
  seasonNames: Record<string, string>;
  seasonOrder: string[];
  tierIcons: Record<number, string>;
  agentInfo: Record<string, { name: string; icon: string; role: string; roleIcon: string }>;
  weapons: Record<string, string>;
  agg: AggStats | null;
  trn: TrnActStats | null;
  trnAgents: TrnAgentStat[];
  trnMaps: TrnMapStat[];
  trnPrev: Record<string, { kd: number; matches: number }>;
  trnMatchTrs: Record<string, number>;
  detailsById: Record<string, TrackerMatchDetail>;
  detailsReady: number;
  detailsTotal: number;
  isLoading: boolean;
  ready: boolean;
  hasCached: boolean;
  clientClosed: boolean;
  banner: string | null;
  setBanner: (m: string | null) => void;
  refresh: () => Promise<void>;
}

// Global module state
let store: TrackerData;
const listeners = new Set<() => void>();

function emitStore() {
  for (const listener of listeners) {
    listener();
  }
}

function updateStore(partial: Partial<TrackerData>) {
  store = { ...store, ...partial };
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__reconStore = store;
  }
  emitStore();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return store;
}

function initStore(): TrackerData {
  const cachedAcc = readCachedAccount();
  const snap = readSnapshot(cachedAcc?.puuid);
  const hasData = Boolean(snap?.profile);

  return {
    profile: snap?.profile ?? null,
    games: snap?.games ?? [],
    queueById: snap?.queueById ?? {},
    mapById: snap?.mapById ?? {},
    seasonNames: {},
    seasonOrder: [],
    tierIcons: {},
    agentInfo: {},
    weapons: {},
    agg: snap?.agg ?? null,
    trn: snap?.trn ?? null,
    trnAgents: snap?.trnAgents ?? [],
    trnMaps: snap?.trnMaps ?? [],
    trnPrev: snap?.trnPrev ?? {},
    trnMatchTrs: snap?.trnMatchTrs ?? {},
    detailsById: snap?.detailsById ?? {},
    detailsReady: snap?.detailsReady ?? 0,
    detailsTotal: snap?.games?.length ?? 0,
    isLoading: false,
    ready: hasData,
    hasCached: hasData,
    clientClosed: false,
    banner: null,
    setBanner: (m: string | null) => updateStore({ banner: m }),
    refresh: triggerGlobalRefresh,
  };
}

store = initStore();

let refreshPromise: Promise<void> | null = null;
let hasAutoRefreshed = false;

/* ---- One owner for the TRN enrichment ------------------------------------ *
 * The store above is module state, so every WebView2 realm has its own copy:
 * `main` and `overlay` each ran their own `runRefresh()`, and each one drove
 * the WHOLE TRN enrichment block (root profile + current-season segment + up
 * to 3 previous-act segments) for the SAME local account. Measured live
 * 2026-09-26 in a steady state: one main-realm refresh cost 1 wire request, and
 * the very next overlay-realm refresh cost 1-2 MORE for identical paths. The
 * per-realm `profileCache`/`seasonSegCache` in trn.ts cannot dedupe across
 * realms, and the Rust memo's 10s TTL only covers calls landing inside it.
 *
 * Those 24h persisted caches were meant to be the safety net. They are not, on
 * this box: localStorage sits at 4.76 MB of a ~5 MB quota and the payloads
 * measured 1.27 MB (root profile) and 1.72 MB (season segment), so every
 * `writePersisted` throws QuotaExceededError, its retry has no other TRN entry
 * to evict, and the error is swallowed. Verified directly: after 40+ successful
 * season fetches, `recon_trn_cache_v1:profile:*` and `season:*` were still
 * absent while the small `matches:*` entry persisted. So each realm re-fetched
 * the local account on every refresh, indefinitely. That cache lives in trn.ts
 * and is not this change's to fix.
 *
 * So the duplicated work is stopped here instead: the TRN enrichment runs in
 * ONE realm and its result is broadcast to the others. Deliberately NOT a
 * longer `TRN_MEMO_TTL_MS` — that would make live lobby stats stale, which is
 * the reason it is 10s.
 *
 * The hand-off is a Tauri event, which is the mechanism this codebase already
 * uses for cross-realm state (`recon:live-match-sync`, consumed at
 * OverlayView.tsx:679 with the same non-regressing-merge rule). localStorage was
 * the first choice and is NOT usable: the same quota above makes the 938 KB
 * tracker snapshot fail to write, so it cannot carry anything. Only the TRN
 * fields travel — `detailsById` is 928 KB of that snapshot and the overlay
 * already derives its own from Riot-local match details, which is not the
 * rate-limited path this fixes.
 *
 * `ownsRefresh` gates the enrichment, NOT the whole refresh: the overlay keeps
 * its own account/Riot-local reads so `profile`, `games` and `detailsById`
 * behave exactly as before, and only the duplicated TRN calls stop. */
const ownsRefresh = (): boolean => {
  try {
    // Same probe App.tsx uses to tell the overlay route apart.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const label = (window as any).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
    // No Tauri (browser preview, the marketing-site embed) → own it, exactly as
    // before: one realm there, so nothing is duplicated.
    return label !== 'overlay';
  } catch {
    return true;
  }
};

/** Broadcast the enriched TRN fields to the other realms. Fired once per
 *  refresh, after the enrichment settles — not per render, and not per fetch. */
async function broadcastTrn(payload: {
  trn: TrnActStats | null;
  trnAgents: TrnAgentStat[];
  trnMaps: TrnMapStat[];
  trnPrev: Record<string, { kd: number; matches: number }>;
  trnMatchTrs: Record<string, number>;
}): Promise<void> {
  try {
    if (!isTauri()) return;
    const { emit } = await import('@tauri-apps/api/event');
    await emit('recon:tracker-trn', payload);
  } catch {
    /* No event bus (browser preview): every realm runs its own enrichment. */
  }
}

/** Non-regressing merge, the rule `recon:live-match-sync` already uses: only
 *  replace a field when the incoming one actually carries data, so a late or
 *  poorer broadcast can never blank a field the realm already filled. */
function mergeTrnBroadcast(p: {
  trn: TrnActStats | null;
  trnAgents: TrnAgentStat[];
  trnMaps: TrnMapStat[];
  trnPrev: Record<string, { kd: number; matches: number }>;
  trnMatchTrs: Record<string, number>;
}): void {
  const next: Partial<TrackerData> = {};
  if (p.trn) next.trn = p.trn;
  if (p.trnAgents?.length) next.trnAgents = p.trnAgents;
  if (p.trnMaps?.length) next.trnMaps = p.trnMaps;
  if (p.trnPrev && Object.keys(p.trnPrev).length) next.trnPrev = p.trnPrev;
  if (p.trnMatchTrs && Object.keys(p.trnMatchTrs).length) next.trnMatchTrs = p.trnMatchTrs;
  if (Object.keys(next).length > 0) updateStore(next);
}

export async function triggerGlobalRefresh(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      await runRefresh();
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function performGlobalRefresh(): Promise<void> {
  resetTrnCooldown();
  const livePromise = fetchLiveMatchState(undefined, true).catch(() => null);
  const trackerPromise = triggerGlobalRefresh().catch(() => {});

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('recon:global-refresh'));
  }

  try {
    const { isTauri } = await import('../utils/ipc');
    if (isTauri()) {
      const { emit } = await import('@tauri-apps/api/event');
      emit('recon:global-refresh', { at: Date.now() }).catch(() => {});
    }
  } catch {}

  const [liveSettled] = await Promise.allSettled([livePromise, trackerPromise]);
  // Feed the fresh lobby straight to the overlay + live views instead of
  // discarding it — otherwise they sit stale until their next poll interval.
  const live = liveSettled.status === 'fulfilled' ? liveSettled.value : null;
  if (live && live.phase !== 'idle') {
    try {
      const { isTauri } = await import('../utils/ipc');
      if (isTauri()) {
        const { emit } = await import('@tauri-apps/api/event');
        emit('recon:live-match-sync', live).catch(() => {});
      }
    } catch {}
  }
}

async function runRefresh(): Promise<void> {
  // 1. Fast <0.1ms lockfile check: is Riot Client actually running?
  const running = await isRiotClientRunning();
  if (!running) {
    /* Browser preview (the marketing site embeds this exact app): there is no
       local Riot client to talk to, so the "client closed" chrome would be
       noise. Skip it, but still load the public static metadata from
       valorant-api.com — that is what fills season/act names, rank crests and
       agent portraits, and it needs no game session.

       The persisted snapshot is re-read here rather than trusted from memory:
       the host page seeds localStorage, and a store hydrated before that seed
       landed would otherwise keep rendering stale values. */
    const fresh = readSnapshot();
    const profileNow = fresh?.profile ?? store.profile;
    const hasData = Boolean(profileNow);

    if (!isTauri() && hasData) {
      const gd = await gameData().catch(() => null);
      updateStore({
        clientClosed: false,
        isLoading: false,
        ready: true,
        hasCached: true,
        banner: null,
        ...(fresh
          ? {
              profile: fresh.profile ?? store.profile,
              games: fresh.games ?? [],
              agg: fresh.agg ?? null,
              mapById: fresh.mapById ?? {},
              queueById: fresh.queueById ?? {},
              trn: fresh.trn ?? null,
              trnAgents: fresh.trnAgents ?? [],
              trnMaps: fresh.trnMaps ?? [],
              trnPrev: fresh.trnPrev ?? {},
              trnMatchTrs: fresh.trnMatchTrs ?? {},
              detailsById: fresh.detailsById ?? {},
              detailsReady: fresh.detailsReady ?? 0,
              detailsTotal: fresh.games?.length ?? 0,
            }
          : {}),
        ...(gd
          ? {
              seasonNames: gd.seasons,
              seasonOrder: gd.seasonOrder,
              tierIcons: gd.tierIcons,
              agentInfo: gd.agentInfo,
              weapons: gd.weapons,
            }
          : {}),
      });
      return;
    }

    // If we have cached data, keep showing it peacefully without wiping anything!
    updateStore({
      clientClosed: true,
      isLoading: false,
      ready: hasData,
      hasCached: hasData,
      banner: hasData ? null : 'Riot Client is closed — launch Riot Client or Valorant to track stats.',
    });
    return;
  }

  // Riot Client is running — proceed with background refresh
  updateStore({
    isLoading: true,
    clientClosed: false,
  });

  try {
    const liveAcc = await detectLocalAccount();
    const prevPuuid = store.profile?.puuid ?? readCachedAccount()?.puuid;

    // Account switched: different PUUID!
    if (prevPuuid && liveAcc.puuid && prevPuuid.toLowerCase() !== liveAcc.puuid.toLowerCase()) {
      clearAccountSnapshot(prevPuuid);
      const newSnap = readSnapshot(liveAcc.puuid);
      if (newSnap?.profile) {
        updateStore({
          profile: newSnap.profile,
          games: newSnap.games ?? [],
          agg: newSnap.agg ?? null,
          mapById: newSnap.mapById ?? {},
          queueById: newSnap.queueById ?? {},
          trn: newSnap.trn ?? null,
          trnAgents: newSnap.trnAgents ?? [],
          trnMaps: newSnap.trnMaps ?? [],
          trnPrev: newSnap.trnPrev ?? {},
          trnMatchTrs: newSnap.trnMatchTrs ?? {},
          detailsById: newSnap.detailsById ?? {},
          detailsReady: newSnap.detailsReady ?? 0,
          detailsTotal: newSnap.games?.length ?? 0,
          ready: true,
          hasCached: true,
        });
      } else {
        updateStore({
          profile: null,
          games: [],
          agg: null,
          mapById: {},
          queueById: {},
          trn: null,
          trnAgents: [],
          trnMaps: [],
          trnPrev: {},
          trnMatchTrs: {},
          detailsById: {},
          detailsReady: 0,
          detailsTotal: 0,
          ready: false,
          hasCached: false,
        });
      }
    }

    const region = await detectRegion();
    const accName = liveAcc.game_name;
    const accTag = liveAcc.tagline;

    const [prof, comp, gd, meta] = await Promise.all([
      fetchMmrDirect(region, accName, accTag),
      fetchCompetitiveUpdates(region, 20),
      gameData(),
      fetchHistoryMeta(region, 0, 20).catch(() => ({ total: 0, queueById: {} as Record<string, string> })),
    ]);

    const mm: Record<string, string> = {};
    for (const g of comp) mm[g.matchId] = shortMapName(g.mapId, gd.maps);

    const fullProfile = { ...prof, name: accName, tag: accTag };

    updateStore({
      profile: fullProfile,
      games: comp,
      mapById: mm,
      queueById: meta.queueById,
      seasonNames: gd.seasons,
      seasonOrder: gd.seasonOrder,
      tierIcons: gd.tierIcons,
      agentInfo: gd.agentInfo,
      weapons: gd.weapons,
      ready: true,
      hasCached: true,
      clientClosed: false,
      banner: null,
    });

    /* One snapshot writer, called again as the async enrichment lands. The
     * cross-realm hand-off depends on it: the overlay adopts whatever the
     * owner last wrote, so a snapshot taken before `fetchTrnAgents` resolved
     * would hand over empty `trnAgents`/`trnMaps` and never correct itself.
     * `store.*` is read fresh on every call, so each write is the whole
     * current state, never a stale partial. */
    const saveSnapshot = (): void =>
      writeSnapshot({
        savedAt: Date.now(),
        puuid: prof.puuid || liveAcc.puuid,
        profile: fullProfile,
        games: comp,
        agg: store.agg,
        mapById: mm,
        queueById: meta.queueById,
        trn: store.trn,
        trnAgents: store.trnAgents,
        trnMaps: store.trnMaps,
        trnPrev: store.trnPrev,
        trnMatchTrs: store.trnMatchTrs,
        detailsById: store.detailsById,
        detailsReady: store.detailsReady,
      });
    saveSnapshot();

    // Background TRN enrichment (best-effort). ONE realm runs this and
    // broadcasts the result; the others used to repeat the identical calls for
    // the same local account (see `ownsRefresh`). The promises are collected
    // rather than just fired, so the broadcast can wait for the SAME in-flight
    // requests instead of re-calling them just to learn when they finished.
    const enrichment: Promise<unknown>[] = [];
    if (accName && ownsRefresh()) {
      enrichment.push(
        fetchTrnActStats(accName, accTag, prof.currentSeasonId)
          .then(({ stats }) => updateStore({ trn: stats }))
          .catch(() => {})
      );
      enrichment.push(
        fetchTrnMatches(accName, accTag)
          .then((matchTrs) => updateStore({ trnMatchTrs: matchTrs }))
          .catch(() => {})
      );
      if (prof.currentSeasonId) {
        enrichment.push(
          fetchTrnAgents(accName, accTag, prof.currentSeasonId)
            .then((agents) => updateStore({ trnAgents: agents }))
            .catch(() => {})
        );
        enrichment.push(
          fetchTrnMaps(accName, accTag, prof.currentSeasonId)
            .then((maps) => updateStore({ trnMaps: maps }))
            .catch(() => {})
        );
      }
    }

    // Previous act K/D. Inside the same ownership guard as the block above on
    // purpose: this is 3 more `fetchTrnActStats` calls for the SAME local
    // account, and leaving it out is exactly how the overlay kept re-fetching
    // season segments after the first half of the duplication was closed.
    if (accName && ownsRefresh()) {
      const played = new Set(prof.seasons.filter((s) => s.games > 0).map((s) => s.id.toLowerCase()));
      const order = gd.seasonOrder.length > 0 ? gd.seasonOrder : [...played];
      const prev = order
        .filter((id) => id !== prof.currentSeasonId.toLowerCase() && played.has(id))
        .slice(0, 3);
      enrichment.push(
        Promise.all(
          prev.map((sid) =>
            fetchTrnActStats(accName, accTag, sid)
              .then(({ stats }) => ({ sid, kd: stats.kd, matches: stats.wins + stats.losses + stats.ties }))
              .catch(() => null)
          )
        ).then((res) => {
          const m: Record<string, { kd: number; matches: number }> = {};
          for (const r of res) if (r) m[r.sid] = { kd: r.kd, matches: r.matches };
          updateStore({ trnPrev: m });
        })
      );
    }

    // Re-publish once the TRN enrichment has settled, so a non-owner realm (the
    // overlay) adopts agents/maps/matches instead of running the same calls
    // itself. Never rejects: every branch above already swallows its own error,
    // and a failed broadcast just means the next refresh sends it again.
    void Promise.allSettled(enrichment).then(() => {
      saveSnapshot();
      if (ownsRefresh()) {
        void broadcastTrn({
          trn: store.trn,
          trnAgents: store.trnAgents,
          trnMaps: store.trnMaps,
          trnPrev: store.trnPrev,
          trnMatchTrs: store.trnMatchTrs,
        });
      }
    });

    // Match details
    const puuid = prof.puuid;
    const ids = comp.map((g) => g.matchId).filter(Boolean);
    updateStore({ detailsTotal: ids.length });
    if (puuid && ids.length > 0) {
      enrichment.push(
        aggregateDetails(region, ids, puuid)
          .then(({ agg: a, byId }) => {
            updateStore({
              agg: a,
              detailsById: byId,
              detailsReady: Object.keys(byId).length,
            });
            // `saveSnapshot` reads `store.*`, which the updateStore above has
            // already folded in, so this publishes the details without a second
            // copy of the snapshot literal.
            saveSnapshot();
          })
          .catch(() => {})
      );
    }
  } catch (e) {
    // If live fetch fails, we keep the cached profile/games intact!
    updateStore({
      banner: String(e instanceof Error ? e.message : e),
    });
  } finally {
    updateStore({ isLoading: false });
  }
}

/** Single shared tracker hook. Returns synchronous state from module store. */
export function useTrackerData(): TrackerData {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    // Auto-refresh once per session on mount, but never on every tab switch!
    if (!hasAutoRefreshed) {
      hasAutoRefreshed = true;
      triggerGlobalRefresh();
    }
  }, []);

  /* Non-owner realms take their TRN enrichment from the owner's broadcast
   * instead of repeating the calls. Registered once per realm (the same guard
   * as the auto-refresh above, and the same reason: 7 call sites share this
   * hook). The owner neither listens nor needs to. */
  useEffect(() => {
    if (ownsRefresh() || !isTauri()) return;
    let alive = true;
    let un: (() => void) | undefined;
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<Parameters<typeof mergeTrnBroadcast>[0]>('recon:tracker-trn', (ev) => {
          if (alive && ev.payload) mergeTrnBroadcast(ev.payload);
        })
      )
      .then((fn) => {
        if (alive) un = fn;
        // Unmounted before the listener resolved: do not leak it.
        else fn();
      })
      .catch(() => {
        /* No event bus: this realm simply stays on its own (un-enriched) data. */
      });
    return () => {
      alive = false;
      try {
        un?.();
      } catch {}
    };
  }, []);

  return state;
}
