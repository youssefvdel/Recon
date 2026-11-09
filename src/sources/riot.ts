/* Riot local client — the authoritative source, and the ONLY place a raw
 * `riot_direct_get` payload exists.
 *
 * Design: docs/architecture/design-data-layer.md §2, step 1. The rule this file
 * enforces is the fix for bug class (a): the raw transport is private, so no
 * caller can obtain an unvalidated response, and every parser only accepts
 * `Validated<T>`, a branded type nothing outside this module can mint.
 *
 * A read either returns validated data or throws. Never junk. */

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../utils/ipc';

declare const VALIDATED: unique symbol;
/** Proof that a payload passed the reader's own checks. Only this module can
 *  mint one, which is why a parser cannot be handed a raw response. */
export type Validated<T> = T & { readonly [VALIDATED]: true };

/** Mint a validated value. Module-private by design — do not export. */
function validated<T>(value: T): Validated<T> {
  return value as Validated<T>;
}

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

interface DirectEnt {
  access_token: string;
  entitlements: string;
  puuid: string;
}

let entCache: { at: number; ent: DirectEnt } | null = null;
let cachedVersion = '';

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

/** One choke point for Riot's local API: bursting spawns one curl process per
 *  call, which tanks the machine. */
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

const PLATFORM_BLOB =
  'ew0KCSJwbGF0Zm9ybVR5cGUiOiJQQyIsDQoJInBsYXRmb3JtT3MiOiJXaW5kb3dzIg0KfQ==';

/** Same blob the Riot client sends; a const so the transport is self-contained. */
function platformBlob(): string {
  return PLATFORM_BLOB;
}

/**
 * Raw GET. NOT exported: this is the only function in the codebase that can
 * produce an unchecked Riot payload, and it must stay unreachable from parsers.
 */
async function riotGet(host: string, path: string): Promise<unknown> {
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
      if (retried?.httpStatus === 401 || retried?.httpStatus === 403) {
        onStatus('locked-out', 'Riot Client is logged out');
      } else {
        onStatus('ok');
      }
      return retried;
    }
    onStatus('ok');
    return j;
  } catch (e) {
    if (String(e).includes('RIOT_EXPIRED')) {
      clearEntitlements();
      return JSON.parse(await withRiotSlot(async () => call(await getEntitlements())));
    }
    const kind = onClassify(e);
    if (kind) onStatus(kind);
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * Validating readers — the public surface
 * ------------------------------------------------------------------ */

export class RiotError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RiotError';
    this.code = code;
  }
}

/** True when the payload is a Riot error object rather than data. */
function assertRiotOk(j: unknown, what: string): void {
  const o = j as { httpStatus?: number; errorCode?: string; message?: string };
  const status = Number(o?.httpStatus ?? 0);
  const code = String(o?.errorCode ?? '');
  if (code || status >= 400 || status === 0) {
    const detail = code || `HTTP ${status}`;
    throw new RiotError(detail, `Riot ${what} failed: ${detail} ${String(o?.message ?? '').slice(0, 120)}`);
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

/** Live match (pregame/coregame). `null` means "no match", not "failed". */
export async function readLiveMatch<T>(
  phase: 'pregame' | 'coregame',
  parse: (j: Validated<unknown>) => T | null
): Promise<Validated<T> | null> {
  const path = phase === 'coregame' ? '/core-game/v1/matches' : '/pregame/v1/matches';
  const j = await riotGet('glz', path);
  const o = j as { httpStatus?: number };
  if (Number(o?.httpStatus ?? 0) === 404) return null;
  assertRiotOk(j, 'live match');
  const parsed = parse(validated(j));
  return parsed === null ? null : validated(parsed);
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
