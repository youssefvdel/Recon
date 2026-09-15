import React, { useEffect, useState } from 'react';
import { CRASH_EVENT, buildDiagnostics, lastCrashInfo } from '../utils/consent';

/* Crash offer: appears when an opted-in capture records a fatal error.
 * Copy-to-clipboard diagnostics for Discord — no uploader, no backend. */
export const CrashOffer: React.FC = () => {
  const [visible, setVisible] = useState(() => lastCrashInfo() !== null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onCrash = (): void => {
      setVisible(true);
      setCopied(false);
    };
    window.addEventListener(CRASH_EVENT, onCrash);
    return () => window.removeEventListener(CRASH_EVENT, onCrash);
  }, []);

  if (!visible) return null;

  const copy = async (): Promise<void> => {
    const text = buildDiagnostics();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-3 rounded-2xl bg-m3-surface-container-high border border-m3-coral/40 shadow-m3-3 text-xs flex items-center gap-3 max-w-md">
      <span className="text-m3-on-surface font-semibold shrink-0">Something broke.</span>
      <button
        type="button"
        onClick={() => void copy()}
        className="px-3 py-1.5 rounded-xl text-xs font-bold bg-m3-surface-container-low border border-m3-outline-subtle text-m3-on-surface hover:border-m3-primary/50 cursor-pointer shrink-0"
      >
        {copied ? 'Copied!' : 'Copy diagnostics'}
      </button>
      <button
        type="button"
        onClick={() => setVisible(false)}
        className="text-m3-outline hover:text-m3-on-surface text-xs font-bold cursor-pointer shrink-0"
      >
        Dismiss
      </button>
    </div>
  );
};
