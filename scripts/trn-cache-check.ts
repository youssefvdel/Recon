// Unit tests for the file-backed TRN cache (src/utils/trn.ts TTL/verdict
// logic + the Rust command wiring it depends on).
//
//   bun scripts/trn-cache-check.ts
//
// The Rust side owns the store (src-tauri/src/trn_cache.rs, tested by
// `cargo test trn_cache`); what is asserted here is the half that lives in
// TS — the freshness policy, the hit/miss decision, and the fact that a file
// hit never becomes a wire request.
export {};

// Deterministic localStorage BEFORE the module under test loads (same shape
// as devqa-check.ts).
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
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
  // Bun's Map has no quota, so the real QuotaExceededError cannot happen
  // here. `failNextWrite` reproduces it on demand, because "the write threw
  // and nobody noticed" is the exact failure this cache was rebuilt to end.
  failNextWrite: false,
} as unknown as Storage;

const { trnCacheFresh, trnCacheVerdict, trnProfilePath } = await import('../src/utils/trn.ts');

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const entry = (ageMs: number) => ({ path: '/api/x', body: '{"a":1}', fetched_at: NOW - ageMs });

// --- freshness is the caller's policy, evaluated on the entry's own age ---
check('a body fetched just now is fresh', trnCacheFresh(NOW, 24 * HOUR, NOW), true);
check('a body fetched 23h ago is fresh at 24h', trnCacheFresh(NOW - 23 * HOUR, 24 * HOUR, NOW), true);
check('a body fetched 25h ago is stale at 24h', trnCacheFresh(NOW - 25 * HOUR, 24 * HOUR, NOW), false);
check('the boundary is exclusive: exactly the TTL is stale', trnCacheFresh(NOW - 24 * HOUR, 24 * HOUR, NOW), false);
check('one ms inside the TTL is fresh', trnCacheFresh(NOW - 24 * HOUR + 1, 24 * HOUR, NOW), true);
check('a pinned 365d entry survives a year-old body', trnCacheFresh(NOW - 364 * 24 * HOUR, 365 * 24 * HOUR, NOW), true);
check('a pinned entry past 365d is stale', trnCacheFresh(NOW - 366 * 24 * HOUR, 365 * 24 * HOUR, NOW), false);
check('the matches 6h window is much shorter than the profile 24h one', trnCacheFresh(NOW - 7 * HOUR, 6 * HOUR, NOW), false);
// An age that cannot be established is never "current".
check('a zero stamp is never fresh', trnCacheFresh(0, 24 * HOUR, NOW), false);
check('a negative stamp is never fresh', trnCacheFresh(-1, 24 * HOUR, NOW), false);
check('a NaN stamp is never fresh', trnCacheFresh(Number.NaN, 24 * HOUR, NOW), false);
check('an unparseable stamp is never fresh', trnCacheFresh(Number.POSITIVE_INFINITY, 24 * HOUR, NOW), false);
check('a zero TTL makes everything stale', trnCacheFresh(NOW, 0, NOW), false);

// --- the hit/miss decision ---
check('no entry on disk → miss', trnCacheVerdict(null, 24 * HOUR, NOW), 'miss');
check('undefined (no entry) → miss', trnCacheVerdict(undefined, 24 * HOUR, NOW), 'miss');
check('a fresh entry → hit', trnCacheVerdict(entry(HOUR), 24 * HOUR, NOW), 'hit');
check('a stale entry → miss (it must revalidate)', trnCacheVerdict(entry(25 * HOUR), 24 * HOUR, NOW), 'miss');
// The same body, two callers, two policies: a 6h matches window and a 24h
// profile window read the SAME entry and reach different verdicts. That is
// the point of keeping the TTL out of Rust.
check('one entry, two policies, two verdicts', [trnCacheVerdict(entry(8 * HOUR), 6 * HOUR, NOW), trnCacheVerdict(entry(8 * HOUR), 24 * HOUR, NOW)], ['miss', 'hit']);

// --- the negative registry is untouched by all of this ---
const { trnNoteNegative, trnNegativeKind, trnNegativeBlocked, TRN_NEG_PRIVATE_MS, TRN_NEG_MISSING_MS, TRN_NEGATIVE_BACKOFF, noteNegativeFromPath } =
  await import('../src/utils/trn.ts');

// A proven private profile must still be filed for 7d and refuse to refetch,
// which is why it never reaches the cache layer at all.
trnNoteNegative('Private Guy', '0001', 'private');
check('a proven private is filed as private', trnNegativeKind('private guy', '0001'), 'private');
check('it is case-insensitive on the player key', trnNegativeBlocked('PRIVATE GUY', '0001'), true);
check('the private window is 7 days', TRN_NEG_PRIVATE_MS, 7 * 24 * HOUR);
check('the missing window is 24h', TRN_NEG_MISSING_MS, 24 * HOUR);
check('an unrelated player is not blocked', trnNegativeBlocked('someone', 'else'), false);
check('a 451 from any path files the negative centrally', noteNegativeFromPath(trnProfilePath('Other', '0002'), 'HTTP 451: CollectorResultStatus::Private This profile is still private.'), 'private');
check('...and it is now blocked without a request', trnNegativeBlocked('other', '0002'), true);
check('a 404 files missing, not private', noteNegativeFromPath(trnProfilePath('Ghost', '0003'), 'HTTP 404: not found'), 'missing');
check('a plain failure files nothing', noteNegativeFromPath(trnProfilePath('Fine', '0004'), 'HTTP 500: boom'), null);
check('the quiet backoff shape carries no ladder substring', /429|403|1015/.test(TRN_NEGATIVE_BACKOFF), false);
check('the registry survived all of that', [...store.keys()].filter((k) => k.startsWith('recon_trn_negative_v1')).length, 1);
check('and the negatives live under one key, not one per player', store.get('recon_trn_negative_v1')!.includes('private guy#0001'), true);

// --- the cooldown ladder is still a localStorage concern ---
const { resetTrnCooldown, trnCooldownRemainingMs, trnCooldownStepCount, trnCooldownDelayMs } =
  await import('../src/utils/trn.ts');
resetTrnCooldown();
check('no cooldown pending after a reset', trnCooldownRemainingMs(), 0);
check('no ladder step after a reset', trnCooldownStepCount(), 0);
check('the ladder still climbs and clamps', [1, 2, 3, 9].map(trnCooldownDelayMs), [25_000, 50_000, 60_000, 60_000]);
// A cooldown that outlives the process is the whole reason it is persisted:
// a warm start that respected it would serve nothing from the disk cache.
store.set('recon_trn_cooldown_until_v1', String(NOW + 30_000));
check('a cooldown written by a previous session is still honoured', trnCooldownRemainingMs() > 25_000, true);
resetTrnCooldown();
check('and a reset clears the persisted stamp too', store.has('recon_trn_cooldown_until_v1'), false);

// --- source wiring: the cache is opt-in per call, and the dead path is gone ---
const trnSrc = await Bun.file('src/utils/trn.ts').text();
const libSrc = await Bun.file('src-tauri/src/lib.rs').text();
const cacheRs = await Bun.file('src-tauri/src/trn_cache.rs').text();

check('trnGet reads the file cache', trnSrc.includes("invoke<TrnCacheEntry | null>('trn_cache_get'"), true);
check('trnGet writes the file cache', trnSrc.includes("invoke<TrnCachePut>('trn_cache_put'"), true);
// The megabyte bodies must NOT be back in localStorage: that is the bug.
check('no profile body is persisted to localStorage', trnSrc.includes('writePersisted(`profile:'), false);
check('no season body is persisted to localStorage', trnSrc.includes('writePersisted(`season:'), false);
check('no profile body is read from localStorage', trnSrc.includes('readPersisted<any>(`profile:'), false);
check('no season body is read from localStorage', trnSrc.includes('readPersisted<any>(`season:'), false);
check('the two small derived maps still are', (trnSrc.match(/writePersisted\(key, out\)/g) || []).length, 2);
check('the cache lookup runs before the per-path backoff', trnSrc.indexOf('trnCacheLookup(path, opts.ttlMs)') < trnSrc.indexOf('trnPathCooling(path)'), true);
check('the cache lookup runs before the cooldown gate', trnSrc.indexOf('trnCacheLookup(path, opts.ttlMs)') < trnSrc.indexOf('const cooling = trnCooldownRemainingMs()'), true);
check('a refusal is reported, not swallowed', trnSrc.includes("trnLog('cache write refused'"), true);
check('the store is fire-and-forget (a disk write never delays a fill)', trnSrc.includes('void invoke<TrnCachePut>'), true);
check('the root profile now has the in-flight dedup it was missing', trnSrc.includes('profileInFlight'), true);
check('the dedup is the same shape as the season one', (trnSrc.match(/InFlight = new Map<string, Promise<any>>\(\)/g) || []).length, 2);
check('a ttlMs is required for the disk path to run at all', trnSrc.includes('if (opts?.ttlMs) {'), true);

check('module declared', libSrc.includes('mod trn_cache;'), true);
check('get registered', libSrc.includes('trn_cache::trn_cache_get'), true);
check('put registered', libSrc.includes('trn_cache::trn_cache_put'), true);
check('trace ring registered', libSrc.includes('trn_cache::trn_cache_trace_log'), true);
check('the cache lives in app_data_dir, not a second convention', cacheRs.includes('.app_data_dir()') && cacheRs.includes('"trn-cache"'), true);
check('the commit is a rename over the target', cacheRs.includes('fs::rename(&tmp, &target)'), true);
check('a write goes to a temp file first', cacheRs.includes('.tmp'), true);
check('the size guard is a named constant', cacheRs.includes('const MAX_BODY_BYTES'), true);
check('the entry bound is a named constant', cacheRs.includes('const MAX_ENTRIES'), true);
check('eviction is oldest-first by the stored fetched_at', cacheRs.includes('sort_by_key(|(_, at)| *at)'), true);
check('a corrupt body is a miss, not data', cacheRs.includes('"corrupt: bad json"'), true);
check('the stored path is verified on read', cacheRs.includes('if h.path != path'), true);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All TRN file-cache tests passed.');
