/* Rust live facts → the live board's state fields. Pure: no React, no Tauri,
 * no I/O.
 *
 * `src-tauri/src/live_facts.rs` derives one fact set per change and
 * `src-tauri/src/live.rs` emits it as `recon:live-facts`. This module is the
 * only place that knows the wire shape; the hooks (`useLiveFacts`) and the
 * interval fallbacks both go through it, so a malformed payload can never
 * masquerade as a match.
 *
 * Wire field names are the Rust ones, verbatim (`phase_label`, `loop_state`,
 * `updated_at`, …) — renaming any of them here silently kills the feed.
 *
 * The map/queue/scores patch is merged through `mergeLiveMatchStateNonRegressing`
 * so the roster enrichment the TS poller owns is never lost to a fact set that
 * cannot carry it. Facts are the cheaper source; they must not overwrite a
 * richer TS value.
 */

import type { LiveMatchState } from '../types';
import { mergeLiveMatchStateNonRegressing } from './merge';

/** Event name, owned by `src-tauri/src/live.rs` (`LIVE_FACTS_EVENT`). */
export const LIVE_FACTS_EVENT = 'recon:live-facts';

/** `LIVE_FACTS_VERSION` in `src-tauri/src/live_facts.rs`. A different version
 *  is a shape we do not understand: treat it as malformed, not as facts. */
export const LIVE_FACTS_VERSION = 1;

/** How long a fact set keeps the interval fallback quiet. The Rust poller runs
 *  every 2.5 s but emits only on change, so a quiet match still fetches on this
 *  cadence — the fallback resumes exactly when the event stream goes quiet. */
export const LIVE_FACTS_STALE_MS = 10_000;

/** Kill switch for the whole event-driven path (docs/live-rust-pipeline.md:
 *  "Rollback: flip flag, TS interval resumes"). False = no listener, no skip;
 *  the two poll hooks behave exactly as they did before Phase 2. */
export const LIVE_FACTS_ENABLED = true;

/** The wire payload, field-for-field as `LiveFacts` in Rust. */
export interface LiveFacts {
  version: number;
  seq: number;
  source: string;
  /** `high` = loop state decoded; `medium` = blob decoded, no loop state;
   *  `low` = nothing known. Only `high` idle is a proven trip to the menus. */
  confidence: string;
  /** HUD gate vocabulary: `idle | pregame | coregame`. */
  phase: string;
  phase_label: string;
  loop_state: string;
  map: string;
  queue: string;
  mode: string;
  /** Presence ally/enemy scores — ally is the local player's team, so this maps
   *  onto `allyScore` / `enemyScore`, not to a HUD side. */
  blue: number;
  red: number;
  updated_at: number;
}

/** A validated fact set reduced to what `LiveMatchState` can absorb, plus the
 *  provenance stamp every event is required to carry. */
export interface LiveFactsPatch {
  /** Only fields the fact set actually knows. Empty facts contribute nothing,
   *  so a poorer event cannot blank a richer state. */
  state: Partial<LiveMatchState>;
  source: string;
  seq: number;
  confidence: string;
  /** Fact wall-clock (`updated_at`). */
  updatedAt: number;
}

const PHASES = new Set(['idle', 'pregame', 'coregame']);

function text(v: Record<string, unknown>, key: string): string | null {
  const value = v[key];
  return typeof value === 'string' ? value : null;
}

/** Validate the wire payload. Anything the Rust side does not guarantee is
 *  malformed: `null`, never a defaulted fact set — a defaulted one would blank
 *  a live match on the first bad event. */
export function parseLiveFacts(payload: unknown): LiveFacts | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const v = payload as Record<string, unknown>;
  if (v.version !== LIVE_FACTS_VERSION) return null;
  if (typeof v.seq !== 'number' || !Number.isInteger(v.seq) || v.seq < 0) return null;
  const phase = text(v, 'phase');
  if (phase === null || !PHASES.has(phase)) return null;
  if (typeof v.blue !== 'number' || !Number.isInteger(v.blue)) return null;
  if (typeof v.red !== 'number' || !Number.isInteger(v.red)) return null;
  if (typeof v.updated_at !== 'number' || !Number.isFinite(v.updated_at) || v.updated_at < 0) {
    return null;
  }
  const source = text(v, 'source');
  const confidence = text(v, 'confidence');
  const phaseLabel = text(v, 'phase_label');
  const loopState = text(v, 'loop_state');
  const map = text(v, 'map');
  const queue = text(v, 'queue');
  const mode = text(v, 'mode');
  if (
    source === null ||
    confidence === null ||
    phaseLabel === null ||
    loopState === null ||
    map === null ||
    queue === null ||
    mode === null
  ) {
    return null;
  }
  return {
    version: v.version,
    seq: v.seq,
    source,
    confidence,
    phase,
    phase_label: phaseLabel,
    loop_state: loopState,
    map,
    queue,
    mode,
    blue: v.blue,
    red: v.red,
    updated_at: v.updated_at,
  };
}

/** Wire payload → state patch. `null` for anything malformed. */
export function factsToPatch(payload: unknown): LiveFactsPatch | null {
  const facts = parseLiveFacts(payload);
  if (!facts) return null;
  const state: Partial<LiveMatchState> = { phase: facts.phase as LiveMatchState['phase'] };
  // Empty strings are "unknown", not values: an idle fact set must not blank
  // the map name a TS fetch already resolved.
  if (facts.map) state.mapName = facts.map;
  if (facts.queue) state.queueId = facts.queue;
  // Scores only exist while a match does. Idle facts carry 0/0 as a placeholder,
  // and rendering those as a real 0–0 would be a fake score.
  if (facts.phase !== 'idle') {
    state.allyScore = facts.blue;
    state.enemyScore = facts.red;
  }
  return {
    state,
    source: facts.source,
    seq: facts.seq,
    confidence: facts.confidence,
    updatedAt: facts.updated_at,
  };
}

/**
 * Fact payload → the live state it implies, merged non-regressively over what
 * the TS poller already knows.
 *
 * `null` means "ignore this event" (malformed). A low/medium-confidence idle
 * fact is also ignored while a match is on screen: those confidences mean
 * "unknown", not "proven idle" (`live_facts.rs` derives idle from a missing
 * presence and from an unreadable blob), and blanking a live match on a blip is
 * exactly what the non-regressing rules exist to prevent.
 */
export function applyLiveFacts(prev: LiveMatchState | null, payload: unknown): LiveMatchState | null {
  const patch = factsToPatch(payload);
  if (!patch) return null;
  const phase = patch.state.phase;
  if (phase === 'idle' && patch.confidence !== 'high' && prev !== null && prev.phase !== 'idle') {
    return prev;
  }
  const base: LiveMatchState = prev ?? {
    phase: 'idle',
    matchId: '',
    mapId: '',
    mapName: '',
    mode: '',
    isDeathmatch: false,
    blueTeam: [],
    redTeam: [],
    updatedAt: 0,
  };
  const incoming: LiveMatchState = {
    ...base,
    ...patch.state,
    updatedAt: Math.max(base.updatedAt ?? 0, patch.updatedAt),
  };
  return mergeLiveMatchStateNonRegressing(prev, incoming);
}

/**
 * Whether an interval tick should skip its network fetch because the Rust
 * poller covered the same source this window. Pure, so the 10 s window is
 * testable without a clock.
 */
export function shouldSkipFallbackFetch(
  lastFactsAt: number,
  now: number,
  enabled: boolean = LIVE_FACTS_ENABLED
): boolean {
  if (!enabled || lastFactsAt <= 0) return false;
  const age = now - lastFactsAt;
  // A backwards clock jump must not suppress the fallback indefinitely.
  return age >= 0 && age < LIVE_FACTS_STALE_MS;
}

/**
 * Timestamp to store for an accepted fact set.
 *
 * Normally "now": the event stream is covering the source, so the intervals may
 * skip their own fetch. But a phase transition is the one moment a fact set is
 * strictly poorer than a fetch — it carries no roster, and the HUD would show
 * five empty cells for up to `LIVE_FACTS_STALE_MS`. Returning 0 opens the gate
 * for exactly one tick, which fetches the roster, and the next fact re-closes it.
 */
export function factsStamp(
  previousPhase: string | null,
  nextPhase: string,
  now: number
): number {
  return previousPhase !== null && previousPhase !== nextPhase ? 0 : now;
}
