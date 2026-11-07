import React, { useState } from 'react';
import { isCrashOptIn, isPulseOptIn, markConsented, setCrashOptIn, setPulseOptIn } from '../utils/consent';

/* Data notice, reopened from Settings ("Review data consent", AppSettingsView).
 * It is the single place that explains what leaves the PC — and both switches
 * here are OFF by default, so the default build sends nothing about the player.
 *
 * Copy rule: say what the switch does, not "we care about privacy". */
export const ConsentModal: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [crashOn, setCrashOn] = useState<boolean>(() => {
    try {
      return isCrashOptIn();
    } catch {
      return false;
    }
  });
  const [pulseOn, setPulseOn] = useState<boolean>(() => {
    try {
      return isPulseOptIn();
    } catch {
      return false;
    }
  });

  const done = (): void => {
    setCrashOptIn(crashOn);
    setPulseOptIn(pulseOn);
    markConsented();
    onDone();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-5 shadow-m3-3">
        <h3 className="font-display font-black text-base text-m3-on-surface">How Recon uses your data</h3>
        <p className="text-xs text-m3-on-surface-variant mt-1 mb-3">
          Recon reads your local Riot client. By default nothing about you is uploaded. Both
          switches below are options you enable — they stay off unless you turn them on.
        </p>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3 rounded-xl bg-m3-surface-container-low border border-m3-outline-subtle px-3 py-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-m3-on-surface">Crash reports</div>
              <div className="text-[10px] text-m3-outline leading-snug">
                Kept on this PC. Never uploaded — only shown to you when something breaks.
              </div>
            </div>
            <div className="flex gap-1.5 shrink-0">
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

          <div className="flex items-center justify-between gap-3 rounded-xl bg-m3-surface-container-low border border-m3-outline-subtle px-3 py-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-m3-on-surface">Usage heartbeat</div>
              <div className="text-[10px] text-m3-outline leading-snug">
                One request per launch: Riot ID, app version, timestamp to the project's own
                server. This is the only feature that sends account data.
              </div>
            </div>
            <div className="flex gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setPulseOn(true)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer transition-colors ${pulseOn ? 'bg-m3-primary/20 border-m3-primary text-m3-primary' : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'}`}
              >
                ON
              </button>
              <button
                type="button"
                onClick={() => setPulseOn(false)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer transition-colors ${!pulseOn ? 'bg-m3-coral/15 border-m3-coral/50 text-m3-coral' : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'}`}
              >
                OFF
              </button>
            </div>
          </div>
        </div>

        <p className="text-[10px] text-m3-outline mt-2 leading-snug">
          Updates and in-app notices are ordinary GitHub downloads and carry no account data.
          Stats shown in the app are read from your local Riot client.
        </p>

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
