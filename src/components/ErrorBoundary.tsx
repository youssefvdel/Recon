import React from 'react';

/* Last-resort error surface.
 *
 * Why this exists: on 2026-11-08 a release shipped where the user saw no
 * window and there was nothing to diagnose. A JS fault and a broken WebView2
 * runtime look IDENTICAL from outside — a blank surface. This turns the JS
 * case into text the user can copy.
 *
 * Constraints, deliberate:
 *  - No Tailwind classes. If a chunk or the CSS failed to load, class-based
 *    styling is exactly what is missing; inline styles always apply.
 *  - Nothing here may throw. Every read is guarded and the whole render body
 *    sits in a try/catch that degrades to a plain-text message. */

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  info: React.ErrorInfo | null;
  copied: boolean;
}

const SURFACE = '#141218';
const ON_SURFACE = '#E6E0E9';
const MUTED = '#CAC4D0';
const PRIMARY = '#6750A4';
const ON_PRIMARY = '#FFFFFF';
const OUTLINE = '#49454F';
const MONO =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace";

/** Safe string for anything we might print. Never throws. */
function asText(value: unknown): string {
  try {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return String(value);
  } catch {
    return '[unreadable value]';
  }
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Guarded: a failure here must not escalate into a second, worse crash.
    try {
      this.setState({ error, info });
    } catch {
      /* the initial getDerivedStateFromError state still renders */
    }
  }

  /** Message + component stack, as one copyable block. Never throws. */
  private details(): string {
    try {
      const message = asText(this.state?.error);
      const stack = asText(this.state?.error?.stack);
      const componentStack = asText(this.state?.info?.componentStack);
      return [
        'Recon crashed',
        '',
        `message: ${message || '(no message)'}`,
        '',
        'stack:',
        stack || '(no stack captured)',
        '',
        'component stack:',
        componentStack || '(no component stack captured)',
        '',
        `time: ${new Date().toISOString()}`,
        `ua: ${asText(typeof navigator !== 'undefined' ? navigator.userAgent : '')}`,
      ].join('\n');
    } catch {
      return 'Recon crashed (details unavailable)';
    }
  }

  private handleCopy = (): void => {
    try {
      const text = this.details();
      void Promise.resolve(navigator?.clipboard?.writeText(text)).catch(() => {});
      this.setState({ copied: true });
    } catch {
      /* clipboard is best-effort; the text is on screen regardless */
    }
  };

  private handleReload = (): void => {
    try {
      window.location.reload();
    } catch {
      /* nothing else to do */
    }
  };

  render(): React.ReactNode {
    try {
      if (!this.state?.error) return this.props.children;
      return (
        <div
          style={{
            minHeight: '100vh',
            background: SURFACE,
            color: ON_SURFACE,
            padding: '24px',
            boxSizing: 'border-box',
            fontFamily: MONO,
            fontSize: '12px',
            lineHeight: 1.5,
          }}
        >
          <div style={{ maxWidth: '900px', margin: '0 auto' }}>
            <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '6px' }}>
              Recon hit an unexpected error
            </div>
            <div style={{ color: MUTED, marginBottom: '16px' }}>
              The app is still running. Copy the details below and report them — nothing else
              on your PC is affected.
            </div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={this.handleCopy}
                style={{
                  background: PRIMARY,
                  color: ON_PRIMARY,
                  border: `1px solid ${OUTLINE}`,
                  borderRadius: '9999px',
                  padding: '8px 16px',
                  font: 'inherit',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {this.state.copied ? 'Copied' : 'Copy details'}
              </button>
              <button
                type="button"
                onClick={this.handleReload}
                style={{
                  background: 'transparent',
                  color: ON_SURFACE,
                  border: `1px solid ${OUTLINE}`,
                  borderRadius: '9999px',
                  padding: '8px 16px',
                  font: 'inherit',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Reload
              </button>
            </div>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                margin: 0,
                padding: '12px',
                background: '#1D1B20',
                border: `1px solid ${OUTLINE}`,
                borderRadius: '12px',
                color: MUTED,
              }}
            >
              {this.details()}
            </pre>
          </div>
        </div>
      );
    } catch {
      // Absolute last resort: bare text, no props, no state, no styles.
      return 'Recon hit an unexpected error. Reload the app. Details are unavailable.';
    }
  }
}
