import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { ShieldAlert, TriangleAlert, X } from 'lucide-react';
import {
  getTrnHealth,
  subscribeTrnHealth,
  resetTrnHealth,
  resetTrnCooldown,
  resetTrnProxyWindow,
  openTrnVerifyWindow,
  trnCooldownRemainingMs,
  trnProxyBackoffRemainingMs,
} from '../utils/trn';
import { triggerGlobalRefresh } from '../hooks/useTrackerData';
import { clearLocalStatsRetry } from '../utils/tracker';

/* One line about the TRN path, and — when a HUMAN is the only thing that can
 * clear it — the two buttons that ask them. Everything TRN used to fail
 * silently (see trn.ts `getTrnHealth`); this is the only place that says so.
 *
 * Deliberately inline, not a fixed overlay: it must never cover the toast or
 * the update prompt, and dismissal is per-verdict, not persisted. */

export const TrnStatusBanner: React.FC = () => {
  const health = useSyncExternalStore(subscribeTrnHealth, getTrnHealth, getTrnHealth);
  /** Dismissed verdict timestamp; a NEW verdict (`at`) shows again. */
  const [dismissedAt, setDismissedAt] = useState(0);
  const [verifyErr, setVerifyErr] = useState('');
  const [busy, setBusy] = useState(false);
  /** Retry countdown, only while a verdict is showing. */
  const [, setTick] = useState(0);

  const captcha = health.health === 'captcha';
  const visible = health.health !== 'ok' && health.at !== dismissedAt;

  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [visible]);

  if (!visible) return null;

  const retryMs = captcha ? 0 : Math.max(trnCooldownRemainingMs(), trnProxyBackoffRemainingMs());
  const retryS = Math.ceil(retryMs / 1000);

  const handleVerify = async () => {
    setVerifyErr('');
    setBusy(true);
    try {
      await openTrnVerifyWindow();
    } catch (e) {
      setVerifyErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const handleFinished = async () => {
    setVerifyErr('');
    setBusy(true);
    try {
      await resetTrnProxyWindow();
      // The wall left a cooldown behind on the first 429; clear it so the
      // refreshed fetch is allowed through, and adopt "ok" until the wire
      // says otherwise (a still-blocked request re-sets it immediately).
      resetTrnCooldown();
      resetTrnHealth();
      // Players held by the failure paths' retryAfter gate (30s / 5min) are
      // still "not due" — without this the refresh visibly does nothing.
      clearLocalStatsRetry();
      await triggerGlobalRefresh();
    } catch (e) {
      setVerifyErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const tone = captcha
    ? { icon: <ShieldAlert className="w-3.5 h-3.5 shrink-0" />, box: 'bg-m3-primary-container/20 border-m3-primary/40', text: 'text-m3-on-surface' }
    : { icon: <TriangleAlert className="w-3.5 h-3.5 shrink-0" />, box: 'bg-amber-500/10 border-amber-500/40', text: 'text-amber-200' };

  return (
    <div className="px-4 sm:px-6 pt-2 shrink-0">
      <div className={`rounded-xl border px-3 py-2 flex items-start gap-2.5 ${tone.box}`}>
        <span className={tone.text}>{tone.icon}</span>
        <div className="min-w-0 flex-1">
          <div className={`text-[12px] font-bold ${tone.text}`}>
            {captcha ? 'tracker.gg needs verification' : health.detail || 'tracker.gg unavailable'}
          </div>
          <div className="text-[11px] text-m3-on-surface-variant leading-snug mt-0.5">
            {captcha ? (
              <>
                A captcha must be solved once by hand — the app cannot do it for you. Verify, solve it,
                then come back and press “I finished”.
              </>
            ) : retryS > 0 ? (
              <>Stats will retry automatically in {retryS}s. Riot-direct data stays available meanwhile.</>
            ) : (
              <>Stats will retry automatically. Riot-direct data stays available meanwhile.</>
            )}
          </div>
          {verifyErr && <div className="text-[11px] text-red-300 mt-1 break-all">{verifyErr}</div>}
        </div>

        {captcha && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleVerify}
              disabled={busy}
              className="px-3.5 py-1.5 rounded-xl bg-m3-primary hover:bg-m3-primary/90 text-m3-on-primary text-xs font-bold shadow-md cursor-pointer active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Verify
            </button>
            <button
              onClick={handleFinished}
              disabled={busy}
              className="px-3.5 py-1.5 rounded-xl bg-m3-surface-container-high hover:bg-m3-surface-container-highest text-m3-on-surface text-xs font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              I finished
            </button>
          </div>
        )}

        <button
          onClick={() => setDismissedAt(health.at)}
          aria-label="Dismiss tracker.gg status"
          className="p-1 rounded-lg text-m3-outline hover:text-m3-on-surface hover:bg-black/20 transition-colors cursor-pointer shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
