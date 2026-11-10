import React from 'react';
import { CustomDropdown } from './ValorantConfig';
import { Skeleton } from './primitives/Skeleton';
import { usePrepData } from './prep/usePrepData';
import { AgentTable } from './prep/AgentTable';
import { MapTable } from './prep/MapTable';

/** Prep: one route, two stacked sections, one act selector.
 *
 *  Agents then Maps in the same 940px column, sharing a single act selection so
 *  there is no second dropdown to drift out of sync. No inner tabs, no cards —
 *  section headings and hairline rows. */
export const Prep: React.FC = () => {
  const { actId, setActId, actOptions, actLoading, agents, maps, isLoading, agentInfo } = usePrepData();
  const loading = isLoading || actLoading;

  return (
    <div className="max-w-[940px] mx-auto w-full px-6 pt-6 pb-10 flex flex-col">
      <div className="flex items-start justify-between gap-4">
        <h2 className="font-display font-extrabold text-[20px] tracking-tight text-m3-on-surface">Prep</h2>
        <CustomDropdown value={actId} options={actOptions} onChange={setActId} />
      </div>

      <section className="mt-6">
        <h3 className="text-micro font-mono uppercase tracking-[0.18em] text-m3-outline pb-2 border-b border-m3-outline-subtle">
          Agents · {agents.length}
        </h3>
        <div className="mt-1">
          {loading && agents.length === 0 ? (
            <Skeleton lines={4} />
          ) : (
            <AgentTable rows={agents} agentInfo={agentInfo} />
          )}
        </div>
      </section>

      <section className="mt-8">
        <h3 className="text-micro font-mono uppercase tracking-[0.18em] text-m3-outline pb-2 border-b border-m3-outline-subtle">
          Maps · {maps.length}
        </h3>
        <div className="mt-1">
          {loading && maps.length === 0 ? <Skeleton lines={4} /> : <MapTable rows={maps} />}
        </div>
      </section>
    </div>
  );
};
