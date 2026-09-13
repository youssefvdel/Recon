import React, { useCallback, useEffect, useState, useRef } from 'react';
import { Lock as LockIcon, Check, Users, Shield, RotateCcw, Move, X, Trophy, EyeOff, Swords, Clock, AlertTriangle, Layers } from 'lucide-react';
import type { LiveMatchState, LiveMatchPlayer } from '../types';
import { fetchLiveMatchState, gameData, matchEndHarvest, harvestMatchNames, isMatchStateEqual } from '../utils/tracker';
import { useTrackerData } from '../hooks/useTrackerData';
import { ScoreBadge, scoreTier } from './ScoreBadge';
import {
  getFlagUrl,
  getCountryName,
  rankTooltip,
  shortAct,
  formatKd,
  getPartyStyle,
  byAcsDesc,
  queueLabel,
} from '../utils/playerDisplay';
import { computeMapAgentStats, getRankTierLabel, type AgentStatSummary } from '../utils/mapMeta';
import { fetchBlitzAgentStats, peekBlitzAgentStats, type BlitzAgentStat } from '../utils/blitzMeta';
import { getOverlayEditMode, setOverlayEditMode, isTabDown, isTauri } from '../utils/ipc';
import { listen } from '@tauri-apps/api/event';

export interface WidgetPos {
  x: number;
  y: number;
}

export interface OverlayConfig {
  showLobby: boolean;
  showPregame: boolean;
  showTopAgents: boolean;
  showStartingSide?: boolean;
  positions: {
    lobby: WidgetPos;
    pregame: WidgetPos;
    topAgents: WidgetPos;
  };
  scales: {
    lobby: number;
    pregame: number;
    topAgents: number;
  };
}

export function getDefaultOverlayPositions(): OverlayConfig['positions'] {
  const w = typeof window !== 'undefined' ? window.innerWidth : 2088;
  const h = typeof window !== 'undefined' ? window.innerHeight : 1440;

  // Exact coordinates requested:
  // Agent Select (pregame): X: 767, Y: 447
  // Match Status (lobby): X: 22, Y: 654
  // Top Agents (topAgents): X: 1691, Y: 836
  if (w <= 2088 || (w >= 2080 && w <= 2090)) {
    return {
      lobby: { x: 22, y: 654 },
      pregame: { x: 767, y: 447 },
      topAgents: { x: 1691, y: 836 },
    };
  }

  return {
    lobby: {
      x: Math.max(16, Math.round(w * (22 / 2088))),
      y: Math.max(40, Math.round(h * (654 / 1440))),
    },
    pregame: {
      x: Math.max(20, Math.round(w * (767 / 2088))),
      y: Math.max(40, Math.round(h * (447 / 1440))),
    },
    topAgents: {
      x: Math.max(20, Math.round(w * (1691 / 2088))),
      y: Math.max(40, Math.round(h * (836 / 1440))),
    },
  };
}

export function getDefaultOverlayConfig(): OverlayConfig {
  return {
    showLobby: true,
    showPregame: true,
    showTopAgents: true,
    showStartingSide: true,
    positions: getDefaultOverlayPositions(),
    scales: {
      lobby: 1.0,
      pregame: 1.0,
      topAgents: 1.0,
    },
  };
}

export const DEFAULT_OVERLAY_CONFIG: OverlayConfig = getDefaultOverlayConfig();

/* Flag/K-D/party/act helpers live in utils/playerDisplay so the in-app Live
   Match page renders players identically to the overlay widgets. */



const PREVIEW_TOP_AGENTS: AgentStatSummary[] = [
  {
    agent: 'Jett',
    role: 'Duelist',
    matches: 48,
    wins: 30,
    losses: 18,
    winPct: 62.5,
    kd: 1.34,
    hsPct: 28.4,
  },
  {
    agent: 'Omen',
    role: 'Controller',
    matches: 32,
    wins: 19,
    losses: 13,
    winPct: 59.4,
    kd: 1.18,
    hsPct: 22.1,
  },
  {
    agent: 'Sova',
    role: 'Initiator',
    matches: 26,
    wins: 15,
    losses: 11,
    winPct: 57.7,
    kd: 1.12,
    hsPct: 24.6,
  },
  {
    agent: 'Cypher',
    role: 'Sentinel',
    matches: 18,
    wins: 10,
    losses: 8,
    winPct: 55.6,
    kd: 1.08,
    hsPct: 21.8,
  },
];

const PREVIEW_PLAYERS: LiveMatchPlayer[] = [
  {
    puuid: 'p1',
    name: 'You',
    tag: 'EUW',
    team: 'Blue',
    agentId: '',
    agentName: 'Jett',
    agentIcon: 'https://media.valorant-api.com/agents/add6443a-41bd-e414-f6ad-e58d267f4e95/displayicon.png',
    agentRole: 'Duelist',
    tier: 22,
    rank: 'Diamond 2',
    rr: 64,
    peakTier: 24,
    peakRank: 'Ascendant 1',
    peakSeasonId: '8102cd81-43a0-d0d7-bd59-47b8fe9bed1b',
    accountLevel: 142,
    cardId: '',
    isMe: true,
    country: 'DE',
    region: 'EU',
    kd: 1.28,
    winPct: 58,
    hsPct: 28,
    trnScore: 712,
    recentWon: 3,
    recentLost: 1,
    streak: 2,
    streakIsWin: true,
    selectionState: 'locked',
    partyIndex: 1,
  },
  {
    puuid: 'p2',
    name: 'Shadow',
    tag: '1337',
    team: 'Blue',
    agentId: '',
    agentName: 'Omen',
    agentIcon: 'https://media.valorant-api.com/agents/8e253930-4c05-31dd-1b6c-968525494517/displayicon.png',
    agentRole: 'Controller',
    tier: 21,
    rank: 'Diamond 1',
    rr: 38,
    peakTier: 23,
    peakRank: 'Diamond 3',
    accountLevel: 89,
    cardId: '',
    isMe: false,
    country: 'EG',
    region: 'EU',
    kd: 1.05,
    winPct: 52,
    hsPct: 21,
    recentWon: 2,
    recentLost: 2,
    streak: 1,
    selectionState: 'locked',
    partyIndex: 1,
  },
  {
    puuid: 'p3',
    name: 'ViperX',
    tag: 'NA1',
    team: 'Blue',
    agentId: '',
    agentName: 'Viper',
    agentIcon: 'https://media.valorant-api.com/agents/707eab51-4836-f488-046a-cda6bf494859/displayicon.png',
    agentRole: 'Controller',
    tier: 20,
    rank: 'Platinum 3',
    rr: 82,
    peakTier: 22,
    peakRank: 'Diamond 2',
    accountLevel: 210,
    cardId: '',
    isMe: false,
    country: 'FR',
    region: 'EU',
    kd: 0.94,
    winPct: 49,
    hsPct: 18,
    recentWon: 1,
    recentLost: 3,
    streak: 0,
    selectionState: 'selected',
    partyIndex: 0,
    isIncognito: true,
  },
  {
    puuid: 'p4',
    name: 'SovaGod',
    tag: 'DART',
    team: 'Blue',
    agentId: '',
    agentName: 'Sova',
    agentIcon: 'https://media.valorant-api.com/agents/320b2a48-4d9b-a075-30f1-1f93a9b638fa/displayicon.png',
    agentRole: 'Initiator',
    tier: 23,
    rank: 'Diamond 3',
    rr: 45,
    peakTier: 25,
    peakRank: 'Ascendant 2',
    accountLevel: 178,
    cardId: '',
    isMe: false,
    country: 'UK',
    region: 'EU',
    kd: 1.18,
    winPct: 56,
    hsPct: 24,
    recentWon: 4,
    recentLost: 1,
    streak: 3,
    selectionState: 'locked',
    partyIndex: 2,
  },
  {
    puuid: 'p5',
    name: 'CypherWire',
    tag: 'TRAP',
    team: 'Blue',
    agentId: '',
    agentName: 'Cypher',
    agentIcon: 'https://media.valorant-api.com/agents/117ed9e3-49f3-6512-3ccf-0cada7e3823b/displayicon.png',
    agentRole: 'Sentinel',
    tier: 22,
    rank: 'Diamond 2',
    rr: 15,
    peakTier: 23,
    peakRank: 'Diamond 3',
    accountLevel: 95,
    cardId: '',
    isMe: false,
    country: 'IT',
    region: 'EU',
    kd: 1.10,
    winPct: 53,
    hsPct: 22,
    recentWon: 3,
    recentLost: 2,
    streak: 1,
    selectionState: 'selected',
    partyIndex: 2,
  },
];

const PREVIEW_OPPONENTS: LiveMatchPlayer[] = [
  {
    puuid: 'r1',
    name: 'ReynaMain',
    tag: 'EUW',
    team: 'Red',
    agentId: '',
    agentName: 'Reyna',
    agentIcon: '',
    agentRole: 'Duelist',
    tier: 23,
    rank: 'Diamond 3',
    rr: 51,
    peakTier: 25,
    peakRank: 'Ascendant 2',
    accountLevel: 167,
    cardId: '',
    isMe: false,
    selectionState: 'locked',
    country: 'ES',
    region: 'EU',
    kd: 1.42,
  },
  {
    puuid: 'r2',
    name: 'Silent',
    tag: '007',
    team: 'Red',
    agentId: '',
    agentName: 'Selecting…',
    agentIcon: '',
    agentRole: '',
    tier: 20,
    rank: 'Platinum 3',
    rr: 12,
    peakTier: 21,
    peakRank: 'Diamond 1',
    accountLevel: 74,
    cardId: '',
    isMe: false,
    selectionState: '',
    country: 'IT',
    region: 'EU',
    kd: 0.98,
  },
  {
    puuid: 'r3',
    name: 'Headshot',
    tag: 'HS',
    team: 'Red',
    agentId: '',
    agentName: 'Cypher',
    agentIcon: '',
    agentRole: 'Sentinel',
    tier: 22,
    rank: 'Diamond 2',
    rr: 77,
    peakTier: 24,
    peakRank: 'Ascendant 1',
    accountLevel: 198,
    cardId: '',
    isMe: false,
    selectionState: 'selected',
    country: 'TR',
    region: 'EU',
    kd: 1.15,
  },
];

export const OverlayView: React.FC = () => {
  const [matchState, setMatchState] = useState<LiveMatchState | null>(null);
  const [tierIcons, setTierIcons] = useState<Record<number, string>>({});
  const [agentMap, setAgentMap] = useState<Record<string, { name: string; icon: string; role: string }>>({});
  const [seasonNames, setSeasonNames] = useState<Record<string, string>>({});
  const [viewMode, setViewMode] = useState<'auto' | 'personal' | 'blitz'>('auto');

  // Edit mode state (synced with main app)
  const [isEditMode, setIsEditMode] = useState<boolean>(false);
  const [, setActiveDragKey] = useState<string | null>(null);

  // Tab-held peek state: in-match scoreboard shows ONLY while Tab is physically held.
  // The click-through overlay never gets keyboard focus, so this is fed by the
  // OS-level GetAsyncKeyState probe — never by JS key listeners.
  const [tabHeld, setTabHeld] = useState<boolean>(false);

  // Widget config + positions (persisted)
  const [config, setConfig] = useState<OverlayConfig>(() => {
    const MIGRATION_KEY = 'recon_overlay_cfg_v7_defaults';
    const mergeSaved = (saved: string | null) => {
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      return {
        ...DEFAULT_OVERLAY_CONFIG,
        ...parsed,
        positions: { ...DEFAULT_OVERLAY_CONFIG.positions, ...(parsed.positions || {}) },
        scales: { ...DEFAULT_OVERLAY_CONFIG.scales, ...(parsed.scales || {}) },
      } as OverlayConfig;
    };
    try {
      // Read the saved layout FIRST: writing defaults before reading (as an
      // earlier revision did) wipes custom widget positions/scales.
      const saved = localStorage.getItem('recon_overlay_cfg_v7') || localStorage.getItem('recon_overlay_cfg_v6') || localStorage.getItem('recon_overlay_cfg_v5');
      if (!localStorage.getItem(MIGRATION_KEY)) {
        localStorage.setItem(MIGRATION_KEY, '1');
        const merged = mergeSaved(saved);
        localStorage.setItem('recon_overlay_cfg_v7', JSON.stringify(merged ?? DEFAULT_OVERLAY_CONFIG));
        return merged ?? DEFAULT_OVERLAY_CONFIG;
      }
      const merged = mergeSaved(saved);
      if (merged) return merged;
    } catch {}
    return DEFAULT_OVERLAY_CONFIG;
  });

  const saveConfig = (next: OverlayConfig) => {
    setConfig(next);
    try {
      localStorage.setItem('recon_overlay_cfg_v7', JSON.stringify(next));
    } catch {}
  };

  const { detailsById, mapById, profile, trnAgents, trnMaps } = useTrackerData();

  const activeMapName =
    matchState && matchState.phase !== 'idle' && matchState.mapName && matchState.mapName !== 'No Match Active' && matchState.mapName !== 'Live Match Status'
      ? matchState.mapName
      : 'Ascent';

  const normActiveMap = activeMapName.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Local match details cover only the last ~20 games, so a per-map slice is
  // 1-2 games — useless on its own. Keep it purely to enrich K/D and HS% on the
  // agents we also see in TRN.
  const localMapStats = computeMapAgentStats(
    activeMapName,
    detailsById || {},
    mapById || {},
    profile?.puuid
  );

  // AUTHORITATIVE source for "my agents on this map": TRN's act-wide per-map
  // segment, which carries the real match count + win rate per agent.
  const trnMap = (trnMaps ?? []).find((m) => {
    const n = m.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return n === normActiveMap || n.includes(normActiveMap) || normActiveMap.includes(n);
  });

  const mapScopedStats: AgentStatSummary[] = (trnMap?.topAgents ?? [])
    .filter((a) => a.matches > 0)
    .map((a) => {
      const local = localMapStats.find((s) => s.agent.toLowerCase() === a.name.toLowerCase());
      const wins = Math.round((a.winPct / 100) * a.matches);
      return {
        agent: a.name,
        role: local?.role,
        matches: a.matches,
        wins,
        losses: Math.max(0, a.matches - wins),
        winPct: Number(a.winPct.toFixed(1)),
        kd: local?.kd ?? 0,
        hsPct: local?.hsPct ?? 0,
      };
    })
    .sort((a, b) => b.matches - a.matches || b.winPct - a.winPct);

  // 2. The player's REAL agent pool across every map (act-wide), so we never
  //    pretend they have no history just because this map is new to them.
  const overallAgentStats: AgentStatSummary[] = (trnAgents ?? [])
    .filter((a) => a.matches > 0)
    .map((a) => ({
      agent: a.agent,
      role: a.role,
      matches: a.matches,
      wins: a.wins,
      losses: a.losses,
      winPct: Number(a.winPct.toFixed(1)),
      kd: Number(a.kd.toFixed(2)),
      hsPct: Number((a.hsPct ?? 0).toFixed(0)),
    }))
    .sort((a, b) => b.matches - a.matches || b.winPct - a.winPct);

  // Scope of the personal view: this map's real record, else their whole pool.
  const mapGames = trnMap?.matchesPlayed ?? localMapStats.reduce((n, s) => n + s.matches, 0);
  const hasMapHistory = mapScopedStats.length > 0;
  const personalStats: AgentStatSummary[] = hasMapHistory ? mapScopedStats : overallAgentStats;
  const personalScope: 'map' | 'all' | 'preview' =
    hasMapHistory ? 'map' : overallAgentStats.length > 0 ? 'all' : 'preview';
  const thinMapSample = !hasMapHistory && mapGames > 0;

  // 3. Does the player have an agent they actually win with here?
  const hasWinningAgentOnMap = mapScopedStats.some((s) => s.matches >= 2 && s.winPct >= 50);

  // 4. Live rank-tuned map meta from Blitz (this map, this rank). Replaces the
  //    hardcoded table, which was stale within a patch or two.
  // One tier const for label + fetch + peek: the label must never claim a
  // Diamond meta while the fetch runs the unranked slice (or vice versa).
  const userTier = profile?.tier || 0;
  const metaTier = userTier || 22;
  const rankTierLabel = getRankTierLabel(metaTier);
  const [metaPicks, setMetaPicks] = useState<BlitzAgentStat[]>(
    () => peekBlitzAgentStats(activeMapName, metaTier) ?? []
  );

  useEffect(() => {
    let alive = true;
    fetchBlitzAgentStats(activeMapName, metaTier).then((rows) => {
      // Keep the last good list if Blitz is unreachable or has no sample.
      if (alive && rows.length > 0) setMetaPicks(rows);
    });
    return () => {
      alive = false;
    };
  }, [activeMapName, metaTier]);

  // Agent select is the one moment a suggestion is actionable — and the HUD is
  // click-through while the overlay is locked, so a toggle the user has to click
  // would NEVER be reachable in-game. The recommendation is therefore the
  // default view, and the toggle exists only to get back to your own numbers
  // while editing.
  const hasMetaForMap = metaPicks.length > 0;
  const showMetaPicks = hasMetaForMap && viewMode !== 'personal';

  // Never fabricate: the preview list only appears when there is no account data
  // at all (dev mock / signed-out), never as a stand-in for missing map games.
  const topAgentsList: AgentStatSummary[] =
    personalStats.length > 0 ? personalStats : PREVIEW_TOP_AGENTS;

  const personalListCount = personalStats.length;

  // Direct element references for GPU hardware-accelerated zero-lag dragging
  const rootRef = useRef<HTMLDivElement>(null);
  const lobbyRef = useRef<HTMLDivElement>(null);
  const pregameRef = useRef<HTMLDivElement>(null);
  const topAgentsRef = useRef<HTMLDivElement>(null);

  const widgetRefs = {
    lobby: lobbyRef,
    pregame: pregameRef,
    topAgents: topAgentsRef,
  };

  // Native DWM message handling strips non-client borders natively.
  const forceRepaint = useCallback(() => {}, []);

  // Sync edit mode and config changes from main app
  useEffect(() => {
    getOverlayEditMode().then(setIsEditMode).catch(() => {});
    // Fresh mounts (HMR reload, navigation, first show) start from a blank
    // surface with nothing dirtying transparent regions — repaint now and
    // once more after first paint settles, or stale white survives.
    forceRepaint();
    const mountRepaint = setTimeout(forceRepaint, 600);
    const unlistenEdit = listen<boolean>('overlay-edit-mode-changed', (event) => {
      setIsEditMode(event.payload);
      forceRepaint();
    });
    const unlistenCfg = listen<OverlayConfig>('overlay-config-changed', (event) => {
      setConfig(event.payload);
    });
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'recon_overlay_cfg_v7' && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          setConfig((prev) => ({ ...prev, ...parsed }));
        } catch {}
      }
    };
    window.addEventListener('storage', onStorage);
    // Resolution switches realloc DWM surfaces — repaint once it settles.
    const unlistenDisp = listen<unknown>('display-mode-changed', () => {
      setTimeout(forceRepaint, 350);
    });
    return () => {
      clearTimeout(mountRepaint);
      window.removeEventListener('storage', onStorage);
      unlistenEdit.then((fn) => fn()).catch(() => {});
      unlistenCfg.then((fn) => fn()).catch(() => {});
      unlistenDisp.then((fn) => fn()).catch(() => {});
    };
  }, [forceRepaint]);

  // Poll live match data ONLY when visible; idle backs off to ~1/3 rate
  // (agent select lasts ~60s+, so a 13s worst-case detect delay is fine).
  const phaseRef = useRef<string>('idle');
  const prevStateRef = useRef<LiveMatchState | null>(null);
  const idleSkips = useRef(0);
  const ticking = useRef(false);
  useEffect(() => {
    gameData()
      .then((d) => {
        setTierIcons(d.tierIcons);
        setAgentMap(d.agentInfo || {});
        setSeasonNames(d.seasons || {});
      })
      .catch(() => {});

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      // A slow Riot round-trip must not let setInterval stack overlapping polls.
      if (ticking.current) return;
      if (phaseRef.current === 'idle') {
        idleSkips.current = (idleSkips.current + 1) % 3;
        if (idleSkips.current !== 0) return;
      }
      ticking.current = true;
      fetchLiveMatchState()
        .then((s) => {
          // Match just ended: Riot releases hidden names only now, so ask
          // name-service for the whole lobby and cache them permanently.
          const harvest = matchEndHarvest(prevStateRef.current, s);
          if (harvest) harvestMatchNames(harvest).catch(() => {});
          if (!isMatchStateEqual(prevStateRef.current, s)) {
            prevStateRef.current = s;
            phaseRef.current = s.phase;
            setMatchState(s);
          }
        })
        .catch(() => {})
        .finally(() => {
          ticking.current = false;
        });
    };

    const onVis = () => {
      if (typeof document !== 'undefined' && !document.hidden) tick();
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVis);
    }
    const id = setInterval(tick, 4500);

    const unlistenSync = isTauri()
      ? listen<LiveMatchState>('recon:live-match-sync', (event) => {
          if (event.payload) {
            const s = event.payload;
            const harvest = matchEndHarvest(prevStateRef.current, s);
            if (harvest) harvestMatchNames(harvest).catch(() => {});
            if (!isMatchStateEqual(prevStateRef.current, s)) {
              prevStateRef.current = s;
              phaseRef.current = s.phase;
              setMatchState(s);
            }
          }
        })
      : null;

    return () => {
      clearInterval(id);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVis);
      }
      unlistenSync?.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Tab-peek probe: polls the OS-level Tab state ONLY during a live match
  // (coregame) and only when NOT editing. One cheap IPC per 150ms, zero curl,
  // zero timers when hidden / idle / pregame / edit mode.
  useEffect(() => {
    const inCoregame = matchState?.phase === 'coregame' && !isEditMode;
    if (!inCoregame) {
      setTabHeld(false);
      return;
    }
    let cancelled = false;
    const probe = async () => {
      try {
        const down = await isTabDown();
        if (!cancelled) setTabHeld((prev) => (prev === down ? prev : down));
      } catch {}
    };
    void probe();
    const id = setInterval(probe, 150);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [matchState?.phase, isEditMode]);

  // Esc exits edit mode (overlay holds focus while editing, so the main
  // app's Lock button may be unreachable behind the fullscreen layer).
  useEffect(() => {
    if (!isEditMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void setOverlayEditMode(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isEditMode]);

  // Smooth GPU-composited drag handler with pointer capture
  const startDrag = (
    key: keyof OverlayConfig['positions'],
    e: React.PointerEvent,
    overrideStartPos?: WidgetPos
  ) => {
    if (!isEditMode) return;
    e.preventDefault();
    e.stopPropagation();
    setActiveDragKey(key);

    const dragTarget = e.currentTarget as HTMLElement;
    try {
      dragTarget.setPointerCapture(e.pointerId);
    } catch {}

    const targetEl = widgetRefs[key].current;
    const basePos = overrideStartPos || config.positions[key] || { x: 16, y: 200 };

    let curX = basePos.x;
    let curY = basePos.y;
    const startClientX = e.clientX;
    const startClientY = e.clientY;

    const onPointerMove = (moveEv: PointerEvent) => {
      moveEv.preventDefault();
      const dx = moveEv.clientX - startClientX;
      const dy = moveEv.clientY - startClientY;

      // Clamp strictly within screen bounds
      const screenW = typeof window !== 'undefined' ? window.innerWidth : 2088;
      const screenH = typeof window !== 'undefined' ? window.innerHeight : 1440;
      const clampedX = Math.max(0, Math.min(screenW - 120, basePos.x + dx));
      const clampedY = Math.max(0, Math.min(screenH - 80, basePos.y + dy));

      curX = clampedX;
      curY = clampedY;

      if (targetEl) {
        const sc = config.scales?.[key] ?? 1.0;
        targetEl.style.transform = `translate3d(${clampedX}px, ${clampedY}px, 0) scale(${sc})`;
      }
    };

    const onPointerUp = (upEv: PointerEvent) => {
      upEv.preventDefault();
      try {
        dragTarget.releasePointerCapture(upEv.pointerId);
      } catch {}
      setActiveDragKey(null);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      setConfig((prev) => {
        const next = {
          ...prev,
          positions: {
            ...prev.positions,
            [key]: { x: Math.round(curX), y: Math.round(curY) },
          },
        };
        saveConfig(next);
        return next;
      });
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp, { passive: false });
    // A cancelled gesture (Alt-Tab / touch interrupt mid-drag) must release
    // the drag too, or the window listeners stay attached with stale state.
    window.addEventListener('pointercancel', onPointerUp, { passive: false });
  };

  const startResize = (key: keyof OverlayConfig['positions'], e: React.PointerEvent) => {
    if (!isEditMode) return;
    e.preventDefault();
    e.stopPropagation();

    const targetEl = widgetRefs[key].current;
    const initialScale = config.scales?.[key] ?? 1.0;
    const startX = e.clientX;
    const startY = e.clientY;
    let currentScale = initialScale;

    const onPointerMove = (moveEv: PointerEvent) => {
      moveEv.preventDefault();
      const dx = moveEv.clientX - startX;
      const dy = moveEv.clientY - startY;
      const delta = (dx + dy) / 350;
      const nextScale = Math.max(0.6, Math.min(1.6, Number((initialScale + delta).toFixed(2))));
      currentScale = nextScale;

      if (targetEl) {
        const pos = config.positions[key] || { x: 16, y: 240 };
        targetEl.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0) scale(${nextScale})`;
      }
    };

    const onPointerUp = (upEv: PointerEvent) => {
      upEv.preventDefault();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      setConfig((prev) => {
        const next = {
          ...prev,
          scales: {
            ...(prev.scales || DEFAULT_OVERLAY_CONFIG.scales),
            [key]: currentScale,
          },
        };
        saveConfig(next);
        return next;
      });
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp, { passive: false });
    window.addEventListener('pointercancel', onPointerUp, { passive: false });
  };

  // Phase-split visibility: agent select gets its own big centered panel;
  // the in-match scoreboard renders ONLY while Tab is physically held.
  const isPregame = matchState?.phase === 'pregame';
  const isCoregame = matchState?.phase === 'coregame';
  const showScorePanel = isEditMode || (isCoregame && tabHeld);
  const showPregamePanel = isEditMode || isPregame;

  // Single source of truth for players. Persisted states can arrive with
  // missing team arrays (corrupt/legacy storage) — a bare `.length` here
  // would throw and unmount the whole overlay, so default defensively.
  // If a live match is detected, always display real players.
  // Only fall back to PREVIEW_PLAYERS when no game is running (idle).
  const liveBlue = matchState?.blueTeam ?? [];
  const liveRed = matchState?.redTeam ?? [];
  const hasLivePlayers = !!(
    matchState &&
    matchState.phase !== 'idle' &&
    (liveBlue.length > 0 || liveRed.length > 0)
  );

  const yourTeam = hasLivePlayers
    ? liveBlue.some((p) => p.isMe)
      ? liveBlue
      : liveRed.some((p) => p.isMe)
      ? liveRed
      : liveBlue.length > 0
      ? liveBlue
      : liveRed
    : PREVIEW_PLAYERS;

  const enemyTeam = hasLivePlayers
    ? yourTeam === liveBlue
      ? liveRed
      : liveBlue
    : PREVIEW_OPPONENTS;
  // Scoreboard mounts/unmounts on every Tab press and panels flip on phase
  // changes — repaint after each transition so DWM never keeps a stale
  // white region from the mount/unmount repaint storm.
  const scoreVisible = config.showLobby && showScorePanel;
  const pregameVisible = config.showPregame && showPregamePanel;
  const topAgentsVisible = config.showTopAgents && (isPregame || isEditMode);
  useEffect(() => {
    const t = setTimeout(forceRepaint, 80);
    return () => clearTimeout(t);
  }, [scoreVisible, pregameVisible, topAgentsVisible, forceRepaint]);

  return (
    <div
      ref={rootRef}
      onDragStart={(e) => e.preventDefault()}
      className="fixed inset-0 w-screen h-screen select-none overflow-hidden font-sans pointer-events-none"
      style={{ backgroundColor: 'transparent' }}
    >
      {/* Edit Mode Dimmer: subtle 40% darkness so desktop/game remains visible */}
      {isEditMode && (
        <>
          <div
            className="fixed inset-0 pointer-events-auto bg-black/40 transition-opacity duration-200 z-0"
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
          />
          {/* Screen Boundary Frame so users clearly see their display perimeter */}
          <div className="fixed inset-3 pointer-events-none border-2 border-dashed border-purple-500/50 rounded-3xl z-40 flex items-start justify-between p-3 select-none">
            <span className="px-3 py-1 rounded-xl bg-[#0c0816]/95 border border-purple-500/40 text-[10px] font-mono font-bold text-purple-300 shadow-md">
              SCREEN BOUNDS • {typeof window !== 'undefined' ? `${window.innerWidth}×${window.innerHeight}` : 'DISPLAY'}
            </span>
            <span className="px-3 py-1 rounded-xl bg-[#0c0816]/95 border border-purple-500/40 text-[10px] font-mono font-bold text-zinc-400 shadow-md">
              DRAG WIDGETS BY TOP BAR • PRESS ESC TO LOCK
            </span>
          </div>
        </>
      )}

      {/* ============================================================ */}
      {/* EDIT MODE TOP CONTROLS (Center Top)                          */}
      {/* ============================================================ */}
      {isEditMode && (
        <div className="fixed top-4 inset-x-0 mx-auto w-fit z-50 pointer-events-auto flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-[#0c0816]/95 border border-purple-500/50 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center gap-2 pr-2 border-r border-white/10">
            <span className="w-2.5 h-2.5 rounded-full bg-m3-mint animate-pulse shadow-[0_0_8px_rgba(58,227,116,0.8)]" />
            <span className="font-display font-black text-xs text-white tracking-wider uppercase">
              HUD Edit Mode
            </span>
          </div>

          <button
            type="button"
            onClick={() => {
              const def = getDefaultOverlayPositions();
              saveConfig({
                ...config,
                showPregame: true,
                positions: {
                  ...config.positions,
                  pregame: def.pregame,
                },
              });
            }}
            className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-white/5 hover:bg-white/10 border border-white/10 text-zinc-300 hover:text-white flex items-center gap-1.5 cursor-pointer transition-colors"
            title="Center Agent Select in middle of screen"
          >
            <Move className="w-3.5 h-3.5 text-purple-400" />
            <span>Center Agent Select</span>
          </button>

          <button
            type="button"
            onClick={() => saveConfig(getDefaultOverlayConfig())}
            className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-white/5 hover:bg-white/10 border border-white/10 text-zinc-300 hover:text-white flex items-center gap-1.5 cursor-pointer transition-colors"
            title="Reset all widget positions to defaults"
          >
            <RotateCcw className="w-3.5 h-3.5 text-zinc-400" />
            <span>Reset All</span>
          </button>

          <button
            type="button"
            onClick={async () => {
              await setOverlayEditMode(false);
            }}
            className="px-4 py-1.5 rounded-xl bg-m3-mint text-zinc-950 text-xs font-extrabold shadow-md border border-white/20 hover:brightness-110 flex items-center gap-1.5 cursor-pointer transition-all ml-1"
          >
            <Check className="w-4 h-4 stroke-[2.5]" />
            <span>Lock HUD (Esc)</span>
          </button>
        </div>
      )}

      {/* ============================================================ */}
      {/* EDIT MODE WIDGETS DRAWER (Top Right Panel)                   */}
      {/* ============================================================ */}
      {isEditMode && (
        <div className="fixed top-4 right-4 z-50 pointer-events-auto w-72 flex flex-col gap-2 p-3 rounded-3xl bg-[#0c0816]/95 border border-purple-500/50 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between px-1 pb-1.5 border-b border-white/10">
            <span className="font-display font-black text-xs text-white uppercase tracking-wider flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-m3-primary" />
              <span>Widgets List</span>
            </span>
            <span className="text-[10px] font-mono text-purple-300 font-bold">
              {[config.showPregame, config.showLobby, config.showTopAgents, config.showStartingSide].filter(Boolean).length} / 4 ON
            </span>
          </div>

          {/* 1. AGENT SELECT */}
          <div className={`p-2.5 rounded-2xl border transition-all flex flex-col gap-1.5 ${
            config.showPregame ? 'bg-purple-950/40 border-purple-500/60 shadow-md ring-1 ring-purple-500/40' : 'bg-zinc-900/50 border-white/10 opacity-60'
          }`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-m3-primary" />
                <span>Agent Select</span>
              </span>
              <button
                type="button"
                onClick={() => saveConfig({ ...config, showPregame: !config.showPregame })}
                className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-black border transition-colors cursor-pointer ${
                  config.showPregame
                    ? 'bg-m3-mint/20 text-m3-mint border-m3-mint/40'
                    : 'bg-white/5 text-zinc-400 border-white/10'
                }`}
              >
                {config.showPregame ? 'ON' : 'OFF'}
              </button>
            </div>
            <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono">
              <span>X: {Math.round(config.positions.pregame.x)} Y: {Math.round(config.positions.pregame.y)}</span>
              <button
                type="button"
                onClick={() => saveConfig({
                  ...config,
                  showPregame: true,
                  positions: { ...config.positions, pregame: getDefaultOverlayPositions().pregame },
                })}
                className="text-purple-300 hover:text-white underline cursor-pointer text-[9px]"
              >
                Reset pos
              </button>
            </div>
          </div>

          {/* 2. MATCH STATUS (SCOREBOARD) */}
          <div className={`p-2.5 rounded-2xl border transition-all flex flex-col gap-1.5 ${
            config.showLobby ? 'bg-purple-950/40 border-purple-500/60 shadow-md ring-1 ring-purple-500/40' : 'bg-zinc-900/50 border-white/10 opacity-60'
          }`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-m3-gold" />
                <span>Match Status</span>
              </span>
              <button
                type="button"
                onClick={() => saveConfig({ ...config, showLobby: !config.showLobby })}
                className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-black border transition-colors cursor-pointer ${
                  config.showLobby
                    ? 'bg-m3-mint/20 text-m3-mint border-m3-mint/40'
                    : 'bg-white/5 text-zinc-400 border-white/10'
                }`}
              >
                {config.showLobby ? 'ON' : 'OFF'}
              </button>
            </div>
            <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono">
              <span>X: {Math.round(config.positions.lobby.x)} Y: {Math.round(config.positions.lobby.y)}</span>
              <button
                type="button"
                onClick={() => saveConfig({
                  ...config,
                  showLobby: true,
                  positions: { ...config.positions, lobby: getDefaultOverlayPositions().lobby },
                })}
                className="text-purple-300 hover:text-white underline cursor-pointer text-[9px]"
              >
                Reset pos
              </button>
            </div>
          </div>

          {/* 3. TOP AGENTS */}
          <div className={`p-2.5 rounded-2xl border transition-all flex flex-col gap-1.5 ${
            config.showTopAgents ? 'bg-purple-950/40 border-purple-500/60 shadow-md ring-1 ring-purple-500/40' : 'bg-zinc-900/50 border-white/10 opacity-60'
          }`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                <Trophy className="w-3.5 h-3.5 text-m3-gold" />
                <span>Top Agents</span>
              </span>
              <button
                type="button"
                onClick={() => saveConfig({ ...config, showTopAgents: !config.showTopAgents })}
                className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-black border transition-colors cursor-pointer ${
                  config.showTopAgents
                    ? 'bg-m3-mint/20 text-m3-mint border-m3-mint/40'
                    : 'bg-white/5 text-zinc-400 border-white/10'
                }`}
              >
                {config.showTopAgents ? 'ON' : 'OFF'}
              </button>
            </div>
            <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono">
              <span>X: {Math.round(config.positions.topAgents.x)} Y: {Math.round(config.positions.topAgents.y)}</span>
              <button
                type="button"
                onClick={() => saveConfig({
                  ...config,
                  showTopAgents: true,
                  positions: { ...config.positions, topAgents: getDefaultOverlayPositions().topAgents },
                })}
                className="text-purple-300 hover:text-white underline cursor-pointer text-[9px]"
              >
                Reset pos
              </button>
            </div>
          </div>

          {/* 4. STARTING SIDE (ATTACK / DEFENSE) */}
          <div className={`p-2.5 rounded-2xl border transition-all flex items-center justify-between ${
            config.showStartingSide ? 'bg-purple-950/40 border-purple-500/60 shadow-md ring-1 ring-purple-500/40' : 'bg-zinc-900/50 border-white/10 opacity-60'
          }`}>
            <div className="flex flex-col">
              <span className="text-xs font-bold text-white flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-m3-mint" />
                <span>Starting Side (Atk/Def)</span>
              </span>
              <span className="text-[10px] text-zinc-400">Show in Agent Select & HUD</span>
            </div>
            <button
              type="button"
              onClick={() => saveConfig({ ...config, showStartingSide: !config.showStartingSide })}
              className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-black border transition-colors cursor-pointer ${
                config.showStartingSide
                  ? 'bg-m3-mint/20 text-m3-mint border-m3-mint/40'
                  : 'bg-white/5 text-zinc-400 border-white/10'
              }`}
            >
              {config.showStartingSide ? 'ON' : 'OFF'}
            </button>
          </div>

        </div>
      )}

      {/* ============================================================ */}
      {/* WIDGET: Match Panel — agent select always on, in-match Tab-peek only */}
      {/* ============================================================ */}
      {config.showLobby && showScorePanel && (
        <div
          ref={lobbyRef}
          onPointerDown={(e) => startDrag('lobby', e)}
          style={{
            transform: `translate3d(${config.positions.lobby.x}px, ${config.positions.lobby.y}px, 0) scale(${config.scales?.lobby ?? 1.0})`,
            transformOrigin: 'top left',
            touchAction: 'none',
          }}
          className={`fixed top-0 left-0 ${
            isEditMode ? 'pointer-events-auto' : 'pointer-events-none'
          } select-none w-[320px] will-change-transform z-10 ${
            isEditMode
              ? 'cursor-grab active:cursor-grabbing border-2 border-dashed border-purple-400 bg-purple-950/25 rounded-3xl p-1.5 shadow-[0_0_30px_rgba(168,85,247,0.45)] ring-2 ring-white/30'
              : ''
          }`}
        >
          {isEditMode && (
            <>
              {/* Corner crosshairs so the bounding box is 100% obvious */}
              <div className="absolute -top-1.5 -left-1.5 w-3.5 h-3.5 border-t-2 border-l-2 border-purple-300 pointer-events-none" />
              <div className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 border-t-2 border-r-2 border-purple-300 pointer-events-none" />
              <div className="absolute -bottom-1.5 -left-1.5 w-3.5 h-3.5 border-b-2 border-l-2 border-purple-300 pointer-events-none" />
              <div className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 border-b-2 border-r-2 border-purple-300 pointer-events-none" />

              <div
                onPointerDown={(e) => startDrag('lobby', e)}
                className="mb-1.5 px-3 py-1.5 rounded-2xl bg-purple-600/30 border border-purple-400/60 flex items-center justify-between cursor-grab active:cursor-grabbing text-[11px] font-mono font-bold text-white select-none shadow-md backdrop-blur-md"
              >
                <div className="flex items-center gap-1.5">
                  <Move className="w-3.5 h-3.5 text-purple-300" />
                  <span>Match Status • ({Math.round(config.positions.lobby.x)}, {Math.round(config.positions.lobby.y)})</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-zinc-300 font-normal">Hold to drag</span>
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      saveConfig({ ...config, showLobby: false });
                    }}
                    className="w-5 h-5 rounded-lg bg-red-500/30 hover:bg-red-500/50 border border-red-500/40 text-red-200 hover:text-white flex items-center justify-center cursor-pointer transition-colors"
                    title="Remove Scoreboard from screen"
                  >
                    <X className="w-3.5 h-3.5 stroke-[2.5]" />
                  </button>
                </div>
              </div>
              <div
                onPointerDown={(e) => startResize('lobby', e)}
                className="absolute -bottom-1 -right-1 w-5 h-5 rounded-br-2xl bg-m3-primary/90 hover:bg-m3-primary cursor-nwse-resize flex items-center justify-center text-[11px] text-zinc-950 font-black select-none shadow-md z-10"
                title="Drag to resize HUD widget"
              >
                ↘
              </div>
            </>
          )}
          <div
            className={`rounded-2xl border p-2.5 shadow-2xl flex flex-col gap-2 transition-all ${
              isEditMode
                ? 'bg-[#0c0816]/95 border-white/25 shadow-[0_12px_40px_rgba(0,0,0,0.85)] ring-1 ring-white/15 backdrop-blur-xl'
                : 'bg-[#0c0816]/95 border-white/15 backdrop-blur-xl shadow-2xl'
            }`}
          >
            {/* Header: Map • Mode • Phase + live game status */}
            <div className="flex items-center justify-between px-1 gap-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-xs font-display font-black text-white truncate">
                  {matchState?.mapName || 'Live Match Status'}
                </span>
                {matchState?.mode && (
                  <span className="text-[10px] font-mono text-zinc-400 truncate">
                    • {matchState.mode}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {/* Side we start on — only Riot tells us this before the game */}
                {config.showStartingSide && matchState?.startingSide && !matchState?.isDeathmatch && (
                  <span
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-extrabold uppercase border ${
                      matchState.startingSide === 'Defense'
                        ? 'bg-m3-mint/15 text-m3-mint border-m3-mint/30'
                        : 'bg-m3-coral/15 text-m3-coral border-m3-coral/30'
                    }`}
                    title={`Starting side: ${matchState.startingSide}`}
                  >
                    {matchState.startingSide === 'Defense' ? (
                      <Shield className="w-2.5 h-2.5" />
                    ) : (
                      <Swords className="w-2.5 h-2.5" />
                    )}
                    {matchState.startingSide === 'Defense' ? 'DEF' : 'ATK'}
                  </span>
                )}
                <span className="px-1.5 py-0.5 rounded bg-m3-primary/20 text-m3-primary text-[9px] font-mono font-extrabold uppercase shrink-0">
                  {matchState?.phase === 'coregame' ? 'LIVE' : matchState?.phase === 'pregame' ? 'SELECT' : 'PREVIEW'}
                </span>
              </div>
            </div>

            {/* Column Titles */}
            <div className="grid grid-cols-[18px_24px_28px_26px_36px_32px_36px_34px] items-center gap-x-1.5 px-2 text-[8.5px] font-mono text-zinc-400 uppercase tracking-wider border-b border-white/10 pb-1 shrink-0">
              <span className="text-center" title="Tracker Score tier">TS</span>
              <span className="text-center" title="Agent">Agent</span>
              <span className="text-center">Rank</span>
              <span className="text-center">Peak</span>
              <span className="text-right" title="Act-wide average combat score — the column this board is sorted by">ACS</span>
              <span className="text-right">K/D</span>
              <span className="text-right" title="Act-wide win rate">Win%</span>
              <span className="text-right" title="Act-wide headshot %">HS%</span>
            </div>

            {/* Vertical Compact Teams / Player Stack */}
            <div className="flex flex-col gap-2">
              {matchState?.isDeathmatch ? (
                /* FFA / Deathmatch — Single unified leaderboard, NOT grouped by teams or groups */
                <VerticalSquadColumn
                  title="Deathmatch"
                  tagColor="text-m3-gold"
                  players={liveBlue}
                  tierIcons={tierIcons}
                />
              ) : (
                /* Standard Match Stack — Your Team vs Enemy Team */
                <>
                  <VerticalSquadColumn
                    title="Your Team"
                    tagColor="text-m3-primary"
                    players={yourTeam}
                    tierIcons={tierIcons}
                  />
                  {enemyTeam.length > 0 ? (
                    <VerticalSquadColumn
                      title="Enemy Team"
                      tagColor="text-rose-400"
                      players={enemyTeam}
                      tierIcons={tierIcons}
                    />
                  ) : matchState?.phase === 'coregame' ? (
                    <div className="rounded-xl bg-black/20 border border-white/5 p-2 flex items-center justify-center gap-2 text-center">
                      <LockIcon className="w-3.5 h-3.5 text-zinc-400" />
                      <span className="text-[10px] font-semibold text-zinc-300">Enemy Team Hidden</span>
                      <span className="text-[9px] text-zinc-500">• Visible on match start</span>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {/* ============================================================ */}
      {/* WIDGET 5: Agent Select — big centered detailed team panel    */}
      {/* ============================================================ */}
      {config.showPregame && showPregamePanel && (
        <div
          ref={pregameRef}
          onPointerDown={(e) => startDrag('pregame', e)}
          style={{
            transform: `translate3d(${config.positions.pregame.x}px, ${config.positions.pregame.y}px, 0) scale(${config.scales?.pregame ?? 1.0})`,
            transformOrigin: 'top left',
            touchAction: 'none',
          }}
          className={`fixed top-0 left-0 ${
            isEditMode ? 'pointer-events-auto' : 'pointer-events-none'
          } select-none w-[510px] max-w-[96vw] will-change-transform z-10 ${
            isEditMode
              ? 'cursor-grab active:cursor-grabbing border-2 border-dashed border-purple-400 bg-purple-950/25 rounded-3xl p-1.5 shadow-[0_0_35px_rgba(168,85,247,0.5)] ring-2 ring-white/30'
              : ''
          }`}
        >
          {isEditMode && (
            <>
              {/* Corner crosshairs so bounding box is 100% visible */}
              <div className="absolute -top-1.5 -left-1.5 w-4 h-4 border-t-2 border-l-2 border-purple-300 pointer-events-none" />
              <div className="absolute -top-1.5 -right-1.5 w-4 h-4 border-t-2 border-r-2 border-purple-300 pointer-events-none" />
              <div className="absolute -bottom-1.5 -left-1.5 w-4 h-4 border-b-2 border-l-2 border-purple-300 pointer-events-none" />
              <div className="absolute -bottom-1.5 -right-1.5 w-4 h-4 border-b-2 border-r-2 border-purple-300 pointer-events-none" />

              <div
                onPointerDown={(e) => startDrag('pregame', e)}
                className="mb-2 px-3.5 py-1.5 rounded-2xl bg-purple-600/30 border border-purple-400/60 flex items-center justify-between cursor-grab active:cursor-grabbing text-xs font-mono font-bold text-white select-none shadow-md backdrop-blur-md"
              >
                <div className="flex items-center gap-1.5">
                  <Move className="w-3.5 h-3.5 text-purple-300" />
                  <span>Agent Select • ({Math.round(config.positions.pregame.x)}, {Math.round(config.positions.pregame.y)})</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-zinc-300 font-normal">Hold to drag</span>
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      saveConfig({ ...config, showPregame: false });
                    }}
                    className="w-5 h-5 rounded-lg bg-red-500/30 hover:bg-red-500/50 border border-red-500/40 text-red-200 hover:text-white flex items-center justify-center cursor-pointer transition-colors"
                    title="Remove Agent Select from screen"
                  >
                    <X className="w-3.5 h-3.5 stroke-[2.5]" />
                  </button>
                </div>
              </div>
              <div
                onPointerDown={(e) => startResize('pregame', e)}
                className="absolute -bottom-1 -right-1 w-5 h-5 rounded-br-2xl bg-m3-primary/90 hover:bg-m3-primary cursor-nwse-resize flex items-center justify-center text-[11px] text-zinc-950 font-black select-none shadow-md z-10"
                title="Drag to resize HUD widget"
              >
                ↘
              </div>
            </>
          )}
          <div
            className={`rounded-2xl border p-3 shadow-2xl flex flex-col gap-2 transition-all ${
              isEditMode
                ? 'bg-[#0c0816]/95 border-white/25 shadow-[0_16px_50px_rgba(0,0,0,0.9)] ring-1 ring-white/15 backdrop-blur-xl'
                : 'bg-[#0c0816]/95 border-white/15 backdrop-blur-xl shadow-2xl'
            }`}
          >
            {/* Header: Map • Starting Side Badge */}
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full bg-m3-mint animate-pulse shadow-[0_0_8px_rgba(58,227,116,0.8)]" />
                <span className="font-display font-black text-white text-xs tracking-wider uppercase">
                  {matchState?.mapName || 'Ascent'} • Team Scout
                </span>
                {/* Precise queue when Riot tells us (Competitive vs Unrated share
                    a ModeID, so `mode` alone can't distinguish them). */}
                {(queueLabel(matchState?.queueId) || matchState?.mode) && (
                  <span
                    className="text-[10px] font-mono text-zinc-400 truncate"
                    title={matchState?.queueId ? `Queue: ${matchState.queueId}` : undefined}
                  >
                    • {queueLabel(matchState?.queueId) || matchState?.mode}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {config.showStartingSide && matchState?.startingSide && (
                  <span
                    className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-mono font-extrabold uppercase shrink-0 border ${
                      matchState.startingSide === 'Defense'
                        ? 'bg-m3-mint/15 text-m3-mint border-m3-mint/30'
                        : 'bg-m3-coral/15 text-m3-coral border-m3-coral/30'
                    }`}
                  >
                    {matchState.startingSide === 'Defense' ? (
                      <>
                        <Shield className="w-3 h-3 text-m3-mint" />
                        <span>Starting Defense</span>
                      </>
                    ) : (
                      <>
                        <Swords className="w-3 h-3 text-m3-coral" />
                        <span>Starting Attack</span>
                      </>
                    )}
                  </span>
                )}
                <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-zinc-300 text-[9px] font-mono font-bold uppercase shrink-0">
                  {isPregame ? 'Agent Select' : 'Preview'}
                </span>
              </div>
            </div>

            <PregameTeamColumn
              title="Your Team"
              tagColor="text-m3-primary"
              players={yourTeam}
              tierIcons={tierIcons}
              seasons={seasonNames}
              queueId={matchState?.queueId}
            />
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* WIDGET 3: Player Top Agents on Active Map & Blitz Meta      */}
      {/* ============================================================ */}
      {config.showTopAgents && (isPregame || isEditMode) && (
        <div
          ref={topAgentsRef}
          onPointerDown={(e) => startDrag('topAgents', e)}
          style={{
            transform: `translate3d(${config.positions.topAgents.x}px, ${config.positions.topAgents.y}px, 0) scale(${config.scales?.topAgents ?? 1.0})`,
            transformOrigin: 'top left',
            touchAction: 'none',
          }}
          className={`fixed top-0 left-0 ${
            isEditMode ? 'pointer-events-auto' : 'pointer-events-none'
          } select-none w-[370px] will-change-transform z-10 ${
            isEditMode
              ? 'cursor-grab active:cursor-grabbing border-2 border-dashed border-purple-400 bg-purple-950/25 rounded-3xl p-1.5 shadow-[0_0_30px_rgba(168,85,247,0.45)] ring-2 ring-white/30'
              : ''
          }`}
        >
          {isEditMode && (
            <>
              {/* Corner crosshairs so bounding box is 100% visible */}
              <div className="absolute -top-1.5 -left-1.5 w-3.5 h-3.5 border-t-2 border-l-2 border-purple-300 pointer-events-none" />
              <div className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 border-t-2 border-r-2 border-purple-300 pointer-events-none" />
              <div className="absolute -bottom-1.5 -left-1.5 w-3.5 h-3.5 border-b-2 border-l-2 border-purple-300 pointer-events-none" />
              <div className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 border-b-2 border-r-2 border-purple-300 pointer-events-none" />

              <div
                onPointerDown={(e) => startDrag('topAgents', e)}
                className="mb-2 px-3.5 py-1.5 rounded-2xl bg-purple-600/30 border border-purple-400/60 flex items-center justify-between cursor-grab active:cursor-grabbing text-xs font-mono font-bold text-white select-none shadow-md backdrop-blur-md"
              >
                <div className="flex items-center gap-1.5">
                  <Move className="w-3.5 h-3.5 text-purple-300" />
                  <span>Top Agents • ({Math.round(config.positions.topAgents.x)}, {Math.round(config.positions.topAgents.y)})</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-zinc-300 font-normal">Hold to drag</span>
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      saveConfig({ ...config, showTopAgents: false });
                    }}
                    className="w-5 h-5 rounded-lg bg-red-500/30 hover:bg-red-500/50 border border-red-500/40 text-red-200 hover:text-white flex items-center justify-center cursor-pointer transition-colors"
                    title="Remove Map Agents from screen"
                  >
                    <X className="w-3.5 h-3.5 stroke-[2.5]" />
                  </button>
                </div>
              </div>
              <div
                onPointerDown={(e) => startResize('topAgents', e)}
                className="absolute -bottom-1 -right-1 w-5 h-5 rounded-br-2xl bg-m3-primary/90 hover:bg-m3-primary cursor-nwse-resize flex items-center justify-center text-[11px] text-zinc-950 font-black select-none shadow-md z-10"
                title="Drag to resize HUD widget"
              >
                ↘
              </div>
            </>
          )}

          <div
            className={`rounded-3xl border p-3 shadow-2xl flex flex-col gap-2 transition-all ${
              isEditMode
                ? 'bg-[#0c0816]/95 border-white/25 shadow-[0_16px_50px_rgba(0,0,0,0.9)] ring-1 ring-white/15 backdrop-blur-xl'
                : 'bg-[#0c0816]/95 border-white/15 backdrop-blur-xl shadow-2xl'
            }`}
          >
            {/* Header with Map name & Mode toggle */}
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <Trophy className="w-3.5 h-3.5 text-m3-gold shrink-0" />
                <span className="font-display font-black text-white text-xs tracking-wider uppercase truncate">
                  {showMetaPicks
                    ? `${activeMapName} • Recommended`
                    : personalScope === 'map'
                    ? `${activeMapName} • Your Agents`
                    : personalScope === 'all'
                    ? 'Your Agents • All Maps'
                    : 'Your Agents • Preview'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setViewMode(showMetaPicks ? 'personal' : 'blitz')}
                  className="px-2 py-0.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-zinc-300 hover:text-white text-[9px] font-mono font-bold uppercase shrink-0 transition-colors flex items-center gap-1 cursor-pointer"
                  title="Toggle between your own agent stats and rank recommended picks"
                >
                  {showMetaPicks ? (
                    <span>Your Agents ({personalListCount})</span>
                  ) : (
                    <span>Meta ({rankTierLabel})</span>
                  )}
                </button>
              </div>
            </div>

            {/* Not enough games on this map to judge — say so instead of guessing */}
            {!showMetaPicks && personalScope === 'all' && (
              <div className="px-2.5 py-1 rounded-xl bg-white/[0.04] border border-white/10 flex items-center gap-1.5 text-[10px] font-mono text-zinc-300">
                <AlertTriangle className="w-3 h-3 text-zinc-400 shrink-0" />
                <span>
                  {thinMapSample
                    ? `Only ${mapGames} ${activeMapName} game${mapGames === 1 ? '' : 's'} — showing your full agent pool`
                    : `No ${activeMapName} games recorded — showing your full agent pool`}
                </span>
              </div>
            )}

            {/* This map has no hand-tuned meta — say so instead of borrowing
                another map's picks and passing them off as this map's. */}
            {!hasMetaForMap && (
              <div className="px-2.5 py-1 rounded-xl bg-white/[0.04] border border-white/10 flex items-center gap-1.5 text-[10px] font-mono text-zinc-300">
                <AlertTriangle className="w-3 h-3 text-zinc-400 shrink-0" />
                <span>No {activeMapName} meta yet — showing your real numbers</span>
              </div>
            )}

            {/* If user struggles on this map (<50% win rate), show tactical alert */}
            {!hasWinningAgentOnMap && !showMetaPicks && personalScope === 'map' && (
              <div className="px-2.5 py-1 rounded-xl bg-amber-400/10 border border-amber-400/25 flex items-center justify-between text-[10px] font-mono text-amber-200">
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                  <span>&lt;50% Win Rate on {activeMapName}</span>
                </div>
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setViewMode('blitz')}
                  className="text-[9px] underline text-amber-300 hover:text-white cursor-pointer font-bold"
                >
                  See Recommended
                </button>
              </div>
            )}

            {/* Table / Rows */}
            {showMetaPicks ? (
              /* RECOMMENDED PICKS FOR THIS MAP AND RANK (NO TIPS) */
              <div className="flex flex-col gap-1.5">
                <div className="px-1 text-[9px] font-mono text-zinc-400 flex items-center justify-between border-b border-white/5 pb-1">
                  <span>Blitz Live Meta ({rankTierLabel})</span>
                  <span className="text-m3-mint font-bold">Top 3 · Win% · Pick%</span>
                </div>
                {metaPicks.slice(0, 3).map((b) => {
                  const norm = b.agent.toLowerCase();
                  const meta = Object.values(agentMap).find((a) => a.name.toLowerCase() === norm);
                  const icon =
                    meta?.icon ||
                    (norm === 'sova'
                      ? 'https://media.valorant-api.com/agents/320b2a48-4d9b-a075-30f1-1f93a9b638fa/displayicon.png'
                      : '');

                  return (
                    <div
                      key={b.agent}
                      className="grid grid-cols-[1fr_56px_50px_46px] items-center px-2.5 py-1.5 rounded-xl border border-white/5 bg-white/[0.03] hover:bg-white/[0.06] text-xs transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0 pr-1">
                        {icon ? (
                          <img
                            src={icon}
                            alt=""
                            draggable={false}
                            onError={(e) => {
                              (e.currentTarget as HTMLElement).style.display = 'none';
                            }}
                            className="w-7 h-7 rounded-lg object-cover shrink-0 border border-white/10 pointer-events-none select-none"
                          />
                        ) : (
                          <div className="w-7 h-7 rounded-lg bg-zinc-800 shrink-0 border border-white/10 flex items-center justify-center text-[10px] font-black text-zinc-400">
                            {b.agent.slice(0, 2).toUpperCase()}
                          </div>
                        )}
                        <div className="flex flex-col min-w-0 leading-tight">
                          <span className="font-bold text-[11px] text-white truncate">{b.agent}</span>
                          <span className="text-[8px] font-mono text-zinc-400 truncate">{b.role}</span>
                        </div>
                      </div>

                      <div className="text-center" title="Games sampled from Blitz">
                        <span className="px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-400/30 text-[8px] font-mono font-bold uppercase">
                          {b.matches >= 1000 ? `${(b.matches / 1000).toFixed(1)}k` : b.matches} G
                        </span>
                      </div>

                      <div className="text-right font-mono text-[10px] font-bold text-m3-mint" title="Lobby Win Rate">
                        {b.winRate}%
                      </div>

                      <div className="text-right font-mono text-[9px] text-zinc-400 font-medium" title="Pick Rate">
                        {b.pickRate}%
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* PLAYER'S OWN AGENT STATS */
              <div className="flex flex-col gap-1">
                <div className="px-1 text-[9px] font-mono text-zinc-400 flex items-center justify-between border-b border-white/5 pb-1 mb-0.5">
                  <span>
                    {personalScope === 'map'
                      ? `Your record on ${activeMapName} (${mapGames} games)`
                      : personalScope === 'all'
                      ? 'Your agent pool (all maps, this act)'
                      : 'Sample preview'}
                  </span>
                  <span className="text-m3-mint font-bold">
                    {personalScope === 'preview' ? 'Demo' : 'Win & K/D'}
                  </span>
                </div>
                {/* Column Headers */}
                <div className="grid grid-cols-[1fr_58px_50px_46px_40px] items-center px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider text-zinc-400 border-b border-white/5">
                  <span>Agent</span>
                  <span className="text-right">Matches</span>
                  <span className="text-right">Win%</span>
                  <span className="text-right">K/D</span>
                  <span className="text-right">HS%</span>
                </div>

                {topAgentsList.slice(0, 5).map((stat) => {
                  const normName = stat.agent.toLowerCase();
                  const meta = Object.values(agentMap).find(
                    (a) => a.name.toLowerCase() === normName
                  );
                  const icon =
                    meta?.icon ||
                    (normName === 'sova'
                      ? 'https://media.valorant-api.com/agents/320b2a48-4d9b-a075-30f1-1f93a9b638fa/displayicon.png'
                      : '');
                  const role = meta?.role || stat.role || 'Agent';
                  const kd = stat.kd.toFixed(2);
                  const kdColor =
                    stat.kd >= 1.2
                      ? 'text-emerald-400 font-bold'
                      : stat.kd >= 1.0
                      ? 'text-m3-mint font-semibold'
                      : 'text-rose-400 font-medium';
                  return (
                    <div
                      key={stat.agent}
                      className="grid grid-cols-[1fr_58px_50px_46px_40px] items-center px-2 py-1.5 rounded-xl border border-white/5 bg-white/[0.03] hover:bg-white/[0.06] text-xs transition-colors"
                    >
                      {/* Agent Icon & Name */}
                      <div className="flex items-center gap-2 min-w-0 pr-1">
                        {icon ? (
                          <img
                            src={icon}
                            alt=""
                            draggable={false}
                            onError={(e) => {
                              (e.currentTarget as HTMLElement).style.display = 'none';
                            }}
                            className="w-7 h-7 rounded-lg object-cover shrink-0 border border-white/10 pointer-events-none select-none"
                          />
                        ) : (
                          <div className="w-7 h-7 rounded-lg bg-zinc-800 shrink-0 border border-white/10 flex items-center justify-center text-[10px] font-black text-zinc-400">
                            {stat.agent.slice(0, 2).toUpperCase()}
                          </div>
                        )}
                        <div className="flex flex-col min-w-0 flex-1 leading-tight">
                          <span className="font-bold text-[11px] text-white truncate">{stat.agent}</span>
                          <span className="text-[8px] font-mono text-zinc-400 truncate">{role}</span>
                        </div>
                      </div>

                      {/* Matches on this map */}
                      <div
                        className="flex flex-col items-end leading-none font-mono"
                        title={`${stat.wins} Wins - ${stat.losses} Losses on ${activeMapName}`}
                      >
                        <span className="text-[10px] font-bold text-white">{stat.matches}G</span>
                        <span className="text-[8px] text-zinc-400 mt-0.5">{stat.wins}W-{stat.losses}L</span>
                      </div>

                      {/* Win % */}
                      <div className="text-right font-mono text-[10px] font-bold" title="Win Rate">
                        <span className={stat.winPct >= 50 ? 'text-m3-mint' : 'text-zinc-400'}>
                          {stat.winPct.toFixed(1)}%
                        </span>
                      </div>

                      {/* K/D — TRN's map segment has no K/D, so only local games can fill it */}
                      <div className="text-right font-mono text-[10px] font-bold" title="K/D Ratio (last-20 local games)">
                        {stat.kd > 0 ? (
                          <span className={kdColor}>{kd}</span>
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </div>

                      {/* HS% */}
                      <div className="text-right font-mono text-[10px] text-amber-200/90 font-medium" title="Headshot %">
                        {stat.hsPct > 0 ? `${stat.hsPct.toFixed(0)}%` : <span className="text-zinc-600">—</span>}
                      </div>
                    </div>
                  );
                })}

                {/* No winning agent here → suggest the rank meta WITHOUT hiding
                    the player's own list. */}
                {!hasWinningAgentOnMap && personalScope !== 'preview' && (
                  <div className="mt-1 pt-1.5 border-t border-white/10 flex flex-col gap-1">
                    <div className="px-1 flex items-center justify-between text-[9px] font-mono">
                      <span className="flex items-center gap-1 text-amber-300">
                        <AlertTriangle className="w-3 h-3 shrink-0" />
                        {personalScope === 'map' ? 'No agent above 50% here' : `No ${activeMapName} record yet`} — suggested
                      </span>
                      <button
                        type="button"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => setViewMode('blitz')}
                        className="text-zinc-400 hover:text-white underline font-bold cursor-pointer shrink-0"
                      >
                        All
                      </button>
                    </div>
                    {metaPicks.slice(0, 3).map((b) => {
                      const meta = Object.values(agentMap).find(
                        (a) => a.name.toLowerCase() === b.agent.toLowerCase()
                      );
                      return (
                        <div
                          key={b.agent}
                          className="grid grid-cols-[1fr_52px_44px] items-center px-2 py-1 rounded-lg border border-amber-400/15 bg-amber-400/[0.04]"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {meta?.icon ? (
                              <img
                                src={meta.icon}
                                alt=""
                                draggable={false}
                                className="w-6 h-6 rounded-md object-cover shrink-0 border border-white/10 pointer-events-none select-none"
                              />
                            ) : (
                              <div className="w-6 h-6 rounded-md bg-zinc-800 shrink-0 border border-white/10" />
                            )}
                            <span className="font-bold text-[10px] text-white truncate">{b.agent}</span>
                            <span className="px-1 py-px rounded bg-purple-500/20 text-purple-300 border border-purple-400/30 text-[7px] font-mono font-bold uppercase shrink-0">
                              {b.matches >= 1000 ? `${(b.matches / 1000).toFixed(1)}k` : b.matches}g
                            </span>
                          </div>
                          <span className="text-right font-mono text-[10px] font-bold text-m3-mint" title="Win rate">
                            {b.winRate}%
                          </span>
                          <span className="text-right font-mono text-[9px] text-zinc-400" title="Pick rate">
                            {b.pickRate}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const PregameTeamColumn: React.FC<{
  title: string;
  tagColor: string;
  players: LiveMatchPlayer[];
  tierIcons: Record<number, string>;
  seasons?: Record<string, string>;
  queueId?: string;
}> = ({ players, tierIcons, seasons }) => {
  return (
    <div className="flex flex-col gap-1.5 pointer-events-none select-none">
      {/* Table Column Headers: Score badge, Player, Rank, Peak, K/D, Win%, HS% */}
      <div className="grid grid-cols-[26px_1fr_40px_40px_48px_50px_48px] items-center px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider text-zinc-400 border-b border-white/10">
        <span className="text-center" title="Tracker Score tier">TS</span>
        <span>Player</span>
        <span className="text-center">Rank</span>
        <span className="text-center">Peak</span>
        <span className="text-right">K/D</span>
        <span className="text-right">Win%</span>
        <span className="text-right">HS%</span>
      </div>

      {/* Teammate Rows */}
      <div className="flex flex-col gap-1">
        {players.map((p) => {
          const icon = tierIcons[p.tier];
          const peakIcon = tierIcons[p.peakTier];
          const kd = formatKd(p.kd);
          const locked = (p.selectionState || '').toLowerCase().includes('lock');
          const hasPick = !locked && !!p.agentName && p.agentName !== 'Selecting…';
          const party = getPartyStyle(p.partyIndex);
          const flagUrl = getFlagUrl(p.country);
          const countryName = getCountryName(p.country);

          return (
            <div
              key={p.puuid}
              className={`relative overflow-hidden grid grid-cols-[26px_1fr_40px_40px_48px_50px_48px] items-center px-2.5 py-1 rounded-xl border text-xs transition-colors ${
                party
                  ? `${party.bg} border-white/10`
                  : p.isMe
                  ? 'bg-purple-500/15 border-purple-400/30 text-white shadow-xs'
                  : 'bg-white/[0.03] hover:bg-white/[0.06] border-white/5 text-zinc-200'
              }`}
            >
              {/* Party identifier: curved bow arc wrapping the left edge when queued in a party */}
              {party && (
                <svg
                  className={`absolute left-0 top-0 bottom-0 h-full w-2.5 pointer-events-none ${party.text} drop-shadow-[0_0_6px_currentColor]`}
                  viewBox="0 0 10 32"
                  fill="none"
                  preserveAspectRatio="none"
                >
                  <title>{`Queued together in ${party.name}`}</title>
                  <path
                    d="M 8 2.5 C 3.5 2.5, 1.5 5.5, 1.5 10 L 1.5 22 C 1.5 26.5, 3.5 29.5, 8 29.5"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
              )}
              {/* Tracker Score badge (hex tier emblem, never a raw number) */}
              <div
                className="flex items-center justify-center shrink-0"
                title={
                  p.trnScore != null
                    ? `Tracker Score: ${p.trnScore} / 1000 — Tier ${scoreTier(p.trnScore).tier}`
                    : 'Tracker Score unavailable'
                }
              >
                {p.trnScore != null ? (
                  <ScoreBadge tier={scoreTier(p.trnScore).tier} size={20} />
                ) : (
                  <span className="w-5 h-5 rounded border border-white/10 bg-white/[0.03] flex items-center justify-center text-[9px] font-mono text-zinc-600">
                    —
                  </span>
                )}
              </div>

              {/* Agent Icon (with Flag overlay) + Player Name & Pick State */}
              <div className="flex items-center gap-2 min-w-0 pr-1">
                <div className="relative shrink-0">
                  {p.agentIcon ? (
                    <img
                      src={p.agentIcon}
                      alt=""
                      draggable={false}
                      onError={(e) => {
                        (e.currentTarget as HTMLElement).style.display = 'none';
                      }}
                      className={`w-[26px] h-[26px] rounded-lg object-cover border ${
                        locked ? 'border-m3-mint/60' : hasPick ? 'border-amber-300/60' : 'border-white/10'
                      } pointer-events-none select-none`}
                    />
                  ) : (
                    <div className="w-[26px] h-[26px] rounded-lg bg-zinc-800 border border-white/10 flex items-center justify-center text-[10px] font-black text-zinc-400">
                      ?
                    </div>
                  )}
                  {flagUrl && (
                    <img
                      src={flagUrl}
                      alt={p.country || ''}
                      title={countryName ? `Country: ${countryName} (${p.country})` : `Country: ${p.country}`}
                      draggable={false}
                      onError={(e) => {
                        (e.currentTarget as HTMLElement).style.display = 'none';
                      }}
                      className="absolute -bottom-0.5 -right-0.5 w-3.5 h-2.5 object-cover rounded-[1.5px] shadow-sm border border-black/80 pointer-events-none select-none"
                    />
                  )}
                </div>

                <div className="flex flex-col min-w-0 flex-1 leading-tight">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {party && (
                      <span
                        className={`w-2 h-2 rounded-full ${party.bar} shrink-0 shadow-xs`}
                        title={`Queued together in ${party.name}`}
                      />
                    )}
                    <span className="font-bold text-[12.5px] text-white truncate" title={`${p.name}${p.tag ? '#' + p.tag : ''}`}>
                      {p.name}
                    </span>
                    {p.isMe && (
                      <span className="px-1.5 py-0.5 rounded bg-purple-500/80 text-[7.5px] font-black text-white uppercase shrink-0">
                        You
                      </span>
                    )}
                    {p.isIncognito && (
                      <span
                        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-300 border border-amber-400/30 text-[7.5px] font-mono font-bold uppercase shrink-0"
                        title={
                          p.nameResolved
                            ? 'Name Hidden in Valorant (Unmasked by Recon)'
                            : 'Riot hides this name during live matches — revealed automatically after the game'
                        }
                      >
                        <EyeOff className="w-2.5 h-2.5" />
                        {p.nameResolved ? 'Unmasked' : 'Hidden'}
                      </span>
                    )}
                  </div>
                  <span className="text-[9.5px] font-mono font-semibold">
                    {locked ? (
                      <span className="flex items-center gap-1 text-m3-mint">
                        <Check className="w-2.5 h-2.5 stroke-[3]" />
                        {p.agentName}
                      </span>
                    ) : hasPick ? (
                      <span className="flex items-center gap-1 text-amber-300">
                        <Clock className="w-2.5 h-2.5" />
                        {p.agentName}
                      </span>
                    ) : (
                      <span className="text-zinc-500">Picking…</span>
                    )}
                  </span>
                </div>
              </div>

              {/* Current Rank emblem + live RR */}
              <div
                className="flex flex-col items-center justify-center leading-none"
                title={rankTooltip(p, seasons?.[p.peakSeasonId?.toLowerCase() ?? ''])}
              >
                {icon ? (
                  <img src={icon} alt="" draggable={false} className="w-[22px] h-[22px] object-contain shrink-0" />
                ) : (
                  <span className="text-[10px] font-mono text-zinc-500">—</span>
                )}
                {p.tier > 2 && p.rr != null ? (
                  <span className="text-[8.5px] font-mono font-bold text-m3-primary mt-0.5">{p.rr}</span>
                ) : (
                  <span className="text-[8.5px] font-mono text-transparent mt-0.5 select-none">—</span>
                )}
              </div>

              {/* Peak Rank emblem + the act it was reached in */}
              <div
                className="flex flex-col items-center justify-center leading-none"
                title={`Peak: ${p.peakRank}${
                  seasons?.[p.peakSeasonId?.toLowerCase() ?? '']
                    ? ` — ${seasons[p.peakSeasonId!.toLowerCase()]}`
                    : ''
                }`}
              >
                {peakIcon ? (
                  <img src={peakIcon} alt="" draggable={false} className="w-[18px] h-[18px] object-contain opacity-75 shrink-0" />
                ) : (
                  <span className="text-[10px] font-mono text-zinc-500">—</span>
                )}
                {p.peakSeasonId && seasons?.[p.peakSeasonId.toLowerCase()] && (
                  <span className="text-[7.5px] font-mono font-bold text-zinc-400 mt-0.5 tracking-tight">
                    {shortAct(seasons[p.peakSeasonId.toLowerCase()])}
                  </span>
                )}
              </div>

              {/* K/D */}
              <div className="text-right font-mono text-[11px] font-bold" title="K/D Ratio">
                <span className={kd.color}>{kd.text}</span>
              </div>

              {/* Win % */}
              <div className="text-right font-mono text-[11px] font-semibold" title="Act Win Rate">
                {p.winPct != null ? (
                  <span className={p.winPct >= 50 ? 'text-m3-mint' : 'text-zinc-400'}>
                    {p.winPct}%
                  </span>
                ) : (
                  <span className="text-zinc-600">—</span>
                )}
              </div>

              {/* HS % */}
              <div className="text-right font-mono text-[11px]" title="Headshot %">
                {p.hsPct != null ? (
                  <span className="text-amber-200/90 font-medium">{p.hsPct}%</span>
                ) : (
                  <span className="text-zinc-600">—</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const VerticalSquadColumn: React.FC<{
  title: string;
  tagColor: string;
  players: LiveMatchPlayer[];
  tierIcons: Record<number, string>;
}> = ({ title, tagColor, players, tierIcons }) => (
  <div className="flex flex-col gap-1">
    <div className="flex items-center justify-between px-1.5 py-0.5">
      <span className={`text-[10px] font-bold uppercase tracking-wider ${tagColor}`}>{title}</span>
      <span className="text-[9px] font-mono text-zinc-400">{players.length}P</span>
    </div>
    {/* Strongest combat score first — the board reads like the in-game
        leaderboard. Players with no ACS yet keep their relative order at the
        bottom rather than being given a fake score. */}
    {[...players].sort(byAcsDesc).map((p) => {
      const icon = tierIcons[p.tier];
      const peakIcon = tierIcons[p.peakTier];
      const kd = formatKd(p.kd);
      const party = getPartyStyle(p.partyIndex);
      const flagUrl = getFlagUrl(p.country);
      const countryName = getCountryName(p.country);

      return (
        <div
          key={p.puuid}
          title={`${p.name}${p.tag ? '#' + p.tag : ''} • ${p.agentName}${countryName ? ` • ${countryName}` : ''}`}
          className={`relative overflow-hidden grid grid-cols-[18px_24px_28px_26px_36px_32px_36px_34px] items-center gap-x-1.5 h-[28px] px-2 rounded-lg border text-xs transition-colors shrink-0 ${
            party
              ? `${party.bg} border-white/10`
              : p.isMe
              ? 'bg-purple-950/70 border-purple-400/60 ring-1 ring-purple-400/30 text-white shadow-xs'
              : 'bg-black/60 hover:bg-black/70 border-white/10 text-zinc-100'
          }`}
        >
          {/* Party identifier: curved bow arc wrapping the left edge when queued in a party */}
          {party && (
            <svg
              className={`absolute left-0 top-0 bottom-0 h-full w-2 pointer-events-none ${party.text} drop-shadow-[0_0_5px_currentColor]`}
              viewBox="0 0 10 32"
              fill="none"
              preserveAspectRatio="none"
            >
              <title>{`Queued together in ${party.name}`}</title>
              <path
                d="M 8 2.5 C 3.5 2.5, 1.5 5.5, 1.5 10 L 1.5 22 C 1.5 26.5, 3.5 29.5, 8 29.5"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
          )}
          {/* Tracker Score tier badge */}
          <div
            className="flex items-center justify-center shrink-0"
            title={
              p.trnScore != null
                ? `Tracker Score: ${p.trnScore} / 1000 — Tier ${scoreTier(p.trnScore).tier}`
                : 'Tracker Score unavailable'
            }
          >
            {p.trnScore != null ? (
              <ScoreBadge tier={scoreTier(p.trnScore).tier} size={15} />
            ) : (
              <span className="w-3.5 h-3.5 rounded border border-white/10 bg-white/[0.03] flex items-center justify-center text-[7.5px] font-mono text-zinc-600">
                —
              </span>
            )}
          </div>

          {/* Agent Icon (with Flag Overlay + Party dot badge) */}
          <div className="relative w-5 h-5 flex items-center justify-center shrink-0">
            {p.agentIcon ? (
              <img
                src={p.agentIcon}
                alt=""
                draggable={false}
                onError={(e) => {
                  (e.currentTarget as HTMLElement).style.display = 'none';
                }}
                className="w-5 h-5 rounded-md object-cover pointer-events-none select-none border border-white/10"
              />
            ) : (
              <div className="w-5 h-5 rounded-md bg-zinc-800 border border-white/10 flex items-center justify-center text-[9px] font-bold text-zinc-400">
                ?
              </div>
            )}
            {flagUrl && (
              <img
                src={flagUrl}
                alt={p.country || ''}
                title={countryName ? `Country: ${countryName} (${p.country})` : `Country: ${p.country}`}
                draggable={false}
                onError={(e) => {
                  (e.currentTarget as HTMLElement).style.display = 'none';
                }}
                className="absolute -bottom-0.5 -right-0.5 w-3 h-2 object-cover rounded-[1.5px] shadow-xs border border-black/80 pointer-events-none select-none"
              />
            )}
            {party && (
              <span
                className={`absolute -top-0.5 -left-0.5 w-1.5 h-1.5 rounded-full ${party.bar} shadow-xs border border-black/60`}
                title={`Queued together in ${party.name}`}
              />
            )}
          </div>

          {/* Current Rank emblem + live RR */}
          <div className="flex flex-col items-center justify-center leading-none" title={rankTooltip(p)}>
            {icon ? (
              <img src={icon} alt="" draggable={false} className="w-4 h-4 object-contain shrink-0" />
            ) : (
              <span className="text-[10px] font-mono text-zinc-500">—</span>
            )}
            {p.tier > 2 && p.rr != null ? (
              <span className="text-[7px] font-mono font-bold text-m3-primary mt-0.5">{p.rr}</span>
            ) : (
              <span className="text-[7px] font-mono text-transparent mt-0.5 select-none">—</span>
            )}
          </div>

          {/* Peak Rank (Icon only) */}
          <div className="flex items-center justify-center" title={`Peak: ${p.peakRank}`}>
            {peakIcon ? (
              <img src={peakIcon} alt="" draggable={false} className="w-3.5 h-3.5 object-contain opacity-75 shrink-0" />
            ) : (
              <span className="text-[10px] font-mono text-zinc-500">—</span>
            )}
          </div>

          {/* ACS — the sort key, so it reads first among the numbers */}
          <div
            className="text-right font-mono text-[10px] font-bold"
            title="Act-wide average combat score"
          >
            {p.acs != null ? (
              <span className={p.acs >= 200 ? 'text-m3-primary' : p.acs >= 150 ? 'text-zinc-200' : 'text-zinc-400'}>
                {p.acs}
              </span>
            ) : (
              <span className="text-zinc-600">—</span>
            )}
          </div>

          {/* KD */}
          <div className="text-right font-mono text-[10px]" title="Act-wide K/D">
            <span className={kd.color}>{kd.text}</span>
          </div>

          {/* Act-wide win rate */}
          <div className="text-right font-mono text-[10px]" title="Act-wide win rate">
            {p.winPct != null ? (
              <span className={p.winPct >= 50 ? 'text-m3-mint font-semibold' : 'text-rose-400'}>
                {p.winPct.toFixed(0)}%
              </span>
            ) : (
              <span className="text-zinc-600">—</span>
            )}
          </div>

          {/* Act-wide headshot % */}
          <div className="text-right font-mono text-[10px] text-amber-200/90" title="Act-wide headshot %">
            {p.hsPct != null && p.hsPct > 0 ? `${p.hsPct.toFixed(0)}%` : <span className="text-zinc-600">—</span>}
          </div>
        </div>
      );
    })}
  </div>
);
