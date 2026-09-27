import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './ipc';
import { logger } from './logger';

/* TRN enrichment: tracker.gg's public read API through a hidden same-origin
   WebView2 window (genuine Edge TLS + navigation chain + page cookies — no
   key, no login, no sidecar, no Rust HTTP). Everything here is a progressive
   enhancement: every caller MUST fall back to Riot-direct data when this
   throws (TRN_*) because TRN can gate or reshape these endpoints at any time. */

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
 * hidden WebView2 window is a transport backstop only — it must never set
 * request spacing.
 * ------------------------------------------------------------------ */
/** Cautious gap bounds: uniform jitter 6000-8000ms between TRN requests
 *  (user-ordered safety margin after repeated walls — a full lobby fill takes
 *  ~2min, accepted cost). */
export const TRN_GAP_MIN_MS = 6000;
export const TRN_GAP_MAX_MS = 8000;
/**
 * Uniform cautious gap, 6000-8000ms. Pure, seeded-independent,
 * unit-testable. Pacing lives ONLY here — the transport serves one call at
 * a time and cannot pace across calls.
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
 * UA major version the hidden WebView2 window sends (genuine Edge;
 * mirrored here display-only for the Dev QA page).
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

/* ------------------------------------------------------------------ *
 * Transport: hidden same-origin WebView2 window (trn_proxy.rs).       *
 * Same-origin fetch: no CORS, genuine navigation chain + real Edge    *
 * TLS/cookies, shared WebView2 pool — no download, no sidecar, no     *
 * Rust HTTP. ONE transport only: any failure (EDGE_UNAVAILABLE /      *
 * EDGE_PAUSED / HTTP {code}) propagates to the caller, which falls    *
 * back to Riot-direct data. No pin, no retry here.                    *
 * ------------------------------------------------------------------ */
async function edgeGet(path: string, drain = false): Promise<string> {
  try {
    // Phase hint lets the proxy pause in-match fullscreen fetches only —
    // pregame/menus always fetch (lobby pre-fetch window). Unknown ('')
    // keeps the Rust fullscreen-facts fallback. drain exempts an
    // already-budgeted fill draining across the phase flip.
    return await invoke<string>('trn_proxy_fetch', {
      path,
      phase: trnMatchPhase,
      drain,
      lobby: trnLobbyKey,
    });
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e));
  }
}

/* Best-known match phase for the proxy pause gate (tracker.ts poll loop
 * sets it from Riot-local every poll — pregame vs coregame vs idle, free).
 * Module state, not persisted: a stale hint only ever over-allows one
 * budgeted ladder-guarded fetch, never over-pauses the lobby. */
let trnMatchPhase = '';

/* Best-known lobby (matchId) for the Rust-side shared per-lobby request
 * ceiling. Every TRN request carries it so the ceiling in trn_proxy.rs can
 * count a lobby ONCE across BOTH WebView realms (see the comment there) —
 * a per-realm counter cannot bound anything. Module state, not persisted;
 * '' means "no lobby" (menus, Tracker tab) and is billed only to the
 * per-hour ceiling, never to a lobby's. */
let trnLobbyKey = '';

/** Stamp the proxy pause hint (pregame/agent-select must never pause). */
export function setTrnMatchPhase(phase: string): void {
  trnMatchPhase = phase;
}

/** Stamp the current lobby key for the shared per-lobby request ceiling. */
export function setTrnLobbyKey(matchId: string): void {
  trnLobbyKey = matchId;
}

/** Test seam: read the hint back. */
export function getTrnMatchPhase(): string {
  return trnMatchPhase;
}

/* Drain job scope: when a lobby fill dispatches, tracker.ts opens one job
 * per lobby (generation id + lowercase `name#tag` set). EVERY TRN call for
 * those players inherits the drain token until the job settles — including
 * descendant detail calls widgets fan out with no explicit token — then
 * pause re-engages. Ladder + persisted cooldown still apply per request
 * inside the job (a 429 still cools). Module state, not persisted. */
let trnDrainGen = 0;
const trnDrainIds = new Set<string>();

const trnDrainKey = (name: string, tag: string): string =>
  `${name.trim().toLowerCase()}#${tag.trim().toLowerCase()}`;

/** Open a drain job for a lobby fill. Replaces any prior job. Returns the generation. */
export function openTrnDrainJob(ids: string[]): number {
  trnDrainGen += 1;
  trnDrainIds.clear();
  for (const id of ids) trnDrainIds.add(id.toLowerCase());
  return trnDrainGen;
}

/** Settle a job — only the owning generation closes, so a stale settle can
 *  never kill a newer lobby's job. Pause re-engages for anything new after. */
export function closeTrnDrainJob(gen: number): void {
  if (gen === trnDrainGen) trnDrainIds.clear();
}

/** Drain inherit: explicit token wins, else current job membership. Pure
 *  (reads module set) — checked by scripts/devqa-check.ts. */
export function trnDrainFor(name: string, tag: string, explicit = false): boolean {
  return explicit || trnDrainIds.has(trnDrainKey(name, tag));
}

/* ---- Central negative registry: proven privates/missing never refire ---- *
 * EVERY exported player fetch consults this FIRST (before gate, pause,
 * cooldown, network) — not just the lobby fill. Otherwise Overview, modals,
 * maps/agents tabs, and the useTrackerData enrichment refire 451/404s on
 * every view open. Keyed by lowercase `name#tag` (what every fetch fn takes);
 * persisted so negatives survive restarts. Writers: fetchTrnStatsNow's catch
 * (tracker.ts) notes the kind its error proved. Same localStorage precedent
 * as the persisted cooldown. */
const TRN_NEG_KEY = 'recon_trn_negative_v1';
export const TRN_NEG_PRIVATE_MS = 7 * 24 * 60 * 60 * 1000;
export const TRN_NEG_MISSING_MS = 24 * 60 * 60 * 1000;
/** Quiet shape while blocked. No 429/403/1015 substring: never trips the
 *  ladder; every caller already catches into its fallback. */
export const TRN_NEGATIVE_BACKOFF = 'TRN_NEGATIVE_BACKOFF';

/** Player key shared by every fetch fn. Pure. */
export function trnPlayerKey(name: string, tag: string): string {
  return `${name.trim().toLowerCase()}#${tag.trim().toLowerCase()}`;
}

function readNegatives(): Record<string, { until: number; kind: 'private' | 'missing' }> {
  try {
    if (typeof localStorage === 'undefined') return {};
    return JSON.parse(localStorage.getItem(TRN_NEG_KEY) ?? '{}') as Record<string, { until: number; kind: 'private' | 'missing' }>;
  } catch {
    return {};
  }
}

/** Record a proven negative (call with the kind the error proved). */
export function trnNoteNegative(name: string, tag: string, kind: 'private' | 'missing'): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const all = readNegatives();
    all[trnPlayerKey(name, tag)] = {
      until: Date.now() + (kind === 'private' ? TRN_NEG_PRIVATE_MS : TRN_NEG_MISSING_MS),
      kind,
    };
    localStorage.setItem(TRN_NEG_KEY, JSON.stringify(all));
  } catch {}
}

/** Kind of proven negative covering this player, if any (lazy-evicts
 *  expired). Pure read, no network. */
export function trnNegativeKind(name: string, tag: string): 'private' | 'missing' | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const all = readNegatives();
    const key = trnPlayerKey(name, tag);
    const e = all[key];
    if (!e) return null;
    if (Date.now() >= e.until) {
      delete all[key];
      localStorage.setItem(TRN_NEG_KEY, JSON.stringify(all));
      return null;
    }
    return e.kind;
  } catch {
    return null;
  }
}

/** True while a negative backoff covers this player (lazy-evicts expired). */
export function trnNegativeBlocked(name: string, tag: string): boolean {
  return trnNegativeKind(name, tag) !== null;
}

/** Parse `/riot/{name}%23{tag}/` request paths back to the player. Null for
 *  non-player paths (match details) and garbage. Pure. */
export function trnPlayerFromPath(path: string): { name: string; tag: string } | null {
  try {
    const m = /\/riot\/([^/?]+)%23([^/?]+)/.exec(path);
    if (!m) return null;
    const name = decodeURIComponent(m[1]);
    const tag = decodeURIComponent(m[2]);
    if (!name || !tag) return null;
    return { name, tag };
  } catch {
    return null;
  }
}

/** Central writer: note a proven private/missing from ANY path's outcome
 *  (fill, Overview, modals, maps/tabs, enrichment, QA) — parsed from the
 *  request path, so writers are never forgotten per-callsite again. Returns
 *  the kind noted (for tests/logs), null when nothing provable. */
export function noteNegativeFromPath(path: string, msg: unknown): 'private' | 'missing' | null {
  const s = typeof msg === 'string' ? msg : msg instanceof Error ? msg.message : String(msg ?? '');
  const kind = isTrnPrivateError(s) ? 'private' : s.includes('HTTP 404') ? 'missing' : null;
  if (!kind) return null;
  const who = trnPlayerFromPath(path);
  if (!who) return null;
  trnNoteNegative(who.name, who.tag, kind);
  if (import.meta.env.DEV) trnLog('negative noted', `${kind} ${who.name}#${who.tag}`);
  return kind;
}

/** Which transport served a trnGet call. QA/display only — never branched on. */
export type TrnTransport = 'EDGE';

/** Readiness-gate timeout shape from trn_proxy.rs (fresh/challenged page).
 *  Transient like every EDGE_PAUSED — callers fall back to Riot-direct and
 *  retry next call. Never contains 429/403/1015 so it never trips the ladder
 *  below. Pure — checked by scripts/devqa-check.ts. */
export const TRN_PROXY_NOT_READY = 'EDGE_PAUSED proxy not ready';

/** True for the readiness-gate timeout above. Pure. */
export function isTrnProxyNotReady(msg: unknown): boolean {
  const s = typeof msg === 'string' ? msg : msg instanceof Error ? msg.message : String(msg ?? '');
  return s.includes(TRN_PROXY_NOT_READY);
}

/** In-match-fullscreen pause shape (Rust gate + the pre-check below throw
 *  the identical string so callers treat both the same). Pure const. */
export const TRN_PROXY_PAUSED = 'EDGE_PAUSED game fullscreen';

/** Marker inside a network-dead outcome: the in-page fetch itself threw
 *  (status 0) — the page's network is down, not Cloudflare answering.
 *  Never overlaps TRN_PROXY_PAUSED (game fullscreen has no such marker). */
export const TRN_NET_DEAD_MARK = 'in-page fetch failed';

/** Consecutive network-dead outcomes before the breaker opens. */
export const TRN_DEAD_STREAK_MAX = 5;
/** Quiet period while open: no network, no gate wait, no budget spend. */
export const TRN_DEAD_QUIET_MS = 5 * 60 * 1000;

/** Quiet shape while the breaker is open. Carries no 429/403/1015 substring
 *  so it never trips the ladder; callers fall back to Riot-direct. */
export const TRN_DEAD_QUIET = 'TRN_DEAD_QUIET';

/* Consecutive status-0 breaker: module state, not persisted (a reload gets
 * one clean probe series — correct, the network may have recovered). */
let trnDeadStreak = 0;
let trnDeadQuietUntil = 0;

/** True for a network-dead outcome (fetch threw pre-status). Pure. */
export function isTrnNetDead(msg: unknown): boolean {
  const s = typeof msg === 'string' ? msg : msg instanceof Error ? msg.message : String(msg ?? '');
  return s.includes(TRN_NET_DEAD_MARK);
}

/** True while the breaker is open (fail quiet, spend nothing). Pure read. */
export function isTrnDeadQuiet(): boolean {
  return Date.now() < trnDeadQuietUntil;
}

/* ------------------------------------------------------------------ *
 * Per-player cache bounds
 *
 * The maps below are keyed by `name#tag` (+ playlist/season), so their key
 * space is "every player this install has ever looked up" — unbounded over
 * a session. All of them carry their own timestamp, so oldest-first
 * eviction is age-ordered (there is no LRU helper in this codebase to
 * reuse and none is warranted for three maps).
 * ------------------------------------------------------------------ */

/** Oldest-first eviction down to `cap`; `at` reads the entry's own age. */
function evictOldest<K, V>(map: Map<K, V>, cap: number, at: (v: V) => number): void {
  if (map.size <= cap) return;
  for (const [k] of [...map.entries()].sort((a, b) => at(a[1]) - at(b[1]))) {
    if (map.size <= cap) break;
    map.delete(k);
  }
}

/** Dead-path stamps: 30s cooldown each, keyed by a full request path. Only
 *  the failures of the last few minutes can ever be read again, so 64 keys
 *  (~6 players x profile+season paths, several over) is generous. */
const TRN_PATH_STAMPS_MAX = 64;

/* ---- Per-path failure backoff: one dead URL burns once per 30s ---- *
 * Five views chase one player (Overview, Mini, modal, enrichment, fill) and
 * gate/budget/cooldown don't stop DIFFERENT callers re-firing one dead path
 * every poll — so the choke lives here, keyed by exact request path: any
 * failed wire attempt stamps it, repeats fail fast without touching gate,
 * budget, or wire. Successes never stamp (caches own the hot path). */
const TRN_PATH_RETRY_MS = 30 * 1000;
const trnPathFailedAt = new Map<string, number>();

/** Stamp a failed attempt for this exact path. */
export function noteTrnPathFailed(path: string): void {
  trnPathFailedAt.set(path, Date.now());
  evictOldest(trnPathFailedAt, TRN_PATH_STAMPS_MAX, (at) => at);
}

/** True while this exact path is cooling after a failure. Pure read. */
export function trnPathCooling(path: string): boolean {
  const at = trnPathFailedAt.get(path);
  return at !== undefined && Date.now() - at < TRN_PATH_RETRY_MS;
}

/** True for TRN's private-profile shape: HTTP 451 with either
 *  `CollectorResultStatus::Private` ("This profile is still private", root
 *  profile calls) or `StandardApiV2::Private` ("Profile stats are private.",
 *  season-segment calls — same locked account, different endpoint).
 *  Pure — no network. Callers treat it as "dashes with a reason", not breakage. */
export function isTrnPrivateError(msg: unknown): boolean {
  const s = typeof msg === 'string' ? msg : msg instanceof Error ? msg.message : String(msg ?? '');
  return (
    s.includes('451') &&
    (s.includes('CollectorResultStatus::Private') ||
      s.includes('StandardApiV2::Private') ||
      s.toLowerCase().includes('still private'))
  );
}

/** DEV-ONLY structured trace for agent debugging: `[TRN HH:MM:SS.mmm] …`.
 *  Call sites wrap in `if (import.meta.env.DEV)` so prod drops arg
 *  construction too — zero prod output. `logger` timestamps + buffers every
 *  line, so the DevDashboard log export carries them with no new UI. */
export function trnLog(event: string, detail = ''): void {
  // Belt-and-braces alongside the call-site `if (import.meta.env.DEV)` gates:
  // a future ungated caller still compiles to a bare return in prod.
  if (!import.meta.env.DEV) return;
  logger.log(`[TRN ${new Date().toISOString().slice(11, 23)}] ${event}${detail ? ` ${detail}` : ''}`);
}

/** Proxy page state (Rust-owned watchdog state, DevDashboard readout). */
export type TrnProxyState = 'READY' | 'CHALLENGED' | 'RECREATED' | 'PAUSED' | 'UNKNOWN';

/** Allowlist-parse the Rust state string. Pure — checked by devqa-check. */
export function parseTrnProxyState(s: unknown): TrnProxyState {
  return s === 'READY' || s === 'CHALLENGED' || s === 'RECREATED' || s === 'PAUSED' ? s : 'UNKNOWN';
}

/** Read the proxy watchdog state (one Rust atomic — no eval, no network). */
export async function trnProxyState(): Promise<TrnProxyState> {
  if (!isTauri()) return 'UNKNOWN';
  try {
    return parseTrnProxyState(await invoke<string>('trn_proxy_state'));
  } catch {
    return 'UNKNOWN';
  }
}

/** Pause pre-check: same Rust predicate as the in-fetch gate, but no window,
 *  no eval, no network — just Win32 reads. Fail-open false (invoke error or
 *  no Tauri): the in-fetch check stays as backstop. */
export async function trnProxyPaused(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>('trn_proxy_paused', { phase: trnMatchPhase });
  } catch {
    return false;
  }
}

/* ---------- file-backed response cache (trn_cache.rs) ------------ *
 * The bodies are megabyte-scale — the root profile measured 1.27 MB and a
 * competitive season segment 1.72 MB (largest observed 2,176,778 chars) —
 * and they were persisted into localStorage, whose whole origin budget on
 * this install measured 4.76 MB of a ~5 MB quota: a 256 KiB write succeeded,
 * a 512 KiB write threw QuotaExceededError. So `writePersisted` threw for
 * every real payload, the error was swallowed, and the persistence layer was
 * silently dead: after 40+ successful season fetches
 * `recon_trn_cache_v1:profile:*` and `season:*` were ABSENT from localStorage
 * while only the small `matches:*` entry persisted. Every cold start therefore
 * re-fetched everything and re-tripped the rate limit. Four season segments
 * plus a profile plus matches is ~9 MB against a ~5 MB ceiling, so no amount
 * of eviction makes localStorage the right store for the bodies. Files can.
 *
 * The bodies moved; nothing else did. The NEGATIVE registry and the COOLDOWN
 * state stay in localStorage on purpose: they are a few hundred bytes per
 * install, they are read on the hot path of every player fetch (a synchronous
 * read, where an IPC round trip would be a new cost on every view open), and
 * they are the two things that stop a rate-limited or private profile from
 * being re-requested in a loop. Moving them would add a failure mode to the
 * one mechanism that must never fail. The small derived maps
 * (`fetchTrnMatches` / `fetchTrnMatchDetails`) stay there too, for the same
 * reason: KB-scale, and the sync read is what makes a repeat poll free.
 *
 * TTL POLICY STAYS HERE. Rust stores a body and returns `fetched_at`;
 * `trnCacheVerdict` below is the entire freshness decision. A `trnGet` with
 * no `ttlMs` neither reads nor writes the cache, which is what keeps the Dev
 * QA burst hammer's deliberately-raw `trnGet` uncached. */
export interface TrnCacheEntry {
  /** Echoed from the stored header; Rust verified it against the request. */
  path: string;
  /** The raw response text, byte-identical to what the wire returned. */
  body: string;
  /** Epoch ms the body was fetched, written by Rust. The only clock fact. */
  fetched_at: number;
}

export interface TrnCachePut {
  stored: boolean;
  bytes: number;
  cap: number;
  /** Empty on success; on a refusal this is the line the user sees. */
  reason: string;
}

/** Pure: an entry is fresh while its OWN age is inside the caller's TTL. A
 *  missing/zero/non-finite stamp is never fresh — an entry whose age cannot
 *  be established must not be served as if it were current. */
export function trnCacheFresh(fetchedAt: number, ttlMs: number, now = Date.now()): boolean {
  return Number.isFinite(fetchedAt) && fetchedAt > 0 && now - fetchedAt < ttlMs;
}

/** Pure: the lookup verdict. `null`/`undefined` = nothing on disk = miss.
 *  Checked by scripts/trn-cache-check.ts. */
export function trnCacheVerdict(
  entry: TrnCacheEntry | null | undefined,
  ttlMs: number,
  now = Date.now()
): 'hit' | 'miss' {
  return entry && trnCacheFresh(entry.fetched_at, ttlMs, now) ? 'hit' : 'miss';
}

/** Disk lookup. `undefined` = miss (absent, stale, corrupt, or a backend
 *  without the command) and the caller falls through to the wire — a
 *  degradation, not a failure, which is why it is reported and not thrown. */
async function trnCacheLookup(path: string, ttlMs: number): Promise<unknown | undefined> {
  try {
    const e = await invoke<TrnCacheEntry | null>('trn_cache_get', { path });
    if (trnCacheVerdict(e, ttlMs) !== 'hit' || !e) return undefined;
    // Rust already proved this parses (it validates the body on read), so a
    // throw here would mean the two sides disagree — fall through to the wire.
    return JSON.parse(e.body) as unknown;
  } catch (err) {
    if (import.meta.env.DEV) {
      trnLog('cache read failed', `${path.slice(0, 60)} ${String(err).slice(0, 80)}`);
    }
    return undefined;
  }
}

/** Fire-and-forget store: the caller already has its data, so a disk write
 *  must never hold up a lobby fill. A refusal is REPORTED — Rust traces it
 *  into the dev ring and the DEV log carries it too — because the failure
 *  mode being replaced was an exception nobody could see. */
function trnCacheStore(path: string, body: string, ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
  void invoke<TrnCachePut>('trn_cache_put', { path, body })
    .then((r) => {
      if (r && r.stored === false && import.meta.env.DEV) {
        trnLog('cache write refused', `${path.slice(0, 60)} ${r.reason}`);
      }
    })
    .catch((err) => {
      if (import.meta.env.DEV) {
        trnLog('cache write failed', `${path.slice(0, 60)} ${String(err).slice(0, 80)}`);
      }
    });
}

export async function trnGet(
  path: string,
  opts?: {
    immediate?: boolean;
    onTransport?: (t: TrnTransport) => void;
    drain?: boolean;
    /** Opt in to the file cache with THIS caller's freshness policy (ms).
     *  Omit it and the call is neither read from nor written to disk. */
    ttlMs?: number;
  }
): Promise<unknown> {
  // Kill-switch first: cheapest possible branch (one cached boolean), no
  // network, no gate, no timers touched. Same TRN_* throw shape as cooldown
  // so every caller falls back to Riot-direct data untouched.
  // ponytail: QA-only tag (which transport served/would-serve). Never branched on.
  const report = (t: TrnTransport): void => opts?.onTransport?.(t);
  if (!isTrackerEnabled()) {
    report('EDGE');
    throw new Error('TRN_DISABLED tracker off');
  }
  if (!isTauri()) {
    report('EDGE');
    throw new Error('TRN needs the desktop app.');
  }

  // File cache FIRST, ahead of every gate below it. A warm start has to be
  // silent even when the previous session ended mid-cooldown, mid-pause or
  // mid-dead-network, so none of those may turn a body we already hold into a
  // network request. Every caller consults the negative registry before it
  // gets here, so a proven private/missing still never reads. No `report()`:
  // no transport ran, and the tag exists to name one.
  if (opts?.ttlMs) {
    const cached = await trnCacheLookup(path, opts.ttlMs);
    if (cached !== undefined) return cached;
  }

  // Per-path backoff BEFORE anything with a cost (even before pause/dead-quiet
  // reads): five views chase one player, and only the first failure per 30s
  // window may touch the wire — the rest fail fast here.
  if (trnPathCooling(path)) {
    if (import.meta.env.DEV) trnLog('path-backoff fail-fast', `path=${path.slice(0, 80)}`);
    report('EDGE');
    throw new Error('TRN_PATH_BACKOFF');
  }

  // Dead-network breaker BEFORE anything with a cost: consecutive status-0
  // deaths mean the page's network is down — fail quiet without touching the
  // gate, the budget, or the wire. A later success reopens automatically.
  if (isTrnDeadQuiet()) {
    if (import.meta.env.DEV) trnLog('dead-quiet fail-fast', `remaining=${Math.ceil((trnDeadQuietUntil - Date.now()) / 1000)}s`);
    report('EDGE');
    throw new Error(`${TRN_DEAD_QUIET} ${Math.ceil((trnDeadQuietUntil - Date.now()) / 1000)}s`);
  }

  // Pause pre-check BEFORE the gate slot claim: a paused call fetches nothing,
  // so it must cost nothing — no wait, no budget. (The in-fetch Rust check
  // stays as backstop for races; stragglers refund their slot below.)
  // drain exempts an already-budgeted fill running to completion.
  if (opts?.drain !== true && (await trnProxyPaused())) {
    if (import.meta.env.DEV) trnLog('pause fail-fast', 'in-match fullscreen (no wait)');
    report('EDGE');
    throw new Error(TRN_PROXY_PAUSED);
  }

  const cooling = trnCooldownRemainingMs();
  if (cooling > 0) {
    // Fail fast: during cooldown we must not touch the network at all.
    if (import.meta.env.DEV) trnLog('cooldown fail-fast', `remaining=${Math.ceil(cooling / 1000)}s`);
    report('EDGE');
    throw new Error(`TRN_RATE_LIMITED ${Math.ceil(cooling / 1000)}s`);
  }

  // Serialise: claim the next slot, then wait for it. Concurrent callers queue
  // up behind each other instead of bursting. The spacing is uniform jitter
  // (human pacing); an explicit user refresh (immediate) skips the wait but
  // still paces its followers. resetTrnCooldown() zeroes the slot, so the
  // first request after a user refresh likewise fires immediately.
  const t0 = Date.now();
  if (import.meta.env.DEV) trnLog('trnGet start', `path=${path} immediate=${opts?.immediate === true}`);
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
    if (import.meta.env.DEV && wait > 0) trnLog('gate waited', `${wait}ms`);
  }

  // Re-check after the wait: a sibling may have tripped a 429 while we were
  // queued. Hitting the network during cooldown extends the Cloudflare block.
  // Refund our slot claim so fail-fast waiters don't phantom-delay the queue.
  if (trnCooldownRemainingMs() > 0) {
    if (trnNextSlot === slot + gap) trnNextSlot = slot;
    if (import.meta.env.DEV) trnLog('cooldown fail-fast', `post-wait remaining=${Math.ceil(trnCooldownRemainingMs() / 1000)}s`);
    report('EDGE');
    throw new Error(`TRN_RATE_LIMITED ${Math.ceil(trnCooldownRemainingMs() / 1000)}s`);
  }

  let raw: string;
  try {
    // Single transport: hidden same-origin window. HTTP statuses flow into
    // the shared ladder below unchanged; transport failures propagate to
    // the caller (Riot-direct fallback) with no pin and no retry here.
    raw = await edgeGet(path, opts?.drain === true);
    if (opts?.ttlMs) trnCacheStore(path, raw, opts.ttlMs);
    if (import.meta.env.DEV) trnLog('outcome', `transport=EDGE status=ok elapsed=${Date.now() - t0}ms`);
    // An answered request proves the path is alive — reset the dead breaker.
    trnDeadStreak = 0;
    trnDeadQuietUntil = 0;
    report('EDGE');
  } catch (e) {
    const msg = String(e);
    if (import.meta.env.DEV) trnLog('fallback', `${msg.slice(0, 120)} elapsed=${Date.now() - t0}ms`);
    // Race backstop: paused after waiting (match started mid-queue) — refund
    // the slot so followers don't pay for a call that fetched nothing.
    if (msg.includes(TRN_PROXY_PAUSED) && trnNextSlot === slot + gap) trnNextSlot = slot;
    if (msg.includes('429') || msg.includes('403') || msg.includes('1015')) {
      trnCooldownStep = Math.min(trnCooldownStep + 1, TRN_COOLDOWN_MAX_STEP);
      trnCooldownUntil = Date.now() + trnCooldownDelayMs(trnCooldownStep);
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(TRN_COOLDOWN_KEY, String(trnCooldownUntil));
        } catch {}
      }
      // An answered request (even a refusal) proves the path is alive —
      // the ladder owns HTTP errors, not the dead breaker.
      trnDeadStreak = 0;
      trnDeadQuietUntil = 0;
    } else if (isTrnNetDead(msg)) {
      // Status-0: the fetch died pre-status. One is noise; a streak means
      // the page's network is down — go quiet instead of clogging the gate.
      trnDeadStreak += 1;
      if (trnDeadStreak >= TRN_DEAD_STREAK_MAX) {
        trnDeadQuietUntil = Date.now() + TRN_DEAD_QUIET_MS;
        if (import.meta.env.DEV) trnLog('dead-quiet engaged', `streak=${trnDeadStreak}`);
      }
    }
    // Stamp failed wire attempts so sibling views don't re-fire one dead URL:
    // any answered HTTP status or status-0 network death. Shapes that never
    // touched the wire (pause/quiet/cooldown/disabled/negative/not-ready)
    // stamp nothing.
    if (msg.includes('HTTP ') || isTrnNetDead(msg)) noteTrnPathFailed(path);
    // Central recording: ANY path proving private/missing notes it for ALL
    // readers (fill, views, modals, tabs, enrichment). Parsed from the path —
    // no per-callsite writer to forget.
    noteNegativeFromPath(path, msg);
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

/* ---------- small persisted caches (localStorage) -------------------- *
 * ONLY for the two KB-scale DERIVED maps below: the matchId -> TRS table and
 * the match -> player/agent TRS table. The megabyte response bodies moved to
 * `trn_cache.rs` (see the file-cache note above) because localStorage cannot
 * hold them; these fit, and a synchronous read is what makes a repeat poll
 * free. */
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

/** Returns false when the entry could NOT be persisted (quota, private
 *  mode). The caller logs it in DEV: this exact call used to swallow the
 *  failure, and a cache that silently stops persisting is the bug this whole
 *  change exists to end. */
function writePersisted<T>(key: string, data: T): boolean {
  try {
    localStorage.setItem(`${TRN_CACHE_PREFIX}:${key}`, JSON.stringify({ at: Date.now(), data }));
    return true;
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
      return true;
    } catch {
      /* private mode — memory caches still cover this session */
      return false;
    }
  }
}


/** Pure profile-path builder (riotId single-sources through this — no drift). */
export const trnProfilePath = (name: string, tag: string): string =>
  `/api/v2/valorant/standard/profile/riot/${encodeURIComponent(name)}%23${encodeURIComponent(tag)}`;

const riotId = (name: string, tag: string): string => trnProfilePath(name, tag);

/* Burst QA hammer (dev-only): 12 raw profile fetches through trnGet — one
   each of the 12 real player IDs in vault/real-players-id.md. Raw trnGet on
   purpose: no 24h cache, serial gate + cooldown intact. */
export const QA_BURST_TARGETS: { name: string; tag: string }[] = [
  { name: 'lil ga7ed', tag: 'zngr' },
  { name: 'AboHaMaDa', tag: '6611' },
  { name: 'curko', tag: '2002' },
  { name: 'Mr Kayz', tag: '000' },
  { name: 'chosen one', tag: 'kebab' },
  { name: 'brad git', tag: 'korea' },
  { name: 'wolverine', tag: 'ssss' },
  { name: 'daijun', tag: 'aim' },
  { name: 'BUBBLLY', tag: '666' },
  { name: 'ledr pa lesyk', tag: '57017' },
  { name: 'SoliDeo', tag: '2222' },
  { name: 'nadjq', tag: 'meow' },
];

/** WALL if any burst line tripped the Cloudflare ladder. Pure. */
export function burstQaVerdict(lines: string[]): 'WALL' | 'NO WALL' {
  return lines.some(
    (m) => m.includes('429') || m.includes('403') || m.includes('1015') || m.includes('RATE_LIMITED')
  )
    ? 'WALL'
    : 'NO WALL';
}

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

// Session memo for root profiles; the file cache (trn_cache.rs) is what
// survives a restart.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const profileCache = new Map<string, { at: number; data: any }>();

/* Root profiles barely change; 24h keeps restarts from re-fetching everything. */
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

/* In-memory caps. A VALORANT lobby is at most 12 players and a night is a
 * few dozen matches, so 200 keys is ~16 lobbies of slack. Over cap the
 * oldest is dropped; the file cache survives the eviction, so a player who
 * comes back is still served from disk. */
const PROFILE_CACHE_MAX = 200;
const SEASON_SEG_CACHE_MAX = 200;

/* In-flight dedup for the root profile. One refresh fires FOUR of these at
 * once for the SAME account: the current act (useTrackerData.ts:504) plus the
 * three previous acts (:540), all pushed into `enrichment` in one tick. Every
 * one of them read the empty map before any had stored, so all four went to
 * the wire — the live trace showed this one path fetched three times and
 * memo-hit twice inside 61s, because the Rust memo is only 10s and the serial
 * gate spaces the four 6-8s apart. `seasonInFlight` below is the same
 * mechanism for season segments; the root profile was simply missing it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const profileInFlight = new Map<string, Promise<any>>();

async function getRootProfile(name: string, tag: string, drain = false): Promise<any> {
  if (trnNegativeBlocked(name, tag)) throw new Error(TRN_NEGATIVE_BACKOFF);
  const key = `${name.toLowerCase()}#${tag.toLowerCase()}`;
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.data;
  const running = profileInFlight.get(key);
  if (running) return running;

  const task = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await trnGet(riotId(name, tag), {
      ...(trnDrainFor(name, tag, drain) ? { drain: true } : {}),
      // Disk-backed across restarts; the TTL rides along as the policy.
      ttlMs: PROFILE_TTL_MS,
    });
    profileCache.set(key, { at: Date.now(), data: j });
    evictOldest(profileCache, PROFILE_CACHE_MAX, (v) => v.at);
    return j;
  })();
  profileInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (profileInFlight.get(key) === task) profileInFlight.delete(key);
  }
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

// Session memo for season segments; the file cache (trn_cache.rs) is what
// survives a restart.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const seasonSegCache = new Map<string, { at: number; data: any }>();
// In-flight dedup: agents+maps+acts fan out via Promise.all for the same
// identity, and without this every cold caller fires its own trnGet.
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const seasonInFlight = new Map<string, Promise<any>>();

/** Raw season segment for any playlist/season (drives stats + agents parsing). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
/** Season segments change only when a match ends — cache them hard. */
const SEASON_SEG_TTL_MS = 24 * 60 * 60 * 1000;
/** Pinned TTL for previous acts: frozen history never revalidates. Only the
 *  current season keeps 24h (Tracker Score must track your latest games). */
const TRN_SEASON_PINNED_TTL_MS = 365 * 24 * 60 * 60 * 1000;

async function fetchSeasonSeg(name: string, tag: string, playlist: string, seasonId: string, drain = false, pinned = false): Promise<any> {
  if (trnNegativeBlocked(name, tag)) throw new Error(TRN_NEGATIVE_BACKOFF);
  const n = name.trim();
  const t = tag.trim();
  if (!n || !t) throw new Error('TRN bad riot id');
  const pl = playlist.toLowerCase();
  const sid = seasonId.toLowerCase();
  const ttl = pinned ? TRN_SEASON_PINNED_TTL_MS : SEASON_SEG_TTL_MS;
  const cacheKey = `${n.toLowerCase()}#${t.toLowerCase()}_${pl}_${sid}`;
  const hit = seasonSegCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const running = seasonInFlight.get(cacheKey);
  if (running) return running;

  const task = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await trnGet(
      `${riotId(n, t)}/segments/season?playlist=${encodeURIComponent(pl)}${seasonId ? `&seasonId=${encodeURIComponent(seasonId)}` : ''}&source=web`,
      {
        ...(trnDrainFor(n, t, drain) ? { drain: true } : {}),
        // Survive reloads: a restart must not re-request every act we already
        // hold. The TTL rides along because it is this caller's policy.
        ttlMs: ttl,
      }
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
    evictOldest(seasonSegCache, SEASON_SEG_CACHE_MAX, (v) => v.at);
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
  playlist = 'competitive',
  opts?: { drain?: boolean }
): Promise<{ stats: TrnActStats; defaultSeason: string; countryCode: string }> {
  if (trnNegativeBlocked(name, tag)) throw new Error(TRN_NEGATIVE_BACKOFF);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let seg: any = null;
  // Always fetch/pull root profile so avatarUrl and countryCode are never missing.
  // A private root (451) rethrows immediately: segments for a locked account
  // would 451 right after, so skip them and let the caller back off 7d.
  const root = await getRootProfile(name, tag, opts?.drain === true).catch((e) => {
    if (isTrnPrivateError(e)) throw e;
    return null;
  });
  const avatarUrl = String(root?.data?.platformInfo?.avatarUrl ?? '');
  const defaultSeason = String(root?.data?.metadata?.defaultSeason ?? '');
  const countryCode = String(root?.data?.userInfo?.countryCode ?? '');

  if (playlist === 'competitive') {
    seg = pickSeasonSegment(root, seasonId);
  }
  if (!seg) {
    // Pin previous acts forever: only the current season's segment changes as
    // you play (Tracker Score must track it). defaultSeason came from the root
    // profile resolved above — no extra request to decide.
    const pinned =
      !!seasonId && !!defaultSeason && seasonId.toLowerCase() !== defaultSeason.toLowerCase();
    const r = await fetchSeasonSeg(name, tag, playlist, seasonId, opts?.drain === true, pinned);
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
export async function fetchTrnAgents(name: string, tag: string, seasonId: string, playlist = 'competitive', opts?: { drain?: boolean }): Promise<TrnAgentStat[]> {
  if (trnNegativeBlocked(name, tag)) throw new Error(TRN_NEGATIVE_BACKOFF);
  const r = await fetchSeasonSeg(name, tag, playlist, seasonId, trnDrainFor(name, tag, opts?.drain === true));
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
export async function fetchTrnMaps(name: string, tag: string, seasonId: string, playlist = 'competitive', opts?: { drain?: boolean }): Promise<TrnMapStat[]> {
  if (trnNegativeBlocked(name, tag)) throw new Error(TRN_NEGATIVE_BACKOFF);
  const r = await fetchSeasonSeg(name, tag, playlist, seasonId, trnDrainFor(name, tag, opts?.drain === true));
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
/** Recent matches move a few times a day at most. */
const TRN_MATCHES_TTL_MS = 6 * 60 * 60 * 1000;

export async function fetchTrnMatches(
  name: string,
  tag: string,
  playlist = 'competitive',
  opts?: { drain?: boolean }
): Promise<Record<string, number>> {
  if (trnNegativeBlocked(name, tag)) throw new Error(TRN_NEGATIVE_BACKOFF);
  const key = `matches:${name.toLowerCase()}#${tag.toLowerCase()}:${playlist}`;
  const cached = readPersisted<Record<string, number>>(key, TRN_MATCHES_TTL_MS);
  if (cached) return cached;

  const path = `/api/v2/valorant/standard/matches/riot/${encodeURIComponent(name)}%23${encodeURIComponent(tag)}?type=${encodeURIComponent(playlist)}`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (await trnGet(path, {
      ...(trnDrainFor(name, tag, opts?.drain === true) ? { drain: true } : {}),
      ttlMs: TRN_MATCHES_TTL_MS,
    })) as any;
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
    // Never cache an empty map: a parse miss must not poison the 6h cache.
    if (Object.keys(out).length > 0 && !writePersisted(key, out) && import.meta.env.DEV) {
      trnLog('cache write refused', `localStorage ${key.slice(0, 60)}`);
    }
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
/** Past matches are immutable, so their TRS never needs revalidating. */
const TRN_MATCH_DETAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function fetchTrnMatchDetails(
  matchId: string
): Promise<Record<string, number>> {
  if (!matchId) return {};
  const key = `match_detail_trs:${matchId}`;
  const cached = readPersisted<Record<string, number>>(key, TRN_MATCH_DETAIL_TTL_MS);
  if (cached) return cached;

  const path = `/api/v2/valorant/standard/matches/${encodeURIComponent(matchId)}`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (await trnGet(path, { ttlMs: TRN_MATCH_DETAIL_TTL_MS })) as any;
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
    if (Object.keys(out).length > 0 && !writePersisted(key, out) && import.meta.env.DEV) {
      trnLog('cache write refused', `localStorage ${key.slice(0, 60)}`);
    }
    return out;
  } catch (e) {
    if (import.meta.env.DEV) logger.warn('Failed to fetch TRN match detail:', e);
    return {};
  }
}

