// Startup tab restore: the saved tab is restored on launch, except `settings`.
// Settings is a visit-only page — the Sidebar version/UPDATE pill navigates
// there — so restoring into it made it the sticky startup tab. A launch must
// fall back to overview instead. Persistence itself is unchanged.
//
//   bun scripts/tab-restore-check.ts

import { resolveInitialTab } from '../src/utils/tabRestore';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (ok) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

// --- restore decision (pure) ---
check('last tab settings → overview', resolveInitialTab('settings'), 'overview');
check('last tab overview → overview', resolveInitialTab('overview'), 'overview');
check('last tab store → store', resolveInitialTab('store'), 'store');
check('saved garbage → overview', resolveInitialTab('not-a-tab'), 'overview');
check('no saved value → overview', resolveInitialTab(null), 'overview');

// --- wiring: App restores through the helper, persistence still records the
// real current tab (the "resume Settings" data must survive) ---
const appSrc = await Bun.file('src/App.tsx').text();
check('App restores via resolveInitialTab', appSrc.includes('resolveInitialTab(localStorage.getItem('), true);
check('persist line unchanged (real current tab)', appSrc.includes("localStorage.setItem('recon_active_tab', currentTab)"), true);
check('no inline settings allowlist left in App', appSrc.includes("'game_config', 'settings', 'valorant'"), false);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All tab-restore tests passed.');
