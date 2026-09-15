import type { LiveMatchPlayer, LiveMatchState } from '../types';

/**
 * Dev-dashboard flag. Direct static access is REQUIRED — Vite replaces
 * `import.meta.env.DEV` at compile time; any indirection (aliases, casts
 * through another variable) survives to runtime where `.env` is undefined.
 */
export const IS_DEV: boolean = import.meta.env.DEV === true;

export type DevMockPhase = 'off' | 'pregame' | 'coregame' | 'deathmatch';
export const DEV_MOCK_KEY = 'aspect_dev_mock_match';
export const DEV_TAB_KEY = 'aspect_dev_tab_held';
export const DEV_NO_CLIENT_KEY = 'aspect_dev_no_client';

const readFlag = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const getDevMockPhase = (): DevMockPhase => {
  // Ungated, any prod user (or stray extension) with this localStorage key
  // would get canned fake-match data in live paths. Dev-only, like the
  // sibling flags below.
  if (!IS_DEV) return 'off';
  const v = readFlag(DEV_MOCK_KEY);
  return v === 'pregame' || v === 'coregame' || v === 'deathmatch' ? v : 'off';
};

/** Physical-Tab override for testing the in-match scoreboard peek hands-free. */
export const isDevTabHeld = (): boolean => {
  if (!IS_DEV) return false;
  try {
    return localStorage.getItem(DEV_TAB_KEY) === '1';
  } catch {
    return false;
  }
};

/** Pretend the Riot Client is closed to exercise empty states. */
export const isDevNoClient = (): boolean => {
  if (!IS_DEV) return false;
  try {
    return localStorage.getItem(DEV_NO_CLIENT_KEY) === '1';
  } catch {
    return false;
  }
};

let mockIdx = 0;
const AGENT_META: Record<string, { icon: string; role: string }> = {
  jett: { icon: 'https://media.valorant-api.com/agents/add6443a-41bd-e414-f6ad-e58d267f4e95/displayicon.png', role: 'Duelist' },
  omen: { icon: 'https://media.valorant-api.com/agents/8e252d04-4643-3281-92ff-8549f6bcbc31/displayicon.png', role: 'Controller' },
  sova: { icon: 'https://media.valorant-api.com/agents/320b2a48-4d9b-a075-30f1-1f93a9b638fa/displayicon.png', role: 'Initiator' },
  killjoy: { icon: 'https://media.valorant-api.com/agents/1e58de9c-4950-5125-93e9-a0aee9f98746/displayicon.png', role: 'Sentinel' },
  raze: { icon: 'https://media.valorant-api.com/agents/f94c3b30-42be-e959-889c-5aa313dba261/displayicon.png', role: 'Duelist' },
  reyna: { icon: 'https://media.valorant-api.com/agents/a3bfb853-43b2-7238-a4f1-ad90e9e46bcc/displayicon.png', role: 'Duelist' },
  viper: { icon: 'https://media.valorant-api.com/agents/707eab51-4836-f488-046a-cda6bf494859/displayicon.png', role: 'Controller' },
  cypher: { icon: 'https://media.valorant-api.com/agents/117ed9e3-49f3-6512-3ccf-0cada7e3823b/displayicon.png', role: 'Sentinel' },
  sage: { icon: 'https://media.valorant-api.com/agents/569fdd95-4d10-43ab-ca70-79becc718b46/displayicon.png', role: 'Sentinel' },
  phoenix: { icon: 'https://media.valorant-api.com/agents/eb9333ab-4034-bc35-8964-64c426378049/displayicon.png', role: 'Duelist' },
};

const mk = (
  name: string,
  team: 'Blue' | 'Red',
  tier: number,
  rank: string,
  extra?: Partial<LiveMatchPlayer>
): LiveMatchPlayer => {
  const i = mockIdx++;
  const kds = [1.38, 1.15, 0.94, 1.08, 1.22, 0.88, 1.45, 1.02, 1.11, 0.96];
  const countries = ['EG', 'DE', 'FR', 'GB', 'US', 'SA', 'TR', 'IT', 'ES', 'SE'];
  return {
    puuid: `dev-puuid-${team}-${i}`,
    name,
    tag: `DEV${i}`,
    team,
    agentId: '',
    agentName: 'Selecting…',
    agentIcon: '',
    agentRole: '',
    tier,
    rank,
    rr: 40 + (i * 7) % 55,
    peakTier: tier + 2,
    peakRank: rank,
    // Real season uuid so the "peak reached in" act label renders in previews.
    peakSeasonId: '8102cd81-43a0-d0d7-bd59-47b8fe9bed1b',
    actWins: 12 + i,
    actGames: 20 + i,
    accountLevel: 100 + (i * 23) % 250,
    cardId: '',
    isMe: false,
    selectionState: '',
    region: 'EU',
    country: countries[i % countries.length],
    kd: kds[i % kds.length],
    winPct: 48 + (i % 5) * 3,
    hsPct: 24 + (i % 4),
    // Spread across the tier bands so the badge range is visible in previews.
    trnScore: [880, 690, 520, 410, 940, 610, 760, 330, 830, 560, 700, 470][i % 12],
    // Also spread across the ACS bands so the ACS sort is visibly working.
    acs: [268, 191, 142, 118, 305, 176, 224, 96, 251, 133, 288, 165][i % 12],
    recentWon: 3 + (i % 4),
    recentLost: i % 3,
    streak: 2,
    streakIsWin: true,
    ...extra,
  };
};

const FIVE = ['You', 'Shadow', 'ViperX', 'Clutch', 'Phantom'];
const FOE = ['ReynaMain', 'Silent', 'Headshot', 'EcoFrag', 'Smurf'];

function mockPregame(): LiveMatchState {
  mockIdx = 0;
  // Duo 1: You + Shadow in Party 1; Duo 2: Clutch + Phantom in Party 2
  const bluePartyMap: Record<number, number> = { 0: 1, 1: 1, 3: 2, 4: 2 };
  // Trio: ReynaMain + Silent + Headshot in Party 3; Duo: EcoFrag + Smurf in Party 4
  const redPartyMap: Record<number, number> = { 0: 3, 1: 3, 2: 3, 3: 4, 4: 4 };

  const blueTeam = FIVE.map((n, i) =>
    mk(n, 'Blue', 21 - (i % 2), i % 2 ? 'Diamond 2' : 'Diamond 1', {
      isMe: i === 0,
      partyIndex: bluePartyMap[i],
      partyId: bluePartyMap[i] ? `dev-party-${bluePartyMap[i]}` : undefined,
    })
  );
  const redTeam = FOE.map((n, i) =>
    mk(n, 'Red', 20 + (i % 3), 'Platinum 3', {
      partyIndex: redPartyMap[i],
      partyId: redPartyMap[i] ? `dev-party-${redPartyMap[i]}` : undefined,
    })
  );
  return {
    phase: 'pregame',
    matchId: 'dev-match-pregame',
    mapId: '/game/maps/ascent/ascent',
    mapName: 'Ascent',
    mode: 'Competitive',
    isDeathmatch: false,
    serverId: 'aresriot.aws-rclusterprod-eu2-1.eu-gp-frankfurt-1',
    serverName: 'Frankfurt · EU2',
    blueTeam,
    redTeam,
    updatedAt: Date.now(),
  };
}

function mockCoregame(): LiveMatchState {
  const s = mockPregame();
  const agents = ['Jett', 'Omen', 'Sova', 'Killjoy', 'Raze'];
  const foes = ['Reyna', 'Viper', 'Cypher', 'Sage', 'Phoenix'];
  return {
    ...s,
    phase: 'coregame',
    matchId: 'dev-match-coregame',
    blueTeam: s.blueTeam.map((p, i) => {
      const meta = AGENT_META[agents[i].toLowerCase()];
      return { ...p, agentName: agents[i], agentIcon: meta?.icon || '', agentRole: meta?.role || '' };
    }),
    redTeam: s.redTeam.map((p, i) => {
      const meta = AGENT_META[foes[i].toLowerCase()];
      return { ...p, agentName: foes[i], agentIcon: meta?.icon || '', agentRole: meta?.role || '' };
    }),
    updatedAt: Date.now(),
  };
}

function mockDeathmatch(): LiveMatchState {
  mockIdx = 0;
  // Duo 1: Fragger 1 (You) + Fragger 3 in Party 1 (Amber)
  // Duo 2: Fragger 7 + Fragger 8 in Party 2 (Cyan)
  const dmParties: Record<number, number> = { 1: 1, 3: 1, 7: 2, 8: 2 };
  const mkDm = (n: number, team: 'Blue' | 'Red'): LiveMatchPlayer =>
    mk(`Fragger${n}`, team, 18 + (n % 5), 'Gold 3', {
      isMe: n === 1,
      name: n === 1 ? 'You' : `Fragger${n}`,
      partyIndex: dmParties[n],
      partyId: dmParties[n] ? `dev-dm-party-${dmParties[n]}` : undefined,
    });
  return {
    phase: 'coregame',
    matchId: 'dev-match-deathmatch',
    mapId: '/game/maps/bonsai/bonsai',
    mapName: 'Split',
    mode: 'Deathmatch',
    isDeathmatch: true,
    serverId: 'aresriot.aws-rclusterprod-eu2-1.eu-gp-frankfurt-1',
    serverName: 'Frankfurt · EU2',
    blueTeam: [1, 2, 3, 4, 5, 6].map((n) => mkDm(n, 'Blue')),
    redTeam: [7, 8, 9, 10, 11, 12].map((n) => mkDm(n, 'Red')),
    updatedAt: Date.now(),
  };
}

/** Canned match state for testing overlay + live views with Riot closed. */
export function getDevMockMatch(): LiveMatchState | null {
  // Belt-and-braces alongside the getDevMockPhase gate: mock data must never
  // reach a production build even if a caller bypasses the phase check.
  if (!IS_DEV) return null;
  switch (getDevMockPhase()) {
    case 'pregame':
      return mockPregame();
    case 'coregame':
      return mockCoregame();
    case 'deathmatch':
      return mockDeathmatch();
    default:
      return null;
  }
}
