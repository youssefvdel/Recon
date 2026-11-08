/* Round-timeline data half: parser + metrics.
 *
 * Two layers, matching docs/features/round-timeline.md §1 and §2:
 *   - `parseRoundDetails` (in tracker.ts) turns Riot's roundResults[] into the
 *     frozen model. It is pure and exported so this file can drive it with
 *     synthetic payloads instead of a live match.
 *   - `roundTimeline.ts` turns that model into numbers.
 *
 *   bun scripts/round-timeline-check.ts
 */
export {};

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(
      `FAIL - ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`
    );
  }
}

const { parseRoundDetails } = await import('../src/utils/tracker.ts');
const { roundsForPlaylist, roundFormatFor, perRoundAverages, economyTimeline, halves } =
  await import('../src/utils/roundTimeline.ts');

const ME = 'me-puuid';
const MATE = 'mate-puuid';
const ENEMY = 'enemy-puuid';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

/** One player's roundStats block. */
function ps(subject: string, opts: Partial<{ kills: Row[]; damage: Row[]; eco: Row | null }> = {}): Row {
  const out: Row = {
    subject,
    kills: opts.kills ?? [],
    damage: opts.damage ?? [],
  };
  if (opts.eco !== null) {
    out.economy = opts.eco ?? { loadoutValue: 3900, remaining: 200, spent: 2900, weapon: 'Vandal', armor: 'Heavy Shields' };
  }
  return out;
}

function kill(s: { victim: string; assistants?: string[]; roundTime?: number; gameTime?: number; weapon?: string }): Row {
  return {
    victim: s.victim,
    assistants: s.assistants ?? [],
    roundTime: s.roundTime ?? 21000,
    gameTime: s.gameTime ?? 65000,
    finishingDamage: { damageItem: s.weapon ?? 'Vandal' },
  };
}

function round(n: number, players: Row[], extra: Row = {}): Row {
  return { roundNum: n, winningTeam: n % 2 === 0 ? 'Red' : 'Blue', roundResult: 'Elimination', playerStats: players, ...extra };
}

// --- 1. A normal round: deaths + assists are derived across players ----------
{
  const r = round(1, [
    ps(ME, {
      kills: [kill({ victim: ENEMY, assistants: [MATE], roundTime: 31000 })],
      damage: [
        { receiver: ENEMY, damage: 160, headshots: 1, bodyshots: 1, legshots: 0 },
        { receiver: ENEMY, damage: 40, headshots: 1, bodyshots: 0, legshots: 0 },
      ],
    }),
    ps(MATE, { kills: [] }),
    ps(ENEMY, { kills: [] }),
  ]);
  const [d] = parseRoundDetails([r]);
  check('round count', d.roundNum, 1);
  check('killer kills', d.players[0].kills, 1);
  // The victim never appears in their own kills[] — death is derived.
  check('victim deaths derived', d.players[2].deaths, 1);
  check('killer deaths', d.players[0].deaths, 0);
  check('assist derived from assistants[]', d.players[1].assists, 1);
  check('headshots summed', d.players[0].headshots, 2);
  check('bodyshots summed', d.players[0].bodyshots, 1);
  check('damageDealt is attacker side', d.players[0].damageDealt, 200);
  check('damageTaken is receiver side', d.players[2].damageTaken, 200);
  check('kill line weapon + clock', [d.players[0].killsDetail[0].weapon, d.players[0].killsDetail[0].roundTimeMs], ['Vandal', 31000]);
  check('kill line assistants', d.players[0].killsDetail[0].assistantPuuids, [MATE]);
  check('economy read through', [d.players[0].economy.loadoutValue, d.players[0].economy.weapon], [3900, 'Vandal']);
}

// --- 2. A plant round --------------------------------------------------------
{
  const r = round(5, [ps(ME, { kills: [] })], {
    roundResult: 'Bomb detonated',
    bombPlanter: ME.toUpperCase(),
    plantSite: 'B',
    plantRoundTime: 42000,
  });
  const [d] = parseRoundDetails([r]);
  check('plant flags', [d.bombPlanter, d.plantSite, d.plantRoundTimeMs], [ME, 'B', 42000]);
  check('plant puuid lowercased', d.bombPlanter, ME);
  check('plant round result kept', d.roundResult, 'Bomb detonated');
  check('no defuser on a plant round', d.bombDefuser, undefined);
}

// --- 3. A defuse round -------------------------------------------------------
{
  const r = round(6, [ps(ME, { kills: [] })], {
    roundResult: 'Bomb defused',
    bombDefuser: MATE,
    defuseRoundTime: 33000,
  });
  const [d] = parseRoundDetails([r]);
  check('defuse flags', [d.bombDefuser, d.defuseRoundTimeMs], [MATE, 33000]);
  check('no planter on a defuse round', d.bombPlanter, undefined);
  check('plantSite omitted, not guessed', 'plantSite' in d, false);
}

// --- 4. A round with no playerStats still yields an entry --------------------
{
  const d = parseRoundDetails([{ roundNum: 7, winningTeam: 'Blue' }])[0];
  check('empty round keeps its number', d.roundNum, 7);
  check('empty round has players: []', d.players, []);
  check('empty round keeps the winner', d.winningTeam, 'Blue');
}

// --- 5. A player with no economy block ---------------------------------------
{
  const r = round(8, [ps(ME, { kills: [], eco: null })]);
  const d = parseRoundDetails([r])[0];
  // The type requires numbers, so an absent economy is zeros, never a guess.
  check(
    'missing economy -> zeros, no invented weapon',
    [d.players[0].economy.loadoutValue, d.players[0].economy.remaining, d.players[0].economy.weapon],
    [0, 0, undefined]
  );
  check('economyTimeline still emits the round', economyTimeline([d], ME).length, 1);
}

// --- 6. A 13-round regulation match -----------------------------------------
{
  const rounds = Array.from({ length: 13 }, (_, i) =>
    round(i + 1, [ps(ME, { kills: i < 2 ? [kill({ victim: ENEMY })] : [], damage: [{ receiver: ENEMY, damage: 100, headshots: 1, bodyshots: 0, legshots: 0 }] })])
  );
  const parsed = parseRoundDetails(rounds);
  check('13 rounds parsed', parsed.length, 13);
  check('round numbers 1..13', parsed.map((r: Row) => r.roundNum), Array.from({ length: 13 }, (_, i) => i + 1));
}

// --- 7. A 25-round overtime match -------------------------------------------
{
  const rounds = Array.from({ length: 25 }, (_, i) => round(i + 1, [ps(ME, { kills: [] })]));
  const parsed = parseRoundDetails(rounds);
  check('25 OT rounds parsed', parsed.length, 25);
  const shape = roundsForPlaylist('competitive');
  check('competitive cap is 27', shape.cap, 27);
  check('competitive has overtime', shape.overtime, true);
  check('a 25-round match fits the cap', parsed.length <= shape.cap, true);
}

// --- 8. Playlist halves: 25 / 19 / 9 / 7 ------------------------------------
{
  check('competitive -> 25', roundsForPlaylist('competitive').maxRounds, 25);
  check('unrated -> 25', roundsForPlaylist('unrated').maxRounds, 25);
  check('swiftplay -> 9', roundsForPlaylist('swiftplay').maxRounds, 9);
  check('spike rush -> 7', roundsForPlaylist('spikerush').maxRounds, 7);
  check('unknown mode -> 19 fallback (never truncates)', roundsForPlaylist('some-new-mode').maxRounds, 19);
  check('null playlist -> 19 fallback', roundsForPlaylist(null).maxRounds, 19);
  check('case and spacing tolerated', roundFormatFor('  SWIFTPLAY '), 'swiftplay');
  check('competitive halves', halves(roundsForPlaylist('competitive').firstTo), { first: [1, 12], second: [13, 24] });
  check('swiftplay halves', halves(roundsForPlaylist('swiftplay').firstTo), { first: [1, 4], second: [5, 8] });
}

// --- 9. Metrics over the parsed model --------------------------------------
{
  // 3 rounds for ME: 2 kills, 1 death, 1 assist-free round survived.
  const rounds = [
    round(1, [
      ps(ME, { kills: [kill({ victim: ENEMY })], damage: [{ receiver: ENEMY, damage: 150, headshots: 2, bodyshots: 1, legshots: 0 }] }),
      ps(ENEMY, { kills: [] }),
    ]),
    round(2, [
      ps(ME, { kills: [], damage: [{ receiver: ENEMY, damage: 50, headshots: 0, bodyshots: 1, legshots: 0 }] }),
      ps(ENEMY, { kills: [kill({ victim: ME })] }),
    ]),
    round(3, [ps(ME, { kills: [], damage: [] })]),
  ];
  const parsed = parseRoundDetails(rounds);
  const avg = perRoundAverages(parsed, ME);
  check('averaged over rounds the player appears in', avg.rounds, 3);
  check('ADR = 200 damage / 3 rounds', avg.adr, 66.7);
  check('DD delta = (200 - 0) / 3', avg.ddPerRound, 66.7);
  // 2 headshots of 4 hits (round 1: 2h/1b, round 2: 0h/1b).
  check('HS% = 2 of 4 hits', avg.hsPct, 50);
  check('KAST counts kill, death(traded-or-not), survive', avg.kastPct > 0, true);
  check('ACS is null without a scoreboard score', avg.acs, null);
  check('ACS uses the caller score when supplied', perRoundAverages(parsed, ME, { score: 600 }).acs, 200);

  const eco = economyTimeline(parsed, ME);
  check('economy timeline covers 3 rounds', eco.length, 3);
  check('economy timeline round numbers', eco.map((e: Row) => e.roundNum), [1, 2, 3]);
  check('economy for an unknown puuid is empty, not zero-filled', economyTimeline(parsed, 'nobody').length, 0);
}

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All round-timeline tests passed.');
