import { describe, expect, test } from 'bun:test';
import {
  applyLiveFacts,
  factsStamp,
  factsToPatch,
  shouldSkipFallbackFetch,
  type LiveFacts,
} from '../src/live/facts';
import type { LiveMatchPlayer, LiveMatchState } from '../src/types';

/* Phase 2 contract (`docs/live-rust-pipeline.md`): the Rust live service is the
 * source, the TS intervals are the fallback. These drive the pure mapping and
 * the freshness window without React, Tauri or a clock. */

const NOW = 1_760_000_000_000;

const base: LiveFacts = {
  version: 1,
  seq: 7,
  source: 'presences',
  confidence: 'high',
  phase: 'coregame',
  phase_label: 'LIVE',
  loop_state: 'INGAME',
  map: 'Ascent',
  queue: 'competitive',
  mode: 'Competitive',
  blue: 7,
  red: 5,
  updated_at: NOW,
};

const fact = (over: Partial<LiveFacts> = {}): LiveFacts => ({ ...base, ...over });

const idleFact = (over: Partial<LiveFacts> = {}): LiveFacts =>
  fact({
    phase: 'idle',
    phase_label: '',
    loop_state: 'MENU',
    map: '',
    queue: '',
    mode: '',
    blue: 0,
    red: 0,
    ...over,
  });

const player = (over: Partial<LiveMatchPlayer> = {}): LiveMatchPlayer => ({
  puuid: 'p1',
  name: 'A',
  tag: 'B',
  team: 'Blue',
  agentId: '',
  agentName: 'Jett',
  agentIcon: '',
  agentRole: '',
  tier: 15,
  rank: 'Diamond 1',
  rr: 42,
  peakTier: 18,
  peakRank: 'Immortal 1',
  accountLevel: 100,
  cardId: '',
  isMe: false,
  kd: 1.4,
  acs: 250,
  hsPct: 30,
  winPct: 55,
  trnScore: 120,
  ...over,
});

const rich: LiveMatchState = {
  phase: 'coregame',
  matchId: 'm1',
  mapId: '',
  mapName: 'Ascent',
  mode: 'Competitive',
  queueId: 'competitive',
  isDeathmatch: false,
  allyScore: 5,
  enemyScore: 3,
  blueTeam: [player()],
  redTeam: [],
  updatedAt: NOW - 2_000,
};

describe('factsToPatch — ingame / pregame / idle', () => {
  test('coregame facts carry phase, map, queue, scores and the provenance stamp', () => {
    const patch = factsToPatch(fact());
    expect(patch).not.toBeNull();
    expect(patch?.state.phase).toBe('coregame');
    expect(patch?.state.mapName).toBe('Ascent');
    expect(patch?.state.queueId).toBe('competitive');
    // Presence ally/enemy is the local player's team: blue = ally.
    expect(patch?.state.allyScore).toBe(7);
    expect(patch?.state.enemyScore).toBe(5);
    expect(patch?.source).toBe('presences');
    expect(patch?.seq).toBe(7);
    expect(patch?.confidence).toBe('high');
    // `mode` is Rust-derived; the TS fetch owns the row label. Not mapped.
    expect('mode' in (patch?.state ?? {})).toBe(false);
  });

  test('pregame facts keep the real 0–0 score and the select phase', () => {
    const patch = factsToPatch(
      fact({ phase: 'pregame', phase_label: 'SELECT', loop_state: 'PREGAME', map: 'Bind', queue: 'swiftplay', blue: 0, red: 0 })
    );
    expect(patch?.state.phase).toBe('pregame');
    expect(patch?.state.mapName).toBe('Bind');
    expect(patch?.state.queueId).toBe('swiftplay');
    expect(patch?.state.allyScore).toBe(0);
    expect(patch?.state.enemyScore).toBe(0);
  });

  test('idle facts carry the phase only — no fake map, queue or 0–0 score', () => {
    const patch = factsToPatch(idleFact());
    expect(patch?.state.phase).toBe('idle');
    expect('mapName' in (patch?.state ?? {})).toBe(false);
    expect('queueId' in (patch?.state ?? {})).toBe(false);
    expect('allyScore' in (patch?.state ?? {})).toBe(false);
    expect('enemyScore' in (patch?.state ?? {})).toBe(false);
  });
});

describe('malformed payloads — null, never a fake match', () => {
  test('rejects non-objects', () => {
    for (const bad of [null, undefined, 'coregame', 42, [], true]) {
      expect(factsToPatch(bad)).toBeNull();
    }
  });

  test('rejects an unknown version, phase, or a non-numeric score', () => {
    expect(factsToPatch(fact({ version: 2 }))).toBeNull();
    expect(factsToPatch({ ...fact(), phase: 'menu' })).toBeNull();
    expect(factsToPatch({ ...fact(), blue: '7' })).toBeNull();
  });

  test('rejects a payload with a missing wire field', () => {
    const { map: _map, ...noMap } = fact();
    expect(factsToPatch(noMap)).toBeNull();
    const { seq: _seq, ...noSeq } = fact();
    expect(factsToPatch(noSeq)).toBeNull();
  });
});

describe('applyLiveFacts — non-regressing merge', () => {
  test('a poorer (low-confidence idle) fact never blanks a rich live state', () => {
    const merged = applyLiveFacts(rich, idleFact({ confidence: 'low' }));
    expect(merged?.phase).toBe('coregame');
    expect(merged?.mapName).toBe('Ascent');
    expect(merged?.allyScore).toBe(5);
    expect(merged?.blueTeam[0].acs).toBe(250);
    expect(merged?.blueTeam[0].kd).toBe(1.4);
  });

  test('a proven idle (high confidence, MENU loop) ends the phase but keeps the roster', () => {
    const merged = applyLiveFacts(rich, idleFact({ confidence: 'high' }));
    expect(merged?.phase).toBe('idle');
    // The roster is the TS poller's; idle facts cannot carry it, so it survives.
    expect(merged?.blueTeam[0].acs).toBe(250);
  });

  test('empty fact fields do not blank richer map/queue values', () => {
    const merged = applyLiveFacts(
      rich,
      fact({ phase: 'pregame', phase_label: 'SELECT', loop_state: 'PREGAME', map: '', queue: '', blue: 0, red: 0 })
    );
    expect(merged?.phase).toBe('pregame');
    expect(merged?.mapName).toBe('Ascent');
    expect(merged?.queueId).toBe('competitive');
    expect(merged?.allyScore).toBe(0);
  });

  test('does not mutate the state it was given', () => {
    applyLiveFacts(rich, fact({ phase: 'pregame', map: 'Bind' }));
    expect(rich.phase).toBe('coregame');
    expect(rich.mapName).toBe('Ascent');
  });

  test('a first fact set with no previous state builds a match-less skeleton', () => {
    const merged = applyLiveFacts(null, fact());
    expect(merged?.phase).toBe('coregame');
    expect(merged?.mapName).toBe('Ascent');
    expect(merged?.blueTeam).toEqual([]);
    expect(merged?.redTeam).toEqual([]);
  });

  test('a malformed event is ignored', () => {
    expect(applyLiveFacts(rich, { version: 1 })).toBeNull();
  });
});

describe('shouldSkipFallbackFetch — the 10s window', () => {
  test('a fact 9s old keeps the interval fetch skipped', () => {
    expect(shouldSkipFallbackFetch(1_000, 10_000)).toBe(true);
  });

  test('a fact 11s old lets the interval fetch again', () => {
    expect(shouldSkipFallbackFetch(1_000, 12_000)).toBe(false);
  });

  test('no event ever arrived means no skip', () => {
    expect(shouldSkipFallbackFetch(0, 5_000)).toBe(false);
  });

  test('the flag turns the suppression off', () => {
    expect(shouldSkipFallbackFetch(1_000, 10_000, false)).toBe(false);
  });

  test('a backwards clock jump does not suppress forever', () => {
    expect(shouldSkipFallbackFetch(20_000, 10_000)).toBe(false);
  });
});

describe('factsStamp', () => {
  test('the first fact closes the gate', () => {
    expect(factsStamp(null, 'coregame', 5_000)).toBe(5_000);
  });

  test('a same-phase fact keeps the gate closed', () => {
    expect(factsStamp('coregame', 'coregame', 7_000)).toBe(7_000);
  });

  test('a phase transition opens the gate so the roster can fetch', () => {
    expect(factsStamp('pregame', 'coregame', 9_000)).toBe(0);
    expect(shouldSkipFallbackFetch(factsStamp('pregame', 'coregame', 9_000), 9_000)).toBe(false);
  });

  test('the next same-phase fact closes it again', () => {
    expect(shouldSkipFallbackFetch(factsStamp('coregame', 'coregame', 10_000), 10_000)).toBe(true);
  });
});
