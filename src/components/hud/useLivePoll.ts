import { useRef, useEffect, type Dispatch, type SetStateAction } from 'react';
import type { LiveMatchState } from '../../types';
import { fetchLiveMatchState, gameData, matchEndHarvest, harvestMatchNames, isMatchStateEqual, mergeLiveMatchStateNonRegressing } from '../../utils/tracker';
import { isTauri } from '../../utils/ipc';
import { listen } from '@tauri-apps/api/event';
import { applyLiveFacts } from '../../live/facts';
import { skipLiveFactsFallbackFetch, useLiveFacts } from '../../live/useLiveFacts';

export interface UseLivePollArgs {
  setMatchState: Dispatch<SetStateAction<LiveMatchState | null>>;
  setTierIcons: Dispatch<SetStateAction<Record<number, string>>>;
  setAgentMap: Dispatch<SetStateAction<Record<string, { name: string; icon: string; role: string }>>>;
  setSeasonNames: Dispatch<SetStateAction<Record<string, string>>>;
}

/* Live-match polling body: static game data fill, 2.5s Riot-local poll with
 * hidden-tab skip and idle backoff, plus cross-window live sync. Moved
 * verbatim from HudCanvas (canvas split 2/3); cadence untouched.
 *
 * Phase 2 (`docs/live-rust-pipeline.md`): the Rust live service's
 * `recon:live-facts` events are the primary source. The interval above stays as
 * the fallback — it skips its fetch while facts are fresh (< 10s), so the same
 * loopback source is polled once, not twice. */

export function useLivePoll({ setMatchState, setTierIcons, setAgentMap, setSeasonNames }: UseLivePollArgs): void {
  // Poll live match data ONLY when visible; idle backs off to ~1/3 rate
  // (agent select lasts ~60s+, so a 13s worst-case detect delay is fine).
  const phaseRef = useRef<string>('idle');
  const prevStateRef = useRef<LiveMatchState | null>(null);
  const idleSkips = useRef(0);
  const ticking = useRef(false);
  /** When the last poll started — lets a visibility return skip a fetch that
   *  the 2.5s interval has already covered. */
  const lastFetchAt = useRef(0);
  // Facts are the primary source now; the interval is the fallback.
  useLiveFacts((facts) => {
    const merged = applyLiveFacts(prevStateRef.current, facts);
    if (!merged) return;
    // A high-confidence idle fact means the presence left the match: Riot only
    // releases hidden names now, so harvest here instead of waiting for the
    // next fetch to notice.
    const harvest = matchEndHarvest(prevStateRef.current, merged);
    if (harvest) harvestMatchNames(harvest).catch(() => {});
    if (!isMatchStateEqual(prevStateRef.current, merged)) {
      prevStateRef.current = merged;
      phaseRef.current = merged.phase;
      setMatchState(merged);
    }
  });

  useEffect(() => {
    gameData()
      .then((d) => {
        setTierIcons(d.tierIcons);
        setAgentMap(d.agentInfo || {});
        setSeasonNames(d.seasons || {});
      })
      .catch(() => {});

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      // A slow Riot round-trip must not let setInterval stack overlapping polls.
      if (ticking.current) return;
      // The Rust live service polled this same loopback source < 10s ago.
      // Skip the duplicate fetch; the interval resumes as soon as the event
      // stream goes quiet.
      if (skipLiveFactsFallbackFetch()) return;
      if (phaseRef.current === 'idle') {
        // Idle backoff: fetch every 12th tick ≈ 30s (was every 5th ≈ 12.5s).
        // Wake stays instant: the main window polls every 3s and broadcasts
        // `recon:live-match-sync` on change (listener below applies it
        // immediately), and visibility return forces a fetch via onVis.
        idleSkips.current = (idleSkips.current + 1) % 12;
        if (idleSkips.current !== 0) return;
      }
      ticking.current = true;
      lastFetchAt.current = Date.now();
      fetchLiveMatchState()
        .then((s) => {
          // Match just ended: Riot releases hidden names only now, so ask
          // name-service for the whole lobby and cache them permanently.
          const harvest = matchEndHarvest(prevStateRef.current, s);
          if (harvest) harvestMatchNames(harvest).catch(() => {});
          if (!isMatchStateEqual(prevStateRef.current, s)) {
            prevStateRef.current = s;
            phaseRef.current = s.phase;
            setMatchState(s);
          }
        })
        .catch(() => {})
        .finally(() => {
          ticking.current = false;
        });
    };

    const onVis = () => {
      if (typeof document === 'undefined' || document.hidden) return;
      // The Tab peek makes this window visible, and Chromium resumes
      // compositing on this frame. A Riot round-trip fired here lands on the
      // same frame as the first paint, which is the hitch the user feels, so
      // paint first and let the poll catch up 300ms later — imperceptible, and
      // skipped entirely when the last poll is still fresh.
      if (Date.now() - lastFetchAt.current < 2500) return;
      // Prime the idle counter so the return-from-hidden tick always fetches
      // instead of landing on a skipped slot.
      if (phaseRef.current === 'idle') idleSkips.current = 11;
      window.setTimeout(tick, 300);
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVis);
    }
    // Riot-local endpoints have no rate limit: 2.5s tick (hidden-tab skip +
    // idle backoff above stay). TRN enrichment keeps its own serial gate.
    const id = setInterval(tick, 2500);

    const unlistenSync = isTauri()
      ? listen<LiveMatchState>('recon:live-match-sync', (event) => {
          if (event.payload) {
            const s = event.payload;
            const harvest = matchEndHarvest(prevStateRef.current, s);
            if (harvest) harvestMatchNames(harvest).catch(() => {});
            // The main window runs its own poll and its own TRN cache, so `s`
            // can be poorer than what we already show. Merge instead of
            // replacing, or the two realms ping-pong for the whole match.
            const merged = mergeLiveMatchStateNonRegressing(prevStateRef.current, s);
            if (!isMatchStateEqual(prevStateRef.current, merged)) {
              prevStateRef.current = merged;
              phaseRef.current = merged.phase;
              setMatchState(merged);
            }
          }
        })
      : null;

    return () => {
      clearInterval(id);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVis);
      }
      unlistenSync?.then((fn) => fn()).catch(() => {});
    };
  }, [setMatchState, setTierIcons, setAgentMap, setSeasonNames]);
}
