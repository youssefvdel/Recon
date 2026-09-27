// Install guard: an update must never install over a live match or a visible
// overlay. On Windows install exits the app, so installing mid-match would
// drop the match. The live-phase scenarios run in fresh child processes
// because peekLiveMatchState latches the first non-idle state in module
// memory, so one process can only observe one phase.
//
//   bun scripts/update-guard-check.ts
export {};

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

// Bun has no localStorage; tracker.ts and the predicate both guard on its
// absence, so the shim must exist before the dynamic import runs.
function shimLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  return store;
}

function liveState(phase: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase,
    matchId: 'm1',
    mapId: 'map',
    mapName: 'Map',
    mode: 'Competitive',
    isDeathmatch: false,
    blueTeam: [],
    redTeam: [],
    updatedAt: Date.now(),
    ...extra,
  });
}

const phase = process.argv.includes('--pregame') ? 'pregame' : process.argv.includes('--coregame') ? 'coregame' : '';

if (phase) {
  // Child scenario: a live lobby must block the install with the match reason.
  const store = shimLocalStorage();
  store.set('recon_preview_live_match', liveState(phase));
  const { isSafeToInstallUpdate, getInstallBlocker } = await import('../src/utils/updater.ts');
  check(`${phase} blocks install`, await isSafeToInstallUpdate(), false);
  const reason = await getInstallBlocker();
  check(`${phase} reports the match reason`, reason?.includes('A match is live') ?? false, true);
  process.exit(failures ? 1 : 0);
}

const { isSafeToInstallUpdate, getInstallBlocker } = await import('../src/utils/updater.ts');

// No lobby, overlay hidden (off-Tauri isOverlayVisible returns false) = safe.
check('idle + no overlay is safe', await isSafeToInstallUpdate(), true);
check('idle returns no blocker', await getInstallBlocker(), null);

// The last match stays in the cache briefly; it is not a blocker.
const store = shimLocalStorage();
store.set('recon_preview_live_match', liveState('coregame', { isPreviousMatch: true }));
check('previous match is not a blocker', await isSafeToInstallUpdate(), true);

// Overlay visibility is IPC-backed and cannot be faked off-Tauri, so assert
// the predicate consults it and fails closed when it cannot read the state.
const src = await Bun.file('src/utils/updater.ts').text();
check('overlay visibility is consulted', src.includes('await isOverlayVisible()'), true);
check('unreadable overlay state blocks install', src.includes('Could not verify the match/overlay state'), true);

for (const scenario of ['coregame', 'pregame']) {
  const proc = Bun.spawnSync([process.execPath, import.meta.path, `--${scenario}`], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    console.error(new TextDecoder().decode(proc.stderr));
  }
  check(`${scenario} child scenario passes`, proc.exitCode, 0);
}

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All update install-guard tests passed.');
