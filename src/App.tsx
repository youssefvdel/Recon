import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { motion, AnimatePresence, MotionConfig } from 'framer-motion';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
const UtilityView = lazy(() => import('./components/UtilityView').then((m) => ({ default: m.UtilityView })));
const ValorantConfig = lazy(() => import('./components/ValorantConfig').then((m) => ({ default: m.ValorantConfig })));
import type { ConfigAccountCtx } from './utils/accountVideo';
const AppSettingsView = lazy(() => import('./components/AppSettingsView').then((m) => ({ default: m.AppSettingsView })));
import { TrackerView } from './components/TrackerView';
const StoreView = lazy(() => import('./components/StoreView').then((m) => ({ default: m.StoreView })));
const RiotChatView = lazy(() => import('./components/RiotChatView').then((m) => ({ default: m.RiotChatView })));
const CrosshairView = lazy(() => import('./components/CrosshairView').then((m) => ({ default: m.CrosshairView })));
const PrepickView = lazy(() => import('./components/PrepickView').then((m) => ({ default: m.PrepickView })));
const AccountsView = lazy(() => import('./components/AccountsView').then((m) => ({ default: m.AccountsView })));
const DevDashboard = lazy(() => import('./components/DevDashboard').then((m) => ({ default: m.DevDashboard })));

/* ui #8 — never show a blank pane on tab switch. The lazy boundary only
 * blanks when the chunk is not cached yet, so we warm it the moment the user
 * commits to a tab (and again on idle for everything else). The Suspense
 * fallback then never paints in practice. */
const VIEW_LOADERS: Partial<Record<TabType, () => Promise<unknown>>> = {
  switcher: () => import('./components/UtilityView'),
  visualizer: () => import('./components/UtilityView'),
  borderless: () => import('./components/UtilityView'),
  gpu: () => import('./components/UtilityView'),
  game_config: () => import('./components/ValorantConfig'),
  valorant: () => import('./components/ValorantConfig'),
  settings: () => import('./components/AppSettingsView'),
  store: () => import('./components/StoreView'),
  chat: () => import('./components/RiotChatView'),
  crosshair: () => import('./components/CrosshairView'),
  prepick: () => import('./components/PrepickView'),
  accounts: () => import('./components/AccountsView'),
  dev: () => import('./components/DevDashboard'),
};

/** Warm the chunk for a tab. Fire-and-forget; a failed preload just means the
 *  Suspense fallback shows, exactly as before. */
function preloadView(tab: TabType): void {
  void VIEW_LOADERS[tab]?.().catch(() => {});
}

/** Idle-prefetch every view once, after first paint. */
function preloadAllViews(): void {
  for (const load of Object.values(VIEW_LOADERS)) void load?.().catch(() => {});
}

/* Legacy tabs from pre-0.5 builds can still sit in localStorage ('sens',
 * 'custom_res'). Tab restore accepts them, but they have no view any more, so
 * a launch painted an empty content pane. Map them to the views they were
 * merged into; their stored value is rewritten on the next persist. */
const LEGACY_TAB_ALIAS: Partial<Record<TabType, TabType>> = {
  sens: 'switcher',
  custom_res: 'game_config',
  borderless: 'switcher',
};
const normalizeTab = (tab: TabType): TabType => LEGACY_TAB_ALIAS[tab] ?? tab;
const OverlayView = lazy(() => import('./components/OverlayView').then((m) => ({ default: m.OverlayView })));
import { TooltipHost } from './components/ReconTooltip';
import { ViewSkeleton } from './components/ViewSkeleton';
import { ViewErrorBoundary } from './components/ViewErrorBoundary';
import type { DisplayInfo, ShortcutBinding, GpuInfo, TabType } from './types';
import { logger } from './utils/logger';
import { resolveInitialTab } from './utils/tabRestore';
import {
  startAutoUpdate,
  subscribeAutoUpdate,
  getAutoUpdateState,
  getInstallBlocker,
  installAutoUpdate,
  deferAutoInstall,
  type AutoUpdateState,
} from './utils/updater';
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
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IS_DEV } from './utils/devTools';
import { ConsentModal } from './components/ConsentModal';
import { OpsNotices } from './components/OpsNotices';
import { TrnStatusBanner } from './components/TrnStatusBanner';
import { fetchNotices, noticeApplies, isDismissed, sendPulse, type OpsNotice } from './utils/ops';
import { APP_VERSION } from './utils/version';
import { CrashOffer } from './components/CrashOffer';
import { installCrashCapture, CONSENT_EVENT } from './utils/consent';
import { accountCurrent } from './utils/accounts';

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
      document.title = 'Recon • Overlay';
      document.documentElement.style.backgroundColor = 'transparent';
      document.body.style.backgroundColor = 'transparent';
      document.body.classList.add('bg-transparent');
    } else if (isDevWindow) {
      document.title = 'Recon • Dev Dashboard';
    } else {
      // The main window's minimum size (default open size) is owned by the
      // Rust setup in src-tauri/src/lib.rs — do not re-set it from the frontend.
      return setupGlobalWindowDrag();
    }
  }, [isOverlay, isDevWindow]);

  const [currentTab, setCurrentTab] = useState<TabType>(() => {
    try {
      // Restore the last tab — except Settings: it is a visit-only page (the
      // Sidebar version/UPDATE pill navigates there), so resolveInitialTab
      // excludes it and a launch falls back to overview. The current tab is
      // still persisted below, so the saved value stays truthful.
      return normalizeTab(resolveInitialTab(localStorage.getItem('recon_active_tab')));
    } catch {
      return 'overview';
    }
  });

  /* Account chosen on the Accounts tab whose video settings are being edited
   * in Game Config. Cleared when leaving (Back button / tab switch away). */
  const [configAccount, setConfigAccount] = useState<ConfigAccountCtx | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem('recon_active_tab', currentTab);
    } catch {}
  }, [currentTab]);
  // Jump-to-live requests from the TopBar LIVE pill.
  const [liveNonce, setLiveNonce] = useState(0);
  useEffect(() => {
    const onGotoLive = () => {
      setCurrentTab('overview');
      setLiveNonce((n) => n + 1);
    };
    window.addEventListener('recon:goto-live', onGotoLive);
    return () => window.removeEventListener('recon:goto-live', onGotoLive);
  }, []);
  const [displayInfo, setDisplayInfo] = useState<DisplayInfo | null>(null);
  const [shortcut, setShortcut] = useState<ShortcutBinding | null>(null);
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [preferredStretched, setPreferredStretched] = useState<[number, number]>([2088, 1440]);
  const [isLoading, setIsLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'info' | 'error' } | null>(null);
  const [autoUpdate, setAutoUpdate] = useState<AutoUpdateState>(getAutoUpdateState);
  const announcedUpdateRef = useRef('');
  const [hasUpdate, setHasUpdate] = useState(false);
  const [_latestVersion, setLatestVersion] = useState('');
  const [showConsent, setShowConsent] = useState<boolean>(false);
  const [opsNotices, setOpsNotices] = useState<OpsNotice[]>([]);

  // Broadcasts + usage pulse, main window only, once per launch.
  // The first-run consent popup is gone: crash capture stays local-only and
  // opt-in from Settings, and the modal now opens only from there.
  useEffect(() => {
    if (isOverlay || isDevWindow) return;
    let dead = false;
    const pullNotices = () => {
      fetchNotices().then((all) => {
        if (dead) return;
        setOpsNotices(all.filter((n) => noticeApplies(n, APP_VERSION) && !isDismissed(n.id)));
      });
    };
    pullNotices();
    // Live broadcast: running apps pick up new notices within 5 minutes.
    const pollId = setInterval(pullNotices, 5 * 60 * 1000);
    accountCurrent()
      .then((live) => sendPulse(live, APP_VERSION))
      .catch(() => sendPulse(null, APP_VERSION));
    return () => {
      dead = true;
      clearInterval(pollId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Local-only crash capture (opt-in flag lives in utils/consent).
  // Consent modal re-opens from Settings via the CONSENT_EVENT.
  useEffect(() => {
    installCrashCapture();
    const onConsent = (): void => setShowConsent(true);
    window.addEventListener(CONSENT_EVENT, onConsent);
    return () => window.removeEventListener(CONSENT_EVENT, onConsent);
  }, []);

  // Background update check + auto-download, main window only (the overlay and
  // dev dashboard also mount App). Delayed 2.5s so app startup is instantaneous.
  useEffect(() => {
    if (isOverlay || isDevWindow) return;
    const timer = setTimeout(() => {
      void startAutoUpdate();
    }, 2500);
    return () => clearTimeout(timer);
  }, [isOverlay, isDevWindow]);

  const showToast = (message: string, type: 'success' | 'info' = 'success', durationMs = 3500) => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, durationMs);
  };

  // Mirror the background updater into the UI: pill state, one toast per
  // discovered version, and the ready-to-install prompt once it is safe.
  useEffect(() => {
    return subscribeAutoUpdate((state) => {
      setAutoUpdate(state);
      const version = state.update?.version;
      if (!version) return;
      setHasUpdate(true);
      setLatestVersion(version);
      if (state.phase !== 'checking' && announcedUpdateRef.current !== version) {
        announcedUpdateRef.current = version;
        showToast(`Update v${version} found — downloading in the background`, 'info', 6000);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const errorToMessage = (e: unknown): string => {
    if (e instanceof Error) return e.message;
    return String(e);
  };

  const handleInstallReady = async () => {
    const blocker = await getInstallBlocker();
    if (blocker) {
      showToast(blocker, 'info', 7000);
      return;
    }
    try {
      await installAutoUpdate();
    } catch (e) {
      showToast(errorToMessage(e), 'info', 7000);
    }
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

    // ui #8: warm every view chunk after the first paint so later tab
    // switches never wait on the network.
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
      .requestIdleCallback;
    if (idle) idle(() => preloadAllViews());
    else window.setTimeout(preloadAllViews, 1500);

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
    const applyTabRequest = (req: string | null) => {
      if (!req) return;
      preloadView(req as TabType);
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
    };
    // Tab-switch requests (automation/scripts) poll ONLY while this window
    // owns focus. `document.hidden` is always false in a Tauri window even
    // when native-hidden (see DevDashboard.tsx:1034), so the old unconditional
    // 2s interval kept ~30 IPC calls/minute alive in the tray forever. Focus is
    // the real signal: hiding to tray always blurs the window.
    let tabTimer: ReturnType<typeof setInterval> | null = null;
    const startTabPoll = () => {
      if (tabTimer) return;
      tabTimer = setInterval(() => {
        checkRequestedTab().then(applyTabRequest).catch(() => {});
      }, 2000);
    };
    const stopTabPoll = () => {
      if (!tabTimer) return;
      clearInterval(tabTimer);
      tabTimer = null;
    };
    // Immediate tick on return (OverlayView/LiveMatchView pattern) so a
    // request filed while hidden never waits a full interval.
    const onTabVis = () => {
      checkRequestedTab().then(applyTabRequest).catch(() => {});
    };
    let unlistenFocus: (() => void) | undefined;
    if (isTauri()) {
      const win = getCurrentWindow();
      // `onFocusChanged` only fires on CHANGE, so seed from the current state
      // (a boot-to-tray start is already unfocused and must poll nothing).
      void win.isFocused().then((f) => {
        if (f) startTabPoll();
      }).catch(() => {});
      win.onFocusChanged(({ payload: focused }) => {
        if (focused) {
          startTabPoll();
          onTabVis();
        } else {
          stopTabPoll();
        }
      }).then((un) => {
        unlistenFocus = un;
      }).catch(() => {});
    } else {
      // Browser preview: no Tauri focus events, cadence unchanged.
      startTabPoll();
    }
    document.addEventListener('visibilitychange', onTabVis);
    window.addEventListener('focus', onTabVis);

    const handleNavigateTab = (e: Event) => {
      const tab = (e as CustomEvent<TabType>).detail;
      if (tab && ['overview', 'switcher', 'visualizer', 'game_config', 'settings', 'matches'].includes(tab)) {
        setCurrentTab(tab);
      }
    };
    window.addEventListener('recon_navigate_tab', handleNavigateTab);

    return () => {
      stopTabPoll();
      try {
        unlistenFocus?.();
      } catch {}
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('recon_navigate_tab', handleNavigateTab);
      document.removeEventListener('visibilitychange', onTabVis);
      window.removeEventListener('focus', onTabVis);
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
  const effectiveTab: TabType = normalizeTab(currentTab);

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
    return (
      <MotionConfig reducedMotion="user">
        {/* Overlay window only: null fallback keeps it transparent while the
            chunk loads instead of flashing a skeleton over the game. */}
        <Suspense fallback={null}>
          <OverlayView />
        </Suspense>
        <TooltipHost />
      </MotionConfig>
    );
  }

  if (isDevWindow) {
    return (
      <MotionConfig reducedMotion="user">
        <div className="h-screen w-screen bg-m3-surface text-m3-on-surface flex flex-col overflow-hidden selection:bg-m3-primary-container selection:text-m3-on-primary-container antialiased font-sans">
          <Suspense fallback={<ViewSkeleton />}>
            <DevDashboard />
          </Suspense>
          <TooltipHost />
        </div>
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
    <div className="h-screen w-screen bg-m3-surface text-m3-on-surface flex overflow-hidden selection:bg-m3-primary-container selection:text-m3-on-primary-container antialiased font-sans">
      <TooltipHost />
      {/* Left Sidebar Navigation */}
      <Sidebar
        currentTab={effectiveTab}
        onSelectTab={(tab) => {
          // Sidebar entry = plain editor, never a stale account banner.
          if (tab === 'game_config') setConfigAccount(null);
          preloadView(tab);
          setCurrentTab(tab);
        }}
        displayInfo={displayInfo}
        gpuInfo={gpuInfo}
        hasUpdate={hasUpdate}
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
        />
        {/* Scrollable View Content (unified grid locks to viewport, no scroll) */}
        <TrnStatusBanner />
        <OpsNotices
          notices={opsNotices}
          onDismiss={(id) => setOpsNotices((prev) => prev.filter((n) => n.id !== id))}
        />
        <main
          ref={mainRef}
          className={
            isFitViewportTab
              ? 'flex-1 min-h-0 overflow-hidden p-0'
              : 'flex-1 overflow-y-auto p-3.5 sm:p-4'
          }
        >
          <div className="h-full min-h-0 w-full">
            <ViewErrorBoundary key={effectiveTab}>
            <Suspense fallback={<ViewSkeleton />}>
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
                  <TrackerView
                    initialSubTab={currentTab === 'matches' ? 'matches' : 'overview'}
                    liveRequest={liveNonce}
                  />
                )}

                {currentTab === 'store' && <StoreView />}

                {currentTab === 'chat' && <RiotChatView />}

                {currentTab === 'crosshair' && <CrosshairView />}

                {currentTab === 'prepick' && <PrepickView />}

                {currentTab === 'accounts' && (
                  <AccountsView
                    onEditConfig={(account) => {
                      setConfigAccount(account);
                      setCurrentTab('game_config');
                    }}
                  />
                )}

                {currentTab === 'dev' && IS_DEV && (
                  <DevDashboard />
                )}

                {(currentTab === 'switcher' || currentTab === 'visualizer' || currentTab === 'borderless' || currentTab === 'gpu') && (
                  <UtilityView
                    initialSubTab={
                      currentTab === 'visualizer' ? 'visualizer' : currentTab === 'gpu' ? 'gpu' : 'switcher'
                    }
                    displayInfo={displayInfo}
                    gpuInfo={gpuInfo}
                    shortcut={shortcut}
                    preferredStretched={preferredStretched}
                    onToggle={handleToggle}
                    onApplyResolution={handleApplyResolution}
                    onSaveShortcut={handleSaveShortcut}
                    onStretchResChanged={(w, h) => setPreferredStretched([w, h])}
                    onRefreshDisplayInfo={loadAllTelemetry}
                    onOpenControlPanel={handleOpenControlPanel}
                    isLoading={isLoading}
                  />
                )}

                {(currentTab === 'game_config' || currentTab === 'valorant') && (
                  <ValorantConfig
                    key={configAccount ? `acct-${configAccount.id}` : 'plain'}
                    account={configAccount}
                    onBackToAccounts={() => {
                      setConfigAccount(null);
                      setCurrentTab('accounts');
                    }}
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
            </Suspense>
            </ViewErrorBoundary>
          </div>
        </main>
      </div>

      {/* First-run data consent + crash diagnostics offer */}
      {showConsent && <ConsentModal onDone={() => setShowConsent(false)} />}
      <CrashOffer />

      {/* Safe-moment install prompt: only once downloaded, no match live, overlay down. */}
      {autoUpdate.phase === 'ready' && autoUpdate.safeToInstall && !autoUpdate.deferred && autoUpdate.update && (
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          className="fixed bottom-6 right-6 z-50 max-w-sm px-4 py-3.5 rounded-2xl bg-m3-surface-bright text-m3-on-surface border border-m3-primary/40 shadow-m3-3 flex flex-col gap-3"
        >
          <div className="flex items-start space-x-2.5">
            <span className="w-2 h-2 mt-1 rounded-full bg-m3-primary shrink-0" />
            <div className="text-xs">
              <div className="font-bold">Update v{autoUpdate.update.version} is ready</div>
              <div className="text-m3-on-surface-variant mt-0.5">
                Downloaded and signature-verified. Install now and restart, or keep playing.
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={deferAutoInstall}
              className="px-3.5 py-1.5 rounded-xl bg-m3-surface-container-high hover:bg-m3-surface-container-highest text-m3-on-surface text-xs font-semibold cursor-pointer"
            >
              Later
            </button>
            <button
              onClick={handleInstallReady}
              className="px-4 py-1.5 rounded-xl bg-m3-primary hover:bg-m3-primary/90 text-m3-on-primary text-xs font-bold shadow-md cursor-pointer active:scale-95"
            >
              Install &amp; Restart
            </button>
          </div>
        </motion.div>
      )}

      {/* Animated Toast Notification.
          Bottom-right STACK column: every transient notice in the app renders
          here, so a future tray/status banner can join the column instead of
          fighting the toast for the same fixed offset. No backdrop blur — the
          toast sits on a flat /0.85 plate, same convention as the HUD. */}
      <div
        className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2 pointer-events-none"
        aria-live={toast?.type === 'error' ? 'assertive' : 'polite'}
        aria-atomic="true"
        role="status"
      >
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: 16, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              className="pointer-events-auto px-5 py-3 rounded-full bg-m3-surface-bright/85 text-m3-on-surface border border-m3-primary/40 shadow-m3-3 text-xs font-medium flex items-center space-x-2.5"
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  toast.type === 'error' ? 'bg-red-400' : 'bg-m3-primary'
                }`}
              />
              <span>{toast.message}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
    </MotionConfig>
  );
};

export default App;
