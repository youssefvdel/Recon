// Unit tests for the dev-dashboard TRN trace parser
// (parseTrnTraceLine + its formatters, src/components/DevDashboard.tsx).
//
//   bun scripts/trn-log-check.ts
//
// The panel's contract is that a line is never dropped and never throws, so
// the degradation cases are asserted as loudly as the happy paths.
export {};

const {
  parseTrnTraceLine,
  formatTrnRel,
  trnPathLabel,
  trnStatusTone,
  trnKindBadge,
  summarizeTrnTrace,
  trnFilterMatch,
  formatTrnTraceExport,
  buildTrnTraceExport,
  trnExportReport,
} = await import('../src/components/DevDashboard.tsx');

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

// Real line shapes, copied off the `trn_trace!` call sites in trn_proxy.rs.
const LINE_FETCH =
  '[TRN 1790444228930] fetch start path=/api/v2/valorant/standard/profile/riot/lil%20ga7ed%23zngr/segments/season?fromIndex=0&toIndex=5 phase=match drain=true lobby=';
const LINE_MEMO = '[TRN 1790444233542] MEMO hit path=/api/v2/valorant/standard/profile/riot/lil%20ga7ed%23zngr/segments/season?fromIndex=0';
const LINE_OK = '[TRN 1790444228920] outcome ok=true status=200 elapsed_ms=662';
const LINE_FAIL = '[TRN 1790441701712] outcome ok=false status=0 elapsed_ms=103';
// A rejected in-page fetch now carries the page's own message, so a
// `status=0` row is readable without the terminal.
const LINE_FAIL_ERR =
  '[TRN 1790441701713] outcome ok=false status=0 elapsed_ms=101 err=NetworkError when attempting to fetch resource.';
const LINE_READY = '[TRN 1790441701609] READY (clearance ok)';
// File-cache lines come off trn_cache.rs's own ring, but with the same
// `[TRN <ms>] ` prefix and the same `path=` field, so the parser is shared.
const LINE_CACHE_HIT =
  '[TRN 1790441701610] CACHE hit path=/api/v2/valorant/standard/profile/riot/lil%20ga7ed%23zngr age_ms=41233 bytes=1271334';
const LINE_CACHE_MISS =
  '[TRN 1790441701611] CACHE miss path=/api/v2/valorant/standard/profile/riot/lil%20ga7ed%23zngr reason=absent';
const LINE_CACHE_CORRUPT =
  '[TRN 1790441701612] CACHE miss path=/api/v2/valorant/standard/profile/riot/lil%20ga7ed%23zngr reason=corrupt: bad json';
const LINE_CACHE_WRITE = '[TRN 1790441701613] CACHE write path=/api/v2/valorant/standard/profile/riot/x%23y bytes=1271334';
const LINE_CACHE_EVICT =
  '[TRN 1790441701614] CACHE evicted path=/api/v2/valorant/standard/profile/riot/old%23act';
const LINE_CACHE_REFUSED =
  '[TRN 1790441701615] CACHE refused path=/api/v2/valorant/standard/profile/riot/big%23body bytes=9000000 cap=4194304 reason=body 9000000 bytes is over the 4194304 byte cap — refused, nothing stored';

// --- kind classification, one per observed body shape ---
check('fetch start → fetch', parseTrnTraceLine(1, LINE_FETCH).kind, 'fetch');
check('MEMO hit → memo', parseTrnTraceLine(2, LINE_MEMO).kind, 'memo');
check('outcome → outcome', parseTrnTraceLine(3, LINE_OK).kind, 'outcome');
check('READY → ready', parseTrnTraceLine(4, LINE_READY).kind, 'ready');
check('unrecognised body → unknown', parseTrnTraceLine(5, '[TRN 1790444233550] RECREATED reason=not-ready path=/api/v2/valorant/standard/profile/riot/lil%20ga7ed%23zngr/segments/season (fresh navigation re-earns clearance)').kind, 'unknown');
// `fetch timeout` is the sibling of `fetch start` and is NOT wire traffic.
check('"fetch timeout" is not a fetch', parseTrnTraceLine(6, '[TRN 1790444233551] fetch timeout path=/api/v2/valorant/standard/profile/riot/lil%20ga7ed%23zngr/segments/season elapsed_ms=20001 (hung page)').kind, 'unknown');
// "NOT READY" must not be swept up by a READY prefix test.
check('NOT READY is not ready', parseTrnTraceLine(7, '[TRN 1790444233552] NOT READY path=/api/v2/valorant/standard/profile/riot/lil%20ga7ed%23zngr/segments/season (still loading/challenged after budget)').kind, 'unknown');
// A timeout names its path but is still not wire traffic, so the "fetches"
// filter (the is-it-spamming answer) must not count it.
check('a timeout is excluded from the wire count', summarizeTrnTrace([parseTrnTraceLine(1, '[TRN 5] fetch timeout path=/api/x elapsed_ms=20001 (hung page)')]).fetches, 0);
// Every refusal names its path, so a row is self-describing in the panel
// without the terminal. They stay `unknown` on purpose: the `errors` filter
// sweeps those in, and a badge that claims a kind would over-claim.
for (const body of [
  'LOST path=/api/x err=proxy lost mid-poll',
  'FAILED path=/api/x err=EDGE_UNAVAILABLE proxy lost',
  'REJECTED path=/api/x err=Path too long.',
  'CEILING spent=lobby path=/api/x',
  'PAUSED path=/api/x phase=coregame (in-match fullscreen)',
  'JOIN in-flight path=/api/x',
  'NOT READY path=/api/x (still loading/challenged after budget)',
]) {
  const r = parseTrnTraceLine(1, `[TRN 5] ${body}`);
  check(`refusal is verbatim and error-visible: ${body.split(' ')[0]}`, [r.kind, r.label.includes('/api/x')], ['unknown', true]);
}

// --- outcome field extraction ---
check(
  'outcome ok=true fields',
  (() => {
    const r = parseTrnTraceLine(8, LINE_OK);
    return [r.ok, r.status, r.elapsed, r.ms, r.seq];
  })(),
  [true, 200, 662, 1790444228920, 8],
);
check(
  'outcome ok=false fields',
  (() => {
    const r = parseTrnTraceLine(9, LINE_FAIL);
    return [r.ok, r.status, r.elapsed];
  })(),
  [false, 0, 103],
);
check('READY carries no fields', parseTrnTraceLine(10, LINE_READY).elapsed, undefined);
// ok/status/elapsed have their own columns, so the middle cell stays empty
// for a line that carries no reason.
check('outcome leaves the middle cell empty', parseTrnTraceLine(10, LINE_OK).label, '');

// --- the failure reason reaches the row (the reason status=0 was unreadable)
// `err=` is the last field and is the only one with spaces in it, so it needs
// its own read; `kv`'s `\S*` would have cut it at the first space.
check(
  'rejected fetch shows the in-page error in the row',
  (() => {
    const r = parseTrnTraceLine(30, LINE_FAIL_ERR);
    return [r.kind, r.ok, r.status, r.elapsed, r.err, r.label];
  })(),
  ['outcome', false, 0, 101, 'NetworkError when attempting to fetch resource.', 'NetworkError when attempting to fetch resource.'],
);
// ...and the other three fields still parse with the extra field present.
check(
  'err= does not disturb ok/status/elapsed',
  (() => {
    const r = parseTrnTraceLine(30, LINE_FAIL_ERR);
    return [r.ok, r.status, r.elapsed];
  })(),
  [false, 0, 101],
);
// An HTTP failure has no err= (the backend only attaches one for status=0) —
// its status is the fact, and its body is never logged.
check('http failure has no err and an empty middle cell', [parseTrnTraceLine(31, '[TRN 5] outcome ok=false status=429 elapsed_ms=400').err, parseTrnTraceLine(31, '[TRN 5] outcome ok=false status=429 elapsed_ms=400').label], [undefined, '']);
// The sentinel for "the page rejected with no message at all" still reads.
check('an empty in-page message is named, not blank', parseTrnTraceLine(31, '[TRN 5] outcome ok=false status=0 elapsed_ms=9 err=<empty>').label, '<empty>');
// The backend flattens control chars, but the parser must not depend on it.
check('err= survives a multi-line body', parseTrnTraceLine(31, '[TRN 5] outcome ok=false status=0 elapsed_ms=9 err=one\ntwo').err, 'one\ntwo');
// A path key that CONTAINS `err=` must not be mistaken for the field.
check('err= inside another value is not the field', parseTrnTraceLine(31, '[TRN 5] outcome ok=true status=200 elapsed_ms=9 referrer=err=nope').err, undefined);

// --- fetch field extraction, including the empty phase/lobby the backend prints ---
check(
  'fetch fields (path/phase/drain/lobby)',
  (() => {
    const r = parseTrnTraceLine(11, LINE_FETCH);
    return [r.path, r.phase, r.drain, r.lobby];
  })(),
  [
    '/api/v2/valorant/standard/profile/riot/lil%20ga7ed%23zngr/segments/season?fromIndex=0&toIndex=5',
    'match',
    true,
    '',
  ],
);
check(
  'fetch with unset phase/lobby/drain',
  (() => {
    const r = parseTrnTraceLine(12, '[TRN 1790444228931] fetch start path=/pd/account/riot/name/tag phase= drain=false lobby=eu-1');
    return [r.phase, r.drain, r.lobby, r.label];
  })(),
  ['', false, 'eu-1', '/pd/account/riot/name/tag'],
);
// --- a fetch and a memo on the SAME path are different kinds (the whole point) ---
const samePath = '/api/v2/valorant/standard/profile/riot/TenZ%230000/segments/season?x=1';
check(
  'same path: fetch ≠ memo',
  (() => {
    const f = parseTrnTraceLine(13, `[TRN 1790444228932] fetch start path=${samePath} phase= phase= lobby=`);
    const m = parseTrnTraceLine(14, `[TRN 1790444228933] MEMO hit path=${samePath}`);
    return [f.kind, m.kind, f.path === m.path, f.label === m.label];
  })(),
  ['fetch', 'memo', true, true],
);

// --- degradation: never throw, never lose the raw line ---
const degraded: [string, string][] = [
  ['empty body', '[TRN 1790444228921] '],
  ['truncated fetch (no path)', '[TRN 1790444228922] fetch start'],
  ['truncated outcome (no boolean)', '[TRN 1790444228923] outcome ok='],
  ['unexpected shape', '[TRN 1790444228924] {"json":true,"n":1}'],
  ['bare stamp, no body', '[TRN 123]'],
  ['no stamp at all', 'totally unparseable garbage'],
];
for (const [name, line] of degraded) {
  const r = parseTrnTraceLine(99, line);
  check(`${name} → unknown, raw retained`, [r.kind, r.raw], ['unknown', line]);
}
// The only one of those that carries a usable stamp keeps it.
check('bare stamp keeps its ms', parseTrnTraceLine(99, '[TRN 123]').ms, 123);
// Surrounding whitespace is tolerated, and the line is still kept verbatim.
check(
  'padded line still parses, raw untouched',
  (() => {
    const r = parseTrnTraceLine(95, '  [TRN 1790444228925] READY (clearance ok)  ');
    return [r.kind, r.raw];
  })(),
  ['ready', '  [TRN 1790444228925] READY (clearance ok)  '],
);
// Malformed-but-stamped outcome: kind survives, the unreadable field does not.
check(
  'outcome with a missing field degrades the field, not the line',
  (() => {
    const r = parseTrnTraceLine(97, '[TRN 1790444228923] outcome ok=true status= elapsed_ms=700');
    return [r.kind, r.ok, r.status, r.elapsed];
  })(),
  ['outcome', true, 0, 700],
);
check('non-string input cannot throw', parseTrnTraceLine(96, undefined as unknown as string).kind, 'unknown');

// --- relative-time formatter ---
check('sub-second', formatTrnRel(9_999, 10_000), '+0.0s');
check('400ms', formatTrnRel(9_600, 10_000), '+0.4s');
check('multi-second', formatTrnRel(7_200, 20_000), '+12.8s');
check('59.9s still sub-minute', formatTrnRel(100, 60_000), '+59.9s');
check('one minute', formatTrnRel(4_000, 64_000), '1m 00s');
check('multi-minute', formatTrnRel(1_000, 65_000), '1m 04s');
check('newest line reads +0.0s', formatTrnRel(64_000, 64_000), '+0.0s');
check('no stamp → em dash, never NaN', formatTrnRel(0, 64_000), '—');
check('no window at all → em dash', formatTrnRel(64_000, 0), '—');

// --- path label: decoded, short, player legible ---
check(
  'player path label',
  trnPathLabel('/api/v2/valorant/standard/profile/riot/lil%20ga7ed%23zngr/segments/season?fromIndex=0&toIndex=5'),
  'lil ga7ed#zngr · segments/season',
);
check('root-only player path', trnPathLabel('/api/v2/valorant/standard/profile/riot/TenZ%230000'), 'TenZ#0000');
check('literal # player path', trnPathLabel('/riot/bot#staff/segments/season'), 'bot#staff · segments/season');
// `/pd/` account paths also contain `/riot/` but carry no `%23` — not a player.
check('non-player path keeps its shape', trnPathLabel('/pd/account/riot/name/tag'), '/pd/account/riot/name/tag');
check('malformed %-escape does not throw', trnPathLabel('/x/riot/%E0%A4%A'), '/x/riot/%E0%A4%A');

// --- status tone: 451/404 are proven negatives in trn.ts, not red failures ---
check('2xx is success', trnStatusTone(200), 'ok');
check('204 is success', trnStatusTone(204), 'ok');
check('404 is a proven negative, not an error', trnStatusTone(404), 'warn');
check('451 is a proven negative, not an error', trnStatusTone(451), 'warn');
check('0 is the real failure', trnStatusTone(0), 'bad');
check('429 is a real failure', trnStatusTone(429), 'bad');
check('5xx is a real failure', trnStatusTone(503), 'bad');
check('3xx is neutral', trnStatusTone(302), 'muted');

// --- badge: colour class + label per kind ---
const badgeOf = (line: string): string => trnKindBadge(parseTrnTraceLine(1, line)).label;
// --- the file cache is its own kind, and it is NOT wire traffic ---
check('CACHE hit → cache/hit', (() => { const r = parseTrnTraceLine(20, LINE_CACHE_HIT); return [r.kind, r.cache]; })(), ['cache', 'hit']);
check('CACHE hit carries the path', parseTrnTraceLine(20, LINE_CACHE_HIT).path, '/api/v2/valorant/standard/profile/riot/lil%20ga7ed%23zngr');
check('CACHE hit label is the player, not the raw path', parseTrnTraceLine(20, LINE_CACHE_HIT).label, 'lil ga7ed#zngr');
check('CACHE miss → cache/miss', (() => { const r = parseTrnTraceLine(21, LINE_CACHE_MISS); return [r.kind, r.cache]; })(), ['cache', 'miss']);
// A corrupt entry is a FAULT, and the cold `reason=absent` miss is not — they
// must not read the same in the errors filter.
check('CACHE miss corrupt → cache/corrupt', (() => { const r = parseTrnTraceLine(22, LINE_CACHE_CORRUPT); return [r.kind, r.cache]; })(), ['cache', 'corrupt']);
check('CACHE write → cache/write', (() => { const r = parseTrnTraceLine(23, LINE_CACHE_WRITE); return [r.kind, r.cache]; })(), ['cache', 'write']);
check('CACHE evicted → cache/evict', (() => { const r = parseTrnTraceLine(24, LINE_CACHE_EVICT); return [r.kind, r.cache]; })(), ['cache', 'evict']);
check('CACHE refused → cache/refused', (() => { const r = parseTrnTraceLine(25, LINE_CACHE_REFUSED); return [r.kind, r.cache]; })(), ['cache', 'refused']);
// The refusal reason is the loud half of the size guard and must survive to
// the row, spaces and all.
check('a refusal keeps its reason in the row', parseTrnTraceLine(25, LINE_CACHE_REFUSED).label.includes('refused, nothing stored'), true);
check('a corrupt entry keeps its reason in the row', parseTrnTraceLine(22, LINE_CACHE_CORRUPT).label, 'corrupt: bad json');
// A plain hit/miss row shows the player, not the reason — the path is what you
// are scanning for once nothing is wrong.
check('a hit row shows the player, not the age', parseTrnTraceLine(20, LINE_CACHE_HIT).label, 'lil ga7ed#zngr');
// ...and a half-line still degrades to unknown rather than claiming a kind.
check('pathless CACHE line still parses as a cache row', (() => { const r = parseTrnTraceLine(26, '[TRN 5] CACHE evicted path=? (unreadable header)'); return [r.kind, r.cache]; })(), ['cache', 'evict']);
check('a CACHE prefix with no known verb is not a cache row', parseTrnTraceLine(27, '[TRN 5] CACHE nonsense path=/api/x').kind, 'unknown');
// THE accounting rule: a file hit costs no request and no memo entry.
check('a cache hit is not billed as a wire request', summarizeTrnTrace([parseTrnTraceLine(20, LINE_CACHE_HIT)]).fetches, 0);
check('a cache hit is not billed as a memo save', summarizeTrnTrace([parseTrnTraceLine(20, LINE_CACHE_HIT)]).memos, 0);
check('a warm window is all hits and zero wire', summarizeTrnTrace([parseTrnTraceLine(1, LINE_CACHE_HIT), parseTrnTraceLine(2, LINE_CACHE_HIT)]), { total: 2, fetches: 0, memos: 0, failures: 0, cacheHits: 2, cacheMisses: 0, avgElapsed: 0 });
check('a corrupt entry counts as a miss', summarizeTrnTrace([parseTrnTraceLine(1, LINE_CACHE_CORRUPT)]).cacheMisses, 1);
check('a refused write is neither a hit nor a miss', (() => { const s = summarizeTrnTrace([parseTrnTraceLine(1, LINE_CACHE_REFUSED)]); return [s.cacheHits, s.cacheMisses, s.total]; })(), [0, 0, 1]);
check('fetches filter excludes cache lines', trnFilterMatch(parseTrnTraceLine(20, LINE_CACHE_HIT), 'fetches'), false);
check('cache filter keeps every cache line', ['hit', 'miss', 'write', 'evicted', 'refused'].map((v) => trnFilterMatch(parseTrnTraceLine(1, `[TRN 5] CACHE ${v} path=/api/x`), 'cache')), [true, true, true, true, true]);
check('no-memo filter also hides a cache hit', trnFilterMatch(parseTrnTraceLine(20, LINE_CACHE_HIT), 'nomemo'), false);
check('no-memo filter still shows a cache miss', trnFilterMatch(parseTrnTraceLine(21, LINE_CACHE_MISS), 'nomemo'), true);
check('errors filter sweeps in a refusal and a corrupt entry', [trnFilterMatch(parseTrnTraceLine(25, LINE_CACHE_REFUSED), 'errors'), trnFilterMatch(parseTrnTraceLine(22, LINE_CACHE_CORRUPT), 'errors')], [true, true]);
check('errors filter does NOT sweep in a cold miss', trnFilterMatch(parseTrnTraceLine(21, LINE_CACHE_MISS), 'errors'), false);
check(
  'badges',
  [badgeOf(LINE_FETCH), badgeOf(LINE_MEMO), badgeOf(LINE_OK), badgeOf(LINE_FAIL), badgeOf(LINE_READY), badgeOf('[TRN 1] odd')].join(','),
  'FETCH,MEMO,OK,FAIL,READY,RAW',
);
check(
  'cache badges read the verdict, not just the line',
  [badgeOf(LINE_CACHE_HIT), badgeOf(LINE_CACHE_MISS), badgeOf(LINE_CACHE_REFUSED)].join(','),
  'CACHE,MISS,CACHE!',
);
check(
  'a cache hit and a cache miss are told apart by colour',
  new Set([LINE_CACHE_HIT, LINE_CACHE_MISS, LINE_CACHE_WRITE, LINE_CACHE_REFUSED].map((l) => trnKindBadge(parseTrnTraceLine(1, l)).cls)).size,
  4,
);
check(
  'every badge has its own colour (ok + ready share emerald on purpose)',
  new Set(
    [LINE_FETCH, LINE_MEMO, LINE_OK, LINE_FAIL, LINE_READY, '[TRN 1] odd'].map((l) => trnKindBadge(parseTrnTraceLine(1, l)).cls)
  ).size,
  5,
);
check('an outcome with no readable ok does not claim OK', badgeOf('[TRN 1] outcome status=200 elapsed_ms=5'), 'RAW');

// --- summary: the "is this spamming TRN" answer ---
const recs = [
  parseTrnTraceLine(1, LINE_FETCH),
  parseTrnTraceLine(2, LINE_FETCH),
  parseTrnTraceLine(3, LINE_MEMO),
  parseTrnTraceLine(4, LINE_OK),
  parseTrnTraceLine(5, LINE_FAIL),
  parseTrnTraceLine(6, LINE_READY),
  parseTrnTraceLine(7, '[TRN 1790444233550] RECREATED reason=silent path=/api/x (fresh navigation re-earns clearance)'),
  parseTrnTraceLine(8, LINE_CACHE_HIT),
  parseTrnTraceLine(9, LINE_CACHE_MISS),
];
check(
  'summary counts the whole window',
  summarizeTrnTrace(recs),
  { total: 9, fetches: 2, memos: 1, failures: 1, cacheHits: 1, cacheMisses: 1, avgElapsed: 383 },
);
check(
  'summary of an empty window',
  summarizeTrnTrace([]),
  { total: 0, fetches: 0, memos: 0, failures: 0, cacheHits: 0, cacheMisses: 0, avgElapsed: 0 },
);
check('avg ignores outcomes with no elapsed field', summarizeTrnTrace([parseTrnTraceLine(1, '[TRN 5] outcome ok=true status=200')]).avgElapsed, 0);

// --- filters ---
const kinds = recs.map((r) => trnFilterMatch(r, 'all'));
check('all shows everything', kinds.every(Boolean), true);
check('errors keeps the failed outcome', trnFilterMatch(parseTrnTraceLine(1, LINE_FAIL), 'errors'), true);
check('errors sweeps in unrecognised lines', trnFilterMatch(recs[6], 'errors'), true);
check('errors drops a passing outcome', trnFilterMatch(parseTrnTraceLine(1, LINE_OK), 'errors'), false);
check('fetches is wire traffic only', recs.filter((r) => trnFilterMatch(r, 'fetches')).length, 2);
// 'nomemo' is "hide what cost nothing": the Rust memo and a file-cache hit.
check('no memo hides cache hits only', [trnFilterMatch(parseTrnTraceLine(1, LINE_MEMO), 'nomemo'), trnFilterMatch(parseTrnTraceLine(1, LINE_FETCH), 'nomemo'), trnFilterMatch(parseTrnTraceLine(1, LINE_CACHE_HIT), 'nomemo'), trnFilterMatch(parseTrnTraceLine(1, LINE_CACHE_MISS), 'nomemo')], [false, true, false, true]);
check('the cache filter is the warm-start answer', recs.filter((r) => trnFilterMatch(r, 'cache')).length, 2);

// --- the panel contract: the source keeps newest-last, the cap, the poll ---
const dash = await Bun.file('src/components/DevDashboard.tsx').text();
check('poll interval untouched at 1000ms', dash.includes('const TRN_LOG_POLL_MS = 1000;'), true);
check('ring view cap untouched at 300', dash.includes('const TRN_LOG_VIEW = 300;'), true);
check('newest-last wording kept', dash.includes('newest last'), true);
check('ring-overwrite chip kept', dash.includes('ring overwrote unseen lines'), true);
check('not-registered message kept', dash.includes('add trn_proxy::trn_trace_log to the lib.rs invoke_handler'), true);
check('parse is memoized on the line arrays', dash.includes('[trnLogLines, trnCacheLines]'), true);
// The file cache keeps its own ring (trn_trace! and its ring are private to
// trn_proxy.rs), so the panel polls it separately and merges by timestamp.
check('both rings are polled', dash.includes("'trn_trace_log'") && dash.includes("'trn_cache_trace_log'"), true);
check('the two rings merge on the epoch stamp', dash.includes('.sort((a, b) => a.ms - b.ms)'), true);
check('row keys stay unique across the two rings', dash.includes('l.seq * 2') && dash.includes('l.seq * 2 + 1'), true);
check('the cache ring has its own cursor', dash.includes('trnCacheAfter = useRef(0)'), true);
check('a cache-ring failure cannot take the transport ring down', dash.includes('cache ring unavailable'), true);
check('clear empties both rings', dash.includes('setTrnCacheLines([])'), true);
check('the summary shows cold-vs-warm', dash.includes('{trnLogSummary.cacheHits} cache hit') && dash.includes('{trnLogSummary.cacheMisses} cache miss'), true);
check('no raw dump left behind', !dash.includes('whitespace-pre-wrap break-all">\n                  {l.text}'), true);

// --- export: the dev window can only export what it actually holds ---------
// The old panel read `getRecentLogs` (a module-level ring = one per WebView2
// realm). The dev window is its own realm, so it always exported 0 lines and
// still reported "copied 0 lines to clipboard". These assert the replacement
// exports real trace text, and that "nothing" never reads as success.
check('export uses the trace ring, not the per-realm logger', dash.includes('buildTrnTraceExport(trnLogRows') && !dash.includes('getRecentLogs('), true);
check('empty export short-circuits before claiming success', dash.includes('if (lines.length === 0)') && dash.includes('trnExportReport(0,'), true);
check('export writes a trace-named file', dash.includes('recon-trn-trace-'), true);

const expFetch = formatTrnTraceExport(parseTrnTraceLine(1, LINE_FETCH), 1790444233542);
check('export carries the FULL path, not the short label', expFetch.includes('path=/api/v2/valorant/standard/profile/riot/lil%20ga7ed%23zngr/segments/season?fromIndex=0&toIndex=5') && !expFetch.includes('lil ga7ed#zngr · segments/season'), true);
check('export carries the relative time', expFetch.includes('+4.6s'), true);
check('export carries the absolute time', expFetch.includes('2026-') && expFetch.includes(String(1790444228930)), true);
check('export names the kind', expFetch.includes('FETCH'), true);

const expOk = formatTrnTraceExport(parseTrnTraceLine(1, LINE_OK), 1790444233542);
check('export outcome keeps status + elapsed', expOk.includes('OUTCOME') && expOk.includes('status=200') && expOk.includes('elapsed_ms=662'), true);
const expFail = formatTrnTraceExport(parseTrnTraceLine(1, LINE_FAIL), 1790444233542);
check('export failure keeps status=0', expFail.includes('status=0') && expFail.includes('elapsed_ms=103'), true);
const expReady = formatTrnTraceExport(parseTrnTraceLine(1, LINE_READY), 1790444233542);
check('export keeps a pathless line verbatim', expReady.includes('READY (clearance ok)'), true);
const expUnstamped = formatTrnTraceExport(parseTrnTraceLine(1, 'not a trace line at all'), 0);
check('export marks an unstamped line rather than faking a time', expUnstamped.includes('unstamped') && expUnstamped.includes('not a trace line at all'), true);

const built = buildTrnTraceExport(recs, 3);
check('build takes the NEWEST n, oldest-first', built.length, 3);
check('build keeps source order', built[0], formatTrnTraceExport(recs[recs.length - 3], 1790444233542));
check('build n larger than held returns all', buildTrnTraceExport(recs, 999).length, recs.length);
check('build of nothing is empty, not a placeholder line', buildTrnTraceExport([], 10), []);

check('0 of 0 says there is nothing to export', trnExportReport(0, 0, 'Copied').includes('Nothing to export'), true);
check('0 of N never claims success', trnExportReport(0, 40, 'Copied').includes('Nothing exported'), true);
check('a real count reports plainly', trnExportReport(12, 40, 'Copied'), 'Copied 12 lines to clipboard (of 40 held)');
check('download reports plainly', trnExportReport(1, 1, 'Downloaded'), 'Downloaded 1 line as recon-trn-trace-*.txt');

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All TRN trace log tests passed.');
