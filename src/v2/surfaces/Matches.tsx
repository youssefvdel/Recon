import React, { useEffect, useMemo, useState } from 'react';
import { useTrackerData } from '../../hooks/useTrackerData';
import { MatchDetailBody } from '../../components/matches/MatchDetailBody';
import { Row } from '../matches/Row';

/** Matches, list only: hairline rows in the reading column, one expansion in
 *  place. The body is reused unchanged — this commit does not touch it. */
export const Matches: React.FC = () => {
  const { profile, games, mapById, detailsById, agentInfo, tierIcons, queueById } = useTrackerData();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState('All');
  const [mapFilter, setMapFilter] = useState('All');

  /* The Overview feed asks for a specific match; adopt it on arrival. */
  useEffect(() => {
    const onGoto = (e: Event) => {
      const id = (e as CustomEvent<{ matchId?: string }>).detail?.matchId;
      if (id) setExpandedId(id);
    };
    window.addEventListener('recon:goto-match', onGoto);
    return () => window.removeEventListener('recon:goto-match', onGoto);
  }, []);

  const rows = useMemo(() => {
    const puuid = profile?.puuid?.toLowerCase() ?? '';
    return [...(games ?? [])]
      .sort((a, b) => (b.when ?? 0) - (a.when ?? 0))
      .map((g) => {
        const d = detailsById?.[g.matchId];
        const me = d?.players?.find((p) => p.puuid?.toLowerCase() === puuid);
        const team = me?.team;
        const mine = team ? d?.teamScore?.[team] : undefined;
        const theirs = team ? d?.teamScore?.[team === 'Blue' ? 'Red' : 'Blue'] : undefined;
        return {
          game: g,
          id: g.matchId,
          map: mapById?.[g.matchId],
          agent: me?.agent,
          score: mine !== undefined && theirs !== undefined ? `${mine}–${theirs}` : undefined,
          result:
            mine !== undefined && theirs !== undefined
              ? ((mine > theirs ? 'W' : mine < theirs ? 'L' : 'D') as 'W' | 'L' | 'D')
              : undefined,
        };
      })
      .filter((r) => (agentFilter === 'All' ? true : r.agent === agentFilter))
      .filter((r) => (mapFilter === 'All' ? true : r.map === mapFilter));
  }, [games, detailsById, mapById, profile?.puuid, agentFilter, mapFilter]);

  const agents = useMemo(
    () => ['All', ...new Set(rows.map((r) => r.agent).filter((a): a is string => Boolean(a)))],
    [rows]
  );
  const maps = useMemo(
    () => ['All', ...new Set(rows.map((r) => r.map).filter((m): m is string => Boolean(m)))],
    [rows]
  );

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 pb-2">
        <h2 className="text-sm font-semibold">Match History</h2>
        <span className="text-xs ml-auto" style={{ color: 'var(--on-surface-muted)' }}>
          {rows.length} matches
        </span>
        <select
          aria-label="Agent filter"
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="text-xs bg-transparent"
          style={{ color: 'var(--on-surface-muted)' }}
        >
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select
          aria-label="Map filter"
          value={mapFilter}
          onChange={(e) => setMapFilter(e.target.value)}
          className="text-xs bg-transparent"
          style={{ color: 'var(--on-surface-muted)' }}
        >
          {maps.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {rows.map((r) => (
        <React.Fragment key={r.id}>
          <Row
            when={r.game.when}
            map={r.map}
            score={r.score}
            result={r.result}
            agent={r.agent}
            open={expandedId === r.id}
            onToggle={() => setExpandedId((prev) => (prev === r.id ? null : r.id))}
          />
          {expandedId === r.id && detailsById?.[r.id] && (
            <div className="py-3">
              <MatchDetailBody
                isOpen
                onClose={() => setExpandedId(null)}
                detail={detailsById[r.id]}
                game={r.game}
                seasonId={profile?.currentSeasonId}
                mapName={r.map ?? ''}
                queue={queueById?.[r.id] ?? 'competitive'}
                puuid={profile?.puuid ?? ''}
                tierIcons={tierIcons ?? {}}
                agentInfo={agentInfo ?? {}}
              />
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
};
