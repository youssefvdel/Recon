import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UnifiedStretch } from './UnifiedStretch';
import { ResolutionVisualizer } from './ResolutionVisualizer';
import { Settings as StretchSetup } from './Settings';
import { HardwareScaling } from './HardwareScaling';
import type { DisplayInfo, GpuInfo, ShortcutBinding } from '../types';

export type UtilitySubTab = 'switcher' | 'visualizer' | 'setup' | 'gpu';

interface UtilityViewProps {
  initialSubTab?: UtilitySubTab;
  displayInfo: DisplayInfo | null;
  gpuInfo: GpuInfo | null;
  shortcut?: ShortcutBinding | null;
  preferredStretched?: [number, number];
  onToggle: () => Promise<void>;
  onApplyResolution: (w: number, h: number, hz: number) => Promise<void>;
  onSaveShortcut: (binding: ShortcutBinding) => Promise<void>;
  onStretchResChanged: (w: number, h: number) => void;
  onRefreshDisplayInfo: () => void;
  onOpenControlPanel: (vendor: string) => Promise<void>;
  isLoading: boolean;
}

const SUBTABS: { id: UtilitySubTab; label: string }[] = [
  { id: 'switcher', label: 'Resolution Switch' },
  { id: 'visualizer', label: 'Stretch Preview' },
  { id: 'setup', label: 'Stretch Setup' },
  { id: 'gpu', label: 'GPU Scaling' },
];

export const UtilityView: React.FC<UtilityViewProps> = ({
  initialSubTab = 'switcher',
  displayInfo,
  gpuInfo,
  shortcut,
  preferredStretched,
  onToggle,
  onApplyResolution,
  onSaveShortcut,
  onStretchResChanged,
  onRefreshDisplayInfo,
  onOpenControlPanel,
  isLoading,
}) => {
  const [subTab, setSubTab] = useState<UtilitySubTab>(initialSubTab);

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden bg-m3-surface">
      {/* Material 3 Tab Row Navigation */}
      <nav className="flex items-center gap-1 sm:gap-2 px-4 sm:px-6 bg-m3-surface-container-low border-b border-m3-outline-subtle h-11 shrink-0 select-none z-10">
        {SUBTABS.map((t) => {
          const active = subTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id)}
              className={`relative h-full px-3.5 sm:px-4 flex items-center justify-center text-xs sm:text-[13px] font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                active ? 'text-m3-primary font-bold font-display' : 'text-m3-outline hover:text-m3-on-surface'
              }`}
            >
              <span>{t.label}</span>
              <span
                className={`absolute -bottom-px left-2 right-2 h-[2.5px] rounded-full transition-all duration-150 pointer-events-none ${
                  active
                    ? 'bg-m3-primary opacity-100 shadow-[0_0_8px_rgba(182,171,247,0.5)]'
                    : 'bg-transparent opacity-0 scale-x-75'
                }`}
              />
            </button>
          );
        })}
      </nav>

      {/* Content Area */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 sm:px-6 py-3.5 pb-8">
        <div className="max-w-6xl mx-auto h-full w-full">
          <AnimatePresence mode="wait">
            {subTab === 'switcher' && (
              <motion.div key="switcher" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
                <UnifiedStretch
                  displayInfo={displayInfo}
                  shortcut={shortcut ?? null}
                  preferredStretched={preferredStretched}
                  onToggle={onToggle}
                  onApplyResolution={onApplyResolution}
                  onSaveShortcut={onSaveShortcut}
                  isLoading={isLoading}
                />
              </motion.div>
            )}

            {subTab === 'visualizer' && (
              <motion.div key="visualizer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
                <ResolutionVisualizer
                  displayInfo={displayInfo}
                  onApplyResolution={onApplyResolution}
                />
              </motion.div>
            )}

            {subTab === 'setup' && (
              <motion.div key="setup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
                <StretchSetup
                  displayInfo={displayInfo}
                  onStretchResChanged={onStretchResChanged}
                  onRefreshDisplayInfo={onRefreshDisplayInfo}
                />
              </motion.div>
            )}

            {subTab === 'gpu' && (
              <motion.div key="gpu" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
                <HardwareScaling
                  gpuInfo={gpuInfo}
                  onOpenControlPanel={onOpenControlPanel}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};
