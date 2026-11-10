import React, { useEffect, useState } from 'react';
import type { LiveMatchPlayer } from '../../types';
import { queueLabel } from '../../utils/tracker';
import { useLiveLobby } from './useLiveLobby';
import { LiveStrip } from './LiveStrip';
import { LobbyRow } from './LobbyRow';

/** The live lobby as the top of the Overview feed — not a destination.
 *
 *  Renders nothing when there are no teams, so an idle client leaves the page
 *  exactly as it was. No keydown, no dialog, no inner scroll: the page owns the
 *  only scroll, and the strip is the only sticky element. */
export const LiveSection: React.FC = () => {
  const { state, tierIcons, seasonNames } = useLiveLobby();
  /* Ages are relative, so the section needs a clock of its own. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const blue = state?.blueTeam ?? [];
  const red = state?.redTeam ?? [];
  if (!state || (blue.length === 0 && red.length === 0)) return null;

  const flat = Boolean(state.isDeathmatch || state.isRange);
  const all = [...blue, ...red];

  /* Party size by id across both teams; solo players carry no bracket. */
  const partyCounts = new Map<string, number>();
  for (const p of all) {
    if (p.partyId) partyCounts.set(p.partyId, (partyCounts.get(p.partyId) ?? 0) + 1);
  }
  const partyOf = (p: LiveMatchPlayer): number => (p.partyId ? partyCounts.get(p.partyId) ?? 1 : 0);

  const group = (title: string, players: LiveMatchPlayer[]) =>
    players.length > 0 && (
      <div key={title}>
        <div className="pt-4 pb-1 text-micro font-mono uppercase tracking-[0.18em] text-m3-outline">
          {title} · {players.length}
        </div>
        {players.map((p) => (
          <LobbyRow
            key={p.puuid}
            player={p}
            partyCount={partyOf(p)}
            tierIcons={tierIcons}
            seasonNames={seasonNames}
            now={now}
          />
        ))}
      </div>
    );

  return (
    <section aria-label="Live lobby">
      <LiveStrip state={state} queueLabel={state.queueId ? queueLabel(state.queueId) : undefined} />

      {flat ? (
        <div>
          <div className="pt-4 pb-1 text-micro font-mono uppercase tracking-[0.18em] text-m3-outline">
            {state.isRange ? 'The range' : 'Deathmatch'} · {all.length}
          </div>
          {all.map((p) => (
            <LobbyRow
              key={p.puuid}
              player={p}
              partyCount={partyOf(p)}
              tierIcons={tierIcons}
              seasonNames={seasonNames}
              now={now}
            />
          ))}
        </div>
      ) : (
        <>
          {group('Your team', blue)}
          {group('Enemy', red)}
          {red.length === 0 && state.phase === 'pregame' && (
            <p className="py-2 text-micro font-mono text-m3-outline">
              Enemy picks hidden during agent select
            </p>
          )}
        </>
      )}
    </section>
  );
};
