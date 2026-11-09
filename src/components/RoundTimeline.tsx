import React, { useId, useMemo, useRef, useState } from 'react';
import { Bomb, ChevronDown, Wrench } from 'lucide-react';
import type { MatchRoundDetail, MatchRoundPlayer } from '../types';

/* Round-by-round view for a tracked match (docs/features/round-timeline.md §3).
 *
 * Data comes from the existing match-details payload via
 * `MatchDetail.roundDetails` — no new network call. The types are the frozen
 * §1 definitions from src/types.ts (ts-client owns them).
 *
 * Collapsed by default because the match modal is already dense. Selecting a
 * round uses a tablist: roving tabindex + Arrow/Home/End move both selection
 * and focus. Everything is instant (no height animation) so opening it never
 * shifts the scoreboard above; the only transition is the chevron, which the
 * `motion-reduce` variant disables.
 */

export interface RoundTimelineRosterEntry {
  puuid: string;
  name: string;
  tag?: string;
  team: string;
  agent?: string;
}

export interface RoundTimelineProps {
  roundDetails?: MatchRoundDetail[] | null;
  subjectPuuid: string;
  roster: RoundTimelineRosterEntry[];
  /** weapon id → display name, from the existing gameData() cache. */
  weaponNames?: Record<string, string>;
}

/* The match-details mapper currently stores `roundNum` 0-based (18 rounds ->
 * 0..17) while Riot's payload is 1-based. Display the human number; if the
 * mapper ever stores the payload value directly, delete this +1. */
const displayRound = (roundNum: number): number => roundNum + 1;

const TEAM_TONE: Record<string, { box: string; text: string; label: string }> = {
  Blue: {
    box: 'bg-m3-mint/15 border-m3-mint/40',
    text: 'text-m3-mint',
    label: 'Blue',
  },
  Red: {
    box: 'bg-m3-coral/15 border-m3-coral/40',
    text: 'text-m3-coral',
    label: 'Red',
  },
};

const toneFor = (team: string) =>
  TEAM_TONE[team] ?? {
    box: 'bg-m3-primary/15 border-m3-primary/40',
    text: 'text-m3-primary',
    label: team || 'Unknown',
  };

const fmtClock = (ms?: number): string => {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '';
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

const fmtMoney = (v?: number): string =>
  typeof v === 'number' && Number.isFinite(v) ? `$${v.toLocaleString('en-US')}` : '—';

/** Signed money for the economy strip: +$650 / -$300 / $0. */
const fmtSignedMoney = (v?: number): string => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  if (v < 0) return `-$${Math.abs(v).toLocaleString('en-US')}`;
  return v > 0 ? `+$${v.toLocaleString('en-US')}` : '$0';
};

const weaponLabel = (id: string | undefined, names?: Record<string, string>): string => {
  if (!id) return '';
  return names?.[id] ?? names?.[id.toLowerCase()] ?? id;
};

export const RoundTimeline: React.FC<RoundTimelineProps> = ({
  roundDetails,
  subjectPuuid,
  roster,
  weaponNames,
}) => {
  const rounds = useMemo(() => roundDetails ?? [], [roundDetails]);
  const hasData = rounds.length > 0;

  const [expanded, setExpanded] = useState(false);
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  const [playerPuuid, setPlayerPuuid] = useState(subjectPuuid);
  const panelId = useId();
  const playerSelectId = useId();
  const tabRefs = useRef(new Map<number, HTMLButtonElement>());

  const rosterByPuuid = useMemo(() => {
    const m = new Map<string, RoundTimelineRosterEntry>();
    for (const p of roster) m.set(p.puuid.toLowerCase(), p);
    return m;
  }, [roster]);

  const nameFor = (puuid: string | undefined): string => {
    if (!puuid) return 'Unknown';
    const p = rosterByPuuid.get(puuid.toLowerCase());
    return p?.name || `Player ${puuid.slice(0, 6)}`;
  };

  const subject = roster.find((p) => p.puuid.toLowerCase() === playerPuuid.toLowerCase());
  /* Keep the roster's casing for the <select> value (options use it verbatim)
     and lowercase only for puuid comparisons. */
  const effectivePuuid = subject?.puuid ?? roster[0]?.puuid ?? playerPuuid;
  const effectivePuuidKey = effectivePuuid.toLowerCase();
  const selectedPlayerName =
    rosterByPuuid.get(effectivePuuidKey)?.name ?? subjectPuuid.slice(0, 6);

  const selected =
    rounds.find((r) => r.roundNum === selectedRound) ?? rounds[0] ?? null;

  const selectRound = (roundNum: number): void => {
    setSelectedRound(roundNum);
    requestAnimationFrame(() => {
      tabRefs.current
        .get(roundNum)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  };

  const moveSelection = (delta: 1 | -1 | 'first' | 'last'): void => {
    if (rounds.length === 0) return;
    const currentIdx = Math.max(
      0,
      rounds.findIndex((r) => r.roundNum === selected?.roundNum)
    );
    const nextIdx =
      delta === 'first'
        ? 0
        : delta === 'last'
          ? rounds.length - 1
          : (currentIdx + delta + rounds.length) % rounds.length;
    const next = rounds[nextIdx];
    setSelectedRound(next.roundNum);
    requestAnimationFrame(() => tabRefs.current.get(next.roundNum)?.focus());
  };

  const onStripKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      moveSelection('first');
    } else if (e.key === 'End') {
      e.preventDefault();
      moveSelection('last');
    }
  };

  /* Kill lines for the selected round, split by the killer's team. Players
     whose puuid is not in the roster (partial payload) are skipped rather
     than mislabelled. */
  type KillLine = {
    killerPuuid: string;
    victimPuuid: string;
    killer: string;
    victim: string;
    weapon?: string;
    clock: string;
  };
  const blueKills: KillLine[] = [];
  const redKills: KillLine[] = [];
  if (selected) {
    for (const p of selected.players) {
      const team = rosterByPuuid.get(p.puuid.toLowerCase())?.team;
      const list = team === 'Blue' ? blueKills : team === 'Red' ? redKills : null;
      if (!list) continue;
      for (const k of p.killsDetail ?? []) {
        list.push({
          killerPuuid: p.puuid,
          victimPuuid: k.victimPuuid,
          killer: nameFor(p.puuid),
          victim: nameFor(k.victimPuuid),
          weapon: weaponLabel(k.weapon, weaponNames),
          clock: fmtClock(k.roundTimeMs),
        });
      }
    }
  }

  const economyFor = (round: MatchRoundDetail): MatchRoundPlayer | undefined =>
    round.players?.find((p) => p.puuid.toLowerCase() === effectivePuuidKey);

  const selectedEconomy = selected ? economyFor(selected) : undefined;

  return (
    <section className="shrink-0 rounded-2xl border border-m3-outline-subtle bg-m3-surface-container">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="w-full px-3.5 py-2.5 flex items-center justify-between gap-3 text-left cursor-pointer"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-bold text-m3-on-surface font-display">Round by round</span>
          <span className="text-micro font-mono text-m3-outline truncate">
            {hasData ? `${rounds.length} rounds` : 'no round data'}
          </span>
        </span>
        <ChevronDown
          className={`w-4 h-4 text-m3-outline shrink-0 transition-transform duration-150 motion-reduce:transition-none ${
            expanded ? 'rotate-180' : ''
          }`}
          aria-hidden="true"
        />
      </button>

      {expanded && (
        <div id={panelId} className="border-t border-m3-outline-subtle/60 px-3.5 pb-3.5 pt-3 flex flex-col gap-3">
          {!hasData ? (
            <p className="text-xs text-m3-outline leading-relaxed">
              No round-by-round data for this match. It was cached before round details were
              recorded — open the match again after the tracker refreshes.
            </p>
          ) : (
            <>
              {/* Round strip */}
              <div
                role="tablist"
                aria-label="Rounds"
                onKeyDown={onStripKeyDown}
                className="flex items-end gap-1 overflow-x-auto custom-scrollbar pb-1"
              >
                {rounds.map((r) => {
                  const tone = toneFor(r.winningTeam);
                  const isSelected = r.roundNum === (selected?.roundNum ?? rounds[0].roundNum);
                  const label = `Round ${displayRound(r.roundNum)}: ${tone.label} won${
                    r.roundResult ? ` (${r.roundResult})` : ''
                  }${r.bombPlanter ? ', bomb planted' : ''}${r.bombDefuser ? ', bomb defused' : ''}`;
                  return (
                    <button
                      key={r.roundNum}
                      ref={(el) => {
                        if (el) tabRefs.current.set(r.roundNum, el);
                        else tabRefs.current.delete(r.roundNum);
                      }}
                      type="button"
                      role="tab"
                      id={`round-tab-${r.roundNum}`}
                      aria-selected={isSelected}
                      aria-controls="round-detail-panel"
                      tabIndex={isSelected ? 0 : -1}
                      aria-label={label}
                      onClick={() => selectRound(r.roundNum)}
                      className="shrink-0 flex flex-col items-center gap-1 rounded-lg p-0.5 cursor-pointer"
                    >
                      <span
                        className={`relative flex h-8 w-9 items-center justify-center rounded-md border ${tone.box} ${
                          isSelected
                            ? 'ring-2 ring-m3-primary ring-offset-1 ring-offset-m3-surface-container'
                            : ''
                        }`}
                      >
                        {r.bombPlanter && (
                          <Bomb className={`w-3 h-3 ${tone.text}`} aria-hidden="true" />
                        )}
                        {r.bombDefuser && (
                          <Wrench className={`w-3 h-3 ${tone.text}`} aria-hidden="true" />
                        )}
                      </span>
                      <span
                        className={`text-micro font-mono tabular-nums ${
                          isSelected ? 'text-m3-primary font-bold' : 'text-m3-outline'
                        }`}
                      >
                        {displayRound(r.roundNum)}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Marker legend — the strip icons are not self-explanatory. */}
              <div className="flex items-center gap-3 text-micro text-m3-outline -mt-1">
                <span className="inline-flex items-center gap-1">
                  <Bomb className="w-3 h-3" aria-hidden="true" /> planted
                </span>
                <span className="inline-flex items-center gap-1">
                  <Wrench className="w-3 h-3" aria-hidden="true" /> defused
                </span>
              </div>

              {/* Selected round */}
              {selected && (
                <div
                  id="round-detail-panel"
                  role="tabpanel"
                  aria-labelledby={`round-tab-${selected.roundNum}`}
                  tabIndex={0}
                  className="rounded-xl border border-m3-outline-subtle bg-m3-surface-container-low p-3 flex flex-col gap-2.5"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-display font-bold text-sm text-m3-on-surface">
                      Round {displayRound(selected.roundNum)} of {rounds.length}
                    </span>
                    <span className={`text-xs font-bold ${toneFor(selected.winningTeam).text}`}>
                      {selected.winningTeam || 'Unknown team'} won
                    </span>
                    {selected.roundResult && (
                      <span className="text-micro font-mono text-m3-outline">
                        {selected.roundResult}
                      </span>
                    )}
                    {selected.bombPlanter && (
                      <span className="text-micro text-m3-outline">
                        Plant: {nameFor(selected.bombPlanter)}
                        {selected.plantSite ? ` at ${selected.plantSite}` : ''}
                        {fmtClock(selected.plantRoundTimeMs)
                          ? ` · ${fmtClock(selected.plantRoundTimeMs)}`
                          : ''}
                      </span>
                    )}
                    {selected.bombDefuser && (
                      <span className="text-micro text-m3-outline">
                        Defuse: {nameFor(selected.bombDefuser)}
                        {fmtClock(selected.defuseRoundTimeMs)
                          ? ` · ${fmtClock(selected.defuseRoundTimeMs)}`
                          : ''}
                      </span>
                    )}
                    {!selected.bombPlanter && !selected.bombDefuser && (
                      <span className="text-micro text-m3-outline">No plant or defuse recorded</span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {(['Blue', 'Red'] as const).map((team) => {
                      const kills = team === 'Blue' ? blueKills : redKills;
                      const tone = toneFor(team);
                      return (
                        <div key={team} className="flex flex-col gap-1 min-w-0">
                          <span className={`text-micro font-bold uppercase tracking-wider ${tone.text}`}>
                            {team} kills ({kills.length})
                          </span>
                          {kills.length === 0 ? (
                            <span className="text-micro text-m3-outline">No kills recorded.</span>
                          ) : (
                            <ul className="flex flex-col gap-1">
                              {kills.map((k, i) => {
                                const highlighted =
                                  k.killerPuuid.toLowerCase() === effectivePuuidKey ||
                                  k.victimPuuid.toLowerCase() === effectivePuuidKey;
                                return (
                                  <li
                                    key={`${team}-${i}`}
                                    className={`flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-micro font-mono ${
                                      highlighted ? 'bg-m3-primary/10 text-m3-on-surface' : ''
                                    }`}
                                  >
                                    <span className="truncate max-w-[38%] text-m3-on-surface">
                                      {k.killer}
                                    </span>
                                    <span className="text-m3-outline" aria-hidden="true">
                                      →
                                    </span>
                                    <span className="truncate max-w-[38%] text-m3-on-surface-variant">
                                      {k.victim}
                                    </span>
                                    {k.weapon && (
                                      <span className="px-1 rounded bg-m3-surface-container-highest text-m3-outline truncate">
                                        {k.weapon}
                                      </span>
                                    )}
                                    {k.clock && (
                                      <span className="ml-auto text-m3-outline tabular-nums">
                                        {k.clock}
                                      </span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Player selector + economy strip */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <label
                      htmlFor={playerSelectId}
                      className="text-micro font-bold uppercase tracking-wider text-m3-outline"
                    >
                      Player
                    </label>
                    <select
                      id={playerSelectId}
                      value={effectivePuuid}
                      onChange={(e) => setPlayerPuuid(e.target.value)}
                      disabled={roster.length === 0}
                      className="h-8 px-2 rounded-lg bg-m3-surface-container-high border border-m3-outline-subtle text-xs text-m3-on-surface font-medium cursor-pointer disabled:opacity-50"
                    >
                      {roster.length === 0 && <option value="">No players</option>}
                      {(['Blue', 'Red'] as const).map((team) => {
                        const members = roster.filter((p) => p.team === team);
                        if (members.length === 0) return null;
                        return (
                          <optgroup key={team} label={team}>
                            {members.map((p) => (
                              <option key={p.puuid} value={p.puuid}>
                                {p.name}
                                {p.tag ? `#${p.tag}` : ''}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </select>
                  </div>
                  <span className="text-micro font-mono text-m3-outline">
                    {selectedEconomy
                      ? `Loadout ${fmtMoney(selectedEconomy.economy.loadoutValue)} · remaining ${fmtMoney(
                          selectedEconomy.economy.remaining
                        )}`
                      : 'No economy data for this round'}
                  </span>
                </div>

                <div className="flex gap-1.5 overflow-x-auto custom-scrollbar pb-1">
                  {rounds.map((r) => {
                    const line = economyFor(r);
                    const isSelected = r.roundNum === (selected?.roundNum ?? rounds[0].roundNum);
                    return (
                      <button
                        key={r.roundNum}
                        type="button"
                        onClick={() => selectRound(r.roundNum)}
                        aria-label={`Round ${displayRound(r.roundNum)} economy for ${selectedPlayerName}`}
                        aria-current={isSelected ? 'true' : undefined}
                        className={`shrink-0 w-16 rounded-md border px-1.5 py-1 text-left cursor-pointer ${
                          isSelected
                            ? 'border-m3-primary bg-m3-primary/10'
                            : 'border-m3-outline-subtle bg-m3-surface-container'
                        }`}
                      >
                        <span className="block text-micro font-mono text-m3-outline">R{displayRound(r.roundNum)}</span>
                        {line ? (
                          <>
                            <span className="block text-micro font-mono font-bold text-m3-on-surface">
                              {fmtMoney(line.economy.loadoutValue)}
                            </span>
                            <span
                              className={`block text-micro font-mono ${
                                line.economy.remaining > 0
                                  ? 'text-m3-mint'
                                  : line.economy.remaining < 0
                                    ? 'text-m3-coral'
                                    : 'text-m3-outline'
                              }`}
                            >
                              {fmtSignedMoney(line.economy.remaining)}
                            </span>
                          </>
                        ) : (
                          <span className="block text-micro text-m3-outline">—</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
};
