/* Riot local client — the authoritative source.
 *
 * Design: docs/architecture/design-data-layer.md §2, step 1. The rule this file
 * enforces is the fix for bug class (a): its raw transport is private, so no
 * caller can obtain an unvalidated response from HERE, and every parser it owns
 * accepts `Validated<T>`, a branded type nothing outside this module can mint.
 *
 * SINGLE OWNER, and the claim is checked, not trusted:
 * this module is the ONLY place a raw payload exists: tracker makes 0 raw `riotGet` calls
 * (checked against the source), the temporary export is gone, and `riotGet` is private
 * again. The assertion in scripts/devqa-check.ts compares the number in this
 * paragraph to the real call-site count and requires the exclusivity claim to
 * hold while it is zero — so the count and this paragraph cannot drift apart. */

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../utils/ipc';
import { gameData } from './gameData';
import { logger } from '../utils/logger';

declare const VALIDATED: unique symbol;
/** Proof that a payload passed the reader's own checks. Only this module can
 *  mint one, which is why a parser cannot be handed a raw response. */
export type Validated<T> = T & { readonly [VALIDATED]: true };

/** Mint a validated value. Module-private by design — do not export. */
function validated<T>(value: T): Validated<T> {
  return value as Validated<T>;
}

/**
 * Riot answered 404 — "nothing here", not "the read failed". Returned only by
 * by-id lookups; every other error status (403/451/5xx) throws. The alias puts
 * the contract in the signature: a caller that gets `null` retries or reports
 * "no match", a caller that gets a throw reports a failed read.
 */
export type NoMatch<T> = Validated<T> | null;

/* ------------------------------------------------------------------ *
 * Status seam
 * ------------------------------------------------------------------ */
export type RiotClientStatus = 'ok' | 'locked-out' | 'crashed' | 'not-running';

let onStatus: (status: RiotClientStatus, detail?: string) => void = () => {};
let onClassify: (e: unknown) => RiotClientStatus | null = () => null;

/** Wire the tracker's status store into this module. Called once. */
export function initRiotSource(hooks: {
  onStatus?: (status: RiotClientStatus, detail?: string) => void;
  onClassify?: (e: unknown) => RiotClientStatus | null;
}): void {
  if (hooks.onStatus) onStatus = hooks.onStatus;
  if (hooks.onClassify) onClassify = hooks.onClassify;
}

/* ------------------------------------------------------------------ *
 * Transport (private)
 * ------------------------------------------------------------------ */

export const platformBlob = (): string => {
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
/* NOT exported (step 1 of the data-layer design): the raw transport is the only
 * way to obtain an unvalidated Riot payload, so it stays inside this module.
 * Validated readers live in src/sources/riot.ts. */
/** Raw GET. PRIVATE: every call site in src/ now goes through a validated
 *  reader, so the only way to obtain an unvalidated payload is inside this
 *  module. A devqa assertion fails if this is ever exported again. */
async function riotGet(host: string, path: string): Promise<any> {
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
      const retried = JSON.parse(await withRiotSlot(async () => call(await getEntitlements())));
      // Still 401/403 after a fresh entitlements read = the session is gone.
      if (retried?.httpStatus === 401 || retried?.httpStatus === 403) {
        onStatus('locked-out', 'Riot Client is logged out');
      } else {
        onStatus('ok');
      }
      return retried;
    }
    // An answered read proves the client is alive and authenticated.
    onStatus('ok');
    return j;
  } catch (e) {
    if (String(e).includes('RIOT_EXPIRED')) {
      clearEntitlements();
      return JSON.parse(await withRiotSlot(async () => call(await getEntitlements())));
    }
    const kind = onClassify(e);
    if (kind) {
      onStatus(
        kind,
        kind === 'locked-out'
          ? 'Riot Client is logged out'
          : kind === 'not-running'
            ? 'Riot Client is not running'
            : 'Riot Client is not responding'
      );
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

export function assertRiotOk(j: any, what: string): void {
  const status = Number(j?.httpStatus ?? 0);
  const code = String(j?.errorCode ?? '');
  if (code || status >= 400) {
    const detail = code || `HTTP ${status}`;
    const msg = String(j?.message ?? '').slice(0, 140);
    throw new Error(
      `Riot ${what} unavailable (${detail})${msg ? ` — ${msg}` : ''}`
    );
  }
}

/** A Riot read that failed. Carries the code so callers can tell a private
 *  profile from a dead client without string-matching. */
export class RiotError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RiotError';
    this.code = code;
  }
}

export interface LocalRank {
  tier: number;
  rr: number;
  peakTier: number;
  peakSeasonId?: string;
  actWins: number;
  actGames: number;
  leaderboardRank: number;
  isRankHidden: boolean;
}

/** Rank for ANY puuid. Validated: a Riot error throws, it never returns tier 0. */
export async function readMmr(
  puuid: string,
  shard: string,
  parse: (j: Validated<unknown>, seasonOrder: string[]) => LocalRank,
  seasonOrder: string[] = []
): Promise<Validated<LocalRank>> {
  if (!puuid) throw new RiotError('NO_PUUID', 'readMmr: puuid is required');
  const j = await riotGet(shard, `/mmr/v1/players/${puuid}`);
  assertRiotOk(j, 'mmr');
  return validated(parse(validated(j), seasonOrder));
}

/** Match details. Validated the same way. */
export async function readMatchDetails<T>(
  matchId: string,
  shard: string,
  parse: (j: Validated<unknown>) => T
): Promise<Validated<T>> {
  if (!matchId) throw new RiotError('NO_MATCH_ID', 'readMatchDetails: matchId is required');
  const j = await riotGet(shard, `/match-details/v1/matches/${matchId}`);
  assertRiotOk(j, 'match details');
  return validated(parse(validated(j)));
}

/** Last-24h win/loss for a puuid, from match history + details. */
export async function readPlayer24h(
  puuid: string,
  shard: string,
  page: (j: Validated<unknown>) => { id: string; at: number; queue: string }[]
): Promise<Validated<{ id: string; at: number; queue: string }[]>> {
  if (!puuid) throw new RiotError('NO_PUUID', 'readPlayer24h: puuid is required');
  const j = await riotGet(shard, `/match-history/v1/history/${puuid}?startIndex=0&endIndex=20`);
  assertRiotOk(j, 'match history');
  return validated(page(validated(j)));
}

/* ------------------------------------------------------------------ *
 * Transport helpers, moved verbatim out of utils/tracker.ts.
 *
 * `shardFor` and `mapLimit` are unambiguously transport/utility. `normTeam` is
 * arguably model code — it moves here now because it unblocks the act-stats
 * split, and if it later looks like model it moves again in its own commit.
 * ------------------------------------------------------------------ */

export const shardFor = (region: string): string =>
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

/** GLZ (live game) host for a region. The transport takes a real hostname —
 *  never a short region or shard name. */
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

/** Run an async mapper over items with a hard concurrency cap. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
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

export const normTeam = (t: unknown): string => {
  const s = String(t ?? '').toLowerCase();
  if (s === 'blue') return 'Blue';
  if (s === 'red') return 'Red';
  return String(t ?? '');
};

/* ------------------------------------------------------------------ *
 * Typed readers for the act-stats cluster (added for the act-stats split).
 * Additive on purpose: nothing calls them yet, so this changes no behaviour.
 * When live/actStats.ts moves out of tracker.ts it will call these instead of
 * the private transport, and THAT switch is the behaviour-changing commit.
 * ------------------------------------------------------------------ */

export interface MatchHistoryRow {
  id: string;
  queue: string;
}

/** A history row with the match start time the 24h record's paging needs. `at`
 *  is `GameStartTime` in epoch ms; 0 means Riot did not report it (the pager
 *  treats that as the oldest possible row). */
export type MatchHistoryTimeRow = MatchHistoryRow & { at: number };

/** Parse one `History[]` page. Private and shared so the plain and timestamped
 *  readers cannot drift. */
function parseHistoryRows(j: unknown): MatchHistoryTimeRow[] {
  const h = Array.isArray((j as { History?: unknown[] })?.History)
    ? ((j as { History: Record<string, unknown>[] }).History as Record<string, unknown>[])
    : [];
  return h.map((x) => ({
    id: String(x?.MatchID ?? ''),
    queue: String(x?.QueueID ?? '').toLowerCase().trim(),
    at: Number(x?.GameStartTime ?? 0),
  }));
}

/** One page of match history, validated. Throws RiotError on an error payload. */
export async function readMatchHistoryPage(
  puuid: string,
  region: string,
  start: number,
  end: number
): Promise<Validated<MatchHistoryRow[]>> {
  if (!puuid) throw new RiotError('NO_PUUID', 'readMatchHistoryPage: puuid is required');
  const j = await riotGet(
    region,
    `/match-history/v1/history/${puuid}?startIndex=${start}&endIndex=${end}`
  );
  assertRiotOk(j, 'match history');
  return validated(parseHistoryRows(j).map(({ id, queue }) => ({ id, queue })));
}

/** One page of match history with `GameStartTime`. Validated exactly like
 *  `readMatchHistoryPage`; the timestamp is the only difference. */
export async function readHistoryPageWithTime(
  puuid: string,
  region: string,
  start: number,
  end: number
): Promise<Validated<MatchHistoryTimeRow[]>> {
  if (!puuid) throw new RiotError('NO_PUUID', 'readHistoryPageWithTime: puuid is required');
  const j = await riotGet(
    region,
    `/match-history/v1/history/${puuid}?startIndex=${start}&endIndex=${end}`
  );
  assertRiotOk(j, 'match history');
  return validated(parseHistoryRows(j));
}

/** History page metadata (total rows + per-match queue). Validated: an error
 *  payload throws instead of reporting `total: 0`, which read as "you have no
 *  matches" rather than "we could not ask". */
export async function readHistoryMeta(
  puuid: string,
  region: string,
  start: number,
  count: number
): Promise<Validated<{ total: number; queueById: Record<string, string> }>> {
  if (!puuid) throw new RiotError('NO_PUUID', 'readHistoryMeta: puuid is required');
  const j = await riotGet(
    region,
    `/match-history/v1/history/${puuid}?startIndex=${start}&endIndex=${start + count}`
  );
  assertRiotOk(j, 'match history');
  const queueById: Record<string, string> = {};
  const h = Array.isArray((j as { History?: unknown[] })?.History)
    ? ((j as { History: Record<string, unknown>[] }).History as Record<string, unknown>[])
    : [];
  for (const x of h) {
    const id = String(x?.MatchID ?? '');
    if (id) queueById[id] = String(x?.QueueID ?? '');
  }
  return validated({ total: Number((j as { Total?: number })?.Total ?? 0), queueById });
}

/** Match details, validated, returned raw for the caller's own parser. */
export async function readMatchDetailsRaw(
  matchId: string,
  region: string
): Promise<Validated<Record<string, unknown>>> {
  if (!matchId) throw new RiotError('NO_MATCH_ID', 'readMatchDetailsRaw: matchId is required');
  const j = await riotGet(region, `/match-details/v1/matches/${matchId}`);
  assertRiotOk(j, 'match details');
  return validated(j as Record<string, unknown>);
}

/** Escape hatch for callers that read a Riot endpoint this module has no typed
 *  reader for yet (crosshair preferences, wallet). It still returns
 *  `Validated<unknown>`, so the result is checked before a parser sees it, and
 *  it stays the ONLY way to get a payload out of this module. */
export async function readRiotValidated<T = { data?: unknown; [k: string]: unknown }>(
  host: string,
  path: string
): Promise<Validated<T>> {
  const j = await riotGet(host, path);
  assertRiotOk(j, 'request');
  return validated(j as T);
}

/* ------------------------------------------------------------------ *
 * Step-2 readers: the live-probe and MMR sites that had no typed reader.
 * Additive on purpose — nothing calls them until ts-client swaps.
 * ------------------------------------------------------------------ */

/** GET a by-id Riot resource. 404 is data (`null`); every other error status
 *  throws, so "nothing here" and "we could not ask" stay distinguishable. */
async function riotGetNoMatch(host: string, path: string): Promise<Validated<unknown> | null> {
  const j = await riotGet(host, path);
  if (Number((j as { httpStatus?: number })?.httpStatus ?? 0) === 404) return null;
  assertRiotOk(j, 'request');
  return validated(j as unknown);
}

/** Live player entry for one puuid. `null` = no match (Riot 404). The legacy
 *  `/coregame/` spelling is tried only when the canonical route 404s, so a real
 *  403/451 on the canonical route still throws instead of being masked. */
export async function readLivePlayer(
  phase: 'pregame' | 'coregame',
  puuid: string,
  region: string
): Promise<NoMatch<{ matchId: string }>> {
  if (!puuid) throw new RiotError('NO_PUUID', 'readLivePlayer: puuid is required');
  const host = glzHostFor(region);
  const canonical =
    phase === 'coregame' ? `/core-game/v1/players/${puuid}` : `/pregame/v1/players/${puuid}`;
  let j = await riotGetNoMatch(host, canonical);
  if (j === null && phase === 'coregame') {
    j = await riotGetNoMatch(host, `/coregame/v1/players/${puuid}`);
  }
  if (j === null) return null;
  return validated({ matchId: String((j as { MatchID?: unknown }).MatchID ?? '') });
}

/** Live match payload by id (pregame/coregame). Raw on purpose — typing the
 *  live-match model is separate work. `null` = no such match (404). */
export async function readLiveMatchById(
  phase: 'pregame' | 'coregame',
  matchId: string,
  region: string
): Promise<NoMatch<unknown>> {
  if (!matchId) throw new RiotError('NO_MATCH_ID', 'readLiveMatchById: matchId is required');
  const host = glzHostFor(region);
  const canonical =
    phase === 'coregame' ? `/core-game/v1/matches/${matchId}` : `/pregame/v1/matches/${matchId}`;
  let j = await riotGetNoMatch(host, canonical);
  if (j === null && phase === 'coregame') {
    j = await riotGetNoMatch(host, `/coregame/v1/matches/${matchId}`);
  }
  return j;
}

/** Generic `/mmr/v1/players/{puuid}` read for callers that need more than the
 *  LocalRank row (profile peaks, per-season buckets). */
export async function readMmrProfile<T>(
  puuid: string,
  shard: string,
  parse: (j: Validated<unknown>) => T
): Promise<Validated<T>> {
  if (!puuid) throw new RiotError('NO_PUUID', 'readMmrProfile: puuid is required');
  const j = await riotGet(shard, `/mmr/v1/players/${puuid}`);
  assertRiotOk(j, 'mmr');
  return validated(parse(validated(j)));
}

/** One competitive-update row. Numeric tier/deltas only — rank names are model
 *  code in the caller, not transport. */
export interface MmrUpdateRow {
  tierAfterUpdate: number;
  rrAfterUpdate: number;
  rrEarned: number;
  matchId: string;
  mapId: string;
  matchStartTime: number;
  queueId: string;
}

/** The last `count` competitive updates for a puuid. Validated: an error
 *  payload throws instead of parsing as "no games". */
export async function readCompetitiveUpdates(
  puuid: string,
  shard: string,
  count: number,
  queue: string
): Promise<Validated<MmrUpdateRow[]>> {
  if (!puuid) throw new RiotError('NO_PUUID', 'readCompetitiveUpdates: puuid is required');
  const queueParam = queue ? `&queue=${encodeURIComponent(queue)}` : '';
  const j = await riotGet(
    shard,
    `/mmr/v1/players/${puuid}/competitiveupdates?startIndex=0&endIndex=${count}${queueParam}`
  );
  assertRiotOk(j, 'competitive updates');
  const list = Array.isArray((j as { Matches?: unknown[] })?.Matches)
    ? ((j as { Matches: Record<string, unknown>[] }).Matches as Record<string, unknown>[])
    : [];
  return validated(
    list.map((g) => ({
      tierAfterUpdate: Number(g?.TierAfterUpdate ?? 0),
      rrAfterUpdate: Number(g?.RankedRatingAfterUpdate ?? 0),
      rrEarned: Number(g?.RankedRatingEarned ?? 0),
      matchId: String(g?.MatchID ?? ''),
      mapId: String(g?.MapID ?? ''),
      matchStartTime: Number(g?.MatchStartTime ?? 0),
      queueId: String(g?.QueueID ?? queue),
    }))
  );
}

/** One entry of a match's `Loadouts` array, as Riot returns it. The model
 *  (`loadout.ts`'s `parseLoadouts`) owns the field semantics. */
export type LoadoutRow = Record<string, unknown>;

/**
 * All loadouts for one match. `null` = no match (every spelling answered 404);
 * an empty array is real data — one spelling answered 200 with an empty
 * Loadouts list. The caller owns the match id, the reader owns the 404
 * contract: no player resolution here, so opening loadouts costs exactly the
 * loadout read and nothing else.
 *
 * Spellings are tried in phase order; the legacy `/coregame/` name is retried
 * only after the canonical route 404s, so a real 403 throws instead of being
 * masked.
 */
export async function readMatchLoadouts(
  phase: 'pregame' | 'coregame',
  matchId: string,
  region: string
): Promise<NoMatch<LoadoutRow[]>> {
  if (!matchId) throw new RiotError('NO_MATCH_ID', 'readMatchLoadouts: matchId is required');
  const host = glzHostFor(region);
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

  let sawData = false;
  for (const route of routes) {
    const j = await riotGetNoMatch(host, route);
    if (j === null) continue; // this spelling does not exist — try the next
    const raw = j as { Loadouts?: unknown; loadouts?: unknown };
    const list = Array.isArray(raw?.Loadouts) ? raw.Loadouts : raw?.loadouts;
    if (!Array.isArray(list)) continue;
    if (list.length > 0) return validated(list as LoadoutRow[]);
    sawData = true;
  }
  return sawData ? validated<LoadoutRow[]>([]) : null;
}

/* ------------------------------------------------------------------ *
 * Rank: the source read itself.
 *
 * Moved verbatim out of utils/tracker.ts. It lives here because the act-stats
 * reader needs a rank row and would otherwise import tracker back — a cycle.
 * ------------------------------------------------------------------ */

export interface LocalRankRow {
  /** Competitive tier number (0 = unranked/unknown). */
  tier: number;
  /** Current-act Ranked Rating. */
  rr: number;
  peakTier: number;
  peakSeasonId?: string;
  actWins: number;
  actGames: number;
  leaderboardRank: number;
  isRankHidden: boolean;
}

/** Parse one /mmr/v1/players/{puuid} body. PURE — extracted verbatim from the
 *  live lobby loop so the poll and the single-player path can never drift.
 *  Checked by scripts/act-aggregate-check.ts. */
export function parseLocalRank(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  j: any,
  seasonOrder: string[]
): LocalRankRow {
  const latest = j?.LatestCompetitiveUpdate ?? {};
  const tierId = Number(latest?.TierAfterUpdate ?? 0);
  const seasons = j?.QueueSkills?.competitive?.SeasonalInfoBySeasonID ?? {};
  // Current-act row carries the LIVE RR; LatestCompetitiveUpdate only holds
  // the value as of the last ranked game.
  const curSeasonId = String(latest?.SeasonID ?? '').toLowerCase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cur = (Object.entries(seasons) as [string, any][]).find(
    ([id]) => id.toLowerCase() === curSeasonId
  )?.[1];
  const rr =
    cur?.RankedRating != null
      ? Number(cur.RankedRating)
      : Number(latest?.RankedRatingAfterUpdate ?? 0);
  const peakInfo = extractPeakInfo(seasons, seasonOrder || []);
  const peak = Math.max(tierId, peakInfo.tier);
  return {
    tier: tierId,
    rr,
    peakTier: peak,
    peakSeasonId: peak === tierId && tierId > 0 ? curSeasonId : peakInfo.seasonId,
    actWins: Number(cur?.NumberOfWins ?? 0),
    actGames: Number(cur?.NumberOfGames ?? 0),
    leaderboardRank: Number(cur?.LeaderboardRank ?? 0),
    isRankHidden: !!j?.IsActRankBadgeHidden,
  };
}

/** Validate then parse one /mmr payload. PURE, so the check script can drive it
 *  with a good payload and with a Riot error payload. This is the guard that
 *  was missing here: without it a 403 parsed into tier 0 — the "Unrated"
 *  fabrication that emptied the board. */
export function rankFromPayload(j: unknown, seasonOrder: string[]): Validated<LocalRankRow> {
  assertRiotOk(j, 'mmr');
  return validated(parseLocalRank(validated(j), seasonOrder));
}

/** Rank + RR for ANY puuid through the local client. Validated: a Riot error
 *  payload throws, it never returns tier 0. */
export async function fetchLocalRank(
  puuid: string,
  region: string
): Promise<Validated<LocalRankRow>> {
  if (!puuid) throw new RiotError('NO_PUUID', 'fetchLocalRank: puuid is required');
  const { seasonOrder } = await gameData();
  const j = await riotGet(shardFor(region), `/mmr/v1/players/${puuid}`);
  return rankFromPayload(j, seasonOrder || []);
}

export interface LocalRiotCtx {
  region: string;
  queue: string;
  drain?: boolean;
  /** Opt IN to the act scan while VALORANT is in coregame. Default false: the
   *  wave-1 in-game guard stays for every automatic caller. Only an explicit
   *  user action (opening the player modal) sets this. */
  allowAct?: boolean;
  /** LOBBY FILL: take trnGet's fast path (no 6-8s serial slot). Only the
   *  budgeted lobby fill sets this; nothing else may. */
  fill?: boolean;
}

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

/* ------------------------------------------------------------------ *
 * Name service: Riot's own answer to "who is this puuid".
 * Moved verbatim out of utils/tracker.ts because the match-details reader
 * resolves missing names through it.
 * ------------------------------------------------------------------ */

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
