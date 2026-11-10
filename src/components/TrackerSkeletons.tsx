import React from 'react';

const Block: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className = '', style }) => (
  <div style={style} className={`animate-pulse bg-m3-surface-container-high ${className}`} />
);

/** Exact 1:1 skeleton matching Overview layout (filter bar, 4 KPI cards, secondary 8-stat strip, 3 feature cards, 2 lower cards). */
export const HistorySkeletons: React.FC = () => (
  <div className="flex flex-col gap-3 w-full">
    {/* Filters: All Agents, All Maps */}
    <div className="flex items-center gap-2 flex-wrap shrink-0">
      <div className="w-36">
        <Block className="h-9 w-full rounded-xl" />
      </div>
      <div className="w-36">
        <Block className="h-9 w-full rounded-xl" />
      </div>
    </div>

    {/* Performance Summary Card */}
    <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-3 shadow-m3-1 shrink-0">
      <div className="flex items-stretch gap-3 flex-wrap">
        {/* Left: Record and K/D / ADR */}
        <div className="flex flex-col justify-center px-1 min-w-32">
          <Block className="h-5 w-32 rounded-md" />
          <Block className="h-3 w-28 rounded-full mt-1.5" />
        </div>

        {/* Right: Top 3 Played Agents cards */}
        <div className="flex items-stretch gap-2 ml-auto flex-wrap">
          {[0, 1, 2].map((idx) => (
            <div
              key={idx}
              className="relative flex items-center gap-2 rounded-xl bg-m3-surface-container-low/60 border border-m3-outline-subtle/60 px-2.5 pt-2 pb-3 overflow-hidden min-w-36"
            >
              <Block className="w-10 h-10 rounded-lg shrink-0" />
              <div className="flex-1 flex flex-col gap-1 min-w-0">
                <Block className="h-3.5 w-20 rounded-md" />
                <Block className="h-2.5 w-14 rounded-full" />
              </div>
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-m3-outline-subtle/50">
                <span className="block h-full bg-m3-mint/40 w-2/3" />
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>

    {/* Day Group 1 */}
    <div className="flex flex-col gap-2 shrink-0">
      {/* Day Group Header */}
      <div className="flex items-center gap-2 sm:gap-3 px-1 flex-wrap">
        <Block className="h-4 w-14 rounded-full" />
        <Block className="h-4 w-6 rounded-md" />
        <Block className="h-3.5 w-20 rounded-full" />
        <Block className="h-4 w-20 rounded-full mx-auto" />
        <div className="ml-auto hidden xl:flex items-center gap-4">
          <div className="flex flex-col items-center gap-1">
            <Block className="h-2 w-6 rounded-full" />
            <Block className="h-3.5 w-8 rounded-md" />
          </div>
          <div className="flex flex-col items-center gap-1">
            <Block className="h-2 w-10 rounded-full" />
            <Block className="h-3.5 w-16 rounded-md" />
          </div>
        </div>
      </div>

      {/* Match Rows in Group 1 */}
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-xl border border-m3-outline-subtle bg-m3-surface-container px-2.5 py-2 flex items-center gap-2.5 text-left"
        >
          {/* Outcome Stripe */}
          <span className="w-1 self-stretch rounded-full shrink-0 min-h-10 bg-m3-outline-subtle/50" />

          {/* Agent Icon */}
          <Block className="w-9 h-9 rounded-lg shrink-0" />

          {/* Map + Queue + Placement */}
          <div className="w-32 sm:w-40 shrink-0 min-w-0 flex flex-col gap-1">
            <Block className="h-2.5 w-24 rounded-full" />
            <div className="flex items-center gap-1.5">
              <Block className="h-4 w-16 rounded-md" />
              <Block className="h-3.5 w-7 rounded" />
            </div>
          </div>

          {/* Rank Badge */}
          <Block className="w-7 h-7 rounded-full shrink-0 hidden sm:block" />

          {/* Score */}
          <div className="flex flex-col items-center shrink-0 w-16 gap-1">
            <Block className="h-2 w-8 rounded-full" />
            <Block className="h-4 w-12 rounded-md" />
          </div>

          {/* TRS */}
          <div className="flex-col items-center shrink-0 w-12 hidden md:flex gap-1">
            <Block className="h-2 w-6 rounded-full" />
            <Block className="h-4 w-8 rounded-md" />
          </div>

          {/* Stat columns (K/D, K/D/A, DDΔ, HS%, ACS) */}
          <div className="hidden sm:flex items-center gap-3 sm:gap-4 ml-auto shrink-0">
            <div className="flex flex-col items-center gap-1 w-9">
              <Block className="h-2 w-6 rounded-full" />
              <Block className="h-4 w-7 rounded-md" />
            </div>
            <div className="flex flex-col items-center gap-1 w-16">
              <Block className="h-2 w-10 rounded-full" />
              <Block className="h-4 w-14 rounded-md" />
            </div>
            <div className="flex flex-col items-center gap-1 w-12">
              <Block className="h-2 w-6 rounded-full" />
              <Block className="h-4 w-10 rounded-md" />
            </div>
            <div className="hidden lg:flex flex-col items-center gap-1 w-8">
              <Block className="h-2 w-6 rounded-full" />
              <Block className="h-4 w-7 rounded-md" />
            </div>
            <div className="flex flex-col items-center gap-1 w-9">
              <Block className="h-2 w-6 rounded-full" />
              <Block className="h-4 w-8 rounded-md" />
            </div>
          </div>

          {/* Context Action Button */}
          <Block className="w-6 h-6 rounded-md shrink-0 ml-1" />
        </div>
      ))}
    </div>

    {/* Day Group 2 */}
    <div className="flex flex-col gap-2 shrink-0 mt-1">
      {/* Day Group Header */}
      <div className="flex items-center gap-2 sm:gap-3 px-1 flex-wrap">
        <Block className="h-4 w-14 rounded-full" />
        <Block className="h-4 w-6 rounded-md" />
        <Block className="h-3.5 w-20 rounded-full" />
        <Block className="h-4 w-20 rounded-full mx-auto" />
        <div className="ml-auto hidden xl:flex items-center gap-4">
          <div className="flex flex-col items-center gap-1">
            <Block className="h-2 w-6 rounded-full" />
            <Block className="h-3.5 w-8 rounded-md" />
          </div>
          <div className="flex flex-col items-center gap-1">
            <Block className="h-2 w-10 rounded-full" />
            <Block className="h-3.5 w-16 rounded-md" />
          </div>
        </div>
      </div>

      {/* Match Rows in Group 2 */}
      {[0, 1].map((i) => (
        <div
          key={i}
          className="rounded-xl border border-m3-outline-subtle bg-m3-surface-container px-2.5 py-2 flex items-center gap-2.5 text-left"
        >
          <span className="w-1 self-stretch rounded-full shrink-0 min-h-10 bg-m3-outline-subtle/50" />
          <Block className="w-9 h-9 rounded-lg shrink-0" />
          <div className="w-32 sm:w-40 shrink-0 min-w-0 flex flex-col gap-1">
            <Block className="h-2.5 w-24 rounded-full" />
            <div className="flex items-center gap-1.5">
              <Block className="h-4 w-16 rounded-md" />
              <Block className="h-3.5 w-7 rounded" />
            </div>
          </div>
          <Block className="w-7 h-7 rounded-full shrink-0 hidden sm:block" />
          <div className="flex flex-col items-center shrink-0 w-16 gap-1">
            <Block className="h-2 w-8 rounded-full" />
            <Block className="h-4 w-12 rounded-md" />
          </div>
          <div className="flex-col items-center shrink-0 w-12 hidden md:flex gap-1">
            <Block className="h-2 w-6 rounded-full" />
            <Block className="h-4 w-8 rounded-md" />
          </div>
          <div className="hidden sm:flex items-center gap-3 sm:gap-4 ml-auto shrink-0">
            <div className="flex flex-col items-center gap-1 w-9">
              <Block className="h-2 w-6 rounded-full" />
              <Block className="h-4 w-7 rounded-md" />
            </div>
            <div className="flex flex-col items-center gap-1 w-16">
              <Block className="h-2 w-10 rounded-full" />
              <Block className="h-4 w-14 rounded-md" />
            </div>
            <div className="flex flex-col items-center gap-1 w-12">
              <Block className="h-2 w-6 rounded-full" />
              <Block className="h-4 w-10 rounded-md" />
            </div>
            <div className="hidden lg:flex flex-col items-center gap-1 w-8">
              <Block className="h-2 w-6 rounded-full" />
              <Block className="h-4 w-7 rounded-md" />
            </div>
            <div className="flex flex-col items-center gap-1 w-9">
              <Block className="h-2 w-6 rounded-full" />
              <Block className="h-4 w-8 rounded-md" />
            </div>
          </div>
          <Block className="w-6 h-6 rounded-md shrink-0 ml-1" />
        </div>
      ))}
    </div>
  </div>
);

/** Exact 1:1 skeleton matching Agents table (header, dropdown + count, full table with agent avatars & columns). */
export const AgentsSkeletons: React.FC = () => (
  <div className="flex flex-col gap-3.5 w-full">
    {/* Page Header */}
    <div className="flex items-center justify-between mb-1">
      <div className="flex flex-col gap-1">
        <Block className="h-6 w-48 rounded-md" />
        <Block className="h-3 w-64 rounded-full" />
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Block className="h-9 w-40 rounded-xl" />
        <Block className="h-7 w-24 rounded-full" />
      </div>
    </div>

    {/* Table Container */}
    <div className="rounded-3xl bg-m3-surface-container-low border border-m3-outline-subtle shadow-m3-1 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-m3-outline-subtle bg-m3-surface-container-high/70">
              <th className="py-3 px-4 min-w-[150px]">
                <Block className="h-3 w-16 rounded-full" />
              </th>
              {['Time Played', 'Matches', 'Win %', 'K/D', 'ADR', 'ACS', 'DDΔ', 'HS%', 'KAST'].map((h) => (
                <th key={h} className="py-3 px-3 text-center">
                  <Block className="h-3 w-12 rounded-full mx-auto" />
                </th>
              ))}
              <th className="py-3 px-4 text-center w-12"></th>
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <tr key={i} className="border-b border-m3-outline-subtle/50">
                <td className="py-2.5 px-4">
                  <div className="flex items-center gap-3 min-w-[140px]">
                    <Block className="w-1 h-8 rounded-full shrink-0" />
                    <Block className="w-9 h-9 rounded-xl shrink-0" />
                    <div className="flex flex-col gap-1 min-w-0">
                      <Block className="h-4 w-20 rounded-md" />
                      <Block className="h-2.5 w-14 rounded-full" />
                    </div>
                  </div>
                </td>
                {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((c) => (
                  <td key={c} className="py-3 px-3 text-center">
                    <Block className="h-4 w-12 rounded-md mx-auto" />
                  </td>
                ))}
                <td className="py-3 px-4 text-center">
                  <Block className="w-4 h-4 rounded-md mx-auto" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </div>
);

/** Exact 1:1 skeleton matching Maps table (header, dropdown + count, map banners & columns). */
export const MapsSkeletons: React.FC = () => (
  <div className="flex flex-col gap-3.5 w-full">
    {/* Page Header */}
    <div className="flex items-center justify-between mb-1">
      <Block className="h-6 w-20 rounded-md" />
      <div className="flex items-center gap-2 shrink-0">
        <Block className="h-9 w-40 rounded-xl" />
        <Block className="h-4 w-28 rounded-full" />
      </div>
    </div>

    {/* Table Container */}
    <div className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle shadow-m3-1 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-m3-outline-subtle bg-m3-surface-container-high/50">
              <th className="py-3 px-3.5 min-w-[150px]">
                <Block className="h-3 w-18 rounded-full" />
              </th>
              <th className="py-3 px-3 text-center min-w-[130px]">
                <Block className="h-3 w-20 rounded-full mx-auto" />
              </th>
              {['Win %', 'Wins', 'Losses', 'K/D', 'ADR', 'ACS', 'DDΔ'].map((h) => (
                <th key={h} className="py-3 px-3 text-center">
                  <Block className="h-3 w-12 rounded-full mx-auto" />
                </th>
              ))}
              <th className="py-3 px-3 text-center w-10"></th>
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <tr key={i} className="border-b border-m3-outline-subtle/40">
                <td className="py-2.5 px-3.5">
                  <Block className="h-11 w-36 rounded-lg" />
                </td>
                <td className="py-2.5 px-3">
                  <div className="flex items-center justify-center gap-2">
                    <Block className="w-7 h-7 rounded-md" />
                    <Block className="w-7 h-7 rounded-md" />
                    <Block className="w-7 h-7 rounded-md" />
                  </div>
                </td>
                {[0, 1, 2, 3, 4, 5, 6].map((c) => (
                  <td key={c} className="py-3 px-3 text-center">
                    <Block className="h-4 w-12 rounded-md mx-auto" />
                  </td>
                ))}
                <td className="py-3 px-3 text-center">
                  <Block className="w-4 h-4 rounded-md mx-auto" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </div>
);

/** Back-compat: full-page loader (overview shape). */
