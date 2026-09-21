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

  // Hover NOW — no waiting. Instant hover is what the player expects to see.
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
];

/** Fetch the active competitive map roster with splashes. */
export async function getCompetitiveMaps(): Promise<ValorantMapInfo[]> {
  try {
    const r = await fetch('https://valorant-api.com/v1/maps').then((res) => res.json());
    const list: ValorantMapInfo[] = [];
    for (const m of r?.data ?? []) {
      const name = String(m?.displayName || '');
      const splash = String(m?.splash || '');
      const uuid = String(m?.uuid || '');
      if (
        splash &&
        (KNOWN_MAP_NAMES.includes(name) ||
          (m?.narrativeDescription && !name.includes('Range') && !name.includes('Training') && !name.includes('Skirmish')))
      ) {
        list.push({ name, uuid, splash });
      }
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return KNOWN_MAP_NAMES.map((name) => ({
      name,
      uuid: name.toLowerCase(),
      splash: `/preview-walls/crosshairbg0.png`,
    }));
  }
}
