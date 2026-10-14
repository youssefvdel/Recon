/* Per-account video memory. Valorant keeps ONE GameUserSettings.ini per PC,
 * not one per Riot account — so Recon remembers the last resolution each
 * account was set to, and the editor labels whose settings are open. */

export interface ConfigAccountCtx {
  id: string;
  label: string;
}

const accountVideoKey = (id: string) => `recon_account_video_${id}`;

export function readAccountVideo(id: string): { w: number; h: number; at: number } | null {
  try {
    const raw = localStorage.getItem(accountVideoKey(id));
    if (!raw) return null;
    const p = JSON.parse(raw) as { w?: number; h?: number; at?: number };
    if (typeof p.w !== 'number' || typeof p.h !== 'number') return null;
    return { w: p.w, h: p.h, at: p.at ?? 0 };
  } catch {
    return null;
  }
}

export function writeAccountVideo(id: string, w: number, h: number): void {
  try {
    localStorage.setItem(accountVideoKey(id), JSON.stringify({ w, h, at: Date.now() }));
  } catch {}
}
