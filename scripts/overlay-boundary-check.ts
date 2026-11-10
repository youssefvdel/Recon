// Guards the HUD boundary: `src-tauri/src/win/` owns the overlay's LIFECYCLE only.
//
// Style, hit-test and placement work belongs to `window_manager::overlay_window`.
// Two files claiming "the HUD" is how a fix lands in the wrong one and strands
// clicks, so this fails if a Win32 style/placement token reappears under `win/`.
//
//   bun scripts/overlay-boundary-check.ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WIN_DIR = 'src-tauri/src/win';

const fail = (msg: string): never => {
  console.error('OVERLAY_BOUNDARY_FAIL: ' + msg);
  process.exit(1);
};

/** Win32 window-style / placement tokens that may only exist outside `win/`. */
const FORBIDDEN = [
  'SetWindowPos',
  'SetWindowLongPtrW',
  'GetWindowLongPtrW',
  'DwmSetWindowAttribute',
  'MonitorFromWindow',
  'GetMonitorInfoW',
  'HWND_TOPMOST',
  'HTTRANSPARENT',
  'WS_EX_',
  'WS_POPUP',
  'WS_OVERLAPPEDWINDOW',
  'WS_CAPTION',
  'WS_THICKFRAME',
  'SWP_',
  '0x80000000', // WS_POPUP bit
  '0x08000000', // WS_EX_NOACTIVATE bit
  '0x00080000', // WS_EX_LAYERED bit
  '0x00000020', // WS_EX_TRANSPARENT bit
];

const files = readdirSync(WIN_DIR)
  .filter((f) => f.endsWith('.rs'))
  .map((f) => join(WIN_DIR, f));

if (files.length === 0) fail(`no Rust files found under ${WIN_DIR}`);

const violations: string[] = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // Comments explain the boundary; only code lines are checked.
    const code = line.replace(/\/\/.*$/, '');
    for (const token of FORBIDDEN) {
      if (code.includes(token)) violations.push(`${file}:${i + 1}  ${token}`);
    }
  });
}

if (violations.length > 0) {
  fail(
    'window style/placement code found under win/ — it belongs in\n' +
      '  src-tauri/src/window_manager/overlay_window.rs\n\n' +
      violations.join('\n'),
  );
}

// The lifecycle file must actually delegate; a header that says "delegates"
// while calling nothing would pass the grep and still be the old lie.
const lifecycle = readFileSync(join(WIN_DIR, 'overlay.rs'), 'utf8');
const delegations = lifecycle.match(/window_manager::[a-z_]+/g) ?? [];
if (delegations.length < 5) {
  fail(
    `win/overlay.rs delegates only ${delegations.length} calls to window_manager:: — ` +
      'style/placement work is expected to live there, not be re-implemented here',
  );
}

console.log(
  `OVERLAY_BOUNDARY_OK: ${files.length} files under win/, ${delegations.length} window_manager delegations, 0 style/placement tokens`,
);
