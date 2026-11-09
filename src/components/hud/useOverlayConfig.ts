import { useState } from 'react';
import {
  DEFAULT_OVERLAY_CONFIG,
  getDefaultOverlayPositions,
  overlayBoundsKey,
  persistOverlayConfig,
  pruneLayouts,
  type OverlayConfig,
} from './overlayConfig';
import { sanitizeCrosshairShape } from '../../utils/crosshairOverlay';

export interface OverlayConfigControls {
  config: OverlayConfig;
  setConfig: React.Dispatch<React.SetStateAction<OverlayConfig>>;
  saveConfig: (next: OverlayConfig) => void;
}

/* Persisted widget config: state initializer and the save path. Moved verbatim
 * from HudCanvas (canvas split 3/3); the per-display reconcile stays in the
 * canvas because it needs the widget refs. */

export function useOverlayConfig(): OverlayConfigControls {
  // Widget config + positions (persisted)
  const [config, setConfig] = useState<OverlayConfig>(() => {
    const MIGRATION_KEY = 'recon_overlay_cfg_v8_defaults';
    const mergeSaved = (saved: string | null) => {
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      return {
        ...DEFAULT_OVERLAY_CONFIG,
        ...parsed,
        positions: { ...DEFAULT_OVERLAY_CONFIG.positions, ...(parsed.positions || {}) },
        scales: { ...DEFAULT_OVERLAY_CONFIG.scales, ...(parsed.scales || {}) },
        // `...parsed` spreads a stored crosshair blindly; complete + clamp it.
        crosshair: sanitizeCrosshairShape(parsed.crosshair),
        // Per-display layouts are user data: never trust the stored shape.
        layouts:
          parsed.layouts && typeof parsed.layouts === 'object' && !Array.isArray(parsed.layouts)
            ? (parsed.layouts as OverlayConfig['layouts'])
            : {},
      } as OverlayConfig;
    };
    try {
      // Read the saved layout FIRST: writing defaults before reading (as an
      // earlier revision did) wipes custom widget positions/scales.
      const saved = localStorage.getItem('recon_overlay_cfg_v7') || localStorage.getItem('recon_overlay_cfg_v6') || localStorage.getItem('recon_overlay_cfg_v5');
      if (!localStorage.getItem(MIGRATION_KEY)) {
        localStorage.setItem(MIGRATION_KEY, '1');
        const merged = mergeSaved(saved);
        // Pre-pick badge moved to the top-left edge after it shipped once, and
        // its old spot (mid-left) reads as a stray panel. Nudge only that key.
        if (merged) {
          merged.positions = {
            ...merged.positions,
            prepick: getDefaultOverlayPositions().prepick,
          };
        }
        localStorage.setItem('recon_overlay_cfg_v7', JSON.stringify(merged ?? DEFAULT_OVERLAY_CONFIG));
        return merged ?? DEFAULT_OVERLAY_CONFIG;
      }
      const merged = mergeSaved(saved);
      if (merged) {
        // One-time widget parity: a config written before a widget existed (or
        // one that inherited an older OFF default) silently hides it, which the
        // user reads as "my friend doesn't have that widget". Turn the two
        // advisory widgets on ONCE, then let the persisted value rule — the
        // marker is separate so hand-placed positions are never touched.
        const PARITY_KEY = 'recon_overlay_widget_parity_v1';
        if (!localStorage.getItem(PARITY_KEY)) {
          localStorage.setItem(PARITY_KEY, '1');
          const next: OverlayConfig = { ...merged, showTopAgents: true, showPrepick: true };
          localStorage.setItem('recon_overlay_cfg_v7', JSON.stringify(next));
          return next;
        }
        return merged;
      }
    } catch {}
    return DEFAULT_OVERLAY_CONFIG;
  });

  const saveConfig = (next: OverlayConfig) => {
    // Mirror the live offsets into this display's slot on every write, so a
    // later resize/monitor swap can restore exactly what was placed here.
    const merged: OverlayConfig = {
      ...next,
      layouts: {
        ...pruneLayouts(next.layouts),
        [overlayBoundsKey()]: next.positions,
      },
    };
    setConfig(merged);
    persistOverlayConfig(merged);
  };

  return { config, setConfig, saveConfig };
}
