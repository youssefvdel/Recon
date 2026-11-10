import React, { useEffect, useRef } from 'react';

/** The single overlay keydown owner.
 *
 *  Registered once, in CAPTURE phase, so it sees Escape before any surface.
 *  Open: Escape closes and stops immediate propagation — the match body beneath
 *  must not also collapse. Closed: it never stops propagation, so the body keeps
 *  its own Escape. No child of the palette or menu registers a keydown. */
export type Overlay = 'palette' | 'menu' | null;

export interface CommandLayerProps {
  overlay: Overlay;
  setOverlay: (o: Overlay) => void;
  children?: React.ReactNode;
}

export const CommandLayer: React.FC<CommandLayerProps> = ({ overlay, setOverlay }) => {
  const overlayRef = useRef<Overlay>(overlay);
  overlayRef.current = overlay;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const open = overlayRef.current;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOverlay(open === 'palette' ? null : 'palette');
        return;
      }
      if (!open) return; // closed: never swallow a key
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setOverlay(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [setOverlay]);

  return null;
};
