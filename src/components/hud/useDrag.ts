import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { DEFAULT_OVERLAY_CONFIG, clampWidgetPos, type OverlayConfig, type WidgetPos } from './overlayConfig';

export interface UseDragArgs {
  config: OverlayConfig;
  setConfig: React.Dispatch<React.SetStateAction<OverlayConfig>>;
  saveConfig: (next: OverlayConfig) => void;
  isEditMode: boolean;
}

export interface DragControls {
  lobbyRef: RefObject<HTMLDivElement | null>;
  pregameRef: RefObject<HTMLDivElement | null>;
  topAgentsRef: RefObject<HTMLDivElement | null>;
  prepickRef: RefObject<HTMLDivElement | null>;
  preRoundRef: RefObject<HTMLDivElement | null>;
  startDrag: (
    key: keyof OverlayConfig['positions'],
    e: ReactPointerEvent,
    overrideStartPos?: WidgetPos
  ) => void;
  startResize: (key: keyof OverlayConfig['positions'], e: ReactPointerEvent) => void;
}

/* Drag/resize state and pointer-capture handlers for the HUD widgets: moved
 * verbatim out of HudCanvas (canvas split 1/3). Placement reconcile stays in
 * the canvas; this hook owns the refs and the two gestures. */

export function useDrag({ config, setConfig, saveConfig, isEditMode }: UseDragArgs): DragControls {
  const [, setActiveDragKey] = useState<string | null>(null);

  const lobbyRef = useRef<HTMLDivElement>(null);
  const pregameRef = useRef<HTMLDivElement>(null);
  const topAgentsRef = useRef<HTMLDivElement>(null);
  const prepickRef = useRef<HTMLDivElement>(null);
  const preRoundRef = useRef<HTMLDivElement>(null);

  const widgetRefs = {
    lobby: lobbyRef,
    pregame: pregameRef,
    topAgents: topAgentsRef,
    prepick: prepickRef,
    preRound: preRoundRef,
  };
  // Smooth GPU-composited drag handler with pointer capture
  const startDrag = (
    key: keyof OverlayConfig['positions'],
    e: React.PointerEvent,
    overrideStartPos?: WidgetPos
  ) => {
    if (!isEditMode) return;
    e.preventDefault();
    e.stopPropagation();
    setActiveDragKey(key);

    const dragTarget = e.currentTarget as HTMLElement;
    try {
      dragTarget.setPointerCapture(e.pointerId);
    } catch {}

    const targetEl = widgetRefs[key].current;
    const basePos = overrideStartPos || config.positions[key] || { x: 16, y: 200 };

    let curX = basePos.x;
    let curY = basePos.y;
    const startClientX = e.clientX;
    const startClientY = e.clientY;

    const onPointerMove = (moveEv: PointerEvent) => {
      moveEv.preventDefault();
      const dx = moveEv.clientX - startClientX;
      const dy = moveEv.clientY - startClientY;

      // Clamp so the visual box stays on screen: the widget is scaled from its
      // top-left corner, so the real footprint is layout size x scale.
      const sc = config.scales?.[key] ?? 1.0;
      const screenW = typeof window !== 'undefined' ? window.innerWidth : 2088;
      const screenH = typeof window !== 'undefined' ? window.innerHeight : 1440;
      const clamped = clampWidgetPos(
        { x: basePos.x + dx, y: basePos.y + dy },
        { w: screenW, h: screenH },
        {
          w: (targetEl?.offsetWidth ?? 120) * sc,
          h: (targetEl?.offsetHeight ?? 80) * sc,
        }
      );
      const clampedX = clamped.x;
      const clampedY = clamped.y;

      curX = clampedX;
      curY = clampedY;

      if (targetEl) {
        targetEl.style.transform = `translate3d(${clampedX}px, ${clampedY}px, 0) scale(${sc})`;
      }
    };

    const onPointerUp = (upEv: PointerEvent) => {
      upEv.preventDefault();
      try {
        dragTarget.releasePointerCapture(upEv.pointerId);
      } catch {}
      setActiveDragKey(null);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      setConfig((prev) => {
        const next = {
          ...prev,
          positions: {
            ...prev.positions,
            [key]: { x: Math.round(curX), y: Math.round(curY) },
          },
        };
        saveConfig(next);
        return next;
      });
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp, { passive: false });
    // A cancelled gesture (Alt-Tab / touch interrupt mid-drag) must release
    // the drag too, or the window listeners stay attached with stale state.
    window.addEventListener('pointercancel', onPointerUp, { passive: false });
  };

  const startResize = (key: keyof OverlayConfig['positions'], e: React.PointerEvent) => {
    if (!isEditMode) return;
    e.preventDefault();
    e.stopPropagation();

    const targetEl = widgetRefs[key].current;
    const initialScale = config.scales?.[key] ?? 1.0;
    const startX = e.clientX;
    const startY = e.clientY;
    let currentScale = initialScale;

    const onPointerMove = (moveEv: PointerEvent) => {
      moveEv.preventDefault();
      const dx = moveEv.clientX - startX;
      const dy = moveEv.clientY - startY;
      const delta = (dx + dy) / 350;
      const nextScale = Math.max(0.6, Math.min(1.6, Number((initialScale + delta).toFixed(2))));
      currentScale = nextScale;

      if (targetEl) {
        const pos = config.positions[key] || { x: 16, y: 240 };
        targetEl.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0) scale(${nextScale})`;
      }
    };

    const onPointerUp = (upEv: PointerEvent) => {
      upEv.preventDefault();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      setConfig((prev) => {
        const next = {
          ...prev,
          scales: {
            ...(prev.scales || DEFAULT_OVERLAY_CONFIG.scales),
            [key]: currentScale,
          },
        };
        saveConfig(next);
        return next;
      });
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp, { passive: false });
    window.addEventListener('pointercancel', onPointerUp, { passive: false });
  };

  return { lobbyRef, pregameRef, topAgentsRef, prepickRef, preRoundRef, startDrag, startResize };
}
