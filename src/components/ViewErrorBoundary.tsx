import React from 'react';
import { logger } from '../utils/logger';

/* Last-resort error surface for a view (ui: first-paint review).
 *
 * There was no error boundary anywhere, so a render throw or a failed lazy
 * chunk import unmounted the whole React root — a blank window with no way
 * back. This keeps the sidebar, top bar and toasts alive and offers a retry.
 * Keyed by the active tab in App so switching views clears the error state.
 */
export class ViewErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error): void {
    logger.error('View crashed', error);
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="h-full min-h-0 flex items-center justify-center p-6" role="alert">
          <div className="max-w-sm rounded-3xl border border-m3-coral/40 bg-m3-surface-container p-6 text-center flex flex-col gap-3">
            <h2 className="font-display font-black text-lg text-m3-on-surface">
              This view failed to load
            </h2>
            <p className="text-xs text-m3-outline leading-relaxed break-words">
              {this.state.error.message || 'Unknown error'} — the rest of Outpeek keeps running.
            </p>
            <button
              type="button"
              onClick={this.retry}
              className="mx-auto h-9 px-5 rounded-xl bg-m3-primary text-m3-on-primary text-xs font-bold cursor-pointer"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
