import { isTauri } from './ipc';
import { glzHostFor, riotPost, gameData, resolveMapName } from './tracker';

const PREPICK_CONFIG_KEY = 'recon_prepick_config_v2';

export interface PrepickMapAgent {
  agentId: string;
  agentName: string;
  agentIcon?: string;
}

export interface PrepickConfig {
  enabled: boolean;
  defaultAgentId: string;
  defaultAgentName: string;
  mapAgents: Record<string, PrepickMapAgent>;
}

/** Unknown/stale keys (e.g. the old lock-delay field) are tolerated and dropped. */
function withDefaults(parsed: Record<string, unknown>): PrepickConfig {
  return {
    enabled: !!parsed.enabled,
    defaultAgentId: String(parsed.defaultAgentId || ''),
    defaultAgentName: String(parsed.defaultAgentName || ''),
    mapAgents: typeof parsed.mapAgents === 'object' && parsed.mapAgents ? (parsed.mapAgents as Record<string, PrepickMapAgent>) : {},
  };
}

export interface ValorantMapInfo {
  name: string;
  uuid: string;
  splash: string;
  /** Small card art (listViewIcon, ~65KB) — the grid uses this so we never
   *  download the 2MB splash for a 300px card. */
  thumb: string;
  /** Small map icon — instant blur-up placeholder while the thumb loads. */
  icon: string;
}

/** Cached roster: the map list changes a few times a year at most. */
const MAPS_CACHE_KEY = 'recon_prepick_maps_v2';
const MAPS_CACHE_TTL = 7 * 24 * 3600 * 1000;

/** Tactical (5v5) maps only: TDM arenas, ranges and training grounds have no
 *  tactical minimap data. Gauntlet/Basic Training/Range/Skirmish excluded. */
const NON_TACTICAL = /(range|training|skirmish|gauntlet)/i;

/** Fetch the active competitive map roster with splashes. */
export async function getCompetitiveMaps(): Promise<ValorantMapInfo[]> {
  const readCache = (): ValorantMapInfo[] | null => {
    try {
      const raw = localStorage.getItem(MAPS_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { savedAt?: number; maps?: ValorantMapInfo[] };
      if (!parsed?.maps?.length) return null;
      if (Date.now() - (parsed.savedAt ?? 0) > MAPS_CACHE_TTL) return null;
      // Normalize: entries cached before `thumb` existed fall back to splash.
      return parsed.maps
        .filter((m) => m?.name && (m?.splash || m?.thumb))
        .map((m) => ({ ...m, thumb: m.thumb || m.splash }));
    } catch {
      return null;
    }
  };
  const writeCache = (maps: ValorantMapInfo[]): void => {
    try {
      localStorage.setItem(MAPS_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), maps }));
    } catch {}
  };

  try {
    const r = await fetch('https://valorant-api.com/v1/maps').then((res) => res.json());
    const list: ValorantMapInfo[] = [];
    for (const m of r?.data ?? []) {
      const name = String(m?.displayName || '');
      const splash = String(m?.splash || '');
      const uuid = String(m?.uuid || '');
      const icon = String(m?.displayIcon || '');
      const thumb = String(m?.listViewIcon || icon || splash);
      // NOTE: `narrativeDescription` no longer ships on any map (verified
      // 2026-10), so it cannot gate the roster. Tactical minimap data marks
      // real 5v5 maps — new competitive maps appear automatically.
      if (
        splash &&
        m?.tacticalDescription &&
        icon &&
        !NON_TACTICAL.test(name)
      ) {
        list.push({ name, uuid, splash, thumb, icon });
      }
    }
    if (list.length > 0) {
      const sorted = list.sort((a, b) => a.name.localeCompare(b.name));
      writeCache(sorted);
      return sorted;
    }
  } catch {}
  // Offline / API down: last-known roster, then the built-in fallback.
  return (
    readCache() ??
    KNOWN_MAP_NAMES.map((name) => ({
      name,
      uuid: name.toLowerCase(),
      splash: `/preview-walls/crosshairbg0.png`,
      thumb: `/preview-walls/crosshairbg0.png`,
      icon: '',
    }))
  );
}

/** Read full pre-picker preferences from localStorage. */
export function getPrepickConfig(): PrepickConfig {
  try {
    const raw = localStorage.getItem(PREPICK_CONFIG_KEY);
    if (raw) {
      return withDefaults(JSON.parse(raw) as Record<string, unknown>);
    }
    // Migration from v1 keys if present
    const v1Enabled = localStorage.getItem('recon_prepick_enabled') === 'true';
    const v1Id = localStorage.getItem('recon_prepick_agent_id') || '';
    const v1Name = localStorage.getItem('recon_prepick_agent_name') || '';
    return withDefaults({
      enabled: v1Enabled,
      defaultAgentId: v1Id,
      defaultAgentName: v1Name,
      mapAgents: {},
    });
  } catch {
    return { enabled: false, defaultAgentId: '', defaultAgentName: '', mapAgents: {} };
  }
}

/** Save pre-picker preferences to localStorage. */
export function setPrepickConfig(config: PrepickConfig): void {
  try {
    localStorage.setItem(PREPICK_CONFIG_KEY, JSON.stringify(config));
    // Keep backwards-compatible v1 keys updated for badges
    localStorage.setItem('recon_prepick_enabled', String(config.enabled));
    localStorage.setItem('recon_prepick_agent_id', config.defaultAgentId);
    localStorage.setItem('recon_prepick_agent_name', config.defaultAgentName);
  } catch {}
}

let lastPrepickedMatchId = '';

/**
 * Execute agent pre-pick in the pre-game lobby: hover only, never locks.
 * Resolves map -> checks map-specific agent -> falls back to default agent.
 * Hovers the chosen agent INSTANTLY; locking the agent in stays the player's
 * call. Runs at most ONCE per unique match ID.
 */
export async function trySafePrepick(
  matchId: string,
  region: string,
  mapIdOrName?: string
): Promise<boolean> {
  if (!isTauri() || !matchId || !region) return false;
  const config = getPrepickConfig();
  if (!config.enabled) return false;
  if (lastPrepickedMatchId === matchId) return false;

  const resolvedMap = mapIdOrName ? resolveMapName(mapIdOrName) : '';
  const mapKey = resolvedMap.toLowerCase().trim();

  // Check map-specific agent first, fallback to default agent
  const mapAgent = mapKey ? config.mapAgents[mapKey] : null;
  const chosen = (mapAgent && mapAgent.agentId)
    ? mapAgent
    : (config.defaultAgentId ? { agentId: config.defaultAgentId, agentName: config.defaultAgentName } : null);

  if (!chosen || !chosen.agentId) return false;

  // Mark claimed immediately so repeat polls don't re-hover.
  lastPrepickedMatchId = matchId;
  const glz = glzHostFor(region);

  // Wait ~2s so Agent Select finishes opening, then hover. Claimed above,
  // so repeat polls during the wait can't schedule a second hover.
  await new Promise((r) => setTimeout(r, 2000));
  // This is the last (and only) Riot call: we never lock the agent in.
  riotPost(glz, `/pregame/v1/matches/${matchId}/select/${chosen.agentId}`).catch(() => {});
  return true;
}

/** Reset the pre-picked match latch. */
export function resetPrepickLatch(): void {
  lastPrepickedMatchId = '';
}

/** Get list of playable agents for the picker UI. */
export async function getPlayableAgents(): Promise<{ id: string; name: string; icon: string; role: string }[]> {
  try {
    const data = await gameData();
    const agents = Object.entries(data.agentInfo).map(([id, info]) => ({
      id,
      name: info.name,
      icon: info.icon,
      role: info.role || 'Agent',
    }));
    return agents.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Last-resort map names when both the API and the roster cache are
 *  unreachable. Kept in sync with the live competitive pool by hand. */
const KNOWN_MAP_NAMES = [
  'Ascent',
  'Bind',
  'Haven',
  'Split',
  'Sunset',
  'Lotus',
  'Icebox',
  'Abyss',
  'Pearl',
  'Fracture',
  'Breeze',
  'Summit',
  'Corrode',
];
