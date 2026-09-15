/**
 * Logging. Console mirrors are dev-only: always wrap calls in
 * `if (import.meta.env.DEV)` so the production minifier dead-code-eliminates
 * the whole statement INCLUDING its string arguments. Calling logger bare
 * keeps the strings in the shipped bundle (arguments evaluate eagerly).
 * Always use this instead of raw console.* anywhere in the app.
 *
 * The ring buffer below captures in ALL builds (capped, ~zero cost) so the
 * user-facing log bundle (Settings → Download logs) and crash diagnostics
 * work in production. Console output stays dev-only.
 * Callers must never log secrets.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogArgs = any[];

/* Ring buffer of recent log lines for the log bundle + crash diagnostics.
 * Captures in every build (capped so cost is ~zero); console mirrors below
 * stay dev-only. Callers must never log secrets. */
const LOG_BUFFER_MAX = 500;
const logBuffer: string[] = [];

/* PII screen for the persisted ring buffer (and therefore the log bundle +
 * crash diagnostics, which read from it). Labeled secrets are dropped,
 * long token-like runs (puuids, session ids) are truncated. Console mirrors
 * stay raw but are dev-only and never leave the machine. */
const SENSITIVE_VALUE_RE =
  /(puuid|cookie|token|entitlement|ssn)\s*[:=]\s*("?)([^"\s,};&]{1,256})\2/gi;
const LONG_TOKEN_RE = /[A-Za-z0-9+/=_-]{32,}/g;

function redact(s: string): string {
  return s
    .replace(SENSITIVE_VALUE_RE, '$1=[redacted]')
    .replace(LONG_TOKEN_RE, (m) => (m.length > 40 ? `${m.slice(0, 8)}…[truncated]` : `${m.slice(0, 8)}…`));
}

function fmtArg(a: unknown): string {
  if (typeof a === 'string') return redact(a);
  try {
    const s = JSON.stringify(a);
    return s === undefined ? redact(String(a)) : redact(s);
  } catch {
    return '[unserializable]';
  }
}

function pushLine(level: string, args: LogArgs): void {
  try {
    logBuffer.push(`[${new Date().toISOString()}] ${level} ${args.map(fmtArg).join(' ')}`);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
  } catch {}
}

/** Last n buffered log lines (oldest-first) for bug-report export. */
export function getRecentLogs(n = 200): string[] {
  return logBuffer.slice(-Math.max(1, Math.min(n, LOG_BUFFER_MAX)));
}

/** Drop buffered log lines. */
export function clearRecentLogs(): void {
  logBuffer.length = 0;
}

export const logger = {
  log: (...args: LogArgs): void => {
    pushLine('log', args);
    if (import.meta.env.DEV) console.log(...args);
  },
  info: (...args: LogArgs): void => {
    pushLine('info', args);
    if (import.meta.env.DEV) console.info(...args);
  },
  warn: (...args: LogArgs): void => {
    pushLine('warn', args);
    if (import.meta.env.DEV) console.warn(...args);
  },
  error: (...args: LogArgs): void => {
    pushLine('error', args);
    if (import.meta.env.DEV) console.error(...args);
  },
  debug: (...args: LogArgs): void => {
    pushLine('debug', args);
    if (import.meta.env.DEV) console.debug(...args);
  },
};
