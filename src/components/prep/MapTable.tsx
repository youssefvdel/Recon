import React, { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { TrnMapStat } from '../../utils/trn';

/** Maps table: nine columns, sortable headers, one row expanded at a time.
 *  Plain thumbnail (no card, no gradient), top agents as icons with their win %
 *  underneath, and a definition grid instead of metric cards or bars. */

type SortKey = 'name' | 'winPct' | 'matchesWon' | 'matchesLost' | 'kd' | 'adr' | 'acs' | 'damageDeltaPerRound';

const COLS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Map' },
  { key: 'winPct', label: 'Win %' },
  { key: 'matchesWon', label: 'Wins' },
  { key: 'matchesLost', label: 'Losses' },
  { key: 'kd', label: 'K/D' },
  { key: 'adr', label: 'ADR' },
  { key: 'acs', label: 'ACS' },
  { key: 'damageDeltaPerRound', label: 'DDΔ' },
];

const signed = (n: number): string => (n > 0 ? `+${Math.round(n)}` : String(Math.round(n)));

const Def: React.FC<{ label: string; value?: string | number | null }> = ({ label, value }) => {
  const text =
    typeof value === 'number' ? (Number.isFinite(value) && value > 0 ? String(Math.round(value * 10) / 10) : '') : value ?? '';
  if (!text) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-micro font-mono uppercase tracking-wider text-m3-outline">{label}</span>
      <span className="text-xs text-m3-on-surface tabular-nums">{text}</span>
    </div>
  );
};

export interface MapTableProps {
  rows: TrnMapStat[];
}

export const MapTable: React.FC<MapTableProps> = ({ rows }) => {
  const [sortKey, setSortKey] = useState<SortKey>('winPct');
  const [sortAsc, setSortAsc] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const val = (m: TrnMapStat): number | string => (sortKey === 'name' ? m.name.toLowerCase() : Number(m[sortKey] ?? 0));
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const cmp = typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y;
      return sortAsc ? cmp : -cmp;
    });
  }, [rows, sortKey, sortAsc]);

  const onSort = (key: SortKey): void => {
    if (key === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  if (sorted.length === 0) {
    return <p className="py-3 text-micro font-mono text-m3-outline">No map data for this act yet.</p>;
  }

  return (
    <table className="w-full border-collapse text-left">
      <thead>
        <tr className="text-micro font-mono uppercase tracking-wider text-m3-outline">
          {COLS.map((c) => {
            const active = c.key === sortKey;
            return (
              <th key={c.key} className="py-2 pr-3 font-bold whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => onSort(c.key)}
                  className={`cursor-pointer ${active ? 'text-m3-primary' : 'hover:text-m3-on-surface'}`}
                  aria-sort={active ? (sortAsc ? 'ascending' : 'descending') : 'none'}
                >
                  {c.label}
                  {active ? (sortAsc ? ' ↑' : ' ↓') : ''}
                </button>
              </th>
            );
          })}
          <th className="py-2 pr-3 font-bold">Top agents</th>
          <th className="w-8" />
        </tr>
      </thead>
      <tbody>
        {sorted.map((m) => {
          const isOpen = open === m.key;
          return (
            <React.Fragment key={m.key}>
              <tr
                onClick={() => setOpen(isOpen ? null : m.key)}
                className={`border-b border-m3-outline-subtle/50 cursor-pointer text-xs ${
                  isOpen ? 'bg-m3-surface-container-low/40' : 'hover:bg-m3-surface-container-high/25'
                }`}
              >
                <td className="py-2 pr-3">
                  <span className="flex items-center gap-2 min-w-0">
                    {m.imageUrl && (
                      <img src={m.imageUrl} alt="" className="w-12 h-7 object-cover shrink-0" />
                    )}
                    <span className="text-[13px] text-m3-on-surface truncate">{m.name}</span>
                  </span>
                </td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">{m.winPct.toFixed(1)}%</td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">{m.matchesWon}</td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">{m.matchesLost}</td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">{m.kd.toFixed(2)}</td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">{m.adr.toFixed(1)}</td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">{m.acs.toFixed(1)}</td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">{signed(m.damageDeltaPerRound)}</td>
                <td className="py-2 pr-3">
                  <span className="flex items-end gap-2">
                    {(m.topAgents ?? []).slice(0, 3).map((a) => (
                      <span key={a.name} className="flex flex-col items-center gap-0.5">
                        {a.icon && <img src={a.icon} alt={a.name} className="w-5 h-5 object-contain" />}
                        <span className="text-micro font-mono text-m3-outline tabular-nums">
                          {a.winPct > 0 ? `${Math.round(a.winPct)}%` : ''}
                        </span>
                      </span>
                    ))}
                  </span>
                </td>
                <td className="py-2 text-m3-outline">
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                </td>
              </tr>
              {isOpen && (
                <tr className="border-b border-m3-outline-subtle/50">
                  <td colSpan={COLS.length + 2} className="px-0 py-3">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3 pt-1">
                      <Def label="Kills" value={m.kills} />
                      <Def label="Deaths" value={m.deaths} />
                      <Def label="Assists" value={m.assists} />
                      <Def label="HS %" value={m.headshotsPct} />
                      <Def label="Matches" value={m.matchesPlayed} />
                      <Def label="Time (s)" value={m.timePlayedSeconds} />
                      <Def label="Aces" value={m.aces} />
                      <Def label="Clutches" value={m.clutches} />
                      <Def label="Thrifty" value={m.thrifty} />
                      <Def label="Flawless" value={m.flawless} />
                      <Def label="Plants" value={m.plants} />
                      <Def label="Defuses" value={m.defuses} />
                      <Def label="Atk win %" value={m.attackRoundsWinPct} />
                      <Def label="Atk kills" value={m.attackKills} />
                      <Def label="Atk deaths" value={m.attackDeaths} />
                      <Def label="Atk assists" value={m.attackAssists} />
                      <Def label="Def win %" value={m.defenseRoundsWinPct} />
                      <Def label="Def kills" value={m.defenseKills} />
                      <Def label="Def deaths" value={m.defenseDeaths} />
                      <Def label="Def assists" value={m.defenseAssists} />
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
};
