import { describe, expect, test } from 'bun:test';
import {
  liveRendererLabel,
  normalizeRendererSetting,
  parseSidecarStatus,
  resolveActiveRenderer,
  sidecarDetail,
  type SidecarStatus,
} from '../src/utils/overlayRenderer.ts';

/* The settings row must never claim a renderer the backend is not running, and
 * an old backend (no `active`) must still mean the same thing the Rust
 * resolver means. Both are pure, so they are pinned here. */

describe('renderer setting normalization', () => {
  test('the three stored values pass through', () => {
    expect(normalizeRendererSetting('ts')).toBe('ts');
    expect(normalizeRendererSetting('native')).toBe('native');
    expect(normalizeRendererSetting('auto')).toBe('auto');
  });

  test('anything else is auto, never a crash or an empty picker', () => {
    for (const raw of [undefined, null, '', 'NATIVE', 'garbage', 3, {}]) {
      expect(normalizeRendererSetting(raw)).toBe('auto');
    }
  });
});

describe('active renderer resolution', () => {
  test('ts ignores health: the user asked for the built-in window', () => {
    expect(resolveActiveRenderer('ts', true)).toBe('ts');
    expect(resolveActiveRenderer('ts', false)).toBe('ts');
  });

  test('native ignores health: explicit choice has no silent fallback', () => {
    expect(resolveActiveRenderer('native', true)).toBe('native');
    expect(resolveActiveRenderer('native', false)).toBe('native');
  });

  test('auto follows health in both directions', () => {
    expect(resolveActiveRenderer('auto', true)).toBe('native');
    expect(resolveActiveRenderer('auto', false)).toBe('ts');
  });
});

describe('sidecar status parsing', () => {
  test('a full backend payload is read verbatim', () => {
    const status = parseSidecarStatus({
      running: true,
      healthy: true,
      setting: 'auto',
      active: 'native',
      binary: true,
    });
    expect(status).toEqual({
      running: true,
      healthy: true,
      setting: 'auto',
      active: 'native',
      binary: true,
    });
  });

  test('the backend verdict wins over the local mirror', () => {
    // Backend says TS even though auto+healthy would mirror to native: the
    // daemons acted on the backend value, so the row must show the same thing.
    const status = parseSidecarStatus({
      running: true,
      healthy: true,
      setting: 'auto',
      active: 'ts',
    });
    expect(status.active).toBe('ts');
    expect(liveRendererLabel(status)).toBe('Built-in overlay');
  });

  test('an old backend without `active` still resolves like Rust', () => {
    expect(parseSidecarStatus({ setting: 'auto', healthy: true }).active).toBe('native');
    expect(parseSidecarStatus({ setting: 'auto', healthy: false }).active).toBe('ts');
    expect(parseSidecarStatus({ setting: 'native' }).active).toBe('native');
    expect(parseSidecarStatus({ setting: 'ts' }).active).toBe('ts');
  });

  test('garbage is the safe state: built-in overlay, nothing claimed', () => {
    for (const raw of [undefined, null, 0, 'nope', []]) {
      const status = parseSidecarStatus(raw);
      expect(status).toEqual({
        running: false,
        healthy: false,
        setting: 'auto',
        active: 'ts',
        binary: null,
      });
    }
  });

  test('binary presence is tri-state, never a guessed boolean', () => {
    expect(parseSidecarStatus({ binary: false }).binary).toBe(false);
    expect(parseSidecarStatus({ binary: true }).binary).toBe(true);
    expect(parseSidecarStatus({}).binary).toBeNull();
    expect(parseSidecarStatus({ binary: 'yes' }).binary).toBeNull();
  });
});

describe('settings row copy', () => {
  const base: SidecarStatus = {
    running: true,
    healthy: true,
    setting: 'auto',
    active: 'native',
    binary: true,
  };

  test('names the renderer that owns the screen', () => {
    expect(liveRendererLabel(base)).toBe('Native overlay');
    expect(liveRendererLabel({ ...base, active: 'ts' })).toBe('Built-in overlay');
  });

  test('a missing binary is said plainly, whatever the setting', () => {
    for (const setting of ['auto', 'native', 'ts'] as const) {
      expect(sidecarDetail({ ...base, binary: false, setting })).toBe(
        'Native overlay app is not installed.'
      );
    }
  });

  test('native renders no HUD while its app is down, and says so', () => {
    expect(
      sidecarDetail({ ...base, setting: 'native', running: false, healthy: false })
    ).toBe('Native overlay is selected, but its app is not running.');
  });

  test('auto explains the fallback instead of the choice', () => {
    expect(
      sidecarDetail({ ...base, active: 'ts', running: false, healthy: false })
    ).toBe('Native overlay app is not running — using the built-in overlay.');
    expect(sidecarDetail({ ...base, active: 'ts', running: true })).toBe(
      'Native overlay app is restarting.'
    );
  });

  test('ts states the user choice, not a failure', () => {
    expect(sidecarDetail({ ...base, setting: 'ts', active: 'ts', running: false })).toBe(
      'Built-in overlay is selected.'
    );
  });
});
