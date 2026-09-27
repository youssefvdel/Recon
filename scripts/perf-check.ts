// Unit tests for the dev-only resource timeline: frontend math
// (src/utils/perf.ts) + Rust/TS contract shapes (perf.rs, DevDashboard).
//
//   bun scripts/perf-check.ts
export {};

const { summarizePerf, sparklinePoints, PERF_POLL_MS, PERF_RING_CAP } = await import(
  '../src/utils/perf.ts'
);

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

// --- contract consts: 5s cadence, 720 slots = 1h ring (mirrors perf.rs) ---
check('poll cadence 5s', PERF_POLL_MS, 5000);
check('ring cap 720 (1h)', PERF_RING_CAP, 720);
check('cap × cadence = 3600s', (PERF_RING_CAP * PERF_POLL_MS) / 1000, 3600);

// --- summarizePerf: current/min/max/avg ---
check('summarize empty → zeros', summarizePerf([]), { current: 0, min: 0, max: 0, avg: 0 });
check('summarize single', summarizePerf([42]), { current: 42, min: 42, max: 42, avg: 42 });
check('summarize multi', summarizePerf([10, 20, 30]), { current: 30, min: 10, max: 30, avg: 20 });

// --- summarizePerf over a mocked timeline (ring-shape input) ---
const mock: import('../src/utils/perf.ts').PerfTimeline = {
  samples: [
    { t: 1, rss_mb: 200, webview_mb: 50, total_mb: 250, cpu_pct: 2 },
    { t: 2, rss_mb: 210, webview_mb: 60, total_mb: 270, cpu_pct: 8 },
    { t: 3, rss_mb: 205, webview_mb: 55, total_mb: 260, cpu_pct: 5 },
  ],
  paused: false,
  rss: { current: 0, min: 0, max: 0, avg: 0 },
  webview: { current: 0, min: 0, max: 0, avg: 0 },
  total: { current: 0, min: 0, max: 0, avg: 0 },
  cpu: { current: 0, min: 0, max: 0, avg: 0 },
};
check('mock rss stats', summarizePerf(mock.samples.map((s) => s.rss_mb)), {
  current: 205,
  min: 200,
  max: 210,
  avg: 205,
});
check('mock webview stats', summarizePerf(mock.samples.map((s) => s.webview_mb)), {
  current: 55,
  min: 50,
  max: 60,
  avg: 55,
});
check('mock total stats', summarizePerf(mock.samples.map((s) => s.total_mb)), {
  current: 260,
  min: 250,
  max: 270,
  avg: 260,
});
check(
  'total = backend + webviews per sample',
  mock.samples.every((s) => s.total_mb === s.rss_mb + s.webview_mb),
  true
);
check('mock cpu stats', summarizePerf(mock.samples.map((s) => s.cpu_pct)), {
  current: 5,
  min: 2,
  max: 8,
  avg: 5,
});

// --- sparklinePoints: SVG polyline math, no chart lib ---
check('sparkline empty → blank', sparklinePoints([], 300, 48), '');
check('sparkline single', sparklinePoints([7], 300, 48), '2.0,46.0');
check('sparkline ramp min-bottom max-top', sparklinePoints([0, 10], 300, 48), '2.0,46.0 298.0,2.0');
check(
  'sparkline flat sits level (no div-by-zero)',
  sparklinePoints([5, 5, 5], 300, 48),
  '2.0,46.0 150.0,46.0 298.0,46.0'
);
check(
  'sparkline shared domain (stacked series compare 1:1)',
  sparklinePoints([5, 15], 300, 48, 2, [0, 20]),
  '2.0,35.0 298.0,13.0'
);

// --- Rust shapes (source text): own-process counters, zero new deps ---
const perfRs = await Bun.file('src-tauri/src/perf.rs').text();
const cargo = await Bun.file('src-tauri/Cargo.toml').text();
const libRs = await Bun.file('src-tauri/src/lib.rs').text();
const dashboard = await Bun.file('src/components/DevDashboard.tsx').text();

// --- the metric itself: private working set = Task Manager's Memory column ---
check('rss via GetProcessMemoryInfo', perfRs.includes('GetProcessMemoryInfo'), true);
check(
  'fallback reads WorkingSetSize (resident), never PrivateUsage (commit)',
  perfRs.includes('counters.WorkingSetSize as u64') && !perfRs.includes('counters.PrivateUsage as u64'),
  true,
);
check('private working set from the PDH counter Task Manager uses', perfRs.includes('Working Set - Private') && perfRs.includes('fn private_ws_by_pid'), true);
check('PDH pids paired by instance index with a name guard', perfRs.includes('\\Process(*)\\ID Process') && perfRs.includes('pname != iname'), true);
check('pdh.dll linked directly, no new crate', perfRs.includes('#[link(name = "pdh")]') && !cargo.includes('Win32_Performance') && !cargo.includes('pdh ='), true);
check('no Wdk/extra feature needed for NtQueryInformationProcess', !cargo.includes('Wdk'), true);
check('metric arithmetic is unit-tested', perfRs.includes('pub fn rss_mb_from_bytes') && perfRs.includes('fn bytes_to_mib_at_task_manager_scale'), true);

// --- the dead per-page route is recorded so it is not re-attempted ---
check('QueryWorkingSetEx dead end documented in rust', perfRs.includes('QueryWorkingSetEx') && perfRs.includes('DEAD END'), true);
check('dead-end claim is the measured one', perfRs.includes('STATUS_INFO_LENGTH_MISMATCH') && perfRs.includes('writes NOTHING'), true);

// --- cost control: the PDH pass must not ride the 5s poll path ---
check('private pass has its own cadence const', perfRs.includes('const PRIV_WS_MIN_INTERVAL: std::time::Duration'), true);
check('cadence const is justified in a comment', /22 ms[\s\S]{0,200}5s\s+[\s\S]{0,200}poll path[\s\S]{0,400}const PRIV_WS_MIN_INTERVAL/.test(perfRs), true);
check('cheap resident pass still runs every poll', perfRs.includes('fn resident_tree_mem') && perfRs.includes('fn sample_tree_mem'), true);
check('PDH buffer allocated once, grow-only', perfRs.includes('static PDH_BUF: Mutex<Vec<u8>>') && perfRs.includes('buf.resize(want, 0)') && perfRs.includes('buf[..want].fill(0)'), true);
check('unreadable counter degrades, never reports zero bytes', perfRs.includes('fn try_private_ws_all') && perfRs.includes('cache.last.unwrap_or(resident)'), true);

// --- honest basis reporting: a wrong number must never be shown as a right one ---
check('basis enum serialized per sample', perfRs.includes('pub basis: MemBasis') && perfRs.includes('pub omitted: u32'), true);
check('basis names all three states', perfRs.includes('PrivateWorkingSet') && perfRs.includes('ResidentWorkingSet') && perfRs.includes('Mixed'), true);
check('rollup is a pure injectable fn', perfRs.includes('pub fn rollup(own: ProcMem, webviews: &[ProcMem])'), true);
check('fallback is explicit, never a silent zero', perfRs.includes('fn fallback_is_explicit_never_silent_zero') && perfRs.includes('fn mem_basis_derivation'), true);
check('unreadable processes are counted, not swallowed', perfRs.includes('ProcMem::Unavailable') && perfRs.includes('pub omitted: u32'), true);
check('per-process basis choice is one small helper', perfRs.includes('fn mem_for_pid'), true);

// --- cpu via GetProcessTimes deltas, over the WHOLE tree (not the backend) ---
check('cpu via GetProcessTimes deltas', perfRs.includes('GetProcessTimes'), true);
check(
  'cpu covers the tree, not the backend handle alone',
  perfRs.includes('fn cpu_tree_times') && perfRs.includes('fn cpu_100ns_of_pid') && !perfRs.includes('GetCurrentProcess()'),
  true,
);
check(
  'per-process times are summed, never averaged',
  perfRs.includes('fn cpu_covers_the_same_set_as_memory') && perfRs.includes('fn rollup_cpu'),
  true,
);
check(
  'unreadable processes counted, not zeroed',
  perfRs.includes('cpu_omitted: u32') && perfRs.includes('pub omitted: u32') && perfRs.includes('fn cpu_unreadable_is_counted_not_zeroed'),
  true,
);
check(
  'process churn cannot wrap the delta',
  perfRs.includes('fn cpu_delta_100ns') && perfRs.includes('saturating_add(cur.saturating_sub(*before))') && perfRs.includes('fn cpu_delta_ignores_processes_without_a_baseline'),
  true,
);
check(
  'one tree walk feeds both metrics',
  perfRs.includes('let webviews = recon_webview_pids(&snapshot_entries(), own);') && perfRs.includes('let (cpu_times, census) = cpu_tree_times(own, &webviews);') && perfRs.includes('sample_tree_mem(own, &webviews)'),
  true,
);
check('tree walk scoped to own PID', perfRs.includes('GetCurrentProcessId') && perfRs.includes('recon_webview_pids(&snapshot_entries(), own)'), true);
check('windows features only, no new crates', !cargo.includes('perf =') && cargo.includes('Win32_System_ProcessStatus') && cargo.includes('Win32_System_Threading'), true);
check('1h ring const', perfRs.includes('PERF_RING_CAP: usize = 720'), true);
check('5s cadence documented', perfRs.includes('720 × 5s') || perfRs.includes('720 slots'), true);
check('release stub returns Err', perfRs.includes('#[cfg(not(debug_assertions))]'), true);
check('release carries no buffer', (perfRs.match(/cfg\(debug_assertions\)/g) || []).length >= 4, true);
check('pause reads foreground focus', perfRs.includes('is_valorant_foreground'), true);
check('pause skips sampling (no push)', perfRs.includes('if !paused'), true);

// --- the CPU panel must NAME what it measures, like the memory one does ---
check('names the CPU metric', dashboard.includes('CPU %'), true);
check('cpu chart label carries its census', dashboard.includes('CPU % (${perfCpuBasisLabel})'), true);
check('says the same tree as memory', dashboard.includes('every msedgewebview2.exe child') && dashboard.includes('backend plus every'), true);
check('says summed, not averaged', dashboard.includes('kernel+user time summed') && dashboard.includes('not averaged'), true);
check('states the normalisation', dashboard.includes('share of all cores') && dashboard.includes('directly comparable'), true);
check('names the residual difference honestly', dashboard.includes('averaging window'), true);
check('records what the metric used to be', dashboard.includes('backend handle alone'), true);
// The copy wraps across JSX lines, so assert the halves rather than a span
// that no longer exists in the file.
check('the "used to be" claim names the measured gap', dashboard.includes('~0.1% here and ~10% in Task'), true);
check('cpu unreadable gap is surfaced', perfRs.includes('cpu_omitted: u32') && dashboard.includes('cpu_omitted?: number') && dashboard.includes('could not be read, so this percentage is LOW'), true);

// --- full footprint: own WebView2 tree only, never system-wide ---
check('tree walk via Toolhelp32Snapshot', perfRs.includes('CreateToolhelp32Snapshot'), true);
check('ToolHelp feature, no new crates', cargo.includes('Win32_System_Diagnostics_ToolHelp') && !cargo.includes('sysinfo') && !cargo.includes('heim'), true);
check('webview allowlist fn', perfRs.includes('pub fn is_recon_webview'), true);
check('allowlist is exactly msedgewebview2.exe', perfRs.includes('eq_ignore_ascii_case("msedgewebview2.exe")'), true);
check('foreign browsers covered as negatives', perfRs.includes('fn webview_exe_allowlist'), true);
check('tree attribution fn (mock-tested)', perfRs.includes('pub fn recon_webview_pids'), true);
check('three sample series', perfRs.includes('pub webview_mb') && perfRs.includes('pub total_mb'), true);
check('three timeline stats', perfRs.includes('pub webview: PerfStats') && perfRs.includes('pub total: PerfStats'), true);

// --- frontend shapes: dev-gated poll, SVG sparklines, readouts ---
check('command registered', libRs.includes('perf::perf_poll'), true);
check('mod registered', libRs.includes('mod perf;'), true);
check('dashboard polls dev-gated', dashboard.includes('if (!import.meta.env.DEV) return;'), true);
check('dashboard uses shared cadence', dashboard.includes('PERF_POLL_MS'), true);
check('dashboard shows ring window', dashboard.includes('PERF_RING_CAP'), true);
check('svg sparkline, no chart lib', dashboard.includes('PerfChart') && dashboard.includes('<polyline') && !dashboard.includes('recharts') && !dashboard.includes('chart.js'), true);
check('total series prominent', dashboard.includes('MEM total') && dashboard.includes('#34d399'), true);
check('backend + views overlay lines', dashboard.includes('overlay={') && dashboard.includes('webview_mb') && dashboard.includes('total_mb'), true);
check('shared y-domain (1:1 compare)', dashboard.includes('domain={perfMemDom}'), true);
check('series color key', dashboard.includes('legend={'), true);
check('paused readout', dashboard.includes('paused (game fullscreen)'), true);
check('min/max/avg readouts', dashboard.includes('min {') && dashboard.includes('max {') && dashboard.includes('avg {'), true);

// --- honest labelling: the total is private working set (Task Manager's Memory)
// summed over the whole tree. If PDH cannot be read the dashboard must say it
// fell back, and must never present the fallback as a private total. Regressing
// these strings is exactly how the 750-vs-105 confusion comes back.
check('names the metric (private working set)', dashboard.includes('private working set'), true);
check('no longer labels the metric as commit', !dashboard.includes('MEM total (private commit)') && !dashboard.includes("'total (private commit)'"), true);
check('records what the metric used to be', dashboard.includes('used to be private commit'), true);
check('says it sums the whole webview tree', dashboard.includes('every WebView2 process in our own tree'), true);
check('spells out what the tree covers', dashboard.includes('browser') && dashboard.includes('GPU') && dashboard.includes('crashpad') && dashboard.includes('utility services'), true);
check('distinguishes resident from commit', dashboard.includes('pagefile commit'), true);
check('stale 880-vs-179 claim is gone', !dashboard.includes('880 MiB'), true);
check('names the fallback basis when degraded', dashboard.includes('full working set') && dashboard.includes('Degraded'), true);
check('degraded marker is a visible banner', dashboard.includes('border-amber-400/40'), true);
check('says the fallback over-counts shared pages', dashboard.includes('reads HIGH'), true);
check('compares against Task Manager by name', dashboard.includes('Task Manager'), true);
check('surfaces omitted process count', dashboard.includes('omitted ${perfOmitted}'), true);
check('chart label carries the live basis', dashboard.includes('MEM total (${perfBasisLabel})'), true);
check('legend carries the live basis', dashboard.includes('total (${perfBasisLabel})'), true);
check('rust doc does not claim Task Manager parity', !perfRs.includes('matches Task Manager'), true);
check('rust doc does not call the tree renderers-only', !perfRs.includes('own WebView2 renderers private bytes'), true);
check('scope test pins helpers + foreign exclusion', perfRs.includes('fn tree_counts_helpers_not_just_renderers'), true);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All perf timeline tests passed.');
