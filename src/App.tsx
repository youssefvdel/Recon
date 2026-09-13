import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { UtilityView } from './components/UtilityView';
import { SettingsView } from './components/SettingsView';
import { AppSettingsView } from './components/AppSettingsView';
import { TrackerView } from './components/TrackerView';
import { StoreView } from './components/StoreView';
import { CrosshairView } from './components/CrosshairView';
import { PrepickView } from './components/PrepickView';
import { AccountsView } from './components/AccountsView';
import { DevDashboard } from './components/DevDashboard';
import { OverlayView } from './components/OverlayView';
import { UpdateModal } from './components/UpdateModal';
import type { DisplayInfo, ShortcutBinding, GpuInfo, TabType } from './types';
import { logger } from './utils/logger';
import { checkForUpdate } from './utils/updater';
import {
  fetchDisplayInfo,
  fetchShortcut,
  fetchGpuInfo,
  fetchPreferredStretchedRes,
  applyResolution,
  toggleProfile,
  saveShortcut,
  openGpuControlPanel,
  checkRequestedTab,
  trimMemory,
  isTauri,
  isBadModeErrorMessage,
  setupGlobalWindowDrag,
} from './utils/ipc';
import { listen } from '@tauri-apps/api/event';
import { IS_DEV } from './utils/devTools';

export const App: React.FC = () => {
  const isOverlay = React.useMemo(() => {
    if (typeof window === 'undefined') return false;
    if (window.location.hash.includes('overlay') || window.location.search.includes('overlay')) return true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const label = (window as any).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
      return label === 'overlay';
    } catch {
      return false;
    }
  }, []);

  const isDevWindow = React.useMemo(() => {
    if (!IS_DEV) return false;
    if (typeof window === 'undefined') return false;
    if (window.location.hash.includes('dev') || window.location.search.includes('dev')) return true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const label = (window as any).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
      return label === 'dev';
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    if (isOverlay) {
      document.title = '';
      document.documentElement.style.backgroundColor = 'transparent';
      document.body.style.backgroundColor = 'transparent';
      document.body.classList.add('bg-transparent');
    } else if (isDevWindow) {
      document.title = 'Recon • Dev Dashboard';
    } else {
      // Current size becomes the floor — the window can never shrink below this.
      import('./utils/ipc').then((m) => m.lockMinSizeToCurrent()).catch(() => {});
      return setupGlobalWindowDrag();
    }
  }, [isOverlay, isDevWindow]);

  const [currentTab, setCurrentTab] = useState<TabType>(() => {
    try {
      const saved = localStorage.getItem('recon_active_tab') as TabType;
      if (saved && ['overview', 'switcher', 'visualizer', 'sens', 'custom_res', 'gpu', 'borderless', 'game_config', 'settings', 'valorant', 'matches', 'store', 'crosshair', 'accounts', 'prepick'].includes(saved)) {
        return saved;
      }
    } catch {}
    return 'overview';
  });

  useEffect(() => {
    try {
      localStorage.setItem('recon_active_tab', currentTab);
    } catch {}
  }, [currentTab]);
  const [displayInfo, setDisplayInfo] = useState<DisplayInfo | null>(null);
  const [shortcut, setShortcut] = useState<ShortcutBinding | null>(null);
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [preferredStretched, setPreferredStretched] = useState<[number, number]>([2088, 1440]);
  const [isLoading, setIsLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'info' } | null>(null);
  const [isUpdateModalOpen, setIsUpdateModalOpen] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [_latestVersion, setLatestVersion] = useState('');

  // Background update check on startup (delayed 2.5s so app startup is instantaneous)
  useEffect(() => {
    const timer = setTimeout(() => {
      checkForUpdate()
        .then((found) => {
          if (found) {
            setHasUpdate(true);
            setLatestVersion(found.version);
          }
        })
        .catch(() => {});
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  const showToast = (message: string, type: 'success' | 'info' = 'success', durationMs = 3500) => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, durationMs);
  };

  const errorToMessage = (e: unknown): string => {
    if (e instanceof Error) return e.message;
    return String(e);
  };

  /** BADMODE (-2) means the mode was never Added: toast the Add guidance and land on Settings. */
  const handleBadModeError = (e: unknown): boolean => {
    const msg = errorToMessage(e);
    if (isBadModeErrorMessage(msg)) {
      showToast(msg, 'info', 7000);
      // Brief delay so the toast is visible while landing on Game Config.
      setTimeout(() => {
        setCurrentTab('game_config');
      }, 900);
      return true;
    }
    return false;
  };

  const loadAllTelemetry = async () => {
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
      if (prefRes && prefRes[0] > 0 && prefRes[1] > 0) {
        setPreferredStretched(prefRes);
      }
    } catch (e) {
      if (import.meta.env.DEV) logger.error('Failed to load telemetry', e);
    }
  };

  useEffect(() => {
    loadAllTelemetry();

    // Listen for background global hotkey toggle events from Rust backend
    let unlistenFn: (() => void) | undefined;
    let unlistenBlFn: (() => void) | undefined;
    if (isTauri()) {
      listen<DisplayInfo>('display-mode-changed', (event) => {
        setDisplayInfo(event.payload);
        showToast(
          `Switched to ${event.payload.current_width}×${event.payload.current_height} @ ${event.payload.current_hz}Hz!`,
          'success'
        );
      }).then((unlisten) => {
        unlistenFn = unlisten;
      });

      listen<{ hwnd: number; title: string; message: string }>('auto-borderless-applied', (event) => {
        showToast(`Auto-borderless: ${event.payload.title || 'VALORANT'} fullscreened`, 'success');
      }).then((unlisten) => {
        unlistenBlFn = unlisten;
      });
    }

    // Trim memory footprint on launch
    trimMemory();

    const handleBlur = () => {
      trimMemory();
    };
    window.addEventListener('blur', handleBlur);

    // Poll for tab switch requests (e.g. from automation or scripts) with low-overhead 2000ms interval
    const tabInterval = setInterval(async () => {
      try {
        const req = await checkRequestedTab();
        if (req) {
          if (['switcher', 'visualizer', 'game_config', 'settings', 'gpu', 'valorant', 'overview', 'matches'].includes(req)) {
            setCurrentTab(req as TabType);
          } else if (req === 'borderless' || req === 'display' || req === 'monitors') {
            // Legacy alias: Window Stretcher merged into switcher grid
            setCurrentTab('switcher');
          } else if (['config', 'custom', 'cru', 'custom_res'].includes(req)) {
            // Legacy aliases: custom builder merged into the game config tab
            setCurrentTab('game_config');
          } else if (req === 'sens') {
            // Legacy alias: sens matcher merged into the switcher tab
            setCurrentTab('switcher');
          }
        }
      } catch (_) {}
    }, 2000);

    const handleNavigateTab = (e: Event) => {
      const tab = (e as CustomEvent<TabType>).detail;
      if (tab && ['overview', 'switcher', 'visualizer', 'game_config', 'settings', 'matches'].includes(tab)) {
        setCurrentTab(tab);
      }
    };
    window.addEventListener('recon_navigate_tab', handleNavigateTab);

    return () => {
      clearInterval(tabInterval);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('recon_navigate_tab', handleNavigateTab);
      if (unlistenFn) unlistenFn();
      if (unlistenBlFn) unlistenBlFn();
    };
  }, []);

  useEffect(() => {
    if (mainRef.current) {
      mainRef.current.scrollTop = 0;
    }
  }, [currentTab]);

  const isFitViewportTab = true;
  const effectiveTab: TabType = currentTab === 'borderless' ? 'switcher' : currentTab;

  const handleToggle = async () => {
    setIsLoading(true);
    try {
      const updated = await toggleProfile();
      setDisplayInfo(updated);
      showToast(
        `Switched to ${updated.current_width}×${updated.current_height} (${updated.active_profile === 'stretched' ? '1.45:1 True Stretch' : 'Native 16:9'})`,
        'success'
      );
    } catch (e) {
      if (!handleBadModeError(e)) {
        showToast(errorToMessage(e), 'info');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleApplyResolution = async (w: number, h: number, hz: number) => {
    setIsLoading(true);
    try {
      await applyResolution(w, h, hz);
      const updated = await fetchDisplayInfo();
      setDisplayInfo(updated);
      showToast(`Applied ${w}×${h} @ ${hz}Hz`, 'success');
    } catch (e) {
      if (!handleBadModeError(e)) {
        showToast(errorToMessage(e), 'info');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveShortcut = async (binding: ShortcutBinding) => {
    try {
      await saveShortcut(binding);
      setShortcut(binding);
      showToast('Global hotkey saved and activated!', 'success');
    } catch (e) {
      showToast(String(e), 'info');
    }
  };

  const handleOpenControlPanel = async (vendor: string) => {
    try {
      await openGpuControlPanel(vendor);
      showToast(`Opened ${vendor} Control Panel`, 'info');
    } catch (e) {
      showToast(String(e), 'info');
    }
  };

  if (isOverlay) {
    return <OverlayView />;
  }

  if (isDevWindow) {
    return (
      <div className="h-screen w-screen bg-m3-surface text-m3-on-surface flex flex-col overflow-hidden selection:bg-m3-primary-container selection:text-m3-on-primary-container antialiased font-sans">
        <DevDashboard />
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-m3-surface text-m3-on-surface flex overflow-hidden selection:bg-m3-primary-container selection:text-m3-on-primary-container antialiased font-sans">
      {/* Left Sidebar Navigation */}
      <Sidebar
        currentTab={effectiveTab}
        onSelectTab={setCurrentTab}
        displayInfo={displayInfo}
        gpuInfo={gpuInfo}
        hasUpdate={hasUpdate}
        onOpenUpdates={() => setIsUpdateModalOpen(true)}
      />

      {/* Main Content Pane */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-m3-surface">
        {/* TopBar Header */}
        <TopBar
          currentTab={effectiveTab}
          displayInfo={displayInfo}
          gpuInfo={gpuInfo}
          shortcut={shortcut}
          onToggleProfile={handleToggle}
          isLoading={isLoading}
          hasUpdate={hasUpdate}
          onOpenUpdates={() => setIsUpdateModalOpen(true)}
        />
        {/* Scrollable View Content (unified grid locks to viewport, no scroll) */}
        <main
          ref={mainRef}
          className={
            isFitViewportTab
              ? 'flex-1 min-h-0 overflow-hidden p-0'
              : 'flex-1 overflow-y-auto p-3.5 sm:p-4'
          }
        >
          <div className="h-full min-h-0 w-full">
            <AnimatePresence mode="wait">
              <motion.div
                key={effectiveTab}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="h-full min-h-0"
              >
                {(currentTab === 'overview' || currentTab === 'matches') && (
                  <TrackerView initialSubTab={currentTab === 'matches' ? 'matches' : 'overview'} />
                )}

                {currentTab === 'store' && <StoreView />}

                {currentTab === 'crosshair' && <CrosshairView />}

                {currentTab === 'prepick' && <PrepickView />}

                {currentTab === 'accounts' && <AccountsView />}

                {currentTab === 'dev' && IS_DEV && (
                  <DevDashboard />
                )}

                {(currentTab === 'switcher' || currentTab === 'visualizer' || currentTab === 'borderless') && (
                  <UtilityView
                    initialSubTab={currentTab === 'visualizer' ? 'visualizer' : 'switcher'}
                    displayInfo={displayInfo}
                    shortcut={shortcut}
                    preferredStretched={preferredStretched}
                    onToggle={handleToggle}
                    onApplyResolution={handleApplyResolution}
                    onSaveShortcut={handleSaveShortcut}
                    isLoading={isLoading}
                  />
                )}

                {(currentTab === 'game_config' || currentTab === 'valorant' || currentTab === 'gpu') && (
                  <SettingsView
                    initialSubTab={currentTab === 'valorant' ? 'valorant' : currentTab === 'gpu' ? 'gpu' : 'setup'}
                    displayInfo={displayInfo}
                    gpuInfo={gpuInfo}
                    onStretchResChanged={(w, h) => setPreferredStretched([w, h])}
                    onRefreshDisplayInfo={loadAllTelemetry}
                    onOpenControlPanel={handleOpenControlPanel}
                  />
                )}

                {currentTab === 'settings' && (
                  <AppSettingsView
                    onUpdateStatusChange={(has, ver) => {
                      setHasUpdate(has);
                      setLatestVersion(ver);
                    }}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>

      {/* In-App Update Modal */}
      <UpdateModal
        isOpen={isUpdateModalOpen}
        onClose={() => setIsUpdateModalOpen(false)}
        onUpdateStatusChange={(has, ver) => {
          setHasUpdate(has);
          setLatestVersion(ver);
        }}
      />

      {/* Animated Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="fixed bottom-6 right-6 z-50 px-5 py-3 rounded-full bg-m3-surface-bright text-m3-on-surface border border-m3-primary/40 shadow-m3-3 text-xs font-medium flex items-center space-x-2.5 backdrop-blur-md"
          >
            <span className="w-2 h-2 rounded-full bg-m3-primary" />
            <span>{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default App;
