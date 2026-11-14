/* One `recon:live-facts` subscription per window, shared by every consumer.
 *
 * The Rust live service already polls Riot's loopback presences (Phase 0). The
 * HUD and the lobby board both want those facts, so they must not each attach
 * their own listener: this module owns the single `listen`, fans the parsed
 * facts out to subscribers, and remembers when the last good event arrived.
 * That timestamp is what lets the intervals know the event stream is covering
 * the same source, so they can skip their own fetch.
 *
 * React-free except for the thin `useLiveFacts` wrapper.
 */

import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauri } from '../utils/ipc';
import {
  LIVE_FACTS_ENABLED,
  LIVE_FACTS_EVENT,
  factsStamp,
  parseLiveFacts,
  shouldSkipFallbackFetch,
  type LiveFacts,
} from './facts';

type FactsHandler = (facts: LiveFacts) => void;

const handlers = new Set<FactsHandler>();
/** When the last *valid* fact set arrived. Malformed payloads do not stamp:
 *  they must not keep the fallback quiet. */
let lastFactsAt = 0;
/** Last phase we saw, so a transition can open the fallback gate once. */
let lastPhase: string | null = null;
let attached: Promise<UnlistenFn> | null = null;

/** Epoch ms of the last fact event this window accepted, 0 if none yet. */
export function lastLiveFactsAt(): number {
  return lastFactsAt;
}

/** True when an interval tick should skip its fetch: a fact arrived within the
 *  last `LIVE_FACTS_STALE_MS`, so the Rust poller already asked. */
export function skipLiveFactsFallbackFetch(now: number = Date.now()): boolean {
  return shouldSkipFallbackFetch(lastFactsAt, now);
}

/**
 * Attach `handler` to the shared facts stream. The first subscriber opens the
 * Tauri listener; the last one closes it. Returns the unsubscribe function.
 */
export function subscribeLiveFacts(handler: FactsHandler): () => void {
  handlers.add(handler);
  if (!attached && isTauri()) {
    let pending: Promise<UnlistenFn>;
    pending = listen<unknown>(LIVE_FACTS_EVENT, (event) => {
      const facts = parseLiveFacts(event.payload);
      if (!facts) return;
      lastFactsAt = factsStamp(lastPhase, facts.phase, Date.now());
      lastPhase = facts.phase;
      // Snapshot: a handler may unsubscribe while the loop runs.
      for (const h of [...handlers]) h(facts);
    })
      .then((unlisten) => {
        // Superseded by a newer subscription, or everyone left before the IPC
        // round-trip answered: close this stream instead of leaving a duplicate
        // that fans the same events out twice.
        if (attached !== pending || handlers.size === 0) {
          unlisten();
          if (attached === pending) attached = null;
        }
        return unlisten;
      })
      .catch(() => {
        // No IPC (dev:ui raced a Tauri check): intervals simply never skip.
        if (attached === pending) attached = null;
        return () => {};
      });
    attached = pending;
  }
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0 && attached) {
      const pending = attached;
      attached = null;
      pending.then((fn) => fn()).catch(() => {});
    }
  };
}

/** Subscribe a component to the fact stream. The handler is kept in a ref, so
 *  an inline callback does not resubscribe on every render. */
export function useLiveFacts(
  handler: FactsHandler,
  enabled: boolean = LIVE_FACTS_ENABLED
): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  }, [handler]);
  useEffect(() => {
    if (!enabled) return;
    return subscribeLiveFacts((facts) => ref.current(facts));
  }, [enabled]);
}
