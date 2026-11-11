import React, { useState, useEffect } from 'react';
import {
  Cpu,
  Zap,
  CheckCircle2,
  ShieldCheck,
  Maximize2,
  Monitor,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import type { GpuInfo, GpuSettingsReport, GpuSettingItem } from '../types';
import { autoConfigureGpuScaling, fetchGpuSettings, setGpuSetting } from '../utils/ipc';
import { logger } from '../utils/logger';

interface HardwareScalingProps {
  gpuInfo: GpuInfo | null;
  onOpenControlPanel?: (vendor: string) => Promise<void>;
}

export const HardwareScaling: React.FC<HardwareScalingProps> = ({ gpuInfo }) => {
  const [settingsReport, setSettingsReport] = useState<GpuSettingsReport | null>(null);
  const [isApplyingAuto, setIsApplyingAuto] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchGpuSettings()
      .then((report) => {
        if (mounted) setSettingsReport(report);
      })
      .catch((err) => {
        if (import.meta.env.DEV) logger.error('Failed to fetch GPU settings:', err);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const handleToggle = async (id: string, currentVal: boolean) => {
    const newVal = !currentVal;

    // 1. Optimistic UI update: Switch flips immediately in 0ms!
    setSettingsReport((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        settings: prev.settings.map((s) =>
          s.id === id ? { ...s, enabled: newVal } : s
        ),
      };
    });

    const targetItem = settingsReport?.settings.find((s) => s.id === id);
    if (targetItem) {
      setStatusMessage(`${targetItem.name}: ${newVal ? 'Activated' : 'Disabled'}`);
    }

    // 2. Invoke backend to apply real setting
    try {
      const updated = await setGpuSetting(id, newVal);
      setSettingsReport(updated);
    } catch (e) {
      // Revert on error
      setSettingsReport((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          settings: prev.settings.map((s) =>
            s.id === id ? { ...s, enabled: currentVal } : s
          ),
        };
      });
      setStatusMessage(`Error updating setting: ${String(e)}`);
    }
  };

  const handleAutoConfigure = async () => {
    setIsApplyingAuto(true);
    // Optimistic all-enabled
    setSettingsReport((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        settings: prev.settings.map((s) => ({ ...s, enabled: true })),
      };
    });
    try {
      const msg = await autoConfigureGpuScaling();
      const updated = await fetchGpuSettings();
      setSettingsReport(updated);
      setStatusMessage(msg);
    } catch (e) {
      setStatusMessage(`Error: ${String(e)}`);
    } finally {
      setIsApplyingAuto(false);
    }
  };

  const getIconForSetting = (id: string) => {
    switch (id) {
      case 'full_screen_scaling':
        return <Maximize2 className="w-4 h-4 text-m3-primary" />;
      case 'gpu_scaling_engine':
        return <Cpu className="w-4 h-4 text-m3-secondary" />;
      case 'override_game_scaling':
        return <ShieldCheck className="w-4 h-4 text-m3-tertiary" />;
      case 'low_latency_scanout':
        return <Zap className="w-4 h-4 text-m3-primary" />;
      case 'integer_scaling_bypass':
        return <Sparkles className="w-4 h-4 text-m3-secondary" />;
      default:
        return <Monitor className="w-4 h-4 text-m3-primary" />;
    }
  };

  const vendor = settingsReport?.vendor || gpuInfo?.vendor || 'Nvidia';
  const gpuName = settingsReport?.name || gpuInfo?.name || 'Graphics Display Adapter';
  const settingsList: GpuSettingItem[] = settingsReport?.settings || [];

  return (
    <div className="space-y-3 max-w-6xl mx-auto">
      {/* Top GPU Header (M3 Expressive Surface) */}
      <section className="bg-m3-surface-container border border-m3-outline-subtle rounded-2xl p-3.5 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 shadow-m3-1">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-m3-primary-container border border-m3-primary/30 flex items-center justify-center text-m3-primary shadow-xs shrink-0">
            <Cpu className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h2 className="font-display font-extrabold text-base text-m3-on-surface tracking-tight leading-tight">
                {gpuName}
              </h2>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-m3-surface-container-high border border-m3-outline-subtle text-m3-primary">
                {vendor} Hardware
              </span>
            </div>
          </div>
        </div>

        {/* Action Button: ONLY Auto-Apply GPU Scaling (Open Panel removed per user request) */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleAutoConfigure}
            disabled={isApplyingAuto}
            className="px-4 py-2 rounded-full bg-m3-primary hover:bg-m3-primary/90 text-m3-on-primary font-semibold text-xs shadow-xs transition-all flex items-center space-x-2 cursor-pointer disabled:opacity-50 active:scale-[0.98]"
            data-tip="Automatically apply all recommended scaling and black bar bypass settings"
          >
            {isApplyingAuto ? (
              <RefreshCw className="w-3.5 h-3.5 text-m3-on-primary animate-spin" />
            ) : (
              <Zap className="w-3.5 h-3.5 text-m3-on-primary fill-m3-on-primary" />
            )}
            <span>{isApplyingAuto ? 'Applying Settings...' : 'Auto-Apply GPU Scaling'}</span>
          </button>
        </div>
      </section>

      {/* Live Status Toast Banner */}
      {statusMessage && (
        <div className="p-2.5 rounded-xl bg-m3-primary-container/40 border border-m3-primary/40 text-xs text-m3-on-primary-container flex items-center justify-between shadow-xs">
          <div className="flex items-center space-x-2">
            <CheckCircle2 className="w-4 h-4 text-m3-primary shrink-0" />
            <span className="font-medium text-[11px] leading-snug">{statusMessage}</span>
          </div>
          <button
            onClick={() => setStatusMessage(null)}
            className="text-[11px] text-m3-primary hover:text-m3-on-surface px-2 py-0.5 rounded cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Real GPU Settings Toggles */}
      <div className="grid grid-cols-1 gap-3 items-start">
        {/* Full-width toggle list */}
        <div className="bg-m3-surface-container border border-m3-outline-subtle rounded-2xl p-3.5 space-y-2.5 shadow-m3-1">
          <div className="flex items-center justify-between border-b border-m3-outline-subtle pb-2">
            <div>
              <h3 className="font-display font-bold text-xs text-m3-on-surface">
                Real Hardware & Driver Settings
              </h3>
            </div>
            <span className="text-[10px] text-m3-primary font-mono font-semibold px-2 py-0.5 rounded-full bg-m3-surface-container-high border border-m3-outline-subtle">
              {settingsList.filter((s) => s.verified && s.enabled).length} verified ·{' '}
              {settingsList.filter((s) => s.enabled).length} requested · {settingsList.length} total
            </span>
          </div>

          <div className="space-y-1.5">
            {settingsList.map((setting) => (
              <div
                key={setting.id}
                onClick={() => handleToggle(setting.id, setting.enabled)}
                className={`p-2.5 rounded-xl border transition-all flex items-center justify-between gap-3 cursor-pointer select-none active:scale-[0.99] ${
                  setting.enabled
                    ? 'bg-m3-surface-container-high/80 border-m3-primary/40 text-m3-on-surface'
                    : 'bg-m3-surface-container/40 hover:bg-m3-surface-container-high/40 border-m3-outline-subtle text-m3-on-surface-variant'
                }`}
              >
                <div className="flex items-start space-x-2.5 min-w-0 pointer-events-none">
                  <div className="w-7 h-7 rounded-lg bg-m3-surface-container-highest flex items-center justify-center shrink-0 mt-0.5">
                    {getIconForSetting(setting.id)}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center space-x-2 flex-wrap">
                      <span className="text-xs font-semibold text-m3-on-surface leading-snug">
                        {setting.name}
                      </span>
                      <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-m3-surface-container-lowest border border-m3-outline-subtle text-m3-on-surface-variant">
                        {setting.badge}
                      </span>
                      {/* Never claim a state we did not read back. */}
                      {setting.verified ? (
                        <span className="text-[9px] font-mono font-bold px-1.5 py-0.2 rounded border border-m3-mint/40 bg-m3-mint/15 text-m3-mint">
                          VERIFIED
                        </span>
                      ) : (
                        <span
                          className="text-[9px] font-mono font-bold px-1.5 py-0.2 rounded border border-amber-400/40 bg-amber-400/10 text-amber-400"
                          data-tip="Recon cannot read this value back from the driver — the vendor controls it"
                        >
                          UNVERIFIED
                        </span>
                      )}
                    </div>
                    {/* Exactly what was found on the machine. */}
                    <p className="text-[10px] text-m3-on-surface-variant leading-snug mt-0.5 break-words">
                      {setting.detail}
                    </p>
                  </div>
                </div>

                {/* Material 3 Toggle Switch */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={setting.enabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggle(setting.id, setting.enabled);
                  }}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                    setting.enabled ? 'bg-m3-primary' : 'bg-m3-surface-container-highest border border-m3-outline-subtle'
                  }`}
                >
                  <span className="sr-only">Toggle {setting.name}</span>
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full shadow-md transition duration-200 ease-in-out ${
                      setting.enabled ? 'translate-x-5 bg-m3-on-primary' : 'translate-x-0 bg-m3-outline'
                    }`}
                  />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};


