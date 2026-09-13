import { gameData } from './tracker';

/**
 * Live agent meta from Blitz's public stats backend — the exact request
 * blitz.gg/valorant/stats/agents renders from:
 *
 *   GET https://data.v2.iesdev.com/api/v1/query_objects/prod/val/agent_stats
 *       ?queue=competitive&map=<slug>&tier=<riot-tier>&ep_act=<act>
 *
 * Why live instead of a hardcoded table: agent meta per map/rank shifts every
 * patch, so a baked-in list is stale within weeks. This one also respects the
 * "don't spam third-party APIs" rule — Blitz regenerates its stats daily
 * (`meta.generated_at`), so a 6h cache is both fresh and polite, and every
 * key is de-duplicated while a request is in flight.
 */

export interface BlitzAgentStat {
  agent: string;
  agentUuid: string;
  role: string;
  winRate: number;
  pickRate: number;
  avgScore: number;
  matches: number;
}

const STATS_URL = 'https://data.v2.iesdev.com/api/v1/query_objects/prod/val/agent_stats';
const MAPS_URL = 'https://utils.iesdev.com/static/json/nexus/valorant/maps';
const ACTS_URL = 'https://utils.iesdev.com/static/json/nexus/valorant/acts';

const CACHE_KEY = 'recon_blitz_agent_stats_v1';
/** Blitz regenerates daily; 6h keeps it fresh without hammering them. */
const STATS_TTL = 6 * 3600 * 1000;
const META_TTL = 24 * 3600 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawRow = any;

const memCache = new Map<string, { at: number; data: BlitzAgentStat[] }>();
const inFlight = new Map<string, Promise<BlitzAgentStat[]>>();

let slugIndex: { at: number; byName: Record<string, string> } | null = null;
let actCache: { at: number; value: string } | null = null;
// Shared pending catalogue fetches: N concurrent meta calls must not each
// fire their own MAPS/ACTS request before the shared inFlight key exists.
let slugPending: Promise<Record<string, string>> | null = null;
let actPending: Promise<string> | null = null;

/** `Summit` → `summit`. Used only when the maps index is unreachable; the
 *  authoritative slug always comes from Blitz's own maps catalogue. */
const deriveSlug = (mapName: string) => mapName.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Blitz's own map slugs, so we never guess a key and silently get no data. */
async function mapSlugFor(mapName: string): Promise<string | null> {
  if (slugIndex && Date.now() - slugIndex.at < META_TTL) {
    return slugIndex.byName[mapName.toLowerCase()] ?? deriveSlug(mapName);
  }
  if (!slugPending) {
    slugPending = (async () => {
      const res = await fetch(MAPS_URL);
      const rows: RawRow[] = await res.json();
      const byName: Record<string, string> = {};
      for (const m of rows ?? []) {
        if (m?.key && m?.name) byName[String(m.name).toLowerCase()] = String(m.key);
      }
      slugIndex = { at: Date.now(), byName };
      return byName;
    })().finally(() => {
      slugPending = null;
    });
  }
  try {
    const byName = await slugPending;
    return byName[mapName.toLowerCase()] ?? deriveSlug(mapName);
  } catch {
    // Offline: the derived slug is right for every map except multi-word ones,
    // and the caller falls back to personal stats if it happens to miss.
    return deriveSlug(mapName);
  }
}

/** Current act token, e.g. `ev26actv` (episode V26, ACT V). */
async function currentActParam(): Promise<string> {
  if (actCache && Date.now() - actCache.at < META_TTL) return actCache.value;
  if (!actPending) {
    actPending = (async () => {
      const res = await fetch(ACTS_URL);
      const rows: RawRow[] = await res.json();
      const list = Array.isArray(rows) ? rows : [];
      // The live act is the one Riot hasn't ended yet; newest start wins a tie.
      const live = list.find((a) => a?.endedAt == null && a?.episode?.name && a?.name) ??
        list.slice().sort((a, b) => String(b?.startedAt ?? '').localeCompare(String(a?.startedAt ?? '')))[0];
      const value = live?.episode?.name && live?.name
        ? `e${String(live.episode.name).toLowerCase()}${String(live.name).toLowerCase().replace(/\s+/g, '')}`
        : 'latest';
      actCache = { at: Date.now(), value };
      return value;
    })().finally(() => {
      actPending = null;
    });
  }
  try {
    return await actPending;
  } catch {
    return 'latest';
  }
}

/** Sums rows across every rank bucket — the fallback when an exact tier has
 *  too few games to publish (Blitz returns an empty set, not a thin one). */
function aggregate(rows: RawRow[]): BlitzAgentStat[] {
  // Non-finite guard: one garbage field (string/undefined from a schema drift)
  // would otherwise NaN the totals and every derived rate.
  const fin = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  const byAgent = new Map<string, { m: number; w: number; r: number; s: number }>();
  for (const row of rows) {
    const g = row?.stats?.general;
    const uuid = String(row?.agent_uuid ?? '').toLowerCase();
    if (!uuid || !g) continue;
    const acc = byAgent.get(uuid) ?? { m: 0, w: 0, r: 0, s: 0 };
    acc.m += fin(g.matchesPlayed);
    acc.w += fin(g.wins);
    acc.r += fin(g.roundsPlayed);
    acc.s += fin(g.score);
    byAgent.set(uuid, acc);
  }
  const total = [...byAgent.values()].reduce((n, a) => n + a.m, 0);
  return [...byAgent.entries()].map(([uuid, a]) => ({
    agentUuid: uuid,
    agent: '',
    role: '',
    winRate: a.m > 0 ? Number(((a.w / a.m) * 100).toFixed(1)) : 0,
    pickRate: total > 0 ? Number(((a.m / total) * 100).toFixed(1)) : 0,
    avgScore: a.r > 0 ? Math.round(a.s / a.r) : 0,
    matches: a.m,
  }));
}

/** Attaches display name/role from Recon's own agent catalogue (the API only
 *  returns uuids). */
async function nameAgents(stats: BlitzAgentStat[]): Promise<BlitzAgentStat[]> {
  let info: Record<string, { name: string; role: string }> = {};
  try {
    const data = await gameData();
    info = data.agentInfo ?? {};
  } catch {
    /* Fall through: the widget shows an initials badge when a name is missing. */
  }
  return stats
    .map((s) => {
      const hit = info[s.agentUuid];
      return { ...s, agent: hit?.name ?? '', role: hit?.role ?? '' };
    })
    .filter((s) => s.agent);
}

/**
 * Best agents for one map at one rank, strongest win rate first.
 * Returns [] (never throws) so the caller can fall back to the player's own
 * numbers instead of showing nothing.
 */
export async function fetchBlitzAgentStats(mapName: string, tier: number): Promise<BlitzAgentStat[]> {
  const map = await mapSlugFor(mapName);
  if (!map) return [];
  const act = await currentActParam();
  const isRanked = Number.isFinite(tier) && tier > 0;
  const key = `${map}|${isRanked ? tier : 'all'}|${act}`;

  const cached = memCache.get(key);
  if (cached && Date.now() - cached.at < STATS_TTL) return cached.data;

  const running = inFlight.get(key);
  if (running) return running;

  const task = (async () => {
    const query = async (withTier: boolean) => {
      const params = new URLSearchParams({ queue: 'competitive', map, ep_act: act });
      if (withTier && isRanked) params.set('tier', String(tier));
      const res = await fetch(`${STATS_URL}?${params.toString()}`);
      if (!res.ok) throw new Error(`blitz ${res.status}`);
      const json = await res.json();
      return (json?.data ?? []) as RawRow[];
    };

    let rows: RawRow[] = [];
    // Narrowest useful slice first: this rank, this map. If Blitz has too few
    // games to publish at that rank it returns nothing, so widen to all ranks
    // rather than pretending the map has no meta. A failed ranked query must
    // still fall through to the widened one — not straight to the catch.
    if (isRanked) {
      try {
        rows = await query(true);
      } catch {
        rows = [];
      }
    }
    if (rows.length === 0) rows = await query(false);
    const stats = await nameAgents(aggregate(rows));
    const sorted = stats.sort((a, b) => b.winRate - a.winRate || b.pickRate - a.pickRate);
    memCache.set(key, { at: Date.now(), data: sorted });
    persist(key, sorted);
    return sorted;
  })()
    .catch(() => cached?.data ?? [])
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, task);
  return task;
}

/** localStorage mirror so a reopened HUD paints immediately (and offline). */
function persist(key: string, data: BlitzAgentStat[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[key] = { at: Date.now(), data };
    // Keep the store small — only recent map/rank slices matter.
    const keys = Object.keys(all);
    if (keys.length > 12) {
      keys
        .sort((a, b) => (all[a]?.at ?? 0) - (all[b]?.at ?? 0))
        .slice(0, keys.length - 12)
        .forEach((k) => delete all[k]);
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {
    /* Quota or private mode — memory cache still covers this session. */
  }
}

/** Synchronous cached read for first paint (null when we have nothing). */
export function peekBlitzAgentStats(mapName: string, tier: number): BlitzAgentStat[] | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const slug = slugIndex?.byName[mapName.toLowerCase()] ?? deriveSlug(mapName);
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as Record<string, { at: number; data: BlitzAgentStat[] }>;
    const prefix = `${slug}|${tier > 0 ? tier : 'all'}|`;
    // Newest slice wins: after an act rollover an older act's entry may still
    // be cached, and insertion order would hand back the stale one.
    const hit = Object.entries(all)
      .filter(([k]) => k.startsWith(prefix))
      .sort(([, a], [, b]) => (b?.at ?? 0) - (a?.at ?? 0))[0];
    if (!hit) return null;
    const [k, entry] = hit;
    if (Date.now() - entry.at > STATS_TTL) return null;
    memCache.set(k, entry);
    return entry.data;
  } catch {
    return null;
  }
}
