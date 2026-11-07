/* Act window aggregation, computed from Riot-LOCAL match details.
 *
 * tracker.gg used to hand us act-wide K/D, ACS and win rate. It is gone for
 * this app (Warden captcha, no VALORANT licence), so these are computed from
 * the scoreboards the local Riot client already answers for.
 *
 * PURE by design: no imports, no I/O, no clock. Everything that can go wrong
 * in the fetch lives in tracker.ts; this file only does arithmetic, so
 * scripts/act-aggregate-check.ts can test it without a desktop runtime.
 *
 * HONESTY RULES (repo AGENTS.md — this app never invents a number):
 *  - A match with no known result (draw, FFA, unreadable) is NOT a game and
 *    never contributes a win or a loss.
 *  - Zero deaths means K/D is genuinely undefined (infinite), so it stays
 *    null (blank in the UI) rather than being faked as `kills`.
 *  - Zero rounds means ACS is undefined -> null.
 *  - Percentiles, KAST, damage delta and Tracker Score are NOT in this
 *    payload, so they are not computed here at all. */

/** One match for one player, as read from a local match-details scoreboard. */
export interface ActMatchSample {
  /** true = win, false = loss, null = result unknown (draw/FFA/unreadable). */
  won: boolean | null;
  kills: number;
  deaths: number;
  /** Round score (the player's own scoreboard `score`, i.e. combat score). */
  score: number;
  rounds: number;
}

export interface ActAggregate {
  /** Games that could be read AND had a known result. */
  games: number;
  /** Kills/deaths over those games; null when there were no deaths. */
  kd: number | null;
  /** Win rate 0-100 over games with a known result; null when none. */
  winPct: number | null;
  /** Average combat score per round; null when no rounds were read. */
  acs: number | null;
}

const fin = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** Aggregate per-match samples into the act window. Pure — unit-tested. */
export function aggregateActStats(samples: ActMatchSample[]): ActAggregate {
  let games = 0;
  let wins = 0;
  let kills = 0;
  let deaths = 0;
  let score = 0;
  let rounds = 0;

  for (const s of samples) {
    const k = fin(s.kills);
    const d = fin(s.deaths);
    const sc = fin(s.score);
    const r = fin(s.rounds);
    // A sample with no rounds read is not a usable game — it would drag ACS
    // toward zero with a denominator it never contributed to.
    if (r <= 0) continue;
    kills += k;
    deaths += d;
    score += sc;
    rounds += r;
    if (s.won === true) {
      wins += 1;
      games += 1;
    } else if (s.won === false) {
      games += 1;
    }
  }

  return {
    games,
    kd: deaths > 0 ? Math.round((kills / deaths) * 100) / 100 : null,
    winPct: games > 0 ? Math.round((wins / games) * 100) : null,
    acs: rounds > 0 ? Math.round((score / rounds) * 10) / 10 : null,
  };
}
