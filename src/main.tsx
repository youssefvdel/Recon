import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'

// Desktop-app hygiene: no browser context menus anywhere (main + overlay).
if (typeof window !== 'undefined') {
  window.addEventListener('contextmenu', (e) => e.preventDefault());
}

/* Boot guard.
 * This used to be `document.getElementById('root')!` — a non-null assertion
 * that turned a stale/missing dist asset into a silent blank window, the exact
 * shape of the 2026-11-08 "no window" report. If the root is gone we now say
 * so on screen, in plain inline styles, so it can be photographed or copied. */
const rootEl = typeof document !== 'undefined' ? document.getElementById('root') : null;

if (!rootEl) {
  if (typeof document !== 'undefined') {
    const message = document.createElement('div');
    message.textContent =
      'Recon could not start: the app root element (#root) is missing from index.html. ' +
      'This is a broken install or an incomplete update — reinstall Recon from the latest release.';
    message.style.cssText = [
      'position:fixed',
      'inset:0',
      'background:#141218',
      'color:#E6E0E9',
      'padding:24px',
      'font:13px/1.5 ui-monospace, Menlo, Consolas, monospace',
      'white-space:pre-wrap',
    ].join(';');
    document.body.textContent = '';
    document.body.appendChild(message);
  }
} else {
  /* Boot is async only for the Linux dev harness: in DEV the mock has to be in
   * place before the first effect calls `invoke`. In a production build
   * `import.meta.env.DEV` is false, the branch disappears, and the harness
   * module is never in the graph — `build:ui` output is unchanged. */
  void (async () => {
    if (import.meta.env.DEV) {
      const { installDevHarness } = await import('./dev/mock/harness');
      installDevHarness();
    }
    /* App is imported AFTER the harness: its module graph (the tracker store
     * included) reads localStorage at import time, so seeding has to happen
     * first or the store hydrates from an empty cache. */
    const { default: App } = await import('./App.tsx');
    createRoot(rootEl).render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );
  })();
}
