import React from 'react';
import { AlertTriangle, Trophy } from 'lucide-react';
import { formatKd, formatPct } from '../../utils/format';
import type { AgentStatSummary } from '../../utils/mapMeta';
import type { BlitzAgentStat } from '../../utils/blitzMeta';

export interface MetaTilesProps {
  isEditMode: boolean;
  showMetaPicks: boolean;
  personalScope: 'map' | 'all' | 'preview';
  personalListCount: number;
  rankTierLabel: string | null;
  activeMapName: string;
  thinMapSample: boolean;
  mapGames: number;
  hasMetaForMap: boolean;
  hasWinningAgentOnMap: boolean;
  metaPicks: BlitzAgentStat[];
  topAgentsList: AgentStatSummary[];
  agentMap: Record<string, { name: string; icon: string; role: string }>;
  setViewMode: (mode: 'auto' | 'personal' | 'blitz') => void;
}

/* Top Agents / Blitz meta plate: moved verbatim from OverlayView (split 4/8).
 * Drag chrome stays in OverlayView; this is the stats body only. */

export const MetaTiles: React.FC<MetaTilesProps> = ({
  isEditMode,
  showMetaPicks,
  personalScope,
  personalListCount,
  rankTierLabel,
  activeMapName,
  thinMapSample,
  mapGames,
  hasMetaForMap,
  hasWinningAgentOnMap,
  metaPicks,
  topAgentsList,
  agentMap,
  setViewMode,
}) => (
<div
  className={`rounded-3xl border p-3 shadow-2xl flex flex-col gap-2 transition-all ${
    isEditMode
      ? 'bg-m3-surface-container/[0.85] border-m3-outline-variant/50 shadow-[0_16px_50px_rgba(0,0,0,0.9)] ring-1 ring-m3-outline-variant/30'
      : 'bg-m3-surface-container/[0.85] border-m3-outline-variant/50 shadow-2xl'
  }`}
>
  {/* Header with Map name & Mode toggle */}
  <div className="flex items-center justify-between px-1">
    <div className="flex items-center gap-1.5 min-w-0">
      <Trophy className="w-3.5 h-3.5 text-m3-gold shrink-0" />
      <span className="font-display font-black text-m3-on-surface text-xs tracking-wider uppercase truncate">
        {showMetaPicks
          ? `${activeMapName} • Recommended`
          : personalScope === 'map'
          ? `${activeMapName} • Your Agents`
          : personalScope === 'all'
          ? 'Your Agents • All Maps'
          : 'Your Agents • Preview'}
      </span>
    </div>
    <div className="flex items-center gap-1">
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setViewMode(showMetaPicks ? 'personal' : 'blitz')}
        className="px-2 py-0.5 rounded-full bg-m3-surface-container-high/60 hover:bg-m3-surface-container-highest border border-m3-outline-subtle/55 text-m3-on-surface-variant hover:text-white text-[9px] font-mono font-bold uppercase shrink-0 transition-colors flex items-center gap-1 cursor-pointer"
        data-tip="Toggle between your own agent stats and rank recommended picks"
      >
        {showMetaPicks ? (
          <span>Your Agents ({personalListCount})</span>
        ) : (
          <span>Meta{rankTierLabel ? ` (${rankTierLabel})` : ''}</span>
        )}
      </button>
    </div>
  </div>

  {/* Not enough games on this map to judge — say so instead of guessing */}
  {!showMetaPicks && personalScope === 'all' && (
    <div className="px-2.5 py-1 rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle/55 flex items-center gap-1.5 text-[10px] font-mono text-m3-on-surface-variant">
      <AlertTriangle className="w-3 h-3 text-m3-on-surface-variant shrink-0" />
      <span>
        {thinMapSample
          ? `Only ${mapGames} ${activeMapName} game${mapGames === 1 ? '' : 's'} — showing your full agent pool`
          : `No ${activeMapName} games recorded — showing your full agent pool`}
      </span>
    </div>
  )}

  {/* This map has no hand-tuned meta — say so instead of borrowing
      another map's picks and passing them off as this map's. */}
  {!hasMetaForMap && (
    <div className="px-2.5 py-1 rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle/55 flex items-center gap-1.5 text-[10px] font-mono text-m3-on-surface-variant">
      <AlertTriangle className="w-3 h-3 text-m3-on-surface-variant shrink-0" />
      <span>No {activeMapName} meta yet — showing your real numbers</span>
    </div>
  )}

  {/* If user struggles on this map (<50% win rate), show tactical alert */}
  {!hasWinningAgentOnMap && !showMetaPicks && personalScope === 'map' && (
    <div className="px-2.5 py-1 rounded-xl bg-amber-400/10 border border-amber-400/25 flex items-center justify-between text-[10px] font-mono text-amber-200">
      <div className="flex items-center gap-1.5">
        <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
        <span>&lt;50% Win Rate on {activeMapName}</span>
      </div>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setViewMode('blitz')}
        className="text-[9px] underline text-amber-300 hover:text-white cursor-pointer font-bold"
      >
        See Recommended
      </button>
    </div>
  )}

  {/* Table / Rows */}
  {showMetaPicks ? (
    /* RECOMMENDED PICKS FOR THIS MAP AND RANK (NO TIPS) */
    <div className="flex flex-col gap-1.5">
      <div className="px-1 text-[9px] font-mono text-m3-on-surface-variant flex items-center justify-between border-b border-m3-outline-subtle/55 pb-1">
        <span>Blitz Live Meta{rankTierLabel ? ` (${rankTierLabel})` : ''}</span>
        <span className="text-m3-on-surface-variant font-bold">Top 3 · Win% · Pick%</span>
      </div>
      {metaPicks.slice(0, 3).map((b) => {
        const norm = b.agent.toLowerCase();
        const meta = Object.values(agentMap).find((a) => a.name.toLowerCase() === norm);
        const icon =
          meta?.icon ||
          (norm === 'sova'
            ? 'https://media.valorant-api.com/agents/320b2a48-4d9b-a075-30f1-1f93a9b638fa/displayicon.png'
            : '');

        return (
          <div
            key={b.agent}
            className="grid grid-cols-[1fr_56px_50px_46px] items-center px-2.5 py-1.5 rounded-xl border border-m3-outline-subtle/55 bg-transparent hover:bg-m3-surface-container-high/50 text-xs transition-colors whitespace-nowrap min-w-0"
          >
            <div className="flex items-center gap-2 min-w-0 pr-1">
              {icon ? (
                <img
                  src={icon}
                  alt=""
                  draggable={false}
                  onError={(e) => {
                    (e.currentTarget as HTMLElement).style.display = 'none';
                  }}
                  className="w-7 h-7 rounded-lg object-cover shrink-0 border border-m3-outline-subtle/55 pointer-events-none select-none"
                />
              ) : (
                <div className="w-7 h-7 rounded-lg bg-m3-surface-container-high shrink-0 border border-m3-outline-subtle/55 flex items-center justify-center text-[10px] font-black text-m3-on-surface-variant">
                  {b.agent.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div className="flex flex-col min-w-0 leading-tight">
                <span className="font-bold text-[11px] text-m3-on-surface truncate">{b.agent}</span>
                <span className="text-[8px] font-mono text-m3-on-surface-variant truncate">{b.role}</span>
              </div>
            </div>

            <div className="text-center" data-tip="Games sampled from Blitz">
              <span className="px-1.5 py-0.5 rounded bg-m3-primary/25 text-m3-primary border border-m3-primary/30 text-[8px] font-mono font-bold uppercase">
                {b.matches >= 1000 ? `${(b.matches / 1000).toFixed(1)}k` : b.matches} G
              </span>
            </div>

            <div className="text-right font-mono text-[10px] font-bold text-m3-on-surface tabular-nums whitespace-nowrap" data-tip="Lobby Win Rate">
              {b.winRate}%
            </div>

            <div className="text-right font-mono text-[9px] text-m3-on-surface-variant font-medium tabular-nums whitespace-nowrap" data-tip="Pick Rate">
              {b.pickRate}%
            </div>
          </div>
        );
      })}
    </div>
  ) : (
    /* PLAYER'S OWN AGENT STATS */
    <div className="flex flex-col gap-1">
      <div className="px-1 text-[9px] font-mono text-m3-on-surface-variant flex items-center justify-between border-b border-m3-outline-subtle/55 pb-1 mb-0.5">
        <span>
          {personalScope === 'map'
            ? `Your record on ${activeMapName} (${mapGames} games)`
            : personalScope === 'all'
            ? 'Your agent pool (all maps, this act)'
            : 'Sample preview'}
        </span>
        <span className="text-m3-on-surface-variant font-bold">
          {personalScope === 'preview' ? 'Demo' : 'Win & K/D'}
        </span>
      </div>
      {/* Column Headers */}
      <div className="grid grid-cols-[1fr_58px_50px_46px_40px] items-center px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider text-m3-on-surface-variant border-b border-m3-outline-subtle/55 whitespace-nowrap">
        <span>Agent</span>
        <span className="text-right">Matches</span>
        <span className="text-right">Win%</span>
        <span className="text-right">K/D</span>
        <span className="text-right">HS%</span>
      </div>

      {topAgentsList.slice(0, 5).map((stat) => {
        const normName = stat.agent.toLowerCase();
        const meta = Object.values(agentMap).find(
          (a) => a.name.toLowerCase() === normName
        );
        const icon =
          meta?.icon ||
          (normName === 'sova'
            ? 'https://media.valorant-api.com/agents/320b2a48-4d9b-a075-30f1-1f93a9b638fa/displayicon.png'
            : '');
        const role = meta?.role || stat.role || 'Agent';
        const kd = formatKd(stat.kd);
        const kdColor =
          stat.kd != null && stat.kd >= 1 ? 'text-m3-on-surface font-semibold' : 'text-m3-on-surface-variant font-medium';
        return (
          <div
            key={stat.agent}
            className="grid grid-cols-[1fr_58px_50px_46px_40px] items-center px-2 py-1.5 rounded-xl border border-m3-outline-subtle/55 bg-transparent hover:bg-m3-surface-container-high/50 text-xs transition-colors whitespace-nowrap min-w-0"
          >
            {/* Agent Icon & Name */}
            <div className="flex items-center gap-2 min-w-0 pr-1">
              {icon ? (
                <img
                  src={icon}
                  alt=""
                  draggable={false}
                  onError={(e) => {
                    (e.currentTarget as HTMLElement).style.display = 'none';
                  }}
                  className="w-7 h-7 rounded-lg object-cover shrink-0 border border-m3-outline-subtle/55 pointer-events-none select-none"
                />
              ) : (
                <div className="w-7 h-7 rounded-lg bg-m3-surface-container-high shrink-0 border border-m3-outline-subtle/55 flex items-center justify-center text-[10px] font-black text-m3-on-surface-variant">
                  {stat.agent.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div className="flex flex-col min-w-0 flex-1 leading-tight">
                <span className="font-bold text-[11px] text-m3-on-surface truncate">{stat.agent}</span>
                <span className="text-[8px] font-mono text-m3-on-surface-variant truncate">{role}</span>
              </div>
            </div>

            {/* Matches on this map */}
            <div
              className="flex flex-col items-end leading-none font-mono"
              data-tip={`${stat.wins} Wins - ${stat.losses} Losses on ${activeMapName}`}
            >
              <span className="text-[10px] font-bold text-m3-on-surface">{stat.matches}G</span>
              <span className="text-[8px] text-m3-on-surface-variant mt-0.5">{stat.wins}W-{stat.losses}L</span>
            </div>

            {/* Win % */}
            <div className="text-right font-mono text-[10px] font-bold tabular-nums whitespace-nowrap" data-tip="Win Rate">
              <span className={(stat.winPct ?? -1) >= 50 ? 'text-m3-on-surface' : 'text-m3-on-surface-variant'}>
                {formatPct(stat.winPct, 1)}
              </span>
            </div>

            {/* K/D — TRN's map segment has no K/D, so only local games can fill it */}
            <div className="text-right font-mono text-[10px] font-bold tabular-nums whitespace-nowrap" data-tip="K/D Ratio (last-20 local games)">
              {stat.kd != null && stat.kd > 0 ? <span className={kdColor}>{kd}</span> : null}
            </div>

            {/* HS% */}
            <div className="text-right font-mono text-[10px] text-amber-200/90 font-medium tabular-nums whitespace-nowrap" data-tip="Headshot %">
              {stat.hsPct > 0 ? formatPct(stat.hsPct, 0) : null}
            </div>
          </div>
        );
      })}

      {/* No winning agent here → suggest the rank meta WITHOUT hiding
          the player's own list. */}
      {!hasWinningAgentOnMap && personalScope !== 'preview' && (
        <div className="mt-1 pt-1.5 border-t border-m3-outline-subtle/55 flex flex-col gap-1">
          <div className="px-1 flex items-center justify-between text-[9px] font-mono">
            <span className="flex items-center gap-1 text-amber-300">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              {personalScope === 'map' ? 'No agent above 50% here' : `No ${activeMapName} record yet`} — suggested
            </span>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setViewMode('blitz')}
              className="text-m3-on-surface-variant hover:text-white underline font-bold cursor-pointer shrink-0"
            >
              All
            </button>
          </div>
          {metaPicks.slice(0, 3).map((b) => {
            const meta = Object.values(agentMap).find(
              (a) => a.name.toLowerCase() === b.agent.toLowerCase()
            );
            return (
              <div
                key={b.agent}
                className="grid grid-cols-[1fr_52px_44px] items-center px-2 py-1 rounded-lg border border-amber-400/15 bg-amber-400/[0.04] whitespace-nowrap"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {meta?.icon ? (
                    <img
                      src={meta.icon}
                      alt=""
                      draggable={false}
                      className="w-6 h-6 rounded-md object-cover shrink-0 border border-m3-outline-subtle/55 pointer-events-none select-none"
                    />
                  ) : (
                    <div className="w-6 h-6 rounded-md bg-m3-surface-container-high shrink-0 border border-m3-outline-subtle/55" />
                  )}
                  <span className="font-bold text-[10px] text-m3-on-surface truncate">{b.agent}</span>
                  <span className="px-1 py-px rounded bg-m3-primary/25 text-m3-primary border border-m3-primary/30 text-[7px] font-mono font-bold uppercase shrink-0">
                    {b.matches >= 1000 ? `${(b.matches / 1000).toFixed(1)}k` : b.matches}g
                  </span>
                </div>
                <span className="text-right font-mono text-[10px] font-bold text-m3-on-surface tabular-nums whitespace-nowrap" data-tip="Win rate">
                  {b.winRate}%
                </span>
                <span className="text-right font-mono text-[9px] text-m3-on-surface-variant tabular-nums whitespace-nowrap" data-tip="Pick rate">
                  {b.pickRate}%
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  )}
</div>
);

