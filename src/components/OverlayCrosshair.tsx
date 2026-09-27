import React, { useEffect, useState } from 'react';
import { Reticle } from './CrosshairPreview';
import {
  crosshairBox,
  toReticleSection,
  toReticlePalette,
  type OverlayCrosshairShape,
} from '../utils/crosshairOverlay';

/** Screen-centred, non-interactive overlay crosshair. Pure presentational:
    viewport size is the only state, geometry comes straight from `shape`. */
const OverlayCrosshair: React.FC<{ shape: OverlayCrosshairShape }> = React.memo(
  ({ shape }) => {
    const [vp, setVp] = useState(() => ({
      w: typeof window !== 'undefined' ? window.innerWidth : 0,
      h: typeof window !== 'undefined' ? window.innerHeight : 0,
    }));
    useEffect(() => {
      const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, []);

    if (!vp.w || !vp.h) return null;

    // width === viewBox width => 1 SVG unit is exactly 1 CSS pixel, so Reticle's
    // pixel geometry stays true (crispEdges never scales it).
    const { size, half } = crosshairBox(shape);
    const cx = Math.round(vp.w / 2);
    const cy = Math.round(vp.h / 2);

    return (
      <svg
        className="pointer-events-none z-30"
        viewBox={`${-half} ${-half} ${size} ${size}`}
        style={{
          position: 'absolute',
          width: size,
          height: size,
          left: cx - half,
          top: cy - half,
          overflow: 'visible',
          pointerEvents: 'none',
          shapeRendering: 'crispEdges',
        }}
      >
        <Reticle section={toReticleSection(shape)} palette={toReticlePalette(shape)} />
      </svg>
    );
  }
);

export default OverlayCrosshair;
