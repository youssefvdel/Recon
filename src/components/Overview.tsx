import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, Check, Gamepad2, Lock, RefreshCw } from 'lucide-react';
import { tierName } from '../utils/tracker';
import { ScoreBadge, gradeFor, scoreTier } from './ScoreBadge';
import {
  fetchTrnActStats,
  fetchTrnAgents,
  resetTrnCooldown,
  type TrnActStats,
  type TrnAgentStat,
} from '../utils/trn';
import { isOpggFallbackActive, OPGG_ATTRIBUTION } from '../utils/opgg';
import killsIcon from '../assets/icons/kills.png';
import firstbloodsIcon from '../assets/icons/firstbloods.png';
import acesIcon from '../assets/icons/aces.png';
import { useTrackerData } from '../hooks/useTrackerData';
import { useCountUp } from '../hooks/useCountUp';
import { OverviewSkeletons } from './TrackerSkeletons';
import { CustomDropdown } from './ValorantConfig';

const rise = {
  hidden: { opacity: 0, y: 12 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.04, duration: 0.3, ease: 'easeOut' as const },
  }),
};

/** Hit-zone body figure: head/body/legs glow with their share of hits. */
const BodyFigure: React.FC<{ head: number; body: number; legs: number }> = ({ head, body, legs }) => {
  const max = Math.max(head, body, legs, 1);
  const o = (v: number): number => +(0.22 + 0.78 * (v / max)).toFixed(2);
  const fill = '#00c3ff';
  return (
    <svg width="48" height="92" viewBox="0 0 48 92" className="shrink-0" aria-label="Hit zones">
      {/* head */}
      <circle cx="24" cy="9" r="7.5" fill={fill} opacity={o(head)} />
      {/* arms */}
      <rect x="6" y="22" width="6" height="26" rx="3" fill={fill} opacity={o(body)} />
      <rect x="36" y="22" width="6" height="26" rx="3" fill={fill} opacity={o(body)} />
      {/* torso */}
      <rect x="15" y="20" width="18" height="32" rx="6" fill={fill} opacity={o(body)} />
      {/* legs */}
      <rect x="15.5" y="54" width="7.5" height="32" rx="3.5" fill={fill} opacity={o(legs)} />
      <rect x="25" y="54" width="7.5" height="32" rx="3.5" fill={fill} opacity={o(legs)} />
    </svg>
  );
};

export const shortAct = (label: string): string => {
  const m = label.match(/(?:V|Season\s*)(\d+)[\s:·]*ACT\s*([IVXLCDM]+|\d+)/i);
  if (m) {
    const ep = m[1];
    const act = m[2];
    const romans: Record<string, string> = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' };
    const num = romans[act.toUpperCase()] ?? act;
    return `V${ep}:A${num}`;
  }
  return label
    .replace('Episode', 'E')
    .replace(/V(\d+)/, 'V$1')
    .replace('ACT', 'A')
    .replace(/\s*·\s*/g, ':');
};

const pctLabel = (p: number): string => (p >= 50 ? `Top ${Math.round(100 - p)}%` : `Bottom ${Math.round(p)}%`);

const BigTile: React.FC<{ label: string; value?: string; numeric?: number; decimals?: number; suffix?: string; locked?: boolean; index: number }> = ({
  label,
  value,
  numeric,
  decimals = 0,
  suffix = '',
  locked = false,
  index,
}) => {
  const v = useCountUp(numeric ?? 0, 900, !locked && numeric !== undefined);
  return (
    <motion.div variants={rise} custom={index}
      className={`rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-3.5 flex flex-col gap-1 min-w-0 ${locked ? 'opacity-70' : ''}`}>
      <span className="text-[11px] font-bold uppercase tracking-wider text-m3-outline flex items-center gap-1">
        {label}
        {locked && <Lock className="w-3 h-3" />}
      </span>
      <span className="font-display font-black text-2xl sm:text-3xl text-m3-on-surface tabular-nums truncate mt-0.5">
        {locked ? (value ?? '—') : numeric !== undefined ? <>{v.toFixed(decimals)}{suffix}</> : (value ?? '—')}
      </span>
    </motion.div>
  );
};

const SmallStat: React.FC<{ label: string; value: string; locked?: boolean; tone?: 'win' | 'loss' }> = ({ label, value, locked = false, tone }) => (
  <div className={`flex flex-col gap-0.5 min-w-0 ${locked ? 'opacity-60' : ''}`}>
    <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-m3-outline flex items-center gap-1">
      {label}
      {locked && <Lock className="w-2.5 h-2.5" />}
    </span>
    <span className={`font-display font-extrabold text-base sm:text-lg tabular-nums truncate ${tone === 'win' ? 'text-m3-mint' : tone === 'loss' ? 'text-m3-coral' : 'text-m3-on-surface'}`}>{value}</span>
  </div>
);

const PLAYLISTS = [
  { value: 'competitive', label: 'Competitive' },
  { value: 'unrated', label: 'Unrated' },
];

export const Overview: React.FC = () => {
  const { profile, seasonNames, seasonOrder, tierIcons, agentInfo, agg, trn, trnAgents, trnPrev, games, detailsById, isLoading, clientClosed, banner, setBanner, refresh } =
    useTrackerData();

  const [playlist, setPlaylist] = useState('competitive');
  const [seasonId, setSeasonId] = useState('');
  const [selStats, setSelStats] = useState<TrnActStats | null>(null);
  const [selAgents, setSelAgents] = useState<TrnAgentStat[] | null>(null);
  const [selLoading, setSelLoading] = useState(false);
  const [selError, setSelError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // True only for the live act + competitive — the one case where the store's
  // `trn`/`agg` snapshots describe the selection.
  const isDefault = playlist === 'competitive' && !seasonId;

  const seasonOptions = useMemo(() => {
    if (!profile) return [];
    const played = new Set(profile.seasons.filter((s) => s.games > 0).map((s) => s.id.toLowerCase()));
    const order = seasonOrder.length > 0 ? seasonOrder : [...played];
    const ids = [profile.currentSeasonId.toLowerCase(), ...order.filter((id) => id !== profile.currentSeasonId.toLowerCase() && played.has(id))];
    return [
      { value: '', label: seasonNames[profile.currentSeasonId.toLowerCase()] ?? 'Current Act' },
      ...ids.slice(1).map((id) => ({ value: id, label: seasonNames[id] ?? shortAct(id) })),
    ];
  }, [profile, seasonOrder, seasonNames]);

  useEffect(() => {
    if (isDefault || !profile) {
      setSelStats(null);
      setSelAgents(null);
      setSelError(null);
      setSelLoading(false);
      return;
    }
    let live = true;
    setSelLoading(true);
    // Drop the previous act's numbers the moment the selection changes. Holding
    // them would show act A's stats under act B's label, which is exactly how
    // switching acts appeared to do nothing.
    setSelStats(null);
    setSelAgents(null);
    setSelError(null);
    const sid = seasonId || profile.currentSeasonId;
    Promise.all([
      fetchTrnActStats(profile.name, profile.tag, sid, playlist).then((r) => r.stats).catch(() => null),
      fetchTrnAgents(profile.name, profile.tag, sid, playlist).catch(() => []),
    ]).then(([st, ag]) => {
      if (!live) return;
      if (!st) {
        // Plain empty state — no countdowns, no jargon. Data appears silently
        // when the cooldown expires; Retry just refetches.
        setSelError('tracker.gg did not return stats for this act.');
        setSelLoading(false);
        return;
      }
      setSelStats(st);
      setSelAgents(ag);
      setSelLoading(false);
    });
    return () => {
      live = false;
    };
  }, [isDefault, playlist, seasonId, profile, reloadKey]);

  // `trn` and `agg` describe the CURRENT act only, so they may only be used when
  // the selection IS the current act. A past act that has not loaded reads as
  // "not loaded" — never as the live act's numbers.
  const S = isDefault ? trn : selStats;
  const agents = isDefault ? trnAgents : selAgents ?? [];
  const statsReady = isDefault || !!selStats;
  const losses = S ? S.losses : isDefault && profile ? Math.max(0, profile.games - profile.wins) : 0;
  const wins = S ? S.wins : isDefault ? profile?.wins ?? 0 : 0;
  const winPct = S ? S.winPct : isDefault && profile && profile.games > 0 ? (profile.wins / profile.games) * 100 : 0;
  const kd = S?.kd ?? (isDefault ? agg?.kd : undefined) ?? 0;
  const adr = S?.adr ?? (isDefault ? agg?.adr : undefined) ?? 0;
  const kills = S?.kills ?? (isDefault ? agg?.kills : undefined) ?? 0;
  const deaths = S?.deaths ?? (isDefault ? agg?.deaths : undefined) ?? 0;
  const assists = S?.assists ?? (isDefault ? agg?.assists : undefined) ?? 0;
  const kpiReady = !selLoading && statsReady;
  const kpiPlaceholder = selLoading ? '…' : statsReady ? undefined : '—';

  const recentActs = useMemo(() => {
    if (!profile) return [];
    const getOrderIdx = (id: string): number => {
      const i = seasonOrder.indexOf(id.toLowerCase());
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return (profile.seasons ?? [])
      .filter((s) => s.games > 0)
      .sort((a, b) => getOrderIdx(a.id) - getOrderIdx(b.id))
      .slice(0, 3);
  }, [profile, seasonOrder]);

  const topAgent = agents[0] ?? null;
  const topAgentMeta = topAgent
    ? Object.values(agentInfo).find((a) => a.name.toLowerCase() === topAgent.agent.toLowerCase())
    : null;

  // Accuracy over the LAST 20 MATCHES (real hit-location data from match details),
  // not the act-wide TRN aggregate. Matches whose cached detail has no hit
  // breakdown are skipped so a stale/empty cache can't drag the numbers down.
  const recentHit = useMemo(() => {
    const puuid = profile?.puuid;
    if (!puuid) return null;
    const ordered =
      (games ?? []).map((g) => g.matchId).filter(Boolean).length > 0
        ? (games ?? []).map((g) => g.matchId).filter(Boolean)
        : Object.keys(detailsById ?? {});

    let head = 0;
    let body = 0;
    let legs = 0;
    let used = 0;
    for (const id of ordered) {
      if (used >= 20) break;
      const d = detailsById?.[id];
      if (!d?.players) continue;
      const me = d.players.find((p) => p.puuid === puuid);
      if (!me) continue;
      const h = me.headshots || 0;
      const b = me.bodyshots || 0;
      const l = me.legshots || 0;
      if (h + b + l === 0) continue; // hit data unavailable for this match
      head += h;
      body += b;
      legs += l;
      used++;
    }
    if (used === 0) return null;
    return { head, body, legs, used, total: head + body + legs };
  }, [games, detailsById, profile]);

  // Prefer the last-20 sample; fall back to the act-wide TRN aggregate when no
  // local match details carry hit data yet.
  const accHead = recentHit ? recentHit.head : S?.headHits ?? 0;
  const accBody = recentHit ? recentHit.body : S?.bodyHits ?? 0;
  const accLegs = recentHit ? recentHit.legs : S?.legHits ?? 0;
  const accHeadPct = recentHit ? (recentHit.head / recentHit.total) * 100 : S?.hsPct ?? 0;
  const hitTotal = accHead + accBody + accLegs;
  const bodyPct = hitTotal > 0 ? (accBody / hitTotal) * 100 : 0;
  const legPct = hitTotal > 0 ? (accLegs / hitTotal) * 100 : 0;
  const accLabel = recentHit ? `Last ${recentHit.used}` : 'Act-wide';

  if (!profile) {
    if (clientClosed) {
      return (
        <div className="h-full min-h-0 max-w-6xl mx-auto w-full overflow-y-auto custom-scrollbar px-4 sm:px-6 py-3.5 pb-8 flex items-center justify-center">
          <div className="rounded-3xl bg-m3-surface-container border border-m3-outline-subtle p-8 flex flex-col items-center text-center gap-3 max-w-sm shadow-m3-1">
            <span className="w-14 h-14 rounded-3xl bg-m3-primary-container/50 border border-m3-primary/30 flex items-center justify-center">
              <Gamepad2 className="w-7 h-7 text-m3-primary" />
            </span>
            <h3 className="font-display font-black text-lg text-m3-on-surface">Riot Client is closed</h3>
            <p className="text-xs text-m3-outline leading-relaxed">
              The tracker reads live data from your local Riot session. Open Riot Client or Valorant, then refresh.
            </p>
            <button
              onClick={refresh}
              disabled={isLoading}
              className="h-9 px-5 rounded-xl bg-m3-primary text-m3-on-primary text-xs font-bold flex items-center gap-2 cursor-pointer disabled:opacity-50 hover:brightness-110"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="h-full min-h-0 max-w-6xl mx-auto w-full overflow-hidden px-6 pt-3 pb-6">
        <OverviewSkeletons />
      </div>
    );
  }

  return (
    <motion.div initial="hidden" animate="show" className="h-full min-h-0 flex flex-col justify-start gap-2.5 max-w-6xl mx-auto w-full overflow-y-auto custom-scrollbar px-6 pt-3 pb-6">
      {clientClosed && (
        <div className="p-2.5 rounded-xl bg-m3-surface-container-high border border-m3-outline-subtle text-m3-on-surface-variant text-xs font-medium flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2">
            <Gamepad2 className="w-3.5 h-3.5 text-m3-outline shrink-0" />
            <span>Viewing offline cached stats • Riot Client is closed</span>
          </div>
          <button onClick={refresh} disabled={isLoading} className="text-m3-primary hover:underline text-xs ml-3 cursor-pointer font-bold shrink-0">
            Check Connection
          </button>
        </div>
      )}
      {banner && (
        <div className="p-2.5 rounded-xl bg-m3-primary-container/40 border border-m3-primary/40 text-m3-on-primary-container text-xs font-semibold flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2">
            <Check className="w-3.5 h-3.5 text-m3-primary shrink-0" />
            <span>{banner}</span>
          </div>
          <button onClick={() => setBanner(null)} className="text-m3-primary hover:underline text-xs ml-3 cursor-pointer font-bold shrink-0">
            Dismiss
          </button>
        </div>
      )}

      {/* Header filter bar */}
      <div className="flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-40">
            <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-m3-outline mb-1 px-1">Playlist</div>
            <CustomDropdown value={playlist} options={PLAYLISTS} onChange={(v) => setPlaylist(v)} />
          </div>
          <div className="w-48">
            <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-m3-outline mb-1 px-1">Act</div>
            <CustomDropdown value={seasonId} options={seasonOptions} onChange={(v) => setSeasonId(v)} />
          </div>
        </div>
      </div>

      {/* Act fetch failed — say so instead of silently showing the live act. */}
      {selError && !isDefault && (
        <div className="p-2.5 rounded-xl bg-m3-coral/10 border border-m3-coral/40 text-xs flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-3.5 h-3.5 text-m3-coral shrink-0" />
            <span className="text-m3-on-surface font-medium leading-snug">
              {selError} Nothing is shown rather than the current act's numbers.
            </span>
          </div>
          <button
            onClick={() => {
              resetTrnCooldown();
              setReloadKey((k) => k + 1);
            }}
            className="shrink-0 px-2.5 py-1 rounded-lg bg-m3-coral/20 hover:bg-m3-coral/30 border border-m3-coral/40 text-m3-coral font-bold cursor-pointer transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* TRN can't serve history right now — the Matches tab supplements from OP.GG. */}
      {isOpggFallbackActive() && (
        <div
          className="px-1 text-[11px] font-mono text-amber-200/90 shrink-0"
          title={OPGG_ATTRIBUTION}
        >
          TRN cooling — Matches tab may supplement from OP.GG
          <span className="opacity-70"> · {OPGG_ATTRIBUTION}</span>
        </div>
      )}

      {profile && (
        <>
          {/* Primary KPI Tiles */}
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 shrink-0">
            <BigTile index={2} label="Win %" numeric={kpiReady ? winPct : undefined} decimals={2} suffix="%" value={kpiPlaceholder} />
            <BigTile index={3} label="K/D" numeric={kpiReady ? kd : undefined} decimals={3} value={kpiPlaceholder} />
            <BigTile
              index={4}
              label="Headshot %"
              numeric={S ? S.hsPct : accHeadPct > 0 ? accHeadPct : undefined}
              decimals={2}
              suffix="%"
              value={!S && accHeadPct === 0 ? '—' : undefined}
            />
            <BigTile index={5} label="Damage/Round" numeric={kpiReady ? adr : undefined} decimals={2} value={kpiPlaceholder} />
          </section>

          {/* Secondary stats row */}
          <motion.section variants={rise} custom={6}
            className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-3.5 shadow-m3-1 shrink-0">
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-3">
              <SmallStat label="Wins" value={String(wins)} tone="win" />
              <SmallStat label="Losses" value={String(losses)} tone="loss" />
              <SmallStat label="Kills" value={kills ? kills.toLocaleString() : '…'} />
              <SmallStat label="Deaths" value={deaths ? deaths.toLocaleString() : '…'} />
              <SmallStat label="Assists" value={assists ? assists.toLocaleString() : '…'} />
              <SmallStat label="Headshots" value={S ? S.headshots.toLocaleString() : recentHit ? recentHit.head.toLocaleString() : '—'} />
              <SmallStat label="Flawless" value={String(S?.flawless ?? (isDefault ? agg?.flawless : undefined) ?? '…')} />
              <SmallStat label="Clutches" value={String(S?.clutches ?? (isDefault ? agg?.clutches : undefined) ?? '…')} />
            </div>
          </motion.section>

          {/* Middle Row: Combat Highlights | Top Agent | Accuracy */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 shrink-0">
            {/* Combat Highlights */}
            <motion.section variants={rise} custom={7}
              className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-3.5 flex flex-col justify-between shadow-m3-1">
              <h4 className="font-display font-bold text-sm text-m3-on-surface mb-2">Combat Highlights</h4>
              <div className="flex flex-col gap-3 flex-1 justify-around">
                <div className="flex items-center gap-3">
                  <img src={killsIcon} alt="" className="w-10 h-10 rounded-full shrink-0 shadow-sm" />
                  <div>
                    <div className="text-[11px] font-medium text-m3-outline">Match Kills (Best)</div>
                    <div className="font-display font-extrabold text-lg text-m3-on-surface tabular-nums leading-tight">
                      {S ? String(S.bestKills || '…') : '…'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <img src={firstbloodsIcon} alt="" className="w-10 h-10 rounded-full shrink-0 shadow-sm" />
                  <div>
                    <div className="text-[11px] font-medium text-m3-outline">First Kills / Deaths</div>
                    <div className="font-display font-extrabold text-lg text-m3-on-surface tabular-nums leading-tight">
                      {S ? `${S.firstKills} / ${S.firstDeaths}` : isDefault && agg ? `${agg.firstKills} / ${agg.firstDeaths}` : '…'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <img src={acesIcon} alt="" className="w-10 h-10 rounded-full shrink-0 shadow-sm" />
                  <div>
                    <div className="text-[11px] font-medium text-m3-outline">Aces</div>
                    <div className="font-display font-extrabold text-lg text-m3-on-surface tabular-nums leading-tight">
                      {S?.aces ?? (isDefault ? agg?.aces : undefined) ?? '…'}
                    </div>
                  </div>
                </div>
              </div>
            </motion.section>

            {/* Top Agent (matches reference layout) */}
            <motion.section variants={rise} custom={8}
              className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-3.5 flex flex-col justify-between shadow-m3-1">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-display font-bold text-sm text-m3-on-surface">Top Agent</h4>
                  {topAgentMeta?.role ? (
                    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-m3-surface-container-high border border-m3-outline-subtle text-[11px] font-medium text-m3-outline">
                      {topAgentMeta.roleIcon && (
                        <img src={topAgentMeta.roleIcon} alt="" className="w-3 h-3 object-contain opacity-80" />
                      )}
                      <span>{topAgentMeta.role}</span>
                    </div>
                  ) : null}
                </div>
                {topAgent ? (
                  <div className="flex items-center gap-3">
                    {topAgentMeta?.icon ? (
                      <img
                        src={topAgentMeta.icon}
                        alt={topAgent.agent}
                        className="w-12 h-12 rounded-lg object-cover bg-m3-mint/10 border border-m3-outline-subtle shrink-0"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-lg bg-m3-surface-container-high shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="font-display font-extrabold text-lg text-m3-on-surface leading-tight truncate">
                        {topAgent.agent}
                      </div>
                      <div className="text-xs text-m3-outline mt-0.5 truncate">
                        {topAgent.hours > 0 ? `${topAgent.hours} hrs, ` : ''}{topAgent.matches} Matches
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-m3-outline">No matches recorded</div>
                )}
              </div>
              {topAgent && (
                <div className="grid grid-cols-4 gap-2 pt-3 mt-3 border-t border-m3-outline-subtle/50">
                  <div>
                    <div className="text-[11px] font-semibold text-m3-outline">Win %</div>
                    <div className="font-display font-bold text-base sm:text-lg text-m3-on-surface tabular-nums mt-0.5">
                      {topAgent.winPct.toFixed(1)}%
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold text-m3-outline">K/D</div>
                    <div className="font-display font-bold text-base sm:text-lg text-m3-on-surface tabular-nums mt-0.5">
                      {topAgent.kd.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold text-m3-outline">ADR</div>
                    <div className="font-display font-bold text-base sm:text-lg text-m3-on-surface tabular-nums mt-0.5">
                      {Math.round(topAgent.adr)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold text-m3-outline">ACS</div>
                    <div className="font-display font-bold text-base sm:text-lg text-m3-on-surface tabular-nums mt-0.5">
                      {Math.round(topAgent.acs)}
                    </div>
                  </div>
                </div>
              )}
            </motion.section>

            {/* Accuracy */}
            <motion.section variants={rise} custom={9}
              className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-3.5 flex flex-col justify-between shadow-m3-1">
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-display font-bold text-sm text-m3-on-surface">Accuracy</h4>
                <span className="text-xs text-m3-outline font-medium" title={recentHit ? `Last ${recentHit.used} matches` : 'Act-wide from Tracker.gg'}>
                  {accLabel}
                </span>
              </div>
              {hitTotal > 0 ? (
                <div className="flex gap-4 items-center flex-1 py-1">
                  <BodyFigure head={accHeadPct} body={bodyPct} legs={legPct} />
                  <div className="flex-1 flex flex-col justify-around h-full gap-2 text-[12px] min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-m3-outline font-medium w-10">Head</span>
                      <span className="font-mono font-bold text-base text-m3-primary">{accHeadPct.toFixed(2)}%</span>
                      <span className="font-mono text-xs text-m3-outline tabular-nums ml-auto">{accHead.toLocaleString()} hits</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-m3-outline font-medium w-10">Body</span>
                      <span className="font-mono font-bold text-base text-m3-on-surface">{bodyPct.toFixed(2)}%</span>
                      <span className="font-mono text-xs text-m3-outline tabular-nums ml-auto">{accBody.toLocaleString()} hits</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-m3-outline font-medium w-10">Legs</span>
                      <span className="font-mono font-bold text-base text-m3-on-surface">{legPct.toFixed(2)}%</span>
                      <span className="font-mono text-xs text-m3-outline tabular-nums ml-auto">{accLegs.toLocaleString()} hits</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl bg-m3-surface-container-low/60 border border-m3-outline-subtle/60 p-3 text-xs text-m3-outline flex items-start gap-2">
                  <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>Hit data loading…</span>
                </div>
              )}
            </motion.section>
          </div>

          {/* Lower Row: Previous Acts & Tracker Score sharing 50/50 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 shrink-0">
            {/* Previous Acts (3 compact columns) */}
            {recentActs.length > 0 && (
              <motion.section variants={rise} custom={10}
                className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-3.5 flex flex-col justify-between shadow-m3-1">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-display font-bold text-sm text-m3-on-surface">Previous Acts</h4>
                  <span className="text-[10px] text-m3-outline uppercase tracking-wider font-semibold">Competitive History</span>
                </div>
                <div className="grid grid-cols-3 gap-2 flex-1 items-center text-center py-1">
                  {recentActs.map((s) => {
                    const isCurrent = s.id.toLowerCase() === profile?.currentSeasonId.toLowerCase();
                    const prev = trnPrev[s.id.toLowerCase()];
                    // "Peak Rating" means the HIGHEST tier reached in that act —
                    // including the live act, where the current tier can sit below
                    // the peak (e.g. peaked Ascendant 3, now Ascendant 2).
                    const rankTier = s.tier;
                    const rName = tierName(s.tier);
                    const kdVal = isCurrent ? (S?.kd ?? agg?.kd ?? prev?.kd ?? 0) : (prev?.kd ?? 0);
                    const matchesCount = isCurrent
                      ? (S ? S.wins + S.losses + S.ties : profile.games)
                      : (prev?.matches ?? s.games);
                    const icon = tierIcons[rankTier];

                    return (
                      <div key={s.id} className="flex flex-col items-center justify-between h-full py-1">
                        <span className="text-[11px] font-bold text-m3-outline uppercase tracking-wider">
                          {shortAct(seasonNames[s.id.toLowerCase()] ?? s.id)}
                        </span>
                        <div className="my-1.5 flex items-center justify-center">
                          {icon ? (
                            <img src={icon} alt={rName} className="w-11 h-11 object-contain drop-shadow-sm" />
                          ) : (
                            <div className="w-11 h-11 rounded-full bg-m3-surface-container-high" />
                          )}
                        </div>
                        <span className="text-[9px] font-bold uppercase tracking-wider text-m3-outline/70">
                          Peak Rating
                        </span>
                        <div className="font-display font-bold text-xs sm:text-sm text-m3-on-surface leading-tight mt-0.5 truncate max-w-full">
                          {rName}
                        </div>
                        <div className="text-[10px] text-m3-outline mt-1 font-medium truncate max-w-full">
                          K/D <strong className="text-m3-on-surface font-mono font-bold">{kdVal.toFixed(2)}</strong> Matches <strong className="text-m3-on-surface font-mono font-bold">{matchesCount}</strong>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </motion.section>
            )}

            {/* Tracker Score */}
            {trn && (
              <motion.section variants={rise} custom={11}
                className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-3.5 flex flex-col justify-between shadow-m3-1"
                style={{
                  borderColor: `${scoreTier(trn.trnScore).color}44`,
                  background: `linear-gradient(180deg, ${scoreTier(trn.trnScore).color}15 0%, transparent 60%)`,
                }}>
                <div>
                  <h4 className="font-display font-bold text-sm text-m3-on-surface mb-2">Tracker Score</h4>

                  <div className="flex items-center gap-2.5 my-1">
                    <ScoreBadge tier={scoreTier(trn.trnScore).tier} size={44} />
                    <div className="font-display font-black text-3xl text-m3-on-surface tabular-nums leading-none">
                      {trn.trnScore}
                    </div>
                    <div className="text-[10px] font-bold text-m3-outline px-2 py-0.5 rounded-md bg-m3-surface-container-high border border-m3-outline-subtle ml-1">
                      Tracker Score - Tier {scoreTier(trn.trnScore).tier}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-1 mt-3 pt-2">
                  {[
                    { label: 'Round Win %', v: trn.roundWinPct.toFixed(1) + '%', p: trn.roundWinPctile, color: '#2cd5f6' },
                    { label: 'KAST', v: trn.kast.toFixed(1) + '%', p: trn.kastPctile, color: '#3ae374' },
                    { label: 'ACS', v: trn.acs.toFixed(1), p: trn.acsPctile, color: '#ff7675' },
                    { label: 'DDΔ/Round', v: String(Math.round(trn.damageDelta / Math.max(1, trn.rounds))), p: trn.ddPctile, color: '#f5b041' },
                  ].map((s, i) => {
                    const g = gradeFor(s.p);
                    return (
                      <React.Fragment key={s.label}>
                        {i > 0 && <span className="text-m3-outline-subtle font-bold text-xs px-0.5 select-none">+</span>}
                        <div
                          className="flex-1 text-center pb-1.5 border-b-2"
                          style={{ borderBottomColor: s.color }}
                        >
                          <div className="text-[10px] font-bold uppercase tracking-wider text-m3-outline truncate">
                            {s.label}
                          </div>
                          <div className="text-[15px] font-mono font-bold text-m3-on-surface mt-0.5 tabular-nums">
                            {s.v}
                          </div>
                          <div className="text-[10px] font-mono font-bold truncate mt-0.5" style={{ color: s.color }}>
                            <span>{g}</span> <span className="text-m3-outline font-normal">· {pctLabel(s.p)}</span>
                          </div>
                        </div>
                      </React.Fragment>
                    );
                  })}
                </div>
              </motion.section>
            )}
          </div>
        </>
      )}
    </motion.div>
  );
};
