import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Sliders,
  RotateCcw,
  Check,
  AlertTriangle,
  CheckCircle2,
  Plus,
  Loader2,
  Shield,
  ChevronDown,
} from 'lucide-react';
import type { DisplayInfo } from '../types';
import { logger } from '../utils/logger';
import {
  applyResolution,
  savePreferredStretchedRes,
  addCustomResolution,
  removeCustomOverride,
} from '../utils/ipc';

interface CustomResolutionProps {
  displayInfo: DisplayInfo | null;
  onRefreshDisplayInfo?: () => void;
  externalDims?: { w: number; h: number; nonce: number } | null;
  defaultW?: number;
  defaultH?: number;
}

export const CustomResolution: React.FC<CustomResolutionProps> = ({
  displayInfo,
  onRefreshDisplayInfo,
  externalDims = null,
  defaultW,
  defaultH,
}) => {
  const nativeW = displayInfo?.native_width || 2560;
  const nativeH = displayInfo?.native_height || 1440;
  const defaultHz = displayInfo?.current_hz || 260;

  const [width, setWidth] = useState<number>(() => defaultW || Math.round(nativeH * 1.451));
  const [height, setHeight] = useState<number>(() => defaultH || nativeH);
  const [hz, setHz] = useState<number>(defaultHz);

  // Sync external dims if user selected a target upstairs or on initial load
  useEffect(() => {
    if (defaultW && defaultH && appliedNonce.current === 0) {
      setWidth(defaultW);
      setHeight(defaultH);
    }
  }, [defaultW, defaultH]);

  // Sync external dims if user selected a target upstairs
  const appliedNonce = useRef<number>(0);
  useEffect(() => {
    if (!externalDims || externalDims.nonce === appliedNonce.current) return;
    appliedNonce.current = externalDims.nonce;
    setWidth(externalDims.w);
    setHeight(externalDims.h);
  }, [externalDims]);

  // Safe Test Mode State
  const [isTesting, setIsTesting] = useState<boolean>(false);
  const [countdown, setCountdown] = useState<number>(15);
  const [safeMode, setSafeMode] = useState<{
    width: number;
    height: number;
    hz: number;
  } | null>(null);

  const [isAdding, setIsAdding] = useState<boolean>(false);
  const [isHzDropdownOpen, setIsHzDropdownOpen] = useState(false);
  const hzDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (hzDropdownRef.current && !hzDropdownRef.current.contains(event.target as Node)) {
        setIsHzDropdownOpen(false);
      }
    };
    if (isHzDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isHzDropdownOpen]);
  const [toastMessage, setToastMessage] = useState<{
    text: string;
    type: 'success' | 'warning' | 'info';
  } | null>(null);

  // Tracks monitorId if an EDID override was added in this test session.
  // If user reverts or timeout expires, this override is removed so it is not kept saved!
  const addedOverrideMonitorId = useRef<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const showToast = (
    text: string,
    type: 'success' | 'warning' | 'info' = 'success'
  ) => {
    setToastMessage({ text, type });
    setTimeout(() => {
      setToastMessage(null);
    }, 4500);
  };

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const normalizeEvenDims = (w: number, h: number) => {
    let ew = Math.round(w);
    let eh = Math.round(h);
    if (ew % 2 !== 0) ew += 1;
    if (eh % 2 !== 0) eh += 1;
    return { w: ew, h: eh, rounded: ew !== Math.round(w) || eh !== Math.round(h) };
  };

  const isAdminErrorText = (text: string) => {
    const l = text.toLowerCase();
    return l.includes('admin') || l.includes('elevat');
  };

  const revertSafeMode = useCallback(async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setIsTesting(false);

    const overrideMonitorId = addedOverrideMonitorId.current;
    addedOverrideMonitorId.current = null;

    if (safeMode) {
      try {
        await applyResolution(safeMode.width, safeMode.height, safeMode.hz);
      } catch (err) {
        if (import.meta.env.DEV) logger.error('Failed to revert resolution:', err);
      }
    }

    // If an EDID override was created during this test, remove it so it does not stay on the PC!
    if (overrideMonitorId) {
      try {
        await removeCustomOverride(overrideMonitorId);
        showToast('Resolution test reverted: mode was removed from your PC.', 'info');
      } catch (err) {
        showToast(`Reverted display, but failed to clean override: ${err}`, 'warning');
      }
    } else if (safeMode) {
      showToast(`Reverted back to safe resolution (${safeMode.width}×${safeMode.height} @ ${safeMode.hz}Hz).`, 'info');
    }

    if (onRefreshDisplayInfo) {
      onRefreshDisplayInfo();
    }
    setSafeMode(null);
  }, [safeMode, onRefreshDisplayInfo]);

  const keepChanges = useCallback(async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setIsTesting(false);
    // User explicitly kept the resolution — do NOT remove the override!
    addedOverrideMonitorId.current = null;
    setSafeMode(null);

    try {
      await savePreferredStretchedRes(width, height);
      showToast(`Resolution ${width}×${height} @ ${hz}Hz confirmed and saved to PC!`, 'success');
      if (onRefreshDisplayInfo) onRefreshDisplayInfo();
    } catch (err) {
      showToast(`Saved resolution mode: ${err}`, 'info');
    }
  }, [width, height, hz, onRefreshDisplayInfo]);

  // Safe Test Watchdog Countdown
  useEffect(() => {
    if (!isTesting) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    setCountdown(15);
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          revertSafeMode();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isTesting, revertSafeMode]);

  // Global Escape and Enter key handler during test
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isTesting) return;
      if (e.key === 'Escape') {
        revertSafeMode();
      } else if (e.key === 'Enter') {
        keepChanges();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isTesting, revertSafeMode, keepChanges]);

  const startSafeTest = async (overrideW?: number, overrideH?: number, overrideHz?: number) => {
    const tw = overrideW ?? width;
    const th = overrideH ?? height;
    const thz = overrideHz ?? hz;
    if (tw <= 0 || th <= 0 || thz <= 0) {
      showToast('Please enter valid resolution dimensions and refresh rate.', 'warning');
      return;
    }

    const currentSafe = {
      width: displayInfo?.current_width || nativeW,
      height: displayInfo?.current_height || nativeH,
      hz: displayInfo?.current_hz || defaultHz,
    };
    setSafeMode(currentSafe);
    setIsTesting(true);

    try {
      await applyResolution(tw, th, thz);
      if (onRefreshDisplayInfo) onRefreshDisplayInfo();
    } catch (err) {
      showToast(`Failed to switch resolution: ${err}`, 'warning');
      setIsTesting(false);
    }
  };

  const handleAddMode = async () => {
    if (width <= 0 || height <= 0 || hz <= 0) {
      showToast('Please enter valid resolution dimensions and refresh rate.', 'warning');
      return;
    }
    const origW = Math.round(width);
    const origH = Math.round(height);
    const norm = normalizeEvenDims(width, height);
    const effW = norm.w;
    const effH = norm.h;
    if (norm.rounded) {
      setWidth(effW);
      setHeight(effH);
      showToast(`Adjusted ${origW}×${origH} to even ${effW}×${effH} for display timing.`, 'info');
    }

    setIsAdding(true);
    try {
      const monitorId = displayInfo?.device_name || '\\\\.\\DISPLAY1';
      let msg: string;
      try {
        msg = await addCustomResolution(monitorId, effW, effH, hz);
        // Track that this override was added for this test so we can roll it back if reverted!
        addedOverrideMonitorId.current = monitorId;
      } catch (err) {
        const text = String(err);
        if (isAdminErrorText(text)) {
          showToast(`Requires administrator rights: restart app as Admin. (${text})`, 'warning');
        } else {
          showToast(`Add mode failed: ${text}`, 'warning');
        }
        return;
      }
      showToast(msg, 'success');
      if (onRefreshDisplayInfo) onRefreshDisplayInfo();
      await startSafeTest(effW, effH, hz);
    } finally {
      setIsAdding(false);
    }
  };

  const handleResetOverrides = async () => {
    const monitorId = displayInfo?.device_name || '\\\\.\\DISPLAY1';
    setIsAdding(true);
    try {
      const msg = await removeCustomOverride(monitorId);
      showToast(msg, 'info');
      if (onRefreshDisplayInfo) onRefreshDisplayInfo();
    } catch (err) {
      showToast(`Reset failed: ${err}`, 'warning');
    } finally {
      setIsAdding(false);
    }
  };

  const supportedRates =
    displayInfo?.supported_refresh_rates && displayInfo.supported_refresh_rates.length > 0
      ? displayInfo.supported_refresh_rates
      : [260, 240, 165, 144, 120, 60];

  return (
    <div className="flex flex-col gap-2.5 p-3.5 select-none bg-m3-surface-container text-m3-on-surface relative rounded-2xl border border-m3-outline-subtle shadow-m3-1">
      {/* SAFE TEST COUNTDOWN OVERLAY MODAL */}
      {isTesting && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-sm p-6 rounded-3xl bg-m3-surface-container-high border border-m3-primary/50 shadow-2xl flex flex-col items-center text-center space-y-4">
            <div className="relative w-20 h-20 flex items-center justify-center my-1 shrink-0">
              <div className="absolute inset-0 rounded-full border-4 border-m3-outline-subtle" />
              <div
                className="absolute inset-0 rounded-full border-4 border-m3-primary border-t-transparent animate-spin"
                style={{ animationDuration: '2s' }}
              />
              <span className="font-display font-extrabold text-2xl text-m3-primary tabular-nums">
                {countdown}s
              </span>
            </div>

            <div>
              <h3 className="font-display font-extrabold text-lg text-m3-on-surface">
                Testing Custom Resolution
              </h3>
              <p className="text-sm font-semibold text-m3-primary mt-0.5 font-mono">
                {width} × {height} @ {hz} Hz
              </p>
              <p className="text-xs text-m3-on-surface-variant mt-2 max-w-xs leading-relaxed">
                If the screen goes black or out of range, do nothing—it will automatically revert to your safe resolution in {countdown} seconds.
              </p>
            </div>

            <div className="flex items-center space-x-2.5 w-full pt-2">
              <button
                onClick={keepChanges}
                className="flex-1 py-2.5 px-3 rounded-full bg-m3-primary text-m3-on-primary font-bold text-xs shadow-m3-1 hover:brightness-110 active:scale-95 transition-all flex items-center justify-center space-x-1.5 cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>Keep (Enter)</span>
              </button>

              <button
                onClick={revertSafeMode}
                className="flex-1 py-2.5 px-3 rounded-full bg-m3-surface-container text-m3-on-surface hover:bg-m3-surface-container-highest border border-m3-outline font-semibold text-xs active:scale-95 transition-all flex items-center justify-center space-x-1.5 cursor-pointer"
              >
                <RotateCcw className="w-4 h-4 text-m3-secondary" />
                <span>Revert (Esc)</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Alert Banner */}
      {toastMessage && (
        <div
          className={`px-3 py-2 rounded-xl flex items-center justify-between text-xs font-medium animate-in fade-in slide-in-from-top-1 duration-200 border ${
            toastMessage.type === 'warning'
              ? 'bg-amber-950/40 border-amber-500/40 text-amber-200'
              : toastMessage.type === 'info'
              ? 'bg-blue-950/40 border-blue-500/40 text-blue-200'
              : 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
          }`}
        >
          <div className="flex items-center space-x-2">
            {toastMessage.type === 'warning' ? (
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            )}
            <span>{toastMessage.text}</span>
          </div>
          <button
            onClick={() => setToastMessage(null)}
            className="text-xs opacity-70 hover:opacity-100 ml-4 font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between h-6 pb-2 border-b border-m3-outline-subtle shrink-0">
        <div className="flex items-center space-x-2">
          <Sliders className="w-4 h-4 text-m3-primary" />
          <h3 className="font-display font-bold text-xs text-m3-on-surface uppercase tracking-wider">
            Display Mode Lab • Add Custom Resolution
          </h3>
        </div>
        <div className="flex items-center space-x-1 text-[11px] font-mono text-m3-outline">
          <Shield className="w-3.5 h-3.5 text-m3-primary" />
          <span>15s Fail-Safe Protected</span>
        </div>
      </div>

      {/* Unmistakable Form Inputs Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 my-1">
        {/* Width Box */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-semibold text-m3-on-surface-variant flex items-center justify-between">
            <span>Width (Horizontal)</span>
            <span className="text-[10px] font-mono text-m3-outline">even px</span>
          </label>
          <div className="relative flex items-center rounded-xl bg-m3-surface-container-lowest border border-m3-outline-subtle/90 hover:border-m3-outline focus-within:border-m3-primary focus-within:ring-2 focus-within:ring-m3-primary/30 transition-all shadow-inner">
            <input
              type="number"
              step="2"
              min="640"
              max="7680"
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
              placeholder="e.g. 2088"
              className="w-full h-10 px-3 pr-10 bg-transparent text-m3-on-surface font-mono font-bold text-sm focus:outline-none tabular-nums placeholder:text-m3-outline/40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="absolute right-3 text-xs font-mono font-semibold text-m3-outline pointer-events-none">
              px
            </span>
          </div>
        </div>

        {/* Height Box */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-semibold text-m3-on-surface-variant flex items-center justify-between">
            <span>Height (Vertical)</span>
            <span className="text-[10px] font-mono text-m3-outline">even px</span>
          </label>
          <div className="relative flex items-center rounded-xl bg-m3-surface-container-lowest border border-m3-outline-subtle/90 hover:border-m3-outline focus-within:border-m3-primary focus-within:ring-2 focus-within:ring-m3-primary/30 transition-all shadow-inner">
            <input
              type="number"
              step="2"
              min="480"
              max="4320"
              value={height}
              onChange={(e) => setHeight(Number(e.target.value))}
              placeholder="e.g. 1440"
              className="w-full h-10 px-3 pr-10 bg-transparent text-m3-on-surface font-mono font-bold text-sm focus:outline-none tabular-nums placeholder:text-m3-outline/40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="absolute right-3 text-xs font-mono font-semibold text-m3-outline pointer-events-none">
              px
            </span>
          </div>
        </div>

        {/* Refresh Rate Dropdown */}
        <div className="flex flex-col gap-1.5" ref={hzDropdownRef}>
          <label className="text-[11px] font-semibold text-m3-on-surface-variant flex items-center justify-between">
            <span>Refresh Rate</span>
            <span className="text-[10px] font-mono text-m3-outline">Hz</span>
          </label>
          <div className="relative">
            <button
              type="button"
              disabled={isAdding}
              onClick={() => setIsHzDropdownOpen((prev) => !prev)}
              className={`w-full h-10 px-3 rounded-xl bg-m3-surface-container-lowest border transition-all flex items-center justify-between gap-2 text-left cursor-pointer shadow-inner ${
                isHzDropdownOpen
                  ? 'border-m3-primary ring-2 ring-m3-primary/30'
                  : 'border-m3-outline-subtle/90 hover:border-m3-outline'
              }`}
            >
              <span className="text-sm font-bold font-mono text-m3-primary">
                {hz} Hz {hz === defaultHz ? '(Native)' : ''}
              </span>
              <ChevronDown className={`w-4 h-4 text-m3-outline transition-transform duration-200 ${isHzDropdownOpen ? 'rotate-180 text-m3-primary' : ''}`} />
            </button>

            <AnimatePresence>
              {isHzDropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -4, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.98 }}
                  transition={{ duration: 0.12 }}
                  className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-xl bg-m3-surface-container border border-m3-outline-subtle shadow-2xl p-1.5 custom-scrollbar max-h-48 overflow-y-auto"
                >
                  {supportedRates.map((r) => {
                    const isSelected = r === hz;
                    return (
                      <button
                        key={r}
                        type="button"
                        onClick={() => {
                          setHz(r);
                          setIsHzDropdownOpen(false);
                        }}
                        className={`w-full px-2.5 py-2 rounded-lg text-left text-xs font-mono font-medium flex items-center justify-between transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-m3-primary/15 text-m3-primary font-bold'
                            : 'text-m3-on-surface hover:bg-m3-surface-container-highest'
                        }`}
                      >
                        <span>{r} Hz {r === defaultHz ? '(Native)' : ''}</span>
                        {isSelected && <Check className="w-3.5 h-3.5 text-m3-primary shrink-0" />}
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Action Footer */}
      <div className="pt-2 border-t border-m3-outline-subtle flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
        <p className="text-[11px] text-m3-on-surface-variant">
          Safely injects resolution and runs 15s test. If reverted or timed out, it is automatically removed from your PC.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleResetOverrides}
            disabled={isAdding || isTesting}
            className="h-8 px-3 rounded-full bg-m3-surface-container-high hover:bg-m3-surface-container-highest border border-m3-outline-subtle text-m3-on-surface hover:text-red-300 font-semibold text-xs transition-colors flex items-center space-x-1.5 active:scale-95 disabled:opacity-50 cursor-pointer"
            data-tip="Remove all custom EDID overrides on this monitor and restore factory timings"
          >
            <RotateCcw className="w-3.5 h-3.5 text-m3-outline" />
            <span>Reset Overrides</span>
          </button>
          <button
            onClick={handleAddMode}
            disabled={isAdding || isTesting}
            className="h-8 px-4 rounded-full bg-m3-primary hover:bg-m3-primary/90 text-m3-on-primary font-bold text-xs shadow-xs transition-all flex items-center space-x-1.5 active:scale-95 disabled:opacity-50 cursor-pointer"
            data-tip="Add mode via EDID override to GPU driver and run 15-second test"
          >
            {isAdding ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5" />
            )}
            <span>{isAdding ? 'Adding & Testing…' : `Add & Test ${width}×${height}`}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
