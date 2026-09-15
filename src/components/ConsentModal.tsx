import React, { useState } from 'react';
import { isCrashOptIn, markConsented, setCrashOptIn } from '../utils/consent';

/* First-run notice. Tracker starts ON unconditionally (Settings opts out);
 * this modal only asks about local-only crash reports (default OFF). */
export const ConsentModal: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [crashOn, setCrashOn] = useState<boolean>(() => {
    try {
      return isCrashOptIn();
    } catch {
      return false;
    }
  });

  const done = (): void => {
    setCrashOptIn(crashOn);
    markConsented();
    onDone();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-5 shadow-m3-3">
        <h3 className="font-display font-black text-base text-m3-on-surface">How Recon uses your data</h3>
        <p className="text-xs text-m3-on-surface-variant mt-1 mb-3">
          Local game data + public tracker.gg / OP.GG stats. Nothing leaves this PC.
        </p>
        <div className="flex items-center justify-between rounded-xl bg-m3-surface-container-low border border-m3-outline-subtle px-3 py-2">
          <span className="text-xs font-semibold text-m3-on-surface">Crash reports (local only)</span>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setCrashOn(true)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer transition-colors ${crashOn ? 'bg-m3-primary/20 border-m3-primary text-m3-primary' : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'}`}
            >
              ON
            </button>
            <button
              type="button"
              onClick={() => setCrashOn(false)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer transition-colors ${!crashOn ? 'bg-m3-coral/15 border-m3-coral/50 text-m3-coral' : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'}`}
            >
              OFF
            </button>
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button
            type="button"
            onClick={done}
            className="flex-1 h-9 rounded-xl bg-m3-primary text-m3-on-primary text-xs font-bold hover:opacity-90 active:scale-95 transition-all cursor-pointer"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
};
