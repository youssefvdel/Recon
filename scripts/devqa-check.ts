// Unit tests for the Dev QA surface: tracker kill-switch toggle (src/utils/trn.ts)
// + server-chip fixture parsing (src/utils/matchServer.ts).
//
//   bun scripts/devqa-check.ts
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

const {
  parseTrackerEnabledFlag,
  isTrackerEnabled,
  setTrackerEnabled,
  resetTrackerEnabledCache,
  trnCooldownRemainingMs,
  trnCooldownStepCount,
  resetTrnCooldown,
  trnCooldownDelayMs,
  TRN_UA_MAJOR,
} = await import('../src/utils/trn.ts');
const { parseGamePodId, extractGamePodId } = await import('../src/utils/matchServer.ts');

const TRN_ENABLED_KEY = 'recon_tracker_enabled_v1';

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

// --- toggle flag parsing (pure) ---
check('flag absent → ON (default)', parseTrackerEnabledFlag(null), true);
check('flag undefined → ON', parseTrackerEnabledFlag(undefined), true);
check("flag '0' → OFF", parseTrackerEnabledFlag('0'), false);
check("flag '1' → ON", parseTrackerEnabledFlag('1'), true);
check("flag '' → ON", parseTrackerEnabledFlag(''), true);
check("flag garbage → ON", parseTrackerEnabledFlag('yes'), true);

// --- toggle get/set/persist round-trip ---
check('default ON with empty store', isTrackerEnabled(), true);
setTrackerEnabled(false);
check('OFF after setTrackerEnabled(false)', isTrackerEnabled(), false);
check('OFF persisted as 0', store.get(TRN_ENABLED_KEY), '0');
resetTrackerEnabledCache();
check('OFF survives cache reset (persisted)', isTrackerEnabled(), false);
setTrackerEnabled(true);
check('ON after setTrackerEnabled(true)', isTrackerEnabled(), true);
check('ON clears the key (absent = default ON)', store.has(TRN_ENABLED_KEY), false);
resetTrackerEnabledCache();
check('ON survives cache reset (default)', isTrackerEnabled(), true);

// --- gate + ladder untouched when ON ---
check('no cooldown pending initially', trnCooldownRemainingMs(), 0);
check('cooldown step 0 initially', trnCooldownStepCount(), 0);
check('UA major display constant', TRN_UA_MAJOR, 153);

// --- fixture parser (same fixtures as the Dev QA page) ---
check(
  'frankfurt fixture',
  parseGamePodId(extractGamePodId({ GamePodID: 'aresriot.aws-rclusterprod-eu2-1.eu-gp-frankfurt-1' })),
  'Frankfurt · EU2'
);
check(
  'oregon fixture',
  parseGamePodId(extractGamePodId({ GamePodID: 'aresriot.aws-rclusterprod-us2-1.na-gp-oregon-1' })),
  'Oregon · US2'
);
check(
  'unknown fixture falls back to raw pod segment',
  parseGamePodId(extractGamePodId({ GamePodID: 'aresriot.custom-cluster-9.custompod-xyz' })),
  'custompod-xyz'
);
check('absent payload → null (hidden chip)', parseGamePodId(extractGamePodId({})), null);
check('null payload → null (hidden chip)', parseGamePodId(extractGamePodId(null)), null);
check('null pod → null (hidden chip)', parseGamePodId(null), null);

// --- cooldown remaining: stored-key paths (cross-tab cooldown) ---
const TRN_COOLDOWN_KEY = 'recon_trn_cooldown_until_v1';
store.set(TRN_COOLDOWN_KEY, String(Date.now() + 25000));
check('stored future cooldown → remaining > 0', trnCooldownRemainingMs() > 0, true);
store.set(TRN_COOLDOWN_KEY, String(Date.now() - 1000));
check('stored expired cooldown → 0', trnCooldownRemainingMs(), 0);
store.set(TRN_COOLDOWN_KEY, 'garbage');
check('stored garbage cooldown → 0', trnCooldownRemainingMs(), 0);
store.delete(TRN_COOLDOWN_KEY);

// --- resetTrnCooldown ---
store.set(TRN_COOLDOWN_KEY, String(Date.now() + 25000));
resetTrnCooldown();
check('reset clears remaining', trnCooldownRemainingMs(), 0);
check('reset removes stored key', store.has(TRN_COOLDOWN_KEY), false);
check('reset clears step', trnCooldownStepCount(), 0);

// --- ladder math (pure; trnGet calls this verbatim) ---
check('ladder step 1 → 25s', trnCooldownDelayMs(1), 25000);
check('ladder step 2 → 50s', trnCooldownDelayMs(2), 50000);
check('ladder step 3 → capped 60s', trnCooldownDelayMs(3), 60000);
check('ladder step 4 → capped 60s', trnCooldownDelayMs(4), 60000);
check('ladder step 9 → capped 60s', trnCooldownDelayMs(9), 60000);
check('ladder step 0 → floored 25s', trnCooldownDelayMs(0), 25000);

// --- toggle storage-throw paths (fail-open, memory still correct) ---
const throwingStorage = {
  getItem: (_k: string): string => {
    throw new Error('denied');
  },
  setItem: (_k: string, _v: string): void => {
    throw new Error('denied');
  },
  removeItem: (_k: string): void => {
    throw new Error('denied');
  },
};
(globalThis as Record<string, unknown>).localStorage = throwingStorage;
resetTrackerEnabledCache();
check('throwing storage → default ON', isTrackerEnabled(), true);
setTrackerEnabled(false);
check('throwing storage → in-memory OFF', isTrackerEnabled(), false);
setTrackerEnabled(true);
check('throwing storage → in-memory ON', isTrackerEnabled(), true);
(globalThis as Record<string, unknown>).localStorage = fakeStorage;
resetTrackerEnabledCache();
check('numeric 0 flag → OFF', parseTrackerEnabledFlag(0), false);
check('restored storage → default ON', isTrackerEnabled(), true);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All Dev QA tests passed.');
