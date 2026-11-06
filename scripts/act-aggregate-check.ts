// Act-window aggregation for the local-Riot stats path (tracker.gg is dead,
// see docs/upstream). Checks the pure aggregator behaviorally with fixtures,
// plus the wiring rule that matters most: nothing is invented when the
// payload does not carry it.
//
//   bun scripts/act-aggregate-check.ts
export {};

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${detail !== undefined ? `\n  detail: ${JSON.stringify(detail)}` : ''}`);
  }
}

const { aggregateActStats } = await import('../src/utils/actStats.ts');
type Sample = { won: boolean | null; kills: number; deaths: number; score: number; rounds: number };

// 1. Two clean wins: K/D, win% and ACS all computable.
{
  const s: Sample[] = [
    { won: true, kills: 20, deaths: 10, score: 4000, rounds: 25 },
    { won: true, kills: 10, deaths: 10, score: 3000, rounds: 25 },
  ];
  const a = aggregateActStats(s);
  check('two wins -> kd 1.5', a.kd === 1.5, a);
  check('two wins -> winPct 100', a.winPct === 100, a);
  check('two wins -> acs 140 (7000 / 50)', a.acs === 140, a);
  check('two wins -> games 2', a.games === 2, a);
}

// 2. A draw has a real scoreboard but an unknown result: it counts toward
//    K/D and ACS, and must NOT become a win or a loss.
{
  const s: Sample[] = [
    { won: true, kills: 12, deaths: 12, score: 2400, rounds: 24 },
    { won: null, kills: 24, deaths: 12, score: 4800, rounds: 24 },
  ];
  const a = aggregateActStats(s);
  check('draw excluded from games', a.games === 1, a);
  check('draw excluded from winPct', a.winPct === 100, a);
  check('draw still feeds kd', a.kd === 1.5, a);
  check('draw still feeds acs', a.acs === 150, a);
}

// 3. Zero deaths: K/D is literally infinite, so it stays blank. ACS and win%
//    are still true and are still reported.
{
  const s: Sample[] = [{ won: true, kills: 13, deaths: 0, score: 3800, rounds: 19 }];
  const a = aggregateActStats(s);
  check('no deaths -> kd null (not faked as kills)', a.kd === null, a);
  check('no deaths -> winPct still 100', a.winPct === 100, a);
  check('no deaths -> acs still computed', a.acs === 200, a);
}

// 4. Nothing usable: empty input and a zero-round sample both yield nulls,
//    never 0 (0 would render as "0.00 K/D" and read as a real stat).
{
  const empty = aggregateActStats([]);
  check('empty -> kd null', empty.kd === null, empty);
  check('empty -> winPct null', empty.winPct === null, empty);
  check('empty -> acs null', empty.acs === null, empty);
  const zeroRounds = aggregateActStats([{ won: true, kills: 5, deaths: 5, score: 500, rounds: 0 }]);
  check('zero rounds -> acs null', zeroRounds.acs === null, zeroRounds);
  check('zero rounds -> not counted as a game', zeroRounds.games === 0, zeroRounds);
}

// 5. Junk numbers never leak through as NaN (Riot omits fields on some modes).
{
  const a = aggregateActStats([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { won: false, kills: 'x' as any, deaths: 4, score: 800, rounds: 20 },
  ]);
  check('non-numeric kills treated as 0', a.kd === 0, a);
  check('non-numeric kills never NaN', Number.isFinite(a.kd as number), a);
}

// 6. Rank parser: /mmr/v1 -> the row the UI already renders. Public rank +
//    RR only; nothing is called MMR and nothing is derived.
{
  const { parseLocalRank } = await import('../src/utils/tracker.ts');
  const live = parseLocalRank(
    {
      LatestCompetitiveUpdate: { TierAfterUpdate: 21, SeasonID: 'abc', RankedRatingAfterUpdate: 40 },
      QueueSkills: {
        competitive: {
          SeasonalInfoBySeasonID: {
            abc: { RankedRating: 77, NumberOfWins: 9, NumberOfGames: 14, LeaderboardRank: 0 },
            def: { CompetitiveTier: 24 },
          },
        },
      },
      IsActRankBadgeHidden: false,
    },
    ['abc', 'def']
  );
  check('rank: tier from TierAfterUpdate', live.tier === 21, live);
  check('rank: RR is the LIVE season value (77), not the stale 40', live.rr === 77, live);
  check('rank: peak is the all-time high (24)', live.peakTier === 24, live);
  check('rank: peak season named', live.peakSeasonId === 'def', live);
  check('rank: act games counted', live.actGames === 14 && live.actWins === 9, live);

  const empty = parseLocalRank({}, []);
  check('rank: empty payload -> zeros, no throw', empty.tier === 0 && empty.rr === 0 && empty.peakTier === 0, empty);
  check('rank: unranked act reports 0 games', empty.actGames === 0, empty);

  const hidden = parseLocalRank({ IsActRankBadgeHidden: true }, []);
  check('rank: hidden badge propagates', hidden.isRankHidden === true, hidden);
}

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All act-aggregate tests passed.');
