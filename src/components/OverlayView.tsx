/* Overlay window entry point.
 *
 * Split 9/9: the canvas (polling, drag/config state and widget placement) now
 * lives in hud/HudCanvas.tsx, moved verbatim. This file keeps the stable export
 * surface so `OverlayView` and the config helpers import exactly as before.
 */

export { OverlayView } from './hud/HudCanvas';

export {
  DEFAULT_OVERLAY_CONFIG,
  getDefaultOverlayConfig,
  getDefaultOverlayPositions,
} from './hud/overlayConfig';
export type { OverlayConfig, WidgetPos } from './hud/overlayConfig';
