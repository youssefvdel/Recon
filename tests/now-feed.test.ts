import { describe, expect, test } from 'bun:test';
import { nowFeed } from '../src/v2/now/feed';
import type { TrackerMatchDetail, TrackerMmrPoint } from '../src/types';

const ME = '10000000-0000-4000-8000-000000000007';

function game(matchId: string, when: number): TrackerMmrPoint {
  return { matchId, when, tier: '', rr: 0, change: 0, mapId: '' };
}

function detail(opts: {
  puuid?: string;
  team?: string;
  agent?: string;
  blue?: number;
  red?: number;
}): TrackerMatchDetail {
  const teamScore: Record<string, number> = {};
  if (opts.blue !== undefined) teamScore.Blue = opts.blue;
  if (opts.red !== undefined) teamScore.Red = opts.red;
  return {
    matchId: '',
    rounds: [],
    players: [
      { puuid: opts.puuid ?? ME, team: opts.team ?? 'Blue', agent: opts.agent ?? 'Jett' },
    ],
    kills: [],
    mapId: '',
    teamScore,
    queue: '',
    when: 0,
  } as unknown as TrackerMatchDetail;
}

describe('nowFeed', () => {
  test('a match with no details gets the map only — no score, no result, no agent', () => {
    const rows = nowFeed([game('m1', 100)], { m1: 'Ascent' }, {}, ME);
    expect(rows).toEqual([{ id: 'm1', map: 'Ascent', score: '', result: '', agent: '' }]);
  });

  test('maps the result from the player’s own team', () => {
    const details = {
      win: detail({ team: 'Blue', agent: 'Reyna', blue: 13, red: 7 }),
      loss: detail({ team: 'Red', agent: 'Omen', blue: 13, red: 7 }),
    };
    const rows = nowFeed([game('win', 2), game('loss', 1)], { win: 'Ascent', loss: 'Bind' }, details, ME);
    expect(rows.map((r) => [r.id, r.score, r.result, r.agent])).toEqual([
      ['win', '13–7', 'W', 'Reyna'],
      ['loss', '7–13', 'L', 'Omen'],
    ]);
  });

  test('a 13–13 payload is a draw', () => {
    const rows = nowFeed([game('m1', 1)], { m1: 'Icebox' }, { m1: detail({ blue: 13, red: 13 }) }, ME);
    expect(rows[0].score).toBe('13–13');
    expect(rows[0].result).toBe('D');
  });

  test('a missing team score blanks both score and result — never 0–0, never D', () => {
    const onlyBlue = nowFeed([game('m1', 1)], { m1: 'Haven' }, { m1: detail({ blue: 13 }) }, ME);
    const onlyRed = nowFeed([game('m1', 1)], { m1: 'Haven' }, { m1: detail({ red: 13 }) }, ME);
    for (const row of [...onlyBlue, ...onlyRed]) {
      expect(row.score).toBe('');
      expect(row.result).toBe('');
    }
  });

  test('a missing map name is an empty string, never undefined', () => {
    const rows = nowFeed([game('m1', 1)], undefined, {}, ME);
    expect(rows[0].map).toBe('');
    const unknownKey = nowFeed([game('m1', 1)], { other: 'Bind' }, {}, ME);
    expect(unknownKey[0].map).toBe('');
  });

  test('a player not in detailsById has no agent, score or result', () => {
    const other = detail({ puuid: 'someone-else', blue: 13, red: 7 });
    const rows = nowFeed([game('m1', 1)], { m1: 'Lotus' }, { m1: other }, ME);
    expect(rows[0]).toEqual({ id: 'm1', map: 'Lotus', score: '', result: '', agent: '' });
  });

  test('limits to five rows with a deterministic tie-break, independent of input order', () => {
    // Three pairs share the same `when`; a swap between polls would reorder them.
    const games = [
      game('b', 3), game('a', 3), game('d', 2), game('c', 2), game('f', 1), game('e', 1), game('g', 0),
    ];
    const expected = ['a', 'b', 'c', 'd', 'e'];
    const forward = nowFeed(games, {}, {}, ME, 5).map((r) => r.id);
    const reversed = nowFeed([...games].reverse(), {}, {}, ME, 5).map((r) => r.id);
    expect(forward).toEqual(expected);
    expect(reversed).toEqual(expected);
    expect(nowFeed(games, {}, {}, ME, 5)).toHaveLength(5);
  });

  test('does not mutate the games array it was given', () => {
    const games = [game('b', 1), game('a', 2)];
    const before = games.map((g) => g.matchId);
    nowFeed(games, {}, {}, ME);
    expect(games.map((g) => g.matchId)).toEqual(before);
  });
});
