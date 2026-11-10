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

/* One line means one line. The same message arriving twice within a moment is
 * the same event seen twice (two refresh passes, two realms, a re-run), not two
 * events — and a doubled log halves its own value, because every count read
 * off it is then wrong by a factor of two. Compare the message WITHOUT the
 * timestamp: the duplicate differs only in the clock. */
const DUP_WINDOW_MS = 500;
let lastLine: { body: string; at: number } | null = null;

function isDuplicate(body: string, now: number): boolean {
  const dup = lastLine !== null && lastLine.body === body && now - lastLine.at <= DUP_WINDOW_MS;
  lastLine = { body, at: now };
  return dup;
}

function pushLine(level: string, args: LogArgs): void {
  try {
    const now = Date.now();
    const body = `${level} ${args.map(fmtArg).join(' ')}`;
    if (isDuplicate(body, now)) return;
    const formatted = `[${new Date(now).toISOString()}] ${body}`;
    logBuffer.push(formatted);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
    // warn+ also reaches Recon.log through the Rust sink; info/debug stay here.
    queueForFile(level, formatted);
  } catch {}
}

/** Last n buffered log lines (oldest-first) for bug-report export. */
export function getRecentLogs(n = 200): string[] {
  return logBuffer.slice(-Math.max(1, Math.min(n, LOG_BUFFER_MAX)));
}

/** Drop buffered log lines. */
/* ------------------------------------------------------------------ *
 * File sink
 *
 * The ring buffer reaches the Settings → Download logs bundle, but Recon.log
 * only ever carried Rust lines — so the `[riot]`/`[tracker]` diagnostics added
 * for the signed-out bug were invisible in the file we actually read. warn and
 * error are batched to the Rust `ui_log` command, which writes through the same
 * log_line sink as the `[window]` lines. Info/debug stay in the ring: the file
 * is for failures, and batching keeps the IPC cost at one call per flush.
 * ------------------------------------------------------------------ */
const UI_LOG_BATCH = 20;
const UI_LOG_FLUSH_MS = 400;
const uiLogQueue: { level: string; message: string }[] = [];
let uiLogTimer: ReturnType<typeof setTimeout> | null = null;

function flushUiLog(): void {
  uiLogTimer = null;
  if (uiLogQueue.length === 0) return;
  const batch = uiLogQueue.splice(0, UI_LOG_BATCH);
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  void import('@tauri-apps/api/core')
    .then(({ invoke }) =>
      Promise.all(
        batch.map((e) => invoke('ui_log', { level: e.level, message: e.message }).catch(() => {}))
      )
    )
    .catch(() => {});
  if (uiLogQueue.length > 0 && uiLogTimer === null) {
    uiLogTimer = setTimeout(flushUiLog, UI_LOG_FLUSH_MS);
  }
}

function queueForFile(level: string, line: string): void {
  try {
    if (level !== 'warn' && level !== 'error') return;
    if (uiLogQueue.length >= 200) return; // hard cap: logging must never grow memory
    uiLogQueue.push({ level, message: line });
    if (uiLogTimer === null) uiLogTimer = setTimeout(flushUiLog, UI_LOG_FLUSH_MS);
  } catch {
    /* never throw from a diagnostic */
  }
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
