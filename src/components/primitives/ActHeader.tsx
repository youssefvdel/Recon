import React from 'react';

export interface ActMetric {
  label: string;
  value: string;
}

export interface ActHeaderProps {
  /** "Episode 9 · Act 3 · Competitive". Absent when the act is unknown. */
  eyebrow?: string;
  /** "34–29". Absent when the act has no games — never 0–0. */
  record?: string;
  winPct?: string;
  /** Only the metrics that have a source; the caller filters. */
  metrics?: ActMetric[];
  /** Rank · RR · top agent line. Each part optional. */
  rankLine?: React.ReactNode;
  agentLine?: React.ReactNode;
}

/** The act record as the hero: one big number, one line of facts under it, no
 *  card. Everything optional collapses — a header with only an eyebrow is a
 *  truthful header for an act we know little about. */
export const ActHeader: React.FC<ActHeaderProps> = ({
  eyebrow,
  record,
  winPct,
  metrics = [],
  rankLine,
  agentLine,
}) => (
  <header className="pb-6 border-b border-m3-outline-subtle">
    {eyebrow && (
      <div className="text-micro font-mono uppercase tracking-[0.18em] text-m3-outline">{eyebrow}</div>
    )}
    {(record || winPct) && (
      <div className="mt-2 flex items-baseline gap-3">
        {record && (
          <span className="font-display font-black text-[46px] leading-none tracking-[-0.04em] text-m3-on-surface tabular-nums">
            {record}
          </span>
        )}
        {winPct && <span className="font-mono text-xl text-m3-outline tabular-nums">{winPct}</span>}
      </div>
    )}
    {metrics.length > 0 && (
      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-micro font-mono text-m3-on-surface-variant">
        {metrics.map((m) => (
          <span key={m.label} className="tabular-nums">
            {m.value} {m.label}
          </span>
        ))}
      </div>
    )}
    {rankLine && <div className="mt-2 text-micro font-mono text-m3-outline">{rankLine}</div>}
    {agentLine && <div className="mt-2 text-micro font-mono text-m3-outline">{agentLine}</div>}
  </header>
);
