import type { LiveMatchPlayer, LiveMatchState, TrackerMatchDetail, TrackerMmrPoint, TrackerProfile } from '../../types';

/** Fixtures for the headless harness. Shapes are copied from the real types and
 *  filled with plausible values — including the ugly ones the new theme has to
 *  survive: an incognito player, a player whose name never resolved, a player
 *  with no rank, a private profile and a "not cached" profile. */

export const FIXTURE_PUUID = '11111111-2222-3333-4444-555555555555';
const NOW = Date.now();

export const profileFixture = (): TrackerProfile => ({
  name: 'Youssef',
  tag: 'EUW',
  region: 'eu',
  puuid: FIXTURE_PUUID,
  rank: 'Diamond 2',
  tier: 20,
  rr: 47,
  peak: 'Ascendant 3',
  wins: 34,
  games: 63,
  currentSeasonId: 'act-3',
  seasons: [
    { id: 'act-3', games: 63, wins: 34, tier: 20 },
    { id: 'act-2', games: 42, wins: 23, tier: 18 },
    { id: 'act-1', games: 38, wins: 19, tier: 16 },
  ],
});

export const gamesFixture = (count = 20): TrackerMmrPoint[] =>
  Array.from({ length: count }, (_, i) => ({
    tier: i % 3 === 0 ? 'Diamond 2' : i % 3 === 1 ? 'Diamond 1' : 'Platinum 3',
    rr: 40 + (i % 40),
    change: i % 2 === 0 ? 18 : -14,
    matchId: `match-${i + 1}`,
    mapId: ['ascent', 'haven', 'lotus', 'sunset', 'abyss'][i % 5],
    when: NOW - i * 6 * 3600_000,
    queueId: 'competitive',
  }));

export const detailFixture = (matchId: string, i: number): TrackerMatchDetail => {
  const blueWon = i % 2 === 0;
  const me = {
    puuid: FIXTURE_PUUID,
    name: 'Youssef',
    tag: 'EUW',
    team: 'Blue',
    agent: ['Jett', 'Omen', 'Raze', 'Cypher', 'Sova'][i % 5],
    kills: 18 + (i % 9),
    deaths: 14 + (i % 6),
    assists: 3 + (i % 5),
    damage: 4200 + i * 30,
    damageTaken: 3900 + i * 20,
    score: 4600 + i * 40,
    rounds: 22 + (i % 4),
    playtimeMs: 2_400_000,
    headshots: 12 + (i % 5),
    bodyshots: 40 + (i % 7),
    legshots: 6,
  };
  const teammates = Array.from({ length: 4 }, (_, k) => ({
    ...me,
    puuid: `mate-${i}-${k}`,
    name: `Mate ${k + 1}`,
    team: 'Blue' as const,
    agent: ['Sova', 'Killjoy', 'Neon', 'Fade'][k],
    kills: 10 + k,
    deaths: 16 - k,
    assists: 5 + k,
    score: 3800 + k * 100,
  }));
  const enemies = Array.from({ length: 5 }, (_, k) => ({
    ...me,
    puuid: `enemy-${i}-${k}`,
    name: `Enemy ${k + 1}`,
    team: 'Red' as const,
    agent: ['Reyna', 'Chamber', 'Viper', 'Breach', 'Skye'][k],
    kills: 12 + k,
    deaths: 15 - k,
    assists: 4 + k,
    score: 3900 + k * 90,
  }));
  const rounds = Array.from({ length: me.rounds }, (_, r) => ({
    roundNum: r,
    winningTeam: (blueWon ? r % 3 !== 0 : r % 3 === 0) ? 'Blue' : 'Red',
    roundResult: r % 4 === 0 ? 'Eliminated' : r % 4 === 1 ? 'Bomb defused' : r % 4 === 2 ? 'Bomb detonated' : 'Time expired',
    bombPlanter: r % 5 === 0 ? me.puuid : undefined,
    bombDefuser: r % 7 === 0 ? me.puuid : undefined,
    kills: [],
    economy: [],
  }));
  return {
    matchId,
    when: NOW - i * 6 * 3600_000,
    queue: 'competitive',
    mapId: ['ascent', 'haven', 'lotus', 'sunset', 'abyss'][i % 5],
    teamScore: { Blue: blueWon ? 13 : 9, Red: blueWon ? 9 : 13 },
    players: [me, ...teammates, ...enemies],
    kills: Array.from({ length: 20 }, (_, k) => ({
      round: k % me.rounds,
      timeInRound: 20 + k,
      killerPuuid: k % 2 === 0 ? me.puuid : `enemy-${i}-${k % 5}`,
      victimPuuid: k % 2 === 0 ? `enemy-${i}-${k % 5}` : me.puuid,
      weapon: 'Vandal',
    })),
    rounds,
  } as unknown as TrackerMatchDetail;
};

const mkPlayer = (over: Partial<LiveMatchPlayer> & { puuid: string; name: string }): LiveMatchPlayer =>
  ({
    tag: 'EUW',
    team: 'Blue',
    agentId: 'jett',
    agentName: 'Jett',
    agentIcon: '',
    agentRole: 'Duelist',
    tier: 20,
    rank: 'Diamond 2',
    rr: 47,
    peakTier: 22,
    peakRank: 'Ascendant 1',
    peakSeasonId: 'act-2',
    accountLevel: 214,
    cardId: '',
    isMe: false,
    ...over,
  }) as LiveMatchPlayer;

/** A lobby with the awkward cases: me, a resolved friend, an incognito player,
 *  one whose name never resolved, one with no rank, one private profile. */
export const liveStateFixture = (): LiveMatchState => {
  const blue: LiveMatchPlayer[] = [
    mkPlayer({ puuid: FIXTURE_PUUID, name: 'Youssef', tag: 'EUW', isMe: true, agentName: 'Jett' }),
    mkPlayer({ puuid: 'p2', name: 'Shadow', tag: 'EUW', agentName: 'Omen', partyId: 'party-1', partyIndex: 1 }),
    mkPlayer({ puuid: 'p3', name: 'Incognito', tag: 'EUW', agentName: 'Raze', isIncognito: true, partyId: 'party-1', partyIndex: 1 }),
    mkPlayer({ puuid: 'p4', name: 'Player 4', tag: '', agentName: 'Cypher', nameResolved: false, tier: 0, rank: '', rr: 0, peakTier: 0, peakRank: '', accountLevel: 0 }),
    mkPlayer({ puuid: 'p5', name: 'Hidden', tag: 'EUW', agentName: 'Sova', isRankHidden: true, rank: '', rr: 0 }),
  ];
  const red: LiveMatchPlayer[] = Array.from({ length: 5 }, (_, k) =>
    mkPlayer({
      puuid: `e${k}`,
      name: `Enemy ${k + 1}`,
      team: 'Red',
      agentName: ['Reyna', 'Chamber', 'Viper', 'Breach', 'Skye'][k],
      tier: 18 + k,
      rank: ['Platinum 1', 'Platinum 3', 'Diamond 1', 'Diamond 2', 'Ascendant 1'][k],
      rr: 20 + k * 7,
      partyId: k < 2 ? 'party-2' : undefined,
      partyIndex: k < 2 ? 1 : 0,
    })
  );
  return {
    phase: 'coregame',
    matchId: 'live-1',
    mapId: 'ascent',
    mapName: 'Ascent',
    mode: 'competitive',
    isDeathmatch: false,
    queueId: 'competitive',
    serverName: 'Frankfurt',
    startingSide: 'Defense',
    allyScore: 6,
    enemyScore: 4,
    blueTeam: blue,
    redTeam: red,
    updatedAt: NOW,
  };
};

/** Keys the app reads on boot. Seeding these exercises the real merge path —
 *  no component is bypassed and no fetch is faked. */
export const storageFixture = (kind: 'lobby' | 'act' | 'empty' | 'error') => {
  const snapshotKey = `recon_tracker_snapshot_v1:${FIXTURE_PUUID.toLowerCase()}`;
  if (kind === 'empty') return { [snapshotKey]: '' };
  const games = gamesFixture(20);
  const details: Record<string, string> = {};
  games.slice(0, 11).forEach((g, i) => {
    details[`recon_match_v7_${g.matchId}`] = JSON.stringify(detailFixture(g.matchId, i));
  });
  const snapshot = {
    savedAt: NOW - 2 * 3600_000,
    puuid: FIXTURE_PUUID,
    profile: profileFixture(),
    games,
    agg: { kills: 220, deaths: 110, assists: 55, damage: 33000, rounds: 220, matches: 11, kd: 2, adr: 150 },
    mapById: Object.fromEntries(games.map((g) => [g.matchId, ['Ascent', 'Haven', 'Lotus', 'Sunset', 'Abyss'][games.indexOf(g) % 5]])),
    queueById: {},
    seasonNames: { 'act-3': 'Episode 9 · Act 3', 'act-2': 'Episode 9 · Act 2', 'act-1': 'Episode 9 · Act 1' },
    seasonOrder: ['act-1', 'act-2', 'act-3'],
    trn: { wins: 34, losses: 29, winPct: 54, acs: 218, kd: 1.24, adr: 142, hsPct: 27 },
    trnAgents: [
      { agent: 'Jett', matches: 34, winPct: 54 },
      { agent: 'Omen', matches: 12, winPct: 58 },
    ],
    trnMaps: [],
    trnPrev: { 'act-2': { kd: 1.18 }, 'act-1': { kd: 1.05 } },
    trnMatchTrs: {},
    trnFetchedAt: kind === 'error' ? undefined : NOW - 4 * 3600_000,
    detailsById: {},
    detailsReady: 0,
  };
  const serialized = JSON.stringify(snapshot);
  /* Both keys: the app reads the per-puuid snapshot when it knows the account,
   * and the legacy single-slot key when the client is closed and it does not. */
  const out: Record<string, string> = {
    [snapshotKey]: serialized,
    recon_tracker_snapshot_v1: serialized,
    ...details,
  };
  if (kind === 'lobby') {
    out['recon_live_match_state_v2'] = JSON.stringify(liveStateFixture());
    out['recon_live_player_stats_v3'] = JSON.stringify({
      [FIXTURE_PUUID]: { fetchedAt: NOW - 4 * 3600_000, kd: 1.24, hsPct: 27 },
      p2: { fetchedAt: NOW - 9 * 86_400_000, kd: 1.1, hsPct: 22 },
    });
  }
  return out;
};

/** The wire payloads the live parser reads. Shapes follow the parser's field
 *  contract (docs/v2/live-fixture-contract.md), not a capture: no match ran
 *  while logging existed, and that is stated rather than implied. */
export const coreGamePayload = (): unknown => ({
  MatchID: 'live-1',
  MapID: '/Game/Maps/Ascent/Ascent',
  ModeID: '/Game/GameModes/Bomb/BombGameMode.BombGameMode_C',
  GamePodID: 'aresriot.aws-euc1-prod.eu-gp-frankfurt-1',
  MatchInformation: { TeamScores: { Blue: 6, Red: 4 } },
  Players: liveStateFixture().blueTeam.concat(liveStateFixture().redTeam).map((p) => ({
    Subject: p.puuid,
    TeamID: p.team === 'Blue' ? 'Blue' : 'Red',
    CharacterID: p.agentId,
    PlayerIdentity: {
      AccountLevel: p.accountLevel,
      PlayerCardID: p.cardId,
      Incognito: Boolean(p.isIncognito),
      partyId: p.partyId,
    },
  })),
});

/** base64url of a JWT body carrying `pp.c`, which is how the region resolves. */
export const fakeEntitlementToken = (): string => {
  const body = btoa(JSON.stringify({ pp: { c: 'eu' } })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `h.${body}.s`;
};
