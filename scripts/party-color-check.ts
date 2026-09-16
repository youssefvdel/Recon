// Party colors are derived from stable party IDs (hash → palette, probed
// distinct per lobby) — never from discovery order. Covers the flicker fix
// plus each sibling cause found in the same area.
//
//   bun scripts/party-color-check.ts
export {};

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${detail !== undefined ? `\n  detail: ${JSON.stringify(detail)}` : ''}`);
  }
}

const {
  PARTY_STYLES,
  assignPartyColors,
  getPartyStyle,
  partyColorIndex,
} = await import('../src/utils/playerDisplay.ts');

const { restoreLatchedParties } = await import('../src/utils/tracker.ts');

// --- Core: same ID → same color, forever ---
const id = 'riot:7f3a2b1c-9d4e-5f6a-8b7c-1d2e3f4a5b6c';
const first = partyColorIndex(id);
let stable = true;
for (let i = 0; i < 1000; i++) {
  if (partyColorIndex(id) !== first) {
    stable = false;
    break;
  }
}
check('same party ID → same color across 1000 hashes', stable && first >= 1 && first <= 6, { first });
check('hash is case/whitespace-insensitive', partyColorIndex(`  ${id.toUpperCase()} `) === first);

// --- Distinct parties → distinct colors ---
const five = ['riot:aaa', 'riot:bbb', 'riot:ccc', 'riot:ddd', 'riot:eee'];
const assigned = assignPartyColors(five);
const vals = [...assigned.values()];
check(
  '5 distinct IDs → 5 distinct colors in 1..6',
  new Set(vals).size === 5 && vals.every((v) => v >= 1 && v <= 6),
  { vals }
);

// --- Solos stay neutral ---
for (const solo of [undefined, null, '', '   '] as const) {
  check(`solo (${JSON.stringify(solo)}) → neutral index 0`, partyColorIndex(solo) === 0);
}
check('index 0 → no style', getPartyStyle(0) === null);
check('undefined → no style', getPartyStyle(undefined) === null);
check('blank IDs skipped by assigner', assignPartyColors(['riot:aaa', '', '   ']).size === 1);

// --- Order-independence: shuffled input, same mapping ---
const ids = ['riot:zeta', 'party_abc123', 'riot:alpha', 'party_999', 'riot:mid'];
const base = assignPartyColors(ids);
let orderFree = true;
for (let s = 0; s < 20; s++) {
  const shuffled = [...ids].sort(() => Math.random() - 0.5);
  const again = assignPartyColors(shuffled);
  for (const k of ids) {
    if (again.get(k) !== base.get(k)) {
      orderFree = false;
      break;
    }
  }
}
check('shuffled input → identical mapping (20 shuffles)', orderFree);
check('duplicate IDs collapse to one entry', assignPartyColors(['riot:a', 'riot:a']).size === 1);

// --- Palette untouched (no new design language) ---
check('palette still has 6 entries', Object.keys(PARTY_STYLES).length === 6);
check(
  'palette names unchanged',
  [1, 2, 3, 4, 5, 6].every((i) => PARTY_STYLES[i]?.name === `Party ${i}`)
);

// --- Sticky outline: a missed poll must not dissolve a party ---
// Poll 1 establishes {a,b} as riot:X (index 2); poll 2 misses b's presence
// row so the fresh maps are empty — the outline must survive via the latch.
{
  const latchedClusters = new Map([['a', 'riot:X'], ['b', 'riot:X']]);
  const latchedIndexes = new Map([['a', 2], ['b', 2]]);
  const freshClusters = new Map<string, string>();
  const freshIndexes = new Map<string, number>();
  restoreLatchedParties(freshClusters, freshIndexes, latchedClusters, latchedIndexes, new Set(['a', 'b', 'c']));
  check('missed poll restores both members', freshClusters.get('a') === 'riot:X' && freshClusters.get('b') === 'riot:X', {
    got: [...freshClusters.entries()],
  });
  check('restored index keeps latched color (no re-hash)', freshIndexes.get('a') === 2 && freshIndexes.get('b') === 2);
  check('restored index still renders an outline', getPartyStyle(freshIndexes.get('a')) !== null);
  check('solo stranger stays solo', !freshClusters.has('c'));
}
{
  // Fresh evidence wins: a re-formed cluster keeps its new id + index.
  const latchedClusters = new Map([['a', 'riot:X']]);
  const latchedIndexes = new Map([['a', 2]]);
  const freshClusters = new Map([['a', 'riot:Y']]);
  const freshIndexes = new Map([['a', 4]]);
  restoreLatchedParties(freshClusters, freshIndexes, latchedClusters, latchedIndexes, new Set(['a']));
  check('fresh cluster id wins over latch', freshClusters.get('a') === 'riot:Y');
  check('fresh index wins over latch', freshIndexes.get('a') === 4);
}
{
  // Leavers are never restored into the new lobby.
  const latchedClusters = new Map([['gone', 'riot:X']]);
  const latchedIndexes = new Map([['gone', 2]]);
  const freshClusters = new Map<string, string>();
  const freshIndexes = new Map<string, number>();
  restoreLatchedParties(freshClusters, freshIndexes, latchedClusters, latchedIndexes, new Set(['a']));
  check('leaver not restored', freshClusters.size === 0 && freshIndexes.size === 0);
}
{
  // Latched entry without an index restores nothing (no phantom outline).
  const latchedClusters = new Map([['a', 'riot:X']]);
  const freshClusters = new Map<string, string>();
  const freshIndexes = new Map<string, number>();
  restoreLatchedParties(freshClusters, freshIndexes, latchedClusters, new Map(), new Set(['a']));
  check('index-less latch restores nothing', freshClusters.size === 0);
}

// --- Sibling-cause regressions (source text) ---
const tracker = await Bun.file('src/utils/tracker.ts').text();
const live = await Bun.file('src/components/LiveMatchView.tsx').text();
const overlay = await Bun.file('src/components/OverlayView.tsx').text();

check('sequential counter gone', !tracker.includes('nextMatchPartyIndex'));
check('per-match index latch gone', !tracker.includes('matchPartyIndexMap'));
check('colors derived via assigner', tracker.includes('assignPartyColors(clusterIds)'));
check('cluster prefers shared Riot presence ID', tracker.includes('riot:${'));
check('solo partyId fallback removed', !tracker.includes('|| p.partyId || presencePartyMap'));
check('union shares the validity predicate', tracker.includes('validRiotPartyId(rp.partyId'));
check('lobby rows keyed by puuid (live view)', live.includes('key={p.puuid}'));
check('lobby rows keyed by puuid (overlay)', overlay.includes('key={p.puuid}'));
check('sticky latch fills solo gaps', tracker.includes('restoreLatchedParties('));
check('latch resets per match', tracker.includes('lastPartyClusterByPuuid.clear()'));
check('latch stores fresh clusters', tracker.includes('lastPartyClusterByPuuid.set(puuid, cid)'));
check('outline never gated on loading', !overlay.includes('party && !') && !live.includes('party && !'));

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All party-color tests passed.');
