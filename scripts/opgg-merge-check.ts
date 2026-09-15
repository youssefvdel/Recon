// Unit tests for the OP.GG match-history fallback (src/utils/opgg.ts):
// gating, normalization (full + sparse fixtures), cache-namespace
// separation, and citation presence.
//
//   bun scripts/opgg-merge-check.ts
export {};

// Deterministic localStorage BEFORE the modules under test load.
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
};

const {
  isOpggFallbackActive,
  normalizeOpggMatchEntry,
  normalizeOpggMatches,
  opggCacheKey,
  readOpggCache,
  writeOpggCache,
  OPGG_ATTRIBUTION,
  OPGG_MATCHES_TTL_MS,
} = await import('../src/utils/opgg.ts');
const { resetTrackerEnabledCache } = await import('../src/utils/trn.ts');

const TRN_COOLDOWN_KEY = 'recon_trn_cooldown_until_v1';
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

// --- 1. gating: fallback fires ONLY on cooldown or toggle OFF ---
check('healthy TRN → fallback OFF', isOpggFallbackActive(), false);
store.set(TRN_COOLDOWN_KEY, String(Date.now() + 25000));
check('TRN cooling → fallback ON', isOpggFallbackActive(), true);
store.delete(TRN_COOLDOWN_KEY);
check('cooldown cleared → fallback OFF', isOpggFallbackActive(), false);
store.set(TRN_ENABLED_KEY, '0');
resetTrackerEnabledCache();
check('tracker toggle OFF → fallback ON', isOpggFallbackActive(), true);
store.delete(TRN_ENABLED_KEY);
resetTrackerEnabledCache();
check('toggle back ON → fallback OFF', isOpggFallbackActive(), false);

// --- 2. normalization: full fixture ---
const FULL = {
  match_id: 'opgg-match-1',
  map: 'Ascent',
  map_id: '7EAECC1B-4337-BBF6-6AB9-04B8F06B3319',
  agent: 'Jett',
  won: true,
  kills: 22,
  deaths: 15,
  assists: 6,
  score: 4850,
  rounds: 24,
  played_at: '2026-09-01T18:30:00Z',
  mode: 'Competitive',
};
const full = normalizeOpggMatchEntry(FULL);
check('full: not null', full !== null, true);
check('full: matchId', full?.matchId, 'opgg-match-1');
check('full: map', full?.map, 'Ascent');
check('full: agent', full?.agent, 'Jett');
check('full: won', full?.won, true);
check('full: k/d/a', `${full?.kills}/${full?.deaths}/${full?.assists}`, '22/15/6');
check('full: score/rounds', `${full?.score}/${full?.rounds}`, '4850/24');
check('full: when parsed', full?.when, Date.parse('2026-09-01T18:30:00Z'));
check('full: queue', full?.queue, 'Competitive');
check('full: source citation', full?.source, 'opgg');
check('full: no rr invented', 'rr' in (full as object), false);
check('full: no tier invented', 'tier' in (full as object), false);
check('full: no rank invented', 'rank' in (full as object), false);

// --- 2b. normalization: sparse fixture (map what exists, null the rest) ---
const SPARSE = { id: 'opgg-match-2', map_name: 'Bind', character: 'Sova' };
const sparse = normalizeOpggMatchEntry(SPARSE);
check('sparse: not null', sparse !== null, true);
check('sparse: id alias', sparse?.matchId, 'opgg-match-2');
check('sparse: map alias', sparse?.map, 'Bind');
check('sparse: agent alias', sparse?.agent, 'Sova');
check('sparse: won null (not invented)', sparse?.won, null);
check('sparse: kills default', sparse?.kills, 0);
check('sparse: when default', sparse?.when, 0);
check('sparse: queue default', sparse?.queue, '');
check('sparse: source citation', sparse?.source, 'opgg');

check('entry without id → null', normalizeOpggMatchEntry({ map: 'Ascent' }), null);check('non-object → null', normalizeOpggMatchEntry(null), null);
check('array → null', normalizeOpggMatchEntry([]), null);

// --- won variants (win/loss synonyms, numbers, booleans) ---
const wonOf = (w: unknown): unknown => normalizeOpggMatchEntry({ id: 'w', won: w })?.won;
check("won 'win' → true", wonOf('win'), true);
check("won 'loss' → false", wonOf('loss'), false);
check("won 'W' → true", wonOf('W'), true);
check("won 'L' → false", wonOf('L'), false);
check('won 1 → true', wonOf(1), true);
check('won 0 → false', wonOf(0), false);
check('won true stays true', wonOf(true), true);
check('won false stays false', wonOf(false), false);
check("won 'maybe' → null", wonOf('maybe'), null);

// --- when variants (epoch s, epoch ms, ISO, garbage) ---
const whenOf = (w: unknown): unknown => normalizeOpggMatchEntry({ id: 't', played_at: w })?.when;
check('when epoch seconds → ms', whenOf(1756751400), 1756751400000);
check('when epoch ms passes through', whenOf(1756751400000), 1756751400000);
check('when ISO parses', whenOf('2026-09-01T18:30:00Z'), Date.parse('2026-09-01T18:30:00Z'));
check('when garbage → 0', whenOf('not a date'), 0);

// --- numeric-string coercion ---
check("kills '22' → 22", normalizeOpggMatchEntry({ id: 'n', kills: '22' })?.kills, 22);

// --- 2c. envelopes ---
const rpcEnvelope = { content: [{ type: 'text', text: JSON.stringify([FULL, SPARSE]) }] };
const fromRpc = normalizeOpggMatches(rpcEnvelope);
check('tools/call envelope → 2 entries', fromRpc.length, 2);
check('envelope ids in order', fromRpc.map((m) => m.matchId).join(','), 'opgg-match-1,opgg-match-2');
check('data envelope', normalizeOpggMatches({ data: [FULL] }).length, 1);
check('matches envelope', normalizeOpggMatches({ matches: [FULL] }).length, 1);
check('result envelope', normalizeOpggMatches({ result: [FULL] }).length, 1);
check(
  'content-text inner data envelope',
  normalizeOpggMatches({ content: [{ text: JSON.stringify({ data: [FULL] }) }] }).length,
  1
);
check('empty content → []', normalizeOpggMatches({ content: [] }).length, 0);
check('content without text → []', normalizeOpggMatches({ content: [{}] }).length, 0);
check('scalar JSON text → []', normalizeOpggMatches({ content: [{ text: '42' }] }).length, 0);
check('bare array', normalizeOpggMatches([FULL]).length, 1);
check('garbage → []', normalizeOpggMatches({ nope: 1 }).length, 0);
check('bad JSON text → []', normalizeOpggMatches({ content: [{ text: '{oops' }] }).length, 0);

// --- 3. cache-namespace separation ---
check('cache key namespaced', opggCacheKey('TenZ', 'SEN').startsWith('recon_opgg_cache_v1:'), true);
writeOpggCache(opggCacheKey('TenZ', 'SEN'), [FULL]);
const back = readOpggCache<typeof FULL[]>(opggCacheKey('TenZ', 'SEN'), OPGG_MATCHES_TTL_MS);
check('cache round-trip', back?.length, 1);
let trnKeys = 0;
for (const k of store.keys()) if (k.startsWith('recon_trn_cache_v1')) trnKeys++;
check('no trn_ keys touched', trnKeys, 0);
// Stale entry expires under the same TTL the fetcher uses.
store.set(opggCacheKey('Old', 'One'), JSON.stringify({ at: Date.now() - OPGG_MATCHES_TTL_MS - 1000, data: [FULL] }));
check('stale entry expires', readOpggCache(opggCacheKey('Old', 'One'), OPGG_MATCHES_TTL_MS), null);
store.set(opggCacheKey('Bad', 'Json'), '{oops');
check('corrupt cache → null', readOpggCache(opggCacheKey('Bad', 'Json'), OPGG_MATCHES_TTL_MS), null);
store.set(opggCacheKey('No', 'At'), JSON.stringify({ data: [] }));
check('missing at → null', readOpggCache(opggCacheKey('No', 'At'), OPGG_MATCHES_TTL_MS), null);
check('TTL is 2h', OPGG_MATCHES_TTL_MS, 7200000);

// --- gating: garbage cooldown with toggle ON stays OFF ---
store.set('recon_trn_cooldown_until_v1', 'garbage');
check('garbage cooldown + toggle ON → fallback OFF', isOpggFallbackActive(), false);
store.delete('recon_trn_cooldown_until_v1');

// --- 4. citation presence ---
check('attribution names OP.GG', OPGG_ATTRIBUTION.includes('OP.GG'), true);
check('attribution has source link', OPGG_ATTRIBUTION.includes('op.gg'), true);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All OP.GG merge tests passed.');
