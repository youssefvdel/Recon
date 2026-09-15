// Consent decoupling: tracker starts ON with no first-run question about it;
// the ask-once modal covers crash reports only (default OFF). The manual
// recon_tracker_enabled_v1 toggle keeps byte-identical default-ON semantics.
//
//   bun scripts/consent-check.ts
export {};

// Deterministic localStorage BEFORE the modules under test load.
const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string): void => {
    store.set(k, String(v));
  },
  removeItem: (k: string): void => {
    store.delete(k);
  },
  clear: (): void => {
    store.clear();
  },
};
(globalThis as Record<string, unknown>).localStorage = fakeStorage;

const { isTrackerEnabled, setTrackerEnabled, resetTrackerEnabledCache } = await import(
  '../src/utils/trn.ts'
);
const { hasConsented, markConsented, isCrashOptIn, setCrashOptIn } = await import(
  '../src/utils/consent.ts'
);

const TRACKER_KEY = 'recon_tracker_enabled_v1';
const CONSENT_KEY = 'recon_consent_v1';
const CRASH_KEY = 'recon_crash_optin_v1';

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

// --- tracker runs without consent: fresh profile, no flags at all ---
store.clear();
resetTrackerEnabledCache();
check('no consent flag → not consented', hasConsented(), false);
check('no flags → tracker ON (never gated on consent)', isTrackerEnabled(), true);

// --- crash opt-in is ask-once, default OFF ---
check('no flags → crash opt-in OFF', isCrashOptIn(), false);

// --- consent flag is crash-only: marking it never touches the tracker ---
markConsented();
check('markConsented sets the consent flag', store.get(CONSENT_KEY), '1');
check('consent is recorded', hasConsented(), true);
check('marking consent leaves tracker ON', isTrackerEnabled(), true);
setTrackerEnabled(false);
markConsented();
check('marking consent leaves an explicit tracker OFF alone', isTrackerEnabled(), false);
setTrackerEnabled(true);

// --- manual toggle still works, default-ON semantics byte-identical ---
store.delete(TRACKER_KEY);
resetTrackerEnabledCache();
check('toggle absent → ON', isTrackerEnabled(), true);
setTrackerEnabled(false);
check('toggle OFF works', isTrackerEnabled(), false);
check('toggle OFF persists as 0', store.get(TRACKER_KEY), '0');
setTrackerEnabled(true);
check('toggle ON works', isTrackerEnabled(), true);
check('toggle ON clears the key', store.has(TRACKER_KEY), false);

// --- crash toggle round-trip ---
setCrashOptIn(true);
check('crash opt-in ON persists', store.get(CRASH_KEY), '1');
check('crash opt-in reads back', isCrashOptIn(), true);
setCrashOptIn(false);
check('crash opt-in OFF clears the key', store.has(CRASH_KEY), false);
check('crash opt-in default stays OFF', isCrashOptIn(), false);

// --- modal copy: crash-only, no tracker branch ---
const modal = await Bun.file('src/components/ConsentModal.tsx').text();
check('modal has no continue-without-tracker branch', modal.includes('Continue without tracker'), false);
check('modal never touches the tracker toggle', modal.includes('setTrackerEnabled'), false);
check('modal writes the crash choice', modal.includes('setCrashOptIn'), true);
check('modal records the ask-once flag', modal.includes('markConsented'), true);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All consent decoupling tests passed.');
