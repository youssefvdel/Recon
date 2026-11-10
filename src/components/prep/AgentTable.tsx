import { num, signedInt as signed } from './cell';
import React, { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { TrnAgentStat } from '../../utils/trn';

/** Agents table: ten columns, sortable headers, one row expanded at a time.
 *  No container card, no role bars, no detail cards — the expansion is a
 *  definition grid of the numbers the row cannot hold. */

type SortKey = 'agent' | 'hours' | 'matches' | 'winPct' | 'kd' | 'adr' | 'acs' | 'damageDeltaPerRound' | 'hsPct' | 'kast';

const COLS: { key: SortKey; label: string; align?: 'right' }[] = [
  { key: 'agent', label: 'Agent' },
  { key: 'hours', label: 'Time' },
  { key: 'matches', label: 'Matches' },
  { key: 'winPct', label: 'Win %' },
  { key: 'kd', label: 'K/D' },
  { key: 'adr', label: 'ADR' },
  { key: 'acs', label: 'ACS' },
  { key: 'damageDeltaPerRound', label: 'DDΔ' },
  { key: 'hsPct', label: 'HS %' },
  { key: 'kast', label: 'KAST' },
];

const timeLabel = (a: TrnAgentStat): string => {
  if (a.hours >= 1) return `${num(a.hours, 1)} hrs`;
  const mins = Math.round((a.timePlayedSeconds ?? 0) / 60);
  return mins > 0 ? `${mins} mins` : '';
};



/** A definition-grid cell: label + value, and nothing at all when the value is
 *  absent. `0` means "we have no number here", never "zero". */
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

export interface AgentTableProps {
  rows: TrnAgentStat[];
  agentInfo: Record<string, { name: string; icon: string; role: string; roleIcon: string }>;
  /* One expansion across BOTH sections, so the state lives in Prep. */
  openKey: string | null;
  onOpenChange: (key: string | null) => void;
}

export const AgentTable: React.FC<AgentTableProps> = ({ rows, agentInfo, openKey, onOpenChange }) => {
  const [sortKey, setSortKey] = useState<SortKey>('hours');
  const [sortAsc, setSortAsc] = useState(false);

  const sorted = useMemo(() => {
    const val = (a: TrnAgentStat): number | string =>
      sortKey === 'agent' ? a.agent.toLowerCase() : Number(a[sortKey] ?? 0);
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
    return <p className="py-3 text-micro font-mono text-m3-outline">No agent data for this act yet.</p>;
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
          <th className="w-8" />
        </tr>
      </thead>
      <tbody>
        {sorted.map((a) => {
          const isOpen = openKey === a.agentKey;
          const meta = Object.values(agentInfo).find((x) => x.name.toLowerCase() === a.agent.toLowerCase());
          return (
            <React.Fragment key={a.agentKey}>
              <tr
                onClick={() => onOpenChange(isOpen ? null : a.agentKey)}
                className={`border-b border-m3-outline-subtle/50 cursor-pointer text-xs ${
                  isOpen ? 'bg-m3-surface-container-low/40' : 'hover:bg-m3-surface-container-high/25'
                }`}
              >
                <td className="py-2 pr-3">
                  <span className="flex items-center gap-2 min-w-0">
                    {meta?.icon && <img src={meta.icon} alt="" className="w-6 h-6 object-contain shrink-0" />}
                    <span className="text-m3-on-surface truncate">{a.agent}</span>
                    {meta?.role && (
                      <span className="text-micro font-mono text-m3-outline shrink-0">{meta.role}</span>
                    )}
                  </span>
                </td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">{timeLabel(a)}</td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">{a.matches}</td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">{num(a.winPct, 1, '%')}</td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">{num(a.kd, 2)}</td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">{num(a.adr, 1)}</td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">{num(a.acs, 1)}</td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">
                  {signed(a.damageDeltaPerRound)}
                </td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">{num(a.hsPct, 1, '%')}</td>
                <td className="py-2 pr-3 font-mono tabular-nums text-m3-outline">
                  {a.kast > 0 ? `${num(a.kast, 1, '%')}` : ''}
                </td>
                <td className="py-2 text-m3-outline">
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                </td>
              </tr>
              {isOpen && (
                <tr className="border-b border-m3-outline-subtle/50">
                  <td colSpan={COLS.length + 1} className="px-0 py-3">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3 pt-1">
                      <Def label="Best kills" value={a.bestKills} />
                      <Def label="First bloods" value={a.firstBloods} />
                      <Def label="Aces" value={a.aces} />
                      <Def label="Clutches" value={a.clutches} />
                      <Def label="Def rounds won" value={a.defenseRoundsWon} />
                      <Def label="Def rounds lost" value={a.defenseRoundsLost} />
                      <Def label="Def win %" value={a.defenseRoundsWinPct} />
                      <Def label="Def K/D" value={a.defenseKd} />
                      <Def label="Def kills" value={a.defenseKills} />
                      <Def label="Def assists" value={a.defenseAssists} />
                      <Def label="Defuses / match" value={a.defusesPerMatch} />
                      <Def label="Atk rounds won" value={a.attackRoundsWon} />
                      <Def label="Atk rounds lost" value={a.attackRoundsLost} />
                      <Def label="Atk win %" value={a.attackRoundsWinPct} />
                      <Def label="Atk K/D" value={a.attackKd} />
                      <Def label="Atk kills" value={a.attackKills} />
                      <Def label="Atk assists" value={a.attackAssists} />
                      <Def label="Plants / match" value={a.plantsPerMatch} />
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
