import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeAdvancedStats } from '../src/live/advancedStats';
import { mapRoundKills, normTeam, parseRoundDetails } from '../src/sources/roundMap';
import type { TrackerDuel, TrackerMatchDetail } from '../src/types';

const FIXTURE = fileURLToPath(new URL('../src/dev/fixtures/matches/real-13.09.json', import.meta.url));

interface RawPlayer {
  subject: string;
  teamId: string;
  gameName?: string;
}

function realDetail(): { detail: TrackerMatchDetail; players: RawPlayer[] } {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const players: RawPlayer[] = raw.players.map((p: RawPlayer) => ({ ...p, subject: String(p.subject) }));
  const teamOf = (puuid: string) => normTeam(players.find((p) => p.subject === puuid)?.teamId);
  const detail = {
    rounds: [],
    roundDetails: parseRoundDetails(raw.roundResults),
    players: players.map((p) => ({ puuid: p.subject, team: normTeam(p.teamId) })),
    kills: mapRoundKills(raw.roundResults, teamOf),
  } as unknown as TrackerMatchDetail;
  return { detail, players };
}

/** Minimal model for the synthetic semantics tests. */
function synthetic(kills: TrackerDuel[], deathsInRound = 1): TrackerMatchDetail {
  return {
    rounds: [],
    roundDetails: [
      { roundNum: 0, winningTeam: 'Blue', players: [{ puuid: 'me', kills: 0, deaths: deathsInRound, assists: 0 }] },
    ],
    players: [
      { puuid: 'me', team: 'Blue' },
      { puuid: 'mate', team: 'Blue' },
      { puuid: 'mate2', team: 'Blue' },
      { puuid: 'opp', team: 'Red' },
    ],
    kills,
  } as unknown as TrackerMatchDetail;
}

/** The teammate kills the killer `deltaMs` after the death. */
function avengedRound(deathRound: number, killRound: number, deltaMs: number, avengerTeam = 'Blue'): TrackerDuel[] {
  const death = {
    round: deathRound, killerPuuid: 'opp', victimPuuid: 'me', killerTeam: 'Red', victimTeam: 'Blue',
    timeInRound: 10_000, weapon: '', assists: [],
  } satisfies TrackerDuel;
  const revenge = {
    round: killRound, killerPuuid: 'mate', victimPuuid: 'opp', killerTeam: avengerTeam, victimTeam: 'Red',
    timeInRound: 10_000 + deltaMs, weapon: '', assists: [],
  } satisfies TrackerDuel;
  return [death, revenge];
}

describe('traded deaths — real capture (28 rounds, 207 kills, patch 13.09)', () => {
  const { detail, players } = realDetail();
  const player = (n: string) => players.find((p) => p.gameName === n)!.subject;

  test('matches the judge recount: 4 / 6 / 14 traded deaths', () => {
    expect(computeAdvancedStats(detail, player('Player1')).tradedDeaths).toBe(4);
    expect(computeAdvancedStats(detail, player('Player2')).tradedDeaths).toBe(6);
    expect(computeAdvancedStats(detail, player('Player3')).tradedDeaths).toBe(14);
  });

  test('KAST uses the corrected trades (100/100/96.43 → 82.14/75.00/71.43)', () => {
    expect(computeAdvancedStats(detail, player('Player1')).kastPct).toBeCloseTo(82.1429, 3);
    expect(computeAdvancedStats(detail, player('Player2')).kastPct).toBeCloseTo(75, 3);
    expect(computeAdvancedStats(detail, player('Player3')).kastPct).toBeCloseTo(71.4286, 3);
  });

  test('first bloods are unaffected by the round/trade fix', () => {
    expect(computeAdvancedStats(detail, player('Player1')).firstBloods).toBe(1);
    expect(computeAdvancedStats(detail, player('Player2')).firstBloods).toBe(1);
    expect(computeAdvancedStats(detail, player('Player3')).firstBloods).toBe(5);
  });
});

describe('traded deaths — definition edges', () => {
  test('a trade must be the same round exactly', () => {
    // The old `|| roundNum + 1` counted this as Player1 round 0's trade.
    const adjacent = synthetic(avengedRound(0, 1, 1_000));
    expect(computeAdvancedStats(adjacent, 'me').tradedDeaths).toBe(0);
    const same = synthetic(avengedRound(0, 0, 1_000));
    expect(computeAdvancedStats(same, 'me').tradedDeaths).toBe(1);
  });

  test('the 5 s window is inclusive at 5,000 ms and excludes 5,001 ms', () => {
    expect(computeAdvancedStats(synthetic(avengedRound(0, 0, 5_000)), 'me').tradedDeaths).toBe(1);
    expect(computeAdvancedStats(synthetic(avengedRound(0, 0, 5_001)), 'me').tradedDeaths).toBe(0);
    // A kill before the death cannot be the avenger.
    expect(computeAdvancedStats(synthetic(avengedRound(0, 0, -500)), 'me').tradedDeaths).toBe(0);
  });

  test('the avenger must be a teammate of the victim', () => {
    const enemyAvenger = synthetic(avengedRound(0, 0, 1_000, 'Red'));
    expect(computeAdvancedStats(enemyAvenger, 'me').tradedDeaths).toBe(0);
  });

  test('a multi-death round counts only the death that was actually traded', () => {
    // Two deaths for `me`; only the first killer is avenged.
    const kills = [
      ...avengedRound(0, 0, 1_000),
      { round: 0, killerPuuid: 'mate2', victimPuuid: 'me', killerTeam: 'Blue', victimTeam: 'Blue', timeInRound: 20_000, weapon: '', assists: [] },
    ];
    const detail = synthetic(kills, 2);
    const stats = computeAdvancedStats(detail, 'me');
    expect(stats.tradedDeaths).toBe(1);
    // KAST is per round: one traded death makes the round count once.
    expect(stats.kastPct).toBe(100);
  });
});
