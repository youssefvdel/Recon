import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './ipc';

/**
 * Account switcher bridge — INTENTIONALLY thin. Every decision (which files,
 * how to copy, kill order, relaunch, metadata) lives in Rust
 * (`src-tauri/src/accounts.rs`). This file only types the responses and
 * forwards button clicks. UI formatting (dates) is the only logic here.
 */

export interface AccountMeta {
  id: string;
  game_name: string;
  tag_line: string;
  puuid: string;
  /** Millis epoch. */
  saved_at: number;
  /** Millis epoch. */
  last_used: number;
}

export interface SwitchResult {
  ok: boolean;
  auto_saved: boolean;
  game_was_running: boolean;
  relaunched: boolean;
}

export interface TickResult {
  current: string | null;
  changed: boolean;
  is_new: boolean;
}

export const accountsList = (): Promise<AccountMeta[]> =>
  isTauri() ? invoke<AccountMeta[]>('accounts_list') : Promise.resolve([]);

export const accountCurrent = (): Promise<string | null> =>
  isTauri() ? invoke<string | null>('account_current') : Promise.resolve(null);

export const accountSaveCurrent = (): Promise<AccountMeta> => invoke<AccountMeta>('account_save_current');

/** Watchdog tick — all policy in Rust; resolves null when unavailable. */
export const accountsAutoTick = (): Promise<TickResult | null> =>
  isTauri() ? invoke<TickResult>('accounts_auto_tick').catch(() => null) : Promise.resolve(null);

export const accountSwitch = (id: string): Promise<SwitchResult> =>
  invoke<SwitchResult>('account_switch', { id });

export const accountRemove = (id: string): Promise<void> =>
  invoke<void>('account_remove', { id });

export const accountsGetAutoStart = (): Promise<boolean> =>
  isTauri() ? invoke<boolean>('accounts_get_auto_start').catch(() => true) : Promise.resolve(true);

export const accountsSetAutoStart = (enabled: boolean): Promise<boolean> =>
  invoke<boolean>('accounts_set_auto_start', { enabled });

export const accountAddNew = (): Promise<boolean> => invoke<boolean>('account_add_new');

export const fmtWhen = (millis: number): string => {
  if (!millis) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - millis) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(millis).toLocaleDateString();
};
