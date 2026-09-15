// Unit tests for the GamePodID → short-label parser (src/utils/matchServer.ts).
//
//   bun scripts/match-server-check.ts
export {};

const { parseGamePodId, extractGamePodId } = await import('../src/utils/matchServer.ts');

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (ok) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

// EU / US / AP / LATAM / Bahrain-style pods (+ legacy cluster shape).
check('eu frankfurt', parseGamePodId('aresriot.aws-rclusterprod-eu2-1.eu-gp-frankfurt-1'), 'Frankfurt · EU2');
check('eu paris second pod', parseGamePodId('aresriot.aws-rclusterprod-eu1-1.eu-gp-paris-2'), 'Paris · EU1');
check('us oregon', parseGamePodId('aresriot.aws-rclusterprod-us2-1.na-gp-oregon-1'), 'Oregon · US2');
check('us n virginia', parseGamePodId('aresriot.aws-rclusterprod-us1-1.na-gp-n_virginia-1'), 'N. Virginia · US1');
check('ap singapore', parseGamePodId('aresriot.aws-rclusterprod-ap1-1.ap-gp-singapore-1'), 'Singapore · AP1');
check('ap tokyo', parseGamePodId('aresriot.aws-rclusterprod-ap2-1.ap-gp-tokyo-1'), 'Tokyo · AP2');
check('latam mexico city', parseGamePodId('aresriot.aws-rclusterprod-latam1-1.latam-gp-mexico_city-1'), 'Mexico City · LATAM1');
check('latam sao paulo', parseGamePodId('aresriot.aws-rclusterprod-latam2-1.latam-gp-sao_paulo-1'), 'São Paulo · LATAM2');
check('bahrain', parseGamePodId('aresriot.aws-rclusterprod-me1-1.me-gp-bahrain-1'), 'Bahrain · ME1');
check(
  'legacy aws cluster shape',
  parseGamePodId('aresriot.aws-euc1-prod.eu-gp-frankfurt-1'),
  'Frankfurt · EUC1'
);

// Unknown formats fall back to the raw trailing pod segment.
check(
  'unknown format fallback',
  parseGamePodId('aresriot.custom-cluster-9.custompod-xyz'),
  'custompod-xyz'
);
check('single segment fallback', parseGamePodId('mystery-pod-7'), 'mystery-pod-7');

// Empty / invalid input never crashes, yields null.
check('empty string → null', parseGamePodId(''), null);
check('whitespace → null', parseGamePodId('   '), null);
check('non-string → null', parseGamePodId(null), null);
check('undefined → null', parseGamePodId(undefined), null);

// Payload extraction across key casings.
check(
  'extract GamePodID',
  extractGamePodId({ GamePodID: 'aresriot.aws-rclusterprod-eu2-1.eu-gp-frankfurt-1' }),
  'aresriot.aws-rclusterprod-eu2-1.eu-gp-frankfurt-1'
);
check('extract gamePodId', extractGamePodId({ gamePodId: 'x' }), 'x');
check('extract absent → null', extractGamePodId({}), null);
check('extract null → null', extractGamePodId(null), null);

// Coverage sweep: unknown-city humanize, digit-less clusters, key aliases,
// non-object payloads, blank-value skipping, empty city slug.
check(
  'unknown city humanizes with pod prefix shard',
  parseGamePodId('aresriot.custom-cluster-9.xx-gp-newcity-1'),
  'Newcity · XX'
);
check(
  'cluster without digit falls back to pod prefix',
  parseGamePodId('aresriot.aws-eu-prod.eu-gp-paris-1'),
  'Paris · EU'
);
check(
  'empty city slug → raw pod segment',
  parseGamePodId('aresriot.aws-eu1-1.eu-gp--1'),
  'eu-gp--1'
);
check('number pod → null', parseGamePodId(42), null);
check('extract GamePod key', extractGamePodId({ GamePod: 'y' }), 'y');
check('extract gamePod key', extractGamePodId({ gamePod: 'z' }), 'z');
check('extract array → null', extractGamePodId([]), null);
check('extract string → null', extractGamePodId('x'), null);
check(
  'blank value skipped for next key',
  extractGamePodId({ GamePodID: '   ', gamePodId: 'w' }),
  'w'
);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All match-server parser tests passed.');
