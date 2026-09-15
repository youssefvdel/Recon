import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './ipc';
import { logger } from './logger';

/* TRN enrichment: tracker.gg's public read API through the bundled trnfetch
   sidecar (Chrome TLS fingerprint — passes their Cloudflare wall with no key,
   no login, no browser). Everything here is a progressive enhancement: every
   caller MUST fall back to Riot-direct data when this throws (TRN_*) because
   TRN can gate or reshape these endpoints at any time. */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* ------------------------------------------------------------------ *
 * tracker.gg request gate
 *
 * tracker.gg has no API key and sits behind Cloudflare. Bursty traffic earns
 * HTTP 429 (Cloudflare Error 1015, "you are being rate limited") and, if we
 * keep firing, 403 bot-blocks. Recon easily bursts: a refresh pulls the
 * profile, act stats, agents, maps and three previous acts; the live-match
 * poll fires a call per lobby player; and TrackerAgents/TrackerMaps fan out
 * with Promise.all over several acts at once. Caches were in-memory only, so
 * every reload re-fetched everything.
 *
 * Every request funnels through trnGet, so the gate lives there: requests are
 * serialised with a minimum gap, and a 429/403 puts us in exponential
 * cooldown so the limit is not extended by continued hammering.
 *
 * OWNERSHIP: TS owns pacing policy (this gate + the cooldown ladder). The
 * Rust sidecar/client is a transport backstop only (bounded-concurrency
 * semaphore) — it must never set request spacing.
 * ------------------------------------------------------------------ */
/** Human-paced gap bounds: uniform jitter 1500-3000ms between TRN requests. */
export const TRN_GAP_MIN_MS = 1500;
export const TRN_GAP_MAX_MS = 3000;
/**
 * Uniform human-paced gap, 1500-3000ms. Pure, seeded-independent,
 * unit-testable. Pacing lives ONLY here — Go exits per request and
 * cannot pace across calls.
 */
export function trnJitterGapMs(): number {
  return TRN_GAP_MIN_MS + Math.random() * (TRN_GAP_MAX_MS - TRN_GAP_MIN_MS);
}
/** Cool-off after a rate-limit response: 25s, 45s, capped at 60s (was 16m). */
const TRN_COOLDOWN_BASE_MS = 25 * 1000;
const TRN_COOLDOWN_MAX_MS = 60 * 1000;
/** Ladder step cap (matches the clamp already applied in trnGet). */
const TRN_COOLDOWN_MAX_STEP = 4;

/**
 * Pure cooldown-ladder math: 25s, 50s, then capped at 60s.
 * Extracted verbatim from trnGet so the ladder is unit-testable;
 * trnGet calls this — behavior byte-identical.
 */
export function trnCooldownDelayMs(step: number): number {
  return Math.min(TRN_COOLDOWN_MAX_MS, TRN_COOLDOWN_BASE_MS * 2 ** (Math.max(1, step) - 1));
}

/**
 * UA major version the trnfetch sidecar sends (single source of truth is
 * main.go's trnUserAgent; mirrored here display-only for the Dev QA page).
 * Major version only — never a secret, never the full UA.
 */
export const TRN_UA_MAJOR = 153;

let trnNextSlot = 0;
let trnCooldownUntil = 0;
let trnCooldownStep = 0;
const TRN_COOLDOWN_KEY = 'recon_trn_cooldown_until_v1';

/* ------------------------------------------------------------------ *
 * Tracker ON/OFF kill-switch (v1, local state only).
 *
 * OFF short-circuits trnGet before any gate/cooldown/network work with a
 * TRN_* throw — the exact shape every caller already swallows as "fall
 * back to Riot-direct". When ON, the serial gate + cooldown ladder below
 * run byte-identical. Flag persists in localStorage (absent = ON).
 * ------------------------------------------------------------------ */
const TRN_ENABLED_KEY = 'recon_tracker_enabled_v1';
let trnEnabled: boolean | null = null;

/** Parse the persisted toggle: absent (default ON) or anything but '0' → on. Pure. */
export function parseTrackerEnabledFlag(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  return String(raw) !== '0';
}

export function isTrackerEnabled(): boolean {
  if (trnEnabled !== null) return trnEnabled;
  try {
    trnEnabled =
      typeof localStorage !== 'undefined'
        ? parseTrackerEnabledFlag(localStorage.getItem(TRN_ENABLED_KEY))
        : true;
  } catch {
    trnEnabled = true;
  }
  return trnEnabled;
}

export function setTrackerEnabled(on: boolean): void {
  trnEnabled = on;
  if (typeof localStorage !== 'undefined') {
    try {
      if (on) localStorage.removeItem(TRN_ENABLED_KEY);
      else localStorage.setItem(TRN_ENABLED_KEY, '0');
    } catch {}
  }
}

/** Test seam: drop the in-memory cache so the next read re-hits storage. */
export function resetTrackerEnabledCache(): void {
  trnEnabled = null;
}

/** Current cooldown ladder step (0 = no cooldown). QA/test affordance. */
export function trnCooldownStepCount(): number {
  return trnCooldownStep;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ms left before tracker.gg will be tried again; 0 when ready. */
export function trnCooldownRemainingMs(): number {
  let until = trnCooldownUntil;
  if (typeof localStorage !== 'undefined') {
    try {
      const stored = Number(localStorage.getItem(TRN_COOLDOWN_KEY) || 0);
      if (stored > until) until = stored;
    } catch {}
  }
  return Math.max(0, until - Date.now());
}

/** Reset cooldown so an explicit user retry fires immediately. */
export function resetTrnCooldown(): void {
  trnCooldownStep = 0;
  trnCooldownUntil = 0;
  trnNextSlot = 0;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(TRN_COOLDOWN_KEY);
    } catch {}
  }
}

async function trnGet(path: string, opts?: { immediate?: boolean }): Promise<unknown> {
  // Kill-switch first: cheapest possible branch (one cached boolean), no
  // network, no gate, no timers touched. Same TRN_* throw shape as cooldown
  // so every caller falls back to Riot-direct data untouched.
  if (!isTrackerEnabled()) throw new Error('TRN_DISABLED tracker off');
  if (!isTauri()) throw new Error('TRN needs the desktop app.');

  const cooling = trnCooldownRemainingMs();
  if (cooling > 0) {
    // Fail fast: during cooldown we must not touch the network at all.
    throw new Error(`TRN_RATE_LIMITED ${Math.ceil(cooling / 1000)}s`);
  }

  // Serialise: claim the next slot, then wait for it. Concurrent callers queue
  // up behind each other instead of bursting. The spacing is uniform jitter
  // (human pacing); an explicit user refresh (immediate) skips the wait but
  // still paces its followers. resetTrnCooldown() zeroes the slot, so the
  // first request after a user refresh likewise fires immediately.
  const gap = trnJitterGapMs();
  let slot: number;
  if (opts?.immediate) {
    slot = Date.now();
    trnNextSlot = Math.max(trnNextSlot, slot) + gap;
  } else {
    slot = Math.max(Date.now(), trnNextSlot);
    trnNextSlot = slot + gap;
    const wait = slot - Date.now();
    if (wait > 0) await sleep(wait);
  }

  // Re-check after the wait: a sibling may have tripped a 429 while we were
  // queued. Hitting the network during cooldown extends the Cloudflare block.
  // Refund our slot claim so fail-fast waiters don't phantom-delay the queue.
  if (trnCooldownRemainingMs() > 0) {
    if (trnNextSlot === slot + gap) trnNextSlot = slot;
    throw new Error(`TRN_RATE_LIMITED ${Math.ceil(trnCooldownRemainingMs() / 1000)}s`);
  }

  let raw: string;
  try {
    raw = await invoke<string>('trn_get', { path });
  } catch (e) {
    const msg = String(e);
    if (msg.includes('429') || msg.includes('403') || msg.includes('1015')) {
      trnCooldownStep = Math.min(trnCooldownStep + 1, TRN_COOLDOWN_MAX_STEP);
      trnCooldownUntil = Date.now() + trnCooldownDelayMs(trnCooldownStep);
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(TRN_COOLDOWN_KEY, String(trnCooldownUntil));
        } catch {}
      }
    }
    throw new Error(msg);
  }
  // A clean response means we are welcome again — but only clear a cooldown
  // that already expired. A sibling request still in flight may have just set
  // one; wiping it resumes hammering mid-block.
  if (Date.now() >= trnCooldownUntil) {
    trnCooldownStep = 0;
    trnCooldownUntil = 0;
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(TRN_COOLDOWN_KEY);
      } catch {}
    }
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('TRN bad JSON.');
  }
}

/* ---------- persistent caches -------------------------------------- *
 * TRN act/agent/map data only changes when a match ends, so it is worth
 * surviving a reload. Persisting also means a restart no longer re-fetches
 * everything and re-trips the rate limit. */

const TRN_CACHE_PREFIX = 'recon_trn_cache_v1';

function readPersisted<T>(key: string, ttlMs: number): T | null {
  try {
    const raw = localStorage.getItem(`${TRN_CACHE_PREFIX}:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; data: T };
    if (!parsed?.at || Date.now() - parsed.at > ttlMs) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writePersisted<T>(key: string, data: T): void {
  try {
    localStorage.setItem(`${TRN_CACHE_PREFIX}:${key}`, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Quota: evict the oldest TRN entries, then retry once. Without this the
    // cache silently stops persisting and every restart re-fetches everything,
    // re-tripping the rate limit.
    try {
      const victims: { k: string; at: number }[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(TRN_CACHE_PREFIX)) {
          let at = 0;
          try {
            at = JSON.parse(localStorage.getItem(k) || '').at ?? 0;
          } catch {}
          victims.push({ k, at });
        }
      }
      victims
        .sort((a, b) => a.at - b.at)
        .slice(0, Math.max(10, victims.length - 40))
        .forEach((v) => localStorage.removeItem(v.k));
      localStorage.setItem(`${TRN_CACHE_PREFIX}:${key}`, JSON.stringify({ at: Date.now(), data }));
    } catch {
      /* private mode — memory caches still cover this session */
    }
  }
}


const riotId = (name: string, tag: string): string =>
  `/api/v2/valorant/standard/profile/riot/${encodeURIComponent(name)}%23${encodeURIComponent(tag)}`;

export interface TrnActStats {
  wins: number;
  losses: number;
  ties: number;
  winPct: number;
  kd: number;
  kda: number;
  kills: number;
  deaths: number;
  assists: number;
  hsPct: number;
  headshots: number;
  adr: number;
  acs: number;
  damage: number;
  damageDelta: number;
  rounds: number;
  roundWinPct: number;
  kast: number;
  mvps: number;
  flawless: number;
  aces: number;
  clutches: number;
  clutchesLost: number;
  firstKills: number;
  firstDeaths: number;
  kills3k: number;
  kills4k: number;
  timePlayedH: number;
  trnScore: number;
  kdPercentile: number;
  hsPercentile: number;
  roundWinPctile: number;
  kastPctile: number;
  acsPctile: number;
  adrPctile: number;
  ddPctile: number;
  headHits: number;
  bodyHits: number;
  legHits: number;
  bestKills: number;
  avatarUrl: string;
}

// In-memory cache for root profiles (10 min TTL)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const profileCache = new Map<string, { at: number; data: any }>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
/* Root profiles barely change; 6h keeps restarts from re-fetching everything. */
const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;

async function getRootProfile(name: string, tag: string): Promise<any> {
  const key = `${name.toLowerCase()}#${tag.toLowerCase()}`;
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.data;
  const persisted = readPersisted<any>(`profile:${key}`, PROFILE_TTL_MS);
  if (persisted) {
    profileCache.set(key, { at: Date.now(), data: persisted });
    return persisted;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j: any = await trnGet(riotId(name, tag));
  profileCache.set(key, { at: Date.now(), data: j });
  writePersisted(`profile:${key}`, j);
  return j;
}

/** Current-season overview segment straight from TRN (act-wide, ties included). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickSeasonSegment(j: any, seasonId: string): any | null {
  const segs = Array.isArray(j?.data?.segments) ? j.data.segments : [];
  if (seasonId) {
    const sid = seasonId.toLowerCase();
    return (
      segs.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) => s?.type === 'season' && String(s?.attributes?.seasonId ?? '').toLowerCase() === sid
      ) ?? null
    );
  }
  return (
    segs.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s?.type === 'season'
    ) ?? null
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stat(seg: any, key: string): number {
  return num(seg?.stats?.[key]?.value);
}

// In-memory cache for season segments (10 min TTL)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const seasonSegCache = new Map<string, { at: number; data: any }>();
// In-flight dedup: agents+maps+acts fan out via Promise.all for the same
// identity, and without this every cold caller fires its own trnGet.
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const seasonInFlight = new Map<string, Promise<any>>();

/** Raw season segment for any playlist/season (drives stats + agents parsing). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
/** Season segments change only when a match ends — cache them hard. */
const SEASON_SEG_TTL_MS = 6 * 60 * 60 * 1000;

async function fetchSeasonSeg(name: string, tag: string, playlist: string, seasonId: string): Promise<any> {
  const n = name.trim();
  const t = tag.trim();
  if (!n || !t) throw new Error('TRN bad riot id');
  const pl = playlist.toLowerCase();
  const sid = seasonId.toLowerCase();
  const cacheKey = `${n.toLowerCase()}#${t.toLowerCase()}_${pl}_${sid}`;
  const hit = seasonSegCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SEASON_SEG_TTL_MS) return hit.data;
  // Survive reloads: a restart must not re-request every act we already hold.
  const persisted = readPersisted<any>(`season:${cacheKey}`, SEASON_SEG_TTL_MS);
  if (persisted) {
    seasonSegCache.set(cacheKey, { at: Date.now(), data: persisted });
    return persisted;
  }
  const running = seasonInFlight.get(cacheKey);
  if (running) return running;

  const task = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await trnGet(
      `${riotId(n, t)}/segments/season?playlist=${encodeURIComponent(pl)}${seasonId ? `&seasonId=${encodeURIComponent(seasonId)}` : ''}&source=web`
    );
    const segs = Array.isArray(j?.data) ? j.data : [];
    const targetSeg = seasonId
      ? segs.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (s: any) => s?.type === 'season' && String(s?.attributes?.seasonId ?? '').toLowerCase() === sid
        )
      : segs.find(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (s: any) => s?.type === 'season'
        );
    if (!targetSeg) throw new Error('TRN no season segment.');
    const result = { seg: targetSeg, data: j?.data };
    seasonSegCache.set(cacheKey, { at: Date.now(), data: result });
    writePersisted(`season:${cacheKey}`, result);
    return result;
  })();
  seasonInFlight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    if (seasonInFlight.get(cacheKey) === task) seasonInFlight.delete(cacheKey);
  }
}

/** Act stats for a Riot ID. seasonId/playlist optional (defaults = current competitive). */
export async function fetchTrnActStats(
  name: string,
  tag: string,
  seasonId = '',
  playlist = 'competitive'
): Promise<{ stats: TrnActStats; defaultSeason: string; countryCode: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let seg: any = null;
  // Always fetch/pull root profile so avatarUrl and countryCode are never missing
  const root = await getRootProfile(name, tag).catch(() => null);
  const avatarUrl = String(root?.data?.platformInfo?.avatarUrl ?? '');
  const defaultSeason = String(root?.data?.metadata?.defaultSeason ?? '');
  const countryCode = String(root?.data?.userInfo?.countryCode ?? '');

  if (playlist === 'competitive') {
    seg = pickSeasonSegment(root, seasonId);
  }
  if (!seg) {
    const r = await fetchSeasonSeg(name, tag, playlist, seasonId);
    seg = r.seg;
  }
  if (!seg) throw new Error('TRN no season segment.');

  const kills = stat(seg, 'kills');
  const deaths = stat(seg, 'deaths');
  return {
    stats: {
      wins: stat(seg, 'matchesWon'),
      losses: stat(seg, 'matchesLost'),
      ties: stat(seg, 'matchesTied'),
      winPct: stat(seg, 'matchesWinPct'),
      kd: stat(seg, 'kDRatio') || (deaths > 0 ? kills / deaths : kills),
      kda: stat(seg, 'kDARatio'),
      kills,
      deaths,
      assists: stat(seg, 'assists'),
      hsPct: stat(seg, 'headshotsPercentage'),
      headshots: stat(seg, 'headshots'),
      adr: stat(seg, 'damagePerRound'),
      acs: stat(seg, 'scorePerRound'),
      damage: stat(seg, 'damage'),
      damageDelta: stat(seg, 'damageDelta'),
      rounds: stat(seg, 'roundsPlayed'),
      roundWinPct: stat(seg, 'roundsWinPct'),
      kast: stat(seg, 'kAST'),
      mvps: stat(seg, 'mVPs'),
      flawless: stat(seg, 'flawless'),
      aces: stat(seg, 'aces'),
      clutches: stat(seg, 'clutches'),
      clutchesLost: stat(seg, 'clutchesLost'),
      firstKills: stat(seg, 'firstBloods'),
      firstDeaths: stat(seg, 'firstDeaths'),
      kills3k: stat(seg, 'kills3K'),
      kills4k: stat(seg, 'kills4K'),
      timePlayedH: Math.round((stat(seg, 'timePlayed') / 3600) * 10) / 10,
      trnScore: stat(seg, 'trnPerformanceScore'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      roundWinPctile: num((seg?.stats?.roundsWinPct as any)?.percentile),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      kastPctile: num((seg?.stats?.kAST as any)?.percentile),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      acsPctile: num((seg?.stats?.scorePerRound as any)?.percentile),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adrPctile: num((seg?.stats?.damagePerRound as any)?.percentile),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ddPctile: num((seg?.stats?.damageDeltaPerRound as any)?.percentile),
      headHits: stat(seg, 'dealtHeadshots'),
      bodyHits: stat(seg, 'dealtBodyshots'),
      legHits: stat(seg, 'dealtLegshots'),
      bestKills: stat(seg, 'mostKillsInMatch'),
      avatarUrl,
      // K/D percentile comes from the K/D stat — not raw kills, which measures
      // volume instead of efficiency.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      kdPercentile: num((seg?.stats?.kDRatio as any)?.percentile) || num((seg?.stats?.kills as any)?.percentile),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hsPercentile: num((seg?.stats?.headshotsPercentage as any)?.percentile),
    },
    defaultSeason,
    countryCode,
  };
}

export interface TrnAgentTopMap {
  mapName: string;
  mapKey: string;
  matches: number;
  wins: number;
  winPct: number;
  kd: number;
}

export interface TrnAgentStat {
  agent: string;
  agentKey: string;
  role?: string;
  matches: number;
  wins: number;
  losses: number;
  winPct: number;
  kd: number;
  kda: number;
  kills: number;
  deaths: number;
  assists: number;
  adr: number;
  acs: number;
  damageDeltaPerRound: number;
  hsPct: number;
  timePlayedSeconds: number;
  hours: number;
  kast: number;
  aces: number;
  clutches: number;
  flawless: number;
  firstBloods: number;
  firstDeaths: number;
  bestKills: number;
  defenseRoundsWon: number;
  defenseRoundsLost: number;
  defenseKd: number;
  defusesPerMatch: number;
  attackRoundsWon: number;
  attackRoundsLost: number;
  attackKd: number;
  plantsPerMatch: number;
  ability1Casts: number;
  ability2Casts: number;
  grenadeCasts: number;
  ultimateCasts: number;
  attackKills: number;
  attackDeaths: number;
  attackAssists: number;
  attackRoundsWinPct: number;
  defenseKills: number;
  defenseDeaths: number;
  defenseAssists: number;
  defenseRoundsWinPct: number;
  topMaps: TrnAgentTopMap[];
}

/** Per-agent season segments (full stats, abilities, attack/defense, maps breakdown). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchTrnAgents(name: string, tag: string, seasonId: string, playlist = 'competitive'): Promise<TrnAgentStat[]> {
  const r = await fetchSeasonSeg(name, tag, playlist, seasonId);
  const segs = Array.isArray(r?.data) ? r.data : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentSegs = segs.filter((s: any) => s?.type === 'agent');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentTopMapSegs = segs.filter((s: any) => s?.type === 'agent-top-map');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapTopAgentSegs = segs.filter((s: any) => s?.type === 'map-top-agent');

  const mapNameMap: Record<string, string> = {
    abyss: 'Abyss',
    sunset: 'Sunset',
    haven: 'Haven',
    ascent: 'Ascent',
    lotus: 'Lotus',
    summit: 'Summit',
    split: 'Split',
    bind: 'Bind',
    breeze: 'Breeze',
    fracture: 'Fracture',
    pearl: 'Pearl',
    icebox: 'Icebox',
  };

  return agentSegs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((s: any): TrnAgentStat => {
      const k = num(s?.stats?.kills?.value);
      const d = num(s?.stats?.deaths?.value);
      const a = num(s?.stats?.assists?.value);
      const m = num(s?.stats?.matchesPlayed?.value);
      const w = num(s?.stats?.matchesWon?.value);
      const l = num(s?.stats?.matchesLost?.value);
      const agentName = String(s?.metadata?.name ?? s?.attributes?.agent ?? '?');
      const key = String(s?.attributes?.key ?? agentName).toLowerCase();

      // Merge maps from both agent-top-map and map-top-agent
      const agentMapEntries = new Map<string, TrnAgentTopMap>();

      for (const tm of agentTopMapSegs) {
        const matchName = String(tm?.metadata?.name ?? '').toLowerCase();
        if (matchName === agentName.toLowerCase()) {
          const mk = String(tm?.attributes?.mapKey ?? '').toLowerCase();
          const cleanName = mapNameMap[mk] || (mk ? mk.charAt(0).toUpperCase() + mk.slice(1) : 'Map');
          agentMapEntries.set(mk, {
            mapName: cleanName,
            mapKey: mk,
            matches: num(tm?.stats?.matchesPlayed?.value),
            wins: num(tm?.stats?.matchesWon?.value),
            winPct: num(tm?.stats?.matchesWinPct?.value),
            kd: num(tm?.stats?.kDRatio?.value),
          });
        }
      }

      for (const ma of mapTopAgentSegs) {
        const matchName = String(ma?.metadata?.name ?? '').toLowerCase();
        if (matchName === agentName.toLowerCase()) {
          const mk = String(ma?.attributes?.mapKey ?? '').toLowerCase();
          if (!agentMapEntries.has(mk)) {
            const cleanName = mapNameMap[mk] || (mk ? mk.charAt(0).toUpperCase() + mk.slice(1) : 'Map');
            agentMapEntries.set(mk, {
              mapName: cleanName,
              mapKey: mk,
              matches: num(ma?.stats?.matchesPlayed?.value),
              wins: num(ma?.stats?.matchesWon?.value),
              winPct: num(ma?.stats?.matchesWinPct?.value),
              kd: num(ma?.stats?.kDRatio?.value),
            });
          }
        }
      }

      const topMaps = Array.from(agentMapEntries.values())
        .filter((tm) => tm.matches > 0)
        .sort((x, y) => y.matches - x.matches);

      return {
        agent: agentName,
        agentKey: key,
        role: s?.metadata?.role ? String(s.metadata.role) : undefined,
        matches: m,
        wins: w,
        losses: l,
        winPct: m > 0 ? (w / m) * 100 : 0,
        kd: d > 0 ? k / d : k,
        kda: d > 0 ? (k + a) / d : k + a,
        kills: k,
        deaths: d,
        assists: a,
        adr: num(s?.stats?.damagePerRound?.value),
        acs: num(s?.stats?.scorePerRound?.value),
        damageDeltaPerRound: Math.round(num(s?.stats?.damageDeltaPerRound?.value)),
        hsPct: num(s?.stats?.headshotsPercentage?.value),
        timePlayedSeconds: num(s?.stats?.timePlayed?.value),
        hours: Math.round((num(s?.stats?.timePlayed?.value) / 3600) * 10) / 10,
        kast: num(s?.stats?.kAST?.value),
        aces: num(s?.stats?.aces?.value),
        clutches: num(s?.stats?.clutches?.value),
        flawless: num(s?.stats?.flawless?.value),
        firstBloods: num(s?.stats?.firstBloods?.value),
        firstDeaths: num(s?.stats?.firstDeaths?.value),
        bestKills: num(s?.stats?.mostKillsInMatch?.value),
        defenseRoundsWon: num(s?.stats?.defenseRoundsWon?.value),
        defenseRoundsLost: num(s?.stats?.defenseRoundsLost?.value),
        defenseKd: num(s?.stats?.defenseKDRatio?.value),
        defusesPerMatch: num(s?.stats?.defusesPerMatch?.value),
        attackRoundsWon: num(s?.stats?.attackRoundsWon?.value),
        attackRoundsLost: num(s?.stats?.attackRoundsLost?.value),
        attackKd: num(s?.stats?.attackKDRatio?.value),
        plantsPerMatch: num(s?.stats?.plantsPerMatch?.value),
        ability1Casts: num(s?.stats?.ability1Casts?.value),
        ability2Casts: num(s?.stats?.ability2Casts?.value),
        grenadeCasts: num(s?.stats?.grenadeCasts?.value),
        ultimateCasts: num(s?.stats?.ultimateCasts?.value),
        attackKills: num(s?.stats?.attackKills?.value),
        attackDeaths: num(s?.stats?.attackDeaths?.value),
        attackAssists: num(s?.stats?.attackAssists?.value),
        attackRoundsWinPct: num(s?.stats?.attackRoundsWinPct?.value),
        defenseKills: num(s?.stats?.defenseKills?.value),
        defenseDeaths: num(s?.stats?.defenseDeaths?.value),
        defenseAssists: num(s?.stats?.defenseAssists?.value),
        defenseRoundsWinPct: num(s?.stats?.defenseRoundsWinPct?.value),
        topMaps,
      };
    })
    .filter((a: TrnAgentStat) => a.matches > 0)
    .sort((a: TrnAgentStat, b: TrnAgentStat) => b.matches - a.matches);
}

export interface TrnMapAgent {
  name: string;
  icon: string;
  matches: number;
  winPct: number;
}

export interface TrnMapStat {
  key: string;
  name: string;
  imageUrl: string;
  matchesPlayed: number;
  matchesWon: number;
  matchesLost: number;
  winPct: number;
  kd: number;
  adr: number;
  acs: number;
  damageDeltaPerRound: number;

  kills: number;
  deaths: number;
  assists: number;
  headshotsPct: number;
  timePlayedSeconds: number;

  aces: number;
  clutches: number;
  thrifty: number;
  flawless: number;
  plants: number;
  defuses: number;

  attackKills: number;
  attackDeaths: number;
  attackAssists: number;
  attackRoundsWinPct: number;

  defenseKills: number;
  defenseDeaths: number;
  defenseAssists: number;
  defenseRoundsWinPct: number;

  topAgents: TrnMapAgent[];
}

/** Per-map season segments (full stats, top agents, attack/defense split). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchTrnMaps(name: string, tag: string, seasonId: string, playlist = 'competitive'): Promise<TrnMapStat[]> {
  const r = await fetchSeasonSeg(name, tag, playlist, seasonId);
  const segs = Array.isArray(r?.data) ? r.data : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapSegs = segs.filter((s: any) => s?.type === 'map');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapTopAgentSegs = segs.filter((s: any) => s?.type === 'map-top-agent');

  return mapSegs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((s: any): TrnMapStat => {
      const key = String(s?.attributes?.key ?? '');
      const topAgents: TrnMapAgent[] = mapTopAgentSegs
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((a: any) => String(a?.attributes?.mapKey ?? '').toLowerCase() === key.toLowerCase())
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((a: any) => ({
          name: String(a?.metadata?.name ?? a?.attributes?.agentKey ?? '?'),
          icon: String(a?.metadata?.imageUrl ?? ''),
          matches: num(a?.stats?.matchesPlayed?.value),
          winPct: num(a?.stats?.matchesWinPct?.value),
        }))
        .sort((x: TrnMapAgent, y: TrnMapAgent) => y.matches - x.matches)
        .slice(0, 3);

      return {
        key,
        name: String(s?.metadata?.name ?? key ?? 'Map'),
        imageUrl: String(s?.metadata?.imageUrl ?? ''),
        matchesPlayed: num(s?.stats?.matchesPlayed?.value),
        matchesWon: num(s?.stats?.matchesWon?.value),
        matchesLost: num(s?.stats?.matchesLost?.value),
        winPct: num(s?.stats?.matchesWinPct?.value),
        kd: num(s?.stats?.kDRatio?.value),
        adr: num(s?.stats?.damagePerRound?.value),
        acs: num(s?.stats?.scorePerRound?.value),
        damageDeltaPerRound: Math.round(num(s?.stats?.damageDeltaPerRound?.value)),

        kills: num(s?.stats?.kills?.value),
        deaths: num(s?.stats?.deaths?.value),
        assists: num(s?.stats?.assists?.value),
        headshotsPct: num(s?.stats?.headshotsPercentage?.value),
        timePlayedSeconds: num(s?.stats?.timePlayed?.value),

        aces: num(s?.stats?.aces?.value),
        clutches: num(s?.stats?.clutches?.value),
        thrifty: num(s?.stats?.thrifty?.value),
        flawless: num(s?.stats?.flawless?.value),
        plants: num(s?.stats?.plants?.value),
        defuses: num(s?.stats?.defuses?.value),

        attackKills: num(s?.stats?.attackKills?.value),
        attackDeaths: num(s?.stats?.attackDeaths?.value),
        attackAssists: num(s?.stats?.attackAssists?.value),
        attackRoundsWinPct: num(s?.stats?.attackRoundsWinPct?.value),

        defenseKills: num(s?.stats?.defenseKills?.value),
        defenseDeaths: num(s?.stats?.defenseDeaths?.value),
        defenseAssists: num(s?.stats?.defenseAssists?.value),
        defenseRoundsWinPct: num(s?.stats?.defenseRoundsWinPct?.value),

        topAgents,
      };
    })
    .filter((m: TrnMapStat) => m.matchesPlayed > 0)
    .sort((a: TrnMapStat, b: TrnMapStat) => b.winPct - a.winPct);
}

/** Matches-weighted average of a per-match rate. */
function wavg(items: { m: number; v: number }[]): number {
  let w = 0;
  let sum = 0;
  for (const it of items) {
    w += it.m;
    sum += it.v * it.m;
  }
  return w > 0 ? sum / w : 0;
}

/** Merge per-act agent tables into an All Acts table (counts summed, rates matches-weighted). */
export function mergeAgentStats(all: TrnAgentStat[][]): TrnAgentStat[] {
  const byKey = new Map<string, TrnAgentStat[]>();
  for (const list of all) {
    for (const a of list) {
      const k = (a.agentKey || a.agent).toLowerCase();
      const l = byKey.get(k) ?? [];
      l.push(a);
      byKey.set(k, l);
    }
  }
  const out: TrnAgentStat[] = [];
  for (const items of byKey.values()) {
    const first = items[0];
    const matches = items.reduce((n, a) => n + a.matches, 0);
    if (matches === 0) continue;
    const w = (pick: (a: TrnAgentStat) => number): number =>
      wavg(items.map((a) => ({ m: a.matches, v: pick(a) })));
    const kills = items.reduce((n, a) => n + a.kills, 0);
    const deaths = items.reduce((n, a) => n + a.deaths, 0);
    const assists = items.reduce((n, a) => n + a.assists, 0);
    const wins = items.reduce((n, a) => n + a.wins, 0);
    const losses = items.reduce((n, a) => n + a.losses, 0);
    const timePlayedSeconds = items.reduce((n, a) => n + a.timePlayedSeconds, 0);
    const mapAgg = new Map<string, { mapName: string; mapKey: string; matches: number; wins: number; kdW: number; kdM: number }>();
    for (const a of items) {
      for (const t of a.topMaps ?? []) {
        const e = mapAgg.get(t.mapKey) ?? { mapName: t.mapName, mapKey: t.mapKey, matches: 0, wins: 0, kdW: 0, kdM: 0 };
        e.matches += t.matches;
        e.wins += t.wins;
        e.kdW += t.kd * t.matches;
        e.kdM += t.matches;
        mapAgg.set(t.mapKey, e);
      }
    }
    out.push({
      agent: first.agent,
      agentKey: first.agentKey,
      role: items.find((a) => a.role)?.role,
      matches,
      wins,
      losses,
      winPct: (wins / matches) * 100,
      kd: deaths > 0 ? kills / deaths : kills,
      kda: deaths > 0 ? (kills + assists) / deaths : kills + assists,
      kills,
      deaths,
      assists,
      adr: w((a) => a.adr),
      acs: w((a) => a.acs),
      damageDeltaPerRound: Math.round(w((a) => a.damageDeltaPerRound)),
      hsPct: w((a) => a.hsPct),
      timePlayedSeconds,
      hours: Math.round((timePlayedSeconds / 3600) * 10) / 10,
      kast: w((a) => a.kast),
      aces: items.reduce((n, a) => n + a.aces, 0),
      clutches: items.reduce((n, a) => n + a.clutches, 0),
      flawless: items.reduce((n, a) => n + a.flawless, 0),
      firstBloods: items.reduce((n, a) => n + a.firstBloods, 0),
      firstDeaths: items.reduce((n, a) => n + a.firstDeaths, 0),
      bestKills: Math.max(...items.map((a) => a.bestKills)),
      defenseRoundsWon: items.reduce((n, a) => n + a.defenseRoundsWon, 0),
      defenseRoundsLost: items.reduce((n, a) => n + a.defenseRoundsLost, 0),
      defenseKd: w((a) => a.defenseKd),
      defusesPerMatch: w((a) => a.defusesPerMatch),
      attackRoundsWon: items.reduce((n, a) => n + a.attackRoundsWon, 0),
      attackRoundsLost: items.reduce((n, a) => n + a.attackRoundsLost, 0),
      attackKd: w((a) => a.attackKd),
      plantsPerMatch: w((a) => a.plantsPerMatch),
      ability1Casts: items.reduce((n, a) => n + a.ability1Casts, 0),
      ability2Casts: items.reduce((n, a) => n + a.ability2Casts, 0),
      grenadeCasts: items.reduce((n, a) => n + a.grenadeCasts, 0),
      ultimateCasts: items.reduce((n, a) => n + a.ultimateCasts, 0),
      attackKills: items.reduce((n, a) => n + a.attackKills, 0),
      attackDeaths: items.reduce((n, a) => n + a.attackDeaths, 0),
      attackAssists: items.reduce((n, a) => n + a.attackAssists, 0),
      attackRoundsWinPct: w((a) => a.attackRoundsWinPct),
      defenseKills: items.reduce((n, a) => n + a.defenseKills, 0),
      defenseDeaths: items.reduce((n, a) => n + a.defenseDeaths, 0),
      defenseAssists: items.reduce((n, a) => n + a.defenseAssists, 0),
      defenseRoundsWinPct: w((a) => a.defenseRoundsWinPct),
      topMaps: [...mapAgg.values()]
        .map((e) => ({
          mapName: e.mapName,
          mapKey: e.mapKey,
          matches: e.matches,
          wins: e.wins,
          winPct: e.matches > 0 ? (e.wins / e.matches) * 100 : 0,
          kd: e.kdM > 0 ? e.kdW / e.kdM : 0,
        }))
        .sort((x, y) => y.matches - x.matches),
    });
  }
  return out.sort((a, b) => b.matches - a.matches);
}

/** Merge per-act map tables into an All Acts table (counts summed, rates matches-weighted). */
export function mergeMapStats(all: TrnMapStat[][]): TrnMapStat[] {
  const byKey = new Map<string, TrnMapStat[]>();
  for (const list of all) {
    for (const m of list) {
      const k = (m.key || m.name).toLowerCase();
      const l = byKey.get(k) ?? [];
      l.push(m);
      byKey.set(k, l);
    }
  }
  const out: TrnMapStat[] = [];
  for (const items of byKey.values()) {
    const first = items[0];
    const matchesPlayed = items.reduce((n, m) => n + m.matchesPlayed, 0);
    if (matchesPlayed === 0) continue;
    const w = (pick: (m: TrnMapStat) => number): number =>
      wavg(items.map((m) => ({ m: m.matchesPlayed, v: pick(m) })));
    const matchesWon = items.reduce((n, m) => n + m.matchesWon, 0);
    const matchesLost = items.reduce((n, m) => n + m.matchesLost, 0);
    const kills = items.reduce((n, m) => n + m.kills, 0);
    const deaths = items.reduce((n, m) => n + m.deaths, 0);
    const agentAgg = new Map<string, { name: string; icon: string; matches: number; winW: number; winM: number }>();
    for (const m of items) {
      for (const t of m.topAgents ?? []) {
        const k = t.name.toLowerCase();
        const e = agentAgg.get(k) ?? { name: t.name, icon: t.icon, matches: 0, winW: 0, winM: 0 };
        if (!e.icon && t.icon) e.icon = t.icon;
        e.matches += t.matches;
        e.winW += t.winPct * t.matches;
        e.winM += t.matches;
        agentAgg.set(k, e);
      }
    }
    out.push({
      key: first.key,
      name: first.name,
      imageUrl: items.find((m) => m.imageUrl)?.imageUrl ?? '',
      matchesPlayed,
      matchesWon,
      matchesLost,
      winPct: (matchesWon / matchesPlayed) * 100,
      kd: deaths > 0 ? kills / deaths : kills,
      adr: w((m) => m.adr),
      acs: w((m) => m.acs),
      damageDeltaPerRound: Math.round(w((m) => m.damageDeltaPerRound)),
      kills,
      deaths,
      assists: items.reduce((n, m) => n + m.assists, 0),
      headshotsPct: w((m) => m.headshotsPct),
      timePlayedSeconds: items.reduce((n, m) => n + m.timePlayedSeconds, 0),
      aces: items.reduce((n, m) => n + m.aces, 0),
      clutches: items.reduce((n, m) => n + m.clutches, 0),
      thrifty: items.reduce((n, m) => n + m.thrifty, 0),
      flawless: items.reduce((n, m) => n + m.flawless, 0),
      plants: items.reduce((n, m) => n + m.plants, 0),
      defuses: items.reduce((n, m) => n + m.defuses, 0),
      attackKills: items.reduce((n, m) => n + m.attackKills, 0),
      attackDeaths: items.reduce((n, m) => n + m.attackDeaths, 0),
      attackAssists: items.reduce((n, m) => n + m.attackAssists, 0),
      attackRoundsWinPct: w((m) => m.attackRoundsWinPct),
      defenseKills: items.reduce((n, m) => n + m.defenseKills, 0),
      defenseDeaths: items.reduce((n, m) => n + m.defenseDeaths, 0),
      defenseAssists: items.reduce((n, m) => n + m.defenseAssists, 0),
      defenseRoundsWinPct: w((m) => m.defenseRoundsWinPct),
      topAgents: [...agentAgg.values()]
        .map((e) => ({
          name: e.name,
          icon: e.icon,
          matches: e.matches,
          winPct: e.winM > 0 ? e.winW / e.winM : 0,
        }))
        .sort((x, y) => y.matches - x.matches)
        .slice(0, 3),
    });
  }
  return out.sort((a, b) => b.winPct - a.winPct);
}

/**
 * Harmonized fallback formula for Tracker Score (0-1000 scale).
 * Calibrated against TRN's core performance pillars (ACS, Damage Delta, KAST, Win%, K/D).
 */
export function calculateTrsFallback(params: {
  kd: number;
  acs: number;
  ddPerRound: number;
  kast: number;
  won: boolean;
}): number {
  const { kd, acs, ddPerRound, kast, won } = params;
  const winScore = won ? 140 : 50;
  const acsScore = Math.min(340, Math.max(0, acs * 1.15));
  const ddScore = Math.min(220, Math.max(-100, ddPerRound * 2.2));
  const kastScore = Math.min(240, Math.max(0, (kast / 100) * 240));
  const kdBonus = Math.min(80, Math.max(-40, (kd - 1) * 70));

  const total = Math.round(winScore + acsScore + ddScore + kastScore + kdBonus);
  return Math.max(50, Math.min(999, total));
}

/**
 * Fetches recent competitive matches for a player from Tracker.gg and extracts
 * the real `trnPerformanceScore` (TRS) for each match.
 * Returns a map of matchId -> TRS.
 */
export async function fetchTrnMatches(
  name: string,
  tag: string,
  playlist = 'competitive'
): Promise<Record<string, number>> {
  const key = `matches:${name.toLowerCase()}#${tag.toLowerCase()}:${playlist}`;
  const cached = readPersisted<Record<string, number>>(key, 2 * 3600 * 1000); // 2 hours
  if (cached) return cached;

  const path = `/api/v2/valorant/standard/matches/riot/${encodeURIComponent(name)}%23${encodeURIComponent(tag)}?type=${encodeURIComponent(playlist)}`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (await trnGet(path)) as any;
    const matches = raw?.data?.matches;
    if (!Array.isArray(matches)) return {};

    const out: Record<string, number> = {};
    for (const m of matches) {
      const matchId = String(m?.attributes?.id ?? '');
      const trs = m?.segments?.[0]?.stats?.trnPerformanceScore?.value;
      if (matchId && typeof trs === 'number') {
        out[matchId] = Math.round(trs);
      }
    }
    // Never cache an empty map: a parse miss must not poison the 2h cache.
    if (Object.keys(out).length > 0) writePersisted(key, out);
    return out;
  } catch (e) {
    if (import.meta.env.DEV) logger.warn('Failed to fetch TRN matches:', e);
    return {};
  }
}

/**
 * Fetches full match details from Tracker.gg to extract the real TRS for EVERY player in the lobby.
 * Returns a map keyed by lowercase Riot ID ("name#tag") and lowercase agent name -> TRS.
 */
export async function fetchTrnMatchDetails(
  matchId: string
): Promise<Record<string, number>> {
  if (!matchId) return {};
  const key = `match_detail_trs:${matchId}`;
  const cached = readPersisted<Record<string, number>>(key, 7 * 24 * 3600 * 1000); // 7 days (past matches are immutable)
  if (cached) return cached;

  const path = `/api/v2/valorant/standard/matches/${encodeURIComponent(matchId)}`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (await trnGet(path)) as any;
    const segments = raw?.data?.segments;
    if (!Array.isArray(segments)) return {};

    const out: Record<string, number> = {};
    for (const s of segments) {
      if (s?.type !== 'player-summary') continue;
      const trs = s?.stats?.trnPerformanceScore?.value;
      if (typeof trs !== 'number') continue;
      const roundedTrs = Math.round(trs);

      const handle = String(
        s?.attributes?.platformUserIdentifier ||
        s?.metadata?.platformInfo?.platformUserHandle ||
        s?.metadata?.platformUserHandle ||
        ''
      ).toLowerCase().trim();

      const agent = String(s?.metadata?.agentName || '').toLowerCase().trim();

      if (handle) out[handle] = roundedTrs;
      // First-wins: mirrored comps field the same agent on both teams, and a
      // blind overwrite returns the other team's player's score.
      if (agent && !(`agent:${agent}` in out)) out[`agent:${agent}`] = roundedTrs;
    }
    // Never cache an empty map: a parse miss must not poison the 7d cache.
    if (Object.keys(out).length > 0) writePersisted(key, out);
    return out;
  } catch (e) {
    if (import.meta.env.DEV) logger.warn('Failed to fetch TRN match detail:', e);
    return {};
  }
}

