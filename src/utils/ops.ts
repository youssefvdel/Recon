import { isPulseOptIn } from './consent';

/* Server-driven broadcasts + opt-in usage pulse. The pulse carries the Riot
 * ID, so it is OFF unless the player enabled it (consent.ts `isPulseOptIn`);
 * `sendPulse` is the single gate, so no caller can bypass it.
 *
 * Notices ride a JSON file in this repo (CDN-cached, editable by commit):
 *   ops/notices.json
 * The pulse goes to the home ops box (best-effort, never blocks, never retries).
 */

export interface OpsNotice {
  id: string;
  severity: 'info' | 'warn' | 'critical';
  min_version?: string;
  max_version?: string;
  title: string;
  body: string;
  link?: string;
  dismissible?: boolean;
}

const NOTICES_URL =
  'https://raw.githubusercontent.com/youssefvdel/Outpeek/main/ops/notices.json';
const PULSE_URL = 'http://154.176.122.255:9736/pulse';

/** Compare dotted versions with optional -prerelease (prerelease < release). */
export function cmpVersions(a: string, b: string): number {
  const pa = a.split('-');
  const pb = b.split('-');
  const na = pa[0].split('.').map((x) => parseInt(x, 10) || 0);
  const nb = pb[0].split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const sa = pa[1] ?? '';
  const sb = pb[1] ?? '';
  if (sa === sb) return 0;
  if (!sa) return 1;
  if (!sb) return -1;
  return sa < sb ? -1 : 1;
}

export function noticeApplies(n: OpsNotice, version: string): boolean {
  if (n.min_version && cmpVersions(version, n.min_version) < 0) return false;
  if (n.max_version && cmpVersions(version, n.max_version) > 0) return false;
  return true;
}

export async function fetchNotices(): Promise<OpsNotice[]> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(NOTICES_URL, { signal: ctl.signal, cache: 'no-cache' });
    clearTimeout(t);
    if (!r.ok) return [];
    const j = (await r.json()) as { notices?: OpsNotice[] };
    return Array.isArray(j.notices) ? j.notices.filter((n) => n && n.id && n.title) : [];
  } catch {
    return [];
  }
}

const dismissKey = (id: string) => `recon_notice_dismissed_${id}`;

export function isDismissed(id: string): boolean {
  try {
    return localStorage.getItem(dismissKey(id)) === '1';
  } catch {
    return false;
  }
}

export function dismissNotice(id: string): void {
  try {
    localStorage.setItem(dismissKey(id), '1');
  } catch {}
}

/** One heartbeat per launch, only after the player opted in. Fire-and-forget:
 *  never awaited, never retried. */
export function sendPulse(riotId: string | null, version: string): void {
  if (!isPulseOptIn()) return;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    void fetch(PULSE_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ riot_id: riotId ?? 'unknown', ts: new Date().toISOString(), version }),
    })
      .catch(() => {})
      .finally(() => clearTimeout(t));
  } catch {}
}
