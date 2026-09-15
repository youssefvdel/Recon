/* Match server (GamePodID) parsing — pure helpers, no imports.
 *
 * LCU GET /pregame/v1/match (agent select) and GET /core-game/v1/match
 * (in-game) return a GamePodID like
 * `aresriot.aws-rclusterprod-eu2-1.eu-gp-frankfurt-1`. These map it to a
 * short display label like `Frankfurt · EU2` for the server chip shown on
 * the Live Match page and both HUD widgets. */

const CITY_NAMES: Record<string, string> = {
  frankfurt: 'Frankfurt',
  paris: 'Paris',
  stockholm: 'Stockholm',
  warsaw: 'Warsaw',
  london: 'London',
  madrid: 'Madrid',
  istanbul: 'Istanbul',
  oregon: 'Oregon',
  hillsboro: 'Hillsboro',
  n_virginia: 'N. Virginia',
  virginia: 'Virginia',
  ashburn: 'Ashburn',
  ohio: 'Ohio',
  columbus: 'Columbus',
  n_california: 'N. California',
  california: 'California',
  san_jose: 'San Jose',
  texas: 'Texas',
  dallas: 'Dallas',
  chicago: 'Chicago',
  illinois: 'Chicago',
  atlanta: 'Atlanta',
  singapore: 'Singapore',
  tokyo: 'Tokyo',
  osaka: 'Osaka',
  seoul: 'Seoul',
  sydney: 'Sydney',
  mumbai: 'Mumbai',
  hong_kong: 'Hong Kong',
  bahrain: 'Bahrain',
  mexico_city: 'Mexico City',
  mexico: 'Mexico City',
  santiago: 'Santiago',
  sao_paulo: 'São Paulo',
};

function humanizeSlug(slug: string): string {
  const words = slug
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length > 0 ? words.join(' ') : slug;
}

/** Pull a GamePodID string out of a pregame/core-game payload (any key
 *  casing). Returns null when absent — never throws. */
export function extractGamePodId(payload: unknown): string | null {
  try {
    if (!payload || typeof payload !== 'object') return null;
    const o = payload as Record<string, unknown>;
    const keys = ['GamePodID', 'GamePodId', 'gamePodId', 'gamePodID', 'GamePod', 'gamePod'];
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/** Map a raw GamePodID to a short label like `Frankfurt · EU2`.
 *
 *  The city comes from the trailing pod segment (`eu-gp-frankfurt-1`) and
 *  the shard from the cluster segment (`aws-rclusterprod-eu2-1` → EU2,
 *  `aws-euc1-prod` → EUC1), falling back to the pod prefix (EU/NA/AP/…).
 *  Unknown formats fall back to the raw trailing pod segment. Returns null
 *  for empty/non-string input — never throws. */
export function parseGamePodId(pod: unknown): string | null {
  try {
    if (typeof pod !== 'string') return null;
    const trimmed = pod.trim();
    if (!trimmed) return null;
    const parts = trimmed
      .split('.')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    const podSeg = parts[parts.length - 1];
    const clusterSeg = parts.length > 1 ? parts[parts.length - 2] : '';
    const gpIdx = podSeg.toLowerCase().indexOf('-gp-');
    if (gpIdx < 0) return podSeg;
    const prefix = podSeg.slice(0, gpIdx);
    const citySlug = podSeg
      .slice(gpIdx + 4)
      .replace(/-\d+$/, '')
      .toLowerCase();
    if (!citySlug) return podSeg;
    const city = CITY_NAMES[citySlug] ?? humanizeSlug(citySlug);
    // First cluster token carrying a digit wins, skipping the literal
    // `rclusterprod` and bare numeric tokens.
    let shard = '';
    if (clusterSeg) {
      for (const tok of clusterSeg.split('-')) {
        const t = tok.trim();
        if (!t || /^\d+$/.test(t)) continue;
        if (/^rcluster/i.test(t)) continue;
        if (/\d/.test(t)) {
          shard = t.toUpperCase();
          break;
        }
      }
    }
    if (!shard && prefix) shard = prefix.toUpperCase();
    return shard ? `${city} · ${shard}` : city;
  } catch {
    return null;
  }
}
