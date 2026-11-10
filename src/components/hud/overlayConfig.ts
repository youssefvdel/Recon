import { DEFAULT_OVERLAY_CROSSHAIR, type OverlayCrosshairShape } from '../../utils/crosshairOverlay';

/* Overlay widget config: defaults, per-display layout keys, clamps, persistence.
 * Moved verbatim out of OverlayView (split 2/8). No behaviour change. */

export interface WidgetPos {
  x: number;
  y: number;
}

export interface OverlayConfig {
  showLobby: boolean;
  showPregame: boolean;
  showTopAgents: boolean;
  showStartingSide?: boolean;
  /** Lobby-only pre-pick reminder badge. Self-hides unless the Pre-Picker is armed. */
  showPrepick?: boolean;
  /** Pre-round information plate (agent select / round start). */
  showPreRound?: boolean;
  /** Screen-centred overlay crosshair. Opt-in; in-match only. */
  showCrosshair?: boolean;
  crosshair?: OverlayCrosshairShape;
  positions: {
    lobby: WidgetPos;
    pregame: WidgetPos;
    topAgents: WidgetPos;
    prepick?: WidgetPos;
    /** Pre-round plate: agent select and round start. */
    preRound?: WidgetPos;
  };
  scales: {
    lobby: number;
    pregame: number;
    topAgents: number;
    prepick?: number;
    preRound?: number;
  };
  /**
   * Widget offsets are CSS px, which depend on the display they were authored
   * on (bounds + DPI scale). One layout per bounds key so a laptop panel and a
   * 1440p monitor each keep their own HUD. Key: see `overlayBoundsKey()`.
   */
  layouts?: Record<string, OverlayConfig['positions']>;
}

export function getDefaultOverlayPositions(): OverlayConfig['positions'] {
  const w = typeof window !== 'undefined' ? window.innerWidth : 2088;
  const h = typeof window !== 'undefined' ? window.innerHeight : 1440;

  // Exact coordinates requested:
  // Agent Select (pregame): X: 767, Y: 447
  // Match Status (lobby): X: 22, Y: 654
  // Top Agents (topAgents): X: 1691, Y: 836
  if (w <= 2088 || (w >= 2080 && w <= 2090)) {
    return {
      lobby: { x: 22, y: 654 },
      pregame: { x: 767, y: 447 },
      topAgents: { x: 1691, y: 836 },
      prepick: { x: 10, y: 10 },
      preRound: { x: 24, y: 300 },
    };
  }

  return {
    lobby: {
      x: Math.max(16, Math.round(w * (22 / 2088))),
      y: Math.max(40, Math.round(h * (654 / 1440))),
    },
    pregame: {
      x: Math.max(20, Math.round(w * (767 / 2088))),
      y: Math.max(40, Math.round(h * (447 / 1440))),
    },
    topAgents: {
      x: Math.max(20, Math.round(w * (1691 / 2088))),
      y: Math.max(40, Math.round(h * (836 / 1440))),
    },
    prepick: {
      x: 10,
      y: 10,
    },
  };
}

export function getDefaultOverlayConfig(): OverlayConfig {
  return {
    showLobby: true,
    showPregame: true,
    showTopAgents: true,
    showStartingSide: true,
    showPrepick: true,
    showPreRound: true,
    // Opt-in only: existing users must not suddenly get a second crosshair
    // drawn over their native one.
    showCrosshair: false,
    crosshair: DEFAULT_OVERLAY_CROSSHAIR,
    positions: getDefaultOverlayPositions(),
    scales: {
      lobby: 1.0,
      pregame: 1.0,
      topAgents: 1.0,
      prepick: 1.0,
      preRound: 1.0,
    },
    layouts: {},
  };
}

export const DEFAULT_OVERLAY_CONFIG: OverlayConfig = getDefaultOverlayConfig();

const OVERLAY_CONFIG_STORAGE_KEY = 'recon_overlay_cfg_v7';

/** Display identity a widget layout was authored on: CSS bounds + DPI scale. */
export function overlayBoundsKey(): string {
  if (typeof window === 'undefined') return '0x0@1';
  const dpr = Math.round(window.devicePixelRatio * 100) / 100;
  return `${Math.round(window.innerWidth)}x${Math.round(window.innerHeight)}@${dpr}`;
}

/** Keep a widget box fully inside the current display bounds. */
export function clampWidgetPos(
  pos: WidgetPos,
  bounds: { w: number; h: number },
  box: { w: number; h: number }
): WidgetPos {
  // A widget larger than the screen pins to the top-left instead of going
  // negative; 24 px is the floor for "the resize handle stays reachable".
  const maxX = Math.max(0, bounds.w - Math.max(24, Math.min(Math.round(box.w), bounds.w)));
  const maxY = Math.max(0, bounds.h - Math.max(24, Math.min(Math.round(box.h), bounds.h)));
  return {
    x: Math.max(0, Math.min(Math.round(pos.x), maxX)),
    y: Math.max(0, Math.min(Math.round(pos.y), maxY)),
  };
}

/** Cap the per-display layout map so a long-lived install cannot grow forever. */
export function pruneLayouts(
  layouts?: Record<string, OverlayConfig['positions']>
): Record<string, OverlayConfig['positions']> {
  if (!layouts) return {};
  const keys = Object.keys(layouts);
  if (keys.length <= 6) return layouts;
  const kept: Record<string, OverlayConfig['positions']> = {};
  for (const k of keys.slice(-6)) kept[k] = layouts[k];
  return kept;
}

export function samePositions(a: OverlayConfig['positions'], b: OverlayConfig['positions']): boolean {
  return (
    a.lobby.x === b.lobby.x &&
    a.lobby.y === b.lobby.y &&
    a.pregame.x === b.pregame.x &&
    a.pregame.y === b.pregame.y &&
    a.topAgents.x === b.topAgents.x &&
    a.topAgents.y === b.topAgents.y &&
    (a.prepick?.x ?? 0) === (b.prepick?.x ?? 0) &&
    (a.prepick?.y ?? 0) === (b.prepick?.y ?? 0)
  );
}

export function persistOverlayConfig(next: OverlayConfig): void {
  try {
    localStorage.setItem(OVERLAY_CONFIG_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* Storage full or blocked: the in-memory config still applies this run. */
  }
}
