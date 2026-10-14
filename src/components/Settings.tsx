import React, { useState, useEffect, useMemo } from 'react';
import {
  Check,
  Crosshair,
  X,
  RotateCcw,
} from 'lucide-react';
import type { DisplayInfo, DisplayMode } from '../types';
import { CustomResolution } from './CustomResolution';
import { logger } from '../utils/logger';
import {
  fetchPreferredStretchedRes,
  savePreferredStretchedRes,
  listSupportedModes,
} from '../utils/ipc';

interface SettingsProps {
  displayInfo: DisplayInfo | null;
  onStretchResChanged?: (w: number, h: number) => void;
  onRefreshDisplayInfo?: () => void;
}

export const Settings: React.FC<SettingsProps> = ({
  displayInfo,
  onStretchResChanged,
  onRefreshDisplayInfo,
}) => {
  const nativeW = displayInfo?.native_width || 2560;
  const nativeH = displayInfo?.native_height || 1440;

  // Stretched resolution target state
  const [stretchedW, setStretchedW] = useState<number>(2088);
  const [stretchedH, setStretchedH] = useState<number>(nativeH);
  const [customInputW, setCustomInputW] = useState<string>('2088');
  const [customInputH, setCustomInputH] = useState<string>(nativeH.toString());

  // Available display modes on PC
  const [supportedModes, setSupportedModes] = useState<DisplayMode[]>([]);

  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  // Signal to pre-fill Display Mode Lab when a target is chosen
  const [buildSignal, setBuildSignal] = useState<{ w: number; h: number; nonce: number } | null>(null);

  // Hidden / removed resolutions persisted in localStorage
  const [removedResolutions, setRemovedResolutions] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('truestretch_removed_resolutions');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const handleRemoveResolution = (w: number, h: number) => {
    const key = `${w}x${h}`;
    const next = [...removedResolutions, key];
    setRemovedResolutions(next);
    try {
      localStorage.setItem('truestretch_removed_resolutions', JSON.stringify(next));
    } catch (_) {}

    if (stretchedW === w && stretchedH === h) {
      handleSelectPreset(nativeW, nativeH);
    }
    setStatusBanner(`Removed ${w}×${h} from list. Click "Restore (${next.length} hidden)" to unhide.`);
  };

  const handleRestoreRemoved = () => {
    setRemovedResolutions([]);
    try {
      localStorage.removeItem('truestretch_removed_resolutions');
    } catch (_) {}
    setStatusBanner('Restored all hidden resolutions.');
  };

  const loadData = async () => {
    try {
      const [res, modes] = await Promise.all([
        fetchPreferredStretchedRes(),
        listSupportedModes(),
      ]);
      setStretchedW(res[0]);
      setStretchedH(res[1]);
      setCustomInputW(res[0].toString());
      setCustomInputH(res[1].toString());
      setSupportedModes(modes);
    } catch (e) {
      if (import.meta.env.DEV) logger.error('Failed to load settings data', e);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleRefreshAll = async () => {
    await loadData();
    if (onRefreshDisplayInfo) {
      onRefreshDisplayInfo();
    }
  };

  // Helper for aspect ratio badges
  const getAspectBadge = (w: number, h: number) => {
    const r = w / h;
    if (Math.abs(r - 1.45) < 0.025 || (w === 2088 && h === 1440) || (w === 2090 && h === 1440) || (w === 1568 && h === 1080)) {
      return { tag: '1.45:1', sub: 'Optimal (Gold)', color: 'border-m3-gold/40 bg-m3-gold/15 text-m3-gold' };
    }
    if (Math.abs(r - 4 / 3) < 0.02) {
      return { tag: '4:3', sub: 'Classic', color: 'border-m3-primary/30 bg-m3-primary/10 text-m3-primary' };
    }
    if (Math.abs(r - 16 / 10) < 0.02) {
      return { tag: '16:10', sub: 'Balanced', color: 'border-m3-outline-subtle bg-m3-surface-container text-m3-secondary' };
    }
    if (Math.abs(r - 5 / 4) < 0.02) {
      return { tag: '5:4', sub: 'Ultra', color: 'border-m3-outline-subtle bg-m3-surface-container text-m3-on-surface-variant' };
    }
    if (Math.abs(r - 16 / 9) < 0.02) {
      return { tag: '16:9', sub: 'Native', color: 'border-m3-outline-subtle bg-m3-surface-container text-m3-outline' };
    }
    return { tag: `${r.toFixed(2)}:1`, sub: 'Custom', color: 'border-m3-outline-subtle bg-m3-surface-container text-m3-outline' };
  };

  // Unique available modes on user's PC, filtered to relevant stretched & native resolutions
  const availableModes = useMemo(() => {
    const modeMap = new Map<string, { width: number; height: number; maxHz: number }>();

    for (const m of supportedModes) {
      if (m.width > nativeW || m.height > nativeH) continue;
      const key = `${m.width}x${m.height}`;
      const isNativeMatch = m.width === nativeW && m.height === nativeH;
      if (!isNativeMatch && removedResolutions.includes(key)) continue;

      const prev = modeMap.get(key);
      if (!prev || m.refresh_rate > prev.maxHz) {
        modeMap.set(key, { width: m.width, height: m.height, maxHz: m.refresh_rate });
      }
    }

    // Ensure active target is in the list
    if (stretchedW && stretchedH && !removedResolutions.includes(`${stretchedW}x${stretchedH}`)) {
      const activeKey = `${stretchedW}x${stretchedH}`;
      if (!modeMap.has(activeKey)) {
        modeMap.set(activeKey, {
          width: stretchedW,
          height: stretchedH,
          maxHz: displayInfo?.current_hz || 260,
        });
      }
    }

    // Filter to stretched aspect ratios (< 1.775) and common gaming resolutions
    const list = Array.from(modeMap.values()).filter((m) => {
      const r = m.width / m.height;
      const isNativeMatch = m.width === nativeW && m.height === nativeH;
      return (r < 1.775 || isNativeMatch) && m.width >= 1024 && m.height >= 720;
    });

    // Sort descending by width, then height
    return list.sort((a, b) => b.width - a.width || b.height - a.height);
  }, [supportedModes, nativeW, nativeH, stretchedW, stretchedH, displayInfo, removedResolutions]);

  const handleSelectPreset = async (w: number, h: number) => {
    try {
      const updated = await savePreferredStretchedRes(w, h);
      setStretchedW(updated[0]);
      setStretchedH(updated[1]);
      setCustomInputW(updated[0].toString());
      setCustomInputH(updated[1].toString());
      setBuildSignal({ w: updated[0], h: updated[1], nonce: Date.now() });
      if (onStretchResChanged) {
        onStretchResChanged(updated[0], updated[1]);
      }
      setStatusBanner(`Active stretch resolution set to ${w}×${h}`);
    } catch (e) {
      setStatusBanner(`Error: ${String(e)}`);
    }
  };

  const handleSaveCustom = async () => {
    const w = parseInt(customInputW, 10);
    const h = parseInt(customInputH, 10);
    if (isNaN(w) || isNaN(h) || w <= 0 || h <= 0) {
      setStatusBanner('Please enter valid resolution dimensions.');
      return;
    }
    try {
      const updated = await savePreferredStretchedRes(w, h);
      setStretchedW(updated[0]);
      setStretchedH(updated[1]);
      setBuildSignal({ w: updated[0], h: updated[1], nonce: Date.now() });
      if (onStretchResChanged) {
        onStretchResChanged(updated[0], updated[1]);
      }
      setStatusBanner(`Custom stretch resolution set to ${w}×${h}`);
    } catch (e) {
      setStatusBanner(`Error: ${String(e)}`);
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-2.5 max-w-6xl mx-auto w-full overflow-hidden [@media(max-height:720px)]:overflow-y-auto">
      {/* Notification Banner */}
      {statusBanner && (
        <div className="p-2.5 rounded-xl bg-m3-primary-container/40 border border-m3-primary/40 text-m3-on-primary-container text-xs font-semibold flex items-center justify-between shadow-xs">
          <div className="flex items-center space-x-2">
            <Check className="w-3.5 h-3.5 text-m3-primary shrink-0" />
            <span>{statusBanner}</span>
          </div>
          <button
            onClick={() => setStatusBanner(null)}
            className="text-m3-primary hover:underline text-xs ml-3 cursor-pointer font-bold"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Stretch target picker — per-file sync lives in the Valorant Config tab */}
      <div className="flex flex-col gap-2.5 flex-1 min-h-0">
        {/* STRETCHED TARGET (AVAILABLE MODES ON PC) */}
        <section className="bg-m3-surface-container border border-m3-outline-subtle rounded-2xl p-3 shadow-m3-1 flex flex-col gap-2 h-full min-h-0">
          <div className="flex items-center justify-between h-6 pb-2 border-b border-m3-outline-subtle shrink-0">
            <div className="flex items-center space-x-2">
              <Crosshair className="w-4 h-4 text-m3-primary" />
              <h3 className="font-display font-bold text-xs text-m3-on-surface uppercase tracking-wider">
                Stretched Resolution Target
              </h3>
            </div>
            <div className="flex items-center space-x-1.5">
              <span className="text-[10px] font-mono text-m3-outline">Active:</span>
              <span className="font-mono text-[11px] text-m3-primary font-bold tabular-nums">
                {stretchedW}×{stretchedH}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px] text-m3-on-surface-variant font-medium shrink-0">
            <span>Available on your PC ({availableModes.length} modes):</span>
            {removedResolutions.length > 0 ? (
              <button
                type="button"
                onClick={handleRestoreRemoved}
                className="text-[10px] font-mono text-m3-primary hover:underline flex items-center gap-1 cursor-pointer"
                data-tip="Restore all hidden resolutions"
              >
                <RotateCcw className="w-2.5 h-2.5" />
                <span>Restore ({removedResolutions.length} hidden)</span>
              </button>
            ) : (
              <span className="text-[10px] text-m3-outline">Click to set target</span>
            )}
          </div>

          {/* Grid of resolutions supported by the PC */}
          <div className="grid grid-cols-2 gap-2 flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1.5 pb-1 content-start">
            {availableModes.map((mode) => {
              const isCurrent = stretchedW === mode.width && stretchedH === mode.height;
              const isNativeRes = mode.width === nativeW && mode.height === nativeH;
              const badge = getAspectBadge(mode.width, mode.height);
              return (
                <button
                  type="button"
                  key={`${mode.width}x${mode.height}`}
                  onClick={() => handleSelectPreset(mode.width, mode.height)}
                  className={`min-h-[52px] p-2 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between group/card ${
                    isNativeRes ? 'col-span-2' : ''
                  } ${
                    isCurrent
                      ? 'bg-m3-primary-container/30 border-m3-primary text-m3-on-primary-container shadow-xs ring-1 ring-m3-primary/30'
                      : 'bg-m3-surface-container-high/60 border-m3-outline-subtle hover:bg-m3-surface-container-high'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono font-bold text-xs tabular-nums text-m3-on-surface">
                      {mode.width} × {mode.height}
                    </span>
                    <div className="flex items-center gap-1">
                      {isCurrent ? (
                        <span className="px-1.5 py-0.5 text-[8px] font-bold rounded-full bg-m3-tertiary text-m3-on-tertiary flex items-center space-x-0.5 shadow-xs shrink-0">
                          <Check className="w-2.5 h-2.5 stroke-[3]" />
                          <span>ACTIVE</span>
                        </span>
                      ) : (
                        <span className={`px-1.5 py-0.5 text-[8px] font-mono font-semibold rounded-full border ${badge.color}`}>
                          {badge.tag}
                        </span>
                      )}
                      {!isNativeRes && (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveResolution(mode.width, mode.height);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                              handleRemoveResolution(mode.width, mode.height);
                            }
                          }}
                          className="w-4 h-4 rounded-full flex items-center justify-center text-m3-outline hover:text-red-400 hover:bg-red-400/15 transition-colors cursor-pointer shrink-0 opacity-40 group-hover/card:opacity-100"
                          data-tip={`Remove ${mode.width}×${mode.height} from list`}
                        >
                          <X className="w-3 h-3" />
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-[10px] font-mono text-m3-outline mt-1">
                    <span>{isNativeRes ? '16:9 Baseline (Native)' : badge.sub}</span>
                    <span>{mode.maxHz} Hz</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Custom Input Compact Box */}
          <div className="rounded-xl bg-m3-surface-container-lowest border border-m3-outline-subtle p-2 flex items-center justify-between gap-2 mt-auto">
            <span className="text-[11px] font-bold text-m3-on-surface truncate">
              Custom Target
            </span>

            <div className="flex items-center space-x-1.5 shrink-0">
              <div className="flex items-center space-x-1 bg-m3-surface-container px-2 py-1 rounded-lg border border-m3-outline-subtle">
                <input
                  type="number"
                  value={customInputW}
                  onChange={(e) => setCustomInputW(e.target.value)}
                  placeholder="W"
                  className="w-14 bg-transparent text-m3-on-surface font-mono text-xs focus:outline-none text-center font-bold"
                />
                <span className="text-m3-outline font-mono text-xs">×</span>
                <input
                  type="number"
                  value={customInputH}
                  onChange={(e) => setCustomInputH(e.target.value)}
                  placeholder="H"
                  className="w-14 bg-transparent text-m3-on-surface font-mono text-xs focus:outline-none text-center font-bold"
                />
              </div>

              <button
                onClick={handleSaveCustom}
                className="h-7 px-3 rounded-full bg-m3-primary hover:bg-m3-primary/90 text-m3-on-primary text-[11px] font-bold shadow-xs transition-all cursor-pointer active:scale-95 shrink-0"
              >
                Set Target
              </button>
            </div>
          </div>
        </section>

      </div>

      {/* Display Mode Lab — safely adds new resolutions to the available list */}
      <section aria-label="Display mode lab" className="shrink-0">
        <CustomResolution
          displayInfo={displayInfo}
          onRefreshDisplayInfo={handleRefreshAll}
          externalDims={buildSignal}
          defaultW={stretchedW}
          defaultH={stretchedH}
        />
      </section>
    </div>
  );
};
