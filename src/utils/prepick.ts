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
  /** Seconds to wait after Agent Select starts before hovering. 1–59 = delay, 60 = never. */
  pickDelaySec: number;
}

/** Factory default: auto-hover OFF, 20s delay. */
export const PREPICK_DEFAULT_DELAY = 20;
export const PREPICK_MAX_DELAY = 60;

function withDefaults(parsed: Record<string, unknown>): PrepickConfig {
  const rawDelay = Number(parsed.pickDelaySec);
  return {
    enabled: !!parsed.enabled,
    defaultAgentId: String(parsed.defaultAgentId || ''),
    defaultAgentName: String(parsed.defaultAgentName || ''),
    mapAgents: typeof parsed.mapAgents === 'object' && parsed.mapAgents ? (parsed.mapAgents as Record<string, PrepickMapAgent>) : {},
    pickDelaySec: Number.isFinite(rawDelay) ? Math.min(PREPICK_MAX_DELAY, Math.max(1, Math.round(rawDelay))) : PREPICK_DEFAULT_DELAY,
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
    return { enabled: false, defaultAgentId: '', defaultAgentName: '', mapAgents: {}, pickDelaySec: PREPICK_DEFAULT_DELAY };
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
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Execute safe agent hover in pre-game lobby.
 * Resolves map -> checks map-specific agent -> falls back to default agent.
 * Waits `pickDelaySec` after Agent Select starts; 60 ("never") skips the hover.
 * SAFE: Only hovers (`select`), NEVER calls `/lock/`.
 * Runs at most ONCE per unique match ID.
 */
export async function trySafePrepick(matchId: string, region: string, mapIdOrName?: string): Promise<boolean> {
  if (!isTauri() || !matchId || !region) return false;
  const config = getPrepickConfig();
  if (!config.enabled) return false;
  if (config.pickDelaySec >= PREPICK_MAX_DELAY) return false; // "never" — don't pick
  if (lastPrepickedMatchId === matchId) return false;

  const resolvedMap = mapIdOrName ? resolveMapName(mapIdOrName) : '';
  const mapKey = resolvedMap.toLowerCase().trim();

  // Check map-specific agent first, fallback to default agent
  const mapAgent = mapKey ? config.mapAgents[mapKey] : null;
  const chosen = (mapAgent && mapAgent.agentId)
    ? mapAgent
    : (config.defaultAgentId ? { agentId: config.defaultAgentId, agentName: config.defaultAgentName } : null);

  if (!chosen || !chosen.agentId) return false;

  // Mark claimed immediately so repeat polls don't stack timers; fire after the delay.
  lastPrepickedMatchId = matchId;
  if (pendingTimer) clearTimeout(pendingTimer);
  const delayMs = Math.max(1, config.pickDelaySec) * 1000;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const glz = glzHostFor(region);
    riotPost(glz, `/pregame/v1/matches/${matchId}/select/${chosen.agentId}`).catch(() => {});
  }, delayMs);
  return true;
}

/** Reset the pre-picked match latch (and cancel any pending delayed hover). */
export function resetPrepickLatch(): void {
  lastPrepickedMatchId = '';
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
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
