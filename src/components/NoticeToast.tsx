import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, X } from 'lucide-react';

/** Self-dismissing notice. The card's own outline is the countdown: a
 *  conic-gradient border that depletes over TOAST_MS, then it dismisses. */
const TOAST_MS = 6000;

export const NoticeToast: React.FC<{ message: string; onClose: () => void }> = ({ message, onClose }) => {
  const [remain, setRemain] = useState(1);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.max(0, 1 - (t - t0) / TOAST_MS);
      setRemain(p);
      if (p > 0) {
        raf = requestAnimationFrame(tick);
      } else {
        onClose();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Mount-only: `key={message}` remounts per distinct message, restarting
    // the countdown. onClose is a stable-enough inline; re-running on its
    // identity change would restart the timer mid-flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Perimeter-based countdown: an SVG rect with a normalized pathLength
  // depletes at constant border distance. (A conic-gradient sweep moves at
  // constant ANGLE, so it visibly races through the corners.)
  const done = 100 - remain * 100;
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="fixed bottom-6 right-6 z-50 w-[min(22rem,calc(100vw-2rem))]"
      role="status"
      aria-live="polite"
      data-tip={`Hiding in ${Math.ceil((remain * TOAST_MS) / 1000)}s`}
    >
      <div className="relative rounded-2xl p-[2px]">
        <svg className="pointer-events-none absolute inset-0 h-full w-full" fill="none" aria-hidden="true">
          <rect
            style={{ x: 1.5, y: 1.5, width: 'calc(100% - 3px)', height: 'calc(100% - 3px)', rx: 14.5 }}
            stroke="rgba(255, 255, 255, 0.12)"
            strokeWidth={2}
          />
          <rect
            style={{ x: 1.5, y: 1.5, width: 'calc(100% - 3px)', height: 'calc(100% - 3px)', rx: 14.5 }}
            stroke="#d0bcff"
            strokeWidth={2}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={100}
            strokeDashoffset={done}
          />
        </svg>
        <div className="rounded-[14px] bg-m3-surface-container-high shadow-m3-3 p-3.5 flex items-start gap-2.5">
          <Check className="w-4 h-4 text-m3-primary shrink-0 mt-0.5" />
          <p className="text-xs text-m3-on-surface font-medium leading-snug flex-1">{message}</p>
          <button
            onClick={onClose}
            aria-label="Dismiss"
            className="p-1 -m-1 rounded-lg hover:bg-white/10 text-m3-outline hover:text-m3-on-surface cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </motion.div>
  );
};
