import { useEffect, useState } from 'react';
import {
  Cpu,
  Monitor,
  Settings,
  TrendingUp,
  FileCode2,
  ShoppingBag,
  Crosshair,
  Users,
  UserCheck,
} from 'lucide-react';
import type { DisplayInfo, GpuInfo, TabType } from '../types';
import { TrackerMini } from './TrackerMini';
import { APP_VERSION, appVersion } from '../utils/version';

interface SidebarTab {
  id: TabType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface SidebarProps {
  currentTab: TabType;
  onSelectTab: (tab: TabType) => void;
  displayInfo: DisplayInfo | null;
  gpuInfo: GpuInfo | null;
  hasUpdate?: boolean;
  onOpenUpdates?: () => void;
}

/* Tracker group — keyless Riot data, zero signup. */
const TRACKER_TABS: SidebarTab[] = [
  {
    id: 'overview',
    label: 'Tracker',
    icon: TrendingUp,
  },
];

/* Store group — the account's daily shop, live from Riot. */
const STORE_TABS: SidebarTab[] = [
  {
    id: 'store',
    label: 'Store',
    icon: ShoppingBag,
  },
];

/* Crosshair group — recolor any profile to any color, live from the client. */
const CROSSHAIR_TABS: SidebarTab[] = [
  {
    id: 'crosshair',
    label: 'Crosshair',
    icon: Crosshair,
  },
];

/* Pre-Picker group — auto-hover agent per map safely in agent select. */
const PREPICK_TABS: SidebarTab[] = [
  {
    id: 'prepick',
    label: 'Pre-Picker',
    icon: UserCheck,
  },
];

/* Accounts group — quick-switch Riot logins, snapshots live in Rust. */
const ACCOUNTS_TABS: SidebarTab[] = [
  {
    id: 'accounts',
    label: 'Accounts',
    icon: Users,
  },
];

/* Utility group — resolution toggle and stretch simulator. */
const UTILITY_TABS: SidebarTab[] = [
  {
    id: 'switcher',
    label: 'Resolution Switch',
    icon: Monitor,
  },
];

/* Config group — stretch setup, Valorant config editor, and GPU scaling. */
const CONFIG_TABS: SidebarTab[] = [
  {
    id: 'game_config',
    label: 'Game Config',
    icon: FileCode2,
  },
];

/* Application Settings group — software updater, auto-start, system tray. */
const SETTINGS_TABS: SidebarTab[] = [
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
  },
];

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  displayInfo,
  gpuInfo,
  hasUpdate,
}) => {
  const isStretched = displayInfo?.active_profile === 'stretched';
  const [appVer, setAppVer] = useState(APP_VERSION);

  // Primary GPU only — multi-adapter strings ("RTX 3080 (+ Radeon…)") stretch the card.
  const shortGpu = (gpuInfo?.name ?? '')
    .split(/[+|/(]/)[0]
    .replace('NVIDIA ', '')
    .replace('GeForce ', '')
    .replace('AMD ', '')
    .trim();

  useEffect(() => {
    appVersion().then(setAppVer);
  }, []);

  const allTabs: SidebarTab[] = [
    ...TRACKER_TABS,
    ...STORE_TABS,
    ...CROSSHAIR_TABS,
    ...PREPICK_TABS,
    ...UTILITY_TABS,
    ...CONFIG_TABS,
    ...ACCOUNTS_TABS,
    ...SETTINGS_TABS,
  ];

  return (
    <aside className="w-72 min-w-72 max-w-72 h-full bg-m3-surface-container-low border-r border-m3-outline-subtle flex flex-col justify-between select-none shrink-0 z-30 overflow-hidden">
      {/* Brand & Top Section */}
      <div className="flex flex-col min-h-0 flex-1 overflow-y-auto custom-scrollbar">
        {/* App Identity */}
        <div className="p-4 sm:p-5 border-b border-m3-outline-subtle flex items-center justify-between">
          <div className="flex items-center space-x-3 min-w-0">
            <img
              src="/icon.png"
              alt="Recon"
              className="w-10 h-10 object-contain shrink-0 drop-shadow-[0_4px_12px_rgba(208,188,255,0.25)]"
            />
            <div className="min-w-0">
              <div className="flex items-center space-x-1">
                <span className="font-display font-black text-xl tracking-tight text-m3-on-surface truncate">
                  Recon
                </span>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onSelectTab('settings')}
            title={hasUpdate ? "New update available — click to open Settings" : `Recon v${appVer}`}
            className={`shrink-0 relative px-2.5 py-0.5 text-[10px] font-mono font-semibold rounded-full flex items-center gap-1.5 transition-all cursor-pointer ${
              hasUpdate
                ? 'text-m3-on-primary bg-m3-primary shadow-sm hover:opacity-90 animate-pulse'
                : 'text-m3-primary bg-m3-primary-container/50 hover:bg-m3-primary/20 border border-m3-primary/40'
            }`}
          >
            {hasUpdate && (
              <span className="w-1.5 h-1.5 rounded-full bg-m3-on-primary" />
            )}
            <span>v{appVer}</span>
            {hasUpdate && (
              <span className="text-[9px] uppercase font-bold tracking-wider">UPDATE</span>
            )}
          </button>
        </div>

        {/* Player Profile Card (TrackerMini) */}
        <div className="pt-2 shrink-0">
          <TrackerMini />
        </div>

        {/* Navigation Tabs List (Clean M3 Navigation Rail with Pill Items) */}
        <nav className="px-3 pt-1 space-y-1">
          {allTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive =
              tab.id === currentTab ||
              (tab.id === 'overview' && (currentTab === 'overview' || currentTab === 'matches')) ||
              (tab.id === 'switcher' && (currentTab === 'switcher' || currentTab === 'visualizer' || currentTab === 'borderless')) ||
              (tab.id === 'game_config' && (currentTab === 'game_config' || currentTab === 'valorant' || currentTab === 'gpu')) ||
              (tab.id === 'settings' && currentTab === 'settings');
            return (
              <button
                key={tab.id}
                onClick={() => onSelectTab(tab.id)}
                className={`relative w-full group flex items-center justify-between px-3 py-2 rounded-full text-left transition-all duration-150 cursor-pointer ${
                  isActive
                    ? 'bg-m3-primary-container text-m3-on-primary-container shadow-m3-1'
                    : 'text-m3-on-surface-variant hover:bg-m3-surface-container/60 hover:text-m3-on-surface'
                }`}
              >
                <div className="flex items-center space-x-2.5 min-w-0">
                  <Icon
                    className={`w-4 h-4 shrink-0 transition-colors ${
                      isActive
                        ? 'text-m3-primary'
                        : 'text-m3-outline group-hover:text-m3-on-surface'
                    }`}
                  />
                  <div
                    className={`text-xs font-semibold leading-tight truncate ${
                      isActive ? 'text-m3-on-primary-container font-display' : 'text-m3-on-surface-variant'
                    }`}
                  >
                    {tab.label}
                  </div>
                </div>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Sidebar Footer: Active Display */}
      <div className="flex flex-col shrink-0 p-3 border-t border-m3-outline-subtle bg-m3-surface-container-lowest/30">
        <div className="p-3 rounded-2xl bg-m3-surface-container border border-m3-outline-subtle flex flex-col space-y-2 shadow-m3-1 overflow-hidden">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-m3-on-surface-variant font-medium flex items-center gap-1.5 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-m3-primary shadow-[0_0_6px_rgba(208,188,255,0.7)]" />
              <span>Active Display</span>
            </span>
            <span
              className={`text-[10px] font-mono font-semibold uppercase px-2 py-0.5 rounded-full whitespace-nowrap leading-relaxed ${
                isStretched
                  ? 'bg-m3-tertiary text-m3-on-tertiary shadow-sm'
                  : 'bg-m3-surface-container-high text-m3-secondary border border-m3-outline-subtle'
              }`}
            >
              {isStretched ? '1.45:1 Stretched' : 'Native 16:9'}
            </span>
          </div>

          {displayInfo && (
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-display font-bold text-m3-on-surface tabular-nums text-sm whitespace-nowrap">
                {displayInfo.current_width}×{displayInfo.current_height}
              </span>
              <span className="font-mono text-m3-primary tabular-nums text-xs font-semibold px-2 py-0.5 rounded-full bg-m3-surface-container-high border border-m3-outline-subtle whitespace-nowrap leading-relaxed">
                {displayInfo.current_hz} Hz
              </span>
            </div>
          )}

          {shortGpu && (
            <div
              className="flex items-center gap-1.5 text-[11px] text-m3-on-surface-variant pt-2 border-t border-m3-outline-subtle/60 min-w-0"
              title={gpuInfo?.name}
            >
              <Cpu className="w-3.5 h-3.5 text-m3-outline shrink-0" />
              <span className="truncate font-medium min-w-0 leading-relaxed">
                {shortGpu}
              </span>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};
