import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';

/* App-wide themed tooltip. Any element with `data-tip="..."` gets the Recon
 * hover card instead of the native gray box: same syntax as `title`, on the
 * app's own theme, animated, and flipped below the cursor target when there
 * is no room above. Driven by delegated pointer + focus events, so no
 * per-element code.
 *
 * Keyboard: focusing a `data-tip` element opens the tip immediately and wires
 * `aria-describedby` to it; blurring closes it. That makes the explanation
 * available to keyboard and screen-reader users, not just on hover
 * (docs/audit/ui.md #7).
 *
 * Mount <TooltipHost /> once near the app root. New hover text = add a
 * `data-tip` attribute, nothing else.
 */

const SHOW_DELAY_MS = 280;
const TIP_ID = 'recon-tooltip';

interface Tip {
  text: string;
  /** Optional bold heading line above the body (from `data-tip-title`). */
  title?: string;
  /** Optional heading `tone`: `amber` renders the heading amber, default primary. */
  tone?: string;
  x: number;
  y: number;
  below: boolean;
  key: number;
}

const tipTarget = (target: EventTarget | null): HTMLElement | null =>
  (target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;

const setDescribedBy = (el: HTMLElement, on: boolean): void => {
  if (on) el.setAttribute('aria-describedby', TIP_ID);
  else if (el.getAttribute('aria-describedby') === TIP_ID) el.removeAttribute('aria-describedby');
};

export const TooltipHost: React.FC = () => {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    let timer = 0;
    let seq = 0;
    let current: HTMLElement | null = null;
    /* The element that actually receives focus; aria-describedby has to sit
       on it, not on an ancestor the tip happens to be attached to. */
    let described: HTMLElement | null = null;
    const clear = () => window.clearTimeout(timer);
    const hide = () => {
      clear();
      if (described) {
        setDescribedBy(described, false);
        described = null;
      }
      current = null;
      setTip(null);
    };
    const paint = (el: HTMLElement, text: string) => {
      const r = el.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) return;
      const below = r.top < 150;
      const x = Math.min(Math.max(r.left + r.width / 2, 160), window.innerWidth - 160);
      seq += 1;
      setTip({
        text,
        title: el.dataset.tipTitle || undefined,
        tone: el.dataset.tipTone || undefined,
        x,
        y: below ? r.bottom : r.top,
        below,
        key: seq,
      });
    };
    const show = (el: HTMLElement, immediate: boolean) => {
      const text = el.dataset.tip;
      if (!text) return;
      clear();
      if (immediate) paint(el, text);
      else timer = window.setTimeout(() => paint(el, text), SHOW_DELAY_MS);
    };
    const onPointerOver = (e: PointerEvent) => {
      const el = tipTarget(e.target);
      if (!el) {
        hide();
        return;
      }
      if (el === current) return;
      hide();
      current = el;
      show(el, false);
    };
    const onPointerOut = (e: PointerEvent) => {
      const el = tipTarget(e.target);
      if (!el || el !== current) return;
      const next = e.relatedTarget as Node | null;
      if (next && el.contains(next)) return;
      hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = tipTarget(e.target);
      if (!el) return;
      hide();
      current = el;
      described = (e.target as HTMLElement | null) ?? el;
      setDescribedBy(described, true);
      show(el, true);
    };
    const onFocusOut = (e: FocusEvent) => {
      const el = tipTarget(e.target);
      if (!el || el !== current) return;
      hide();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };

    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointerout', onPointerOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('pointerdown', hide);
    window.addEventListener('blur', hide);
    return () => {
      clear();
      if (described) setDescribedBy(described, false);
      document.removeEventListener('pointerover', onPointerOver);
      document.removeEventListener('pointerout', onPointerOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('pointerdown', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);

  return createPortal(
    tip ? (
      <motion.div
        id={TIP_ID}
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
            className={`block text-micro font-bold leading-snug ${
              tip.tone === 'amber' ? 'text-amber-300' : 'text-m3-primary'
            }`}
          >
            {tip.title}
          </span>
        )}
        <span className="block text-micro font-medium text-m3-on-surface leading-snug">
          {tip.text}
        </span>
      </motion.div>
    ) : null,
    document.body
  );
};
