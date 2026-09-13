import React, { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Lightbulb, Copy } from 'lucide-react';
import type { TrackerMatchDetail, TrackerMmrPoint } from '../types';
import { matchCard, queueLabel, shortMapName, tierName } from '../utils/tracker';
import { useTrackerData } from '../hooks/useTrackerData';
import { calculateTrsFallback } from '../utils/trn';
import { buildTips } from '../utils/trackerTips';
import { HistorySkeletons } from './TrackerSkeletons';
import { CustomDropdown } from './ValorantConfig';
import { MatchDetailModal } from './MatchDetailModal';
import { ScoreBadge, scoreTier } from './ScoreBadge';

const ago = (ms: number): string => {
  if (!ms) return '';
  const mins = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const dayLabel = (ms: number): string => {
  if (!ms) return 'Older';
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

interface Row {
  g: TrackerMmrPoint;
  detail?: TrackerMatchDetail;
  agent: string;
  won: boolean;
  us: number;
  them: number;
  k: number;
  d: number;
  a: number;
  acs: number;
  dd: number;
  hsPct: number;
  place: number;
  kast: number;
  cw: number;
  cl: number;
  k3: number;
  k4: number;
  aces: number;
  trs: number;
}

/** Count clutch rounds fought alone (won vs lost). Mirrors matchCard's clutch rule. */
const countClutch = (detail: TrackerMatchDetail, puuid: string): { won: number; lost: number } => {
  const me = detail.players.find((p) => p.puuid === puuid);
  const myTeam = me?.team ?? '';
  const byRound = new Map<number, typeof detail.kills>();
  for (const k of detail.kills) {
    const l = byRound.get(k.round) ?? [];
    l.push(k);
    byRound.set(k.round, l);
  }
  let won = 0;
  let lost = 0;
  for (const [num, kl] of byRound) {
    const roundWon = detail.rounds[num]?.winningTeam === myTeam;
    const myK = kl.filter((k) => k.killerPuuid === puuid);
    const iDied = kl.some((k) => k.victimPuuid === puuid);
    const mateDeaths = kl.filter((k) => k.victimTeam === myTeam && k.victimPuuid !== puuid).length;
    if (myK.length > 0 && mateDeaths >= 3) {
      if (roundWon && !iDied) won++;
      else if (!roundWon && mateDeaths >= 4) lost++;
    }
  }
  return { won, lost };
};

const Pill: React.FC<{ label: string; tone: 'gold' | 'red' }> = ({ label, tone }) => (
  <span
    className={`px-1.5 py-px rounded-md text-[10px] font-bold border whitespace-nowrap ${
      tone === 'gold'
        ? 'bg-m3-tertiary/10 border-m3-tertiary/40 text-m3-tertiary'
        : 'bg-m3-coral/10 border-m3-coral/40 text-m3-coral'
    }`}>
    {label}
  </span>
);

const Stat: React.FC<{ label: string; children: React.ReactNode; className?: string; width?: string }> = ({
  label,
  children,
  className = '',
  width = 'w-12',
}) => (
  <div className={`flex flex-col items-center shrink-0 ${width} ${className}`}>
    <span className="text-[9px] font-bold uppercase tracking-wider text-m3-outline whitespace-nowrap">{label}</span>
    <span className="text-[14px] font-mono font-bold tabular-nums whitespace-nowrap">{children}</span>
  </div>
);

const MatchRow: React.FC<{
  r: Row;
  queue: string;
  map: string;
  index: number;
  icon: string;
  rankIcon: string;
  puuid: string;
  open: boolean;
  onToggle: () => void;
  onOpenModal: () => void;
}> = ({ r, queue, map, index, icon, rankIcon, puuid, open, onToggle, onOpenModal }) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const card = useMemo(() => (r.detail ? matchCard(r.detail, puuid) : null), [r.detail, puuid]);

  const handleCopyPlayer = (e: React.MouseEvent, p: { name?: string; tag?: string; agent: string; puuid?: string }) => {
    e.stopPropagation();
    const id = p.name ? (p.tag ? `${p.name}#${p.tag}` : p.name) : p.agent;
    navigator.clipboard.writeText(id);
    const k = p.puuid || p.name || p.agent;
    setCopiedKey(k);
    setTimeout(() => setCopiedKey((c) => (c === k ? null : c)), 1500);
  };
  const teams = useMemo(() => {
    if (!r.detail) return [];
    return ['Blue', 'Red']
      .map((t) => ({
        team: t,
        score: r.detail!.teamScore[t] ?? 0,
        players: [...r.detail!.players]
          .filter((p) => p.team === t)
          .sort((a, b) => b.score - a.score || b.kills - a.kills),
      }))
      .filter((x) => x.players.length > 0);
  }, [r.detail]);
  const tips = useMemo(() => (r.detail && puuid ? buildTips(r.detail, puuid) : []), [r.detail, puuid]);
  const kd = r.d > 0 ? r.k / r.d : r.k;

  const pills: { label: string; tone: 'gold' | 'red' }[] = [];
  if (r.k3 > 0) {
    pills.push({ label: '3k', tone: 'gold' });
    if (r.k3 > 1) pills.push({ label: `x${r.k3}`, tone: 'gold' });
  }
  if (r.k4 > 0) {
    pills.push({ label: '4k', tone: 'gold' });
    if (r.k4 > 1) pills.push({ label: `x${r.k4}`, tone: 'gold' });
  }
  if (r.aces > 0) {
    pills.push({ label: 'Ace', tone: 'gold' });
    if (r.aces > 1) pills.push({ label: `x${r.aces}`, tone: 'gold' });
  }
  if (r.cw > 0) {
    pills.push({ label: '1v1 Clutch', tone: 'gold' });
    if (r.cw > 1) pills.push({ label: `x${r.cw}`, tone: 'gold' });
  }
  if (r.cl > 0) {
    pills.push({ label: '1v1 Lost', tone: 'red' });
    if (r.cl > 1) pills.push({ label: `x${r.cl}`, tone: 'red' });
  }
  if (r.kast >= 85) pills.push({ label: 'High KAST', tone: 'gold' });

  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.4), duration: 0.3, ease: 'easeOut' }}
      className={`rounded-xl border overflow-hidden ${
        r.won ? 'bg-m3-mint/[0.07] border-m3-mint/25' : 'bg-m3-surface-container border-m3-outline-subtle'
      }`}>
      <button
        onClick={() => {
          if (r.detail) onOpenModal();
        }}
        className={`w-full px-2.5 py-2 flex items-center gap-2.5 text-left ${
          r.detail ? 'cursor-pointer hover:bg-m3-surface-container-high/30' : ''
        }`}>
        <span className={`w-1 self-stretch rounded-full shrink-0 ${r.won ? 'bg-m3-mint' : 'bg-m3-coral/70'}`} />
        {icon ? (
          <img src={icon} alt={r.agent} className="w-9 h-9 rounded-lg object-cover bg-m3-surface-container-high shrink-0" />
        ) : (
          <span className="w-9 h-9 rounded-lg bg-m3-surface-container-high shrink-0" />
        )}

        {/* Map + mode + placement */}
        <div className="w-32 sm:w-40 shrink-0 min-w-0">
          <div className="text-[10px] text-m3-outline truncate">
            {ago(r.g.when)} // {queue}
          </div>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[15px] font-display font-extrabold text-m3-on-surface truncate">{map}</span>
            {r.place > 0 && (
              <span className="text-[9px] font-mono font-bold text-m3-outline border border-m3-outline-subtle rounded px-1 py-px shrink-0">
                {ordinal(r.place)}
              </span>
            )}
          </div>
        </div>

        {/* Rank */}
        <div className="w-8 shrink-0 hidden sm:flex items-center justify-center">
          {rankIcon ? (
            <img src={rankIcon} alt={r.g.tier} title={r.g.tier} className="w-7 h-7 object-contain" />
          ) : (
            <span className="w-7 h-7" />
          )}
        </div>

        {/* Score */}
        <div className="flex flex-col items-center shrink-0 w-16">
          <span className="text-[9px] font-bold uppercase tracking-wider text-m3-outline">Score</span>
          <span className="text-[15px] font-mono font-extrabold tabular-nums whitespace-nowrap">
            <span className="text-m3-mint">{r.us}</span>
            <span className="text-m3-outline"> : </span>
            <span className="text-m3-coral">{r.them}</span>
          </span>
        </div>

        {/* TRS */}
        <div className="flex-col items-center shrink-0 w-12 hidden md:flex">
          <span className="text-[9px] font-bold uppercase tracking-wider text-m3-outline">TRS</span>
          <div
            className="flex items-center justify-center h-6 cursor-default"
            title={
              r.trs > 0
                ? `Tracker Rating Score: ${r.trs} / 1000 — Tier ${scoreTier(r.trs).tier}`
                : 'Tracker Rating Score unavailable'
            }
          >
            {r.trs > 0 ? (
              <ScoreBadge tier={scoreTier(r.trs).tier} size={22} />
            ) : (
              <span className="text-[10px] font-mono text-m3-outline">—</span>
            )}
          </div>
        </div>

        {/* Heroic pills */}
        <div className="hidden xl:flex items-center gap-1 flex-wrap flex-1 min-w-0 pr-2">
          {pills.map((b, i) => (
            <Pill key={`${b.label}-${i}`} label={b.label} tone={b.tone} />
          ))}
        </div>

        {/* Spacer on smaller screens where pills are hidden, keeping stats pinned to right */}
        <div className="flex-1 xl:hidden" />

        {/* Stat columns */}
        <div className="hidden sm:flex items-center gap-2 md:gap-3 lg:gap-4 shrink-0">
          <Stat label="K/D" width="w-12">
            <span className={kd >= 1 ? 'text-m3-mint' : 'text-m3-coral'}>{kd.toFixed(1)}</span>
          </Stat>
          <Stat label="K/D/A" width="w-[84px]">
            <span className="text-m3-on-surface">
              {r.k} <span className="text-m3-outline">/</span> {r.d} <span className="text-m3-outline">/</span> {r.a}
            </span>
          </Stat>
          <Stat label="DDΔ" width="w-14">
            <span className={r.dd >= 0 ? 'text-m3-mint' : 'text-m3-coral'}>
              {r.dd > 0 ? `+${r.dd}` : r.dd}
            </span>
          </Stat>
          <Stat label="HS%" width="w-12" className="hidden lg:flex">
            <span className="text-m3-on-surface">{r.hsPct > 0 ? Math.round(r.hsPct) : '—'}</span>
          </Stat>
          <Stat label="ACS" width="w-12">
            <span className="text-m3-on-surface">{r.acs}</span>
          </Stat>
        </div>

        {/* Mobile compact */}
        <div className="sm:hidden ml-auto shrink-0 text-right">
          <div className="text-[13px] font-mono font-bold text-m3-on-surface tabular-nums">
            {r.k}/{r.d}/{r.a}
          </div>
          <div className="text-[10px] font-mono text-m3-outline">ACS {r.acs}</div>
        </div>

        <span
          role="button"
          onClick={(e) => {
            e.stopPropagation();
            if (r.detail) onToggle();
          }}
          className="text-m3-outline hover:text-m3-on-surface p-1 rounded-md text-sm leading-none shrink-0 select-none cursor-pointer"
        >
          {open ? '▾' : '⋮'}
        </span>
      </button>

      {open && r.detail && (
        <div className="px-2.5 pb-2.5 pt-1 border-t border-m3-outline-subtle/50">
          <div className="flex items-center gap-2 px-1 py-1.5 text-[10px] font-mono text-m3-outline">
            <span>
              {r.g.change > 0 ? `+${r.g.change}` : r.g.change} RR
            </span>
            <span>•</span>
            <span>
              HS {r.hsPct > 0 ? `${r.hsPct.toFixed(1)}%` : '—'}
            </span>
            <span>•</span>
            <span>KAST {r.kast}%</span>
            {card && card.kills3 + card.kills4 + card.aces > 0 && (
              <>
                <span>•</span>
                <span>
                  {card.kills3}×3k {card.kills4}×4k {card.aces}×Ace
                </span>
              </>
            )}
          </div>
          {teams.map((t) => (
            <div key={t.team} className="mt-1.5">
              <div className="text-[9px] font-bold uppercase tracking-[0.12em] text-m3-outline mb-1">
                Team {t.team} • {t.score}
              </div>
              {t.players.map((p) => {
                const isMe = p.puuid === puuid;
                const pacs = p.rounds > 0 ? Math.round(p.score / p.rounds) : 0;
                const hits = p.headshots + p.bodyshots + p.legshots;
                const phs = hits > 0 ? (p.headshots / hits) * 100 : 0;
                return (
                  <div
                    key={p.puuid || `${p.agent}-${p.kills}`}
                    className={`flex items-center justify-between gap-2 py-1 px-1.5 rounded-lg text-[11px] ${
                      isMe ? 'bg-m3-primary/10 border border-m3-primary/30' : ''
                    }`}>
                    <span className="truncate text-m3-on-surface flex items-center gap-1.5 min-w-0">
                      <span className="font-semibold truncate">{isMe ? 'You' : (p.name || p.agent)}</span>
                      <span className="text-m3-outline shrink-0"> • {p.agent}{p.tag ? ` #${p.tag}` : ''}</span>
                      <button
                        type="button"
                        onClick={(e) => handleCopyPlayer(e, p)}
                        className="p-0.5 rounded hover:bg-white/10 text-m3-outline hover:text-white transition-colors cursor-pointer shrink-0"
                        title={copiedKey === (p.puuid || p.name || p.agent) ? 'Copied!' : `Copy ${p.name || p.agent}${p.tag ? '#' + p.tag : ''}`}
                      >
                        {copiedKey === (p.puuid || p.name || p.agent) ? (
                          <Check className="w-2.5 h-2.5 text-emerald-400" />
                        ) : (
                          <Copy className="w-2.5 h-2.5" />
                        )}
                      </button>
                    </span>
                    <span className="font-mono text-m3-on-surface-variant shrink-0 tabular-nums">
                      {p.kills}/{p.deaths}/{p.assists} • {pacs} • {Math.round(phs)}%
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
          {tips.length > 0 && (
            <div className="mt-2 rounded-lg bg-m3-tertiary/10 border border-m3-tertiary/30 p-2 space-y-1">
              {tips.map((t, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[10px] text-m3-tertiary/90 leading-snug">
                  <Lightbulb className="w-3 h-3 shrink-0 mt-px" />
                  <span>{t}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
};

export const MatchHistory: React.FC = () => {
  const { profile, games, queueById, mapById, detailsById, agentInfo, tierIcons, trnMatchTrs, isLoading, banner, setBanner } =
    useTrackerData();
  const [agentFilter, setAgentFilter] = useState('All');
  const [mapFilter, setMapFilter] = useState('All');
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [selectedMatch, setSelectedMatch] = useState<{
    detail: TrackerMatchDetail;
    game: TrackerMmrPoint;
    mapName: string;
    queue: string;
  } | null>(null);
  const puuid = profile?.puuid ?? '';

  const infoByName = useMemo(() => {
    const m: Record<string, { name: string; icon: string; role: string; roleIcon: string }> = {};
    for (const v of Object.values(agentInfo)) m[v.name.toLowerCase()] = v;
    return m;
  }, [agentInfo]);

  const tierIconByName = useMemo(() => {
    const m: Record<string, string> = {};
    for (let t = 0; t <= 30; t++) {
      try {
        const n = tierName(t);
        if (n && tierIcons[t]) m[n.toLowerCase()] = tierIcons[t];
      } catch {}
    }
    return m;
  }, [tierIcons]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const g of games) {
      // Matches tab shows Competitive games only
      const queue = (
        g.queueId ||
        detailsById[g.matchId]?.queue ||
        queueById[g.matchId] ||
        ''
      ).toLowerCase();
      if (queue && queue !== 'competitive') continue;

      const detail = detailsById[g.matchId];
      const me = detail?.players.find((p) => p.puuid === puuid);
      const agent = me?.agent ?? '?';
      const map = mapById[g.matchId] ?? shortMapName(g.mapId, {});
      if (agentFilter !== 'All' && agent !== agentFilter) continue;
      if (mapFilter !== 'All' && map !== mapFilter) continue;
      const myTeam = me?.team ?? '';
      const us = myTeam && detail ? (detail.teamScore[myTeam] ?? 0) : 0;
      const them =
        myTeam && detail
          ? Math.max(0, ...Object.entries(detail.teamScore).filter(([t]) => t !== myTeam).map(([, n]) => n), 0)
          : 0;
      const won = detail && us !== them ? us > them : g.change > 0;
      const k = me?.kills ?? 0;
      const d = me?.deaths ?? 0;
      const a = me?.assists ?? 0;
      const acs = me && me.rounds > 0 ? Math.round(me.score / me.rounds) : 0;
      const dd = me ? me.damage - me.damageTaken : 0;
      const hits = (me?.headshots ?? 0) + (me?.bodyshots ?? 0) + (me?.legshots ?? 0);
      const hsPct = hits > 0 ? ((me?.headshots ?? 0) / hits) * 100 : 0;
      const place = detail
        ? [...detail.players].sort((x, y) => y.score - x.score).findIndex((p) => p.puuid === puuid) + 1
        : 0;
      let kast = 0;
      let k3 = 0;
      let k4 = 0;
      let aces = 0;
      let cw = 0;
      let cl = 0;
      if (detail) {
        try {
          const c = matchCard(detail, puuid);
          kast = c.kastPct;
          k3 = c.kills3;
          k4 = c.kills4;
          aces = c.aces;
        } catch {}
        try {
          const cc = countClutch(detail, puuid);
          cw = cc.won;
          cl = cc.lost;
        } catch {}
      }
      const kd = d > 0 ? k / d : k;
      const ddPr = me && me.rounds > 0 ? (me.damage - me.damageTaken) / me.rounds : 0;

      // Real Tracker Score from TRN (exact), falling back to harmonized formula
      const realTrs = trnMatchTrs?.[g.matchId];
      const fallbackTrs = detail
        ? calculateTrsFallback({
            kd,
            acs,
            ddPerRound: ddPr,
            kast,
            won,
          })
        : 0;
      const trs = typeof realTrs === 'number' && realTrs > 0 ? realTrs : fallbackTrs;

      out.push({
        g, detail, agent, won, us, them, k, d, a, acs, dd, hsPct, place,
        kast, cw, cl, k3, k4, aces,
        trs,
      });
    }
    return out;
  }, [games, detailsById, puuid, mapById, queueById, trnMatchTrs, agentFilter, mapFilter]);

  const agentsPlayed = useMemo(
    () => [...new Set(rows.map((r) => r.agent).filter((a) => a && a !== '?'))].sort(),
    [rows]
  );
  const mapsPlayed = useMemo(
    () =>
      [
        ...new Set(
          rows
            .map((r) => mapById[r.g.matchId] ?? shortMapName(r.g.mapId, {}))
            .filter((m) => m && m !== '?')
        ),
      ].sort(),
    [rows, mapById]
  );

  const sum = useMemo(() => {
    let w = 0;
    let k = 0;
    let d = 0;
    let dmg = 0;
    let rds = 0;
    for (const r of rows) {
      if (r.won) w++;
      k += r.k;
      d += r.d;
      const me = r.detail?.players.find((p) => p.puuid === puuid);
      if (me) {
        dmg += me.damage;
        rds += me.rounds;
      }
    }
    return {
      w,
      l: rows.length - w,
      kd: d > 0 ? k / d : k,
      adr: rds > 0 ? dmg / rds : 0,
    };
  }, [rows, puuid]);

  const topAgents = useMemo(() => {
    const m = new Map<string, { w: number; n: number; k: number; d: number }>();
    for (const r of rows) {
      if (r.agent === '?') continue;
      const e = m.get(r.agent) ?? { w: 0, n: 0, k: 0, d: 0 };
      e.n++;
      if (r.won) e.w++;
      e.k += r.k;
      e.d += r.d;
      m.set(r.agent, e);
    }
    return [...m.entries()]
      .map(([name, e]) => ({ name, ...e, wr: e.n > 0 ? (e.w / e.n) * 100 : 0, kd: e.d > 0 ? e.k / e.d : e.k }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 3);
  }, [rows]);

  const days = useMemo(() => {
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = dayLabel(r.g.when);
      const l = groups.get(key) ?? [];
      l.push(r);
      groups.set(key, l);
    }
    return [...groups.entries()].map(([label, rs]) => {
      let w = 0;
      let k = 0;
      let d = 0;
      let a = 0;
      let hs = 0;
      let hits = 0;
      let dmg = 0;
      let rds = 0;
      for (const r of rs) {
        if (r.won) w++;
        k += r.k;
        d += r.d;
        a += r.a;
        const me = r.detail?.players.find((p) => p.puuid === puuid);
        if (me) {
          hs += me.headshots;
          hits += me.headshots + me.bodyshots + me.legshots;
          dmg += me.damage;
          rds += me.rounds;
        }
      }
      return {
        label,
        rs,
        w,
        l: rs.length - w,
        kd: d > 0 ? k / d : k,
        kda: `${k}K // ${d}D // ${a}A`,
        kdaNum: d + a > 0 ? (k + a) / Math.max(1, d) : k + a,
        dd: dmg - rs.reduce((s, r) => s + (r.detail?.players.find((p) => p.puuid === puuid)?.damageTaken ?? 0), 0),
        hsPct: hits > 0 ? (hs / hits) * 100 : 0,
        acs: rds > 0 ? Math.round(dmg / rds) : 0,
      };
    });
  }, [rows, puuid]);

  const toggle = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!profile && games.length === 0) {
    return (
      <div className="h-full min-h-0 max-w-6xl mx-auto w-full overflow-y-auto custom-scrollbar px-4 sm:px-6 py-3.5 pb-8">
        <HistorySkeletons />
      </div>
    );
  }

  const sumWr = rows.length > 0 ? (sum.w / rows.length) * 100 : 0;

  return (
    <div className="h-full min-h-0 max-w-6xl mx-auto w-full overflow-y-auto custom-scrollbar px-4 sm:px-6 py-3.5 pb-8">
      <div className="flex flex-col gap-3">
        {banner && (
          <div className="p-2.5 rounded-xl bg-m3-primary-container/40 border border-m3-primary/40 text-m3-on-primary-container text-xs font-semibold flex items-center justify-between shrink-0">
            <div className="flex items-center space-x-2">
              <Check className="w-3.5 h-3.5 text-m3-primary shrink-0" />
              <span>{banner}</span>
            </div>
            <button
              onClick={() => setBanner(null)}
              className="text-m3-primary hover:underline text-xs ml-3 cursor-pointer font-bold shrink-0">
              Dismiss
            </button>
          </div>
        )}

        {/* Filters */}
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <div className="w-36">
            <CustomDropdown
              value={agentFilter}
              options={[{ value: 'All', label: 'All Agents' }, ...agentsPlayed.map((a) => ({ value: a, label: a }))]}
              onChange={setAgentFilter}
            />
          </div>
          <div className="w-36">
            <CustomDropdown
              value={mapFilter}
              options={[{ value: 'All', label: 'All Maps' }, ...mapsPlayed.map((m) => ({ value: m, label: m }))]}
              onChange={setMapFilter}
            />
          </div>
        </div>

        {/* Summary bar */}
        {rows.length > 0 && (
          <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-3 shadow-m3-1 shrink-0">
            <div className="flex items-stretch gap-3 flex-wrap">
              <div className="flex flex-col justify-center px-1 min-w-32">
                <div className="font-display font-extrabold text-base tabular-nums whitespace-nowrap">
                  <span className="text-m3-mint">{sum.w}W</span>
                  <span className="text-m3-outline"> - </span>
                  <span className="text-m3-coral">{sum.l}L</span>
                  <span className="text-m3-outline text-sm"> ({Math.round(sumWr)}%)</span>
                </div>
                <div className="text-[11px] font-mono font-bold text-m3-mint mt-0.5 whitespace-nowrap">
                  {sum.kd.toFixed(2)} K/D | {Math.round(sum.adr)} ADR
                </div>
              </div>
              <div className="flex items-stretch gap-2 ml-auto flex-wrap">
                {topAgents.map((a) => {
                  const info = infoByName[a.name.toLowerCase()];
                  return (
                    <div
                      key={a.name}
                      className="relative flex items-center gap-2 rounded-xl bg-m3-surface-container-low/60 border border-m3-outline-subtle/60 px-2.5 pt-2 pb-3 overflow-hidden min-w-36">
                      {info?.icon ? (
                        <img src={info.icon} alt={a.name} className="w-10 h-10 rounded-lg object-cover shrink-0" />
                      ) : null}
                      <div className="min-w-0">
                        <div className="text-[12px] font-bold text-m3-on-surface whitespace-nowrap tabular-nums">
                          {a.w}W - {a.n - a.w}L ({Math.round(a.wr)}%)
                        </div>
                        <div className="text-[10px] font-mono text-m3-outline">K/D {a.kd.toFixed(2)}</div>
                      </div>
                      <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-m3-outline-subtle/50">
                        <span className="block h-full bg-m3-mint" style={{ width: `${Math.round(a.wr)}%` }} />
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {/* Day groups */}
        {days.map((day) => {
          return (
            <div key={day.label} className="flex flex-col gap-2 shrink-0">
              <div className="flex items-center gap-2 sm:gap-3 px-1 flex-wrap">
                <span className="text-[13px] font-display font-bold text-m3-on-surface">{day.label}</span>
                <span className="text-[10px] font-mono font-bold text-m3-outline bg-m3-surface-container-high border border-m3-outline-subtle rounded-md px-1.5 py-px">
                  {day.rs.length}
                </span>
                <span className="text-[13px] font-display font-extrabold mx-auto">
                  <span className="text-m3-mint">{day.w} W</span>
                  <span className="text-m3-outline"> // </span>
                  <span className="text-m3-coral">{day.l} L</span>
                </span>
                <span className="ml-auto hidden xl:flex items-center gap-4">
                  <Stat label="K/D">
                    <span className={day.kd >= 1 ? 'text-m3-mint' : 'text-m3-coral'}>{day.kd.toFixed(1)}</span>
                  </Stat>
                  <span className="flex flex-col items-center">
                    <span className="text-[10px] font-mono text-m3-outline whitespace-nowrap">{day.kda}</span>
                    <span className="text-[13px] font-mono font-bold text-m3-on-surface tabular-nums">
                      {day.kdaNum.toFixed(2)} K/D/A
                    </span>
                  </span>
                  <Stat label="DDΔ">
                    <span className={day.dd >= 0 ? 'text-m3-mint' : 'text-m3-coral'}>
                      {day.dd > 0 ? `+${day.dd}` : day.dd}
                    </span>
                  </Stat>
                  <Stat label="HS%">
                    <span className="text-m3-on-surface">{Math.round(day.hsPct)}</span>
                  </Stat>
                  <Stat label="ACS">
                    <span className="text-m3-on-surface">{day.acs}</span>
                  </Stat>
                </span>
              </div>
              {day.rs.map((r, i) => (
                <MatchRow
                  key={r.g.matchId || r.g.when}
                  r={r}
                  index={i}
                  queue={queueLabel(r.g.queueId || detailsById[r.g.matchId]?.queue || queueById[r.g.matchId] || 'competitive')}
                  map={mapById[r.g.matchId] ?? shortMapName(r.g.mapId, {})}
                  icon={infoByName[r.agent.toLowerCase()]?.icon ?? ''}
                  rankIcon={tierIconByName[r.g.tier.toLowerCase()] ?? ''}
                  puuid={puuid}
                  open={openIds.has(r.g.matchId || String(r.g.when))}
                  onToggle={() => toggle(r.g.matchId || String(r.g.when))}
                  onOpenModal={() => {
                    if (r.detail) {
                      setSelectedMatch({
                        detail: r.detail,
                        game: r.g,
                        mapName: mapById[r.g.matchId] ?? shortMapName(r.g.mapId, {}),
                        queue: queueLabel(r.g.queueId || detailsById[r.g.matchId]?.queue || queueById[r.g.matchId] || 'competitive'),
                      });
                    }
                  }}
                />
              ))}
            </div>
          );
        })}

        {!profile && !isLoading && (
          <div className="p-4 rounded-xl bg-m3-surface-container-high/40 border border-m3-outline-subtle text-center text-[11px] text-m3-on-surface-variant shrink-0">
            Open the Riot Client and this tab fills itself — matches, scoreboards, roles, weapons.
          </div>
        )}
      </div>

      <MatchDetailModal
        isOpen={!!selectedMatch}
        onClose={() => setSelectedMatch(null)}
        detail={selectedMatch?.detail ?? null}
        game={selectedMatch?.game ?? null}
        seasonId={profile?.currentSeasonId}
        mapName={selectedMatch?.mapName ?? ''}
        queue={selectedMatch?.queue ?? ''}
        puuid={puuid}
        myAccountName={profile?.name}
        myAccountTag={profile?.tag}
        tierIcons={tierIcons}
        agentInfo={agentInfo}
        onSelectProfile={(name, tag) => {
          const trackerUrl = `https://tracker.gg/valorant/profile/riot/${encodeURIComponent(name + '#' + (tag || ''))}/overview`;
          try {
            if ((window as any).__TAURI__) {
              import('@tauri-apps/api/webviewWindow').then(({ WebviewWindow }) => {
                const win = new WebviewWindow(`player-${name.replace(/[^a-zA-Z0-9]/g, '')}-${Date.now() % 1000}`, {
                  url: trackerUrl,
                  title: `Recon • ${name}#${tag} Profile`,
                  width: 1240,
                  height: 860,
                  resizable: true,
                });
                win.once('tauri://error', () => window.open(trackerUrl, '_blank'));
              }).catch(() => window.open(trackerUrl, '_blank'));
              return;
            }
          } catch {}
          window.open(trackerUrl, '_blank');
        }}
      />
    </div>
  );
};
