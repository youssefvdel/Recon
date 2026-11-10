import React, { useEffect, useMemo, useState } from 'react';
import { useTrackerData } from '../../hooks/useTrackerData';
import { LiveSection } from '../../components/live/LiveSection';

/** Now: the live strip (reused, not rebuilt) plus the act record and the recent
 *  match feed. Same hooks, same data path — only the presentation is v2. */
export const Now: React.FC = () => {
  const { profile, seasonNames, games, mapById, detailsById, trn, trnFetchedAt } = useTrackerData();

  const actLabel = seasonNames?.[profile?.currentSeasonId?.toLowerCase() ?? ''] ?? 'Current Act';
  const record =
    trn && trn.wins !== undefined && trn.losses !== undefined ? `${trn.wins}–${trn.losses}` : undefined;
  /* A clock, not a call to Date.now() during render: the latter is impure (two
   * renders of the same state can disagree) and the age would only change when
   * something else happened to re-render. One tick a minute is the resolution
   * the label shows. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const age = trnFetchedAt ? Math.round((now - trnFetchedAt) / 3_600_000) : undefined;

  const feed = useMemo(() => {
    const list = [...(games ?? [])].sort((a, b) => (b.when ?? 0) - (a.when ?? 0)).slice(0, 5);
    return list.map((g) => {
      const d = detailsById?.[g.matchId];
      const me = d?.players?.find((p) => p.puuid?.toLowerCase() === profile?.puuid?.toLowerCase());
      const team = me?.team;
      const mine = team ? d?.teamScore?.[team] : undefined;
      const theirs = team ? d?.teamScore?.[team === 'Blue' ? 'Red' : 'Blue'] : undefined;
      return {
        id: g.matchId,
        map: mapById?.[g.matchId] ?? '',
        score: mine !== undefined && theirs !== undefined ? `${mine}–${theirs}` : '',
        result: mine !== undefined && theirs !== undefined ? (mine > theirs ? 'W' : mine < theirs ? 'L' : 'D') : '',
        agent: me?.agent ?? '',
      };
    });
  }, [games, detailsById, mapById, profile?.puuid]);

  return (
    <div className="flex flex-col gap-6">
      <LiveSection />

      <section>
        <p className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--on-surface-muted)' }}>
          {actLabel}
        </p>
        <div className="flex items-baseline gap-3">
          <span className="text-4xl font-black tabular-nums" style={{ color: 'var(--on-surface)' }}>
            {record ?? ''}
          </span>
          {age !== undefined && (
            <span className="text-xs" style={{ color: 'var(--on-surface-muted)' }}>
              as of {age}h ago
            </span>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--on-surface-muted)' }}>
          Recent matches
        </h2>
        {feed.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--on-surface-muted)' }}>
            No matches cached.
          </p>
        ) : (
          feed.map((r) => (
            <div
              key={r.id}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-4 py-2 border-b text-sm"
              style={{ borderColor: 'var(--outline)', color: 'var(--on-surface)' }}
            >
              <span className="truncate">{r.map || 'Unknown map'}</span>
              <span className="tabular-nums" style={{ color: 'var(--on-surface-muted)' }}>
                {r.score}
              </span>
              <span
                className="text-xs font-bold"
                style={{
                  color:
                    r.result === 'W' ? 'var(--positive)' : r.result === 'L' ? 'var(--negative)' : 'var(--on-surface-muted)',
                }}
              >
                {r.result}
              </span>
            </div>
          ))
        )}
      </section>
    </div>
  );
};
