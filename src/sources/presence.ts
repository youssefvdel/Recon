/* Riot-local presence: the only source that tells Competitive from Unrated,
 * and the fast hint the fill uses to decide pregame vs coregame.
 *
 * Moved verbatim out of utils/tracker.ts so the fill orchestrator can leave
 * tracker without reaching back into it. */

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../utils/ipc';
import { trnLog, setTrnMatchPhase } from '../utils/trn';
import { getEntitlements } from './riot';

export function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Presence loop → proxy hint. Positive signals only — anything else yields
 *  null so the caller leaves the hint alone (never downgrade on missing
 *  data). Pure — checked by scripts/trn-spread-check.ts. */
export function presenceLoopToPhase(loop: string): 'pregame' | 'coregame' | null {
  const l = loop.trim().toUpperCase();
  if (l === 'PREGAME') return 'pregame';
  if (l === 'INGAME') return 'coregame';
  return null;
}

/** Fast Riot-local loop state (free loopback read, no TRN). Null when
 *  unreadable — callers keep the previous hint. */
async function fetchLocalLoopState(): Promise<string | null> {
  try {
    if (!isTauri()) return null;
    const ent = await getEntitlements();
    const raw = await invoke<string>('local_presences');
    const presences: { puuid?: string; private?: string }[] = JSON.parse(raw)?.presences ?? [];
    const me = presences.find(
      (p) => String(p?.puuid ?? '').toLowerCase() === ent.puuid.toLowerCase()
    );
    if (!me?.private) return null;
    const blob = JSON.parse(decodeBase64Utf8(String(me.private)));
    const loop = String(blob?.matchPresenceData?.sessionLoopState ?? blob?.sessionLoopState ?? '');
    return loop || null;
  } catch {
    return null;
  }
}

/** Warm the proxy pause hint from Riot-local presences before the first fill
 *  of a lobby. The full poll is slow (MMR + names per player) and can arrive
 *  already in coregame; presences answer in ms, so pregame wins the race and
 *  fetches start at lobby formation. Positive signals only — true
 *  coregame-fullscreen still pauses. Never throws. */
export async function warmTrnPhaseFromPresence(): Promise<void> {
  try {
    const warmed = presenceLoopToPhase((await fetchLocalLoopState()) ?? '');
    if (warmed) {
      setTrnMatchPhase(warmed);
      if (import.meta.env.DEV) trnLog('phase warmed', warmed);
    }
  } catch {
    /* stale hint stands */
  }
}
