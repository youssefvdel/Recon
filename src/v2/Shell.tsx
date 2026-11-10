import React, { useCallback, useMemo, useState } from 'react';
import '../v2/tokens.css';
import { CommandLayer, type Overlay } from './CommandLayer';
import { Now } from './surfaces/Now';
import { Matches } from './surfaces/Matches';
import { Prep } from './surfaces/Prep';
import { Tools } from './Tools';
import { AppSettingsView } from '../components/AppSettingsView';
import { NAV, isAnchor, searchNav, type Dest, type NavItem, type ToolAnchor } from './nav';

const DESTS: { id: Dest; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'matches', label: 'Matches' },
  { id: 'prep', label: 'Prep' },
];

/** Deep link: ?v2=1#accounts opens the Tools sheet at that section. */
const hashAnchor = (): ToolAnchor | null => {
  const h = window.location.hash.replace(/^#/, '');
  return isAnchor(h) ? h : null;
};

/** The v2 frame.
 *
 *  56px bar, three destinations, no sidebar, one page scroll. Tools and Settings
 *  are sheets reached from ⋯ and ⌘K — both render the same registry (nav.ts), so
 *  a destination cannot exist in one and be missing from the other.
 *
 *  Every colour here is a token; a raw hex in a component is a bug. */
export const Shell: React.FC = () => {
  const [dest, setDest] = useState<Dest>(() => (hashAnchor() ? 'tools' : 'now'));
  const [anchor, setAnchor] = useState<ToolAnchor | null>(hashAnchor);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [theme, setTheme] = useState<'graphite' | 'nocturne'>('graphite');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const navigate = useCallback((item: NavItem) => {
    setDest(item.dest);
    setAnchor(item.anchor ?? null);
    setOverlay(null);
    setQuery('');
    setActive(0);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${item.anchor ? `#${item.anchor}` : ''}`
    );
  }, []);

  /* Stable: Tools re-runs its jump effect when this identity changes. */
  const onAnchorApplied = useCallback(() => setAnchor(null), []);

  const results = useMemo(() => searchNav(query), [query]);
  /* Arrow/Enter belong to the focused input, not to a second window listener:
     CommandLayer stays the only keydown owner in capture phase. */
  const onPaletteKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = results[active];
      if (pick) navigate(pick);
    }
  };

  return (
    <div data-theme={theme} className="min-h-screen" style={{ background: 'var(--surface-0)', color: 'var(--on-surface)' }}>
      <CommandLayer overlay={overlay} setOverlay={setOverlay} />

      {/* 56px bar: brand · destinations · live · ⌘K · ⋯ · window controls */}
      <header className="h-14 flex items-center gap-4 px-6 border-b" style={{ borderColor: 'var(--outline)', background: 'var(--surface-1)' }}>
        <span className="font-semibold tracking-tight" style={{ color: 'var(--on-surface)' }}>
          Recon
        </span>
        <nav className="flex items-center gap-1">
          {DESTS.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => navigate(NAV.find((n) => n.id === d.id)!)}
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
            aria-haspopup="menu"
            aria-expanded={overlay === 'menu'}
            className="text-xs px-2 py-1 rounded cursor-pointer"
            style={{ background: 'var(--surface-2)', color: 'var(--on-surface-muted)' }}
          >
            ⋯
          </button>
        </span>
      </header>

      <main className="mx-auto px-6 py-8" style={{ maxWidth: '1280px' }}>
        {dest === 'now' && <Now />}
        {dest === 'matches' && <Matches />}
        {dest === 'prep' && <Prep />}
        {dest === 'tools' && <Tools anchor={anchor} onAnchorApplied={onAnchorApplied} />}
        {dest === 'settings' && (
          /* Settings is its own sheet, never a section of Tools. */
          <div style={{ height: '78vh', minHeight: 480 }}>
            <AppSettingsView />
          </div>
        )}
      </main>

      {overlay === 'palette' && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]" onClick={() => setOverlay(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Go to"
            className="w-full max-w-md rounded-lg border p-3"
            style={{ background: 'var(--surface-1)', borderColor: 'var(--outline)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onPaletteKey}
              placeholder="Go to…"
              role="combobox"
              aria-expanded
              aria-controls="palette-results"
              className="w-full bg-transparent outline-none text-sm px-1 py-1"
              style={{ color: 'var(--on-surface)' }}
            />
            <ul id="palette-results" role="listbox" className="mt-2 max-h-[52vh] overflow-y-auto">
              {results.length === 0 && (
                <li className="text-xs px-1 py-2" style={{ color: 'var(--on-surface-muted)' }}>
                  Nothing matches
                </li>
              )}
              {results.map((item, i) => (
                <li key={item.id} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => navigate(item)}
                    className="w-full text-left text-sm px-2 py-1.5 rounded cursor-pointer"
                    style={{
                      color: i === active ? 'var(--on-surface)' : 'var(--on-surface-muted)',
                      background: i === active ? 'var(--surface-2)' : 'transparent',
                    }}
                  >
                    {item.label}
                    <span className="text-[10px] uppercase tracking-[0.12em] ml-2" style={{ color: 'var(--on-surface-muted)' }}>
                      {item.group}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {overlay === 'menu' && (
        <div className="fixed inset-0 z-40" onClick={() => setOverlay(null)}>
          <div
            role="menu"
            className="absolute right-6 top-14 w-60 rounded-lg border p-2 max-h-[calc(100vh-80px)] overflow-y-auto"
            style={{ background: 'var(--surface-1)', borderColor: 'var(--outline)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {(['Go', 'Tools', 'App'] as const).map((group) => (
              <div key={group} className="py-1">
                <p className="text-[10px] uppercase tracking-[0.14em] px-2 pb-1" style={{ color: 'var(--on-surface-muted)' }}>
                  {group}
                </p>
                {NAV.filter((n) => n.group === group).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    onClick={() => navigate(item)}
                    className="w-full text-left text-sm px-2 py-1.5 rounded cursor-pointer"
                    style={{ color: 'var(--on-surface)' }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
            <div className="pt-1 mt-1 border-t" style={{ borderColor: 'var(--outline)' }}>
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
        </div>
      )}
    </div>
  );
};
