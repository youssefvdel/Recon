import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import type { LiveMatchPlayer, LiveMatchState, LocalRiotAccount, TrackerDuel, TrackerMatchDetail, TrackerMmrPoint, TrackerPlayer, TrackerProfile } from '../types';
import { isTauri } from './ipc';
import { getDevMockMatch, isDevNoClient } from './devTools';
import { logger } from './logger';

/* Keyless tracker: everything comes straight from Riot using the local
   client's own session. No API keys, no third party. Needs Riot Client open.
   Proven live shapes (2026-09-08/09), same endpoints TRN/Blitz call locally:
   - mmr: { LatestCompetitiveUpdate: {...}, QueueSkills: { competitive: { SeasonalInfoBySeasonID } } }
   - competitiveupdates: { Matches: [{ MatchID, MapID, MatchStartTime, TierAfterUpdate, RankedRatingAfterUpdate, RankedRatingEarned }] }
   - history: { Total, History: [{ MatchID, GameStartTime, QueueID }] }
   - match-details/v1/matches/{id}: { matchInfo, players[] (subject/teamId/characterId/stats/roundDamage), teams[], roundResults[] } */

/** Fast check (<0.1ms) if the local Riot Client lockfile exists. */
export async function isRiotClientRunning(): Promise<boolean> {
  if (isDevNoClient()) return false;
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>('is_riot_client_running');
  } catch {
    return false;
  }
}

/** Get the currently logged-in account, or the cached account if Riot Client is closed.
    Never throws — returns null if there has never been any logged-in user. */
export async function getEffectiveAccount(): Promise<LocalRiotAccount | null> {
  const running = await isRiotClientRunning();
  if (!running) {
    return readCachedAccount();
  }
  try {
    return await detectLocalAccount();
  } catch {
    return readCachedAccount();
  }
}

/** Logged-in Riot account from the local client. Throws when the client is closed. */
export async function detectLocalAccount(): Promise<LocalRiotAccount> {
  const live = await detectLocalAccountLive();
  writeCachedAccount(live);
  return live;
}

async function detectLocalAccountLive(): Promise<LocalRiotAccount> {
  if (isDevNoClient()) throw new Error('Auto-detect failed — is the Riot Client open?');
  if (!isTauri()) throw new Error('Auto-detect needs the desktop app.');
  try {
    const acc = await invoke<LocalRiotAccount>('detect_local_account');
    let name = acc.game_name ?? '';
    let tag = acc.tagline ?? '';
    if (!tag && name.includes('#')) {
      const i = name.lastIndexOf('#');
      tag = name.slice(i + 1);
      name = name.slice(0, i);
    }
    return { ...acc, game_name: name, tagline: tag };
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : 'Auto-detect failed — is the Riot Client open?');
  }
}

/* ---- Account identity cache ------------------------------------------------
   The logged-in user almost never changes between launches, so the last known
   account paints the sidebar + tracker instantly and the live read only
   corrects it. Everything is keyed by PUUID: when the user switches accounts
   the PUUID differs, so the stale snapshot is dropped instead of showing the
   previous player's rank and matches under the new name. */

const ACCOUNT_KEY = 'recon_account_v1';

export function readCachedAccount(): LocalRiotAccount | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (!raw) return null;
    const a = JSON.parse(raw) as LocalRiotAccount;
    return a?.game_name ? a : null;
  } catch {
    return null;
  }
}

export function writeCachedAccount(acc: LocalRiotAccount): void {
  try {
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(acc));
  } catch {
    /* cache is best-effort only */
  }
}

/** True when the live account is a different player than the cached one. */
export function accountSwitched(cached: LocalRiotAccount | null, live: LocalRiotAccount): boolean {
  if (!cached) return false;
  const a = (cached.puuid || '').toLowerCase();
  const b = (live.puuid || '').toLowerCase();
  if (a && b) return a !== b;
  // No PUUID available: fall back to name#tag comparison.
  return `${cached.game_name}#${cached.tagline}`.toLowerCase() !==
    `${live.game_name}#${live.tagline}`.toLowerCase();
}

/** Drop the snapshot for a specific account (used when the user switches). */
export function clearAccountSnapshot(puuid: string): void {
  try {
    const k = `recon_tracker_snapshot_v1:${(puuid || 'anon').toLowerCase()}`;
    localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** Shape shared with useTrackerData's snapshot store. Only the fields the
    sidebar card needs are declared — extra keys are ignored. */
export interface CachedTrackerSnapshot {
  savedAt: number;
  puuid: string;
  profile: TrackerProfile | null;
}

/** Last persisted tracker snapshot for the cached account, if still fresh. */
export function readCachedTrackerSnapshot(): CachedTrackerSnapshot | null {
  try {
    const acc = readCachedAccount();
    if (!acc?.puuid) return null;
    const raw = localStorage.getItem(`recon_tracker_snapshot_v1:${acc.puuid.toLowerCase()}`);
    if (!raw) return null;
    const s = JSON.parse(raw) as CachedTrackerSnapshot;
    if (!s?.savedAt || !s?.profile) return null;
    if (Date.now() - s.savedAt > 24 * 3600 * 1000) return null;
    return s;
  } catch {
    return null;
  }
}


export interface CachedSidebarMini {
  name: string;
  tag: string;
  rank: string;
  rr: number;
  peak: string;
  icon: string;
  peakIcon: string;
  avatarUrl: string;
  bannerUrl: string;
  countryCode: string;
  level: number;
  /** Equipped card. Persisted so the banner/avatar URLs can be re-derived from
   *  it on the next launch — a cache written while the card endpoint was 404ing
   *  (empty URLs) heals itself instead of blanking the card again. */
  cardId?: string;
  puuid?: string;
  savedAt?: number;
}

const SIDEBAR_MINI_PREFIX = 'recon_sidebar_mini_v2';

export function readCachedSidebarMini(puuid?: string): CachedSidebarMini | null {
  try {
    const p = puuid || readCachedAccount()?.puuid;
    if (p) {
      const raw = localStorage.getItem(`${SIDEBAR_MINI_PREFIX}:${p.toLowerCase()}`);
      if (raw) return JSON.parse(raw);
    }
    const legacy = localStorage.getItem(SIDEBAR_MINI_PREFIX);
    return legacy ? JSON.parse(legacy) : null;
  } catch {
    return null;
  }
}

export function writeCachedSidebarMini(mini: CachedSidebarMini, puuid?: string): void {
  try {
    const toStore = { ...mini, savedAt: Date.now() };
    const p = puuid || mini.puuid || readCachedAccount()?.puuid;
    if (p) {
      localStorage.setItem(`${SIDEBAR_MINI_PREFIX}:${p.toLowerCase()}`, JSON.stringify(toStore));
    }
    localStorage.setItem(SIDEBAR_MINI_PREFIX, JSON.stringify(toStore));
  } catch {}
}

/** Tier id → name fallback when only the number arrives. */
export const tierName = (id: number): string => {
  if (!Number.isFinite(id)) return '—';
  if (id >= 27) return 'Radiant';
  if (id < 3) return 'Unrated';
  const tiers = ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Ascendant', 'Immortal'];
  return `${tiers[Math.floor((id - 3) / 3)]} ${((id - 3) % 3) + 1}`;
};

const platformBlob = (): string => {
  try {
    return btoa(
      JSON.stringify({
        platformType: 'PC',
        platformOS: 'Windows',
        platformOSVersion: '10.0.19042.1.256.64bit',
        platformChipset: 'Unknown',
      })
    );
  } catch {
    return '';
  }
};

const shardFor = (region: string): string =>
  (
    {
      eu: 'pd.eu.a.pvp.net',
      na: 'pd.na.a.pvp.net',
      ap: 'pd.ap.a.pvp.net',
      br: 'pd.br.a.pvp.net',
      latam: 'pd.latam.a.pvp.net',
      kr: 'pd.kr.a.pvp.net',
    } as Record<string, string>
  )[region] ?? 'pd.eu.a.pvp.net';

interface DirectEnt {
  access_token: string;
  entitlements: string;
  puuid: string;
}

let entCache: { at: number; ent: DirectEnt } | null = null;

export async function getEntitlements(): Promise<DirectEnt> {
  if (entCache && Date.now() - entCache.at < 5 * 60 * 1000) return entCache.ent;
  if (!isTauri()) throw new Error('Tracker needs the desktop app.');
  const ent = await invoke<DirectEnt>('local_entitlements');
  if (!ent.access_token) throw new Error('No active session — log into the Riot Client first.');
  entCache = { at: Date.now(), ent };
  return ent;
}

export const clearEntitlements = (): void => {
  entCache = null;
};

let cachedVersion: string | null = null;

/** Client version Riot demands in headers. Log scrape first, public API fallback
    (log only exists after the game itself has launched once). */
async function resolveVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  try {
    const v = await invoke<string>('local_client_version');
    if (v && v.includes('shipping')) {
      cachedVersion = v;
      return v;
    }
  } catch {}
  try {
    const j = await fetch('https://valorant-api.com/v1/version').then((r) => r.json());
    const v = String(j?.data?.riotClientVersion ?? '');
    if (v) {
      cachedVersion = v;
      return v;
    }
  } catch {}
  return 'release-13.05-shipping-11-5350494';
}

/* Global gate for Riot's local API: one choke point so every caller
   (match details, MMR, history, 24h tracker) shares a single concurrency cap.
   Bursting spawns one curl process per call, which tanks the machine. */
const RIOT_CONCURRENCY = 6;
let riotActive = 0;
const riotQueue: Array<() => void> = [];
async function withRiotSlot<R>(fn: () => Promise<R>): Promise<R> {
  if (riotActive >= RIOT_CONCURRENCY) {
    await new Promise<void>((resolve) => riotQueue.push(resolve));
  }
  riotActive++;
  try {
    return await fn();
  } finally {
    riotActive--;
    const next = riotQueue.shift();
    if (next) next();
  }
}

/** Authed Riot GET from Rust (browser origins are blocked). Refetches entitlements once on expiry.
 * Exported for player-data reads outside the tracker module (notably the wallet). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function riotGet(host: string, path: string): Promise<any> {
  const call = async (e: DirectEnt): Promise<string> => {
    const version = await resolveVersion();
    return invoke<string>('riot_direct_get', {
      host,
      path,
      accessToken: e.access_token,
      entitlements: e.entitlements,
      clientPlatform: platformBlob(),
      clientVersion: version,
    });
  };
  try {
    const raw = await withRiotSlot(async () => call(await getEntitlements()));
    const j = JSON.parse(raw);
    if (j?.httpStatus === 401 || j?.errorCode === 'BAD_AUTH' || j?.message === 'Unauthorized') {
      clearEntitlements();
      return JSON.parse(await withRiotSlot(async () => call(await getEntitlements())));
    }
    return j;
  } catch (e) {
    if (String(e).includes('RIOT_EXPIRED')) {
      clearEntitlements();
      return JSON.parse(await withRiotSlot(async () => call(await getEntitlements())));
    }
    throw e;
  }
}

/** Authed Riot PUT from Rust — same pipeline as riotGet, but `-X PUT` with a
 *  real JSON body. Exported for player-data routes that take PUT
 *  (notably `PUT /playerPref/v3/savePreference` — crosshair saves). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function riotPut(host: string, path: string, body: string): Promise<any> {
  const call = async (e: DirectEnt): Promise<string> => {
    const version = await resolveVersion();
    return invoke<string>('riot_direct_put', {
      host,
      path,
      bodyArg: body,
      accessToken: e.access_token,
      entitlements: e.entitlements,
      clientPlatform: platformBlob(),
      clientVersion: version,
    });
  };
  try {
    const raw = await withRiotSlot(async () => call(await getEntitlements()));
    const j = JSON.parse(raw);
    if (j?.httpStatus === 401 || j?.errorCode === 'BAD_AUTH' || j?.message === 'Unauthorized') {
      clearEntitlements();
      return JSON.parse(await withRiotSlot(async () => call(await getEntitlements())));
    }
    return j;
  } catch (e) {
    if (String(e).includes('RIOT_EXPIRED')) {
      clearEntitlements();
      return JSON.parse(await withRiotSlot(async () => call(await getEntitlements())));
    }
    throw e;
  }
}
/** Authed Riot POST from Rust — same pipeline as riotGet, but `-X POST` with
 *  an empty JSON body. Exported for player-data routes that reject GET
 *  (notably `POST /store/v3/storefront/{puuid}` — the daily shop). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function riotPost(host: string, path: string): Promise<any> {
  const call = async (e: DirectEnt): Promise<string> => {
    const version = await resolveVersion();
    return invoke<string>('riot_direct_post', {
      host,
      path,
      accessToken: e.access_token,
      entitlements: e.entitlements,
      clientPlatform: platformBlob(),
      clientVersion: version,
    });
  };
  try {
    const raw = await withRiotSlot(async () => call(await getEntitlements()));
    const j = JSON.parse(raw);
    if (j?.httpStatus === 401 || j?.errorCode === 'BAD_AUTH' || j?.message === 'Unauthorized') {
      clearEntitlements();
      return JSON.parse(await withRiotSlot(async () => call(await getEntitlements())));
    }
    return j;
  } catch (e) {
    if (String(e).includes('RIOT_EXPIRED')) {
      clearEntitlements();
      return JSON.parse(await withRiotSlot(async () => call(await getEntitlements())));
    }
    throw e;
  }
}

let gameDataMem: { agents: Record<string, string>; maps: Record<string, string>; seasons: Record<string, string>; seasonOrder: string[]; tierIcons: Record<number, string>; agentInfo: Record<string, { name: string; icon: string; role: string; roleIcon: string }>; weapons: Record<string, string> } | null = null;

const GAME_DATA_KEY = 'aspect_game_data_v3';

/** Latest valorant-api map index (mapUrl|uuid → display name), module-level so
 *  the SYNCHRONOUS read paths (persisted match state, caches) can re-derive a
 *  map name instead of trusting one stored by an older build. */
let mapIndexMem: Record<string, string> = {};

/** Static Riot metadata via public valorant-api.com, cached 30 days. */
export async function gameData(): Promise<{ agents: Record<string, string>; maps: Record<string, string>; seasons: Record<string, string>; seasonOrder: string[]; tierIcons: Record<number, string>; agentInfo: Record<string, { name: string; icon: string; role: string; roleIcon: string }>; weapons: Record<string, string> }> {
  if (gameDataMem) return gameDataMem;
  try {
    const raw = localStorage.getItem(GAME_DATA_KEY);
    if (raw) {
      const { savedAt, data } = JSON.parse(raw);
      if (Date.now() - savedAt < 30 * 24 * 3600 * 1000 && data?.agents && data?.tierIcons && data?.agentInfo) {
        gameDataMem = { agents: data.agents, maps: data.maps ?? {}, seasons: data.seasons ?? {}, seasonOrder: data.seasonOrder ?? [], tierIcons: data.tierIcons, agentInfo: data.agentInfo ?? {}, weapons: data.weapons ?? {} };
        mapIndexMem = gameDataMem.maps;
        return gameDataMem;
      }
    }
  } catch {}
  const agents: Record<string, string> = {};
  const maps: Record<string, string> = {};
  const seasons: Record<string, string> = {};
  let seasonOrder: string[] = [];
  const tierIcons: Record<number, string> = {};
  const agentInfo: Record<string, { name: string; icon: string; role: string; roleIcon: string }> = {};
  const weapons: Record<string, string> = {};
  try {
    const [aj, mj, cs, sn, ct, wj] = await Promise.all([
      fetch('https://valorant-api.com/v1/agents?isPlayableCharacter=true').then((r) => r.json()),
      fetch('https://valorant-api.com/v1/maps').then((r) => r.json()),
      fetch('https://valorant-api.com/v1/seasons/competitive').then((r) => r.json()),
      fetch('https://valorant-api.com/v1/seasons').then((r) => r.json()),
      fetch('https://valorant-api.com/v1/competitivetiers').then((r) => r.json()),
      fetch('https://valorant-api.com/v1/weapons').then((r) => r.json()),
    ]);
    for (const a of aj?.data ?? []) {
      if (a?.uuid && a?.displayName) {
        const id = String(a.uuid).toLowerCase();
        agents[id] = a.displayName;
        agentInfo[id] = {
          name: a.displayName,
          icon: String(a.displayIcon ?? ''),
          role: String(a.role?.displayName ?? ''),
          roleIcon: String(a.role?.displayIcon ?? ''),
        };
      }
    }
    for (const m of mj?.data ?? []) {
      if (m?.mapUrl && m?.displayName) {
        maps[String(m.mapUrl).toLowerCase()] = m.displayName;
        if (m?.uuid) maps[String(m.uuid).toLowerCase()] = m.displayName;
      }
    }
    // competitive uuid → "V26 · ACT V": episode from asset path, act from season name.
    const names: Record<string, string> = {};
    for (const s of sn?.data ?? []) {
      if (s?.uuid && s?.displayName) names[String(s.uuid).toLowerCase()] = s.displayName;
    }
    const compList = Array.isArray(cs?.data) ? cs.data : [];
    for (const c of compList) {
      const cuuid = String(c?.uuid ?? '').toLowerCase();
      const suuid = String(c?.seasonUuid ?? '').toLowerCase();
      if (!cuuid && !suuid) continue;
      const act = names[suuid] ?? '';
      const ep = /Episode(V\d+)/i.exec(String(c?.assetPath ?? ''))?.[1] ?? '';
      const label = [ep, act].filter(Boolean).join(' · ') || 'Season';
      // Riot keys player seasons by the SEASON uuid (SeasonID), not the
      // competitive uuid — index both so lookups always hit.
      if (cuuid) seasons[cuuid] = label;
      if (suuid) seasons[suuid] = label;
    }
    seasonOrder = compList
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .slice().sort((a: any, b: any) => String(b?.endTime ?? '').localeCompare(String(a?.endTime ?? '')))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any) => String(c?.seasonUuid ?? c?.uuid ?? '').toLowerCase()).filter(Boolean);
    // newest tier set wins; tier id matches Riot's numbering 0–27.
    const sets = Array.isArray(ct?.data) ? ct.data : [];
    const tiers = sets.length > 0 ? sets[sets.length - 1]?.tiers ?? [] : [];
    for (const t of tiers) {
      const id = Number(t?.tier);
      if (Number.isInteger(id) && t?.largeIcon) tierIcons[id] = String(t.largeIcon);
    }
    for (const w of wj?.data ?? []) {
      if (w?.uuid && w?.displayName) weapons[String(w.uuid).toLowerCase()] = w.displayName;
    }
    localStorage.setItem(GAME_DATA_KEY, JSON.stringify({ savedAt: Date.now(), data: { agents, maps, seasons, seasonOrder, tierIcons, agentInfo, weapons } }));
  } catch {}
  gameDataMem = { agents, maps, seasons, seasonOrder, tierIcons, agentInfo, weapons };
  mapIndexMem = maps;
  return gameDataMem;
}

/** Last path segment of a /Game/Maps/X/X id, for maps valorant-api.com doesn't know yet. */
export const shortMapName = (mapId: string, maps: Record<string, string>): string => {
  const known = maps[mapId.toLowerCase()];
  if (known) return known;
  // Riot reuses codenames (Plummet became Summit), so the path segment is only
  // ever a last resort — and it must at least be title-cased for display.
  const seg = mapId.split('/').filter(Boolean).pop() || '?';
  return seg.charAt(0).toUpperCase() + seg.slice(1);
};

/** Offline fallback for the map codename table. NEVER authoritative: Riot
 *  reuses codenames between releases (Plummet → Summit, Abyss moved to
 *  Infinity), so the live valorant-api index always outranks this. */
const OFFLINE_MAP_NAMES: Record<string, string> = {
  '/game/maps/duality/duality': 'Bind',
  '/game/maps/bonsai/bonsai': 'Split',
  '/game/maps/ascent/ascent': 'Ascent',
  '/game/maps/triad/triad': 'Haven',
  '/game/maps/port/port': 'Icebox',
  '/game/maps/foxtrot/foxtrot': 'Breeze',
  '/game/maps/canyon/canyon': 'Fracture',
  '/game/maps/pitt/pitt': 'Pearl',
  '/game/maps/jam/jam': 'Lotus',
  '/game/maps/juliett/juliett': 'Sunset',
  '/game/maps/plummet/plummet': 'Summit',
  '/game/maps/infinity/infinity': 'Abyss',
  '/game/maps/rook/rook': 'Corrode',
  '/game/maps/poveglia/range': 'The Range',
};

/**
 * Single source of truth for a map display name, and safe to call synchronously
 * from persisted-state read paths.
 *
 * Order matters: the live valorant-api index wins, the offline table is a
 * fallback, the path segment is last. A name that was STORED by an older build
 * must never be trusted — that is how a cached lobby kept reporting "Abyss"
 * for Summit long after Riot moved the codename.
 */
export function resolveMapName(mapId: string, maps?: Record<string, string>): string {
  const id = String(mapId || '').toLowerCase();
  if (!id) return '';
  const index = maps ?? mapIndexMem;
  return index[id] || OFFLINE_MAP_NAMES[id] || shortMapName(id, index);
}

/**
 * Re-derives `mapName` from `mapId` for a state that came out of a cache or
 * localStorage. Persisted derived fields go stale the moment Riot reuses a
 * codename, so read paths always recompute instead of trusting the stored name.
 */
function healMapName(s: LiveMatchState): LiveMatchState;
function healMapName(s: LiveMatchState | null): LiveMatchState | null;
function healMapName(s: LiveMatchState | null): LiveMatchState | null {
  if (!s || !s.mapId) return s;
  const mapName = resolveMapName(s.mapId);
  if (!mapName || mapName === s.mapName) return s;
  return { ...s, mapName };
}

/** True all-time peak tier for one season row (end tier, act rank, or highest won tier). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seasonPeakTier(s: any): number {
  const endTier = Number(s?.CompetitiveTier ?? 0);
  const actRank = Number(s?.Rank ?? 0);
  let winTier = 0;
  if (s?.WinsByTier && typeof s.WinsByTier === 'object') {
    for (const tk of Object.keys(s.WinsByTier)) {
      const num = Number(tk);
      if (!isNaN(num) && Number(s.WinsByTier[tk]) > 0) {
        winTier = Math.max(winTier, num);
      }
    }
  }
  return Math.max(endTier, actRank, winTier);
}

/**
 * True all-time peak tier PLUS the act it was reached in.
 * Riot keys SeasonalInfoBySeasonID by season uuid, so the winning key is the act id.
 * Pass `orderNewestFirst` (newest→oldest) so ties resolve to the MOST RECENT act
 * rather than to arbitrary object insertion order.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractPeakInfo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  seasonsObj: Record<string, any>,
  orderNewestFirst: string[] = []
): { tier: number; seasonId: string } {
  const keys = Object.keys(seasonsObj || {});
  if (keys.length === 0) return { tier: 0, seasonId: '' };

  // Oldest → newest, so a strict `>` lets the newest act win every tie.
  const rank = new Map<string, number>();
  orderNewestFirst.forEach((id, i) => rank.set(String(id).toLowerCase(), orderNewestFirst.length - i));
  const ordered = keys.slice().sort((a, b) => {
    const ra = rank.get(a.toLowerCase());
    const rb = rank.get(b.toLowerCase());
    if (ra != null && rb != null) return ra - rb;
    if (ra != null) return -1;
    if (rb != null) return 1;
    return 0;
  });

  let tier = 0;
  let seasonId = '';
  for (const id of ordered) {
    const t = seasonPeakTier(seasonsObj[id]);
    if (t > tier) {
      tier = t;
      seasonId = id;
    }
  }
  return { tier, seasonId };
}

/** Calculate the true all-time peak tier from Riot's SeasonalInfoBySeasonID payload */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractPeakTier(seasonsObj: Record<string, any>): number {
  return extractPeakInfo(seasonsObj).tier;
}

/** Rank + RR + peak + per-season peaks straight from Riot. */
export async function fetchMmrDirect(region: string, name: string, tag: string): Promise<TrackerProfile> {
  const ent = await getEntitlements();
  const j = await riotGet(shardFor(region), `/mmr/v1/players/${ent.puuid}`);
  const latest = j?.LatestCompetitiveUpdate ?? {};
  const currentSeasonId = String(latest?.SeasonID ?? '').toLowerCase();
  const seasons = j?.QueueSkills?.competitive?.SeasonalInfoBySeasonID ?? {};
  let wins = 0;
  let games = 0;
  let peakTier = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const per: { id: string; games: number; wins: number; tier: number }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const [id, s] of Object.entries(seasons) as [string, any][]) {
    const g = Number(s?.NumberOfGames ?? 0);
    const endTier = Number(s?.CompetitiveTier ?? 0);
    const actRank = Number(s?.Rank ?? 0);
    let winTier = 0;
    if (s?.WinsByTier && typeof s.WinsByTier === 'object') {
      for (const tk of Object.keys(s.WinsByTier)) {
        const num = Number(tk);
        if (!isNaN(num) && Number(s.WinsByTier[tk]) > 0) {
          winTier = Math.max(winTier, num);
        }
      }
    }
    const t = Math.max(endTier, actRank, winTier);
    per.push({ id, games: g, wins: Number(s?.NumberOfWins ?? 0), tier: t });
    if (g >= games) {
      games = g;
      wins = Number(s?.NumberOfWins ?? 0);
    }
    peakTier = Math.max(peakTier, t);
  }
  const tierId = Number(latest?.TierAfterUpdate ?? 0);
  // Wins/games belong to the CURRENT act (Riot tells us which). Fall back to busiest.
  if (currentSeasonId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cur = (Object.entries(seasons) as [string, any][]).find(([id]) => String(id).toLowerCase() === currentSeasonId)?.[1];
    if (cur && Number(cur?.NumberOfGames ?? 0) > 0) {
      games = Number(cur.NumberOfGames);
      wins = Number(cur?.NumberOfWins ?? 0);
    }
  }
  return {
    name,
    tag,
    region,
    puuid: ent.puuid,
    rank: tierName(tierId),
    tier: tierId,
    rr: Number(latest?.RankedRatingAfterUpdate ?? 0),
    peak: peakTier > 0 ? tierName(peakTier) : '—',
    wins,
    games,
    currentSeasonId,
    seasons: per.filter((s) => s.games > 0).sort((a, b) => b.games - a.games),
  };
}

export interface PlayerIdentity {
  cardId: string;
  titleId: string;
  level: number;
}

let identityCache: { at: number; puuid: string; id: PlayerIdentity } | null = null;

/** Equipped player card + account level.
 *
 *  `/personalization/v1|v2/players/{puuid}/playerloadout` now 404s (endpoint
 *  retired), which silently left `cardId` empty and made the sidebar fall back
 *  to a letter avatar with no banner. The local presence blob carries both
 *  values for every signed-in player, so that is the source of truth. */
async function fetchPresenceIdentity(
  puuid: string
): Promise<{ cardId: string; level: number } | null> {
  if (!isTauri()) return null;
  const raw = await invoke<string>('local_presences');
  const presences: unknown[] = JSON.parse(raw)?.presences ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const me = (presences as any[]).find(
    (p) => String(p?.puuid ?? '').toLowerCase() === puuid.toLowerCase()
  );
  if (!me?.private) return null;
  const blob = JSON.parse(decodeBase64Utf8(String(me.private)));
  const ppd = blob?.playerPresenceData ?? {};
  return {
    cardId: String(ppd?.playerCardId ?? ''),
    level: Number(ppd?.accountLevel ?? 0),
  };
}

/** Base64 → UTF-8 string. `atob` alone mangles non-ASCII (player names). */
function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function fetchIdentityDirect(_region: string): Promise<PlayerIdentity> {
  const ent = await getEntitlements();
  // Keyed by account: after an account switch the previous user's card/level
  // must not be served from cache for 30 minutes.
  if (
    identityCache &&
    identityCache.puuid.toLowerCase() === ent.puuid.toLowerCase() &&
    Date.now() - identityCache.at < 30 * 60 * 1000
  )
    return identityCache.id;
  const fromPresence = await fetchPresenceIdentity(ent.puuid).catch(() => null);
  const id: PlayerIdentity = {
    cardId: fromPresence?.cardId ?? '',
    titleId: '',
    level: fromPresence?.level ?? 0,
  };
  if (!id.cardId) throw new Error('No player card equipped.');
  identityCache = { at: Date.now(), puuid: ent.puuid, id };
  return id;
}

/** Player card art (banner + avatar).
 *
 *  The media host serves each card at a fixed path, so the URLs are derived
 *  from the card ID directly — no API round-trip, no CORS dependency, and it
 *  resolves instantly (including offline). `/wideart.png` is the banner,
 *  `/smallart.png` the square avatar. Synchronous so callers can use it during
 *  first render, before any fetch resolves. */
export function cardArtUrls(cardId?: string): { wide: string; small: string } {
  if (!cardId) return { wide: '', small: '' };
  const base = `https://media.valorant-api.com/playercards/${cardId}`;
  return { wide: `${base}/wideart.png`, small: `${base}/smallart.png` };
}

/** Last N competitive games with map, time, and RR earned — feeds rows AND trend. */
export async function fetchCompetitiveUpdates(
  region: string,
  count = 20,
  queue = 'competitive'
): Promise<TrackerMmrPoint[]> {
  const ent = await getEntitlements();
  const queueParam = queue ? `&queue=${encodeURIComponent(queue)}` : '';
  const j = await riotGet(
    shardFor(region),
    `/mmr/v1/players/${ent.puuid}/competitiveupdates?startIndex=0&endIndex=${count}${queueParam}`
  );
  const list = Array.isArray(j?.Matches) ? j.Matches : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return list.map((g: any) => ({
    tier: tierName(Number(g?.TierAfterUpdate ?? 0)),
    rr: Number(g?.RankedRatingAfterUpdate ?? 0),
    change: Number(g?.RankedRatingEarned ?? 0),
    matchId: String(g?.MatchID ?? ''),
    mapId: String(g?.MapID ?? ''),
    when: Number(g?.MatchStartTime ?? 0),
    queueId: String(g?.QueueID ?? queue ?? 'competitive'),
  }));
}

/** Find the account's shard: cached 7 days, else first shard that answers. */
export async function detectRegion(): Promise<string> {
  try {
    const ent = await getEntitlements();
    if (ent.access_token) {
      const part = ent.access_token.split('.')[1];
      if (part) {
        const decoded = JSON.parse(atob(part));
        const reg = decoded?.pp?.c || decoded?.c;
        if (reg && typeof reg === 'string') {
          // Persist so the 7-day cache branch below can hit when the token
          // is momentarily unreadable — without a writer that branch is dead
          // and non-EU users fall through to 'eu'.
          try {
            localStorage.setItem(
              'aspect_tracker_shard',
              JSON.stringify({ savedAt: Date.now(), region: reg.toLowerCase() })
            );
          } catch {}
          return reg.toLowerCase();
        }
      }
    }
  } catch {}
  try {
    const raw = localStorage.getItem('aspect_tracker_shard');
    if (raw) {
      const { savedAt, region } = JSON.parse(raw);
      if (Date.now() - savedAt < 7 * 24 * 3600 * 1000 && region) return region;
    }
  } catch {}
  return 'eu';
}

export async function fetchHistoryMeta(
  region: string,
  start: number,
  count: number
): Promise<{ total: number; queueById: Record<string, string> }> {
  const ent = await getEntitlements();
  const j = await riotGet(
    shardFor(region),
    `/match-history/v1/history/${ent.puuid}?startIndex=${start}&endIndex=${start + count}`
  );
  const queueById: Record<string, string> = {};
  const h = Array.isArray(j?.History) ? j.History : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const x of h as any[]) {
    const id = String(x?.MatchID ?? '');
    if (id) queueById[id] = String(x?.QueueID ?? '');
  }
  return { total: Number(j?.Total ?? 0), queueById };
}

export const queueLabel = (q: string): string => {
  const s = q.trim().toLowerCase();
  if (s === 'competitive') return 'Competitive';
  if (s === 'unrated') return 'Unrated';
  if (s === 'deathmatch') return 'Deathmatch';
  if (s === 'spikerush') return 'Spike Rush';
  if (s === 'swiftplay') return 'Swiftplay';
  if (s === 'custom') return 'Custom';
  return s ? s[0].toUpperCase() + s.slice(1) : '—';
};

const normTeam = (t: unknown): string => {
  const s = String(t ?? '').toLowerCase();
  if (s === 'blue') return 'Blue';
  if (s === 'red') return 'Red';
  return String(t ?? '');
};

/**
 * Resolve a list of PUUIDs into real GameName and TagLine via Riot Name-Service.
 * Results are cached in localStorage to prevent repeated network calls.
 */
export async function resolvePlayerNames(
  puuids: string[],
  shard = 'eu'
): Promise<Record<string, { name: string; tag: string }>> {
  if (puuids.length === 0) return {};
  const cacheKey = 'aspect_names_cache_v2';
  const legacyKey = 'aspect_names_cache_v1';
  let cache: Record<string, { name: string; tag: string }> = {};
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) cache = JSON.parse(raw);
  } catch {}
  // One-time migration: v1 held ~200+ resolved names. Merge them into v2
  // instead of dropping them — otherwise every live lobby re-PUTs 10
  // PUUIDs and risks Riot 1015 rate-limiting mid-game.
  try {
    const legacyRaw = localStorage.getItem(legacyKey);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as Record<string, { name: string; tag: string }>;
      let migrated = 0;
      for (const [k, v] of Object.entries(legacy || {})) {
        if (v?.name && !cache[k]) {
          cache[k] = v;
          migrated++;
        }
      }
      if (migrated > 0) {
        try {
          localStorage.setItem(cacheKey, JSON.stringify(cache));
        } catch {}
      }
      try {
        localStorage.removeItem(legacyKey);
      } catch {}
    }
  } catch {}

  const cachedFor = (p: string) => cache[p] ?? cache[p.toLowerCase()] ?? cache[p.toUpperCase()];
  const missing = puuids.filter((p) => !cachedFor(p)?.name);
  if (missing.length === 0) return cache;

  // Path 1 — the Riot Client's own account service. Local, batched, no
  // entitlements token, no remote round trip, no 1015 rate limit. It also
  // reports an explicit per-PUUID error, so a blank name here is a real
  // "unknown", not a silent failure. This is the primary path; the remote
  // name-service below is the fallback.
  try {
    const localRes = await invoke<string>('riot_local_namesets', { puuids: missing });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const localParsed = JSON.parse(localRes) as any[];
    if (Array.isArray(localParsed)) {
      for (const item of localParsed) {
        const sub = String(item?.puuid ?? item?.Subject ?? '').trim();
        const gn = String(item?.alias?.gameName ?? item?.alias?.game_name ?? '').trim();
        const tl = String(item?.alias?.tagLine ?? item?.alias?.tag_line ?? '').trim();
        if (sub && gn) {
          cache[sub] = { name: gn, tag: tl };
          cache[sub.toLowerCase()] = { name: gn, tag: tl };
          cache[sub.toUpperCase()] = { name: gn, tag: tl };
        }
      }
      try {
        localStorage.setItem(cacheKey, JSON.stringify(cache));
      } catch {}
    }
  } catch (e) {
    if (import.meta.env.DEV) logger.warn('Local nameset lookup failed:', e);
  }

  // Only PUUIDs the local service could not answer go to the remote call.
  const stillMissing = puuids.filter((p) => !cachedFor(p)?.name);
  if (stillMissing.length === 0) return cache;

  try {
    // Accept either a short region ('eu') or a full pd host — Rust
    // normalizes both, but short codes are unambiguous.
    const short = shard.replace(/^pd\./i, '').replace(/\.a\.pvp\.net$/i, '').toLowerCase() || 'eu';
    const res = await invoke<string>('riot_resolve_names', {
      shard: short,
      puuids: stillMissing,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse(res) as any[];
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const sub = String(item?.Subject ?? item?.subject ?? '').trim();
        const gn = String(item?.GameName ?? item?.gameName ?? item?.DisplayName ?? item?.displayName ?? '').trim();
        const tl = String(item?.TagLine ?? item?.tagLine ?? '').trim();
        if (sub && gn) {
          cache[sub] = { name: gn, tag: tl };
          cache[sub.toLowerCase()] = { name: gn, tag: tl };
          cache[sub.toUpperCase()] = { name: gn, tag: tl };
        }
      }
      try {
        localStorage.setItem(cacheKey, JSON.stringify(cache));
      } catch {}
    }
  } catch (e) {
    if (import.meta.env.DEV) logger.warn('Failed to resolve player names:', e);
  }

  return cache;
}

/**
 * Permanently remember Riot IDs from a trusted source (post-game
 * match-details payload, live presences). This is how strict-hidden players
 * get unmasked: Riot blanks their live name-service entry, but reveals the
 * real gameName/tagLine after the match — once seen, Recon knows them in
 * every future lobby, even while hidden.
 */
export function rememberPlayerNames(entries: { puuid: string; name: string; tag: string }[]): void {
  if (entries.length === 0) return;
  const cacheKey = 'aspect_names_cache_v2';
  let cache: Record<string, { name: string; tag: string }> = {};
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) cache = JSON.parse(raw);
  } catch {}
  let touched = false;
  for (const e of entries) {
    const sub = String(e?.puuid ?? '').trim();
    const nm = String(e?.name ?? '').trim();
    if (!sub || !nm || nm.startsWith('Player ')) continue;
    const tg = String(e?.tag ?? '').trim();
    const val = { name: nm, tag: tg };
    if (cache[sub]?.name !== nm || cache[sub]?.tag !== tg) {
      cache[sub] = val;
      cache[sub.toLowerCase()] = val;
      cache[sub.toUpperCase()] = val;
      touched = true;
    }
  }
  if (touched) {
    try {
      localStorage.setItem(cacheKey, JSON.stringify(cache));
    } catch {}
  }
}

/**
 * Decides when a finished match should be harvested for real names.
 *
 * Riot blanks strict-hidden stranger names in BOTH live payloads and
 * /name-service during a match, but releases them once the match is over.
 * So the moment we transition out of `coregame` we must ask name-service
 * for the whole lobby and remember the answers — that is the only window
 * where a hidden player's real Riot ID becomes available.
 *
 * Returns the deduped PUUIDs of every lobby participant at match end, or
 * null when no harvest should run (not a match end, or nobody to ask for).
 * Pure — no I/O, so the transition rules are testable.
 */
export function matchEndHarvest(
  prev: LiveMatchState | null,
  next: LiveMatchState
): string[] | null {
  if (!prev || prev.phase !== 'coregame') return null;
  if (next.phase === 'coregame') return null;
  const puuids = [...prev.blueTeam, ...prev.redTeam]
    .map((p) => p.puuid)
    .filter(Boolean);
  const deduped = [...new Set(puuids)];
  return deduped.length > 0 ? deduped : null;
}

/**
 * Asks name-service for the whole lobby at match end and remembers the
 * answers permanently. This is what makes strict-hidden players show their
 * real Riot ID in every future lobby: Riot only releases those names after
 * the match, and `resolvePlayerNames` + `rememberPlayerNames` fold them into
 * the persistent cache. Best-effort — never throws into the poll loop.
 */
export async function harvestMatchNames(puuids: string[], region?: string): Promise<number> {
  if (puuids.length === 0) return 0;
  try {
    // Callers may not know the shard; detectRegion reads it from the local
    // session token, which is exactly what resolvePlayerNames needs.
    const shard = region || (await detectRegion());
    // matchEndHarvest already deduped; resolvePlayerNames caches by PUUID.
    const nameMap = await resolvePlayerNames(puuids, shard);
    const entries = puuids
      .map((puuid) => {
        const hit = nameMap[puuid] ?? nameMap[puuid.toLowerCase()] ?? nameMap[puuid.toUpperCase()];
        return hit?.name ? { puuid, name: hit.name, tag: hit.tag } : null;
      })
      .filter((e): e is { puuid: string; name: string; tag: string } => e !== null);
    if (entries.length === 0) return 0;
    rememberPlayerNames(entries);
    return entries.length;
  } catch {
    return 0;
  }
}

/**
 * Full match straight from Riot via the SAME endpoint TRN/Blitz call locally
 * (match-details/v1 — the singular /match/v1 path 503s for client creds).
 * Immutable → cached forever. Throws when unusable.
 */
export async function fetchMatchDetailDirect(region: string, matchId: string): Promise<TrackerMatchDetail> {
  const cacheKey = `recon_match_v6_${matchId}`;
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) return JSON.parse(raw) as TrackerMatchDetail;
    const legacyRaw = localStorage.getItem(`aspect_match_v5_${matchId}`);
    if (legacyRaw) {
      const parsed = JSON.parse(legacyRaw) as TrackerMatchDetail;
      if (parsed.players?.[0]?.partyId) return parsed;
    }
  } catch {}
  const shard = shardFor(region);
  const j = await riotGet(shard, `/match-details/v1/matches/${matchId}`);
  const { agents: amap } = await gameData();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const players: TrackerPlayer[] = ((Array.isArray(j?.players) ? j.players : []) as any[]).map((p) => {
    const st = p?.stats ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dmg = (Array.isArray(p?.roundDamage) ? p.roundDamage : []).reduce((n: number, r: any) => n + Number(r?.damage ?? 0), 0);
    return {
      puuid: String(p?.subject ?? ''),
      name: String(p?.gameName ?? ''),
      tag: String(p?.tagLine ?? ''),
      team: normTeam(p?.teamId),
      agent: amap[String(p?.characterId ?? '').toLowerCase()] ?? 'Agent',
      kills: Number(st.kills ?? 0),
      deaths: Number(st.deaths ?? 0),
      assists: Number(st.assists ?? 0),
      damage: dmg,
      damageTaken: 0,
      score: Number(st.score ?? 0),
      rounds: Number(st.roundsPlayed ?? 0),
      playtimeMs: Number(st.playtimeMillis ?? 0),
      headshots: 0,
      bodyshots: 0,
      legshots: 0,
      accountLevel: Number(p?.accountLevel ?? 0),
      tier: Number(p?.competitiveTier ?? 0),
      partyId: String(p?.partyId ?? ''),
    };
  });
  if (players.length === 0) throw new Error('Empty scoreboard.');

  // Identify parties (players with the same partyId where party size >= 2)
  const matchPartyCounts = new Map<string, number>();
  for (const p of players) {
    if (p.partyId) {
      matchPartyCounts.set(p.partyId, (matchPartyCounts.get(p.partyId) ?? 0) + 1);
    }
  }
  const matchPartyIdxMap = new Map<string, number>();
  let nextMatchPartyIdx = 1;
  for (const [pId, count] of matchPartyCounts.entries()) {
    if (count >= 2) {
      matchPartyIdxMap.set(pId, nextMatchPartyIdx++);
    }
  }
  for (const p of players) {
    if (p.partyId && matchPartyIdxMap.has(p.partyId)) {
      p.partyIndex = matchPartyIdxMap.get(p.partyId);
    }
  }

  // Resolve real player names from PUUIDs using Riot name-service
  try {
    const puuids = players.map((p) => p.puuid).filter(Boolean);
    const nameMap = await resolvePlayerNames(puuids, region);
    for (const p of players) {
      if (nameMap[p.puuid]?.name) {
        p.name = nameMap[p.puuid].name;
        p.tag = nameMap[p.puuid].tag;
      }
    }
  } catch {}
  // Permanent memory: the payload reveals strict-hidden names post-game.
  // Remember them so future live lobbies unmask instantly from cache.
  try {
    rememberPlayerNames(players.map((p) => ({ puuid: p.puuid, name: p.name, tag: p.tag })));
  } catch {}
  const teamOf = (puuid: string): string => players.find((p) => p.puuid === puuid)?.team ?? '';
  // Damage taken: every player's roundDamage lists who they hit — invert it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawPlayers: any[] = Array.isArray(j?.players) ? j.players : [];
  const taken = new Map<string, number>();
  for (const rp of rawPlayers) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of (Array.isArray(rp?.roundDamage) ? rp.roundDamage : []) as any[]) {
      const recv = String(r?.receiver ?? '');
      if (recv) taken.set(recv, (taken.get(recv) ?? 0) + Number(r?.damage ?? 0));
    }
  }
  for (const p of players) p.damageTaken = taken.get(p.puuid) ?? 0;
  // Team scores come straight from the payload — no round counting needed.
  const teamScore: Record<string, number> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const t of (Array.isArray(j?.teams) ? j.teams : []) as any[]) {
    teamScore[normTeam(t?.teamId)] = Number(t?.roundsWon ?? 0);
  }
  const roundsSrc: unknown[] = Array.isArray(j?.roundResults) ? j.roundResults : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rounds = (roundsSrc as any[]).map((r) => ({
    winningTeam: normTeam(r?.winningTeam),
    roundResult: String(r?.roundResult ?? 'Elimination'),
    ceremony: String(r?.roundCeremony ?? ''),
  }));
  const kills: TrackerDuel[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (roundsSrc as any[]).forEach((r) => {
    const num = Number(r?.roundNum ?? 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pstats: any[] = Array.isArray(r?.playerStats) ? r.playerStats : [];
    for (const ps of pstats) {
      const sub = String(ps?.subject ?? '');
      const p = players.find((x) => x.puuid === sub);
      if (p) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const d of (Array.isArray(ps?.damage) ? ps.damage : []) as any[]) {
          p.headshots += Number(d?.headshots ?? 0);
          p.bodyshots += Number(d?.bodyshots ?? 0);
          p.legshots += Number(d?.legshots ?? 0);
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kl: any[] = Array.isArray(ps?.kills) ? ps.kills : [];
      for (const k of kl) {
        const kp = String(k?.killer ?? ps?.subject ?? '');
        const vp = String(k?.victim ?? '');
        kills.push({
          round: num,
          killerPuuid: kp,
          victimPuuid: vp,
          killerTeam: teamOf(kp),
          victimTeam: teamOf(vp),
          timeInRound: Number(k?.roundTime ?? 0),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          weapon: String((k as any)?.finishingDamage?.damageItem ?? ''),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          assists: Array.isArray((k as any)?.assistants) ? (k as any).assistants.map((a: unknown) => String(a)) : [],
        });
      }
    }
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mi: any = (j as any)?.matchInfo ?? {};
  const out: TrackerMatchDetail = {
    rounds,
    players,
    kills,
    mapId: String(mi.mapId ?? ''),
    teamScore,
    queue: String(mi.queueID ?? ''),
    when: Number(mi.gameStartMillis ?? 0),
    durationMs: Number(mi.gameLengthMillis ?? 0),
  };
  try {
    localStorage.setItem(cacheKey, JSON.stringify(out));
  } catch {}
  return out;
}

export interface AggStats {
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  rounds: number;
  matches: number;
  kd: number;
  adr: number;
  flawless: number;
  clutches: number;
  aces: number;
  firstKills: number;
  firstDeaths: number;
  topAgent: { name: string; matches: number; hours: number };
}

/** Round-level heroics + identity, derived purely from a cached scoreboard. */
export function deriveHeroics(
  detail: TrackerMatchDetail,
  puuid: string
): { flawless: number; clutch: boolean; ace: boolean; firstKill: boolean; firstDeath: boolean; agent: string; playtimeMs: number } {
  const me = detail.players.find((p) => p.puuid === puuid);
  const myTeam = me?.team ?? '';
  const byRound = new Map<number, TrackerDuel[]>();
  for (const k of detail.kills) {
    const l = byRound.get(k.round) ?? [];
    l.push(k);
    byRound.set(k.round, l);
  }
  let flawless = 0;
  let clutch = false;
  let ace = false;
  for (const [num, kl] of byRound) {
    const round = detail.rounds[num];
    const won = round?.winningTeam === myTeam;
    const myDeaths = kl.filter((k) => k.victimTeam === myTeam).length;
    const mateDeaths = kl.filter((k) => k.victimTeam === myTeam && k.victimPuuid !== puuid).length;
    const iDied = kl.some((k) => k.victimPuuid === puuid);
    const myKills = kl.filter((k) => k.killerPuuid === puuid).length;
    if (won && myTeam && myDeaths === 0) flawless++;
    // Real clutch: I survived with a kill while 2+ mates were already dead (>=3 = 3vX or worse).
    if (won && !iDied && myKills > 0 && mateDeaths >= 3) clutch = true;
    if (myKills >= 5) ace = true;
  }
  const flat = [...detail.kills].sort((a, b) => a.round - b.round || a.timeInRound - b.timeInRound);
  return {
    flawless,
    clutch,
    ace,
    firstKill: flat.length > 0 && flat[0].killerPuuid === puuid,
    firstDeath: flat.length > 0 && flat[0].victimPuuid === puuid,
    agent: me?.agent ?? 'Agent',
    playtimeMs: Number((me as TrackerPlayer & { playtimeMs?: number })?.playtimeMs ?? 0),
  };
}

export interface MatchCard {
  kills3: number;
  kills4: number;
  aces: number;
  kastPct: number;
  dmgTaken: number;
  ddDelta: number;
  clutchWon: boolean;
  clutchLost: boolean;
  weaponKills: Record<string, number>;
}

/** Per-match Blitz-style card: multikills, KAST, damage delta, clutch flags, weapons. */
export function matchCard(detail: TrackerMatchDetail, puuid: string): MatchCard {
  const byRound = new Map<number, TrackerDuel[]>();
  for (const k of detail.kills) {
    const l = byRound.get(k.round) ?? [];
    l.push(k);
    byRound.set(k.round, l);
  }
  let kills3 = 0;
  let kills4 = 0;
  let aces = 0;
  let kastRounds = 0;
  let clutchWon = false;
  let clutchLost = false;
  const weaponKills: Record<string, number> = {};
  const me = detail.players.find((p) => p.puuid === puuid);
  const myTeam = me?.team ?? '';
  const rounds = byRound.size || detail.rounds.length || 1;
  for (const [num, kl] of byRound) {
    const won = detail.rounds[num]?.winningTeam === myTeam;
    const myK = kl.filter((k) => k.killerPuuid === puuid);
    const iDied = kl.some((k) => k.victimPuuid === puuid);
    const iAssisted = kl.some((k) => k.assists?.includes(puuid));
    if (myK.length === 3) kills3++;
    if (myK.length === 4) kills4++;
    if (myK.length >= 5) aces++;
    if (myK.length > 0 || iAssisted || !iDied) kastRounds++;
    const mateDeaths = kl.filter((k) => k.victimTeam === myTeam && k.victimPuuid !== puuid).length;
    // Won clutch: alive at the end with 2+ mates down. Lost clutch: fought
    // alone to the end (last alive) but the round slipped away.
    if (myK.length > 0 && mateDeaths >= 3) {
      if (won && !iDied) clutchWon = true;
      if (!won && mateDeaths >= 4) clutchLost = true;
    }
    for (const k of myK) {
      const w = (k.weapon || '').toLowerCase();
      if (w) weaponKills[w] = (weaponKills[w] ?? 0) + 1;
    }
  }
  let dmgTaken = 0;
  let ddDelta = 0;
  {
    const d = detail.players.find((p) => p.puuid === puuid);
    if (d) {
      dmgTaken = d.damageTaken;
      ddDelta = d.damage - d.damageTaken;
    }
  }
  return { kills3, kills4, aces, kastPct: Math.round((kastRounds / rounds) * 100), dmgTaken, ddDelta, clutchWon, clutchLost, weaponKills };
}

/** Aggregate K/D/ADR over a set of matches (details cached forever, repeats are free). */
export async function aggregateDetails(
  region: string,
  matchIds: string[],
  puuid: string
): Promise<{ agg: AggStats; byId: Record<string, TrackerMatchDetail> }> {
  const byId: Record<string, TrackerMatchDetail> = {};
  await Promise.all(
    matchIds.map(async (id) => {
      try {
        byId[id] = await fetchMatchDetailDirect(region, id);
      } catch {}
    })
  );
  let kills = 0;
  let deaths = 0;
  let assists = 0;
  let damage = 0;
  let rounds = 0;
  let matches = 0;
  let flawless = 0;
  let clutches = 0;
  let aces = 0;
  let firstKills = 0;
  let firstDeaths = 0;
  const agentUse = new Map<string, { matches: number; ms: number }>();
  for (const id of matchIds) {
    const d = byId[id];
    const me = d?.players.find((p) => p.puuid === puuid);
    if (!me) continue;
    matches++;
    kills += me.kills;
    deaths += me.deaths;
    assists += me.assists;
    damage += me.damage;
    rounds += me.rounds;
    const h = deriveHeroics(d, puuid);
    flawless += h.flawless;
    if (h.clutch) clutches++;
    if (h.ace) aces++;
    if (h.firstKill) firstKills++;
    if (h.firstDeath) firstDeaths++;
    const a = agentUse.get(h.agent) ?? { matches: 0, ms: 0 };
    a.matches++;
    a.ms += h.playtimeMs;
    agentUse.set(h.agent, a);
  }
  let topAgent = { name: '—', matches: 0, hours: 0 };
  for (const [name, a] of agentUse) {
    if (a.matches > topAgent.matches) {
      topAgent = { name, matches: a.matches, hours: Math.round((a.ms / 3600000) * 10) / 10 };
    }
  }
  return {
    agg: {
      kills,
      deaths,
      assists,
      damage,
      rounds,
      matches,
      kd: deaths > 0 ? kills / deaths : kills,
      adr: rounds > 0 ? damage / rounds : 0,
      flawless,
      clutches,
      aces,
      firstKills,
      firstDeaths,
      topAgent,
    },
    byId,
  };
}

export const glzHostFor = (region: string): string => {
  const r = region.toLowerCase();
  const map: Record<string, string> = {
    eu: 'glz-eu-1.eu.a.pvp.net',
    na: 'glz-na-1.na.a.pvp.net',
    ap: 'glz-ap-1.ap.a.pvp.net',
    kr: 'glz-kr-1.kr.a.pvp.net',
    latam: 'glz-latam-1.latam.a.pvp.net',
    br: 'glz-br-1.br.a.pvp.net',
  };
  return map[r] ?? 'glz-eu-1.eu.a.pvp.net';
};

/**
 * Equipped skins + sprays for everyone in the match — agent select AND in-progress.
 *
 * Two routes, one per phase (verified against valapidocs + live payloads):
 *   GET glz-…/pregame/v1/matches/{pregameId}/loadouts    (agent select)
 *   GET glz-…/core-game/v1/matches/{coregameId}/loadouts (in match)
 *
 * The match-ID namespaces differ per phase, so a pregame ID 404s on the
 * core-game route and vice versa. The caller's phase is tried first, then the
 * other one — this runs once per Skins click (never polled), so the extra 404
 * on a phase change is cheap. First non-empty `Loadouts` array wins.
 *
 * Riot exposes loadouts nowhere else (the per-player personalization routes
 * 404). Returns the raw `Loadouts` array; `src/utils/loadout.ts` parses it.
 * Never throws: the caller is a UI path, so a miss returns `[]`.
 */
export async function fetchMatchLoadouts(
  matchId: string,
  region: string,
  phase?: 'pregame' | 'coregame',
): Promise<unknown[]> {
  if (!matchId) return [];
  /* Website preview: no Riot client available, so serve the seeded loadout
     payload. Same shape Riot returns, so parseLoadouts/resolveLoadoutForPlayer
     and the LoadoutViewer all run their real code paths. */
  if (!isTauri()) {
    try {
      const raw = localStorage.getItem('recon_preview_loadouts');
      if (raw) return JSON.parse(raw) as unknown[];
    } catch {}
    return [];
  }
  try {
    const glz = glzHostFor(region);
    const routes =
      phase === 'pregame'
        ? [
            `/pregame/v1/matches/${matchId}/loadouts`,
            `/core-game/v1/matches/${matchId}/loadouts`,
            `/coregame/v1/matches/${matchId}/loadouts`,
          ]
        : [
            `/core-game/v1/matches/${matchId}/loadouts`,
            `/coregame/v1/matches/${matchId}/loadouts`,
            `/pregame/v1/matches/${matchId}/loadouts`,
          ];
    for (const route of routes) {
      try {
        const raw = await riotGet(glz, route);
        const list = raw?.Loadouts ?? raw?.loadouts;
        if (Array.isArray(list) && list.length > 0) return list;
      } catch {
        /* Wrong phase namespace 404s here — try the next route. */
      }
    }
    return [];
  } catch {
    return [];
  }
}

const liveMmrCache = new Map<
  string,
  {
    tier: number;
    rr: number;
    peakTier: number;
    peakSeasonId?: string;
    actWins?: number;
    actGames?: number;
    leaderboardRank?: number;
    isRankHidden?: boolean;
    fetchedAt: number;
    /** Set when the last lookup FAILED (rate limit, blip). The entry keeps the
     *  last good rank and only backs off briefly before retrying. */
    retryAfter?: boolean;
  }
>();

/** A resolved rank stays valid for the session — Riot's numbers barely move
 *  mid-match. A FAILED lookup backs off only briefly so the rank comes back as
 *  soon as Riot answers again. */
const MMR_TTL_MS = 15 * 60 * 1000;
const MMR_RETRY_MS = 2 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * LAST-24H WIN/LOSS TRACKER
 * Riot's local match-history endpoint resolves for ANY puuid (not just
 * the signed-in account), and every entry carries GameStartTime. We keep
 * a compact per-match result table (matchId → { puuid: 1|0 }) instead of
 * full match details, so hundreds of matches cost only a few KB.
 * ------------------------------------------------------------------ */
const MATCH_RESULTS_KEY = 'recon_match_results_v1';

let matchResultTable: Record<string, Record<string, 1 | 0>> | null = null;

function loadResultTable(): Record<string, Record<string, 1 | 0>> {
  if (matchResultTable) return matchResultTable;
  try {
    const raw = localStorage.getItem(MATCH_RESULTS_KEY);
    matchResultTable = raw ? (JSON.parse(raw) as Record<string, Record<string, 1 | 0>>) : {};
  } catch {
    matchResultTable = {};
  }
  return matchResultTable;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistResultTable(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const table = loadResultTable();
      const ids = Object.keys(table);
      // Bound growth: keep the 400 most recently touched matches.
      if (ids.length > 400) {
        for (const id of ids.slice(0, ids.length - 400)) delete table[id];
      }
      localStorage.setItem(MATCH_RESULTS_KEY, JSON.stringify(table));
    } catch {}
  }, 1500);
}

/** Compact W/L lookup for one match+player. Returns 1 win, 0 loss, null unknown. */
async function fetchLiteMatchResult(
  region: string,
  matchId: string,
  puuid: string
): Promise<1 | 0 | null> {
  const table = loadResultTable();
  const known = table[matchId]?.[puuid];
  if (known !== undefined) return known;
  try {
    // riotGet itself is globally gated, so no extra slot here.
    const j = await riotGet(shardFor(region), `/match-details/v1/matches/${matchId}`);
    const scores: Record<string, number> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const t of (Array.isArray(j?.teams) ? j.teams : []) as any[]) {
      scores[normTeam(t?.teamId)] = Number(t?.roundsWon ?? 0);
    }
    const row: Record<string, 1 | 0> = {};
    // FFA modes have no two-sided result — recording one would pick an
    // arbitrary opponent, so the whole match is unknown rather than wrong.
    if (Object.keys(scores).length !== 2) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const p of (Array.isArray(j?.players) ? j.players : []) as any[]) {
      const sub = String(p?.subject ?? '');
      if (!sub) continue;
      const tm = normTeam(p?.teamId);
      const opp = Object.keys(scores).find((k) => k !== tm);
      if (!opp) continue;
      const mine = scores[tm] ?? 0;
      const theirs = scores[opp] ?? 0;
      // Draws are neither — recording them as losses fabricates the record.
      if (mine === theirs) continue;
      row[sub] = mine > theirs ? 1 : 0;
    }
    if (Object.keys(row).length === 0) return null;
    loadResultTable()[matchId] = row;
    persistResultTable();
    return row[puuid] ?? null;
  } catch {
    return null;
  }
}

/** Run an async mapper over items with a hard concurrency cap. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface Recent24hRecord {
  won: number;
  lost: number;
  /** Most recent results, newest first — used for the streak badge. */
  streak: number;
  streakIsWin: boolean;
  fetchedAt: number;
}

const recent24hCache = new Map<string, Recent24hRecord>();
const recent24hInflight = new Map<string, Promise<Recent24hRecord>>();
const livePlayerRecentMatchesCache = new Map<string, { matches: string[]; fetchedAt: number }>();

// Stable party assignment across polling cycles for the same match
let activePartyMatchKey = '';
const matchPartyIndexMap = new Map<string, number>();
let nextMatchPartyIndex = 1;

/** Compares two live match states to determine if any meaningful UI data changed.
 *  Covers EVERY field that reaches the screen, matched by PUUID (Riot can
 *  reorder players between polls) — no visual change ⇒ no re-render, ever. */
export function isMatchStateEqual(a: LiveMatchState | null, b: LiveMatchState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.phase !== b.phase ||
    a.matchId !== b.matchId ||
    a.mapId !== b.mapId ||
    a.mapName !== b.mapName ||
    a.mode !== b.mode ||
    a.queueId !== b.queueId ||
    a.isDeathmatch !== b.isDeathmatch ||
    a.isRange !== b.isRange ||
    a.isPreviousMatch !== b.isPreviousMatch ||
    a.startingSide !== b.startingSide ||
    a.allyScore !== b.allyScore ||
    a.enemyScore !== b.enemyScore ||
    a.error !== b.error ||
    a.blueTeam.length !== b.blueTeam.length ||
    a.redTeam.length !== b.redTeam.length
  ) {
    return false;
  }
  // NOTE: `updatedAt` is deliberately excluded — it advances every poll and
  // would make every comparison unequal.

  const isPlayerEqual = (p1: LiveMatchPlayer, p2: LiveMatchPlayer) => {
    return (
      p1.puuid.toLowerCase() === p2.puuid.toLowerCase() &&
      p1.name === p2.name &&
      p1.tag === p2.tag &&
      p1.team === p2.team &&
      p1.agentId === p2.agentId &&
      p1.agentName === p2.agentName &&
      p1.agentIcon === p2.agentIcon &&
      p1.agentRole === p2.agentRole &&
      p1.tier === p2.tier &&
      p1.rank === p2.rank &&
      p1.rr === p2.rr &&
      p1.peakTier === p2.peakTier &&
      p1.peakRank === p2.peakRank &&
      p1.peakSeasonId === p2.peakSeasonId &&
      p1.actWins === p2.actWins &&
      p1.actGames === p2.actGames &&
      p1.leaderboardRank === p2.leaderboardRank &&
      p1.isRankHidden === p2.isRankHidden &&
      p1.accountLevel === p2.accountLevel &&
      p1.cardId === p2.cardId &&
      p1.isMe === p2.isMe &&
      p1.selectionState === p2.selectionState &&
      p1.region === p2.region &&
      p1.country === p2.country &&
      p1.kd === p2.kd &&
      p1.winPct === p2.winPct &&
      p1.hsPct === p2.hsPct &&
      p1.trnScore === p2.trnScore &&
      p1.acs === p2.acs &&
      p1.recentWon === p2.recentWon &&
      p1.recentLost === p2.recentLost &&
      p1.streak === p2.streak &&
      p1.streakIsWin === p2.streakIsWin &&
      p1.isIncognito === p2.isIncognito &&
      p1.nameResolved === p2.nameResolved &&
      p1.partyId === p2.partyId &&
      p1.partyIndex === p2.partyIndex
    );
  };

  // Match by PUUID, not by array index — Riot reorders lobby rows between polls.
  const teamsEqual = (ta: LiveMatchPlayer[], tb: LiveMatchPlayer[]) => {
    if (ta.length !== tb.length) return false;
    const byId = new Map(tb.map((p) => [p.puuid.toLowerCase(), p]));
    return ta.every((pa) => {
      const pb = byId.get(pa.puuid.toLowerCase());
      return pb !== undefined && isPlayerEqual(pa, pb);
    });
  };

  return teamsEqual(a.blueTeam, b.blueTeam) && teamsEqual(a.redTeam, b.redTeam);
}

/**
 * Real win/loss record for a player over the last 24 hours, newest match first.
 * Only matches actually started within the window are counted.
 *
 * `queue` scopes the record to one Riot queue id ("competitive", "swiftplay",
 * "deathmatch", …). Without it a competitive lobby would show a player's
 * Swiftplay and Deathmatch games mixed in, which is meaningless next to their
 * rank. Riot's history rows each carry `QueueID`, so the filter is exact.
 */
export async function fetchPlayer24hRecord(
  puuid: string,
  region: string,
  queue?: string
): Promise<Recent24hRecord> {
  const empty: Recent24hRecord = { won: 0, lost: 0, streak: 0, streakIsWin: false, fetchedAt: Date.now() };
  if (!puuid) return empty;
  // Scope the cache per queue — two lobbies can otherwise poison each other.
  const key = queue ? `${puuid}:${queue}` : puuid;
  const cached = recent24hCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) return cached;
  // The overlay polls every few seconds — never stack duplicate work per player.
  const running = recent24hInflight.get(key);
  if (running) return running;

  const task = (async (): Promise<Recent24hRecord> => {
    try {
      const cutoff = Date.now() - 24 * 3600 * 1000;
      // Riot caps this endpoint at ~25 rows per request, so page through until
      // the oldest row falls outside the 24h window (heavy grinders).
      // Paging continues past the window: a page may be entirely the wrong
      // queue, so we cannot stop at the first out-of-window row alone.
      const entries: { id: string; at: number; queue: string }[] = [];
      for (let page = 0; page < 5; page++) {
        const start = page * 20;
        const j = await riotGet(
          shardFor(region),
          `/match-history/v1/history/${puuid}?startIndex=${start}&endIndex=${start + 20}`
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = ((Array.isArray(j?.History) ? j.History : []) as any[]).map((h) => ({
          id: String(h?.MatchID ?? ''),
          at: Number(h?.GameStartTime ?? 0),
          queue: String(h?.QueueID ?? ''),
        }));
        if (rows.length === 0) break;
        entries.push(...rows);
        const oldest = rows[rows.length - 1]?.at ?? 0;
        if (oldest < cutoff) break;
      }

      const targetQueue = (queue || '').toLowerCase().trim();
      const recent = entries
        .filter((h) => h.id && h.at >= cutoff && (!targetQueue || h.queue.toLowerCase().trim() === targetQueue))
        .sort((a, b) => b.at - a.at);

      if (recent.length === 0) {
        recent24hCache.set(key, empty);
        return empty;
      }

      const results = await mapLimit(recent, 4, (m) => fetchLiteMatchResult(region, m.id, puuid));
      let won = 0;
      let lost = 0;
      // results[] follows `recent` order = newest first
      const played = results.filter((r): r is 1 | 0 => r === 0 || r === 1);
      for (const r of played) {
        if (r === 1) won++;
        else lost++;
      }
      let streak = 0;
      const streakIsWin = played.length > 0 && played[0] === 1;
      for (const r of played) {
        const isWin = r === 1;
        if (isWin === streakIsWin) streak++;
        else break;
      }
      const record: Recent24hRecord = { won, lost, streak, streakIsWin, fetchedAt: Date.now() };
      recent24hCache.set(key, record);
      return record;
    } catch {
      // A transient Riot blip must not blank a known W/L + streak for the
      // full TTL (contrast the MMR path, which preserves last-good). Keep the
      // previous record; only genuine results are cached.
      const prev = recent24hCache.get(key);
      return prev ?? empty;
    } finally {
      recent24hInflight.delete(key);
    }
  })();

  recent24hInflight.set(key, task);
  return task;
}

export interface LivePlayerStatsEntry {
  kd?: number;
  winPct?: number;
  hsPct?: number;
  trnScore?: number;
  acs?: number;
  recentWon?: number;
  recentLost?: number;
  streak?: number;
  streakIsWin?: boolean;
  country?: string;
  fetchedAt: number;
  retryAfter?: number;
  /** Last successful 24h-record refresh — decoupled from `fetchedAt`, which
   *  TRN updates also bump. Sharing one timestamp let each source suppress
   *  the other's refresh. */
  recFetchedAt?: number;
}

const livePlayerStatsCache = new Map<string, LivePlayerStatsEntry>();
const LIVE_STATS_CACHE_KEY = 'recon_live_player_stats_v2';
const LIVE_STATS_TTL = 24 * 60 * 60 * 1000; // 24 hours — player act stats & country do not change every minute
const trnInFlightLive = new Set<string>();

export function getCachedLivePlayerStats(puuid: string): LivePlayerStatsEntry | undefined {
  if (!puuid) return undefined;
  const pU = puuid.toLowerCase();
  const mem = livePlayerStatsCache.get(pU);
  if (mem && Date.now() - mem.fetchedAt < LIVE_STATS_TTL) return mem;

  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(LIVE_STATS_CACHE_KEY);
      if (raw) {
        const store = JSON.parse(raw) as Record<string, LivePlayerStatsEntry>;
        const entry = store[pU];
        if (entry) {
          // Self-heal: clear poisoned multi-hour lockouts from previous sessions
          if (entry.retryAfter && entry.retryAfter > Date.now() + 2 * 60 * 1000) {
            entry.retryAfter = undefined;
          }
          if (Date.now() - entry.fetchedAt < LIVE_STATS_TTL) {
            livePlayerStatsCache.set(pU, entry);
            return entry;
          }
        }
      }
    } catch {}
  }
  // TTL-expired with no fresh persisted copy: stale must not masquerade as
  // fresh. Callers treat a return value as valid stats.
  return undefined;
}

export function setCachedLivePlayerStats(puuid: string, entry: Partial<LivePlayerStatsEntry>): void {
  if (!puuid) return;
  const pU = puuid.toLowerCase();

  let existing: LivePlayerStatsEntry | undefined = livePlayerStatsCache.get(pU);
  let store: Record<string, LivePlayerStatsEntry> = {};

  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(LIVE_STATS_CACHE_KEY);
      if (raw) {
        store = JSON.parse(raw);
        if (store[pU]) {
          existing = { ...existing, ...store[pU] };
        }
      }
    } catch {}
  }

  // Non-destructive merge: NEVER overwrite existing valid fields with undefined
  const merged: LivePlayerStatsEntry = {
    ...existing,
    fetchedAt: entry.fetchedAt ?? existing?.fetchedAt ?? Date.now(),
  };
  for (const [k, v] of Object.entries(entry)) {
    if (v !== undefined && v !== null) {
      (merged as any)[k] = v;
    }
  }
  if (entry.retryAfter !== undefined) {
    merged.retryAfter = entry.retryAfter;
  }

  livePlayerStatsCache.set(pU, merged);

  if (typeof localStorage !== 'undefined') {
    try {
      store[pU] = merged;
      const keys = Object.keys(store);
      if (keys.length > 200) {
        const sorted = keys.sort((a, b) => store[a].fetchedAt - store[b].fetchedAt);
        for (let i = 0; i < 40; i++) delete store[sorted[i]];
      }
      localStorage.setItem(LIVE_STATS_CACHE_KEY, JSON.stringify(store));
    } catch {}
  }
}

/**
 * Queue id of the match the player is currently in ("competitive", "swiftplay",
 * "deathmatch", …), or '' when not in one.
 *
 * Read from the local presence blob, which is the only source that tells
 * Competitive apart from Unrated — both share one ModeID in the core-game
 * payload, so the payload alone cannot scope the stats correctly. Ignored while
 * in menus, where the blob keeps the queue id of the last match played.
 */
export async function fetchLiveQueueId(): Promise<string> {
  try {
    if (!isTauri()) return '';
    const ent = await getEntitlements();
    const raw = await invoke<string>('local_presences');
    const presences: { puuid?: string; private?: string }[] = JSON.parse(raw)?.presences ?? [];
    const me = presences.find(
      (p) => String(p?.puuid ?? '').toLowerCase() === ent.puuid.toLowerCase()
    );
    if (!me?.private) return '';
    const blob = JSON.parse(decodeBase64Utf8(String(me.private)));
    const md = blob?.matchPresenceData ?? {};
    const loop = String(md?.sessionLoopState ?? '').toUpperCase();
    // PREGAME = agent select, INGAME = playing. Anything else is a stale value.
    if (loop !== 'PREGAME' && loop !== 'INGAME') return '';
    return String(md?.queueId ?? '').toLowerCase();
  } catch {
    return '';
  }
}

const LIVE_MATCH_CACHE_KEY = 'recon_live_match_state_v2';
/* Seeded lobby used by the website preview (see website/src/previewData.ts). */
const PREVIEW_LIVE_MATCH_KEY = 'recon_preview_live_match';
const LAST_ACTIVE_MATCH_KEY = 'recon_last_active_match_v1';
/** A stored lobby older than this is never shown as "previous match". */
const LAST_ACTIVE_TTL_MS = 6 * 60 * 60 * 1000;
/** Key of the match whose round sequence is tracked (old keys are deleted). */
let lastRoundSeqMatchId = '';
const isLastActiveFresh = (s: LiveMatchState | null): s is LiveMatchState =>
  !!s && Date.now() - (s.updatedAt ?? 0) < LAST_ACTIVE_TTL_MS;
let lastLiveMatchFetchTime = 0;
let lastLiveMatchResult: LiveMatchState | null = null;
let lastActiveMatchState: LiveMatchState | null = null;
/** Shared by concurrent pollers so overlapping polls run one fetch, not three. */
let liveMatchInflight: Promise<LiveMatchState> | null = null;
/** Fetch-starter sequence — lets superseded executions adopt the newest result. */
let liveMatchIssue = 0;
/** Monotonic execution id — only the newest fetch may persist shared state. */
let liveMatchSeq = 0;

/** Returns the last completed/active match so the UI stays populated while waiting in queue. */
export function getLastActiveMatch(): LiveMatchState | null {
  if (lastActiveMatchState && !isLastActiveFresh(lastActiveMatchState)) {
    lastActiveMatchState = null;
  }
  if (lastActiveMatchState && (lastActiveMatchState.blueTeam.length > 0 || lastActiveMatchState.redTeam.length > 0)) {
    return healMapName(lastActiveMatchState);
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(LAST_ACTIVE_MATCH_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as LiveMatchState;
        if (parsed && (parsed.blueTeam?.length > 0 || parsed.redTeam?.length > 0)) {
          if (!isLastActiveFresh(parsed)) {
            localStorage.removeItem(LAST_ACTIVE_MATCH_KEY);
            return null;
          }
          lastActiveMatchState = parsed;
          return healMapName(parsed);
        }
      }
    } catch {}
  }
  return null;
}

/**
 * Synchronous best-known lobby snapshot, with no awaiting.
 *
 * A view seeds its initial render from this so the first paint already shows the
 * lobby it knows about, instead of flashing the "Waiting for Valorant Match"
 * empty state while the first fetch resolves.
 */
export function peekLiveMatchState(): LiveMatchState | null {
  if (lastLiveMatchResult?.phase && lastLiveMatchResult.phase !== 'idle') {
    return healMapName(lastLiveMatchResult);
  }
  if (typeof localStorage === 'undefined') return null;

  /* The browser preview writes its own key; the desktop app persists a cached
     payload under a different one. */
  const key = isTauri() ? LIVE_MATCH_CACHE_KEY : PREVIEW_LIVE_MATCH_KEY;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: LiveMatchState } & LiveMatchState;
    const state = key === LIVE_MATCH_CACHE_KEY ? parsed?.state : parsed;
    if (state?.phase && state.phase !== 'idle') {
      lastLiveMatchResult = state;
      return healMapName(state);
    }
  } catch {}

  // Keep last match visible while in queue so screen is never empty
  const lastActive = getLastActiveMatch();
  if (lastActive) {
    return { ...lastActive, isPreviousMatch: true };
  }

  return null;
}

/**
 * Live-match entry point shared by every poller (overlay, LiveMatchView,
 * focus/visibility handlers, global refresh).
 *
 * Concurrent callers share one in-flight fetch, and a monotonic sequence
 * guards the shared writes — a slow poll N can neither fork duplicate Riot
 * traffic nor overwrite a fresh poll N+1's teams/scores in memory,
 * localStorage, or the cross-window event.
 */
export function fetchLiveMatchState(regionOverride?: string, forceRefresh = false): Promise<LiveMatchState> {
  const devMock = getDevMockMatch();
  if (devMock) return Promise.resolve(devMock);
  if (!forceRefresh && liveMatchInflight) {
    // Sharer: hand back whatever is newest when this resolves — never a
    // stale intermediate result.
    const shared = liveMatchInflight;
    return shared.then((s) => {
      const cur = liveMatchInflight;
      return cur && cur !== shared ? cur : s;
    });
  }
  const task = fetchLiveMatchStateInner(regionOverride, forceRefresh);
  const myIssue = ++liveMatchIssue;
  liveMatchInflight = task;
  task.then(
    () => {
      if (liveMatchInflight === task) liveMatchInflight = null;
    },
    () => {
      if (liveMatchInflight === task) liveMatchInflight = null;
    }
  );
  // Adopt-newest: if a newer fetch started while this one ran, hand back the
  // newest result instead of flashing stale data for a frame. Overlapping
  // executions (interval poll vs manual refresh vs focus handler) used to
  // resolve out of order — live, then idle — which is the match↔waiting flicker.
  return task.then((s) => {
    if (myIssue !== liveMatchIssue && liveMatchInflight && liveMatchInflight !== task) {
      return liveMatchInflight;
    }
    return s;
  });
}

async function fetchLiveMatchStateInner(regionOverride?: string, forceRefresh = false): Promise<LiveMatchState> {
  // Dev dashboard simulator: canned match without Riot open (dev builds only).
  const devMock = getDevMockMatch();
  if (devMock) return devMock;
  // Newest-wins token for the shared writes at the end of this fetch.
  const mySeq = ++liveMatchSeq;

  const now = Date.now();
  if (!forceRefresh) {
    if (lastLiveMatchResult && now - lastLiveMatchFetchTime < 2500) {
      return healMapName(lastLiveMatchResult);
    }
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(LIVE_MATCH_CACHE_KEY);
        if (raw) {
          const item = JSON.parse(raw) as { at: number; state: LiveMatchState };
          if (item?.state && now - item.at < 2500) {
            lastLiveMatchResult = item.state;
            lastLiveMatchFetchTime = item.at;
            return healMapName(item.state);
          }
        }
      } catch {}
    }
  }

  const idleState: LiveMatchState = {
    phase: 'idle',
    matchId: '',
    mapId: '',
    mapName: 'No Match Active',
    mode: '',
    isDeathmatch: false,
    blueTeam: [],
    redTeam: [],
    updatedAt: Date.now(),
  };

  /* Website preview: there is no local Riot client to interrogate, so serve the
     seeded preview lobby instead of an empty idle state. Deliberately the same
     shape as the live payload so every downstream component (player tables,
     party grouping, unmask badges) renders for real. */
  if (!isTauri()) {
    try {
      const raw = localStorage.getItem(PREVIEW_LIVE_MATCH_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as LiveMatchState;
        if (parsed?.phase && parsed.phase !== 'idle') {
          lastLiveMatchResult = parsed;
          lastLiveMatchFetchTime = now;
          return healMapName(parsed);
        }
      }
    } catch {}
    return idleState;
  }

  try {
    const ent = await getEntitlements();
    if (!ent.puuid) return idleState;

    const region = regionOverride || (await detectRegion());
    const glz = glzHostFor(region);
    const shard = shardFor(region);
    const data = await gameData();
    // Queue being played — scopes the per-player 24h record to the same mode.
    const liveQueue = await fetchLiveQueueId();

    let phase: 'idle' | 'pregame' | 'coregame' = 'idle';
    let matchId = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchData: any = null;

    // 1. Check Coregame (in-match)
    try {
      const corePlayer = await riotGet(glz, `/core-game/v1/players/${ent.puuid}`).catch(() =>
        riotGet(glz, `/coregame/v1/players/${ent.puuid}`)
      );
      if (corePlayer?.MatchID) {
        matchId = corePlayer.MatchID;
        matchData = await riotGet(glz, `/core-game/v1/matches/${matchId}`).catch(() =>
          riotGet(glz, `/coregame/v1/matches/${matchId}`)
        );
        if (matchData && !matchData.httpStatus) {
          phase = 'coregame';
        }
      }
    } catch {}

    // 2. Check Pregame (agent select) if not in coregame
    if (phase === 'idle') {
      try {
        const prePlayer = await riotGet(glz, `/pregame/v1/players/${ent.puuid}`);
        if (prePlayer?.MatchID) {
          matchId = prePlayer.MatchID;
          matchData = await riotGet(glz, `/pregame/v1/matches/${matchId}`);
          if (matchData && !matchData.httpStatus) {
            phase = 'pregame';
            // Safe Agent Pre-Picker: safely hover preferred agent once per match
            import('./prepick').then((m) => m.trySafePrepick(matchId, region, matchData?.MapID)).catch(() => {});
          }
        }
      } catch {}
    }

    if (phase === 'idle' || !matchData) {
      import('./prepick').then((m) => m.resetPrepickLatch()).catch(() => {});
      // If we were previously in a live match or agent select, verify local presence before declaring idle.
      // This prevents mid-game session loss caused by transient Riot cloud gateway blips or token re-auth.
      if (lastLiveMatchResult && lastLiveMatchResult.phase !== 'idle') {
        try {
          const rawPres = await invoke<string>('local_presences');
          const presData = JSON.parse(rawPres);
          const presencesList = Array.isArray(presData?.presences) ? presData.presences : [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const me = presencesList.find(
            (p: any) => String(p?.puuid || p?.pid?.split?.('@')?.[0] || '').toLowerCase() === ent.puuid.toLowerCase()
          );
          if (me?.private) {
            const blob = JSON.parse(decodeBase64Utf8(String(me.private)));
            const loop = String(blob?.matchPresenceData?.sessionLoopState ?? blob?.sessionLoopState ?? '').toUpperCase();
            if (loop === 'INGAME' || loop === 'PREGAME') {
              clearEntitlements();
              const freshEnt = await getEntitlements();
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const retryPlayer: any = await riotGet(
                glz,
                loop === 'INGAME' ? `/core-game/v1/players/${freshEnt.puuid}` : `/pregame/v1/players/${freshEnt.puuid}`
              ).catch(() => null);
              if (retryPlayer?.MatchID) {
                matchId = retryPlayer.MatchID;
                matchData = await riotGet(
                  glz,
                  loop === 'INGAME' ? `/core-game/v1/matches/${matchId}` : `/pregame/v1/matches/${matchId}`
                ).catch(() => null);
                if (matchData && !matchData.httpStatus) {
                  phase = loop === 'INGAME' ? 'coregame' : 'pregame';
                }
              }
              if (phase === 'idle' || !matchData) {
                // Game client is still INGAME/PREGAME; transient Riot cloud hiccup: preserve live match state!
                // (Widened read: the outer guard already narrowed `.phase`, so a
                // direct `=== 'idle'` comparison won't compile.)
                const prevPhase: string = lastLiveMatchResult?.phase ?? 'idle';
                if (!lastLiveMatchResult || prevPhase === 'idle') return idleState;
                return healMapName({ ...lastLiveMatchResult, updatedAt: Date.now() });
              }
            }
          }
        } catch {}
      }

      return idleState;
    }

    // Extract live party mappings from local presence chat (checks puuid, pid, private, packedData, and parties)
    const presencePartyMap = new Map<string, string>(); // puuid (lowercase) -> partyId (lowercase)
    const presenceNameMap = new Map<string, { name: string; tag: string }>(); // puuid (lowercase) -> live Riot ID (fallback when name-service is rate-limited)
    let liveAllyScore = 0;
    let liveEnemyScore = 0;
    try {
      if (isTauri()) {
        const rawPres = await invoke<string>('local_presences');
        const presData = JSON.parse(rawPres);
        const presencesList = Array.isArray(presData?.presences) ? presData.presences : [];
        for (const pr of presencesList) {
          const pU = String(pr?.puuid || pr?.pid?.split?.('@')?.[0] || '').toLowerCase().trim();
          if (!pU) continue;

          // Live Riot ID fallback: presences carry the real game_name/tag
          // even when the player hides their name in-game.
          const presName = String(pr?.game_name ?? pr?.gameName ?? '').trim();
          const presTag = String(pr?.game_tag ?? pr?.gameTag ?? '').trim();
          if (presName && !presenceNameMap.get(pU)?.name) {
            presenceNameMap.set(pU, { name: presName, tag: presTag });
          }

          let pId = '';

          // 1. Check pr.private payload
          if (pr.private) {
            try {
              const blob = JSON.parse(decodeBase64Utf8(String(pr.private)));
              pId = String(
                blob?.partyId ||
                blob?.partyPresenceData?.partyId ||
                ''
              ).toLowerCase().trim();

              if (pU === ent.puuid.toLowerCase()) {
                liveAllyScore = Number(blob?.partyOwnerMatchScoreAllyTeam ?? blob?.partyPresenceData?.partyOwnerMatchScoreAllyTeam ?? 0);
                liveEnemyScore = Number(blob?.partyOwnerMatchScoreEnemyTeam ?? blob?.partyPresenceData?.partyOwnerMatchScoreEnemyTeam ?? 0);
              }
            } catch {}
          }

          // 2. Check pr.packedData payload
          if (!pId && pr.packedData) {
            try {
              const packedBlob = JSON.parse(decodeBase64Utf8(String(pr.packedData)));
              const rawId = String(packedBlob?.party?.id || '');
              pId = rawId.replace(/^.*party:valorant:/i, '').toLowerCase().trim();
            } catch {}
          }

          // 3. Check pr.parties array
          if (!pId && Array.isArray(pr.parties) && pr.parties[0]?.partyId) {
            pId = String(pr.parties[0].partyId).toLowerCase().trim();
          }

          if (pId && pId !== '0' && pId !== 'null' && pId !== 'undefined' && pId.length > 5) {
            presencePartyMap.set(pU, pId);
          }
        }
      }
    } catch {}

    interface RawPlayer {
      puuid: string;
      team: 'Blue' | 'Red';
      characterId: string;
      accountLevel: number;
      cardId: string;
      selectionState?: string;
      isIncognito?: boolean;
      partyId?: string;
    }

    const rawPlayers: RawPlayer[] = [];

    if (phase === 'coregame' && Array.isArray(matchData.Players)) {
      for (const p of matchData.Players) {
        const sub = String(p.Subject || '').toLowerCase();
        const directParty = String(p.partyId || p.PartyId || p.PartyID || p.PlayerIdentity?.partyId || p.PlayerIdentity?.PartyId || p.PlayerIdentity?.PartyID || '').toLowerCase().trim();
        rawPlayers.push({
          puuid: p.Subject,
          team: p.TeamID === 'Red' ? 'Red' : 'Blue',
          characterId: p.CharacterID || '',
          accountLevel: p.PlayerIdentity?.AccountLevel || 0,
          cardId: p.PlayerIdentity?.PlayerCardID || '',
          isIncognito: !!(p.PlayerIdentity?.Incognito),
          partyId: directParty || presencePartyMap.get(sub),
        });
      }
    } else if (phase === 'pregame') {
      if (Array.isArray(matchData.Teams)) {
        for (const t of matchData.Teams) {
          const tId = (t.TeamID === 'Red' || t.TeamID === 'TeamTwo') ? 'Red' : 'Blue';
          for (const p of t.Players || []) {
            const sub = String(p.Subject || '').toLowerCase();
            const directParty = String(p.partyId || p.PartyId || p.PartyID || p.PlayerIdentity?.partyId || p.PlayerIdentity?.PartyId || p.PlayerIdentity?.PartyID || '').toLowerCase().trim();
            rawPlayers.push({
              puuid: p.Subject,
              team: tId,
              characterId: p.CharacterID || '',
              accountLevel: p.PlayerIdentity?.AccountLevel || 0,
              cardId: p.PlayerIdentity?.PlayerCardID || '',
              selectionState: p.CharacterSelectionState || '',
              isIncognito: !!(p.PlayerIdentity?.Incognito),
              partyId: directParty || presencePartyMap.get(sub),
            });
          }
        }
      }
      // Pregame AllyTeam
      if (Array.isArray(matchData.AllyTeam?.Players)) {
        const allyTeamId = (matchData.AllyTeam.TeamID === 'Red' || matchData.AllyTeam.TeamID === 'TeamTwo') ? 'Red' : 'Blue';
        for (const p of matchData.AllyTeam.Players) {
          if (!rawPlayers.some((rp) => rp.puuid === p.Subject)) {
            const sub = String(p.Subject || '').toLowerCase();
            const directParty = String(p.partyId || p.PartyId || p.PartyID || p.PlayerIdentity?.partyId || p.PlayerIdentity?.PartyId || p.PlayerIdentity?.PartyID || '').toLowerCase().trim();
            rawPlayers.push({
              puuid: p.Subject,
              team: allyTeamId,
              characterId: p.CharacterID || '',
              accountLevel: p.PlayerIdentity?.AccountLevel || 0,
              cardId: p.PlayerIdentity?.PlayerCardID || '',
              selectionState: p.CharacterSelectionState || '',
              isIncognito: !!(p.PlayerIdentity?.Incognito),
              partyId: directParty || presencePartyMap.get(sub),
            });
          }
        }
      }
      // Pregame EnemyTeam (populated in custom games!)
      if (Array.isArray(matchData.EnemyTeam?.Players)) {
        const enemyTeamId = (matchData.EnemyTeam.TeamID === 'Red' || matchData.EnemyTeam.TeamID === 'TeamTwo') ? 'Red' : 'Blue';
        for (const p of matchData.EnemyTeam.Players) {
          if (!rawPlayers.some((rp) => rp.puuid === p.Subject)) {
            const sub = String(p.Subject || '').toLowerCase();
            const directParty = String(p.partyId || p.PartyId || p.PartyID || p.PlayerIdentity?.partyId || p.PlayerIdentity?.PartyId || p.PlayerIdentity?.PartyID || '').toLowerCase().trim();
            rawPlayers.push({
              puuid: p.Subject,
              team: enemyTeamId,
              characterId: p.CharacterID || '',
              accountLevel: p.PlayerIdentity?.AccountLevel || 0,
              cardId: p.PlayerIdentity?.PlayerCardID || '',
              selectionState: p.CharacterSelectionState || '',
              isIncognito: !!(p.PlayerIdentity?.Incognito),
              partyId: directParty || presencePartyMap.get(sub),
            });
          }
        }
      }
    }

    const puuids = rawPlayers.map((p) => p.puuid).filter(Boolean);
    const nameMap = await resolvePlayerNames(puuids, region);
    // Remember live presence names too — friends stay unmasked permanently.
    try {
      rememberPlayerNames(
        [...presenceNameMap.entries()].map(([puuid, v]) => ({ puuid, name: v.name, tag: v.tag }))
      );
    } catch {}

    // Fetch MMRs only for players not already cached within the last 15 minutes
    const mmrMap = new Map<
      string,
      {
        tier: number;
        rr: number;
        peakTier: number;
        peakSeasonId?: string;
        actWins?: number;
        actGames?: number;
        leaderboardRank?: number;
        isRankHidden?: boolean;
      }
    >();
    const missingMmr = puuids.filter((p) => {
      const pU = p.toLowerCase();
      // Prune stale entries so one map per player cannot grow without bound
      // across matches.
      if (liveMmrCache.size > 150) {
        const cutoff = Date.now() - MMR_TTL_MS;
        for (const [k, v] of liveMmrCache) {
          if (v.fetchedAt < cutoff) liveMmrCache.delete(k);
        }
      }
      const cached = liveMmrCache.get(p) ?? liveMmrCache.get(pU);
      if (cached) {
        // A failed entry backs off briefly; a resolved rank is good for the
        // session, so one transient blip can no longer blank a lobby for 15min.
        const ttl = cached.retryAfter ? MMR_RETRY_MS : MMR_TTL_MS;
        if (Date.now() - cached.fetchedAt < ttl) {
          mmrMap.set(p, cached);
          mmrMap.set(pU, cached);
          return false;
        }
      }
      return true;
    });

    if (missingMmr.length > 0) {
      // Chunk in groups of 4 to avoid spawning 12 curl processes at the exact same instant
      for (let i = 0; i < missingMmr.length; i += 4) {
        const batch = missingMmr.slice(i, i + 4);
        await Promise.all(
          batch.map(async (p) => {
            try {
              const j = await riotGet(shard, `/mmr/v1/players/${p}`);
              const latest = j?.LatestCompetitiveUpdate ?? {};
              const tierId = Number(latest?.TierAfterUpdate ?? 0);
              const seasons = j?.QueueSkills?.competitive?.SeasonalInfoBySeasonID ?? {};
              // Current-act row carries the LIVE RR; LatestCompetitiveUpdate only
              // holds the value as of the last ranked game.
              const curSeasonId = String(latest?.SeasonID ?? '').toLowerCase();
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const cur = (Object.entries(seasons) as [string, any][]).find(
                ([id]) => id.toLowerCase() === curSeasonId
              )?.[1];
              const rr =
                cur?.RankedRating != null
                  ? Number(cur.RankedRating)
                  : Number(latest?.RankedRatingAfterUpdate ?? 0);
              const peakInfo = extractPeakInfo(seasons, data.seasonOrder || []);
              const peak = Math.max(tierId, peakInfo.tier);
              const val = {
                tier: tierId,
                rr,
                peakTier: peak,
                peakSeasonId: peak === tierId && tierId > 0 ? curSeasonId : peakInfo.seasonId,
                actWins: Number(cur?.NumberOfWins ?? 0),
                actGames: Number(cur?.NumberOfGames ?? 0),
                leaderboardRank: Number(cur?.LeaderboardRank ?? 0),
                isRankHidden: !!j?.IsActRankBadgeHidden,
                fetchedAt: Date.now(),
              };
              liveMmrCache.set(p, val);
              liveMmrCache.set(p.toLowerCase(), val);
              mmrMap.set(p, val);
              mmrMap.set(p.toLowerCase(), val);
            } catch {
              // A failed lookup must NEVER erase a rank we already know. Writing
              // tier 0 here (and stamping fetchedAt) is what made ranks flicker:
              // the failure was cached as "no rank" and the TTL then held that
              // for the full 15 minutes. Keep the last good value, back off
              // briefly, and let the next poll retry.
              const prev =
                liveMmrCache.get(p) ?? liveMmrCache.get(p.toLowerCase()) ?? null;
              const val = prev
                ? { ...prev, fetchedAt: Date.now(), retryAfter: true }
                : { tier: 0, rr: 0, peakTier: 0, fetchedAt: Date.now(), retryAfter: true };
              liveMmrCache.set(p, val);
              liveMmrCache.set(p.toLowerCase(), val);
              mmrMap.set(p, val);
              mmrMap.set(p.toLowerCase(), val);
            }
          })
        );
      }
    }

    const rawMapId = String(matchData.MapID || '').toLowerCase();

    const rawModeId = String(matchData.ModeID || matchData.Mode || '');
    const directQueue = String(
      matchData.QueueID ||
      matchData.MatchmakingData?.QueueID ||
      liveQueue ||
      ''
    ).toLowerCase().trim();

    const rawModeLower = rawModeId.toLowerCase();
    const rawMapLower = rawMapId.toLowerCase();
    const isRange =
      rawMapLower.includes('poveglia') ||
      rawMapLower.includes('range') ||
      rawModeLower.includes('shootingrange') ||
      rawModeLower.includes('practice');

    const mapName = isRange ? 'The Range' : resolveMapName(rawMapId, data.maps);

    const isDeathmatch = !isRange && (rawModeLower.includes('deathmatch') || directQueue.includes('deathmatch'));

    // Strictly resolve exact game mode — never mix Competitive, Unrated, or other modes together
    const modeName = isRange
      ? 'The Range'
      : isDeathmatch
      ? 'Deathmatch'
      : directQueue === 'competitive'
      ? 'Competitive'
      : directQueue === 'unrated'
      ? 'Unrated'
      : directQueue === 'swiftplay' || rawModeLower.includes('hurry')
      ? 'Swiftplay'
      : directQueue === 'spikerush' || rawModeLower.includes('onefa')
      ? 'Spike Rush'
      : directQueue === 'premier'
      ? 'Premier'
      : directQueue === 'ggteam'
      ? 'Escalation'
      : directQueue === 'custom' || rawModeLower.includes('custom')
      ? 'Custom Game'
      : directQueue
      ? directQueue.charAt(0).toUpperCase() + directQueue.slice(1)
      : 'Custom Game';

    const blueTeam: LiveMatchPlayer[] = [];
    const redTeam: LiveMatchPlayer[] = [];

    // Cross-reference recent matches + presence to accurately detect parties across ALL players (same proven algorithm as Tracker.gg)
    const playerMatchesMap = new Map<string, string[]>();
    await mapLimit(rawPlayers, 4, async (rp) => {
      const pU = rp.puuid.toLowerCase();
      const cached = livePlayerRecentMatchesCache.get(pU);
      if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) {
        playerMatchesMap.set(pU, cached.matches);
        return;
      }
      try {
        const j = await riotGet(
          shardFor(region),
          `/match-history/v1/history/${rp.puuid}?startIndex=0&endIndex=5`
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = (Array.isArray(j?.History) ? j.History : []).map((h: any) => String(h?.MatchID ?? '').toLowerCase()).filter(Boolean);
        livePlayerRecentMatchesCache.set(pU, { matches: rows, fetchedAt: Date.now() });
        playerMatchesMap.set(pU, rows);
      } catch {}
    });

    // Disjoint Set Union (DSU) to group players into party clusters
    const parentMap = new Map<string, string>();
    const findRoot = (id: string): string => {
      let root = id;
      while (parentMap.has(root) && parentMap.get(root) !== root) {
        root = parentMap.get(root)!;
      }
      let curr = id;
      while (curr !== root) {
        const next = parentMap.get(curr) ?? root;
        parentMap.set(curr, root);
        curr = next;
      }
      return root;
    };
    const unionPlayers = (a: string, b: string) => {
      const rootA = findRoot(a);
      const rootB = findRoot(b);
      if (rootA !== rootB) {
        parentMap.set(rootB, rootA);
      }
    };

    // Initialize each player as their own parent
    for (const rp of rawPlayers) {
      const pU = rp.puuid.toLowerCase();
      parentMap.set(pU, pU);
    }

    // 1. Union players sharing identical Riot presence partyId
    const presenceGroups = new Map<string, string[]>();
    for (const rp of rawPlayers) {
      const pU = rp.puuid.toLowerCase();
      const pId = (rp.partyId || presencePartyMap.get(pU) || '').toLowerCase().trim();
      if (pId && pId !== '0' && pId !== 'null' && pId !== 'undefined' && pId.length > 5) {
        const list = presenceGroups.get(pId) || [];
        list.push(pU);
        presenceGroups.set(pId, list);
      }
    }
    for (const members of presenceGroups.values()) {
      for (let i = 1; i < members.length; i++) {
        unionPlayers(members[0], members[i]);
      }
    }

    // 2. Union players sharing recent matches (Tracker.gg match prediction algorithm).
    // Require 2+ shared past matches: a single shared match is usually a
    // requeue echo (Valorant requeues the same lobby), not a real party.
    // Presence unions above stay as-is — a live partyId is certain.
    const currentMatchIdLower = String(matchId || '').toLowerCase().trim();
    for (let i = 0; i < rawPlayers.length; i++) {
      const uA = rawPlayers[i].puuid.toLowerCase();
      const matchesA = playerMatchesMap.get(uA) || [];
      for (let j = i + 1; j < rawPlayers.length; j++) {
        const uB = rawPlayers[j].puuid.toLowerCase();
        const matchesB = playerMatchesMap.get(uB) || [];
        let sharedCount = 0;
        for (const mA of matchesA) {
          if (mA && mA !== currentMatchIdLower && matchesB.includes(mA)) {
            sharedCount++;
            if (sharedCount >= 2) break;
          }
        }
        if (sharedCount >= 2) {
          unionPlayers(uA, uB);
        }
      }
    }

    // Group players by connected root
    const clusters = new Map<string, string[]>();
    for (const rp of rawPlayers) {
      const pU = rp.puuid.toLowerCase();
      const root = findRoot(pU);
      const list = clusters.get(root) || [];
      list.push(pU);
      clusters.set(root, list);
    }

    // Filter and sort genuine parties (2-5 players) deterministically
    const validClusters: string[][] = [];
    for (const members of clusters.values()) {
      if (members.length >= 2 && members.length <= 5) {
        members.sort(); // Canonical internal sorting
        validClusters.push(members);
      }
    }
    // Sort all clusters by their primary member PUUID so order never flips
    validClusters.sort((a, b) => a[0].localeCompare(b[0]));

    // Match-scoped cache so party indices stay 100% static for the match duration.
    // Pregame and core-game IDs live in different namespaces, so the raw key
    // changes mid-match — carry indices over instead of resetting (pruning
    // players who left), so party colors survive agent select → match start.
    const currentMatchKey = String(matchId || phase || 'current').toLowerCase().trim();
    if (activePartyMatchKey !== currentMatchKey) {
      activePartyMatchKey = currentMatchKey;
      const present = new Set(rawPlayers.map((rp) => rp.puuid.toLowerCase()));
      for (const k of [...matchPartyIndexMap.keys()]) {
        if (!present.has(k)) matchPartyIndexMap.delete(k);
      }
      if (matchPartyIndexMap.size === 0) nextMatchPartyIndex = 1;
    }

    const playerPartyIndexMap = new Map<string, number>();
    const playerPartyIdMap = new Map<string, string>();

    for (const members of validClusters) {
      // If any player in this party already has an index assigned in this match, reuse it
      let pIdx = members.reduce<number | undefined>((found, m) => found ?? matchPartyIndexMap.get(m), undefined);
      if (!pIdx) {
        pIdx = nextMatchPartyIndex++;
      }
      const canonicalRoot = members[0];
      for (const m of members) {
        matchPartyIndexMap.set(m, pIdx);
        playerPartyIndexMap.set(m, pIdx);
        playerPartyIdMap.set(m, `party_${canonicalRoot}`);
      }
    }

    // In Deathmatch / FFA, keep all players in one unified list (blueTeam) without grouping into teams
    rawPlayers.forEach((p, idx) => {
      const pU = p.puuid.toLowerCase();
      const pPartyIndex = playerPartyIndexMap.get(pU);
      const pPartyId = playerPartyIdMap.get(pU) || p.partyId || presencePartyMap.get(pU);
      // Case-insensitive name-service lookup + live presence fallback, so
      // hidden/incognito names resolve mid-game instead of only post-game
      // (match-details carries gameName; pregame/coregame carry PUUID only).
      const resolved = nameMap[p.puuid] ?? nameMap[pU] ?? nameMap[p.puuid.toUpperCase()];
      const presFallback = presenceNameMap.get(pU);
      const realName = resolved?.name || presFallback?.name || '';
      const realTag = resolved?.tag || presFallback?.tag || '';
      const isSelf = pU === ent.puuid.toLowerCase();
      // Latch identity from the previous poll: local presences can hiccup for a
      // poll and must never flip a known Riot ID back to "Player N" (flicker).
      const prevPlayer =
        lastLiveMatchResult?.blueTeam.find((bp) => bp.puuid.toLowerCase() === pU) ||
        lastLiveMatchResult?.redTeam.find((rp) => rp.puuid.toLowerCase() === pU);
      const prevHasRealName = !!prevPlayer && !!prevPlayer.name && !prevPlayer.name.startsWith('Player ');
      // Deterministic placeholder: poll-order indexes (`Player ${idx+1}`) rename
      // the same unknown PUUID whenever Riot reorders rows, which the comparator
      // reads as a change and re-renders every poll. A puuid suffix is stable.
      const anonSuffix = p.puuid.replace(/-/g, '').slice(-4).toUpperCase() || String(idx + 1);
      const name = realName || (prevHasRealName ? prevPlayer!.name : isSelf ? 'You' : `Player ${anonSuffix}`);
      const tag = realName ? realTag : prevHasRealName ? prevPlayer!.tag : '';
      const nameResolved = !!realName || prevHasRealName;

      const mmr =
        mmrMap.get(p.puuid) ||
        mmrMap.get(pU) ||
        (prevPlayer
          ? {
              tier: prevPlayer.tier,
              rr: prevPlayer.rr,
              peakTier: prevPlayer.peakTier,
              peakSeasonId: prevPlayer.peakSeasonId,
              actWins: prevPlayer.actWins,
              actGames: prevPlayer.actGames,
              leaderboardRank: prevPlayer.leaderboardRank,
              isRankHidden: prevPlayer.isRankHidden,
            }
          : { tier: 0, rr: 0, peakTier: 0 });
      const agentRawName = data.agents[p.characterId.toLowerCase()] || '';
      const agentMeta = Object.values(data.agentInfo).find(
        (a) => a.name.toLowerCase() === agentRawName.toLowerCase()
      );

      // Asynchronously fetch TRN stats (KD & country) if not cached
      const statsCached = getCachedLivePlayerStats(p.puuid);
      const needsStats =
        !statsCached ||
        (statsCached.kd == null &&
          statsCached.acs == null &&
          Date.now() > (statsCached.retryAfter ?? 0));

      // Fetch TRN stats (KD & country) for any player with a resolved Riot ID,
      // including unmasked streamer-mode players.
      if (needsStats && realName && realTag && !realName.startsWith('Player ')) {
        const inFlightKey = p.puuid.toLowerCase();
        if (!trnInFlightLive.has(inFlightKey)) {
          trnInFlightLive.add(inFlightKey);
          import('./trn')
            .then(({ fetchTrnActStats, trnCooldownRemainingMs }) => {
              if (trnCooldownRemainingMs() > 0) {
                trnInFlightLive.delete(inFlightKey);
                return;
              }
              fetchTrnActStats(realName, realTag)
                .then((res) => {
                  const realCountry =
                    res?.countryCode &&
                    res.countryCode.length === 2 &&
                    !['EU', 'NA', 'AP', 'KR'].includes(res.countryCode.toUpperCase())
                      ? res.countryCode.toUpperCase()
                      : undefined;

                  const update: Partial<LivePlayerStatsEntry> = {
                    fetchedAt: Date.now(),
                    retryAfter: undefined,
                  };
                  if (realCountry) update.country = realCountry;
                  if (res?.stats?.kd != null) update.kd = Number(res.stats.kd.toFixed(2));
                  if (res?.stats?.winPct != null) update.winPct = Math.round(res.stats.winPct);
                  if (res?.stats?.hsPct != null) update.hsPct = Math.round(res.stats.hsPct);
                  if (res?.stats?.trnScore != null) update.trnScore = Math.round(res.stats.trnScore);
                  if (res?.stats?.acs != null) update.acs = Math.round(res.stats.acs);
                  // If private or no stats found, set short backoff (5 min) so we can retry later
                  if (!res || !res.stats || res.stats.kd == null) {
                    update.retryAfter = Date.now() + 5 * 60 * 1000;
                  }
                  setCachedLivePlayerStats(p.puuid, update);
                })
                .catch(() => {
                  // Align retry with the live cooldown expiry (+2s) so a player
                  // never sleeps through availability; floor 30s for transient errors.
                  const cool = trnCooldownRemainingMs();
                  setCachedLivePlayerStats(p.puuid, {
                    retryAfter: Date.now() + Math.max(30 * 1000, cool + 2000),
                  });
                })
                .finally(() => {
                  trnInFlightLive.delete(inFlightKey);
                });
            })
            .catch(() => {
              trnInFlightLive.delete(inFlightKey);
            });
        }
      }

      // Last-24h record — Riot local history works for ANY puuid, so every
      // player in the lobby gets a real 24-hour win/loss line. Scoped to the
      // queue being played, so a ranked lobby never shows Swiftplay/Deathmatch
      // games in the column.
      const cached24h = getCachedLivePlayerStats(p.puuid);
      const needs24h =
        !cached24h ||
        (cached24h.recentWon == null &&
          cached24h.recentLost == null &&
          Date.now() > (cached24h.retryAfter ?? 0)) ||
        Date.now() - (cached24h?.recFetchedAt ?? 0) > 10 * 60 * 1000;

      if (needs24h) {
        fetchPlayer24hRecord(p.puuid, region, liveQueue)
          .then((rec) => {
            const prev = getCachedLivePlayerStats(p.puuid);
            setCachedLivePlayerStats(p.puuid, {
              ...prev,
              recentWon: rec.won,
              recentLost: rec.lost,
              streak: rec.streak,
              streakIsWin: rec.streakIsWin,
              recFetchedAt: Date.now(),
            });
          })
          .catch(() => {});
      }

      const targetTeam = isDeathmatch ? 'Blue' : p.team;
      const playerStats = getCachedLivePlayerStats(p.puuid);

      // Latch remaining TRN fields from previous state — data must STICK and never flicker

      const resolvedCountry = playerStats?.country || prevPlayer?.country;
      const resolvedKd = playerStats?.kd ?? prevPlayer?.kd;
      const resolvedWinPct = playerStats?.winPct ?? prevPlayer?.winPct;
      const resolvedHsPct = playerStats?.hsPct ?? prevPlayer?.hsPct;
      const resolvedTrnScore = playerStats?.trnScore ?? prevPlayer?.trnScore;
      const resolvedAcs = playerStats?.acs ?? prevPlayer?.acs;
      const resolvedRecentWon = playerStats?.recentWon ?? prevPlayer?.recentWon;
      const resolvedRecentLost = playerStats?.recentLost ?? prevPlayer?.recentLost;
      const resolvedStreak = playerStats?.streak ?? prevPlayer?.streak;
      const resolvedStreakIsWin = playerStats?.streakIsWin ?? prevPlayer?.streakIsWin;

      const playerObj: LiveMatchPlayer = {
        puuid: p.puuid,
        name,
        tag,
        team: targetTeam,
        agentId: p.characterId,
        agentName: agentRawName || 'Selecting…',
        agentIcon: agentMeta?.icon || '',
        agentRole: agentMeta?.role || '',
        tier: mmr.tier,
        rank: tierName(mmr.tier),
        rr: mmr.rr,
        peakTier: mmr.peakTier,
        peakRank: mmr.peakTier > 0 ? tierName(mmr.peakTier) : '—',
        peakSeasonId: mmr.peakSeasonId,
        actWins: mmr.actWins,
        actGames: mmr.actGames,
        leaderboardRank: mmr.leaderboardRank,
        isRankHidden: mmr.isRankHidden,
        accountLevel: p.accountLevel,
        cardId: p.cardId,
        isMe: p.puuid.toLowerCase() === ent.puuid.toLowerCase() || prevPlayer?.isMe === true,
        selectionState: p.selectionState,
        region: region.toUpperCase(),
        country: resolvedCountry,
        kd: resolvedKd,
        winPct: resolvedWinPct,
        hsPct: resolvedHsPct,
        trnScore: resolvedTrnScore,
        acs: resolvedAcs,
        recentWon: resolvedRecentWon,
        recentLost: resolvedRecentLost,
        streak: resolvedStreak,
        streakIsWin: resolvedStreakIsWin,
        isIncognito: p.isIncognito ?? false,
        nameResolved,
        partyId: pPartyId,
        partyIndex: pPartyIndex,
      };

      if (targetTeam === 'Blue') {
        blueTeam.push(playerObj);
      } else {
        redTeam.push(playerObj);
      }
    });

    const startingSide = matchData.AllyTeam?.TeamID === 'Red'
      ? 'Attack'
      : matchData.AllyTeam?.TeamID === 'Blue'
      ? 'Defense'
      : undefined;

    const finalState: LiveMatchState = {
      phase,
      matchId,
      mapId: rawMapId,
      mapName,
      mode: modeName,
      isDeathmatch,
      isRange,
      queueId: isRange ? '' : liveQueue,
      startingSide,
      allyScore: liveAllyScore,
      enemyScore: liveEnemyScore,
      blueTeam,
      redTeam,
      updatedAt: Date.now(),
    };

    // A superseded poll must not overwrite fresher data a newer execution
    // already persisted — newest execution wins.
    const isNewest = mySeq === liveMatchSeq;
    if (isNewest && finalState.phase !== 'idle' && (finalState.blueTeam.length > 0 || finalState.redTeam.length > 0)) {
      lastActiveMatchState = finalState;
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(LAST_ACTIVE_MATCH_KEY, JSON.stringify(finalState));
        } catch {}
      }
    }

    // Background score progression sequence tracker. Old match keys are
    // deleted on match change so one key per matchId cannot accumulate forever.
    if (typeof localStorage !== 'undefined' && matchId) {
      try {
        if (lastRoundSeqMatchId && lastRoundSeqMatchId !== matchId) {
          localStorage.removeItem(`recon_live_round_seq_${lastRoundSeqMatchId}`);
        }
        lastRoundSeqMatchId = matchId;
        const roundSeqKey = `recon_live_round_seq_${matchId}`;
        const rawSeq = localStorage.getItem(roundSeqKey);
        let seqData: { ally: number; enemy: number; history: boolean[] } = rawSeq
          ? JSON.parse(rawSeq)
          : { ally: 0, enemy: 0, history: [] };

        if (liveAllyScore === 0 && liveEnemyScore === 0) {
          // Write the reset once — every 0-0 poll rewriting it is pure thrash.
          if (!rawSeq) localStorage.setItem(roundSeqKey, JSON.stringify(seqData));
        } else {
          if (liveAllyScore > seqData.ally) {
            const diff = liveAllyScore - seqData.ally;
            for (let i = 0; i < diff; i++) seqData.history.push(true);
            seqData.ally = liveAllyScore;
          }
          if (liveEnemyScore > seqData.enemy) {
            const diff = liveEnemyScore - seqData.enemy;
            for (let i = 0; i < diff; i++) seqData.history.push(false);
            seqData.enemy = liveEnemyScore;
          }
          if (seqData.history.length > 200) seqData.history = seqData.history.slice(-200);
          localStorage.setItem(roundSeqKey, JSON.stringify(seqData));
        }
      } catch {}
    }

    if (isNewest) {
      lastLiveMatchResult = finalState;
      lastLiveMatchFetchTime = Date.now();
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(
            LIVE_MATCH_CACHE_KEY,
            JSON.stringify({ at: lastLiveMatchFetchTime, state: finalState })
          );
        } catch {}
      }

      // Broadcast across windows via Tauri event
      if (isTauri()) {
        emit('recon:live-match-sync', finalState).catch(() => {});
      }
    }

    return finalState;
  } catch (err) {
    return {
      ...idleState,
      error: String(err),
    };
  }
}
