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

    // Write latest snapshot
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

    // Background TRN enrichment (best-effort)
    if (accName) {
      fetchTrnActStats(accName, accTag, prof.currentSeasonId)
        .then(({ stats }) => updateStore({ trn: stats }))
        .catch(() => {});
      fetchTrnMatches(accName, accTag)
        .then((matchTrs) => updateStore({ trnMatchTrs: matchTrs }))
        .catch(() => {});
      if (prof.currentSeasonId) {
        fetchTrnAgents(accName, accTag, prof.currentSeasonId)
          .then((agents) => updateStore({ trnAgents: agents }))
          .catch(() => {});
        fetchTrnMaps(accName, accTag, prof.currentSeasonId)
          .then((maps) => updateStore({ trnMaps: maps }))
          .catch(() => {});
      }
    }

    // Previous act K/D
    {
      const played = new Set(prof.seasons.filter((s) => s.games > 0).map((s) => s.id.toLowerCase()));
      const order = gd.seasonOrder.length > 0 ? gd.seasonOrder : [...played];
      const prev = order
        .filter((id) => id !== prof.currentSeasonId.toLowerCase() && played.has(id))
        .slice(0, 3);
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
      });
    }

    // Match details
    const puuid = prof.puuid;
    const ids = comp.map((g) => g.matchId).filter(Boolean);
    updateStore({ detailsTotal: ids.length });
    if (puuid && ids.length > 0) {
      aggregateDetails(region, ids, puuid)
        .then(({ agg: a, byId }) => {
          updateStore({
            agg: a,
            detailsById: byId,
            detailsReady: Object.keys(byId).length,
          });
          writeSnapshot({
            savedAt: Date.now(),
            puuid: prof.puuid || liveAcc.puuid,
            profile: fullProfile,
            games: comp,
            agg: a,
            mapById: mm,
            queueById: meta.queueById,
            trn: store.trn,
            trnAgents: store.trnAgents,
            trnMaps: store.trnMaps,
            trnPrev: store.trnPrev,
            trnMatchTrs: store.trnMatchTrs,
            detailsById: byId,
            detailsReady: Object.keys(byId).length,
          });
        })
        .catch(() => {});
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

  return state;
}
