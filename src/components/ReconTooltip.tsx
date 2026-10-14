import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';

/* App-wide themed tooltip. Any element with `data-tip="..."` gets the Recon
 * hover card instead of the native gray box: same syntax as `title`, on the
 * app's own theme, animated, and flipped below the cursor target when there
 * is no room above. Driven by mouseover delegation, so no per-element code.
 *
 * Mount <TooltipHost /> once near the app root. New hover text = add a
 * `data-tip` attribute, nothing else.
 */

const SHOW_DELAY_MS = 280;

interface Tip {
  text: string;
  /** Optional bold heading line above the body (from `data-tip-title`). */
  title?: string;
  /** Optional heading tone: `amber` renders the heading amber, default primary. */
  tone?: string;
  x: number;
  y: number;
  below: boolean;
  key: number;
}

export const TooltipHost: React.FC = () => {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    let timer = 0;
    let seq = 0;
    const clear = () => window.clearTimeout(timer);
    const hide = () => {
      clear();
      setTip(null);
    };
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.(
        '[data-tip]'
      ) as HTMLElement | null;
      const text = el?.dataset?.tip;
      if (!el || !text) {
        hide();
        return;
      }
      const title = el.dataset.tipTitle || undefined;
      const tone = el.dataset.tipTone || undefined;
      clear();
      timer = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        if (!r || (r.width === 0 && r.height === 0)) return;
        const below = r.top < 150;
        const x = Math.min(Math.max(r.left + r.width / 2, 160), window.innerWidth - 160);
        seq += 1;
        setTip({ text, title, tone, x, y: below ? r.bottom : r.top, below, key: seq });
      }, SHOW_DELAY_MS);
    };
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', hide);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('mousedown', hide);
    window.addEventListener('blur', hide);
    return () => {
      clear();
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', hide);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('mousedown', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);

  return createPortal(
    tip ? (
      <motion.div
        key={tip.key}
        initial={{ opacity: 0, x: '-50%', y: tip.below ? 2 : -2, scale: 0.97 }}
        animate={{ opacity: 1, x: '-50%', y: tip.below ? 10 : 'calc(-100% - 10px)', scale: 1 }}
        transition={{ duration: 0.13, ease: 'easeOut' }}
        className="pointer-events-none fixed left-0 top-0 z-[100] max-w-[20rem] rounded-xl bg-m3-surface-container-high border border-m3-primary/30 shadow-m3-2 px-2.5 py-1.5"
        style={{ left: tip.x, top: tip.y }}
        role="tooltip"
      >
        {tip.title && (
          <span
            className={`block text-[11px] font-bold leading-snug ${
              tip.tone === 'amber' ? 'text-amber-300' : 'text-m3-primary'
            }`}
          >
            {tip.title}
          </span>
        )}
        <span className="block text-[11px] font-medium text-m3-on-surface leading-snug">
          {tip.text}
        </span>
      </motion.div>
    ) : null,
    document.body
  );
};
