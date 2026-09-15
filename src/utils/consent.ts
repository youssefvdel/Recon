import { APP_VERSION } from './version';
import { getRecentLogs, logger } from './logger';

/* First-run consent + local-only crash opt-in. No backend exists: every
 * flag lives in localStorage, nothing is uploaded anywhere. The tracker
 * toggle is reused as the consent opt-out — there is intentionally no
 * second tracker flag. */

export const CONSENT_KEY = 'recon_consent_v1';
export const CRASH_OPTIN_KEY = 'recon_crash_optin_v1';
export const CRASH_EVENT = 'recon:crash-captured';
export const CONSENT_EVENT = 'recon:open-consent';

/** True once the first-run notice was accepted (fail-remembered: no nag). */
export function hasConsented(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return true;
  }
}

export function markConsented(): void {
  try {
    localStorage.setItem(CONSENT_KEY, '1');
  } catch {}
}

/** Crash capture is strictly opt-in (default OFF). */
export function isCrashOptIn(): boolean {
  try {
    return localStorage.getItem(CRASH_OPTIN_KEY) === '1';
  } catch {
    return false;
  }
}

export function setCrashOptIn(on: boolean): void {
  try {
    if (on) localStorage.setItem(CRASH_OPTIN_KEY, '1');
    else localStorage.removeItem(CRASH_OPTIN_KEY);
  } catch {}
}

export interface CrashInfo {
  message: string;
  at: number;
}

let lastCrash: CrashInfo | null = null;

/** Most recent captured error, if any. */
export function lastCrashInfo(): CrashInfo | null {
  return lastCrash;
}

/** Short plain-text bundle for pasting into Discord. No uploader, no backend. */
export function buildDiagnostics(): string {
  const c = lastCrashInfo();
  const lines = [
    `Recon diagnostics ${APP_VERSION} (${navigator.platform ?? 'unknown'})`,
    `Time: ${new Date(c?.at ?? Date.now()).toISOString()}`,
    `Error: ${(c?.message || 'none recorded').slice(0, 200)}`,
  ];
  const logs = getRecentLogs(10);
  if (logs.length > 0) {
    lines.push('Recent logs:');
    for (const l of logs) lines.push(l.slice(0, 160));
  }
  return lines.join('\n').slice(0, 2000);
}

/** Record a caught fatal error (opt-in only) and notify the offer UI. */
export function captureCrash(message: unknown): void {
  if (!isCrashOptIn()) return;
  const text = String(message ?? 'unknown error').slice(0, 300);
  lastCrash = { message: text, at: Date.now() };
  logger.error('[crash]', text);
  try {
    window.dispatchEvent(new CustomEvent(CRASH_EVENT));
  } catch {}
}

let crashInstalled = false;

/** Global error/rejection listeners. Cheap: each handler is one flag check. */
export function installCrashCapture(): void {
  if (crashInstalled || typeof window === 'undefined') return;
  crashInstalled = true;
  window.addEventListener('error', (e) => {
    try {
      const msg = (e as ErrorEvent).message || (e as ErrorEvent).error;
      captureCrash(msg instanceof Error ? msg.message : msg);
    } catch {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const r = (e as PromiseRejectionEvent).reason;
      captureCrash(r instanceof Error ? r.message : r);
    } catch {}
  });
}

/** Dev/test seam: stage a crash offer without touching the opt-in flag. */
export function debugSimulateCrash(message = '[simulated] widget failed to render'): void {
  lastCrash = { message, at: Date.now() };
  logger.error('[crash]', message);
  try {
    window.dispatchEvent(new CustomEvent(CRASH_EVENT));
  } catch {}
}
