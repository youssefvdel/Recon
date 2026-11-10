import { useCallback, useEffect, useState } from 'react';
import {
  applyResolution,
  fetchDisplayInfo,
  fetchGpuInfo,
  fetchPreferredStretchedRes,
  fetchShortcut,
  openGpuControlPanel,
  saveShortcut,
  toggleProfile,
} from '../../utils/ipc';
import { logger } from '../../utils/logger';
import type { DisplayInfo, GpuInfo, ShortcutBinding } from '../../types';

/** The display/GPU telemetry the Resolution section needs, in v2.
 *
 *  Same commands, same refresh path as the shipping App — the sheet is a second
 *  renderer of one state, not a second state. A failed read leaves the previous
 *  value in place and says so in a toast; it never invents a mode. */
export interface ToolsState {
  displayInfo: DisplayInfo | null;
  gpuInfo: GpuInfo | null;
  shortcut: ShortcutBinding | null;
  preferredStretched: [number, number];
  isLoading: boolean;
  toast: string | null;
  dismissToast: () => void;
  toggle: () => Promise<void>;
  applyRes: (w: number, h: number, hz: number) => Promise<void>;
  saveBinding: (b: ShortcutBinding) => Promise<void>;
  setStretchRes: (w: number, h: number) => void;
  refresh: () => Promise<void>;
  openControlPanel: (vendor: string) => Promise<void>;
}

const errorToMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The IPC message is the guidance: a BADMODE failure already says the mode was
 *  never Added and how to add it. v2 has no config editor to land on, so the
 *  toast is where that sentence belongs — not a jump to a page that is absent. */
const guidance = errorToMessage;

export const useToolsState = (): ToolsState => {
  const [displayInfo, setDisplayInfo] = useState<DisplayInfo | null>(null);
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  const [shortcut, setShortcut] = useState<ShortcutBinding | null>(null);
  const [preferredStretched, setPreferredStretched] = useState<[number, number]>([2088, 1440]);
  const [isLoading, setIsLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [disp, sc, gpu, prefRes] = await Promise.all([
        fetchDisplayInfo(),
        fetchShortcut(),
        fetchGpuInfo(),
        fetchPreferredStretchedRes(),
      ]);
      setDisplayInfo(disp);
      setShortcut(sc);
      setGpuInfo(gpu);
      if (prefRes && prefRes[0] > 0 && prefRes[1] > 0) setPreferredStretched(prefRes);
    } catch (e) {
      if (import.meta.env.DEV) logger.error('Failed to load telemetry', e);
      setToast(`Display read failed — ${errorToMessage(e)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(async () => {
    setIsLoading(true);
    try {
      const updated = await toggleProfile();
      setDisplayInfo(updated);
      setToast(
        `Switched to ${updated.current_width}×${updated.current_height} (${updated.active_profile === 'stretched' ? '1.45:1 True Stretch' : 'Native 16:9'})`
      );
    } catch (e) {
      setToast(guidance(e));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const applyRes = useCallback(async (w: number, h: number, hz: number) => {
    setIsLoading(true);
    try {
      await applyResolution(w, h, hz);
      setDisplayInfo(await fetchDisplayInfo());
      setToast(`Applied ${w}×${h} @ ${hz}Hz`);
    } catch (e) {
      setToast(guidance(e));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const saveBinding = useCallback(async (binding: ShortcutBinding) => {
    try {
      await saveShortcut(binding);
      setShortcut(binding);
      setToast('Global hotkey saved and activated.');
    } catch (e) {
      setToast(guidance(e));
    }
  }, []);

  const openControlPanel = useCallback(async (vendor: string) => {
    try {
      await openGpuControlPanel(vendor);
      setToast(`Opened ${vendor} Control Panel`);
    } catch (e) {
      setToast(guidance(e));
    }
  }, []);

  return {
    displayInfo,
    gpuInfo,
    shortcut,
    preferredStretched,
    isLoading,
    toast,
    dismissToast: () => setToast(null),
    toggle,
    applyRes,
    saveBinding,
    setStretchRes: (w, h) => setPreferredStretched([w, h]),
    refresh,
    openControlPanel,
  };
};
