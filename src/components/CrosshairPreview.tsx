import React, { useId } from 'react';

/* ------------------------------------------------------------------ */
/* 1:1 Pixel Crosshair Engine — Valorant marks are raw screen pixels: */
/* - Dot is an exact D×D pixel square                                 */
/* - Lines are exact T×L pixel rectangles                             */
/* - Line offset G is exact integer pixel gap                         */
/* - Outlines are O-pixel border plates behind each mark              */
/* - 1 unit = EXACTLY 1 SCREEN PIXEL (no resolution or SVG scaling)   */
/* - PreviewBanner mirrors Valorant in-game: compact horizontal strip */
/*   with PRIMARY, AIM DOWN SIGHTS, and SNIPER SCOPE columns.         */
/* ------------------------------------------------------------------ */

export interface PreviewPalette {
  main: string;
  outline: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const num = (v: any, fb: number): number =>
  Number.isFinite(Number(v)) ? Number(v) : fb;

/** Snap to whole game pixels — the game has no fractional pixels. */
const gpx = (v: number): number => Math.max(0, Math.round(v));

const WallBackdrop: React.FC<{ id: string }> = ({ id }) => (
  <>
    <defs>
      <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#2b3145" />
        <stop offset="68%" stopColor="#1c2133" />
        <stop offset="68.5%" stopColor="#121627" />
        <stop offset="100%" stopColor="#0b0e19" />
      </linearGradient>
      <pattern id={`${id}-brick`} width="32" height="16" patternUnits="userSpaceOnUse">
        <path
          d="M0 0.5H32 M0 8.5H32 M0 15.5H32 M16 0.5V8.5 M8 8.5V15.5 M24 8.5V15.5"
          stroke="rgba(255,255,255,0.055)"
          strokeWidth="1"
        />
      </pattern>
      <radialGradient id={`${id}-vig`} cx="50%" cy="42%" r="78%">
        <stop offset="55%" stopColor="rgba(0,0,0,0)" />
        <stop offset="100%" stopColor="rgba(0,0,0,0.6)" />
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill={`url(#${id}-bg)`} />
    <rect width="100%" height="100%" fill={`url(#${id}-brick)`} />
    <rect width="100%" height="100%" fill={`url(#${id}-vig)`} />
  </>
);

interface MarkProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  section: any;
  palette: PreviewPalette;
}

/** One hipfire/ADS reticle in exact 1:1 pixels centered at (0, 0). */
const Reticle: React.FC<MarkProps> = ({ section, palette }) => {
  if (!section || section.bHideCrosshair) return null;

  const hasOutline = !!section.bHasOutline;
  const oT = hasOutline ? Math.max(1, gpx(num(section.outlineThickness, 1))) : 0;
  const oOp = num(section.outlineOpacity, 1);

  const dot = gpx(num(section.centerDotSize, 0));
  const showDot = !!section.bDisplayCenterDot && dot > 0;
  const dotOp = num(section.centerDotOpacity, 1);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getLine = (ln: any) => {
    if (!ln || typeof ln !== 'object' || ln.bShowLines === false) return null;
    const t = gpx(num(ln.lineThickness, 2));
    if (t <= 0) return null;
    const len = gpx(num(ln.lineLength, 4));
    const vLen = gpx(ln.bAllowVertScaling ? num(ln.lineLengthVertical, len) : len);
    const offset = gpx(num(ln.lineOffset, 0));
    const op = num(ln.opacity, 1);
    return { t, len, vLen, offset, op };
  };

  const inLine = getLine(section.innerLines ?? section.InnerLines);
  const outLine = getLine(section.outerLines ?? section.OuterLines);

  const renderLineArms = (ln: NonNullable<ReturnType<typeof getLine>>, keyPrefix: string) => (
    <g key={keyPrefix}>
      {/* Self-contained outlines for this line layer */}
      {hasOutline && oT > 0 && (
        <g fill={palette.outline} fillOpacity={oOp}>
          {ln.vLen > 0 && (
            <>
              {/* North Outline */}
              <rect
                x={-Math.floor(ln.t / 2) - oT}
                y={-(ln.offset + ln.vLen) - oT}
                width={ln.t + 2 * oT}
                height={ln.vLen + 2 * oT}
              />
              {/* South Outline */}
              <rect
                x={-Math.floor(ln.t / 2) - oT}
                y={ln.offset - oT}
                width={ln.t + 2 * oT}
                height={ln.vLen + 2 * oT}
              />
            </>
          )}
          {ln.len > 0 && (
            <>
              {/* West Outline */}
              <rect
                x={-(ln.offset + ln.len) - oT}
                y={-Math.floor(ln.t / 2) - oT}
                width={ln.len + 2 * oT}
                height={ln.t + 2 * oT}
              />
              {/* East Outline */}
              <rect
                x={ln.offset - oT}
                y={-Math.floor(ln.t / 2) - oT}
                width={ln.len + 2 * oT}
                height={ln.t + 2 * oT}
              />
            </>
          )}
        </g>
      )}
      {/* Cores for this line layer */}
      <g fill={palette.main} fillOpacity={ln.op}>
        {ln.vLen > 0 && (
          <>
            {/* North Core */}
            <rect
              x={-Math.floor(ln.t / 2)}
              y={-(ln.offset + ln.vLen)}
              width={ln.t}
              height={ln.vLen}
            />
            {/* South Core */}
            <rect
              x={-Math.floor(ln.t / 2)}
              y={ln.offset}
              width={ln.t}
              height={ln.vLen}
            />
          </>
        )}
        {ln.len > 0 && (
          <>
            {/* West Core */}
            <rect
              x={-(ln.offset + ln.len)}
              y={-Math.floor(ln.t / 2)}
              width={ln.len}
              height={ln.t}
            />
            {/* East Core */}
            <rect
              x={ln.offset}
              y={-Math.floor(ln.t / 2)}
              width={ln.len}
              height={ln.t}
            />
          </>
        )}
      </g>
    </g>
  );

  return (
    <g shapeRendering="crispEdges">
      {/* LAYER 0 (Z=0): Inner Lines */}
      {inLine && renderLineArms(inLine, 'inner')}

      {/* LAYER 1 (Z=1): Center Dot (on top of inner lines) */}
      {showDot && (
        <g key="dot">
          {hasOutline && oT > 0 && (
            <rect
              x={-Math.floor(dot / 2) - oT}
              y={-Math.floor(dot / 2) - oT}
              width={dot + 2 * oT}
              height={dot + 2 * oT}
              fill={palette.outline}
              fillOpacity={oOp}
            />
          )}
          <rect
            x={-Math.floor(dot / 2)}
            y={-Math.floor(dot / 2)}
            width={dot}
            height={dot}
            fill={palette.main}
            fillOpacity={dotOp}
          />
        </g>
      )}

      {/* LAYER 2 (Z=2): Outer Lines (on top of everything) */}
      {outLine && renderLineArms(outLine, 'outer')}
    </g>
  );
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export const PreviewBanner: React.FC<{
  primary: any;
  ads: any;
  sniper: any;
  primaryPal: PreviewPalette;
  adsPal: PreviewPalette;
  sniperColor: string;
  nativeHeight?: number;
  /** Real map art URL — replaces the generated wall when set. */
  bgUrl?: string | null;
}> = ({ primary, ads, sniper, primaryPal, adsPal, sniperColor, bgUrl }) => {
  const gid = useId().replace(/[^a-zA-Z0-9]/g, '');

  const sniperSize = gpx(num(sniper?.centerDotSize ?? sniper?.CenterDotSize, 0));
  const showSniperDot = !!sniper && sniper?.bDisplayCenterDot !== false && sniperSize > 0;
  const sniperDotOp = num(sniper?.centerDotOpacity ?? sniper?.CenterDotOpacity, 1);

  return (
    <div className="relative h-[116px] rounded-xl border border-m3-outline-subtle/70 overflow-hidden select-none bg-black/60">
      {/* Background wall */}
      {bgUrl ? (
        <img
          src={bgUrl}
          alt=""
          loading="lazy"
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
        />
      ) : (
        <svg className="absolute inset-0 w-full h-full pointer-events-none">
          <WallBackdrop id={gid} />
        </svg>
      )}
      <div className="absolute inset-0 bg-black/15 pointer-events-none" />

      {/* 3 Columns: Primary / ADS / Sniper */}
      <div className="relative z-10 flex w-full h-full">
        {/* PRIMARY */}
        <div className="relative flex-1 h-full flex items-center justify-center">
          <div className="absolute top-2 left-1/2 -translate-x-1/2 rounded-[2px] bg-black/80 px-2 py-0.5 pointer-events-none shadow-sm">
            <span className="block text-[8.5px] font-bold uppercase tracking-[0.14em] text-white/90 leading-tight">
              Primary
            </span>
          </div>
          <svg
            width="160"
            height="100"
            viewBox="-80 -50 160 100"
            className="pointer-events-none overflow-visible"
            style={{ shapeRendering: 'crispEdges' }}
          >
            <Reticle section={primary} palette={primaryPal} />
          </svg>
        </div>

        {/* AIM DOWN SIGHTS */}
        <div className="relative flex-1 h-full flex items-center justify-center">
          <div className="absolute top-2 left-1/2 -translate-x-1/2 rounded-[2px] bg-black/80 px-2 py-0.5 pointer-events-none shadow-sm">
            <span className="block text-[8.5px] font-bold uppercase tracking-[0.14em] text-white/90 leading-tight">
              Aim Down Sights
            </span>
          </div>
          <svg
            width="160"
            height="100"
            viewBox="-80 -50 160 100"
            className="pointer-events-none overflow-visible"
            style={{ shapeRendering: 'crispEdges' }}
          >
            <Reticle section={ads} palette={adsPal} />
          </svg>
        </div>

        {/* SNIPER SCOPE */}
        <div className="relative flex-1 h-full flex items-center justify-center overflow-hidden">
          <div className="absolute top-2 left-1/2 -translate-x-1/2 rounded-[2px] bg-black/80 px-2 py-0.5 pointer-events-none shadow-sm z-10">
            <span className="block text-[8.5px] font-bold uppercase tracking-[0.14em] text-white/90 leading-tight">
              Sniper Scope
            </span>
          </div>
          {/* Hairlines */}
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[1px] bg-black/85 pointer-events-none" />
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[1px] bg-black/85 pointer-events-none my-2.5" />
          {/* Center Dot */}
          {showSniperDot && (
            <div
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
              style={{
                width: `${sniperSize}px`,
                height: `${sniperSize}px`,
                borderRadius: '50%',
                backgroundColor: sniperColor,
                opacity: sniperDotOp,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};
