import React, { useMemo, useState } from 'react';
import { usePrepData } from '../../components/prep/usePrepData';
import { num, signedInt } from '../../components/prep/cell';
import type { TrnAgentStat } from '../../utils/trn';

/** Prep, rebuilt on the v2 tokens.
 *
 *  Two sections in one 940 column, no inner tabs, no cards: section headings and
 *  hairline rows. ONE expansion across both sections — opening a map row closes
 *  an agent row — because two open rows across two tables is two answers to the
 *  same question.
 *
 *  Every number is absent when the payload cannot support it (`num` renders
 *  nothing for a non-finite value); nothing here substitutes 0 or a dash. */

const COLS = 'grid items-center gap-3';
const AGENT_COLS = `${COLS} grid-cols-[minmax(0,1.4fr)_64px_64px_64px_64px_64px_64px_56px_56px_64px]`;
const MAP_COLS = `${COLS} grid-cols-[minmax(0,1.4fr)_64px_56px_56px_64px_64px_64px_56px_minmax(0,1fr)]`;

const Head: React.FC<{ children: React.ReactNode; span?: number }> = ({ children, span }) => (
  <span
    className="text-[10px] uppercase tracking-[0.16em]"
    style={{ color: 'var(--on-surface-muted)', gridColumn: span ? `span ${span}` : undefined }}
  >
    {children}
  </span>
);

const Cell: React.FC<{ children: React.ReactNode; dim?: boolean }> = ({ children, dim }) => (
  <span
    className="text-[12px] tabular-nums text-right truncate"
    style={{ fontFamily: 'var(--font-mono)', color: dim ? 'var(--on-surface-muted)' : 'var(--on-surface)' }}
  >
    {children}
  </span>
);

const Detail: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-baseline justify-between gap-4 py-1">
    <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--on-surface-muted)' }}>
      {label}
    </span>
    <span className="text-[12px] tabular-nums" style={{ fontFamily: 'var(--font-mono)', color: 'var(--on-surface)' }}>
      {value}
    </span>
  </div>
);

export const Prep: React.FC = () => {
  const { actId, setActId, actOptions, agents, maps, isLoading } = usePrepData();
  /* One expansion for both sections: {section, key}. */
  const [open, setOpen] = useState<{ section: 'agents' | 'maps'; key: string } | null>(null);
  const toggle = (section: 'agents' | 'maps', key: string): void =>
    setOpen((cur) => (cur && cur.section === section && cur.key === key ? null : { section, key }));

  const sortedAgents = useMemo(
    () => [...agents].sort((a, b) => (b.hours ?? 0) - (a.hours ?? 0)),
    [agents]
  );
  const sortedMaps = useMemo(
    () => [...maps].sort((a, b) => (b.winPct ?? 0) - (a.winPct ?? 0)),
    [maps]
  );

  const agentDetail = (a: TrnAgentStat): [string, string][] => [
    ['Kills / deaths / assists', `${a.kills} / ${a.deaths} / ${a.assists}`],
    ['KAST', num(a.kast, 1, '%')],
    ['First bloods', num(a.firstBloods, 0)],
    ['First deaths', num(a.firstDeaths, 0)],
    ['Aces', num(a.aces, 0)],
    ['Clutches', num(a.clutches, 0)],
    ['Flawless', num(a.flawless, 0)],
    ['Attack rounds', `${a.attackRoundsWon} won / ${a.attackRoundsLost} lost`],
    ['Defence rounds', `${a.defenseRoundsWon} won / ${a.defenseRoundsLost} lost`],
    ['Attack K/D', num(a.attackKd, 2)],
    ['Defence K/D', num(a.defenseKd, 2)],
    ['Plants / match', num(a.plantsPerMatch, 2)],
    ['Defuses / match', num(a.defusesPerMatch, 2)],
    ['Time played', num(a.hours, 1, ' h')],
  ];

  return (
    <div className="max-w-[940px] mx-auto w-full px-6 pt-8 pb-16">
      <div className="flex items-baseline justify-between gap-4 pb-2 border-b" style={{ borderColor: 'var(--outline)' }}>
        <h1 className="text-[20px] font-semibold tracking-tight" style={{ color: 'var(--on-surface)' }}>
          Prep
        </h1>
        {/* One act selector for both sections: a second copy is a second answer. */}
        <select
          value={actId ?? ''}
          onChange={(e) => setActId(e.target.value)}
          className="text-[12px] px-2 py-1 rounded-sm outline-none"
          style={{
            background: 'var(--surface-2)',
            color: 'var(--on-surface)',
            border: '1px solid var(--outline-strong)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {actOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <section className="mt-8">
        <h2 className="text-[10px] uppercase tracking-[0.18em] pb-2" style={{ color: 'var(--on-surface-muted)' }}>
          Agents · {sortedAgents.length}
        </h2>
        <div className={AGENT_COLS + ' pb-2'}>
          <Head>Agent</Head>
          <Head>Time</Head>
          <Head>Games</Head>
          <Head>Win %</Head>
          <Head>K/D</Head>
          <Head>ADR</Head>
          <Head>ACS</Head>
          <Head>DDΔ</Head>
          <Head>HS %</Head>
          <Head>KAST</Head>
        </div>
        {isLoading && sortedAgents.length === 0 ? (
          <p className="text-[12px] py-3" style={{ color: 'var(--on-surface-muted)' }}>
            Loading…
          </p>
        ) : (
          sortedAgents.map((a) => {
            const isOpen = open?.section === 'agents' && open.key === a.agentKey;
            return (
              <React.Fragment key={a.agentKey}>
                <button
                  onClick={() => toggle('agents', a.agentKey)}
                  className={AGENT_COLS + ' w-full py-2 border-b text-left'}
                  style={{ borderColor: 'var(--outline)' }}
                >
                  <span className="text-[12px] truncate" style={{ color: 'var(--on-surface)' }}>
                    {a.agent}
                  </span>
                  <Cell dim>{num(a.hours, 1, 'h')}</Cell>
                  <Cell dim>{num(a.matches, 0)}</Cell>
                  <Cell>{num(a.winPct, 1, '%')}</Cell>
                  <Cell>{num(a.kd, 2)}</Cell>
                  <Cell>{num(a.adr, 1)}</Cell>
                  <Cell>{num(a.acs, 1)}</Cell>
                  <Cell dim>{signedInt(a.damageDeltaPerRound)}</Cell>
                  <Cell>{num(a.hsPct, 1, '%')}</Cell>
                  <Cell>{num(a.kast, 1, '%')}</Cell>
                </button>
                {isOpen && (
                  <div className="grid grid-cols-2 gap-x-10 pb-4 pl-1 border-b" style={{ borderColor: 'var(--outline)' }}>
                    {agentDetail(a).map(([k, v]) => (
                      <Detail key={k} label={k} value={v} />
                    ))}
                  </div>
                )}
              </React.Fragment>
            );
          })
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-[10px] uppercase tracking-[0.18em] pb-2" style={{ color: 'var(--on-surface-muted)' }}>
          Maps · {sortedMaps.length}
        </h2>
        <div className={MAP_COLS + ' pb-2'}>
          <Head>Map</Head>
          <Head>Win %</Head>
          <Head>Wins</Head>
          <Head>Losses</Head>
          <Head>K/D</Head>
          <Head>ADR</Head>
          <Head>ACS</Head>
          <Head>DDΔ</Head>
          <Head>Top agents</Head>
        </div>
        {isLoading && sortedMaps.length === 0 ? (
          <p className="text-[12px] py-3" style={{ color: 'var(--on-surface-muted)' }}>
            Loading…
          </p>
        ) : (
          sortedMaps.map((m) => {
            const isOpen = open?.section === 'maps' && open.key === m.key;
            return (
              <React.Fragment key={m.key}>
                <button
                  onClick={() => toggle('maps', m.key)}
                  className={MAP_COLS + ' w-full py-2 border-b text-left'}
                  style={{ borderColor: 'var(--outline)' }}
                >
                  <span className="text-[12px] truncate" style={{ color: 'var(--on-surface)' }}>
                    {m.name}
                  </span>
                  <Cell>{num(m.winPct, 1, '%')}</Cell>
                  <Cell dim>{num(m.matchesWon, 0)}</Cell>
                  <Cell dim>{num(m.matchesLost, 0)}</Cell>
                  <Cell>{num(m.kd, 2)}</Cell>
                  <Cell>{num(m.adr, 1)}</Cell>
                  <Cell>{num(m.acs, 1)}</Cell>
                  <Cell dim>{signedInt(m.damageDeltaPerRound)}</Cell>
                  <span className="text-[11px] truncate" style={{ color: 'var(--on-surface-muted)' }}>
                    {(m.topAgents ?? [])
                      .slice(0, 2)
                      .map((t) => t.name)
                      .join(' · ')}
                  </span>
                </button>
                {isOpen && (
                  <div className="grid grid-cols-2 gap-x-10 pb-4 pl-1 border-b" style={{ borderColor: 'var(--outline)' }}>
                    {([
                      ['Matches', num(m.matchesPlayed, 0)],
                      ['Kills / deaths', `${num(m.kills, 0)} / ${num(m.deaths, 0)}`],
                      ['Assists', num(m.assists, 0)],
                      ['Headshots', num(m.headshotsPct, 1, '%')],
                      ['Attack rounds won', num(m.attackRoundsWinPct, 1, '%')],
                      ['Defence rounds won', num(m.defenseRoundsWinPct, 1, '%')],
                      ['Aces', num(m.aces, 0)],
                      ['Clutches', num(m.clutches, 0)],
                      ['Flawless', num(m.flawless, 0)],
                      ['Plants', num(m.plants, 0)],
                      ['Defuses', num(m.defuses, 0)],
                      ['Time played', num(m.timePlayedSeconds, 0, ' s')],
                    ] as [string, string][]).map(([k, v]) => (
                      <Detail key={k} label={k} value={v} />
                    ))}
                  </div>
                )}
              </React.Fragment>
            );
          })
        )}
      </section>
    </div>
  );
};
