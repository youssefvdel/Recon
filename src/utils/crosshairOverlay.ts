/* Pure shape model for the screen-centred overlay crosshair.
   Dependency-free on purpose so scripts/crosshair-overlay-check.ts can import it
   with plain Bun (no bundler, no DOM). The renderer is the shared `Reticle` in
   components/CrosshairPreview.tsx; this module only sanitises + adapts to it. */

export interface OverlayCrosshairShape {
  core: string; // hex, the bright core colour
  outline: string; // hex, the contrasting outline
  outlineOn: boolean;
  outlineThickness: number; // 0-6
  length: number; // 0-20  arm length
  thickness: number; // 1-10  arm thickness
  gap: number; // 0-20  arm offset from centre
  dotOn: boolean;
  dotSize: number; // 0-6
  opacity: number; // 0-1
}

export const DEFAULT_OVERLAY_CROSSHAIR: OverlayCrosshairShape = {
  core: '#00FF00',
  outline: '#000000',
  outlineOn: true,
  outlineThickness: 2,
  length: 5,
  thickness: 2,
  gap: 3,
  dotOn: false,
  dotSize: 2,
  opacity: 1,
};

const HEX = /^#[0-9a-fA-F]{6}$/;

const num = (v: unknown, lo: number, hi: number, fb: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.min(hi, Math.max(lo, n));
};

const hex = (v: unknown, fb: string): string =>
  typeof v === 'string' && HEX.test(v) ? v : fb;

/** Clamp/coerce a possibly-corrupt persisted shape back into a safe value. */
export function sanitizeCrosshairShape(raw: unknown): OverlayCrosshairShape {
  const d = DEFAULT_OVERLAY_CROSSHAIR;
  const src: Record<string, unknown> =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    core: hex(src.core, d.core),
    outline: hex(src.outline, d.outline),
    outlineOn: !!src.outlineOn,
    outlineThickness: num(src.outlineThickness, 0, 6, d.outlineThickness),
    length: num(src.length, 0, 20, d.length),
    thickness: num(src.thickness, 1, 10, d.thickness),
    gap: num(src.gap, 0, 20, d.gap),
    dotOn: !!src.dotOn,
    dotSize: num(src.dotSize, 0, 6, d.dotSize),
    opacity: num(src.opacity, 0, 1, d.opacity),
  };
}

/** Largest distance from centre to any drawn edge, floored at 1. */
export function crosshairHalfExtent(s: OverlayCrosshairShape): number {
  const oT = s.outlineOn ? s.outlineThickness : 0;
  return Math.max(
    s.gap + s.length + oT,
    s.dotOn ? Math.ceil(s.dotSize / 2) : 0,
    oT,
    1
  );
}

/** `size` is always even so `half` is an integer: keeps the SVG viewBox min on a
    whole pixel (crisp edges) instead of a half-pixel seam. */
export function crosshairBox(s: OverlayCrosshairShape): { size: number; half: number } {
  const half = crosshairHalfExtent(s) + 1;
  return { size: half * 2, half };
}

/** Map the shape onto the field names `Reticle` actually reads (see
    CrosshairPreview.tsx ~lines 60-84). Outer lines off; outline stays opaque. */
export function toReticleSection(s: OverlayCrosshairShape): Record<string, unknown> {
  const hasOutline = s.outlineOn && s.outlineThickness > 0;
  const showDot = s.dotOn && s.dotSize > 0;
  return {
    bHideCrosshair: false,
    bHasOutline: hasOutline,
    outlineThickness: s.outlineThickness,
    outlineOpacity: 1, // a translucent outline defeats the contrast mechanism
    bDisplayCenterDot: showDot,
    centerDotSize: s.dotSize,
    centerDotOpacity: s.opacity,
    innerLines: {
      bShowLines: true,
      lineLength: s.length,
      lineThickness: s.thickness,
      lineOffset: s.gap,
      opacity: s.opacity,
      bAllowVertScaling: false,
      lineLengthVertical: s.length,
    },
    outerLines: { bShowLines: false },
  };
}

export function toReticlePalette(s: OverlayCrosshairShape): { main: string; outline: string } {
  return { main: s.core, outline: s.outline };
}
