import React from 'react';

/* First-frame placeholder for a lazily loaded view (ui #2).
 *
 * The Suspense boundary used to render `null`, so a restored lazy tab painted
 * an empty content pane until the chunk resolved. This mirrors the shared page
 * frame — max-w-6xl column, header line, action row, card rows — using the
 * same skeleton tokens as TrackerSkeletons. The pulse is disabled under
 * prefers-reduced-motion by the global override in index.css.
 */
export const ViewSkeleton: React.FC = () => (
  <div
    className="h-full min-h-0 overflow-y-auto custom-scrollbar bg-m3-surface"
    role="status"
    aria-live="polite"
  >
    <span className="sr-only">Loading view…</span>
    <div
      className="h-full min-h-0 max-w-6xl mx-auto w-full px-4 sm:px-6 py-3.5 pb-8"
      aria-hidden="true"
    >
      <div className="animate-pulse flex flex-col gap-3.5">
        {/* Page header */}
        <div className="flex flex-col gap-1.5 px-1">
          <div className="h-6 w-44 rounded-md bg-m3-surface-container-high" />
          <div className="h-3 w-64 rounded-full bg-m3-surface-container-high/70" />
        </div>

        {/* Filter / action row */}
        <div className="flex items-center gap-2">
          <div className="h-9 w-40 rounded-xl bg-m3-surface-container-high" />
          <div className="h-9 w-40 rounded-xl bg-m3-surface-container-high" />
          <div className="ml-auto h-9 w-28 rounded-xl bg-m3-surface-container-high/70" />
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-2xl border border-m3-outline-subtle bg-m3-surface-container p-3.5 flex flex-col gap-2"
            >
              <div className="h-3 w-16 rounded-full bg-m3-surface-container-high" />
              <div className="h-8 w-24 rounded-lg bg-m3-surface-container-high" />
            </div>
          ))}
        </div>

        {/* Content cards */}
        <div className="rounded-2xl border border-m3-outline-subtle bg-m3-surface-container p-4 flex flex-col gap-3">
          <div className="h-4 w-32 rounded-full bg-m3-surface-container-high" />
          <div className="h-3 w-full rounded-full bg-m3-surface-container-high/70" />
          <div className="h-3 w-5/6 rounded-full bg-m3-surface-container-high/70" />
          <div className="h-3 w-2/3 rounded-full bg-m3-surface-container-high/70" />
        </div>
        <div className="rounded-2xl border border-m3-outline-subtle bg-m3-surface-container h-40" />
      </div>
    </div>
  </div>
);
