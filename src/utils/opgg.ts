import { trnCooldownRemainingMs, isTrackerEnabled, trnJitterGapMs } from './trn';
import { logger } from './logger';

/* OP.GG match-history fallback (TRN stays primary — nothing about TRN changes).
 *
 * When tracker.gg cools us down (or the local kill-switch is OFF), recent
 * match history falls back to OP.GG's official public MCP
 * (https://mcp-api.op.gg/mcp — Streamable HTTP JSON-RPC, no auth documented).
 * MATCH HISTORY ONLY: that MCP exposes no rank/RR tool, so this module never
 * fabricates rank/RR — unmapped fields stay null/empty.
 *
 * Thrift + attribution (per OP.GG terms): at most one paced fetch per
 * identity per 2h (separate opgg_ cache namespace), only from explicit
 * history views, never background polls. Every row carries source:'opgg'
 * and the UI cites OP.GG next to it.
 */

const OPGG_MCP_URL = 'https://mcp-api.op.gg/mcp';
const OPGG_TOOL = 'valorant_list_player_matches';

/** Human-readable attribution; UI cites this exact string next to OP.GG rows. */
export const OPGG_ATTRIBUTION = 'Match data by OP.GG (op.gg)';

const OPGG_CACHE_PREFIX = 'recon_opgg_cache_v1';
/** Mirror the TRN matches 2h persisted TTL (separate namespace, never trn_ keys). */
export const OPGG_MATCHES_TTL_MS = 2 * 3600 * 1000;

/** One normalized OP.GG match. No rank/RR fields exist here by design. */
export interface OpggMatch {
  matchId: string;
  map: string;
  mapId: string;
  agent: string;
  /** null when the payload doesn't say who won — callers decide display. */
  won: boolean | null;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  rounds: number;
  /** epoch ms, 0 when unknown. */
  when: number;
  queue: string;
  /** Citation carried on the row: every OP.GG row renders an OP.GG tag. */
  source: 'opgg';
}

/* ------------------------------------------------------------------ *
 * Gating (the core rule): OP.GG is called ONLY while TRN is cooling or
 * the local tracker toggle is OFF. Otherwise the TRN path runs exactly
 * as today. Pure apart from storage reads — unit-testable.
 * ------------------------------------------------------------------ */
export function isOpggFallbackActive(): boolean {
  try {
    if (!isTrackerEnabled()) return true;
  } catch {}
  try {
    return trnCooldownRemainingMs() > 0;
  } catch {
    return false;
  }
}

/* ------------------------- cache (opgg_ only) ---------------------- */

export function opggCacheKey(name: string, tag: string): string {
  return `${OPGG_CACHE_PREFIX}:matches:${name.trim().toLowerCase()}#${tag.trim().toLowerCase()}`;
}

export function readOpggCache<T>(key: string, ttlMs: number): T | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; data: T };
    if (!parsed?.at || Date.now() - parsed.at > ttlMs) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function writeOpggCache<T>(key: string, data: T): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
  } catch {}
}

/* ------------------------- MCP JSON-RPC client --------------------- *
 * Hand-rolled POST, no new dependencies. Responses may be plain JSON
 * or SSE (text/event-stream data: frames) — accept both. */

let opggSessionId: string | null = null;

async function mcpRpc(method: string, params: unknown, id: number | string): Promise<unknown> {
  // Body built with JSON.stringify — never hand-quoted shell JSON.
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (opggSessionId) headers['mcp-session-id'] = opggSessionId;
  const res = await fetch(OPGG_MCP_URL, { method: 'POST', headers, body });
  const sid = res.headers.get('mcp-session-id');
  if (sid) opggSessionId = sid;
  const text = await res.text();
  if (!res.ok) throw new Error(`OP.GG MCP HTTP ${res.status}`);
  const ctype = res.headers.get('content-type') ?? '';
  let payload: unknown;
  if (ctype.includes('text/event-stream')) {
    let found: unknown;
    // Cap frames: a poisoned/huge stream must not hang or OOM the parse.
    for (const line of text.split('\n', 1000)) {
      const t = line.trim();
      if (t.startsWith('data:')) {
        const p = t.slice(5).trim();
        if (!p || p === '[DONE]') continue;
        try {
          found = JSON.parse(p) as unknown;
        } catch {
          continue; // skip poisoned frame, keep scanning
        }
      }
    }
    if (found === undefined) throw new Error('OP.GG MCP empty SSE reply');
    payload = found;
  } else {
    payload = JSON.parse(text) as unknown;
  }
  const envelope = (payload ?? {}) as { error?: unknown; result?: unknown };
  if (envelope.error) throw new Error(`OP.GG MCP error: ${JSON.stringify(envelope.error).slice(0, 200)}`);
  return envelope.result ?? payload;
}

async function mcpCallTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  // Stateless transport: handshake first (as discovered by scripts/opgg-mcp-probe.ts).
  await mcpRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'recon', version: '0.4.1-alpha.2' },
  }, `init-${Date.now() % 100000}`);
  return mcpRpc('tools/call', { name: toolName, arguments: args }, `call-${Date.now() % 100000}`);
}

/* ------------------------- normalization --------------------------- *
 * Defensive: the tools/call payload shape for player matches could not be
 * captured live (the MCP's upstream fetch fails from this sandbox —
 * INTERNAL_ERROR/RequestException; see probe notes). Accept an array, a
 * {data|matches|result} envelope, or a content[0].text JSON envelope, with
 * generous per-field aliases. Map what exists, null/empty what doesn't —
 * never invent rank/RR. */

const str = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
};

const num = (v: unknown): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? (n as number) : 0;
};

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) lower[k.toLowerCase()] = v;
  for (const k of keys) {
    const v = lower[k.toLowerCase()];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function parseWon(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['win', 'won', 'victory', 'w', 'true', '1'].includes(s)) return true;
    if (['loss', 'lost', 'defeat', 'l', 'false', '0'].includes(s)) return false;
  }
  return null;
}

function parseWhen(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? Math.round(v) : Math.round(v * 1000);
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v.trim());
    if (Number.isFinite(t)) return t;
    const n = Number(v.trim());
    if (Number.isFinite(n)) return parseWhen(n);
  }
  return 0;
}

/** Normalize one OP.GG match entry. Returns null when it has no usable id. */
export function normalizeOpggMatchEntry(raw: unknown): OpggMatch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const matchId = str(pick(o, ['match_id', 'matchId', 'id', 'game_id', 'gameId']));
  if (!matchId) return null;
  return {
    matchId,
    map: str(pick(o, ['map', 'map_name', 'mapName'])),
    mapId: str(pick(o, ['map_id', 'mapId', 'mapUuid'])),
    agent: str(pick(o, ['agent', 'agent_name', 'agentName', 'character', 'character_name'])),
    won: parseWon(pick(o, ['won', 'win', 'victory', 'result', 'outcome'])),
    kills: num(pick(o, ['kills'])),
    deaths: num(pick(o, ['deaths'])),
    assists: num(pick(o, ['assists'])),
    score: num(pick(o, ['score'])),
    rounds: num(pick(o, ['rounds', 'rounds_played', 'roundsPlayed'])),
    when: parseWhen(pick(o, ['played_at', 'playedAt', 'game_start', 'gameStartTime', 'timestamp', 'date', 'when'])),
    queue: str(pick(o, ['mode', 'queue', 'queue_id', 'game_mode'])),
    source: 'opgg',
  };
}

/** Normalize a tools/call result payload into OP.GG matches (never throws). */
export function normalizeOpggMatches(payload: unknown): OpggMatch[] {
  try {
    let list: unknown = payload;
    if (list && typeof list === 'object' && !Array.isArray(list)) {
      const o = list as Record<string, unknown>;
      // tools/call envelope: { content: [{ type:'text', text:'[...]' }] }
      const content = o.content;
      if (Array.isArray(content) && content.length > 0) {
        const first = content[0] as { text?: unknown };
        const text = typeof first?.text === 'string' ? first.text : '';
        try {
          list = text ? (JSON.parse(text) as unknown) : [];
        } catch {
          return [];
        }
        if (list && typeof list === 'object' && !Array.isArray(list)) {
          const inner = list as Record<string, unknown>;
          if (Array.isArray(inner.data)) list = inner.data;
          else if (Array.isArray(inner.matches)) list = inner.matches;
          else if (Array.isArray(inner.result)) list = inner.result;
        }
      } else if (Array.isArray(o.data)) list = o.data;
      else if (Array.isArray(o.matches)) list = o.matches;
      else if (Array.isArray(o.result)) list = o.result;
      else return [];
    }
    if (!Array.isArray(list)) return [];
    const out: OpggMatch[] = [];
    for (const entry of list) {
      const m = normalizeOpggMatchEntry(entry);
      if (m) out.push(m);
    }
    return out;
  } catch {
    return [];
  }
}

/* ------------------------- fetch (gated + paced) ------------------- */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let opggNextSlot = 0;

/**
 * OP.GG match history for a Riot ID. Returns [] unless the fallback gate is
 * open (TRN cooling or tracker OFF) — when TRN is healthy this never touches
 * the network. Paced with the same 1.5–3s serial discipline as the TRN gate
 * (own slot; no parallel fan-out). Results cached 2h under opgg_ keys.
 */
export async function fetchOpggMatches(name: string, tag: string): Promise<OpggMatch[]> {
  const n = name.trim();
  const t = tag.trim();
  if (!n || !t) return [];
  if (!isOpggFallbackActive()) return [];
  const key = opggCacheKey(n, t);
  const cached = readOpggCache<OpggMatch[]>(key, OPGG_MATCHES_TTL_MS);
  if (cached) return cached;

  // Serial pacing: same human discipline as the TRN gate, own slot.
  const gap = trnJitterGapMs();
  const slot = Math.max(Date.now(), opggNextSlot);
  opggNextSlot = slot + gap;
  const wait = slot - Date.now();
  if (wait > 0) await sleep(wait);

  try {
    // Param names + tool name discovered live via scripts/opgg-mcp-probe.ts
    // (valorant_list_player_matches takes game_name + tag_line only).
    const result = await mcpCallTool(OPGG_TOOL, { game_name: n, tag_line: t });
    const out = normalizeOpggMatches(result).slice(0, 20);
    // Never cache an empty array: a fallback miss must not poison the 2h cache.
    if (out.length > 0) writeOpggCache(key, out);
    return out;
  } catch (e) {
    if (import.meta.env.DEV) logger.warn('OP.GG fallback failed:', e);
    return [];
  }
}
