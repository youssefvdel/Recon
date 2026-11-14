/**
 * HUD renderer state for the settings UI.
 *
 * Two renderers ship in this build: the built-in Tauri overlay window (`ts`)
 * and the native Slint sidecar (`native`). The backend owns the verdict — this
 * module only normalizes its payload and words it for the settings row, so the
 * UI can never claim a renderer the backend is not running. The resolver below
 * mirrors `src-tauri/src/overlay_renderer.rs`; the backend value wins whenever
 * it is present.
 */

export type OverlayRendererSetting = 'ts' | 'native' | 'auto';
export type ActiveOverlayRenderer = 'ts' | 'native';

export interface SidecarStatus {
  /** The native process is alive right now. */
  running: boolean;
  /** Last health probe passed AND the process is alive. */
  healthy: boolean;
  /** Persisted preference. */
  setting: OverlayRendererSetting;
  /** The renderer that owns the screen right now (what the backend reads). */
  active: ActiveOverlayRenderer;
  /** false = sidecar binary absent; null = not probed yet (renderer is `ts`). */
  binary: boolean | null;
}

export const RENDERER_CHOICES: ReadonlyArray<{
  value: OverlayRendererSetting;
  label: string;
  hint: string;
}> = [
  { value: 'auto', label: 'Auto', hint: 'Native when it works, built-in otherwise.' },
  { value: 'native', label: 'Native', hint: 'Native window only. No built-in fallback.' },
  { value: 'ts', label: 'Built-in', hint: 'Built-in window only. Native never starts.' },
];

export function normalizeRendererSetting(raw: unknown): OverlayRendererSetting {
  return raw === 'ts' || raw === 'native' || raw === 'auto' ? raw : 'auto';
}

/** Mirror of the backend resolver; used only when `active` is missing. */
export function resolveActiveRenderer(
  setting: OverlayRendererSetting,
  sidecarHealthy: boolean
): ActiveOverlayRenderer {
  if (setting === 'ts') return 'ts';
  if (setting === 'native') return 'native';
  return sidecarHealthy ? 'native' : 'ts';
}

export function parseSidecarStatus(raw: unknown): SidecarStatus {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const setting = normalizeRendererSetting(o.setting);
  const healthy = o.healthy === true;
  const active: ActiveOverlayRenderer =
    o.active === 'ts' || o.active === 'native'
      ? o.active
      : resolveActiveRenderer(setting, healthy);
  return {
    running: o.running === true,
    healthy,
    setting,
    active,
    binary: o.binary === true ? true : o.binary === false ? false : null,
  };
}

/** The one line the settings row shows: which renderer is actually live. */
export function liveRendererLabel(status: SidecarStatus): string {
  return status.active === 'native' ? 'Native overlay' : 'Built-in overlay';
}

/** Plain-language reason for the state, never a claim the backend did not make. */
export function sidecarDetail(status: SidecarStatus): string {
  if (status.binary === false) {
    return 'Native overlay app is not installed.';
  }
  if (status.active === 'native') {
    return status.running
      ? 'Native overlay app is running.'
      : 'Native overlay is selected, but its app is not running.';
  }
  if (status.setting === 'auto') {
    return status.running
      ? 'Native overlay app is restarting.'
      : 'Native overlay app is not running — using the built-in overlay.';
  }
  return 'Built-in overlay is selected.';
}
