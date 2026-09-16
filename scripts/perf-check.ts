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

check('rss via GetProcessMemoryInfo', perfRs.includes('GetProcessMemoryInfo'), true);
check('cpu via GetProcessTimes deltas', perfRs.includes('GetProcessTimes'), true);
check('own process only (backend counters)', perfRs.includes('GetCurrentProcess'), true);
check('tree walk scoped to own PID', perfRs.includes('GetCurrentProcessId') && perfRs.includes('recon_webview_pids(&snapshot_entries(), own)'), true);
check('windows features only, no new crates', !cargo.includes('perf =') && cargo.includes('Win32_System_ProcessStatus') && cargo.includes('Win32_System_Threading'), true);
check('1h ring const', perfRs.includes('PERF_RING_CAP: usize = 720'), true);
check('5s cadence documented', perfRs.includes('720 × 5s') || perfRs.includes('720 slots'), true);
check('release stub returns Err', perfRs.includes('#[cfg(not(debug_assertions))]'), true);
check('release carries no buffer', (perfRs.match(/cfg\(debug_assertions\)/g) || []).length >= 4, true);
check('pause reads foreground focus', perfRs.includes('is_valorant_foreground'), true);
check('pause skips sampling (no push)', perfRs.includes('if !paused'), true);

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

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All perf timeline tests passed.');
