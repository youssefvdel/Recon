import type { TabType } from '../types';

/**
 * Which tabs a launch may restore into.
 *
 * `settings` is deliberately absent: it is a visit-only configuration page,
 * and the Sidebar's version/UPDATE pill navigates there — restoring into it
 * would make Settings the sticky startup tab after any visit. A launch falls
 * back to `overview` when Settings was the last tab.
 *
 * Persistence is unchanged (`recon_active_tab` still records the real current
 * tab); only this restore decision excludes Settings. That keeps the data
 * available if a "resume Settings" affordance is ever wanted.
 */
const RESTORABLE_TABS: readonly TabType[] = [
  'overview',
  'switcher',
  'visualizer',
  'sens',
  'custom_res',
  'gpu',
  'borderless',
  'game_config',
  'valorant',
  'matches',
  'store',
  'crosshair',
  'prepick',
  'chat',
  'accounts',
];

/** Startup tab for a saved value: the saved tab when restorable, else `overview`. */
export function resolveInitialTab(saved: string | null): TabType {
  return saved && (RESTORABLE_TABS as readonly string[]).includes(saved)
    ? (saved as TabType)
    : 'overview';
}
