import { describe, expect, test } from 'bun:test';
import { rrTrend } from '../src/v2/now/rrTrend.ts';
import type { TrackerMmrPoint } from '../src/types.ts';

/* `games` already carries the RR each competitive match earned, so this is
 * arithmetic over data already fetched. The assertions that matter are the
 * absence rules: a game we cannot price must not be counted as a game that moved
 * us by nothing. */

const g = (matchId: string, change: unknown, when: number): TrackerMmrPoint =>
  ({ matchId, change, when, tier: 'Diamond 2', rr: 47, mapId: 'ascent', queueId: 'competitive' }) as unknown as TrackerMmrPoint;

describe('rrTrend', () => {
  test('sums the deltas and counts wins and losses', () => {
    const t = rrTrend([g('a', 18, 3), g('b', -14, 2), g('c', 12, 1)]);
    expect(t?.net).toBe(16);
    expect(t?.wins).toBe(2);
    expect(t?.losses).toBe(1);
  });

  test('a game with no numeric change is skipped, not counted as zero', () => {
    const t = rrTrend([g('a', 18, 2), g('b', undefined, 1), g('c', 'x' as unknown as number, 0)]);
    expect(t?.entries).toHaveLength(1);
    expect(t?.net).toBe(18);
  });

  test('nothing priced means no trend at all, not a zero', () => {
    expect(rrTrend([g('a', undefined, 1)])).toBeNull();
    expect(rrTrend([])).toBeNull();
    expect(rrTrend(undefined)).toBeNull();
  });

  test('keeps the newest `limit` games', () => {
    const games = Array.from({ length: 30 }, (_, i) => g(`m${i}`, 10, i));
    const t = rrTrend(games, 20);
    expect(t?.entries).toHaveLength(20);
    // newest first: when=29 down to when=10
    expect(t?.entries[0].when).toBe(29);
    expect(t?.entries[19].when).toBe(10);
    expect(t?.net).toBe(200);
  });

  test('best and worst are the largest single gain and loss', () => {
    const t = rrTrend([g('a', 5, 3), g('b', 27, 2), g('c', -19, 1), g('d', -3, 0)]);
    expect(t?.best).toBe(27);
    expect(t?.worst).toBe(-19);
  });

  test('a flat run has no best or worst, and a net of zero', () => {
    const t = rrTrend([g('a', 18, 1), g('b', -18, 0)]);
    expect(t?.net).toBe(0);
    expect(t?.best).toBe(18);
    expect(t?.worst).toBe(-18);
  });

  test('does not mutate the input array', () => {
    const games = [g('a', 1, 1), g('b', 2, 2)];
    const copy = [...games];
    rrTrend(games);
    expect(games).toEqual(copy);
  });
});
