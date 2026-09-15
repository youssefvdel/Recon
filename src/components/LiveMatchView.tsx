import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  Shield,
  Radio,
  Lock,
  EyeOff,
  Swords,
  Users,
  Clock,
  Sparkles,
  Copy,
  Check,
} from 'lucide-react';
import type { LiveMatchState, LiveMatchPlayer } from '../types';
import {
  fetchLiveMatchState,
  peekLiveMatchState,
  getLastActiveMatch,
  gameData,
  matchEndHarvest,
  harvestMatchNames,
  fetchMatchLoadouts,
  isMatchStateEqual,
} from '../utils/tracker';
import { getPrepickConfig } from '../utils/prepick';
import {
  loadWeaponCatalog,
  parseLoadouts,
  resolveLoadoutForPlayer,
  type PlayerLoadout,
} from '../utils/loadout';
import { LoadoutViewer } from './LoadoutViewer';
import { useTrackerData } from '../hooks/useTrackerData';
import { ScoreBadge, scoreTier } from './ScoreBadge';
import { ServerChip } from './ServerChip';
import {
  getFlagUrl,
  getCountryName,
  getTrackerUrls,
  rankTooltip,
  shortAct,
  formatKd,
  getPartyStyle,
  splitTeams,
  byAcsDesc,
} from '../utils/playerDisplay';
import { isTauri, openExternalUrl } from '../utils/ipc';
import { listen } from '@tauri-apps/api/event';

/* In-app Live Match page.

   IMPORTANT — data honesty:
   Riot's local client API exposes the live match LOBBY (who is in it, their
   ranks, agent picks, party grouping) but NO live combat data. There is no
   endpoint, log line, or local socket carrying current-match kills, deaths,
   round score, or in-match headshot %. Verified against the live payload, the
   official endpoint schema, and the game's own log files.

   So every number on this page is act/career aggregate from Riot + Tracker.gg,
   never a fabricated "current match" figure. The column header says so
   explicitly. Live combat stats would require Overwolf's Game Events Provider
   (a licensed Overwolf-only API) or screen OCR — see ROADMAP.md. */

export const LiveMatchView: React.FC = () => {
  /* Seeded from the last known lobby so the first paint already has data.
     Starting at `null` made the "Waiting for Valorant Match" empty state flash
     for a frame or two on every visit before the fetch resolved. */
  const [matchState, setMatchState] = useState<LiveMatchState | null>(() =>
    peekLiveMatchState()
  );
  // Loadout viewer — Riot serves equipped skins per phase (agent select +
  // live match), so the data is fetched on demand rather than polled.
  const [loadoutFor, setLoadoutFor] = useState<LiveMatchPlayer | null>(null);
  const loadoutReq = useRef(0);
  const [loadoutData, setLoadoutData] = useState<PlayerLoadout | null>(null);
  const [loadoutLoading, setLoadoutLoading] = useState(false);
  const [loadoutAmbiguous, setLoadoutAmbiguous] = useState(false);
  const [loadoutReason, setLoadoutReason] = useState<string | null>(null);
  const [tierIcons, setTierIcons] = useState<Record<number, string>>({});
  const prevStateRef = useRef<LiveMatchState | null>(null);

  // Act labels for the peak-act caption under the peak emblem.
  const { seasonNames } = useTrackerData();

  const loadState = useCallback(async () => {
    try {
      const s = await fetchLiveMatchState(undefined, true);
      setMatchState(s);
    } catch {}
  }, []);

  useEffect(() => {
    gameData().then((d) => setTierIcons(d.tierIcons)).catch(() => {});
    loadState();
  }, [loadState]);

  // Background live sync: synchronized with in-game overlay via events,
  // refreshed instantly on focus/visibility, and polled in background.
  useEffect(() => {
    const poll = () => {
      fetchLiveMatchState()
        .then((s) => {
          // Match just ended: hidden names are released by Riot only now.
          const harvest = matchEndHarvest(prevStateRef.current, s);
          if (harvest) harvestMatchNames(harvest).catch(() => {});
          if (!isMatchStateEqual(prevStateRef.current, s)) {
            prevStateRef.current = s;
            setMatchState(s);
          }
        })
        .catch(() => {});
    };

    const onGlobalRefresh = () => {
      fetchLiveMatchState(undefined, true)
        .then((s) => {
          prevStateRef.current = s;
          setMatchState(s);
        })
        .catch(() => {});
    };
    window.addEventListener('recon:global-refresh', onGlobalRefresh);

    const onVis = () => {
      if (typeof document !== 'undefined' && !document.hidden) poll();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVis);
      window.addEventListener('focus', onVis);
    }

    const unlistenSync = isTauri()
      ? listen<LiveMatchState>('recon:live-match-sync', (event) => {
          if (event.payload) {
            const s = event.payload;
            const harvest = matchEndHarvest(prevStateRef.current, s);
            if (harvest) harvestMatchNames(harvest).catch(() => {});
            if (!isMatchStateEqual(prevStateRef.current, s)) {
              prevStateRef.current = s;
              setMatchState(s);
            }
          }
        })
      : null;

    // Riot-local endpoints have no rate limit: 3s lobby poll. TRN enrichment
    // (per-player stats) stays behind its own 1.5–3s serial gate, untouched.
    const interval = setInterval(poll, 3000);
    return () => {
      clearInterval(interval);
      window.removeEventListener('recon:global-refresh', onGlobalRefresh);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('focus', onVis);
      }
      unlistenSync?.then((fn) => fn()).catch(() => {});
    };
  }, []);

  /**
   * Open a player's loadout.
   *
   * Riot serves equipped skins from the per-phase match route
   * (`pregame/v1/.../loadouts` during agent select, `core-game/v1/.../loadouts`
   * once the match is live), so this needs a live `matchId`. With no live
   * match the viewer says so instead of rendering a grid of fake defaults.
   */
  const openLoadout = useCallback(
    async (p: LiveMatchPlayer) => {
      setLoadoutFor(p);
      setLoadoutData(null);
      setLoadoutAmbiguous(false);
      setLoadoutReason(null);

      const matchId = matchState?.matchId ?? '';
      const phase = matchState?.phase;
      if (!matchId || (phase !== 'coregame' && phase !== 'pregame')) {
        setLoadoutReason('Loadouts are available only while a match is in progress.');
        return;
      }

      setLoadoutLoading(true);
      // Rapid Skins clicks interleave freely — a slow first click must not
      // overwrite the second player's result. Stale completions exit quietly.
      const seq = ++loadoutReq.current;
      const isLatest = () => seq === loadoutReq.current;
      try {
        const region = (p.region || 'eu').replace(/[0-9]+$/, '').toLowerCase();
        const [raw, catalog] = await Promise.all([
          fetchMatchLoadouts(matchId, region, phase),
          loadWeaponCatalog(),
        ]);
        if (!isLatest()) return;
        const all = parseLoadouts(raw, catalog);
        if (all.length === 0) {
          setLoadoutReason('Riot returned no loadout data for this match yet.');
          return;
        }
        const teammates = [...(matchState?.blueTeam ?? []), ...(matchState?.redTeam ?? [])];
        const index = teammates.findIndex((t) => t.puuid === p.puuid);
        const { loadout, ambiguous } = resolveLoadoutForPlayer(all, {
          puuid: p.puuid,
          characterId: p.agentId,
          index: index >= 0 ? index : undefined,
        });
        if (!isLatest()) return;
        setLoadoutAmbiguous(ambiguous);
        if (!loadout) {
          setLoadoutReason(
            'No loadout entry matched this player for this match — it may have rotated since the lobby loaded. Close and reopen Skins.'
          );
          return;
        }
        setLoadoutData(loadout);
      } catch {
        if (isLatest()) setLoadoutReason('Could not read the loadout from the Riot client.');
      } finally {
        if (isLatest()) setLoadoutLoading(false);
      }
    },
    [matchState]
  );

  const lastActive = getLastActiveMatch();
  const effectiveState: LiveMatchState | null = useMemo(() => {
    if (matchState && matchState.phase !== 'idle' && (matchState.blueTeam.length > 0 || matchState.redTeam.length > 0)) {
      return matchState;
    }
    if (lastActive && (lastActive.blueTeam.length > 0 || lastActive.redTeam.length > 0)) {
      return { ...lastActive, isPreviousMatch: true };
    }
    return matchState;
  }, [matchState, lastActive]);

  const isLive = Boolean(effectiveState && (effectiveState.blueTeam.length > 0 || effectiveState.redTeam.length > 0));
  // Pre-picker status banner: lobby-only. In agent select the picker already
  // hovered; in-game there is nothing to pick — showing it there would blur
  // whether the feature is armed. Only the pre-match waiting screen shows it.
  const isLobbyWaiting = !isLive && !(effectiveState as LiveMatchState | null)?.isPreviousMatch;

  // Your team / enemy team, with Deathmatch flattened into one FFA board.
  const teams = useMemo(
    () =>
      effectiveState
        ? splitTeams({
            isDeathmatch: effectiveState.isDeathmatch,
            blueTeam: effectiveState.blueTeam,
            redTeam: effectiveState.redTeam,
          })
        : { yours: [], theirs: [], isFfa: false },
    [effectiveState]
  );

  return (
    <div className="h-full min-h-0 flex flex-col justify-start gap-2.5 max-w-6xl mx-auto w-full overflow-hidden px-6 pt-3 pb-6 select-none">
      {/* Consolidated Live Match Status Bar */}
      {isLive && effectiveState && (
        <MatchStatusStrip
          state={effectiveState}
        />
      )}

      {/* Main Content Area */}
      {!isLive ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 rounded-3xl bg-m3-surface-container-low border border-m3-outline-subtle text-center">
          <div className="w-16 h-16 rounded-3xl bg-m3-surface-container-high border border-m3-outline-subtle flex items-center justify-center text-m3-outline mb-3">
            <Radio className="w-8 h-8 animate-pulse text-m3-primary" />
          </div>
          <h3 className="font-display font-bold text-lg text-m3-on-surface">
            Waiting for Valorant Match
          </h3>
          <p className="text-xs text-m3-outline max-w-sm mt-1 mb-4 leading-relaxed">
            Queue into Agent Select or an active game. Recon detects lobby players and pulls ranks, RR, and top agents live.
          </p>
          <div className="flex items-center gap-2 text-[11px] text-m3-outline font-medium bg-m3-surface-container px-3 py-1.5 rounded-xl border border-m3-outline-subtle">
            <Shield className="w-3.5 h-3.5 text-m3-mint" />
            <span>100% Vanguard Safe • Zero DLL / Game Memory Injections</span>
          </div>
          {isLobbyWaiting &&
            (() => {
              const prepick = getPrepickConfig();
              const targetAgent = prepick.defaultAgentName;
              if (!prepick.enabled || !targetAgent) return null;
              return (
                <div className="mt-3 flex items-center gap-2 text-[11px] font-mono font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 px-3 py-1.5 rounded-xl">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span>Auto-Hover Ready: {targetAgent}</span>
                </div>
              );
            })()}
        </div>
      ) : teams.isFfa ? (
        <PlayerTable
          hideHeader
          accent="gold"
          players={teams.yours}
          tierIcons={tierIcons}
          seasonNames={seasonNames}
          queueId={effectiveState?.queueId}
          onShowLoadout={openLoadout}
        />
      ) : effectiveState?.isRange ? (
        <PlayerTable
          title="The Range — Practice"
          accent="mint"
          players={teams.yours}
          tierIcons={tierIcons}
          seasonNames={seasonNames}
          queueId={effectiveState?.queueId}
          onShowLoadout={openLoadout}
        />
      ) : (
        <div className="flex flex-col justify-start gap-2.5 shrink-0">
          <PlayerTable
            title="Your Team"
            accent="primary"
            players={teams.yours}
            tierIcons={tierIcons}
            seasonNames={seasonNames}
            queueId={effectiveState?.queueId}
            onShowLoadout={openLoadout}
          />

          {effectiveState?.phase === 'coregame' || effectiveState?.isPreviousMatch || teams.theirs.length > 0 ? (
            <PlayerTable
              title="Enemy Team"
              accent="coral"
              players={teams.theirs}
              tierIcons={tierIcons}
              seasonNames={seasonNames}
              queueId={effectiveState?.queueId}
              onShowLoadout={openLoadout}
            />
          ) : (
            <div className="p-3 rounded-xl bg-m3-surface-container border border-m3-outline-subtle text-center text-[11px] text-m3-outline flex items-center justify-center gap-2">
              <Lock className="w-3.5 h-3.5 text-m3-outline" />
              <span>Opponent team details are hidden by Riot during Agent Select to prevent queue dodging.</span>
            </div>
          )}
        </div>
      )}

      {loadoutFor && (
        <LoadoutViewer
          player={loadoutFor}
          loadout={loadoutData}
          loading={loadoutLoading}
          ambiguous={loadoutAmbiguous}
          unavailableReason={loadoutReason}
          onClose={() => {
            setLoadoutFor(null);
            setLoadoutData(null);
            setLoadoutReason(null);
          }}
        />
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Live match status strip                                             */
/* ------------------------------------------------------------------ */

const MatchStatusStrip: React.FC<{
  state: LiveMatchState;
}> = ({ state }) => {
  const units = (n: number) => `${n} Player${n === 1 ? '' : 's'}`;

  return (
    <section className="rounded-xl bg-m3-surface-container-low border border-m3-outline-subtle px-3 py-1.5 flex items-center gap-x-3 gap-y-1 flex-wrap text-[10px] shrink-0">
      {/* Live Phase indicator */}
      <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-m3-surface-container-high border border-m3-outline-subtle text-[10px] font-mono font-bold shrink-0">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            state.isPreviousMatch
              ? 'bg-amber-400'
              : state.phase === 'coregame' || state.phase === 'pregame'
              ? 'bg-m3-mint animate-pulse'
              : 'bg-m3-outline'
          }`}
        />
        <span className={state.isPreviousMatch ? 'text-amber-300' : state.phase === 'coregame' || state.phase === 'pregame' ? 'text-m3-mint' : 'text-m3-outline'}>
          {state.isPreviousMatch
            ? 'PREVIOUS MATCH • WAITING FOR QUEUE'
            : state.phase === 'coregame'
            ? 'IN MATCH'
            : state.phase === 'pregame'
            ? 'AGENT SELECT'
            : 'IDLE'}
        </span>
      </div>

      {/* Safe Pre-pick status badge — lobby only.
          Hidden during Agent Select and in-game: the hover already happened,
          and the badge is meant as an "is it armed?" reminder while queuing. */}
      {(() => {
        const prepick = getPrepickConfig();
        const mapKey = state.mapName ? state.mapName.toLowerCase() : '';
        const targetAgent = (mapKey && prepick.mapAgents[mapKey]?.agentName) || prepick.defaultAgentName;
        if (!prepick.enabled || !targetAgent) return null;
        const inAgentSelectOrGame =
          !state.isPreviousMatch && (state.phase === 'pregame' || state.phase === 'coregame');
        if (inAgentSelectOrGame) return null;
        return (
          <span
            className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-[9.5px] font-mono font-bold text-emerald-300 shrink-0"
            title="Pre-Picker armed: hovers this agent instantly in Agent Select, then locks it in after your delay"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>Pre-pick: {targetAgent}</span>
          </span>
        );
      })()}

      {/* Map */}
      <span className="flex items-center gap-1.5 font-mono text-m3-outline shrink-0">
        <Swords className="w-3 h-3 text-m3-primary" />
        <span className="font-bold text-m3-on-surface">{state.mapName || 'Unknown map'}</span>
      </span>

      {/* Mode badge */}
      {state.mode && (
        <span className="px-2 py-0.5 rounded-md bg-purple-500/20 border border-purple-400/30 text-purple-200 text-[9.5px] font-mono font-bold uppercase shrink-0 tracking-wider">
          {state.mode}
        </span>
      )}

      {/* Match server — hides when Riot reports none (menus / no match) */}
      <ServerChip serverName={state.serverName} />

      {state.startingSide && !state.isDeathmatch && (
        <span className="flex items-center gap-1.5 font-mono text-m3-outline shrink-0">
          <span className="text-m3-outline">Starting side</span>
          <span
            className={`px-1.5 py-px rounded font-bold ${
              state.startingSide === 'Attack'
                ? 'bg-m3-coral/15 text-m3-coral border border-m3-coral/30'
                : 'bg-m3-mint/15 text-m3-mint border border-m3-mint/30'
            }`}
          >
            {state.startingSide}
          </span>
        </span>
      )}

      <span className="flex items-center gap-1.5 font-mono text-m3-outline shrink-0">
        <Users className="w-3 h-3" />
        <span>{units(state.blueTeam.length + state.redTeam.length)} in lobby</span>
      </span>

      {/* Sync timestamp (refresh lives in the top bar) */}
      <div className="flex items-center gap-2 font-mono text-m3-outline ml-auto shrink-0">
        <span className="flex items-center gap-1 text-m3-outline text-[9.5px]">
          <Clock className="w-3 h-3" />
          <span>synced {state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : '—'}</span>
        </span>
      </div>
    </section>
  );
};

/* ------------------------------------------------------------------ */
/* Player table — mirrors the Agent Select widget's columns            */
/* ------------------------------------------------------------------ */

const GRID = 'grid grid-cols-[1fr_64px_28px_70px_68px_42px_38px_42px_38px_34px] items-center gap-x-1.5';

const ACCENTS: Record<string, { tag: string; border: string }> = {
  primary: { tag: 'bg-m3-primary/15 text-m3-primary border-m3-primary/30', border: 'border-m3-primary/25' },
  coral: { tag: 'bg-m3-coral/15 text-m3-coral border-m3-coral/30', border: 'border-m3-coral/25' },
  gold: { tag: 'bg-m3-gold/15 text-m3-gold border-m3-gold/30', border: 'border-m3-gold/25' },
  mint: { tag: 'bg-m3-mint/15 text-m3-mint border-m3-mint/30', border: 'border-m3-mint/25' },
};

const PlayerTable: React.FC<{
  title?: string;
  accent: keyof typeof ACCENTS;
  players: LiveMatchPlayer[];
  tierIcons: Record<number, string>;
  seasonNames: Record<string, string>;
  /** Queue being played — captions the Last-24h column so it reads mode-scoped. */
  queueId?: string;
  onShowLoadout?: (p: LiveMatchPlayer) => void;
  hideHeader?: boolean;
}> = ({ title, accent, players, tierIcons, seasonNames, onShowLoadout, hideHeader }) => {
  const a = ACCENTS[accent] ?? ACCENTS.primary;

  return (
    <section
      className={`shrink-0 rounded-2xl bg-m3-surface-container-low border ${a.border} p-2.5 shadow-m3-1 flex flex-col gap-1.5 overflow-hidden`}
    >
      {!hideHeader && title && (
        <div className="flex items-center justify-between px-1 shrink-0 pb-1">
          <span className={`text-[10.5px] font-bold font-display px-2 py-0.5 rounded-full border ${a.tag}`}>
            {title}
          </span>
          <span className="text-[9.5px] font-mono text-m3-outline">
            {players.length} Player{players.length === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {/* Column headers. Act-wide disclosure is deliberate: Riot exposes no
          live combat stats, so nothing here may imply "this match". */}
      <div
        className={`${GRID} px-2 pb-0.5 text-[8.5px] font-mono uppercase tracking-wider text-m3-outline border-b border-m3-outline-subtle shrink-0`}
      >
        <span>Player</span>
        <span className="text-center" title="Equipped weapon skins & cosmetics">Skins</span>
        <span className="text-center" title="Tracker Score tier">TS</span>
        <span className="text-left pl-1">Rank</span>
        <span className="text-left pl-1" title="Peak rank — the act it was earned in is shown under the emblem">Peak</span>
        <span className="text-right" title="Act-wide average combat score — the column this board is sorted by">ACS</span>
        <span className="text-right" title="Act-wide K/D (Riot exposes no live kill data)">K/D</span>
        <span className="text-right" title="Act-wide win rate">Win%</span>
        <span className="text-right" title="Act-wide headshot %">HS%</span>
        <span className="text-right">Lvl</span>
      </div>

      <div className="flex flex-col gap-1.5 overflow-hidden shrink-0">
        {[...players].sort(byAcsDesc).map((p) => (
          <PlayerRow
            key={p.puuid}
            p={p}
            tierIcons={tierIcons}
            seasonNames={seasonNames}
            onShowLoadout={onShowLoadout}
          />
        ))}
        {players.length === 0 && (
          <div className="py-4 flex items-center justify-center p-2 text-center text-[10.5px] text-m3-outline font-mono">
            No players detected yet.
          </div>
        )}
      </div>
    </section>
  );
};

const PlayerRow: React.FC<{
  p: LiveMatchPlayer;
  tierIcons: Record<number, string>;
  seasonNames: Record<string, string>;
  onShowLoadout?: (p: LiveMatchPlayer) => void;
}> = ({ p, tierIcons, seasonNames, onShowLoadout }) => {
  const [copied, setCopied] = useState(false);
  const rankIcon = tierIcons[p.tier];
  const peakIcon = tierIcons[p.peakTier];
  const kd = formatKd(p.kd);
  const party = getPartyStyle(p.partyIndex);
  const flagUrl = getFlagUrl(p.country);
  const countryName = getCountryName(p.country);
  const trackerUrls = getTrackerUrls(p.name, p.tag);
  const actLabel = p.peakSeasonId ? seasonNames[p.peakSeasonId] : undefined;

  const handleCopyRiotId = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!p.name) return;
    const fullId = `${p.name}${p.tag ? '#' + p.tag : ''}`;
    navigator.clipboard.writeText(fullId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div
      className={`${GRID} h-10 shrink-0 relative overflow-hidden rounded-xl border px-2.5 py-1 transition-colors ${
        party
          ? `${party.bg} border-m3-outline-subtle/40`
          : p.isMe
          ? 'bg-m3-primary/10 border-m3-primary/40 shadow-xs'
          : 'bg-m3-surface-container border-m3-outline-subtle hover:bg-m3-surface-container-high'
      }`}
    >
      {/* Party identifier: curved bow arc wrapping the left edge to show who is queued together in a party */}
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

      {/* 1. Agent portrait + flag, name, badges */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="relative shrink-0">
          {p.agentIcon ? (
            <img
              src={p.agentIcon}
              alt={p.agentName}
              className="w-6 h-6 rounded-md object-cover bg-m3-surface-container-highest border border-m3-outline-subtle"
            />
          ) : (
            <div className="w-6 h-6 rounded-md bg-m3-surface-container-highest border border-m3-outline-subtle flex items-center justify-center text-[10px] font-bold text-m3-outline">
              ?
            </div>
          )}
          {flagUrl && (
            <img
              src={flagUrl}
              alt={p.country || ''}
              title={countryName ? `Country: ${countryName} (${p.country})` : `Country: ${p.country}`}
              className="absolute -bottom-0.5 -right-0.5 w-3 h-2 object-cover rounded-[1.5px] border border-m3-surface shadow-xs"
            />
          )}
        </div>

        <div className="flex flex-col min-w-0 leading-tight">
          <div className="flex items-center gap-1.5 min-w-0">
            {party && (
              <span
                className={`w-1.5 h-1.5 rounded-full ${party.bar} shrink-0 shadow-xs`}
                title={`Queued together in ${party.name}`}
              />
            )}
            <span
              className="font-display font-bold text-[11.5px] text-m3-on-surface truncate"
              title={`${p.name}${p.tag ? '#' + p.tag : ''}`}
            >
              {p.name}
            </span>
            {p.tag && (
              <span className="text-[8.5px] font-mono text-m3-outline truncate">#{p.tag}</span>
            )}
            {p.name && p.tag && !p.name.startsWith('Player ') && (
              <button
                type="button"
                onClick={handleCopyRiotId}
                className="p-0.5 rounded hover:bg-white/10 text-m3-outline hover:text-white cursor-pointer transition-colors shrink-0"
                title={copied ? 'Copied!' : `Copy ${p.name}#${p.tag}`}
              >
                {copied ? <Check className="w-2.5 h-2.5 text-m3-mint" /> : <Copy className="w-2.5 h-2.5" />}
              </button>
            )}
            {p.name && p.tag && !p.name.startsWith('Player ') && (
              <div className="flex items-center gap-1 ml-0.5 shrink-0">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openExternalUrl(trackerUrls.trn);
                  }}
                  className="px-1 py-px rounded text-[7px] font-mono font-bold bg-white/5 hover:bg-[#b6abf7]/25 hover:text-[#b6abf7] border border-white/10 text-zinc-400 cursor-pointer transition-colors"
                  title={`Search ${p.name}#${p.tag} on Tracker.gg (TRN)`}
                >
                  TRN
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openExternalUrl(trackerUrls.blitz);
                  }}
                  className="px-1 py-px rounded text-[7px] font-mono font-bold bg-white/5 hover:bg-red-500/25 hover:text-red-300 border border-white/10 text-zinc-400 cursor-pointer transition-colors"
                  title={`Search ${p.name}#${p.tag} on Blitz.gg`}
                >
                  Blitz
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openExternalUrl(trackerUrls.opgg);
                  }}
                  className="px-1 py-px rounded text-[7px] font-mono font-bold bg-white/5 hover:bg-blue-500/25 hover:text-blue-300 border border-white/10 text-zinc-400 cursor-pointer transition-colors"
                  title={`Search ${p.name}#${p.tag} on OP.GG`}
                >
                  OP.GG
                </button>
              </div>
            )}
            {p.isMe && (
              <span className="px-1 py-px rounded bg-m3-primary text-m3-on-primary text-[7.5px] font-black uppercase shrink-0">
                You
              </span>
            )}
            {p.isIncognito && (
              <span
                className="flex items-center gap-0.5 px-1 py-px rounded bg-amber-400/15 text-amber-300 border border-amber-400/30 text-[7.5px] font-mono font-bold uppercase shrink-0"
                title={
                  p.nameResolved
                    ? 'Name hidden in Valorant — unmasked by Recon from account UUID'
                    : 'Riot hides this name during live matches — revealed automatically after the game'
                }
              >
                <EyeOff className="w-2.5 h-2.5" />
                {p.nameResolved ? 'Unmasked' : 'Hidden'}
              </span>
            )}
          </div>
          <div className="text-[9px] text-m3-outline truncate flex items-center gap-1">
            <span className="font-medium text-m3-on-surface-variant truncate">
              {p.agentName}
            </span>
            {p.agentRole && <span className="truncate">• {p.agentRole}</span>}
            {countryName && (
              <span className="text-zinc-300 font-medium truncate" title={`Nationality: ${countryName} (${p.country})`}>
                • {countryName}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 2. Skins / Loadout button — between Player and TS so it pops out */}
      <div className="flex items-center justify-center">
        {onShowLoadout && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onShowLoadout(p);
            }}
            className="h-6 px-2.5 rounded-lg bg-gradient-to-r from-purple-500/20 to-purple-600/30 hover:from-purple-500/35 hover:to-purple-600/50 border border-purple-400/40 hover:border-purple-300 text-purple-100 hover:text-white transition-all flex items-center justify-center gap-1.5 text-[9.5px] font-bold font-display shadow-xs hover:shadow-[0_0_8px_rgba(192,132,252,0.4)] cursor-pointer active:scale-95 shrink-0"
            title={`View ${p.name}'s weapon skins & loadout`}
            aria-label={`View ${p.name}'s loadout`}
          >
            <Sparkles className="w-2.5 h-2.5 text-purple-300 animate-pulse" />
            <span>Skins</span>
          </button>
        )}
      </div>

      {/* 3. Tracker Score badge — unified 20px size, right next to Rank */}
      <div
        className="flex items-center justify-center"
        title={
          p.trnScore != null
            ? `Tracker Score: ${p.trnScore} / 1000 — Tier ${scoreTier(p.trnScore).tier}`
            : 'Tracker Score unavailable'
        }
      >
        {p.trnScore != null ? (
          <ScoreBadge tier={scoreTier(p.trnScore).tier} size={20} />
        ) : (
          <span className="w-5 h-5 rounded border border-m3-outline-subtle bg-m3-surface-container flex items-center justify-center text-[8px] font-mono text-m3-outline">
            —
          </span>
        )}
      </div>

      {/* 4. Current rank: icon on left (20px), text on right (rank + RR) */}
      <div className="flex items-center gap-1.5 min-w-0" title={rankTooltip(p, actLabel)}>
        {rankIcon ? (
          <img src={rankIcon} alt={p.rank} className="w-5 h-5 object-contain shrink-0" />
        ) : (
          <span className="w-5 text-center text-[8.5px] font-mono text-m3-outline shrink-0">—</span>
        )}
        <div className="flex flex-col min-w-0 leading-none">
          <span className="text-[8.5px] font-display font-bold text-m3-on-surface truncate">
            {p.rank}
          </span>
          {p.tier > 2 ? (
            <span className="text-[7.5px] font-mono font-bold text-m3-primary tracking-tight mt-0.5">
              {p.rr} RR
            </span>
          ) : (
            <span className="text-[7.5px] font-mono text-m3-outline mt-0.5">—</span>
          )}
        </div>
      </div>

      {/* 5. Peak rank: icon on left (20px), text on right (peak + act) */}
      <div
        className="flex items-center gap-1.5 min-w-0"
        title={p.peakTier > 0 ? `Peak ${p.peakRank}${actLabel ? ` (${shortAct(actLabel)})` : ''}` : 'Peak unavailable'}
      >
        {peakIcon ? (
          <img src={peakIcon} alt={p.peakRank} className="w-5 h-5 object-contain opacity-90 shrink-0" />
        ) : (
          <span className="w-5 text-center text-[8.5px] font-mono text-m3-outline shrink-0">—</span>
        )}
        <div className="flex flex-col min-w-0 leading-none">
          <span className="text-[8.5px] font-display font-semibold text-m3-outline truncate">
            {p.peakRank}
          </span>
          {p.peakSeasonId && actLabel && (
            <span className="text-[7px] font-mono text-m3-outline/80 mt-0.5">
              {shortAct(actLabel)}
            </span>
          )}
        </div>
      </div>

      {/* 6. ACS — the sort key, so it reads first among the numbers */}
      <div className="text-right font-mono text-[10.5px] font-bold" title="Act-wide average combat score">
        {p.acs != null ? (
          <span className={p.acs >= 200 ? 'text-m3-primary' : p.acs >= 150 ? 'text-m3-on-surface' : 'text-m3-outline'}>
            {p.acs}
          </span>
        ) : (
          <span className="text-m3-outline">—</span>
        )}
      </div>

      {/* 7. K/D */}
      <div className="text-right font-mono text-[10.5px] font-bold" title="Act-wide K/D">
        <span className={kd.color}>{kd.text}</span>
      </div>

      {/* 8. Win % */}
      <div className="text-right font-mono text-[10.5px]" title="Act-wide win rate">
        {p.winPct != null ? (
          <span className={p.winPct >= 50 ? 'text-m3-mint font-semibold' : 'text-rose-400'}>
            {p.winPct.toFixed(0)}%
          </span>
        ) : (
          <span className="text-m3-outline">—</span>
        )}
      </div>

      {/* 9. HS % */}
      <div className="text-right font-mono text-[10.5px] text-amber-500" title="Act-wide headshot %">
        {p.hsPct != null && p.hsPct > 0 ? `${p.hsPct.toFixed(0)}%` : <span className="text-m3-outline">—</span>}
      </div>

      {/* 10. Account level */}
      <div className="text-right font-mono text-[9.5px] text-m3-outline" title="Account level">
        {p.accountLevel > 0 ? p.accountLevel : '—'}
      </div>
    </div>
  );
};
