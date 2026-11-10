import React, { useState } from 'react';
import '../v2/tokens.css';
import { CommandLayer, type Overlay } from './CommandLayer';
import { Now } from './surfaces/Now';
import { Matches } from './surfaces/Matches';
import { Prep } from './surfaces/Prep';

type Dest = 'now' | 'matches' | 'prep';
const DESTS: { id: Dest; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'matches', label: 'Matches' },
  { id: 'prep', label: 'Prep' },
];

/** Step 1 of the v2 shell: the frame only.
 *
 *  56px bar, three destinations, no sidebar, one page scroll. Surfaces are
 *  placeholders — the deliverable is the frame, the tokens and reachability.
 *  Every colour here is a token; a raw hex in a component is a bug. */
export const Shell: React.FC = () => {
  const [dest, setDest] = useState<Dest>('now');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [theme, setTheme] = useState<'graphite' | 'nocturne'>('graphite');

  return (
    <div
      data-theme={theme}
      className="min-h-screen"
      style={{ background: 'var(--surface-0)', color: 'var(--on-surface)' }}
    >
      <CommandLayer overlay={overlay} setOverlay={setOverlay} />

      {/* 56px bar: brand · destinations · live · ⌘K · ⋯ · window controls */}
      <header
        className="h-14 flex items-center gap-4 px-6 border-b"
        style={{ borderColor: 'var(--outline)', background: 'var(--surface-1)' }}
      >
        <span className="font-semibold tracking-tight" style={{ color: 'var(--on-surface)' }}>
          Recon
        </span>
        <nav className="flex items-center gap-1">
          {DESTS.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDest(d.id)}
              aria-current={dest === d.id ? 'page' : undefined}
              className="px-3 py-1.5 rounded text-sm cursor-pointer"
              style={{
                color: dest === d.id ? 'var(--accent)' : 'var(--on-surface-muted)',
                background: dest === d.id ? 'var(--surface-2)' : 'transparent',
              }}
            >
              {d.label}
            </button>
          ))}
        </nav>

        <span className="ml-auto flex items-center gap-2">
          <span
            className="text-xs px-2 py-1 rounded"
            style={{ background: 'var(--surface-2)', color: 'var(--on-surface-muted)' }}
            title="No live match"
          >
            Offline
          </span>
          <button
            type="button"
            onClick={() => setOverlay(overlay === 'palette' ? null : 'palette')}
            className="text-xs px-2 py-1 rounded cursor-pointer"
            style={{ background: 'var(--surface-2)', color: 'var(--on-surface-muted)' }}
          >
            ⌘K
          </button>
          <button
            type="button"
            onClick={() => setOverlay(overlay === 'menu' ? null : 'menu')}
            aria-label="More"
            className="text-xs px-2 py-1 rounded cursor-pointer"
            style={{ background: 'var(--surface-2)', color: 'var(--on-surface-muted)' }}
          >
            ⋯
          </button>
        </span>
      </header>

      <main className="mx-auto px-6 py-8" style={{ maxWidth: '1280px' }}>
        {/* Every destination has a surface now: the placeholder that used to sit
            here would be dead code, and dead code is where a second app grows. */}
        {dest === 'now' ? <Now /> : dest === 'matches' ? <Matches /> : <Prep />}
      </main>

      {overlay === 'palette' && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]" onClick={() => setOverlay(null)}>
          <div
            className="w-full max-w-md rounded-lg border p-3"
            style={{ background: 'var(--surface-1)', borderColor: 'var(--outline)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              placeholder="Go to…"
              className="w-full bg-transparent outline-none text-sm px-1 py-1"
              style={{ color: 'var(--on-surface)' }}
            />
            <p className="text-xs mt-2" style={{ color: 'var(--on-surface-muted)' }}>
              Palette wiring lands with the surfaces (step 2+).
            </p>
          </div>
        </div>
      )}

      {overlay === 'menu' && (
        <div className="fixed inset-0 z-40" onClick={() => setOverlay(null)}>
          <div
            className="absolute right-6 top-14 w-56 rounded-lg border p-2"
            style={{ background: 'var(--surface-1)', borderColor: 'var(--outline)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setTheme(theme === 'graphite' ? 'nocturne' : 'graphite')}
              className="w-full text-left text-sm px-2 py-1.5 rounded cursor-pointer"
              style={{ color: 'var(--on-surface)' }}
            >
              Theme: {theme === 'graphite' ? 'Graphite' : 'Nocturne'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
