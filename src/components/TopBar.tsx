import React, { useEffect, useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Eye,
  Cpu,
  Settings,
  Wand2,
  Crosshair,
  FileCode2,
  FlaskConical,
  Minus,
  Square,
  Copy,
  X,
  TrendingUp,
  Monitor,
  RefreshCw,
  Coffee,
  ShoppingBag,
  Users,
  UserCheck,
  MessageSquare,
} from 'lucide-react';
import type { DisplayInfo, GpuInfo, TabType } from '../types';
import {
  appMinimize,
  appToggleMaximize,
  appClose,
  appStartDragging,
  appIsMaximized,
  openDevWindow,
  openExternalUrl,
  isTauri,
} from '../utils/ipc';
import { IS_DEV } from '../utils/devTools';
import { performGlobalRefresh } from '../hooks/useTrackerData';
import { isTrackerEnabled } from '../utils/trn';
import { peekLiveMatchState } from '../utils/tracker';
import type { LiveMatchState } from '../types';
import { listen } from '@tauri-apps/api/event';

interface TopBarProps {
  currentTab: TabType;
  displayInfo: DisplayInfo | null;
  gpuInfo: GpuInfo | null;
  shortcut?: import('../types').ShortcutBinding | null;
  onToggleProfile?: () => void;
  isLoading?: boolean;
  hasUpdate?: boolean;
  onOpenUpdates?: () => void;
}

const TAB_METADATA: Record<
  TabType,
  {
    title: string;
    description: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  switcher: {
    title: 'Resolution Switch + Borderless',
    description: 'Toggle stretched / native and make game borderless — single grid',
    icon: Monitor,
  },
  visualizer: {
    title: 'Stretch & Hitbox Preview',
    description: 'Interactive simulator showing enemy model widening (+22.5% hitbox) and FOV',
    icon: Eye,
  },
  sens: {
    title: 'Sensitivity Match',
    description: 'Stretch-compensated sens + eDPI so aim feels identical',
    icon: Crosshair,
  },
  custom_res: {
    title: 'Custom Resolution & Safe Tester',
    description: 'Hardware resolution generator with 15s auto-revert protection and native driver scaling',
    icon: Wand2,
  },
  gpu: {
    title: 'Fix Black Bars (GPU Scaler)',
    description: 'One-click full-screen hardware scaling and letterbox clamp removal',
    icon: Cpu,
  },
  borderless: {
    title: 'Resolution Switch + Borderless',
    description: 'Merged into switcher grid — alias view',
    icon: Monitor,
  },
  game_config: {
    title: 'Game Config — Stretch & Valorant Setup',
    description: 'Customize stretch targets, edit Valorant config files, and manage GPU scaling',
    icon: FileCode2,
  },
  settings: {
    title: 'Application Settings',
    description: 'Software updates, Windows startup preferences, and system tray configuration',
    icon: Settings,
  },
  valorant: {
    title: 'Valorant Config — Customize + Verify',
    description: 'Per-profile fullscreen, letterbox, resolution editor with on-disk verification',
    icon: FileCode2,
  },
  overview: {
    title: 'Valorant Tracker',
    description: 'Overview, match history, performance, agents, and maps — live from Riot + TRN',
    icon: TrendingUp,
  },
  matches: {
    title: 'Valorant Tracker',
    description: 'Overview, match history, performance, agents, and maps — live from Riot + TRN',
    icon: TrendingUp,
  },
  store: {
    title: 'Account Store',
    description: 'Daily offers, accessories, and featured bundle — live from Riot',
    icon: ShoppingBag,
  },
  crosshair: {
    title: 'Crosshair',
    description: 'Recolor any crosshair profile to any color — saved server-side',
    icon: Crosshair,
  },
  prepick: {
    title: 'Agent Pre-Picker',
    description: 'Instant hover + timed lock-in, per map or a global default',
    icon: UserCheck,
  },
  chat: {
    title: 'Riot Chat',
    description: "The Riot Client's own friends list, requests and messages",
    icon: MessageSquare,
  },
  accounts: {
    title: 'Accounts',
    description: 'Quick-switch Riot logins — snapshots stay on this PC',
    icon: Users,
  },
  dev: {
    title: 'Dev Dashboard',
    description: 'Dev-builds only — simulators, IPC smoke tests, backend event log',
    icon: FlaskConical,
  },
};


export const TopBar: React.FC<TopBarProps> = ({
  currentTab,
}) => {
  const meta = TAB_METADATA[currentTab];
  const Icon = meta.icon;
  const [isMaximized, setIsMaximized] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [trackerOn, setTrackerOn] = useState<boolean>(() => {
    try {
      return isTrackerEnabled();
    } catch {
      return true;
    }
  });
  const [showClove, setShowClove] = useState(false);
  const [dodgeOffset, setDodgeOffset] = useState({ x: 0, y: 0 });
  const [dodgeCount, setDodgeCount] = useState(0);
  const [liveActive, setLiveActive] = useState(false);

  // Live-match shortcut: surface a jump pill next to APIs Ready while a
  // pregame/coregame lobby exists. Driven by the shared live-match sync bus.
  useEffect(() => {
    let alive = true;
    const isLive = (s: LiveMatchState | null | undefined): boolean =>
      !!s && (s.phase === 'pregame' || s.phase === 'coregame') && (s.blueTeam.length > 0 || s.redTeam.length > 0);
    try {
      if (alive) setLiveActive(isLive(peekLiveMatchState()));
    } catch {}
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      listen<LiveMatchState>('recon:live-match-sync', (event) => {
        if (alive && event.payload) setLiveActive(isLive(event.payload));
      })
        .then((fn) => {
          unlisten = fn;
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
      if (unlisten) unlisten();
    };
  }, []);

  const handleGotoLive = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('recon:goto-live'));
  };
  const cloveRef = useRef<HTMLDivElement>(null);
  const coffeeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const tick = () => {
      // Same existing 1s tick — no new intervals. Surfaces the kill-switch
      // flipped on the Dev QA page. (Cooldown countdown pill removed: the
      // mechanism runs silently; users never see seconds.)
      try {
        setTrackerOn(isTrackerEnabled());
      } catch {}
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const handleXDodge = () => {
    if (dodgeCount < 3) {
      setDodgeCount((c) => c + 1);
      // Playfully jump/scramble away from the cursor
      const randX = (Math.random() > 0.5 ? 1 : -1) * (26 + Math.floor(Math.random() * 30));
      const randY = (Math.random() > 0.5 ? 1 : -1) * (18 + Math.floor(Math.random() * 22));
      setDodgeOffset({ x: randX, y: randY });
    }
  };

  useEffect(() => {
    if (showClove) {
      setDodgeOffset({ x: 0, y: 0 });
      setDodgeCount(0);
    }
  }, [showClove]);

  // Option A: delayed milestone trigger (3 minutes after app start)
  useEffect(() => {
    const dismissedUntil = Number(localStorage.getItem('recon_clove_coffee_dismissed_until') || 0);
    if (Date.now() < dismissedUntil) return;
    const timer = setTimeout(() => {
      setShowClove(true);
    }, 3 * 60 * 1000);
    return () => clearTimeout(timer);
  }, []);

  // Listen for dev trigger or custom trigger to test Clove donation popup
  useEffect(() => {
    const onTrigger = () => setShowClove(true);
    window.addEventListener('recon:trigger-clove-donation', onTrigger);
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'recon_dev_trigger_clove') setShowClove(true);
    };
    window.addEventListener('storage', onStorage);

    let unlistenTauri: (() => void) | null = null;
    if (isTauri()) {
      import('@tauri-apps/api/event').then(({ listen }) => {
        listen('recon:trigger-clove-donation', () => setShowClove(true))
          .then((un) => {
            unlistenTauri = un;
          })
          .catch(() => {});
      }).catch(() => {});
    }

    return () => {
      window.removeEventListener('recon:trigger-clove-donation', onTrigger);
      window.removeEventListener('storage', onStorage);
      if (unlistenTauri) unlistenTauri();
    };
  }, []);

  const handleSnooze = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setShowClove(false);
    // Snooze for 7 days
    localStorage.setItem(
      'recon_clove_coffee_dismissed_until',
      String(Date.now() + 7 * 24 * 60 * 60 * 1000)
    );
  };

  const handleDonate = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setShowClove(false);
    // Snooze for 30 days after donating
    localStorage.setItem(
      'recon_clove_coffee_dismissed_until',
      String(Date.now() + 30 * 24 * 60 * 60 * 1000)
    );
    openExternalUrl('https://ko-fi.com/youssefvdel');
  };

  const handleCoffeeClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowClove((prev) => !prev);
  };

  const checkMaximized = useCallback(() => {
    if (isTauri()) {
      appIsMaximized().then(setIsMaximized).catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    checkMaximized();
    window.addEventListener('resize', checkMaximized);
    window.addEventListener('focus', checkMaximized);
    return () => {
      window.removeEventListener('resize', checkMaximized);
      window.removeEventListener('focus', checkMaximized);
    };
  }, [checkMaximized]);

  const handleStartDrag = (e: React.MouseEvent) => {
    if (e.button === 0 && e.detail < 2) {
      appStartDragging().catch(() => {});
    }
  };

  const handleToggle = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    appToggleMaximize()
      .then(() => {
        setTimeout(checkMaximized, 100);
      })
      .catch(() => {});
  };

  const handleMinimize = (e: React.MouseEvent) => {
    e.stopPropagation();
    appMinimize().catch(() => {});
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    appClose().catch(() => {});
  };

  const handleOpenDevWindow = (e: React.MouseEvent) => {
    e.stopPropagation();
    openDevWindow().catch(() => {});
  };

  const handleGlobalRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await performGlobalRefresh();
    } finally {
      setTimeout(() => setIsRefreshing(false), 600);
    }
  };

  return (
    <header
      data-tauri-drag-region
      onMouseDown={handleStartDrag}
      onDoubleClick={handleToggle}
      className="h-14 px-4 sm:px-6 border-b border-m3-outline-subtle bg-m3-surface/85 backdrop-blur-md flex items-center justify-between shrink-0 select-none z-20 cursor-default relative"
    >
      {/* Active Section Info */}
      <div
        data-tauri-drag-region
        onMouseDown={handleStartDrag}
        className="flex items-center space-x-3 min-w-0 pointer-events-none"
      >
        <div className="w-8 h-8 rounded-xl bg-m3-surface-container-high border border-m3-outline-subtle flex items-center justify-center text-m3-primary shadow-sm shrink-0">
          <Icon className="w-4 h-4" />
        </div>
        <div className="truncate">
          <h1 className="font-display font-bold text-sm sm:text-base text-m3-on-surface leading-tight truncate">
            {meta.title}
          </h1>
        </div>
      </div>

      {/* Draggable center space */}
      <div
        data-tauri-drag-region
        onMouseDown={handleStartDrag}
        className="flex-1 h-full min-w-4"
      />

      {/* Right Controls Container */}
      <div
        className="flex items-center space-x-2.5 shrink-0"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Live-match shortcut: pops in beside APIs Ready while a lobby is live */}
        {liveActive && (
          <button
            type="button"
            onClick={handleGotoLive}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/15 border border-red-400/50 text-red-300 text-[10px] font-mono font-bold cursor-pointer hover:bg-red-500/25 active:scale-95 transition-all"
            title="Live match in progress — jump to Live Match tab"
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-500" />
            </span>
            <span>LIVE</span>
          </button>
        )}
        {/* API Health Indicator (Tracker OFF setting only — cooldowns stay invisible) */}
        {!trackerOn ? (
          <div
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-500/15 border border-zinc-400/40 text-zinc-300 text-[10px] font-mono font-bold"
            title="Tracker kill-switch is OFF (Dev QA page) — TRN requests throw immediately, no network. Distinct from rate-limit cooling."
          >
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-400" />
            <span>Tracker OFF</span>
          </div>
        ) : (
          <div
            className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-m3-surface-container border border-m3-outline-subtle text-[9.5px] font-mono text-m3-outline"
            title="All external APIs (TRN, Blitz & Riot) are connected and healthy"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span>APIs Ready</span>
          </div>
        )}

        {/* Separated Square-Rounded Window Controls */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleGlobalRefresh}
            disabled={isRefreshing}
            className="w-8 h-8 rounded-xl bg-m3-surface-container border border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface hover:bg-m3-surface-container-high hover:border-m3-outline/40 active:scale-95 transition-all flex items-center justify-center cursor-pointer shadow-xs disabled:opacity-50"
            title="Refresh all data & sync live game"
            aria-label="Refresh all data"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-m3-primary' : ''}`} />
          </button>

          {IS_DEV && (
            <button
              onClick={handleOpenDevWindow}
              className="w-8 h-8 rounded-xl bg-m3-surface-container border border-m3-outline-subtle text-m3-primary hover:text-m3-primary hover:bg-m3-surface-container-high hover:border-m3-primary/50 active:scale-95 transition-all flex items-center justify-center cursor-pointer shadow-xs"
              title="Open Dev Dashboard in new window"
              aria-label="Open Dev Dashboard in new window"
            >
              <FlaskConical className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            ref={coffeeBtnRef}
            onClick={handleCoffeeClick}
            className={`w-8 h-8 rounded-xl bg-m3-surface-container border transition-all flex items-center justify-center cursor-pointer shadow-xs group ${
              showClove
                ? 'border-amber-400/80 bg-amber-400/15 text-amber-300'
                : 'border-m3-outline-subtle text-amber-400/90 hover:text-amber-300 hover:bg-amber-400/10 hover:border-amber-400/40 active:scale-95'
            }`}
            title="Support Recon on Ko-fi"
            aria-label="Support Recon on Ko-fi"
          >
            <Coffee className="w-3.5 h-3.5 transition-transform group-hover:-rotate-12" />
          </button>

          <button
            onClick={handleMinimize}
            className="w-8 h-8 rounded-xl bg-m3-surface-container border border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface hover:bg-m3-surface-container-high hover:border-m3-outline/40 active:scale-95 transition-all flex items-center justify-center cursor-pointer shadow-xs"
            title="Minimize"
            aria-label="Minimize"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleToggle}
            className="w-8 h-8 rounded-xl bg-m3-surface-container border border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface hover:bg-m3-surface-container-high hover:border-m3-outline/40 active:scale-95 transition-all flex items-center justify-center cursor-pointer shadow-xs"
            title={isMaximized ? 'Restore' : 'Maximize'}
            aria-label={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? <Copy className="w-3 h-3" /> : <Square className="w-3 h-3" />}
          </button>
          <button
            onClick={handleClose}
            className="w-8 h-8 rounded-xl bg-m3-surface-container border border-m3-outline-subtle text-m3-outline hover:text-white hover:bg-rose-600 hover:border-rose-500 active:scale-95 transition-all flex items-center justify-center cursor-pointer shadow-xs"
            title="Close"
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Cute Clove Chibi Popover (Anchored cleanly below header: top-[58px] right-[106px] — Clove sits directly under Coffee button) */}
      <AnimatePresence>
        {showClove && (
          <div
            ref={cloveRef}
            className="absolute top-[58px] right-[106px] z-50 select-none"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.88, y: -8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: -6 }}
              transition={{ type: 'spring', stiffness: 380, damping: 26 }}
              className="relative flex items-end gap-3 filter drop-shadow-[0_16px_32px_rgba(0,0,0,0.65)]"
            >
              {/* Left: Speech Bubble */}
              <div className="relative w-64 bg-m3-surface-container-high/95 border border-m3-outline-subtle rounded-3xl p-3.5 shadow-2xl backdrop-blur-md flex flex-col gap-2.5">
                {/* Speech Bubble Arrow pointing RIGHT toward Clove's mouth */}
                <div className="absolute bottom-6 -right-1.5 w-3.5 h-3.5 bg-m3-surface-container-high border-t border-r border-m3-outline-subtle transform rotate-45 z-10" />

                {/* Close X button that playfully runs away / dodges on hover */}
                <motion.button
                  onClick={handleSnooze}
                  onMouseEnter={handleXDodge}
                  animate={{ x: dodgeOffset.x, y: dodgeOffset.y }}
                  transition={{ type: 'spring', stiffness: 600, damping: 18 }}
                  className="absolute top-2.5 right-2.5 w-6 h-6 rounded-full bg-m3-surface-container border border-m3-outline hover:bg-rose-600 hover:border-rose-500 hover:text-white text-m3-on-surface flex items-center justify-center transition-colors cursor-pointer shadow-sm z-30"
                  title={dodgeCount < 3 ? "Catch me if you can! 😝" : "Dismiss (snooze 7 days)"}
                  aria-label="Dismiss"
                >
                  <X className="w-3.5 h-3.5" />
                </motion.button>

                {/* Bubble Text */}
                <div className="space-y-1 pr-7 text-left">
                  <h3 className="font-display font-black text-xs text-m3-on-surface leading-tight flex items-center gap-1">
                    <span>Can you buy me a coffee?</span>
                    <span className="text-sm leading-none">🥺☕</span>
                  </h3>
                  <p className="text-[10.5px] text-m3-outline leading-snug">
                    Keeping Recon fast, free, and open-source for everyone!
                  </p>
                </div>

                {/* Single Action Button across bottom */}
                <div className="pt-1 border-t border-m3-outline-subtle/40">
                  <button
                    onClick={handleDonate}
                    className="w-full h-8 px-3 rounded-xl bg-amber-400 hover:bg-amber-300 text-neutral-950 text-xs font-bold transition-all active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 shadow-xs whitespace-nowrap"
                  >
                    <Coffee className="w-3.5 h-3.5 fill-neutral-950/20" />
                    <span>Support on Ko-fi</span>
                  </button>
                </div>
              </div>

              {/* Right: Floating Clove sticker (comfortably below header, feet aligned with bubble) */}
              <motion.div
                animate={{ y: [0, -3, 0], rotate: [0, 1, 0] }}
                transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
                className="relative w-24 h-24 shrink-0 drop-shadow-[0_12px_24px_rgba(244,114,182,0.45)] flex items-center justify-center pointer-events-none self-end mb-1"
              >
                <img
                  src="/clove-coffee.png"
                  alt="Cute Clove"
                  className="w-full h-full object-contain"
                />
              </motion.div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </header>
  );
};
