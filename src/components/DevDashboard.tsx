import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { FlaskConical, Play, Trash2, Radio, Coffee, Download, Copy, Activity, Terminal, ChevronDown } from 'lucide-react';
import { listen, emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import {
  fetchDisplayInfo,
  fetchGpuInfo,
  showOverlay,
  hideOverlay,
  setOverlayEditMode,
  getOverlayEditMode,
  isOverlayVisible,
  isTabDown,
  setOverlayWindowed,
  fetchWindows,
  fetchValorantConfigs,
  isTauri,
} from '../utils/ipc';
import { detectLocalAccount, getEntitlements, detectRegion, fetchCompetitiveUpdates } from '../utils/tracker';
import { TRN_PROXY_NOT_READY, TRN_PROXY_PAUSED, TRN_NET_DEAD_MARK } from '../utils/trn';
import { fetchPerf, PERF_POLL_MS, PERF_RING_CAP, type PerfTimeline, type PerfStats } from '../utils/perf';
import { debugSimulateCrash } from '../utils/consent';
import {
  DEV_MOCK_KEY,
  DEV_TAB_KEY,
  DEV_NO_CLIENT_KEY,
  getDevMockPhase,
  type DevMockPhase,
} from '../utils/devTools';

/* perf.rs serializes extra fields on every sample that src/utils/perf.ts (not
 * ours to edit) does not declare. Widened here rather than in perf.ts so the
 * basis and the CPU census travel with the numbers and the UI can refuse to
 * present a degraded total as a clean one. */
type MemBasis = 'PrivateWorkingSet' | 'ResidentWorkingSet' | 'Mixed';
interface BasisSample {
  basis?: MemBasis;
  omitted?: number;
  /** Processes the CPU % covers: backend + our whole WebView2 tree. */
  cpu_processes?: number;
  /** Tree processes whose CPU times could not be read → the % is an under-count. */
  cpu_omitted?: number;
}
/* `?.` is load-bearing, not decoration: the first render runs before the first
 * `perf_poll` lands, so the newest sample is genuinely `undefined` here, and
 * this component has no error boundary above it — a throw blanks the whole
 * dev window. The casts keep the return types; the chain keeps the runtime. */
const memBasisOf = (s: unknown): MemBasis => (s as BasisSample | undefined)?.basis ?? 'Mixed';
const memOmittedOf = (s: unknown): number => (s as BasisSample | undefined)?.omitted ?? 0;
const cpuProcsOf = (s: unknown): number => (s as BasisSample | undefined)?.cpu_processes ?? 0;
const cpuOmittedOf = (s: unknown): number => (s as BasisSample | undefined)?.cpu_omitted ?? 0;


/* Dev-only TRN transport trace. The `[TRN <ms>] …` lines the backend prints
 * to the terminal also land in a bounded Rust ring (trn_proxy.rs
 * `trn_trace_log`), so a transport bug is readable here instead of needing a
 * screenshot of the scrollback.
 *
 * 1000ms is a batching window, not a latency target. The backend emits at
 * `POLL_EVERY` (100ms) and gates readiness at `READINESS_POLL` (200ms), so a
 * 1s window coalesces a sub-300ms lifecycle (memo hit, ceiling reject, join)
 * into one appended burst instead of one line per poll. It also leaves the
 * worst-case lag between a line being emitted and being displayed at 1s,
 * which is the visible cost: a fetch that takes ~1.5s legitimately arrives as
 * two bursts. Halving to 500ms would halve that lag but still split a 1.5s
 * fetch AND double the IPC rate, and no poll interval short enough to force a
 * whole lifecycle into one batch is honest — `READINESS_TIMEOUT` is 10s and
 * `FETCH_TIMEOUT` 20s. So the ordering (monotonic `seq` + the `[TRN <ms>]`
 * stamp on every line) carries the reading, and the interval stays loose. */
const TRN_LOG_POLL_MS = 1000;
/** Lines kept on screen. The Rust ring holds 512; the newest 300 covers
 * several lobby fills without a long DOM list behind a 1s poll. */
const TRN_LOG_VIEW = 300;

interface TrnTraceLine {
  seq: number;
  text: string;
}
interface TrnTracePayload {
  /** Newest sequence held; feed back as `after` to poll incrementally. */
  head: number;
  lines: TrnTraceLine[];
  /** The ring evicted lines this panel never saw (view has a gap). */
  missed: boolean;
}

/* ---- Trace line → structured row ----------------------------------------
 * The ring hands back raw `[TRN <epoch_ms>] <body>` text, and the bodies
 * differ per transport decision (trn_proxy.rs `trn_trace!` call sites).
 * Parsing is a total function: a line it does not recognise becomes
 * `unknown` with `raw` intact, never dropped and never thrown. A log viewer
 * that quietly loses a line is worse than one that shows it verbatim — the
 * whole reason this panel exists is reading a bug off the scrollback.
 * Pure + exported so scripts/trn-log-check.ts can test it without a WebView;
 * the eslint-disable is the fast-refresh rule, not a style choice. */
/* eslint-disable react/only-export-components */

export type TrnTraceKind = 'fetch' | 'memo' | 'outcome' | 'ready' | 'cache' | 'unknown';

/** What a `CACHE …` line reports about the file cache (trn_cache.rs).
 *  `hit` is a body READ off disk — a warm start is nothing but these, and
 *  none of them costs a request. `miss` is the cold/absent/stale answer (the
 *  following `fetch start` is what says "and it was stale"). `corrupt` and
 *  `refused` are the two loud ones: a bad entry and a body over the cap. */
export type TrnCacheVerdict = 'hit' | 'miss' | 'write' | 'evict' | 'corrupt' | 'refused';

export interface TrnTraceRecord {
  seq: number;
  kind: TrnTraceKind;
  /** Epoch ms off the stamp; 0 when the line carried no parsable stamp. */
  ms: number;
  /** Everything after the stamp, trimmed. */
  body: string;
  /** The line exactly as received. The escape hatch; never dropped. */
  raw: string;
  /** Decoded, shortened path for fetch/memo/cache; the body otherwise. */
  label: string;
  path?: string;
  phase?: string;
  drain?: boolean;
  lobby?: string;
  ok?: boolean;
  status?: number;
  elapsed?: number;
  /** The page's own failure message, when the backend attached one. */
  err?: string;
  /** Set only on `cache` rows. */
  cache?: TrnCacheVerdict;
}

/** `[TRN 1790444228920] …` — anchored, so a mid-line mention never parses. */
const TRN_STAMP = /^\[TRN\s+(\d+)\]\s?([\s\S]*)$/;

/** `key=value` out of a body. `undefined` = absent, `''` = present but empty
 *  (the backend prints bare `phase=` / `lobby=` when unset, so the two must
 *  stay distinguishable). */
const kv = (body: string, key: string): string | undefined =>
  new RegExp(`(?:^|\\s)${key}=(\\S*)`).exec(body)?.[1];

const decodeSafe = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** `/…/profile/riot/lil%20ga7ed%23zngr/segments/season?fromIndex=0` →
 *  `lil ga7ed#zngr · segments/season`. Query dropped, `%20`/`%23` decoded so
 *  the player reads as a player. Full path stays in the row's tooltip.
 *  The `%23`/`#` is the discriminator (same as `trnPlayerFromPath` in
 *  trn.ts) so a `/pd/…/riot/name/tag` account path is not mistaken for one. */
export function trnPathLabel(path: string): string {
  const bare = path.split('?')[0];
  const m = /\/riot\/([^/]+)%23([^/]*)(?:\/(.*))?$/.exec(bare) ?? /\/riot\/([^/]+)#([^/]*)(?:\/(.*))?$/.exec(bare);
  if (m) {
    const who = `${decodeSafe(m[1])}#${decodeSafe(m[2])}`;
    const rest = (m[3] ?? '').replace(/\/+$/, '');
    return rest ? `${who} · ${rest}` : who;
  }
  const trimmed = bare.replace(/^\/api\/v2\/valorant\/standard\/profile/, '');
  return decodeSafe(trimmed || bare);
}

/** Parse one ring line. Never throws, never returns null. */
export function parseTrnTraceLine(seq: number, text: string): TrnTraceRecord {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  const m = TRN_STAMP.exec(raw.trim());
  const ms = m ? Number(m[1]) : 0;
  const body = (m ? m[2] : raw).trim();
  const base: TrnTraceRecord = { seq, kind: 'unknown', ms, body, raw, label: body };
  if (!Number.isFinite(ms) || ms <= 0) return base;
  try {
    // A kind badge asserts "this is one of the shapes we know". A half-line
    // does not earn one: `fetch start` with no path, or `outcome ok=` with no
    // boolean, degrades to `unknown` so the RAW badge never over-claims.
    // `fetch start` only — the sibling `fetch timeout (hung page)` must NOT
    // read as wire traffic that went out.
    const path = kv(body, 'path');
    if (/^fetch start\b/.test(body) && path) {
      const drain = kv(body, 'drain');
      return {
        ...base,
        kind: 'fetch',
        path,
        phase: kv(body, 'phase'),
        drain: drain === undefined ? undefined : drain === 'true',
        lobby: kv(body, 'lobby'),
        label: trnPathLabel(path),
      };
    }
    if (/^MEMO hit\b/.test(body) && path) return { ...base, kind: 'memo', path, label: trnPathLabel(path) };
    /* The file cache (trn_cache.rs) is a third ring, not a trn_trace! one,
     * but it uses the same `[TRN <ms>] ` prefix and the same `path=` field, so
     * it parses here unchanged. A `corrupt` miss is split out of `miss` on
     * purpose: a cold start legitimately misses everything, while a corrupt
     * entry is a fault the `errors` filter must surface. */
    if (/^CACHE (hit|miss|write|evicted|refused)\b/.test(body)) {
      const why = /reason=([\s\S]*)$/.exec(body)?.[1]?.trim() ?? '';
      const verdict: TrnCacheVerdict =
        body.startsWith('CACHE hit')
          ? 'hit'
          : body.startsWith('CACHE write')
            ? 'write'
            : body.startsWith('CACHE evicted')
              ? 'evict'
              : body.startsWith('CACHE refused')
                ? 'refused'
                : why.startsWith('corrupt')
                  ? 'corrupt'
                  : 'miss';
      return {
        ...base,
        kind: 'cache',
        cache: verdict,
        path,
        // A refusal (body over the cap) and a corrupt entry are FAULTS: their
        // reason is the whole point of the row, so it takes the cell. Every
        // other verdict shows the player, which is what you are looking for.
        label:
          verdict === 'refused' || verdict === 'corrupt'
            ? why || body
            : path
              ? trnPathLabel(path)
              : body,
      };
    }
    if (/^outcome\b/.test(body)) {
      const ok = kv(body, 'ok');
      if (ok !== 'true' && ok !== 'false') return base;
      const status = Number(kv(body, 'status'));
      const elapsed = Number(kv(body, 'elapsed_ms'));
      // `err=` is the LAST field and is the only field with spaces in it
      // (`err=NetworkError when attempting to fetch resource.`), so `kv`'s
      // `\S*` cannot read it. Without it a rejected fetch renders as
      // `status=0 101ms` and says nothing about why.
      const err = /(?:^|\s)err=([\s\S]*)$/.exec(body)?.[1]?.trim();
      return {
        ...base,
        kind: 'outcome',
        // ok/status/elapsed each get their own column, so the middle cell
        // carries the failure reason when there is one, and stays empty when
        // there is not.
        label: err ?? '',
        ok: ok === 'true',
        status: Number.isFinite(status) ? status : undefined,
        elapsed: Number.isFinite(elapsed) ? elapsed : undefined,
        err,
      };
    }
    if (/^READY\b/.test(body)) return { ...base, kind: 'ready' };
    return base;
  } catch {
    // A future body shape must not take the panel (and the dev window) with it.
    return base;
  }
}

/** `+0.4s` / `+12.8s` / `1m 04s`, measured back from the newest stamped line. */
export function formatTrnRel(ms: number, newest: number): string {
  if (!Number.isFinite(ms) || ms <= 0 || !Number.isFinite(newest) || newest <= 0) return '—';
  const d = Math.max(0, newest - ms);
  if (d < 60_000) return `+${(d / 1000).toFixed(1)}s`;
  return `${Math.floor(d / 60_000)}m ${String(Math.floor((d % 60_000) / 1000)).padStart(2, '0')}s`;
}

export type TrnTone = 'ok' | 'warn' | 'bad' | 'muted';

/** 404 and 451 are NOT transport failures: trn.ts treats both as *proven
 *  negatives* — `noteNegativeFromPath` files them for 24h (missing) / 7d
 *  (private, via `isTrnPrivateError`) so they never refire. They belong on
 *  screen (that is how you spot a locked account) but must not read red.
 *  Status 0 is the real failure: the in-page fetch never answered. */
export function trnStatusTone(status: number): TrnTone {
  if (status === 0) return 'bad';
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404 || status === 451) return 'warn';
  if (status >= 300 && status < 400) return 'muted';
  return 'bad';
}

const TONE_CLS: Record<TrnTone, string> = {
  ok: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  warn: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  bad: 'border-m3-coral/50 bg-m3-coral/10 text-m3-coral',
  muted: 'border-m3-outline-subtle bg-transparent text-m3-outline',
};

/** Badge per record. `fetch` stays neutral (it is the baseline traffic),
 *  `memo` and a `cache` hit are sky/violet because they cost nothing, and
 *  `unknown` is dashed to say "verbatim, we could not read this". */
export function trnKindBadge(r: TrnTraceRecord): { label: string; cls: string } {
  if (r.kind === 'outcome') {
    if (r.ok === true) return { label: 'OK', cls: TONE_CLS.ok };
    if (r.ok === false) return { label: 'FAIL', cls: TONE_CLS.bad };
    return { label: 'RAW', cls: TONE_CLS.muted };
  }
  if (r.kind === 'cache') {
    if (r.cache === 'refused' || r.cache === 'corrupt') return { label: 'CACHE!', cls: TONE_CLS.bad };
    if (r.cache === 'hit') return { label: 'CACHE', cls: 'border-violet-400/40 bg-violet-400/10 text-violet-300' };
    if (r.cache === 'evict' || r.cache === 'write') return { label: 'CACHE', cls: TONE_CLS.muted };
    return { label: 'MISS', cls: 'border-amber-400/40 bg-amber-400/10 text-amber-300' };
  }
  if (r.kind === 'fetch') return { label: 'FETCH', cls: 'border-m3-outline-subtle bg-m3-surface-container-low text-m3-outline' };
  if (r.kind === 'memo') return { label: 'MEMO', cls: 'border-sky-400/40 bg-sky-400/10 text-sky-300' };
  if (r.kind === 'ready') return { label: 'READY', cls: TONE_CLS.ok };
  return { label: 'RAW', cls: 'border-dashed border-zinc-600 text-zinc-500' };
}

export interface TrnTraceSummary {
  total: number;
  /** `fetch start` — the only lines that cost an actual request. */
  fetches: number;
  memos: number;
  failures: number;
  /** Bodies read off disk (file cache). NOT wire traffic — a warm launch is
   *  all of these and none of the `fetches` above. */
  cacheHits: number;
  /** Bodies that were not on disk (cold, or past their TTL). */
  cacheMisses: number;
  /** Mean of `elapsed_ms` over outcome lines that carried one; 0 = no data. */
  avgElapsed: number;
}

/** The at-a-glance answer to "is this spamming TRN", over the whole held
 *  window (not the filtered view — a filter must not flatter the numbers). */
export function summarizeTrnTrace(recs: readonly TrnTraceRecord[]): TrnTraceSummary {
  let fetches = 0;
  let memos = 0;
  let failures = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let sum = 0;
  let timed = 0;
  for (const r of recs) {
    if (r.kind === 'fetch') fetches++;
    else if (r.kind === 'memo') memos++;
    if (r.kind === 'cache') {
      if (r.cache === 'hit') cacheHits++;
      else if (r.cache === 'miss' || r.cache === 'corrupt') cacheMisses++;
    }
    if (r.kind === 'outcome') {
      if (r.ok === false) failures++;
      if (r.elapsed !== undefined) {
        sum += r.elapsed;
        timed++;
      }
    }
  }
  return {
    total: recs.length,
    fetches,
    memos,
    failures,
    cacheHits,
    cacheMisses,
    avgElapsed: timed > 0 ? Math.round(sum / timed) : 0,
  };
}

export type TrnLogFilter = 'all' | 'errors' | 'fetches' | 'nomemo' | 'cache';

const TRN_FILTERS: { id: TrnLogFilter; label: string; hint: string }[] = [
  { id: 'all', label: 'all', hint: 'every held line' },
  { id: 'errors', label: 'errors', hint: 'failed outcomes + lines this parser did not recognise' },
  { id: 'fetches', label: 'fetches', hint: 'only real wire requests' },
  { id: 'nomemo', label: 'no memo', hint: 'hide cache hits so wire traffic stands out' },
  { id: 'cache', label: 'cache', hint: 'only file-cache decisions' },
];

/** `errors` deliberately sweeps in `unknown` too: `fetch timeout`,
 *  `NOT READY`, `CEILING` and friends are exactly what a triage view must
 *  not hide, and a filter that hid them would recreate the raw-dump problem.
 *  A `CACHE refused` (body over the cap) and a `CACHE corrupt` entry are
 *  faults, and a cold `CACHE miss` is not — every launch has those. */
export function trnFilterMatch(r: TrnTraceRecord, f: TrnLogFilter): boolean {
  if (f === 'all') return true;
  if (f === 'errors') {
    return (
      (r.kind === 'outcome' && r.ok === false) ||
      r.kind === 'unknown' ||
      (r.kind === 'cache' && (r.cache === 'refused' || r.cache === 'corrupt'))
    );
  }
  if (f === 'fetches') return r.kind === 'fetch';
  if (f === 'cache') return r.kind === 'cache';
  return r.kind !== 'memo' && !(r.kind === 'cache' && r.cache === 'hit');
}

/* ---- Export: the trace this window actually holds -------------------------
 * The "Log export" panel used to read `getRecentLogs` — a MODULE-level ring
 * buffer, so there is one per WebView2 realm. The dev window is its own realm,
 * logs almost nothing, and the panel therefore always exported 0 lines and
 * still reported "copied 0 lines to clipboard" as a success. The buffer is not
 * useless, it is simply not THIS window's: it is the main window's real one,
 * and Settings (AppSettingsView) is where that belongs. A dev window wants
 * transport diagnostics, and it already holds them — the Rust ring above.
 *
 * The export is built from the same parsed records the panel renders, so what
 * you copy is what you see. Two deliberate differences from the on-screen row,
 * both in the direction of MORE information: the full untruncated path instead
 * of `trnPathLabel`'s short form, and the absolute timestamp next to the
 * relative one so a line can be matched against the terminal scrollback.
 */

/** One record as one export line. `r.path ?? r.raw` is the same fallback the
 *  row's tooltip uses, so the export can never be narrower than the screen. */
export function formatTrnTraceExport(r: TrnTraceRecord, newest: number): string {
  const when = r.ms > 0 ? new Date(r.ms).toISOString() : 'unstamped';
  const epoch = r.ms > 0 ? String(r.ms) : '-';
  const cols = [formatTrnRel(r.ms, newest).padEnd(8), when.padEnd(24), epoch.padEnd(14), r.kind.toUpperCase().padEnd(8)];
  // `path=` is kept on the full path so an exported line greps against the
  // backend's own `fetch start path=…` terminal output, which is the line
  // whoever reads the bug report will have in front of them.
  return `${cols.join(' ')} ${r.path !== undefined ? `path=${r.path}` : r.raw}`;
}

/** The newest `max` records, oldest-first, as export lines. Empty in → empty
 *  out: this never invents a line, and a caller can tell "0" from "n". */
export function buildTrnTraceExport(recs: readonly TrnTraceRecord[], max: number): string[] {
  const newest = recs.reduce((a, r) => (r.ms > a ? r.ms : a), 0);
  const n = Math.max(0, Math.trunc(max) || 0);
  return recs.slice(Math.max(0, recs.length - n)).map((r) => formatTrnTraceExport(r, newest));
}

/** What the panel says after an export. An empty export must never read as a
 *  success — that "copied 0 lines" report is the bug this whole panel had. */
export function trnExportReport(exported: number, held: number, verb: 'Copied' | 'Downloaded'): string {
  if (exported === 0) {
    return held === 0
      ? 'Nothing to export — no TRN trace lines held yet. Open the Live Match tab (or drive any TRN request) so the backend emits some, then export again.'
      : `Nothing exported — 0 of ${held} held line(s) selected. Raise the line count above 0.`;
  }
  const tail = verb === 'Copied' ? 'to clipboard' : 'as recon-trn-trace-*.txt';
  return `${verb} ${exported} line${exported === 1 ? '' : 's'} ${tail}${exported < held ? ` (of ${held} held)` : ''}`;
}
/* ---- IPC smoke tests -------------------------------------------------------
 * One click = one IPC round-trip, and the answer lands next to the button.
 *
 * Three states, not two. A command that is broken is a FAIL; a command that
 * works but whose environment is absent (no Riot Client, no tracker.gg page,
 * VALORANT owning the screen) is a PRECONDITION — rendered neutral/warn with
 * the reason. Painting those red is how a smoke panel trains its reader to
 * ignore red, at which point it catches nothing.
 *
 * Detection reuses the vocabulary the callers already throw, so a reason shown
 * here is greppable back to the call site. Pure + exported so
 * scripts/devqa-check.ts can test it without a WebView.
 */
export type SmokeOutcome = 'pass' | 'fail' | 'precondition';

/** `needle` is matched against the raw error text (case-insensitively);
 *  `reason` is what the panel shows instead of a red FAIL. */
const PRECONDITION_SHAPES: { needle: string; reason: string }[] = [
  { needle: 'Riot Client not found on this PC', reason: 'no Riot Client on this machine' },
  { needle: 'Riot Client lockfile missing', reason: 'Riot Client not running' },
  { needle: 'Unreadable lockfile', reason: 'Riot Client lockfile unreadable' },
  { needle: 'Riot Client not responding', reason: 'Riot Client not answering loopback' },
  { needle: 'No active session', reason: 'no Riot Client session — log in first' },
  { needle: 'Auto-detect failed', reason: 'Riot Client not running' },
  { needle: 'needs the desktop app', reason: 'not running inside the desktop app' },
  { needle: TRN_PROXY_NOT_READY, reason: 'no tracker.gg page loaded yet' },
  { needle: TRN_PROXY_PAUSED, reason: 'VALORANT owns the screen' },
  { needle: TRN_NET_DEAD_MARK, reason: 'proxy page has no network' },
  { needle: 'TRN_RATE_LIMITED', reason: 'TRN rate-limit ladder engaged' },
  { needle: 'TRN_DISABLED', reason: 'tracker kill-switch is OFF' },
  { needle: 'TRN_BUDGET', reason: 'shared TRN request ceiling spent' },
];

/** The absent-environment reason for `msg`, or null when this is a real
 *  failure. First match wins, so the narrow shapes stay ahead of the broad
 *  `'Riot Client …'` ones they contain. */
export function detectPrecondition(msg: string): string | null {
  const s = String(msg ?? '');
  for (const { needle, reason } of PRECONDITION_SHAPES) {
    if (s.toLowerCase().includes(needle.toLowerCase())) return reason;
  }
  return null;
}

export interface SmokeCheck {
  id: string;
  label: string;
  /** The IPC round-trip. Anything it resolves with is a pass by default. */
  run: () => Promise<unknown>;
  /** Short summary line when the payload is the shape it must be. Throw to
   *  fail, with the reason as the message. */
  expect?: (value: unknown) => string;
  /** Absent environment for a RESOLVED value (e.g. no VALORANT install, so an
   *  empty config list). Returns the reason, or null. */
  precondition?: (value: unknown) => string | null;
}

export interface SmokeGroup {
  id: string;
  label: string;
  checks: SmokeCheck[];
}

/** Shared by Display/GPU checks: a non-zero dimension means the read worked. */
function expectDisplay(v: unknown): string {
  const d = v as { current_width?: number; current_height?: number; current_hz?: number };
  if (!d || !d.current_width || !d.current_height) throw new Error('no dimensions in the payload');
  return `${d.current_width}×${d.current_height} @ ${d.current_hz ?? '?'} Hz`;
}

export const SMOKE_GROUPS: SmokeGroup[] = [
  {
    id: 'display',
    label: 'Display / GPU',
    checks: [
      { id: 'display-info', label: 'Display info', run: fetchDisplayInfo, expect: expectDisplay },
      {
        id: 'gpu-info',
        label: 'GPU info',
        run: fetchGpuInfo,
        expect: (v) => {
          const g = v as { vendor?: string; name?: string };
          if (!g?.name) throw new Error('no adapter name in the payload');
          return `${g.vendor ?? '?'} · ${g.name}`;
        },
      },
    ],
  },
  {
    id: 'overlay',
    label: 'Overlay',
    checks: [
      {
        id: 'overlay-visible',
        label: 'Visible?',
        run: isOverlayVisible,
        expect: (v) => (v === true ? 'shown' : 'hidden'),
      },
      {
        id: 'overlay-edit',
        label: 'Edit mode?',
        run: getOverlayEditMode,
        expect: (v) => (v === true ? 'editing' : 'locked'),
      },
      { id: 'overlay-tab', label: 'Tab down?', run: isTabDown, expect: (v) => (v === true ? 'held' : 'up') },
      {
        id: 'overlay-show',
        label: 'Open',
        run: async () => {
          await showOverlay();
          return isOverlayVisible();
        },
        // Read back instead of trusting the ack: a show that silently fails is
        // the exact bug this panel exists for.
        expect: (v) => {
          if (v !== true) throw new Error('ack returned but the window is not visible');
          return 'visible';
        },
      },
      {
        id: 'overlay-hide',
        label: 'Close',
        run: async () => {
          await hideOverlay();
          return isOverlayVisible();
        },
        expect: (v) => {
          if (v !== false) throw new Error('ack returned but the window is still visible');
          return 'hidden';
        },
      },
      {
        id: 'overlay-edit-on',
        label: 'Edit mode ON',
        run: async () => {
          await setOverlayEditMode(true);
          return getOverlayEditMode();
        },
        expect: (v) => {
          if (v !== true) throw new Error('ack returned but edit mode is off');
          return 'editing';
        },
      },
      {
        id: 'overlay-edit-off',
        label: 'Edit mode OFF',
        run: async () => {
          await setOverlayEditMode(false);
          return getOverlayEditMode();
        },
        expect: (v) => {
          if (v !== false) throw new Error('ack returned but edit mode is still on');
          return 'locked';
        },
      },
    ],
  },
  {
    id: 'windows',
    label: 'Windows',
    checks: [
      {
        id: 'window-list',
        label: 'Window list',
        run: fetchWindows,
        expect: (v) => {
          const w = v as { title?: string }[];
          if (!Array.isArray(w)) throw new Error('not an array');
          return `${w.length} top-level window(s)`;
        },
      },
    ],
  },
  {
    id: 'valorant',
    label: 'VALORANT',
    checks: [
      {
        id: 'valorant-configs',
        label: 'Game configs',
        run: fetchValorantConfigs,
        // An empty list is the game not being installed — absent, not broken.
        precondition: (v) => (Array.isArray(v) && v.length === 0 ? 'no VALORANT install found' : null),
        expect: (v) => {
          const c = v as { display_name?: string }[];
          if (!Array.isArray(c) || c.length === 0) throw new Error('no config files');
          return c.length === 1 ? `1 file · ${c[0].display_name ?? '?'}` : `${c.length} files`;
        },
      },
      {
        id: 'valorant-account',
        label: 'Local account',
        run: detectLocalAccount,
        expect: (v) => {
          const a = v as { game_name?: string; tagline?: string; puuid?: string };
          if (!a?.game_name) throw new Error('no account name in the payload');
          return `${a.game_name}#${a.tagline ?? '????'} · ${a.puuid ? `${a.puuid.slice(0, 8)}…` : 'no puuid'}`;
        },
      },
    ],
  },
  {
    id: 'transport',
    label: 'Transport',
    checks: [
      {
        id: 'transport-session',
        label: 'Client session (loopback)',
        run: getEntitlements,
        expect: (v) => {
          const e = v as { puuid?: string };
          if (!e?.puuid) throw new Error('no puuid in the payload');
          return `session for ${e.puuid.slice(0, 8)}…`;
        },
      },
      {
        id: 'transport-riot-get',
        label: 'Riot GET (riot_http)',
        run: async () => {
          // Real existing entry point: resolves the region from the live token,
          // then auths one read-only MMR route through `riot_direct_get`.
          const rows = await fetchCompetitiveUpdates(await detectRegion(), 1);
          return { rows: rows.length, sample: rows[0] ?? null };
        },
        expect: (v) => {
          const r = v as { rows?: number };
          if (typeof r?.rows !== 'number') throw new Error('no competitive update list');
          return r.rows > 0 ? `${r.rows} match(es) returned` : 'answered with an empty list';
        },
      },
    ],
  },
  {
    id: 'diag',
    label: 'Diagnostics',
    checks: [
      {
        id: 'diag-perf',
        label: 'perf_poll',
        // Direct invoke, NOT `fetchPerf`: that helper swallows the rejection to
        // `null`, and a broken command would then read as an empty timeline.
        run: () => invoke<PerfTimeline>('perf_poll'),
        expect: (v) => {
          const tl = v as PerfTimeline;
          if (!tl || !Array.isArray(tl.samples)) throw new Error('no timeline in the payload');
          if (tl.samples.length === 0) throw new Error('timeline is empty — the poll pushed no sample');
          const basis = memBasisOf(tl.samples[tl.samples.length - 1]);
          // A fallback basis is a real finding, not something to normalise away.
          if (basis !== 'PrivateWorkingSet') throw new Error(`basis ${basis} — the private counter was not read`);
          return `${tl.samples.length} samples · basis ${basis}${tl.paused ? ' · paused' : ''}`;
        },
      },
      {
        id: 'diag-proxy-state',
        label: 'Proxy state',
        // `trnProxyState()` would answer UNKNOWN for both "no fetch yet" and
        // "the command is gone", so this reads the raw string.
        run: () => invoke<string>('trn_proxy_state'),
        expect: (v) => {
          const s = String(v ?? '');
          if (!/^(READY|CHALLENGED|RECREATED|PAUSED|UNKNOWN)$/.test(s)) throw new Error(`unrecognised state ${JSON.stringify(s)}`);
          return s === 'UNKNOWN' ? 'UNKNOWN — no proxy fetch yet' : s;
        },
      },
      {
        id: 'diag-proxy-paused',
        label: 'Proxy paused?',
        run: () => invoke<boolean>('trn_proxy_paused', { phase: null }),
        expect: (v) => (v === true ? 'paused (game fullscreen)' : 'not paused'),
      },
      {
        id: 'diag-trace',
        label: 'Trace log',
        run: () => invoke<TrnTracePayload>('trn_trace_log', { after: 0 }),
        expect: (v) => {
          const t = v as TrnTracePayload | null;
          if (!t || typeof t.head !== 'number' || !Array.isArray(t.lines)) throw new Error('no head/lines in the payload');
          // An empty ring is valid: no TRN traffic has happened yet.
          return `head ${t.head} · ${t.lines.length} held line(s)${t.missed ? ' · ring overwrote unseen lines' : ''}`;
        },
      },
    ],
  },
];

export const SMOKE_CHECK_COUNT = SMOKE_GROUPS.reduce((n, g) => n + g.checks.length, 0);

/** `running` is the in-flight placeholder; it carries no ms/summary. */
export type SmokeResult = {
  outcome: SmokeOutcome | 'running';
  /** Wall time of the round-trip. 0 while running. */
  ms: number;
  /** One line: the `expect` summary, or the precondition reason. */
  summary: string;
  /** Raw error text, only on a fail. */
  detail: string;
  /** Wall clock of the last run, so a stale row is visible. */
  at: number;
  /** How many times this check has run — a fresh row beats a fresh-looking one. */
  runs: number;
};

export interface SmokeTally {
  pass: number;
  fail: number;
  precondition: number;
}

/** Pass / fail / precondition counts. An empty list tallies all zeroes, which
 *  renders as "not run yet" — never as a clean sweep. */
export function tallySmoke(outcomes: readonly SmokeOutcome[]): SmokeTally {
  let pass = 0;
  let fail = 0;
  let precondition = 0;
  for (const o of outcomes) {
    if (o === 'pass') pass++;
    else if (o === 'fail') fail++;
    else precondition++;
  }
  return { pass, fail, precondition };
}

/** The one-word verdict: a failure always wins, and an unmet precondition is
 *  never quietly folded into the pass count. */
export function smokeVerdict(t: SmokeTally): string {
  if (t.pass + t.fail + t.precondition === 0) return 'no results yet';
  if (t.fail > 0) return `${t.fail} FAILED`;
  if (t.pass === 0) return 'nothing passed';
  return t.precondition > 0 ? `PASS with ${t.precondition} unmet` : 'ALL PASS';
}
/* eslint-enable react/only-export-components */

const fmtClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/* Read through module-scope helpers: `performance.now`/`Date.now` are impure,
 * and the react purity rule only reasons about calls inside a component body.
 * The clock is genuinely read at click time, not render time. */
const nowMs = (): number => performance.now();
const wallClock = (): number => Date.now();

/* Performance timeline chart (dev-only): hand-rolled SVG, zero chart deps.
 * 720 points max at a 5s cadence is far below Canvas territory (uPlot/ECharts
 * earn their weight past ~10k points or 60fps streams), so SVG keeps full
 * M3-theme control with negligible update cost (one small subtree per poll).
 * Axes + grid, gradient area, hover crosshair with values, spike dots.
 *
 * The plot box is MEASURED, not a fixed viewBox scaled by CSS. A viewBox would
 * keep the aspect ratio (no distortion) but would scale the 8px axis labels
 * and 1.5px strokes with it — legible at 320px, comically large once a widescreen
 * window hands the same chart 600px. Measuring keeps the SVG at 1:1 device
 * pixels, so the type and line weights are what they were authored to be at
 * every width, and the height only grows to 200 so a wide panel gets a wider
 * timeline instead of a taller one. */
const PerfChart: React.FC<{
  label: string;
  values: number[];
  times: number[];
  stats: PerfStats | undefined;
  color: string;
  fmt: (v: number) => string;
  /** Fixed y-domain (shared across stacked series so they compare 1:1). */
  domain?: [number, number];
  /** Thinner underlay lines on the same scale (e.g. total parts). */
  overlay?: { values: number[]; color: string; width?: number }[];
  /** Color key for the overlay lines. */
  legend?: { color: string; text: string }[];
}> = ({ label, values, times, stats, color, fmt, domain, overlay, legend }) => {
  const [hover, setHover] = useState<number | null>(null);
  const gradId = `perf-${useId().replace(/:/g, '')}`;
  const n = values.length;

  const box = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(320);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      if (w > 0) setBoxW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = boxW;
  const H = Math.round(Math.min(200, Math.max(120, W * 0.375)));
  const padL = 38;
  const padR = 8;
  const padT = 8;
  const padB = 16;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const lo = domain ? domain[0] : n > 0 ? Math.min(...values) : 0;
  const hi = domain ? domain[1] : n > 0 ? Math.max(...values) : 0;
  // Padded domain keeps the line off the frame; grid labels stay on real data.
  const rawSpan = hi - lo || 1;
  const dLo = lo - rawSpan * 0.08;
  const dHi = hi + rawSpan * 0.08;
  const dSpan = dHi - dLo || 1;
  const x = (i: number): number => (n <= 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const y = (v: number): number => padT + plotH - ((v - dLo) / dSpan) * plotH;

  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const baseY = padT + plotH;
  const area = n > 0 ? `${padL},${baseY} ${points} ${padL + plotW},${baseY}` : '';

  // Spikes: mean + 2σ, falling back to the max so a wavy line still names one.
  const mean = n > 0 ? values.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 0 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0;
  let spikes = values.map((v, i) => (v > mean + 2 * sd ? i : -1)).filter((i) => i >= 0);
  // `n > 0` is required: a caller-supplied `domain` (the MEM chart's [0, hi])
  // makes `hi > lo` true on an empty ring, and `values.indexOf(hi)` is then -1 —
  // a phantom "1 spike" on a chart that has no samples at all.
  if (n > 0 && spikes.length === 0 && hi > lo) spikes = [values.indexOf(hi)];

  const gridVals = n > 0 ? [hi, (hi + lo) / 2, lo] : [];
  const tEnd = times.length === n && n > 0 && times[n - 1] > 0 ? times[n - 1] * 1000 : 0;
  const tStart = times.length === n && n > 0 && times[0] > 0 ? times[0] * 1000 : 0;

  const hov = hover != null && hover >= 0 && hover < n ? hover : null;

  return (
    <div className="rounded-xl bg-zinc-950/80 border border-white/10 p-2.5">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider" style={{ color }}>
          {label}
          {spikes.length > 0 && (
            <span className="ml-1.5 normal-case font-semibold text-rose-400/90">
              · {spikes.length} spike{spikes.length === 1 ? '' : 's'}
            </span>
          )}
        </span>
        <span className="text-sm font-mono font-bold text-zinc-100 tabular-nums">
          {stats ? fmt(stats.current) : '—'}
        </span>
      </div>
      {legend && legend.length > 0 && (
        <div className="flex gap-2.5 mb-1 text-[9px] font-mono text-zinc-400">
          {legend.map((l) => (
            <span key={l.text} className="flex items-center gap-1">
              <i className="w-2 h-[3px] rounded-full inline-block" style={{ background: l.color }} />
              {l.text}
            </span>
          ))}
        </div>
      )}
      <div className="relative" ref={box}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label={`${label} timeline`}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {gridVals.map((g) => (
            <g key={g}>
              <line x1={padL} x2={W - padR} y1={y(g)} y2={y(g)} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
              <text x={padL - 4} y={y(g) + 3} textAnchor="end" fontSize="8" fontFamily="ui-monospace, monospace" fill="#71717a">
                {fmt(g)}
              </text>
            </g>
          ))}
          {tStart > 0 && tEnd > 0 && (
            <g fontSize="8" fontFamily="ui-monospace, monospace" fill="#52525b">
              <text x={padL} y={H - 4}>{fmtClock(tStart)}</text>
              <text x={padL + plotW / 2} y={H - 4} textAnchor="middle">{fmtClock((tStart + tEnd) / 2)}</text>
              <text x={W - padR} y={H - 4} textAnchor="end">now</text>
            </g>
          )}
          {n === 0 ? (
            <text x={padL + plotW / 2} y={padT + plotH / 2} textAnchor="middle" fontSize="9" fontFamily="ui-monospace, monospace" fill="#52525b">
              waiting for samples…
            </text>
          ) : (
            <>
              <polygon points={area} fill={`url(#${gradId})`} />
              {(overlay ?? []).map((o, k) => (
                <polyline
                  key={k}
                  points={o.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
                  fill="none"
                  stroke={o.color}
                  strokeWidth={o.width ?? 1.25}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity="0.9"
                />
              ))}
              <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
              {spikes.map((i) => (
                <circle key={i} cx={x(i)} cy={y(values[i])} r="2.5" fill="#f87171" stroke="#09090b" strokeWidth="1" />
              ))}
              {hov != null && (
                <g>
                  <line x1={x(hov)} x2={x(hov)} y1={padT} y2={baseY} stroke="rgba(255,255,255,0.35)" strokeWidth="1" strokeDasharray="3 2" />
                  <circle cx={x(hov)} cy={y(values[hov])} r="3.5" fill={color} stroke="#09090b" strokeWidth="1.5" />
                </g>
              )}
              <rect
                x={padL}
                y={padT}
                width={plotW}
                height={plotH}
                fill="transparent"
                onMouseMove={(e) => {
                  // rect IS the plot area (x=padL, width=plotW) — map within it directly.
                  const rect = e.currentTarget.getBoundingClientRect();
                  const i = Math.round(((e.clientX - rect.left) / rect.width) * (n - 1));
                  setHover(Math.max(0, Math.min(n - 1, i)));
                }}
                onMouseLeave={() => setHover(null)}
              />
            </>
          )}
        </svg>
        {hov != null && (
          <div
            className="absolute top-0 px-1.5 py-0.5 rounded-md bg-zinc-900 border border-white/15 text-[10px] font-mono text-zinc-100 whitespace-nowrap pointer-events-none shadow-lg"
            style={{ left: `${(x(hov) / W) * 100}%`, transform: x(hov) > W - 70 ? 'translate(-100%, -110%)' : 'translate(-50%, -110%)' }}
          >
            {fmt(values[hov])}
            {times.length === n && times[hov] > 0 && <span className="text-zinc-400"> · {fmtClock(times[hov] * 1000)}</span>}
          </div>
        )}
      </div>
      <div className="mt-1 flex gap-3 text-[10px] font-mono text-zinc-400 tabular-nums">
        <span>min {stats ? fmt(stats.min) : '—'}</span>
        <span>max {stats ? fmt(stats.max) : '—'}</span>
        <span>avg {stats ? fmt(stats.avg) : '—'}</span>
      </div>
    </div>
  );
};

/**
 * DEV-BUILDS ONLY dashboard (never reachable in release: the Sidebar entry
 * and App route are both gated on IS_DEV). Test overlay + tracker flows
 * with zero Riot dependency: canned matches, Tab override, client-closed
 * simulation, raw IPC smoke tests, and a live backend event log.
 */
export const DevDashboard: React.FC = () => {
  const [phase, setPhase] = useState<DevMockPhase>(() => getDevMockPhase());
  const [tabHeld, setTabHeld] = useState(() => {
    try {
      return localStorage.getItem(DEV_TAB_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [noClient, setNoClient] = useState(() => {
    try {
      return localStorage.getItem(DEV_NO_CLIENT_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [events, setEvents] = useState<{ t: string; name: string; payload: string }[]>([]);
  const [windowed, setWindowed] = useState(false);

  /* IPC smoke tests: per-check outcome, plus a run lock for "Run all". */
  const [smoke, setSmoke] = useState<Record<string, SmokeResult>>({});
  const [smokeRunning, setSmokeRunning] = useState(false);
  const [smokeProgress, setSmokeProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [logLines, setLogLines] = useState(200);
  const [logOut, setLogOut] = useState('');

  /* Derived, never stored: re-running one check must not leave a "Run all"
   * verdict standing next to a fresher, contradicting row. Only settled rows
   * count, so the tally fills in as the sweep goes. */
  const smokeTally = useMemo<SmokeTally | null>(() => {
    const settled = SMOKE_GROUPS.flatMap((g) => g.checks)
      .map((c) => smoke[c.id])
      .filter((r): r is SmokeResult & { outcome: SmokeOutcome } => !!r && r.outcome !== 'running')
      .map((r) => r.outcome);
    return settled.length > 0 ? tallySmoke(settled) : null;
  }, [smoke]);

  /* TRN transport trace: incremental poll of the backend ring. The cursor is
   * a ref, so no render is caused by the poll itself, and the dev gate is
   * static so a prod build drops the whole thing. */
  const [trnLogOpen, setTrnLogOpen] = useState(true);
  const [trnLogLines, setTrnLogLines] = useState<TrnTraceLine[]>([]);
  /* The file cache (trn_cache.rs) keeps its own ring — `trn_trace!` and its
   * ring are private to trn_proxy.rs — so it is polled separately and merged
   * by timestamp below. Same line shape, same `after` cursor. */
  const [trnCacheLines, setTrnCacheLines] = useState<TrnTraceLine[]>([]);
  const [trnLogMissed, setTrnLogMissed] = useState(false);
  const [trnLogErr, setTrnLogErr] = useState('');
  const [trnLogFilter, setTrnLogFilter] = useState<TrnLogFilter>('all');
  const trnLogAfter = useRef(0);
  const trnCacheAfter = useRef(0);
  const trnLogBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let alive = true;
    // `document.hidden` is always false in this window — even native-hidden —
    // so the Tauri focus events are the real visibility gate. `focused` lives
    // in this closure (like `alive`): the tick and the listeners share it.
    let focused = true;
    const tick = async (): Promise<void> => {
      // Hidden-tab or collapsed-section skip: exact 1000ms cadence kept
      // when the trace panel is visible. Cursors stay put, so expanding or
      // refocusing never refetches or loses lines.
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!focused) return;
      if (!trnLogOpen) return;
      try {
        const r = await invoke<TrnTracePayload | null>('trn_trace_log', { after: trnLogAfter.current });
        // `!r` before any field read: a null payload would throw out of the
        // tick, past this catch, and blank the window like the perf accessor did.
        if (!alive || !r) return;
        trnLogAfter.current = r.head;
        setTrnLogErr('');
        setTrnLogMissed(r.missed);
        if (r.lines.length > 0) {
          setTrnLogLines((prev) => [...prev, ...r.lines].slice(-TRN_LOG_VIEW));
        }
      } catch (e) {
        if (!alive) return;
        // The command is only live once `trn_proxy::trn_trace_log` sits in
        // lib.rs's invoke_handler. Name that instead of leaving a permanently
        // empty box that reads as "no TRN traffic".
        const msg = e instanceof Error ? e.message : String(e);
        setTrnLogErr(
          !isTauri()
            ? 'open the desktop app (tauri dev) — the trace ring lives in the backend'
            : /not found|unknown/i.test(msg)
              ? `not registered yet — add trn_proxy::trn_trace_log to the lib.rs invoke_handler · ${msg}`
              : msg
        );
      }
      // Cache ring: polled after (never inside) the try above, so a
      // not-yet-registered cache command cannot take the transport ring's
      // lines down with it. Its own failure is simply no cache lines.
      try {
        const c = await invoke<TrnTracePayload | null>('trn_cache_trace_log', { after: trnCacheAfter.current });
        if (!alive || !c) return;
        trnCacheAfter.current = c.head;
        setTrnLogMissed((m) => m || c.missed);
        if (c.lines.length > 0) {
          setTrnCacheLines((prev) => [...prev, ...c.lines].slice(-TRN_LOG_VIEW));
        }
      } catch {
        /* cache ring unavailable — the transport ring above still works */
      }
    };
    void tick();
    // Immediate tick on return (OverlayView visibilitychange pattern) so a
    // burst emitted while hidden/collapsed shows at once, not after 1s.
    const onVis = () => {
      if (focused && typeof document !== 'undefined' && !document.hidden) void tick();
    };
    const onTauriFocus = () => {
      focused = true;
      onVis();
    };
    const onTauriBlur = () => {
      focused = false;
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVis);
      window.addEventListener('focus', onVis);
    }
    const stops: (() => void)[] = [];
    listen('tauri://focus', onTauriFocus)
      .then((fn) => stops.push(fn))
      .catch(() => {});
    listen('tauri://blur', onTauriBlur)
      .then((fn) => stops.push(fn))
      .catch(() => {});
    const id = setInterval(() => void tick(), TRN_LOG_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
      stops.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('focus', onVis);
      }
    };
  }, [trnLogOpen]);
  /* Parse once per append, not once per render: keyed on the line arrays
   * themselves (a fresh array every poll), so a filter toggle or a hover never
   * re-parses 300 lines, and the next poll does not defeat the memo either.
   * The two rings are merged on the epoch stamp, and their sequence numbers
   * are folded to disjoint ranges (`*2` / `*2+1`) because each ring counts
   * from 1 on its own and the row key has to stay unique across both. */
  const trnLogRows = useMemo(
    () =>
      [
        ...trnLogLines.map((l) => parseTrnTraceLine(l.seq * 2, l.text)),
        ...trnCacheLines.map((l) => parseTrnTraceLine(l.seq * 2 + 1, l.text)),
      ].sort((a, b) => a.ms - b.ms),
    [trnLogLines, trnCacheLines],
  );
  const trnLogNewest = useMemo(() => trnLogRows.reduce((a, r) => (r.ms > a ? r.ms : a), 0), [trnLogRows]);
  /* Summary covers the whole held window, not the filtered view — the point
   * is "how many requests actually went out", and a filter must not flatter it. */
  const trnLogSummary = useMemo(() => summarizeTrnTrace(trnLogRows), [trnLogRows]);
  const trnLogShown = useMemo(() => trnLogRows.filter((r) => trnFilterMatch(r, trnLogFilter)), [trnLogRows, trnLogFilter]);
  /* Terminal-style: stick to the newest line while new ones arrive, on
   * expand (the box is unmounted while collapsed), and on a filter swap. */
  useEffect(() => {
    const el = trnLogBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [trnLogRows, trnLogOpen, trnLogFilter]);

  /* Performance: own-process RAM/CPU timeline (dev-only backend ring: 5s
   * cadence, 1h window, pauses while VALORANT owns the screen). The
   * `import.meta.env.DEV` gate is static so prod dead-code-eliminates the
   * poll entirely — same convention as trnLog call sites. */
  const [perf, setPerf] = useState<PerfTimeline | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let alive = true;
    // Same gate as the trace poll above: `document.hidden` lies in this
    // window, so Tauri focus is what pauses the 5s poll behind the game.
    let focused = true;
    const tick = async (): Promise<void> => {
      // Hidden-tab skip: exact 5000ms cadence kept when visible. The perf
      // section has no collapse toggle, so visibility is the only gate.
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!focused) return;
      const tl = await fetchPerf();
      if (alive && tl) setPerf(tl);
    };
    void tick();
    // Immediate tick on return (OverlayView visibilitychange pattern) so the
    // charts never sit a full interval stale.
    const onVis = () => {
      if (focused && typeof document !== 'undefined' && !document.hidden) void tick();
    };
    const onTauriFocus = () => {
      focused = true;
      onVis();
    };
    const onTauriBlur = () => {
      focused = false;
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVis);
      window.addEventListener('focus', onVis);
    }
    const stops: (() => void)[] = [];
    listen('tauri://focus', onTauriFocus)
      .then((fn) => stops.push(fn))
      .catch(() => {});
    listen('tauri://blur', onTauriBlur)
      .then((fn) => stops.push(fn))
      .catch(() => {});
    const id = setInterval(() => void tick(), PERF_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
      stops.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('focus', onVis);
      }
    };
  }, []);
  /* Shared y-domain for the memory chart so total/backend/views compare 1:1. */
  const perfSamples = perf?.samples ?? [];
  const perfMemHi = Math.max(1, ...perfSamples.map((s) => s.total_mb));
  const perfMemDom: [number, number] = [0, perfMemHi];
  /* Basis of the newest sample — the number currently on screen. Never assumed,
   * and never read at all before the first sample lands: an empty ring has no
   * basis, which is a third state, not a degraded one. */
  const perfHasSamples = perfSamples.length > 0;
  const perfLast = perfHasSamples ? perfSamples[perfSamples.length - 1] : undefined;
  const perfBasis = memBasisOf(perfLast);
  const perfOmitted = memOmittedOf(perfLast);
  const perfDegraded = perfHasSamples && perfBasis !== 'PrivateWorkingSet';
  const perfBasisLabel = !perfHasSamples
    ? 'waiting for first sample'
    : perfBasis === 'PrivateWorkingSet'
      ? 'private working set'
      : perfBasis === 'ResidentWorkingSet'
        ? 'full working set (DEGRADED)'
        : 'MIXED bases (DEGRADED)';
  /* CPU census, same shape: an unreadable process makes the percentage an
   * UNDER-count, and the gap is named instead of being folded in as an idle
   * process. `cpu_processes` is the set the claim covers — backend + tree, the
   * same set `webview_mb` claims. */
  const perfCpuProcs = cpuProcsOf(perfLast);
  const perfCpuOmitted = cpuOmittedOf(perfLast);
  const perfCpuDegraded = perfHasSamples && perfCpuOmitted > 0;
  const perfCpuBasisLabel = !perfHasSamples
    ? 'waiting for first sample'
    : perfCpuDegraded
      ? `PARTIAL ${perfCpuProcs - perfCpuOmitted}/${perfCpuProcs} read`
      : `${perfCpuProcs} processes`;

  /* One check = one round-trip, judged in this order: absent environment →
   * throw (fail) → resolved. `runs` and the clock make a stale row obvious. */
  const executeSmoke = async (check: SmokeCheck): Promise<SmokeResult & { outcome: SmokeOutcome }> => {
    const t0 = nowMs();
    const at = wallClock();
    const ms = () => Math.round(nowMs() - t0);
    const base = { runs: (smoke[check.id]?.runs ?? 0) + 1, at };
    try {
      const value = await check.run();
      const absent = check.precondition?.(value) ?? null;
      if (absent) return { ...base, outcome: 'precondition', ms: ms(), summary: absent, detail: '' };
      return {
        ...base,
        outcome: 'pass',
        ms: ms(),
        summary: check.expect?.(value) ?? 'ok',
        // Kept, not just summarised: the row truncates, so the inspector is the
        // only way to actually read what came back.
        detail: JSON.stringify(value, null, 1)?.slice(0, 1500) ?? '',
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const absent = detectPrecondition(msg);
      return {
        ...base,
        outcome: absent ? 'precondition' : 'fail',
        ms: ms(),
        summary: absent ?? 'failed',
        detail: msg.slice(0, 400),
      };
    }
  };

  /* One row: mark running, round-trip, land the result. Shared by the single
   * button and the sweep, so the two can never drift. The click-time `smoke`
   * read is the right baseline — a sweep visits each check exactly once. */
  const runOne = async (check: SmokeCheck): Promise<void> => {
    setSmoke((prev) => ({ ...prev, [check.id]: { ...prev[check.id], outcome: 'running' } as SmokeResult }));
    const res = await executeSmoke(check);
    setSmoke((prev) => ({ ...prev, [check.id]: res }));
  };

  /* Sequential on purpose: these touch real system state (overlay show/hide,
   * edit mode, window focus). Concurrent calls would interleave a show with a
   * hide and the read-backs would lie. */
  const runAllSmoke = async (): Promise<void> => {
    if (smokeRunning) return;
    const flat = SMOKE_GROUPS.flatMap((g) => g.checks);
    setSmokeRunning(true);
    try {
      for (let i = 0; i < flat.length; i++) {
        setSmokeProgress({ done: i, total: flat.length, label: flat[i].label });
        await runOne(flat[i]);
      }
    } finally {
      setSmokeProgress(null);
      setSmokeRunning(false);
    }
  };

  /* Export the trace THIS window holds, not the module-level logger ring (see
   * the export note above): `trnLogRows` is the parsed view the panel renders,
   * so copy and download carry exactly those records, full paths included. */
  const exportLines = (): string[] => buildTrnTraceExport(trnLogRows, Math.max(1, Math.min(logLines || 200, TRN_LOG_VIEW)));

  const downloadLogs = (): void => {
    const lines = exportLines();
    if (lines.length === 0) {
      setLogOut(trnExportReport(0, trnLogRows.length, 'Downloaded'));
      return;
    }
    try {
      const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `recon-trn-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setLogOut(trnExportReport(lines.length, trnLogRows.length, 'Downloaded'));
    } catch (e) {
      setLogOut(`download failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /* `execCommand` fallback, used when the async clipboard is unusable. */
  const copyViaTextarea = (text: string): boolean => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  };

  /* The ORDERING here is the whole fix, and it came out of a measurement rather
   * than a reading of the docs. `navigator.clipboard.writeText` does not merely
   * fail when the document is unfocused — it RESOLVES, having written nothing.
   * Measured live on this dev window: `await writeText(...)` returned success,
   * the panel reported "Copied 21 lines to clipboard", and the system
   * clipboard was still empty. A missing-API check cannot see that. So when the
   * document has focus, take the modern API (falling back if it rejects); when
   * it does not, go straight to the synchronous textarea route, which does
   * reach the clipboard in that state. Verified: the textarea path put
   * CLIPBOARD_PROBE_12345 on the real Windows clipboard from the same unfocused
   * window. */
  const copyText = async (text: string): Promise<boolean> => {
    if (document.hasFocus() && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        /* rejected — fall through to the synchronous route */
      }
    }
    return copyViaTextarea(text);
  };

  const copyLogs = async (): Promise<void> => {
    const lines = exportLines();
    if (lines.length === 0) {
      setLogOut(trnExportReport(0, trnLogRows.length, 'Copied'));
      return;
    }
    try {
      if (!(await copyText(lines.join('\n')))) {
        setLogOut(
          `Copy blocked — the webview would not take it. Select the text from the trace panel above, or use Download .txt instead (${lines.length} line${lines.length === 1 ? '' : 's'} ready).`
        );
        return;
      }
      setLogOut(trnExportReport(lines.length, trnLogRows.length, 'Copied'));
    } catch (e) {
      setLogOut(`copy failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const pickPhase = (p: DevMockPhase) => {
    try {
      if (p === 'off') localStorage.removeItem(DEV_MOCK_KEY);
      else localStorage.setItem(DEV_MOCK_KEY, p);
    } catch {}
    setPhase(p);
  };

  const flip = (key: string, cur: boolean, set: (v: boolean) => void) => {
    const next = !cur;
    try {
      if (next) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
    } catch {}
    set(next);
  };

  useEffect(() => {
    const names = ['overlay-edit-mode-changed', 'overlay-config-changed', 'display-mode-changed', 'auto-borderless-applied'];
    let alive = true;
    const stops: (() => void)[] = [];
    for (const n of names) {
      listen<unknown>(n, (ev) => {
        if (!alive) return;
        const t = new Date().toLocaleTimeString();
        setEvents((prev) =>
          [{ t, name: n, payload: JSON.stringify(ev.payload)?.slice(0, 220) ?? '' }, ...prev].slice(0, 30)
        );
      })
        .then((fn) => stops.push(fn))
        .catch(() => {});
    }
    return () => {
      alive = false;
      stops.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
    };
  }, []);

  const phases: { id: DevMockPhase; label: string }[] = [
    { id: 'off', label: 'Off (real client)' },
    { id: 'pregame', label: 'Agent Select 5v5' },
    { id: 'coregame', label: 'In Match 5v5' },
    { id: 'deathmatch', label: 'Deathmatch' },
  ];

  return (
    /* `bg-m3-surface` is the main window's page colour (App.tsx: `h-screen
     * w-screen bg-m3-surface`, index.css `body { @apply bg-m3-surface }`) and
     * the ONLY colour behind every other view. It has to be repeated here:
     * index.html forces `html,body` transparent for the overlay window, so a
     * dashboard that paints nothing shows the native window background — the
     * dev window is built with no `backgroundColor`, i.e. plain white.
     *
     * No max-width: the dev window is 16:9 (1920×1080, lib.rs
     * `build_dev_window`), and a centred 72rem cap wasted the sides of it.
     * Panels tile in a responsive grid instead, `items-start` so a short panel
     * never stretches to match a tall neighbour. */
    <div className="h-full min-h-0 flex flex-col gap-3.5 w-full overflow-y-auto custom-scrollbar bg-m3-surface px-4 sm:px-5 py-3.5 pb-10">
      <div className="flex items-center gap-2.5 shrink-0">
        <span className="w-8 h-8 rounded-2xl bg-amber-400/15 border border-amber-400/40 flex items-center justify-center">
          <FlaskConical className="w-4 h-4 text-amber-300" />
        </span>
        <div>
          <h2 className="font-display font-black text-m3-on-surface leading-tight">Dev Dashboard</h2>
          <p className="text-[11px] text-m3-outline">Dev builds only — test overlay + tracker with no Riot open. Live views pick up simulators on next poll.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-3.5 items-start w-full min-w-0">
      {/* Performance (dev-only own-process timeline) — first: the canary for every QA session */}
      <section className="xl:col-span-2 2xl:col-span-3 rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-4 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-1">
          <h4 className="font-display font-bold text-sm text-m3-on-surface flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-m3-primary" />
            <span>Performance</span>
          </h4>
          <span className="text-[10px] font-mono text-m3-outline text-right">
            {perf ? `${perf.samples.length}/${PERF_RING_CAP} samples · 5s cadence · 1h ring` : 'dev-only · open the desktop app for live samples'}
            {perf?.paused ? ' · paused (game fullscreen)' : ''}
          </span>
        </div>
        <p className="text-[11px] text-m3-outline mb-2.5">
          Recon&apos;s full footprint: <span className="text-m3-on-surface font-semibold">private working set</span> summed over the
          backend + <span className="text-m3-on-surface font-semibold">every WebView2 process in our own tree</span> (browser host, GPU,
          renderers, network/storage utility services, crashpad) — tree-walked from our PID, so other apps&apos; views are excluded.
          Private working set is resident pages no other process shares — RAM actually in use, not pagefile commit — read from the same
          Windows counter Task Manager&apos;s Memory column is computed from, so compare it to Task Manager&apos;s Recon + WebView2 group
          total directly. This series used to be private commit, which read several times higher for the very same tree.
          {perfDegraded ? (
            <>
              {' '}
              <span className="text-amber-400 font-semibold">
                Degraded: that counter could not be read here, so this is each process&apos;s full resident working set
                {perfOmitted > 0 ? `, and ${perfOmitted} process${perfOmitted === 1 ? '' : 'es'} could not be read at all` : ''}.
              </span>{' '}
              Still resident, never commit — but it includes pages shared between our own processes and with system DLLs, so summing it
              counts them once per process and reads HIGH against Task Manager. Every process reported here.
            </>
          ) : null}{' '}
          Sampling pauses while VALORANT owns the screen (FPS-first).
        </p>
        <p className="text-[11px] text-m3-outline mb-2.5">
          <span className="text-m3-on-surface font-semibold">CPU %</span> covers the same{' '}
          <span className="text-m3-on-surface font-semibold">{perfCpuProcs || 'backend + WebView2'} processes in our own tree</span> — the
          backend plus every msedgewebview2.exe child, per-process <span className="text-m3-on-surface font-semibold">kernel+user time summed</span>{' '}
          (not averaged) over the poll interval, as a share of all cores. That is the same set and the same normalisation Task Manager uses for a
          Recon + WebView2 group, so the two are directly comparable. The residual difference is the averaging window: this is a {PERF_POLL_MS / 1000}s
          delta and Task Manager refreshes on its own much shorter cycle, so a number that is actively moving will differ by whatever the load did
          between the two reads. It used to read the backend handle alone, which is why a busy renderer showed as ~0.1% here and ~10% in Task
          Manager.
          {perfCpuDegraded ? (
            <>
              {' '}
              <span className="text-amber-400 font-semibold">
                Degraded: {perfCpuOmitted} process{perfCpuOmitted === 1 ? '' : 'es'} in the tree could not be read, so this percentage is LOW.
              </span>
            </>
          ) : null}
        </p>
        {perfDegraded && (
          <div className="mb-2.5 rounded-lg border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[11px] font-mono text-amber-300">
            basis: {perfBasisLabel}
            {perfOmitted > 0 ? ` · omitted ${perfOmitted} process${perfOmitted === 1 ? '' : 'es'}` : ''} — over-counts shared
            pages, not a private total
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
          <PerfChart
            label={`MEM total (${perfBasisLabel})`}
            values={perfSamples.map((s) => s.total_mb)}
            times={perfSamples.map((s) => s.t)}
            stats={perf?.total}
            color="#34d399"
            fmt={(v: number) => `${Math.round(v)} MiB`}
            domain={perfMemDom}
            overlay={[
              { values: perfSamples.map((s) => s.rss_mb), color: '#7dd3fc', width: 1.25 },
              { values: perfSamples.map((s) => s.webview_mb), color: '#fbbf24', width: 1 },
            ]}
            legend={[
              { color: '#34d399', text: `total (${perfBasisLabel})` },
              { color: '#7dd3fc', text: 'backend' },
              { color: '#fbbf24', text: 'webview2 tree' },
            ]}
          />
          <PerfChart
            label={`CPU % (${perfCpuBasisLabel})`}
            values={(perf?.samples ?? []).map((s) => s.cpu_pct)}
            times={(perf?.samples ?? []).map((s) => s.t)}
            stats={perf?.cpu}
            color="#fbbf24"
            fmt={(v: number) => `${v.toFixed(1)}%`}
          />
        </div>
      </section>

      {/* Match simulator */}
      <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-4 min-w-0">
        <h4 className="font-display font-bold text-sm text-m3-on-surface mb-1">Mock live match</h4>
        <p className="text-[11px] text-m3-outline mb-2.5">Feeds Live Match tab + in-game overlay with canned data. Open the overlay + edit HUD to position widgets against it.</p>
        <div className="flex flex-wrap gap-1.5">
          {phases.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => pickPhase(p.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer transition-colors ${
                phase === p.id
                  ? 'bg-m3-primary/20 border-m3-primary text-m3-primary'
                  : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      {/* State simulators */}
      <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-4 min-w-0">
        <h4 className="font-display font-bold text-sm text-m3-on-surface mb-2.5">State overrides</h4>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => flip(DEV_TAB_KEY, tabHeld, setTabHeld)}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer transition-colors ${
              tabHeld ? 'bg-m3-primary/20 border-m3-primary text-m3-primary' : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'
            }`}
          >
            Tab held: {tabHeld ? 'ON (scoreboard shows)' : 'OFF'}
          </button>
          <button
            type="button"
            onClick={() => flip(DEV_NO_CLIENT_KEY, noClient, setNoClient)}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer transition-colors ${
              noClient ? 'bg-m3-coral/15 border-m3-coral/50 text-m3-coral' : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'
            }`}
          >
            Riot closed: {noClient ? 'ON (empty states)' : 'OFF'}
          </button>
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem('recon_clove_coffee_dismissed_until');
              localStorage.setItem('recon_dev_trigger_clove', String(Date.now()));
              window.dispatchEvent(new CustomEvent('recon:trigger-clove-donation'));
              if (isTauri()) {
                emit('recon:trigger-clove-donation', {}).catch(() => {});
              }
            }}
            className="px-3 py-1.5 rounded-xl text-xs font-bold border border-amber-400/40 bg-amber-400/15 text-amber-300 hover:bg-amber-400/25 active:scale-95 cursor-pointer transition-all flex items-center gap-1.5 shadow-xs"
            title="Trigger Clove Ko-fi popup on the main window"
          >
            <Coffee className="w-3.5 h-3.5 text-amber-400" />
            <span>Trigger Clove Ko-fi Popup</span>
          </button>
          <button
            type="button"
            onClick={() => debugSimulateCrash()}
            className="px-3 py-1.5 rounded-xl text-xs font-bold border border-m3-outline-subtle bg-m3-surface-container-low text-m3-outline hover:text-m3-on-surface cursor-pointer transition-colors"
            title="Stage a crash offer without touching the opt-in flag (verifies the CrashOffer UI)"
          >
            Simulate crash offer
          </button>
        </div>
      </section>

      {/* Overlay as window (debug the white bar off-fullscreen) */}
      <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-4 min-w-0">
        <h4 className="font-display font-bold text-sm text-m3-on-surface mb-1">Overlay as window</h4>
        <p className="text-[11px] text-m3-outline mb-2.5">
          Drops the overlay out of fullscreen click-through into a framed 1280×800 window you can move, resize, and dock DevTools against. Toggle back to restore fullscreen HUD.
        </p>
        <button
          type="button"
          onClick={() => {
            const next = !windowed;
            setWindowed(next);
            void setOverlayWindowed(next).catch(() => setWindowed(!next));
          }}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer transition-colors ${
            windowed ? 'bg-m3-primary/20 border-m3-primary text-m3-primary' : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'
          }`}
        >
          Windowed overlay: {windowed ? 'ON' : 'OFF'}
        </button>
      </section>

      {/* IPC smoke tests — full width; the per-group cards tile inside it */}
      <section className="xl:col-span-2 2xl:col-span-3 rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-4 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
          <h4 className="font-display font-bold text-sm text-m3-on-surface flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5 text-m3-primary" />
            <span>IPC smoke tests</span>
          </h4>
          <div className="flex items-center gap-2">
            {smokeProgress && (
              <span className="text-[10px] font-mono text-m3-outline tabular-nums">
                {smokeProgress.done + 1}/{smokeProgress.total} · {smokeProgress.label}
              </span>
            )}
            {smokeTally && !smokeRunning && (
              <span
                className={`text-[10px] font-mono font-bold tabular-nums px-1.5 py-0.5 rounded-lg border ${
                  smokeTally.fail > 0
                    ? 'border-m3-coral/50 bg-m3-coral/10 text-m3-coral'
                    : smokeTally.precondition > 0
                      ? 'border-amber-400/40 bg-amber-400/10 text-amber-300'
                      : 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                }`}
              >
                {smokeVerdict(smokeTally)} · {smokeTally.pass} pass / {smokeTally.fail} fail / {smokeTally.precondition} unmet
              </span>
            )}
            <button
              type="button"
              onClick={() => void runAllSmoke()}
              disabled={smokeRunning}
              className="px-2.5 py-1.5 rounded-xl text-xs font-bold bg-m3-primary/20 border border-m3-primary/50 text-m3-primary hover:bg-m3-primary/30 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 cursor-pointer"
              title="Every check, sequentially — these touch real system state (overlay show/hide, focus)"
            >
              <Play className="w-3 h-3 shrink-0" />
              <span>{smokeRunning ? 'Running…' : `Run all (${SMOKE_CHECK_COUNT})`}</span>
            </button>
          </div>
        </div>
        <p className="text-[11px] text-m3-outline mb-2.5">
          One IPC round-trip per check, answer shown inline. <span className="text-emerald-300 font-semibold">pass</span> means the
          command answered with the payload it must have;{' '}
          <span className="text-amber-300 font-semibold">unmet</span> means the environment is absent (no Riot Client, no tracker.gg
          page, VALORANT owning the screen) — not a broken command; <span className="text-m3-coral font-semibold">fail</span> is
          reserved for real breakage.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-2 items-start">
          {SMOKE_GROUPS.map((g) => (
            <div key={g.id} className="rounded-xl bg-zinc-950/60 border border-white/10 p-2 min-w-0">
              <div className="flex items-baseline justify-between gap-2 mb-1.5">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-m3-outline">{g.label}</span>
                <span className="text-[9px] font-mono text-zinc-600 tabular-nums">{g.checks.length} checks</span>
              </div>
              <div className="flex flex-col gap-1">
                {g.checks.map((c) => {
                  const r = smoke[c.id];
                  const busy = r?.outcome === 'running';
                  return (
                    <div key={c.id} className="flex items-center gap-1.5 min-w-0">
                      <button
                        type="button"
                        onClick={() => void runOne(c)}
                        disabled={smokeRunning}
                        className="shrink-0 px-2 py-1 rounded-lg text-[11px] font-semibold bg-m3-surface-container-low border border-m3-outline-subtle text-m3-on-surface hover:border-m3-primary/50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 cursor-pointer"
                      >
                        <Play className="w-2.5 h-2.5 text-m3-primary shrink-0" />
                        <span className="truncate">{busy ? 'running…' : c.label}</span>
                      </button>
                      {r && (
                        <span
                          className={`shrink-0 rounded border px-1 py-px text-[9px] font-bold uppercase tracking-wide ${
                            r.outcome === 'pass'
                              ? TONE_CLS.ok
                              : r.outcome === 'fail'
                                ? TONE_CLS.bad
                                : r.outcome === 'precondition'
                                  ? TONE_CLS.warn
                                  : TONE_CLS.muted
                          }`}
                        >
                          {r.outcome === 'running' ? '···' : r.outcome === 'precondition' ? 'unmet' : r.outcome}
                        </span>
                      )}
                      {r && r.outcome !== 'running' && (
                        <>
                          <span className="shrink-0 text-[10px] font-mono text-zinc-500 tabular-nums">{r.ms}ms</span>
                          <span
                            className="flex-1 min-w-0 truncate text-[10px] font-mono text-zinc-400"
                            title={r.summary}
                          >
                            {r.summary}
                          </span>
                          <span
                            className="shrink-0 text-[9px] font-mono text-zinc-600 tabular-nums"
                            title={`run #${r.runs} at ${new Date(r.at).toLocaleTimeString()}`}
                          >
                            #{r.runs} {new Date(r.at).toLocaleTimeString()}
                          </span>
                          {r.detail && (
                            <details className="shrink-0">
                              <summary className="cursor-pointer text-[9px] font-mono text-m3-primary hover:underline select-none">
                                raw
                              </summary>
                              <pre className="mt-1 max-w-full overflow-x-auto rounded-lg bg-black/60 border border-white/10 p-1.5 text-[10px] font-mono text-zinc-300 whitespace-pre-wrap break-all max-h-40 overflow-y-auto custom-scrollbar">
                                {r.detail}
                              </pre>
                            </details>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* TRN transport trace — the lines the `tauri dev` terminal shows. Two
          columns: the fixed-width age/status/elapsed cells and the truncating
          path cell were tuned for a panel wider than one third of the window. */}
      <section className="xl:col-span-2 2xl:col-span-2 rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-4 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-2">
          <button
            type="button"
            onClick={() => setTrnLogOpen((v) => !v)}
            className="flex items-center gap-1.5 cursor-pointer text-left"
            title={trnLogOpen ? 'Collapse trace' : 'Expand trace'}
            aria-expanded={trnLogOpen}
          >
            <ChevronDown className={`w-4 h-4 text-m3-outline transition-transform ${trnLogOpen ? '' : '-rotate-90'}`} />
            <span className="font-display font-bold text-sm text-m3-on-surface flex items-center gap-1.5">
              <Terminal className="w-3.5 h-3.5 text-m3-primary" />
              <span>TRN transport trace</span>
            </span>
          </button>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono text-m3-outline text-right">
              {trnLogErr
                ? 'backend trace unavailable'
                : `${trnLogRows.length} shown / ${TRN_LOG_VIEW} cap · newest last · ${TRN_LOG_POLL_MS}ms poll`}
            </span>
            {trnLogMissed && (
              <span className="text-[10px] font-mono text-amber-400 border border-amber-400/40 bg-amber-400/10 rounded-lg px-1.5 py-0.5">
                ring overwrote unseen lines
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                // View only: the cursors stay at the newest sequence, so the
                // cleared lines are not re-fetched from either ring.
                setTrnLogLines([]);
                setTrnCacheLines([]);
                setTrnLogMissed(false);
              }}
              className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-m3-surface-container-low border border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface flex items-center gap-1 cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
              <span>Clear</span>
            </button>
          </div>
        </div>
        {trnLogOpen && (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {TRN_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={trnLogFilter === f.id}
                  title={f.hint}
                  onClick={() => setTrnLogFilter(f.id)}
                  className={`px-2 py-0.5 rounded-lg text-[10px] font-mono font-bold border cursor-pointer transition-colors ${
                    trnLogFilter === f.id
                      ? 'bg-m3-primary/20 border-m3-primary/50 text-m3-primary'
                      : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'
                  }`}
                >
                  {f.label}
                </button>
              ))}
              <span
                className="ml-auto text-[10px] font-mono text-m3-outline tabular-nums"
                title="Over the whole held window, not the filtered view — this is the is-it-spamming answer"
              >
                {trnLogSummary.total} lines · {trnLogSummary.fetches} wire · {trnLogSummary.memos} memo saved ·{' '}
                {trnLogSummary.cacheHits} cache hit · {trnLogSummary.cacheMisses} cache miss · {trnLogSummary.failures} fail ·{' '}
                {trnLogSummary.avgElapsed > 0 ? `avg ${trnLogSummary.avgElapsed}ms` : 'no outcomes'}
              </span>
            </div>
            {trnLogErr ? (
              <p className="text-[11px] font-mono text-amber-300 break-all">{trnLogErr}</p>
            ) : trnLogRows.length === 0 ? (
              <p className="text-[11px] text-m3-outline">
                No trace lines yet — a TRN request has to be in flight (a live lobby fill, or any fill that runs while the Live Match tab is
                open). Dev builds only; the tracer is compiled out of release, so this stays empty there.
              </p>
            ) : trnLogShown.length === 0 ? (
              <p className="text-[11px] text-m3-outline">
                This filter excludes all {trnLogRows.length} held lines — nothing is hidden, nothing errored. Switch back to “all”.
              </p>
            ) : (
              <div
                ref={trnLogBox}
                className="rounded-xl bg-zinc-950/80 border border-white/10 p-1 max-h-72 overflow-y-auto custom-scrollbar font-mono text-[10px] leading-relaxed"
              >
                {trnLogShown.map((r) => {
                  const badge = trnKindBadge(r);
                  const tone = r.status !== undefined ? trnStatusTone(r.status) : null;
                  return (
                    <div key={r.seq} className="flex items-center gap-2 px-1 rounded hover:bg-white/[0.04] min-w-0">
                      {/* Epoch stays in the tooltip so a row can be matched against the terminal. */}
                      <span className="w-12 shrink-0 text-right text-zinc-500 tabular-nums" title={r.ms > 0 ? String(r.ms) : undefined}>
                        {formatTrnRel(r.ms, trnLogNewest)}
                      </span>
                      <span
                        className={`w-11 shrink-0 text-center rounded border px-1 py-px text-[9px] font-bold uppercase tracking-wide ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                      {tone !== null && (
                        <span className={`w-11 shrink-0 text-center rounded-full border px-1 py-px text-[9px] tabular-nums ${TONE_CLS[tone]}`}>
                          {r.status}
                        </span>
                      )}
                      <span className="flex-1 min-w-0 truncate text-zinc-300" title={r.path ?? r.raw}>
                        {r.label || <span className="text-zinc-600">—</span>}
                      </span>
                      <span className="w-12 shrink-0 text-right text-zinc-400 tabular-nums">{r.elapsed !== undefined ? `${r.elapsed}ms` : ''}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>
      {/* Backend events + log export share one column, stacked, so the trace
          above can take two columns without leaving a hole in the grid. */}
      <div className="flex flex-col gap-3.5 min-w-0">
        <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-4 min-w-0">
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-display font-bold text-sm text-m3-on-surface flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5 text-m3-primary" />
              <span>Backend events</span>
            </h4>
            <button
              type="button"
              onClick={() => setEvents([])}
              className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-m3-surface-container-low border border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface flex items-center gap-1 cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
              <span>Clear</span>
            </button>
          </div>
          {events.length === 0 ? (
            <p className="text-[11px] text-m3-outline">
              No events yet — toggle edit mode, switch resolution, or change HUD config. The overlay checks in the smoke panel above fire
              several of these.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {events.map((e, i) => (
                <div
                  key={`${e.t}-${i}`}
                  className="rounded-lg bg-zinc-950/80 border border-white/10 px-2 py-1 font-mono text-[10px] flex gap-2 min-w-0"
                >
                  <span className="text-zinc-500 shrink-0">{e.t}</span>
                  <span className="text-m3-primary font-bold shrink-0">{e.name}</span>
                  <span className="text-zinc-300 truncate">{e.payload}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-4 min-w-0">
          <h4 className="font-display font-bold text-sm text-m3-on-surface mb-1">TRN trace export</h4>
          <p className="text-[11px] text-m3-outline mb-2.5">
            The TRN transport trace this window is holding, as plain text for bug reports — same records the panel above renders, with the
            full untruncated path and both timestamps on every line. Not the in-app logger buffer: that is module state, so there is one per
            window, and this realm's is empty. The main window&apos;s real buffer is exported from Settings.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              value={logLines}
              onChange={(e) => setLogLines(Number(e.target.value) || 0)}
              type="number"
              min={1}
              max={TRN_LOG_VIEW}
              aria-label="Number of log lines"
              className="px-2.5 py-1.5 rounded-xl text-xs font-mono bg-m3-surface-container-low border border-m3-outline-subtle text-m3-on-surface w-24"
            />
            <button
              type="button"
              onClick={downloadLogs}
              className="px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-m3-surface-container-low border border-m3-outline-subtle text-m3-on-surface hover:border-m3-primary/50 flex items-center gap-1.5 cursor-pointer"
            >
              <Download className="w-3 h-3 text-m3-primary shrink-0" />
              <span>Download .txt</span>
            </button>
            <button
              type="button"
              onClick={() => void copyLogs()}
              className="px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-m3-surface-container-low border border-m3-outline-subtle text-m3-on-surface hover:border-m3-primary/50 flex items-center gap-1.5 cursor-pointer"
            >
              <Copy className="w-3 h-3 text-m3-primary shrink-0" />
              <span>Copy to clipboard</span>
            </button>
          </div>
          {logOut && (
            <div className="mt-2.5 rounded-xl bg-zinc-950/80 border border-white/10 p-2 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-all">
              {logOut}
            </div>
          )}
        </section>
      </div>
      </div>
    </div>
  );
};