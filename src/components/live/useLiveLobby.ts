import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { LiveMatchState } from '../../types';
import {
  fetchLiveMatchState,
  peekLiveMatchState,
  gameData,
  matchEndHarvest,
  harvestMatchNames,
  isMatchStateEqual,
  mergeLiveMatchStateNonRegressing,
} from '../../utils/tracker';
import { isTauri } from '../../utils/ipc';
import { useSeasonNames } from '../../hooks/useTrackerData';

/** The live lobby's data layer, lifted out of the old page shell so the surface
 *  is pure presentation. Behaviour is unchanged: same 3s poll, same
 *  non-regressing merge with the overlay window, same harvest on match end.
 *
 *  Nothing here renders, and it owns no keydown, no dialog and no scroll. */
export interface LiveLobby {
  state: LiveMatchState | null;
  tierIcons: Record<number, string>;
  seasonNames: Record<string, string>;
}

export function useLiveLobby(): LiveLobby {
  /* Seeded from the last known lobby so the first paint already has data: a
   * null start made the old view flash its empty state on every visit. */
  const [state, setState] = useState<LiveMatchState | null>(() => peekLiveMatchState());
  const [tierIcons, setTierIcons] = useState<Record<number, string>>({});
  const prevStateRef = useRef<LiveMatchState | null>(null);
  const seasonNames = useSeasonNames();

  const loadState = useCallback(async () => {
    try {
      const fresh = await fetchLiveMatchState(undefined, true);
      /* A forced read that comes back idle WITH an error is "we could not ask",
       * not "there is no match": the Riot client is unreachable, so the seeded
       * lobby is still the best evidence we have. Replacing it would blank a
       * live match on a failed poll. */
      if (fresh?.phase === 'idle' && fresh.error) return;
      setState(fresh);
    } catch {
      /* a failed first read leaves the previous state in place */
    }
  }, []);

  useEffect(() => {
    gameData()
      .then((d) => setTierIcons(d.tierIcons))
      .catch(() => {});
    void loadState();
  }, [loadState]);

  useEffect(() => {
    const poll = () => {
      fetchLiveMatchState()
        .then((s) => {
          // Match just ended: hidden names are released by Riot only now.
          const harvest = matchEndHarvest(prevStateRef.current, s);
          if (harvest) harvestMatchNames(harvest).catch(() => {});
          if (!isMatchStateEqual(prevStateRef.current, s)) {
            prevStateRef.current = s;
            setState(s);
          }
        })
        .catch(() => {});
    };

    const onGlobalRefresh = () => {
      fetchLiveMatchState(undefined, true)
        .then((s) => {
          prevStateRef.current = s;
          setState(s);
        })
        .catch(() => {});
    };
    window.addEventListener('recon:global-refresh', onGlobalRefresh);

    /* A background tab does not need to poll; coming back to it does. */
    const onVis = () => {
      if (typeof document !== 'undefined' && !document.hidden) poll();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVis);
      window.addEventListener('focus', onVis);
    }

    const unlistenSync = isTauri()
      ? listen<LiveMatchState>('recon:live-match-sync', (event) => {
          if (!event.payload) return;
          const s = event.payload;
          const harvest = matchEndHarvest(prevStateRef.current, s);
          if (harvest) harvestMatchNames(harvest).catch(() => {});
          // The overlay runs its own poll and TRN cache, so `s` can be poorer
          // than what we show. Merge instead of replacing, or the two realms
          // ping-pong for the whole match.
          const merged = mergeLiveMatchStateNonRegressing(prevStateRef.current, s);
          if (!isMatchStateEqual(prevStateRef.current, merged)) {
            prevStateRef.current = merged;
            setState(merged);
          }
        })
      : null;

    // Riot-local endpoints have no rate limit: 3s lobby poll.
    const interval = setInterval(poll, 3000);
    return () => {
      clearInterval(interval);
      window.removeEventListener('recon:global-refresh', onGlobalRefresh);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('focus', onVis);
      }
      unlistenSync?.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return { state, tierIcons, seasonNames };
}
