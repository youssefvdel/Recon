import React, { useState, useEffect } from 'react';
import { Overview } from './Overview';
import { MatchHistory } from './MatchHistory';
import { TrackerMaps } from './TrackerMaps';
import { TrackerAgents } from './TrackerAgents';
import { LiveMatchView } from './LiveMatchView';
import { motion, AnimatePresence } from 'framer-motion';

export type TrackerSubTab = 'overview' | 'live' | 'matches' | 'agents' | 'maps';

interface SubTabItem {
  id: TrackerSubTab;
  label: string;
}

const TABS: SubTabItem[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'matches', label: 'Matches' },
  { id: 'agents', label: 'Agents' },
  { id: 'maps', label: 'Maps' },
  { id: 'live', label: 'Live Match' },
];

export const TrackerView: React.FC<{ initialSubTab?: TrackerSubTab; liveRequest?: number }> = ({
  initialSubTab = 'overview',
  liveRequest = 0,
}) => {
  const [subTab, setSubTab] = useState<TrackerSubTab>(() => {
    try {
      const saved = localStorage.getItem('recon_active_subtab') as TrackerSubTab;
      if (saved && ['overview', 'live', 'matches', 'agents', 'maps'].includes(saved)) {
        return saved;
      }
    } catch {}
    return initialSubTab;
  });

  useEffect(() => {
    if (initialSubTab) {
      setSubTab(initialSubTab);
    }
  }, [initialSubTab]);

  // Jump requests from the TopBar LIVE pill: land straight on Live Match.
  useEffect(() => {
    if (liveRequest > 0) setSubTab('live');
  }, [liveRequest]);

  useEffect(() => {
    try {
      localStorage.setItem('recon_active_subtab', subTab);
    } catch {}
  }, [subTab]);

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden bg-m3-surface">
      {/* Material 3 Tab Row Navigation */}
      <nav className="flex items-center gap-1 sm:gap-2 px-4 sm:px-6 bg-m3-surface-container-low border-b border-m3-outline-subtle h-11 shrink-0 select-none z-10">
        {TABS.map((t) => {
          const active = subTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id)}
              className={`relative h-full px-3.5 sm:px-4 flex items-center justify-center text-xs sm:text-[13px] font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                active ? 'text-m3-primary font-bold font-display' : 'text-m3-outline hover:text-m3-on-surface'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <span>{t.label}</span>
                {t.id === 'live' && (
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)]" />
                  </span>
                )}
              </span>
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

      {/* Tab Content Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <AnimatePresence mode="wait">
          {subTab === 'overview' && (
            <motion.div key="overview" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <Overview />
            </motion.div>
          )}

          {subTab === 'live' && (
            <motion.div key="live" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <LiveMatchView />
            </motion.div>
          )}

          {subTab === 'matches' && (
            <motion.div key="matches" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <MatchHistory />
            </motion.div>
          )}

          {subTab === 'agents' && (
            <motion.div key="agents" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <TrackerAgents />
            </motion.div>
          )}

          {subTab === 'maps' && (
            <motion.div key="maps" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
              <TrackerMaps />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
