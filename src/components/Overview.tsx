import React, { useEffect, useMemo, useState } from 'react';
import { useTrackerData } from '../hooks/useTrackerData';
import { fetchTrnActStats, type TrnActStats } from '../utils/trn';
import type { TrackerMatchDetail, TrackerMmrPoint } from '../types';
import { shortMapName, tierName } from '../utils/tracker';
import { Skeleton } from './primitives/Skeleton';
import { ActHeader, type ActMetric } from './primitives/ActHeader';
import { FeedRow } from './primitives/FeedRow';
import { Sparkline } from './primitives/Sparkline';
import { StatusLine } from './primitives/StatusLine';
import { MatchDetailModal } from './MatchDetailModal';
import type { Outcome } from './primitives/colors';

/* Overview, direction B ("Season Stream"): one 940px column, no cards.
 * The act record is the hero, the season is a feed, the history is a list.
 *
 * Every number here comes from the store or from a cached match detail. A
 * segment with no source is OMITTED — never a zero, a dash or an ellipsis —
 * and there is no per-day series anywhere: `games` is one entry per match, so
 * the feed is a list of matches, not a trend curve. */

export const shortAct = (label: string): string => {
  const m = label.match(/episode\s*(\d+).*?act\s*(\d+)/i);
  if (m) return `E${m[1]}A${m[2]}`;
  const a = label.match(/act\s*(\d+)/i);
  return a ? `A${a[1]}` : label;
};

const HOUR = 3_600_000;
const relAge = (when: number, now: number): string => {
  const d = now - when;
  if (!Number.isFinite(d) || d < 0) return '';
  if (d < HOUR) return `${Math.max(1, Math.round(d / 60_000))}m`;
  if (d < 24 * HOUR) return `${Math.round(d / HOUR)}h`;
  return `${Math.round(d / (24 * HOUR))}d`;
};

const myTeamIn = (detail: TrackerMatchDetail | undefined, puuid: string): string | null =>
  detail?.players?.find((p) => p.puuid?.toLowerCase() === puuid?.toLowerCase())?.team ?? null;

const PLAYLISTS = [
  { value: 'competitive', label: 'Competitive' },
  { value: 'unrated', label: 'Unrated' },
];

export const Overview: React.FC = () => {
  const { profile, seasonNames, seasonOrder, agentInfo, tierIcons, agg, trn, trnPrev, trnAgents, trnFetchedAt, games, mapById, detailsById, isLoading, clientClosed, refresh } =
    useTrackerData();

  const [playlist, setPlaylist] = useState('competitive');
  const [seasonId, setSeasonId] = useState('');
  /* Keyed by the act it was fetched for: a stale selection can never render the
   * previous act's numbers, because the key no longer matches. */
  const [selState, setSelState] = useState<{ id: string; stats: TrnActStats } | null>(null);
  const [selError, setSelError] = useState<string | null>(null);
  const [selLoading, setSelLoading] = useState(false);
  const [openMatch, setOpenMatch] = useState<TrackerMmrPoint | null>(null);
  /* Ages are relative, so the page needs a clock: one tick a minute keeps
   * "2h" from silently becoming "2h" three hours later. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const isDefault = playlist === 'competitive' && !seasonId;
  const selStats = selState && selState.id === seasonId ? selState.stats : null;
  const S = isDefault ? trn : selStats;

  /* A past act is fetched on demand, exactly as before. While it loads the page
   * shows no numbers for it rather than zeros, and a failure is one line. */
  useEffect(() => {
    if (isDefault || !profile?.name) return;
    let alive = true;
    setSelLoading(true);
    setSelError(null);
    fetchTrnActStats(profile.name, profile.tag, seasonId, playlist)
      .then((r) => alive && setSelState({ id: seasonId, stats: r.stats }))
      .catch((e) => {
        if (!alive) return;
        setSelState(null);
        setSelError(String(e?.message ?? e));
      })
      .finally(() => alive && setSelLoading(false));
    return () => {
      alive = false;
    };
  }, [isDefault, seasonId, playlist, profile?.name, profile?.tag]);

  const seasonOptions = useMemo(() => {
    if (!profile) return [];
    const current = profile.currentSeasonId?.toLowerCase();
    const played = new Set(profile.seasons?.filter((s) => s.games > 0).map((s) => s.id.toLowerCase()) ?? []);
    const order = (seasonOrder?.length ? seasonOrder : [...played]).filter((id) => id !== current && played.has(id));
    return order.map((id) => ({ value: id, label: seasonNames?.[id] ?? shortAct(id) }));
  }, [profile, seasonOrder, seasonNames]);

  /* Cached act metrics are not fresh by default: the current act's TRN blob is
   * timestamped, so an old fetch is reported as old. A past-act fetch is made on
   * selection and is self-evidently fresh. */
  const trnAge = useMemo(() => {
    if (!isDefault || !trn) return '';
    if (!trnFetchedAt) return 'date unknown';
    const d = Date.now() - trnFetchedAt;
    if (d < 0) return '';
    if (d < HOUR) return `${Math.max(1, Math.round(d / 60_000))}m ago`;
    if (d < 24 * HOUR) return `${Math.round(d / HOUR)}h ago`;
    return `${Math.round(d / (24 * HOUR))}d ago`;
  }, [isDefault, trn, trnFetchedAt, now]);

  const actLabel = isDefault
    ? seasonNames?.[profile?.currentSeasonId?.toLowerCase() ?? ''] ?? 'Current Act'
    : seasonNames?.[seasonId] ?? shortAct(seasonId);

  /* Record: the act blob when we have it, else the profile's own totals. */
  const wins = isDefault ? S?.wins ?? profile?.wins : S?.wins;
  const losses = isDefault ? S?.losses ?? (profile ? profile.games - profile.wins : undefined) : S?.losses;
  const record = wins !== undefined && losses !== undefined ? `${wins}–${losses}` : undefined;
  const winPct = isDefault
    ? S?.winPct ?? (profile && profile.games > 0 ? Math.round((profile.wins / profile.games) * 100) : undefined)
    : S?.winPct;

  const metrics: ActMetric[] = [];
  if (S?.acs !== undefined) metrics.push({ label: 'ACS', value: String(Math.round(S.acs)) });
  const kd = S?.kd ?? agg?.kd;
  if (kd !== undefined && kd > 0) metrics.push({ label: 'K/D', value: kd.toFixed(2) });
  const adr = S?.adr ?? agg?.adr;
  if (adr !== undefined && adr > 0) metrics.push({ label: 'ADR', value: String(Math.round(adr)) });
  if (S?.hsPct !== undefined && S.hsPct > 0) metrics.push({ label: 'HS', value: `${Math.round(S.hsPct)}%` });

  const rankLine = profile?.rank ? (
    <>
      {profile.rank}
      {profile.tier > 2 && profile.rr > 0 ? ` · ${profile.rr} RR` : ''}
    </>
  ) : undefined;

  const topAgent = isDefault ? trnAgents?.[0] : undefined;
  const topAgentMeta = topAgent
    ? Object.values(agentInfo ?? {}).find((a) => a.name?.toLowerCase() === topAgent.agent?.toLowerCase())
    : undefined;
  const agentLine = topAgent ? (
    <span className="inline-flex items-center gap-1.5">
      {topAgentMeta?.icon && <img src={topAgentMeta.icon} alt="" className="w-5 h-5 object-contain" />}
      <span>
        {topAgent.agent} · {topAgent.matches} games
        {topAgent.winPct > 0 ? ` · ${Math.round(topAgent.winPct)}% win` : ''}
      </span>
    </span>
  ) : undefined;

  /* Feed: one row per match, newest first. A row without a cached detail shows
   * its map and age and nothing else — no verdict, no score, no placeholder. */
  const feed = useMemo(() => {
    const list = [...(games ?? [])].sort((a, b) => (b.when ?? 0) - (a.when ?? 0)).slice(0, 5);
    return list.map((g) => {
      const detail = detailsById?.[g.matchId];
      const team = myTeamIn(detail, profile?.puuid ?? '');
      const mine = team && detail ? detail.teamScore?.[team] : undefined;
      const theirs = team && detail ? detail.teamScore?.[team === 'Blue' ? 'Red' : 'Blue'] : undefined;
      const me = detail?.players?.find((p) => p.puuid?.toLowerCase() === profile?.puuid?.toLowerCase());
      const score = mine !== undefined && theirs !== undefined ? `${mine}–${theirs}` : undefined;
      const verdict: Outcome | null =
        mine !== undefined && theirs !== undefined
          ? mine > theirs
            ? 'win'
            : mine < theirs
              ? 'loss'
              : 'draw'
          : null;
      const kda = me ? `${me.kills}/${me.deaths}/${me.assists}` : '';
      /* ACS is combat score per round — computed from the detail, never stored. */
      const acs = me && me.rounds > 0 ? Math.round(me.score / me.rounds) : undefined;
      const sub = [me?.agent, kda, acs !== undefined ? `${acs} ACS` : ''].filter(Boolean).join(' · ') || undefined;
      const rounds = detail?.rounds;
      const spark: Outcome[] = rounds && team ? rounds.map((r) => (r.winningTeam === team ? 'win' : 'loss')) : [];
      const map = mapById?.[g.matchId] ?? (g.mapId ? shortMapName(g.mapId, mapById ?? {}) : undefined);
      return { g, map, age: g.when ? relAge(g.when, now) : undefined, verdict, score, sub, spark };
    });
  }, [games, detailsById, mapById, profile?.puuid, now]);

  const history = useMemo(() => {
    if (!profile?.seasons) return [];
    const current = profile.currentSeasonId?.toLowerCase();
    const orderIdx = (id: string): number => {
      const i = seasonOrder?.indexOf(id.toLowerCase()) ?? -1;
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return profile.seasons
      .filter((s) => s.games > 0 && s.id.toLowerCase() !== current)
      .sort((a, b) => orderIdx(a.id) - orderIdx(b.id))
      .slice(0, 3)
      .map((s) => ({
        id: s.id,
        // Never the raw season id: an unknown act gets a neutral label.
        label: seasonNames?.[s.id.toLowerCase()] ?? 'Past act',
        games: s.games,
        tier: s.tier,
        kd: trnPrev?.[s.id.toLowerCase()]?.kd ?? trnPrev?.[s.id]?.kd,
      }));
  }, [profile, seasonNames, seasonOrder, trnPrev]);

  const status = selError
    ? `Could not load ${actLabel}: ${selError}`
    : clientClosed
      ? `Riot Client closed — showing cached results${
          trnAge === 'date unknown' ? ' · date unknown' : trnAge ? ` · as of ${trnAge}` : ''
        }`
      : trnAge && trnAge !== 'date unknown'
        ? `Cached act data · as of ${trnAge}`
        : trnAge === 'date unknown' && trn
          ? 'Cached act data · date unknown'
          : undefined;

  if (!profile) {
    return (
      <div className="max-w-[940px] mx-auto w-full px-6 pt-6 pb-10">
        {isLoading && !clientClosed ? (
          <Skeleton lines={3} />
        ) : (
          /* Loading that can never resolve is a lie with a spinner on it: when
           * the client is closed, say so and offer the way out. */
          <div className="flex flex-col items-start gap-3 text-xs text-m3-outline font-mono">
            <span>
              {clientClosed
                ? 'Riot Client closed — no cached profile yet. Open Riot Client and refresh.'
                : 'No Riot profile yet — open Riot Client and refresh.'}
            </span>
            <button type="button" onClick={() => refresh()} className="text-m3-primary hover:underline cursor-pointer">
              Retry
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-[940px] mx-auto w-full px-6 pt-6 pb-10 flex flex-col">
      <div className="flex items-start justify-between gap-4">
        <ActHeader
          eyebrow={[
            actLabel || (isDefault ? seasonNames?.[profile.currentSeasonId?.toLowerCase() ?? ''] ?? 'Current Act' : ''),
            PLAYLISTS.find((p) => p.value === playlist)?.label ?? '',
          ]
            .filter(Boolean)
            .join(' · ')}
          record={selLoading ? undefined : record}
          winPct={selLoading ? undefined : winPct !== undefined ? `${Math.round(winPct)}%` : undefined}
          metrics={selLoading ? [] : metrics}
          rankLine={rankLine}
          agentLine={agentLine}
        />
        <div className="flex items-center gap-3 shrink-0 pt-1 text-micro font-mono text-m3-outline">
          <select
            aria-label="Playlist"
            value={playlist}
            onChange={(e) => setPlaylist(e.target.value)}
            className="bg-transparent appearance-none cursor-pointer uppercase tracking-wider hover:text-m3-on-surface"
          >
            {PLAYLISTS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          {seasonOptions.length > 0 && (
            <select
              aria-label="Act"
              value={seasonId}
              onChange={(e) => setSeasonId(e.target.value)}
              className="bg-transparent appearance-none cursor-pointer uppercase tracking-wider hover:text-m3-on-surface"
            >
              <option value="">Current</option>
              {seasonOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <StatusLine
        reason={status}
        onRetry={() => {
          setSelError(null);
          refresh();
        }}
      />

      <section className="mt-8">
        <h2 className="text-micro font-mono uppercase tracking-[0.18em] text-m3-outline flex items-baseline justify-between">
          <span>Matches</span>
          {games?.length ? <span className="tabular-nums">{games.length}</span> : null}
        </h2>
        {feed.length === 0 ? (
          <p className="mt-3 text-micro font-mono text-m3-outline">
            No matches cached — open Riot Client to refresh.
          </p>
        ) : (
          <div className="mt-1">
            {feed.map(({ g, map, age, verdict, score, sub, spark }) => (
              <FeedRow
                key={g.matchId}
                age={age}
                map={map}
                verdict={verdict}
                score={score}
                sub={sub}
                spark={<Sparkline values={spark} />}
                onOpen={detailsById?.[g.matchId] ? () => setOpenMatch(g) : undefined}
              />
            ))}
          </div>
        )}
      </section>

      {history.length > 0 && (
        <section className="mt-8">
          <h2 className="text-micro font-mono uppercase tracking-[0.18em] text-m3-outline">Act history</h2>
          <div className="mt-1">
            {history.map((h) => (
              <div
                key={h.id}
                className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-4 py-2.5 border-b border-m3-outline-subtle/50"
              >
                <span className="flex items-center">
                  {tierIcons?.[h.tier] ? (
                    <img src={tierIcons[h.tier]} alt="" className="w-6 h-6 object-contain" />
                  ) : null}
                </span>
                <span className="text-xs text-m3-on-surface truncate">{h.label}</span>
                <span className="text-micro font-mono text-m3-outline tabular-nums">
                  {h.tier > 0 ? `${tierName(h.tier)} · ` : ''}
                  {h.games} games{h.kd ? ` · ${h.kd.toFixed(2)} K/D` : ''}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <MatchDetailModal
        isOpen={!!openMatch}
        onClose={() => setOpenMatch(null)}
        detail={openMatch ? detailsById?.[openMatch.matchId] ?? null : null}
        game={openMatch}
        mapName={openMatch ? mapById?.[openMatch.matchId] ?? '' : ''}
        queue={openMatch?.queueId ?? 'competitive'}
        puuid={profile.puuid}
        tierIcons={tierIcons ?? {}}
        agentInfo={agentInfo ?? {}}
      />
    </div>
  );
};
