import React, { useCallback, useEffect, useState, useRef } from 'react';
import { Move, X, AlertTriangle, Crosshair } from 'lucide-react';
import type { LiveMatchState, LiveMatchPlayer } from '../types';
import { fetchLiveMatchState, gameData, matchEndHarvest, harvestMatchNames, isMatchStateEqual, mergeLiveMatchStateNonRegressing } from '../utils/tracker';
import { useTrackerData } from '../hooks/useTrackerData';
import OverlayCrosshair from './OverlayCrosshair';
import { DEFAULT_OVERLAY_CROSSHAIR, sanitizeCrosshairShape } from '../utils/crosshairOverlay';
import { computeMapAgentStats, getRankTierLabel, type AgentStatSummary } from '../utils/mapMeta';
import { fetchBlitzAgentStats, peekBlitzAgentStats, type BlitzAgentStat } from '../utils/blitzMeta';
import { getOverlayEditMode, setOverlayEditMode, isTabDown, isTauri } from '../utils/ipc';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { logger } from '../utils/logger';
import { getPrepickConfig } from '../utils/prepick';

import {
  DEFAULT_OVERLAY_CONFIG,
  clampWidgetPos,
  getDefaultOverlayPositions,
  overlayBoundsKey,
  persistOverlayConfig,
  pruneLayouts,
  samePositions,
  type OverlayConfig,
  type WidgetPos,
} from './hud/overlayConfig';

export {
  DEFAULT_OVERLAY_CONFIG,
  getDefaultOverlayPositions,
} from './hud/overlayConfig';
export type { OverlayConfig, WidgetPos } from './hud/overlayConfig';

import { MetaTiles } from './hud/MetaTiles';
import { PregamePanel } from './hud/PregamePanel';
import { EditChrome } from './hud/EditChrome';
import { MatchPanel } from './hud/MatchPanel';


/* Overlay failures are shown inline for ~6 s, then gone — the window is
 * click-through in-game, so the row cannot be dismissed and must not linger.
 * The durable half: a capped ring of one-line records any diagnostics view can
 * read later (key `recon_overlay_notices_v1`, newest last). */
const OVERLAY_NOTICE_STORAGE_KEY = 'recon_overlay_notices_v1';
const OVERLAY_NOTICE_MAX = 20;

function persistOverlayNotice(text: string): void {
  try {
    const raw = localStorage.getItem(OVERLAY_NOTICE_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed.slice(-(OVERLAY_NOTICE_MAX - 1)) : [];
    list.push({ at: new Date().toISOString(), text });
    localStorage.setItem(OVERLAY_NOTICE_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* Storage blocked: the inline row and the logger still carry it. */
  }
}

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

  // Inline failure surface. Overlay IPC can fail (window gone, style call
  // refused, probe dead) and every caller used to swallow it: the HUD just
  // silently missed data or refused to unlock. The row is click-through in
  // game, so it cannot be dismissed there: it clears itself after 6 s and the
  // durable record goes to `recon_overlay_notices_v1` for diagnostics.
  type OverlayNotice = { kind: 'command' | 'probe'; text: string };
  const [notice, setNotice] = useState<OverlayNotice | null>(null);
  const lastNoticed = useRef<string | null>(null);
  const raiseNotice = useCallback((next: OverlayNotice) => {
    // First failure wins until it clears — a broken probe every tick must not
    // restart the banner or re-render the HUD 2x a second.
    setNotice((prev) => prev ?? next);
    if (lastNoticed.current === next.text) return;
    lastNoticed.current = next.text;
    logger.warn(`[overlay] ${next.text}`);
    persistOverlayNotice(next.text);
  }, []);
  const clearNotice = useCallback((kind: OverlayNotice['kind']) => {
    setNotice((prev) => (prev && prev.kind === kind ? null : prev));
  }, []);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(id);
  }, [notice]);

  // Widget config + positions (persisted)
  const [config, setConfig] = useState<OverlayConfig>(() => {
    const MIGRATION_KEY = 'recon_overlay_cfg_v8_defaults';
    const mergeSaved = (saved: string | null) => {
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      return {
        ...DEFAULT_OVERLAY_CONFIG,
        ...parsed,
        positions: { ...DEFAULT_OVERLAY_CONFIG.positions, ...(parsed.positions || {}) },
        scales: { ...DEFAULT_OVERLAY_CONFIG.scales, ...(parsed.scales || {}) },
        // `...parsed` spreads a stored crosshair blindly; complete + clamp it.
        crosshair: sanitizeCrosshairShape(parsed.crosshair),
        // Per-display layouts are user data: never trust the stored shape.
        layouts:
          parsed.layouts && typeof parsed.layouts === 'object' && !Array.isArray(parsed.layouts)
            ? (parsed.layouts as OverlayConfig['layouts'])
            : {},
      } as OverlayConfig;
    };
    try {
      // Read the saved layout FIRST: writing defaults before reading (as an
      // earlier revision did) wipes custom widget positions/scales.
      const saved = localStorage.getItem('recon_overlay_cfg_v7') || localStorage.getItem('recon_overlay_cfg_v6') || localStorage.getItem('recon_overlay_cfg_v5');
      if (!localStorage.getItem(MIGRATION_KEY)) {
        localStorage.setItem(MIGRATION_KEY, '1');
        const merged = mergeSaved(saved);
        // Pre-pick badge moved to the top-left edge after it shipped once, and
        // its old spot (mid-left) reads as a stray panel. Nudge only that key.
        if (merged) {
          merged.positions = {
            ...merged.positions,
            prepick: getDefaultOverlayPositions().prepick,
          };
        }
        localStorage.setItem('recon_overlay_cfg_v7', JSON.stringify(merged ?? DEFAULT_OVERLAY_CONFIG));
        return merged ?? DEFAULT_OVERLAY_CONFIG;
      }
      const merged = mergeSaved(saved);
      if (merged) {
        // One-time widget parity: a config written before a widget existed (or
        // one that inherited an older OFF default) silently hides it, which the
        // user reads as "my friend doesn't have that widget". Turn the two
        // advisory widgets on ONCE, then let the persisted value rule — the
        // marker is separate so hand-placed positions are never touched.
        const PARITY_KEY = 'recon_overlay_widget_parity_v1';
        if (!localStorage.getItem(PARITY_KEY)) {
          localStorage.setItem(PARITY_KEY, '1');
          const next: OverlayConfig = { ...merged, showTopAgents: true, showPrepick: true };
          localStorage.setItem('recon_overlay_cfg_v7', JSON.stringify(next));
          return next;
        }
        return merged;
      }
    } catch {}
    return DEFAULT_OVERLAY_CONFIG;
  });

  const saveConfig = (next: OverlayConfig) => {
    // Mirror the live offsets into this display's slot on every write, so a
    // later resize/monitor swap can restore exactly what was placed here.
    const merged: OverlayConfig = {
      ...next,
      layouts: {
        ...pruneLayouts(next.layouts),
        [overlayBoundsKey()]: next.positions,
      },
    };
    setConfig(merged);
    persistOverlayConfig(merged);
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
  const prepickRef = useRef<HTMLDivElement>(null);

  const widgetRefs = {
    lobby: lobbyRef,
    pregame: pregameRef,
    topAgents: topAgentsRef,
    prepick: prepickRef,
  };

  // Newest config for callbacks that run outside React's render (resize).
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  });

  // Widget offsets are CSS px, so they only mean anything on the display they
  // were authored on (bounds + DPI scale). Keep one layout per display key,
  // restore it when the window lands on that display, and clamp the live one
  // when it does not fit. Resize-only on purpose: the overlay window is born
  // 800x600 and only becomes the game rect on the first show, so reconciling
  // before that resize would squash hand-placed widgets and persist the loss.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const reconcile = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (w < 320 || h < 240) return;
      const cur = configRef.current;
      const key = overlayBoundsKey();
      const saved = cur.layouts?.[key];
      const source = saved ?? cur.positions;
      const bounds = { w, h };
      const box = (
        ref: React.RefObject<HTMLDivElement | null>,
        fallbackW: number,
        fallbackH: number,
        scale: number
      ) => ({
        w: (ref.current?.offsetWidth || fallbackW) * scale,
        h: (ref.current?.offsetHeight || fallbackH) * scale,
      });
      const next: OverlayConfig['positions'] = {
        lobby: clampWidgetPos(source.lobby, bounds, box(lobbyRef, 304, 220, cur.scales?.lobby ?? 1)),
        pregame: clampWidgetPos(
          source.pregame,
          bounds,
          box(pregameRef, 560, 360, cur.scales?.pregame ?? 1)
        ),
        topAgents: clampWidgetPos(
          source.topAgents,
          bounds,
          box(topAgentsRef, 400, 240, cur.scales?.topAgents ?? 1)
        ),
        prepick: clampWidgetPos(
          source.prepick ?? { x: 10, y: 10 },
          bounds,
          box(prepickRef, 260, 40, cur.scales?.prepick ?? 1)
        ),
      };
      if (saved && samePositions(next, cur.positions)) return;
      const merged: OverlayConfig = {
        ...cur,
        positions: next,
        layouts: { ...pruneLayouts(cur.layouts), [key]: next },
      };
      configRef.current = merged;
      setConfig(merged);
      persistOverlayConfig(merged);
    };

    const onResize = () => {
      if (timer) clearTimeout(timer);
      // A resolution switch reallocs the window twice (game + our align pass).
      timer = setTimeout(reconcile, 250);
    };

    window.addEventListener('resize', onResize);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // Sync edit mode and config changes from main app
  useEffect(() => {
    getOverlayEditMode()
      .then(setIsEditMode)
      .catch((e) => {
        // If the read fails we cannot know whether the window is locked, and a
        // wrong guess is the difference between playable and click-trapped.
        raiseNotice({
          kind: 'command',
          text: `Could not read HUD edit state (${String(e)}) — the overlay may capture clicks`,
        });
      });
    const unlistenEdit = listen<boolean>('overlay-edit-mode-changed', (event) => {
      setIsEditMode(event.payload);
    });
    // The real cross-window config path: both webviews share the WebView2
    // profile, so a save in the main window fires a `storage` event here.
    // The old `overlay-config-changed` Tauri listener is deleted — nothing in
    // the app ever emitted that event, so it only looked like a sync path.
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'recon_overlay_cfg_v7' && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          setConfig((prev) => ({ ...prev, ...parsed, crosshair: sanitizeCrosshairShape(parsed.crosshair) }));
        } catch {}
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      unlistenEdit.then((fn) => fn()).catch(() => {});
    };
  }, [raiseNotice]);

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
        // Idle backoff: fetch every 12th tick ≈ 30s (was every 5th ≈ 12.5s).
        // Wake stays instant: the main window polls every 3s and broadcasts
        // `recon:live-match-sync` on change (listener below applies it
        // immediately), and visibility return forces a fetch via onVis.
        idleSkips.current = (idleSkips.current + 1) % 12;
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
      if (typeof document === 'undefined' || document.hidden) return;
      // Prime the idle counter so the return-from-hidden tick always fetches
      // instead of landing on a skipped slot.
      if (phaseRef.current === 'idle') idleSkips.current = 11;
      tick();
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVis);
    }
    // Riot-local endpoints have no rate limit: 2.5s tick (hidden-tab skip +
    // idle backoff above stay). TRN enrichment keeps its own serial gate.
    const id = setInterval(tick, 2500);

    const unlistenSync = isTauri()
      ? listen<LiveMatchState>('recon:live-match-sync', (event) => {
          if (event.payload) {
            const s = event.payload;
            const harvest = matchEndHarvest(prevStateRef.current, s);
            if (harvest) harvestMatchNames(harvest).catch(() => {});
            // The main window runs its own poll and its own TRN cache, so `s`
            // can be poorer than what we already show. Merge instead of
            // replacing, or the two realms ping-pong for the whole match.
            const merged = mergeLiveMatchStateNonRegressing(prevStateRef.current, s);
            if (!isMatchStateEqual(prevStateRef.current, merged)) {
              prevStateRef.current = merged;
              phaseRef.current = merged.phase;
              setMatchState(merged);
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
  // (coregame) and only when NOT editing. Zero timers when hidden / idle /
  // pregame / edit mode. 500 ms, not 150: 6.7 IPC/s for a whole match was a
  // real share of the overlay's own budget (audit perf #7), and a peek tolerates
  // a half-second. A Rust-side key hook that pushes an event would drop the poll
  // entirely — that half is a Rust change, not this file.
  useEffect(() => {
    const inCoregame = matchState?.phase === 'coregame' && !isEditMode;
    if (!inCoregame) {
      setTabHeld(false);
      return;
    }
    let cancelled = false;
    let failures = 0;
    const probe = async () => {
      try {
        const down = await isTabDown();
        if (failures > 0) {
          failures = 0;
          clearNotice('probe');
        }
        if (!cancelled) setTabHeld((prev) => (prev === down ? prev : down));
      } catch {
        // Dead IPC = the peek never fires. Say it once instead of leaving the
        // player pressing Tab at an overlay that cannot hear the key.
        failures += 1;
        if (!cancelled && failures >= 3) {
          raiseNotice({ kind: 'probe', text: 'Tab peek unavailable — overlay link down' });
        }
      }
    };
    void probe();
    const id = setInterval(probe, 500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [matchState?.phase, isEditMode, raiseNotice, clearNotice]);

  // Exiting edit mode is the one command that can strand the player behind a
  // window that eats clicks, so its failure is surfaced, never swallowed.
  const exitEditMode = useCallback(async () => {
    try {
      await setOverlayEditMode(false);
      setIsEditMode(false);
      clearNotice('command');
    } catch (e) {
      raiseNotice({
        kind: 'command',
        text: `Could not unlock the HUD (${String(e)}) — Esc again, or quit Recon from the tray`,
      });
    }
  }, [raiseNotice, clearNotice]);

  // Esc exits edit mode (overlay holds focus while editing, so the main
  // app's Lock button may be unreachable behind the fullscreen layer).
  useEffect(() => {
    if (!isEditMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void exitEditMode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isEditMode, exitEditMode]);

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

      // Clamp so the visual box stays on screen: the widget is scaled from its
      // top-left corner, so the real footprint is layout size x scale.
      const sc = config.scales?.[key] ?? 1.0;
      const screenW = typeof window !== 'undefined' ? window.innerWidth : 2088;
      const screenH = typeof window !== 'undefined' ? window.innerHeight : 1440;
      const clamped = clampWidgetPos(
        { x: basePos.x + dx, y: basePos.y + dy },
        { w: screenW, h: screenH },
        {
          w: (targetEl?.offsetWidth ?? 120) * sc,
          h: (targetEl?.offsetHeight ?? 80) * sc,
        }
      );
      const clampedX = clamped.x;
      const clampedY = clamped.y;

      curX = clampedX;
      curY = clampedY;

      if (targetEl) {
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
  // In-match only (edit mode always previews) — a crosshair floating over the
  // lobby/menus is wrong. Matches the widgetVisible = flag && (phase || edit) convention.
  const crosshairVisible = !!config.showCrosshair && (isEditMode || isCoregame);
  const xhair = config.crosshair ?? DEFAULT_OVERLAY_CROSSHAIR;

  // Safe Pre-Picker reminder: visible while simply queued (no lobby yet), and
  // hidden the moment Agent Select or the game starts — the hover is spent by
  // then, and the badge is a "is it armed?" reminder for the queue wait.
  // Also hides itself when the Pre-Picker is off, so it never claims "armed".
  const prepickCfg = getPrepickConfig();
  const prepickAgent =
    (matchState?.mapName
      ? prepickCfg.mapAgents[matchState.mapName.toLowerCase()]?.agentName
      : '') || prepickCfg.defaultAgentName;
  const prepickArmed = !!prepickCfg.enabled && !!prepickAgent;
  const prepickIcon = Object.values(agentMap).find(
    (a) => a.name.toLowerCase() === prepickAgent.toLowerCase()
  )?.icon || '';
  const prepickVisible =
    !!config.showPrepick &&
    prepickArmed &&
    (isEditMode || (!isPregame && !isCoregame && !matchState?.isPreviousMatch));
  // Audit overlay#4: tell Rust whether the HUD has content of its own right
  // now. With `false` the daemon stops compositing the full-screen alpha layer
  // for the whole match; its 100 ms guard thread still shows the layer while Tab
  // is held, and the overlay is brought back the moment this flips true.
  //
  // The Tab peek is deliberately NOT part of this. Rust's guard owns that
  // transition already, and reporting `present=true` for it would pin the layer
  // on for up to the 2 s daemon tick after every Tab release — the opposite of
  // the saving. Everything else that paints outside the peek must be listed.
  const hudPresent =
    isEditMode || pregameVisible || topAgentsVisible || prepickVisible || crosshairVisible;
  const presentSent = useRef<boolean | null>(null);
  useEffect(() => {
    // Debounced: phase transitions flip several gates at once and re-renders
    // are frequent, but the backend only needs the settled value.
    const t = setTimeout(() => {
      if (presentSent.current === hudPresent) return;
      presentSent.current = hudPresent;
      if (!isTauri()) return;
      // Rust names the argument `needed` (lib.rs: set_overlay_present(needed)),
      // and Tauri matches JS keys to Rust parameter names — `{ present }` would
      // fail with "missing required key needed" on every call.
      invoke('set_overlay_present', { needed: hudPresent }).catch((e) => {
        raiseNotice({ kind: 'command', text: `HUD layer switch failed (${String(e)})` });
      });
    }, 200);
    return () => clearTimeout(t);
  }, [hudPresent, raiseNotice]);

  return (
    <div
      ref={rootRef}
      onDragStart={(e) => e.preventDefault()}
      className="fixed inset-0 w-screen h-screen select-none overflow-hidden font-sans pointer-events-none"
      style={{ backgroundColor: 'transparent' }}
    >
      <EditChrome
        isEditMode={isEditMode}
        config={config}
        xhair={xhair}
        saveConfig={saveConfig}
        exitEditMode={exitEditMode}
      />


      {/* Inline failure row: overlay IPC is silent by default (every command
          returns () and the caller used to drop the error). Bottom-centre so it
          never covers the edit toolbar or the HUD widgets. */}
      {notice && (
        <div className="fixed bottom-4 inset-x-0 mx-auto w-fit max-w-[92vw] z-[60] pointer-events-auto flex items-center gap-2 px-3 py-1.5 rounded-xl bg-rose-950/90 border border-rose-400/50 shadow-2xl">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-300 shrink-0" />
          <span className="text-[10.5px] font-mono text-rose-100 leading-snug">{notice.text}</span>
          {isEditMode && (
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="ml-1 w-4 h-4 rounded-lg bg-rose-400/20 hover:bg-rose-400/40 text-rose-100 flex items-center justify-center cursor-pointer"
              aria-label="Dismiss overlay warning"
            >
              <X className="w-3 h-3 stroke-[2.5]" />
            </button>
          )}
        </div>
      )}


      {/* ============================================================ */}
      {/* WIDGET: Match Panel — agent select always on, in-match Tab-peek only */}
      {/* ============================================================ */}
      {scoreVisible && (
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
          } select-none w-[304px] will-change-transform z-10 ${
            isEditMode
              ? 'cursor-grab active:cursor-grabbing border-2 border-dashed border-m3-primary bg-m3-primary/10 rounded-3xl p-1.5 shadow-[0_0_30px_rgba(168,85,247,0.45)] ring-2 ring-m3-primary/30'
              : ''
          }`}
        >
          {isEditMode && (
            <>
              {/* Corner crosshairs so the bounding box is 100% obvious */}
              <div className="absolute -top-1.5 -left-1.5 w-3.5 h-3.5 border-t-2 border-l-2 border-m3-primary pointer-events-none" />
              <div className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 border-t-2 border-r-2 border-m3-primary pointer-events-none" />
              <div className="absolute -bottom-1.5 -left-1.5 w-3.5 h-3.5 border-b-2 border-l-2 border-m3-primary pointer-events-none" />
              <div className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 border-b-2 border-r-2 border-m3-primary pointer-events-none" />

              <div
                onPointerDown={(e) => startDrag('lobby', e)}
                className="mb-1.5 px-3 py-1.5 rounded-2xl bg-m3-primary-container/50 border border-m3-primary/45 flex items-center justify-between cursor-grab active:cursor-grabbing text-[11px] font-mono font-bold text-m3-on-surface select-none shadow-md"
              >
                <div className="flex items-center gap-1.5">
                  <Move className="w-3.5 h-3.5 text-m3-primary" />
                  <span>Match Status • ({Math.round(config.positions.lobby.x)}, {Math.round(config.positions.lobby.y)})</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-m3-on-surface-variant font-normal">Hold to drag</span>
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      saveConfig({ ...config, showLobby: false });
                    }}
                    className="w-5 h-5 rounded-lg bg-red-500/30 hover:bg-red-500/50 border border-red-500/40 text-red-200 hover:text-white flex items-center justify-center cursor-pointer transition-colors"
                    data-tip="Remove Scoreboard from screen"
                  >
                    <X className="w-3.5 h-3.5 stroke-[2.5]" />
                  </button>
                </div>
              </div>
              <div
                onPointerDown={(e) => startResize('lobby', e)}
                className="absolute -bottom-1 -right-1 w-5 h-5 rounded-br-2xl bg-m3-primary/90 hover:bg-m3-primary cursor-nwse-resize flex items-center justify-center text-[11px] text-m3-on-primary font-black select-none shadow-md z-10"
                data-tip="Drag to resize HUD widget"
              >
                ↘
              </div>
            </>
          )}
          <MatchPanel
            isEditMode={isEditMode}
            matchState={matchState}
            showStartingSide={config.showStartingSide}
            liveBlue={liveBlue}
            yourTeam={yourTeam}
            enemyTeam={enemyTeam}
            tierIcons={tierIcons}
          />
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
          } select-none w-[560px] max-w-[96vw] will-change-transform z-10 ${
            isEditMode
              ? 'cursor-grab active:cursor-grabbing border-2 border-dashed border-m3-primary bg-m3-primary/10 rounded-3xl p-1.5 shadow-[0_0_35px_rgba(168,85,247,0.5)] ring-2 ring-m3-primary/30'
              : ''
          }`}
        >
          {isEditMode && (
            <>
              {/* Corner crosshairs so bounding box is 100% visible */}
              <div className="absolute -top-1.5 -left-1.5 w-4 h-4 border-t-2 border-l-2 border-m3-primary pointer-events-none" />
              <div className="absolute -top-1.5 -right-1.5 w-4 h-4 border-t-2 border-r-2 border-m3-primary pointer-events-none" />
              <div className="absolute -bottom-1.5 -left-1.5 w-4 h-4 border-b-2 border-l-2 border-m3-primary pointer-events-none" />
              <div className="absolute -bottom-1.5 -right-1.5 w-4 h-4 border-b-2 border-r-2 border-m3-primary pointer-events-none" />

              <div
                onPointerDown={(e) => startDrag('pregame', e)}
                className="mb-2 px-3.5 py-1.5 rounded-2xl bg-m3-primary-container/50 border border-m3-primary/45 flex items-center justify-between cursor-grab active:cursor-grabbing text-xs font-mono font-bold text-m3-on-surface select-none shadow-md"
              >
                <div className="flex items-center gap-1.5">
                  <Move className="w-3.5 h-3.5 text-m3-primary" />
                  <span>Agent Select • ({Math.round(config.positions.pregame.x)}, {Math.round(config.positions.pregame.y)})</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-m3-on-surface-variant font-normal">Hold to drag</span>
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      saveConfig({ ...config, showPregame: false });
                    }}
                    className="w-5 h-5 rounded-lg bg-red-500/30 hover:bg-red-500/50 border border-red-500/40 text-red-200 hover:text-white flex items-center justify-center cursor-pointer transition-colors"
                    data-tip="Remove Agent Select from screen"
                  >
                    <X className="w-3.5 h-3.5 stroke-[2.5]" />
                  </button>
                </div>
              </div>
              <div
                onPointerDown={(e) => startResize('pregame', e)}
                className="absolute -bottom-1 -right-1 w-5 h-5 rounded-br-2xl bg-m3-primary/90 hover:bg-m3-primary cursor-nwse-resize flex items-center justify-center text-[11px] text-m3-on-primary font-black select-none shadow-md z-10"
                data-tip="Drag to resize HUD widget"
              >
                ↘
              </div>
            </>
          )}
          <PregamePanel
            isEditMode={isEditMode}
            matchState={matchState}
            isPregame={isPregame}
            showStartingSide={config.showStartingSide}
            yourTeam={yourTeam}
            tierIcons={tierIcons}
            seasonNames={seasonNames}
          />
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
          } select-none w-[400px] will-change-transform z-10 ${
            isEditMode
              ? 'cursor-grab active:cursor-grabbing border-2 border-dashed border-m3-primary bg-m3-primary/10 rounded-3xl p-1.5 shadow-[0_0_30px_rgba(168,85,247,0.45)] ring-2 ring-m3-primary/30'
              : ''
          }`}
        >
          {isEditMode && (
            <>
              {/* Corner crosshairs so bounding box is 100% visible */}
              <div className="absolute -top-1.5 -left-1.5 w-3.5 h-3.5 border-t-2 border-l-2 border-m3-primary pointer-events-none" />
              <div className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 border-t-2 border-r-2 border-m3-primary pointer-events-none" />
              <div className="absolute -bottom-1.5 -left-1.5 w-3.5 h-3.5 border-b-2 border-l-2 border-m3-primary pointer-events-none" />
              <div className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 border-b-2 border-r-2 border-m3-primary pointer-events-none" />

              <div
                onPointerDown={(e) => startDrag('topAgents', e)}
                className="mb-2 px-3.5 py-1.5 rounded-2xl bg-m3-primary-container/50 border border-m3-primary/45 flex items-center justify-between cursor-grab active:cursor-grabbing text-xs font-mono font-bold text-m3-on-surface select-none shadow-md"
              >
                <div className="flex items-center gap-1.5">
                  <Move className="w-3.5 h-3.5 text-m3-primary" />
                  <span>Top Agents • ({Math.round(config.positions.topAgents.x)}, {Math.round(config.positions.topAgents.y)})</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-m3-on-surface-variant font-normal">Hold to drag</span>
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      saveConfig({ ...config, showTopAgents: false });
                    }}
                    className="w-5 h-5 rounded-lg bg-red-500/30 hover:bg-red-500/50 border border-red-500/40 text-red-200 hover:text-white flex items-center justify-center cursor-pointer transition-colors"
                    data-tip="Remove Map Agents from screen"
                  >
                    <X className="w-3.5 h-3.5 stroke-[2.5]" />
                  </button>
                </div>
              </div>
              <div
                onPointerDown={(e) => startResize('topAgents', e)}
                className="absolute -bottom-1 -right-1 w-5 h-5 rounded-br-2xl bg-m3-primary/90 hover:bg-m3-primary cursor-nwse-resize flex items-center justify-center text-[11px] text-m3-on-primary font-black select-none shadow-md z-10"
                data-tip="Drag to resize HUD widget"
              >
                ↘
              </div>
            </>
          )}

          <MetaTiles
            isEditMode={isEditMode}
            showMetaPicks={showMetaPicks}
            personalScope={personalScope}
            personalListCount={personalListCount}
            rankTierLabel={rankTierLabel}
            activeMapName={activeMapName}
            thinMapSample={thinMapSample}
            mapGames={mapGames}
            hasMetaForMap={hasMetaForMap}
            hasWinningAgentOnMap={hasWinningAgentOnMap}
            metaPicks={metaPicks}
            topAgentsList={topAgentsList}
            agentMap={agentMap}
            setViewMode={setViewMode}
          />
        </div>
      )}

      {/* ============================================================ */}
      {/* WIDGET 5: Safe Pre-Picker reminder (lobby only)              */}
      {/* ============================================================ */}
      {prepickVisible && (
        <div
          ref={prepickRef}
          onPointerDown={(e) => startDrag('prepick', e)}
          style={{
            transform: `translate3d(${config.positions.prepick?.x ?? 22}px, ${config.positions.prepick?.y ?? 520}px, 0) scale(${config.scales?.prepick ?? 1.0})`,
            transformOrigin: 'top left',
            touchAction: 'none',
          }}
          className={`fixed top-0 left-0 ${
            isEditMode ? 'pointer-events-auto' : 'pointer-events-none'
          } select-none will-change-transform z-10 ${
            isEditMode
              ? 'cursor-grab active:cursor-grabbing border-2 border-dashed border-m3-primary bg-m3-primary/10 rounded-3xl p-1.5 shadow-[0_0_30px_rgba(182,171,247,0.45)] ring-2 ring-white/20'
              : ''
          }`}
        >
          {isEditMode && (
            <div
              onPointerDown={(e) => startDrag('prepick', e)}
              className="mb-2 px-3.5 py-1.5 rounded-2xl bg-m3-primary-container/50 border border-m3-primary/40 flex items-center justify-between cursor-grab active:cursor-grabbing text-[11px] font-mono font-bold text-m3-on-surface select-none shadow-m3-1"
            >
              <div className="flex items-center gap-1.5">
                <Move className="w-3.5 h-3.5 text-m3-primary" />
                <span>
                  Pre-Pick • ({Math.round(config.positions.prepick?.x ?? 10)},{' '}
                  {Math.round(config.positions.prepick?.y ?? 10)})
                </span>
              </div>
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  saveConfig({ ...config, showPrepick: false });
                }}
                className="w-5 h-5 rounded-lg bg-red-500/30 hover:bg-red-500/50 border border-red-500/40 text-red-200 hover:text-white flex items-center justify-center cursor-pointer transition-colors"
                data-tip="Remove Pre-Pick badge from screen"
              >
                <X className="w-3.5 h-3.5 stroke-[2.5]" />
              </button>
            </div>
          )}

          <div className="rounded-2xl border border-m3-outline-variant/50 bg-m3-surface-container/[0.85] shadow-m3-2 px-3 py-2.5 flex items-center gap-2.5">
            {prepickIcon ? (
              <img
                src={prepickIcon}
                alt=""
                draggable={false}
                className="w-9 h-9 rounded-xl object-cover shrink-0 border border-m3-outline-variant/50 bg-m3-surface-container-high/60 pointer-events-none select-none"
              />
            ) : (
              <div className="w-9 h-9 rounded-xl shrink-0 border border-m3-outline-variant/50 bg-m3-surface-container-high/60 flex items-center justify-center">
                <Crosshair className="w-4 h-4 text-m3-primary" />
              </div>
            )}
            <div className="flex flex-col leading-tight min-w-0">
              <span className="font-display font-bold text-[11px] text-m3-on-surface-variant tracking-wider uppercase">
                Pre-Pick
              </span>
              <span className="font-mono text-[11px] text-m3-on-surface font-bold truncate">
                {prepickAgent}
                <span className="text-m3-outline font-normal"> • hover only</span>
              </span>
            </div>
            <span className="ml-1 w-1.5 h-1.5 rounded-full bg-m3-mint shrink-0" />
          </div>
        </div>
      )}

      {/* Centre-anchored, non-draggable widget — no widgetRefs/positions/scales entry. */}
      {crosshairVisible && <OverlayCrosshair shape={config.crosshair ?? DEFAULT_OVERLAY_CROSSHAIR} />}
    </div>
  );
};

