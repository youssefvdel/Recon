import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { LiveMatchState } from '../types';
import { isTauri } from '../utils/ipc';
import { peekLiveMatchState } from '../utils/tracker';

/** Same predicate the TopBar LIVE pill uses: a real lobby, not the previous match. */
const isLive = (s: LiveMatchState | null | undefined): boolean =>
  !!s &&
  !s.isPreviousMatch &&
  (s.phase === 'pregame' || s.phase === 'coregame') &&
  (s.blueTeam.length > 0 || s.redTeam.length > 0);

/** True while a pregame/coregame lobby is live.
 *
 * One shared signal for the TopBar LIVE pill and the Tracker tab's live dot,
 * fed by the `recon:live-match-sync` bus, so the two can never disagree. */
export function useLiveMatchActive(): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    let alive = true;
    try {
      if (alive) setActive(isLive(peekLiveMatchState()));
    } catch {
      /* no cached lobby — stay off */
    }
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      listen<LiveMatchState>('recon:live-match-sync', (event) => {
        if (alive && event.payload) setActive(isLive(event.payload));
      })
        .then((fn) => {
          unlisten = fn;
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
      if (unlisten) unlisten();
    };
  }, []);

  return active;
}
