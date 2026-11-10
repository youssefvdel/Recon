import React from 'react';
import { Lock as LockIcon, EyeOff, Check, Clock } from 'lucide-react';
import type { LiveMatchPlayer } from '../../types';
import { StatValue } from '../StatValue';
import { ScoreBadge, scoreTier } from '../ScoreBadge';
import { formatPct } from '../../utils/format';
import {
  getFlagUrl,
  getCountryName,
  rankTooltip,
  shortAct,
  formatKd,
  getPartyStyle,
  byAcsDesc,
  TRN_PRIVATE_TOOLTIP,
  TRN_PENDING_TOOLTIP,
} from '../../utils/playerDisplay';

/* Pregame/team columns: moved verbatim from OverlayView (split 3/8). */

export const PregameTeamColumn: React.FC<{
  title: string;
  tagColor: string;
  players: LiveMatchPlayer[];
  tierIcons: Record<number, string>;
  seasons?: Record<string, string>;
  queueId?: string;
}> = ({ players, tierIcons, seasons }) => {
  return (
    <div className="flex flex-col gap-1.5 pointer-events-none select-none">
      {/* Table Column Headers: Score badge, Player, Rank, Peak, K/D, Win%, HS% */}
      <div className="grid grid-cols-[26px_1fr_40px_40px_48px_50px_48px] items-center px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider text-m3-on-surface-variant border-b border-m3-outline-subtle/55 whitespace-nowrap">
        <span className="text-center" data-tip="Tracker Score tier">TS</span>
        <span>Player</span>
        <span className="text-center">Rank</span>
        <span className="text-center">Peak</span>
        <span className="text-right">K/D</span>
        <span className="text-right">Win%</span>
        <span className="text-right">HS%</span>
      </div>

      {/* Teammate Rows */}
      <div className="flex flex-col gap-1">
        {players.map((p) => {
          const icon = tierIcons[p.tier];
          const peakIcon = tierIcons[p.peakTier];
          const kd = formatKd(p.kd);
          // formatKd() emits an em dash for "no data" — a placeholder, not a
          // value. Unknown cells stay empty (grid column keeps the alignment).
          const kdKnown = p.kd != null && p.kd !== '' && Number(p.kd) > 0;
          const locked = (p.selectionState || '').toLowerCase().includes('lock');
          // Private TRN profile: TRN-fed cells show a lock, not dashes.
          // (Name `privLocked`: `locked` above already means agent lock-in.)
          const privLocked = p.isTrnPrivate === true;
          const privLockCell = (
            <span data-tip={TRN_PRIVATE_TOOLTIP} className="inline-flex items-center justify-center text-zinc-500">
              <LockIcon className="w-2.5 h-2.5" />
            </span>
          );
          const hasPick = !locked && !!p.agentName && p.agentName !== 'Selecting…';
          const party = getPartyStyle(p.partyIndex);
          const flagUrl = getFlagUrl(p.country);
          const countryName = getCountryName(p.country);

          return (
            <div
              key={p.puuid}
              className={`relative overflow-hidden grid grid-cols-[26px_1fr_40px_40px_48px_50px_48px] items-center px-2.5 py-1 rounded-xl border text-xs transition-colors whitespace-nowrap min-w-0 ${
                party
                  ? `${party.bg} border-m3-outline-subtle/55`
                  : p.isMe
                  ? 'bg-m3-primary/15 border-m3-primary/30 text-m3-on-surface shadow-xs'
                  : 'bg-m3-surface-dim/25 hover:bg-m3-surface-container-high/50 border-m3-outline-subtle/55 text-m3-on-surface'
              }`}
            >
              {/* Party identifier: curved bow arc wrapping the left edge when queued in a party */}
              {party && (
                <svg
                  className={`absolute left-0 top-0 bottom-0 h-full w-2.5 pointer-events-none ${party.text} drop-shadow-[0_0_6px_currentColor]`}
                  viewBox="0 0 10 32"
                  fill="none"
                  preserveAspectRatio="none"
                >
                  <title>{`Queued together in ${party.name}`}</title>
                  <path
                    d="M 8 2.5 C 3.5 2.5, 1.5 5.5, 1.5 10 L 1.5 22 C 1.5 26.5, 3.5 29.5, 8 29.5"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
              )}
              {/* Tracker Score badge (hex tier emblem, never a raw number) */}
              <div
                className="flex items-center justify-center shrink-0"
                data-tip={
                  p.trnScore != null
                    ? `Tracker Score: ${p.trnScore} / 1000 — Tier ${scoreTier(p.trnScore).tier}`
                    : 'Tracker Score unavailable'
                }
              >
                {p.trnScore != null ? (
                  <ScoreBadge tier={scoreTier(p.trnScore).tier} size={20} />
                ) : privLocked ? (
                  privLockCell
                ) : (
                  <span className="w-5 h-5 rounded border border-m3-outline-subtle/55 bg-m3-surface-container-high/60 flex items-center justify-center text-[9px] font-mono">
                    <StatValue reason="Tracker Score unavailable" className="text-[9px]" />
                  </span>
                )}
              </div>

              {/* Agent Icon (with Flag overlay) + Player Name & Pick State */}
              <div className="flex items-center gap-2 min-w-0 pr-1">
                <div className="relative shrink-0">
                  {p.agentIcon ? (
                    <img
                      src={p.agentIcon}
                      alt=""
                      draggable={false}
                      onError={(e) => {
                        (e.currentTarget as HTMLElement).style.display = 'none';
                      }}
                      className={`w-[26px] h-[26px] rounded-lg object-cover border ${
                        locked ? 'border-m3-primary/60' : hasPick ? 'border-amber-300/60' : 'border-m3-outline-subtle/55'
                      } pointer-events-none select-none`}
                    />
                  ) : (
                    <div className="w-[26px] h-[26px] rounded-lg bg-m3-surface-container-high border border-m3-outline-subtle/55 flex items-center justify-center text-[10px] font-black text-m3-on-surface-variant">
                      ?
                    </div>
                  )}
                  {flagUrl && (
                    <img
                      src={flagUrl}
                      alt={p.country || ''}
                      data-tip={countryName ? `Country: ${countryName} (${p.country})` : `Country: ${p.country}`}
                      draggable={false}
                      onError={(e) => {
                        (e.currentTarget as HTMLElement).style.display = 'none';
                      }}
                      className="absolute -bottom-0.5 -right-0.5 w-3.5 h-2.5 object-cover rounded-[1.5px] shadow-sm border border-black/80 pointer-events-none select-none"
                    />
                  )}
                </div>

                <div className="flex flex-col min-w-0 flex-1 leading-tight">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {party && (
                      <span
                        className={`w-2 h-2 rounded-full ${party.bar} shrink-0 shadow-xs`}
                        data-tip={`Queued together in ${party.name}`}
                      />
                    )}
                    <span className="font-bold text-[12.5px] text-m3-on-surface truncate" data-tip={`${p.name}${p.tag ? '#' + p.tag : ''}`}>
                      {p.name}
                    </span>
                    {p.isMe && (
                      <span className="px-1.5 py-0.5 rounded bg-m3-primary-container text-[7.5px] font-black text-m3-on-surface uppercase shrink-0">
                        You
                      </span>
                    )}
                    {p.isIncognito && (
                      <span
                        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-300 border border-amber-400/30 text-[7.5px] font-mono font-bold uppercase shrink-0"
                        data-tip={
                          p.nameResolved
                            ? 'Name Hidden in Valorant (Unmasked by Recon)'
                            : 'Riot hides this name during live matches — revealed automatically after the game'
                        }
                      >
                        <EyeOff className="w-2.5 h-2.5" />
                        {p.nameResolved ? 'Unmasked' : 'Hidden'}
                      </span>
                    )}
                    {p.isTrnPrivate && (
                      <span
                        className="flex items-center px-1 py-px rounded bg-white/5 text-zinc-400 border border-white/10 shrink-0"
                        data-tip={TRN_PRIVATE_TOOLTIP}
                      >
                        <LockIcon className="w-2.5 h-2.5" />
                      </span>
                    )}
                  </div>
                  <span className="text-[9.5px] font-mono font-semibold">
                    {locked ? (
                      <span className="flex items-center gap-1 text-m3-primary">
                        <Check className="w-2.5 h-2.5 stroke-[3]" />
                        {p.agentName}
                      </span>
                    ) : hasPick ? (
                      <span className="flex items-center gap-1 text-amber-300">
                        <Clock className="w-2.5 h-2.5" />
                        {p.agentName}
                      </span>
                    ) : (
                      <span className="text-m3-outline">Picking…</span>
                    )}
                  </span>
                </div>
              </div>

              {/* Current Rank emblem + live RR. Unknown rank = empty box that
                  keeps the row height; no dash pretending to be a value. */}
              <div
                className="flex flex-col items-center justify-center leading-none"
                data-tip={rankTooltip(p, seasons?.[p.peakSeasonId?.toLowerCase() ?? ''])}
              >
                {icon ? (
                  <img src={icon} alt="" draggable={false} className="w-[22px] h-[22px] object-contain shrink-0" />
                ) : (
                  <span aria-hidden="true" className="block w-[22px] h-[22px]" />
                )}
                {p.tier > 2 && p.rr != null ? (
                  <span className="text-[8.5px] font-mono font-bold text-m3-primary mt-0.5">{p.rr}</span>
                ) : (
                  <span aria-hidden="true" className="block h-[9px] mt-0.5" />
                )}
              </div>

              {/* Peak Rank emblem + the act it was reached in */}
              <div
                className="flex flex-col items-center justify-center leading-none"
                data-tip={`Peak: ${p.peakRank}${
                  seasons?.[p.peakSeasonId?.toLowerCase() ?? '']
                    ? ` — ${seasons[p.peakSeasonId!.toLowerCase()]}`
                    : ''
                }`}
              >
                {peakIcon ? (
                  <img src={peakIcon} alt="" draggable={false} className="w-[18px] h-[18px] object-contain opacity-75 shrink-0" />
                ) : (
                  <span aria-hidden="true" className="block w-[18px] h-[18px]" />
                )}
                {p.peakSeasonId && seasons?.[p.peakSeasonId.toLowerCase()] && (
                  <span className="text-[7.5px] font-mono font-bold text-m3-on-surface-variant mt-0.5 tracking-tight">
                    {shortAct(seasons[p.peakSeasonId.toLowerCase()])}
                  </span>
                )}
              </div>

              {/* K/D */}
              <div className="text-right font-mono text-[11px] font-bold tabular-nums whitespace-nowrap" data-tip="K/D Ratio">
                {privLocked ? privLockCell : kdKnown ? <span className={kd.color}>{kd.text}</span> : null}
              </div>

              {/* Win % */}
              <div className="text-right font-mono text-[11px] font-semibold tabular-nums whitespace-nowrap" data-tip="Act Win Rate">
                {p.winPct != null ? (
                  <span className={p.winPct >= 50 ? 'text-m3-on-surface' : 'text-m3-on-surface-variant'}>
                    {formatPct(p.winPct, 0)}
                  </span>
                ) : privLocked ? (
                  privLockCell
                ) : null}
              </div>

              {/* HS % */}
              <div className="text-right font-mono text-[11px] tabular-nums whitespace-nowrap" data-tip="Headshot %">
                {p.hsPct != null ? (
                  <span className="text-amber-200/90 font-medium">{formatPct(p.hsPct, 0)}</span>
                ) : privLocked ? (
                  privLockCell
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/** Party sizes + best rank for one side, from data we actually have. */
function teamAtGlance(players: LiveMatchPlayer[]): { stacks: number[]; topRank: string | null } {
  const counts = new Map<number, number>();
  for (const p of players) {
    if (p.partyIndex && p.partyIndex > 0) {
      counts.set(p.partyIndex, (counts.get(p.partyIndex) ?? 0) + 1);
    }
  }
  const stacks = [...counts.values()]
    .filter((n) => n >= 2)
    .sort((a, b) => b - a);
  let top: LiveMatchPlayer | null = null;
  for (const p of players) {
    // tier 0-2 = Unranked/Iron placeholder from Riot, not a real rank claim.
    if (p.tier > 2 && p.rank && (!top || p.tier > top.tier)) top = p;
  }
  return { stacks, topRank: top?.rank ?? null };
}

export const VerticalSquadColumn: React.FC<{
  title: string;
  tagColor: string;
  players: LiveMatchPlayer[];
  tierIcons: Record<number, string>;
}> = ({ title, tagColor, players, tierIcons }) => {
  // One-glance facts for this side. Row cells are icon-sized, and their
  // data-tip tooltips can never fire in-game (the HUD is click-through), so the
  // two things a player acts on — who is queued together, and how high this
  // side goes — sit in the header where they always read. Omitted when unknown.
  const { stacks, topRank } = teamAtGlance(players);
  return (
  <div className="flex flex-col gap-1">
    <div className="flex items-center justify-between px-1.5 py-0.5">
      <span className={`text-[10px] font-bold uppercase tracking-wider ${tagColor}`}>{title}</span>
      <span className="flex items-center gap-1.5 text-[9px] font-mono">
        {stacks.length > 0 && (
          <span
            className="text-m3-on-surface-variant"
            data-tip="Party sizes queued together on this side"
          >
            {stacks.join('+')} stack
          </span>
        )}
        {topRank && (
          <span className="text-m3-primary/90 font-semibold" data-tip="Highest rank on this side">
            {topRank}
          </span>
        )}
        <span className="text-m3-on-surface-variant">{players.length}P</span>
      </span>
    </div>
    {/* Strongest combat score first — the board reads like the in-game
        leaderboard. Players with no ACS yet keep their relative order at the
        bottom rather than being given a fake score. */}
    {[...players].sort(byAcsDesc).map((p) => {
      const icon = tierIcons[p.tier];
      const peakIcon = tierIcons[p.peakTier];
      const kd = formatKd(p.kd);
      // formatKd() returns an em dash for "no data". A dash is a placeholder,
      // not a value, and the audit says omit those — so gate on the number.
      const kdKnown = p.kd != null && p.kd !== '' && Number(p.kd) > 0;
      // Private TRN profile: stat cells show a lock, not dashes.
      const privLocked = p.isTrnPrivate === true;
      const privLockCell = (
        <span data-tip={TRN_PRIVATE_TOOLTIP} className="inline-flex items-center justify-center text-zinc-500">
          <LockIcon className="w-2.5 h-2.5" />
        </span>
      );
      // "Still filling" vs "nothing there": a faint dot while the TRN fill is
      // queued or in flight, NOTHING once the verdict is "no data". A dash was a
      // placeholder posing as a value — omit it. One dot, no animation: this
      // grid repaints on every 2.5s tick.
      const trnBlank = (state: LiveMatchPlayer['trnState']) =>
        state === 'pending' ? (
          <span data-tip={TRN_PENDING_TOOLTIP} className="inline-flex items-center justify-center">
            <span className="block h-[3px] w-[3px] rounded-full bg-m3-outline/50" />
          </span>
        ) : null;
      const party = getPartyStyle(p.partyIndex);
      const flagUrl = getFlagUrl(p.country);
      const countryName = getCountryName(p.country);

      return (
        <div
          key={p.puuid}
          data-tip={`${p.name}${p.tag ? '#' + p.tag : ''} • ${p.agentName}${countryName ? ` • ${countryName}` : ''}`}
          className={`relative overflow-hidden grid grid-cols-[18px_22px_26px_24px_minmax(32px,1fr)_minmax(30px,1fr)_minmax(32px,1fr)_minmax(32px,1fr)] items-center gap-x-1.5 h-[28px] px-2 rounded-lg border text-xs transition-colors shrink-0 whitespace-nowrap min-w-0 ${
            party
              ? `${party.bg} border-m3-outline-subtle/55`
              : p.isMe
              ? 'bg-m3-primary/25 border-m3-primary/45 ring-1 ring-m3-primary/30 text-m3-on-surface shadow-xs'
              : 'bg-m3-surface-dim/25 hover:bg-m3-surface-container-high/50 border-m3-outline-subtle/55 text-m3-on-surface'
          }`}
        >
          {/* Party identifier: curved bow arc wrapping the left edge when queued in a party */}
          {party && (
            <svg
              className={`absolute left-0 top-0 bottom-0 h-full w-2 pointer-events-none ${party.text} drop-shadow-[0_0_5px_currentColor]`}
              viewBox="0 0 10 32"
              fill="none"
              preserveAspectRatio="none"
            >
              <title>{`Queued together in ${party.name}`}</title>
              <path
                d="M 8 2.5 C 3.5 2.5, 1.5 5.5, 1.5 10 L 1.5 22 C 1.5 26.5, 3.5 29.5, 8 29.5"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
          )}
          {/* Tracker Score tier badge */}
          <div
            className="flex items-center justify-center shrink-0"
            data-tip={
              p.trnScore != null
                ? `Tracker Score: ${p.trnScore} / 1000 — Tier ${scoreTier(p.trnScore).tier}`
                : p.isTrnPrivate
                ? TRN_PRIVATE_TOOLTIP
                : p.trnState === 'pending'
                ? TRN_PENDING_TOOLTIP
                : 'Tracker Score unavailable'
            }
          >
            {p.trnScore != null ? (
              <ScoreBadge tier={scoreTier(p.trnScore).tier} size={15} />
            ) : p.isTrnPrivate ? (
              <span className="w-3.5 h-3.5 rounded border border-m3-outline-subtle/55 bg-m3-surface-container-high/60 flex items-center justify-center text-m3-outline/70">
                <LockIcon className="w-2.5 h-2.5" />
              </span>
            ) : (
              trnBlank(p.trnState)
            )}
          </div>

          {/* Agent Icon (with Flag Overlay + Party dot badge) */}
          <div className="relative w-5 h-5 flex items-center justify-center shrink-0">
            {p.agentIcon ? (
              <img
                src={p.agentIcon}
                alt=""
                draggable={false}
                onError={(e) => {
                  (e.currentTarget as HTMLElement).style.display = 'none';
                }}
                className="w-5 h-5 rounded-md object-cover pointer-events-none select-none border border-m3-outline-subtle/55"
              />
            ) : (
              <div className="w-5 h-5 rounded-md bg-m3-surface-container-high border border-m3-outline-subtle/55 flex items-center justify-center text-[9px] font-bold text-m3-on-surface-variant">
                ?
              </div>
            )}
            {flagUrl && (
              <img
                src={flagUrl}
                alt={p.country || ''}
                data-tip={countryName ? `Country: ${countryName} (${p.country})` : `Country: ${p.country}`}
                draggable={false}
                onError={(e) => {
                  (e.currentTarget as HTMLElement).style.display = 'none';
                }}
                className="absolute -bottom-0.5 -right-0.5 w-3 h-2 object-cover rounded-[1.5px] shadow-xs border border-black/80 pointer-events-none select-none"
              />
            )}
            {party && (
              <span
                className={`absolute -top-0.5 -left-0.5 w-1.5 h-1.5 rounded-full ${party.bar} shadow-xs border border-black/60`}
                data-tip={`Queued together in ${party.name}`}
              />
            )}
          </div>

          {/* Current Rank emblem + live RR. Unknown rank renders an empty box
              (keeps the row height), never a dash pretending to be a value. */}
          <div className="flex flex-col items-center justify-center leading-none" data-tip={rankTooltip(p)}>
            {icon ? (
              <img src={icon} alt="" draggable={false} className="w-4 h-4 object-contain shrink-0" />
            ) : (
              <span aria-hidden="true" className="block w-4 h-4" />
            )}
            {p.tier > 2 && p.rr != null ? (
              <span className="text-[7px] font-mono font-bold text-m3-primary mt-0.5">{p.rr}</span>
            ) : (
              <span aria-hidden="true" className="block h-[8px] mt-0.5" />
            )}
          </div>

          {/* Peak Rank (Icon only) */}
          <div className="flex items-center justify-center" data-tip={`Peak: ${p.peakRank}`}>
            {peakIcon ? (
              <img src={peakIcon} alt="" draggable={false} className="w-3.5 h-3.5 object-contain opacity-75 shrink-0" />
            ) : (
              <span aria-hidden="true" className="block w-3.5 h-3.5" />
            )}
          </div>

          {/* ACS — the sort key, so it reads first among the numbers */}
          <div
            className="text-right font-mono text-[10px] font-bold tabular-nums leading-none"
            data-tip="Act-wide average combat score"
          >
            {p.acs != null ? (
              <span className={p.acs >= 200 ? 'text-m3-primary' : p.acs >= 150 ? 'text-m3-on-surface' : 'text-m3-on-surface-variant'}>
                {p.acs}
              </span>
            ) : privLocked ? (
              privLockCell
            ) : (
              trnBlank(p.trnState)
            )}
          </div>

          {/* KD */}
          <div className="text-right font-mono text-[10px] tabular-nums whitespace-nowrap" data-tip="Act-wide K/D">
            {privLocked ? privLockCell : kdKnown ? <span className={kd.color}>{kd.text}</span> : trnBlank(p.trnState)}
          </div>

          {/* Act-wide win rate */}
          <div className="text-right font-mono text-[10px] tabular-nums whitespace-nowrap" data-tip="Act-wide win rate">
            {p.winPct != null ? (
              <span className={p.winPct >= 50 ? 'text-m3-on-surface font-semibold' : 'text-m3-on-surface-variant'}>
                {formatPct(p.winPct, 0)}
              </span>
            ) : privLocked ? (
              privLockCell
            ) : (
              trnBlank(p.trnState)
            )}
          </div>

          {/* Act-wide headshot % */}
          <div className="text-right font-mono text-[10px] text-amber-200/90 tabular-nums whitespace-nowrap" data-tip="Act-wide headshot %">
            {p.hsPct != null && p.hsPct > 0 ? formatPct(p.hsPct, 0) : privLocked ? privLockCell : trnBlank(p.trnState)}
          </div>
        </div>
      );
    })}
  </div>
  );
};
