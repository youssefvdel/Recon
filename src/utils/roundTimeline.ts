/* Round-timeline metrics — pure, no React, no IPC.
 *
 * Spec: docs/features/round-timeline.md §2. Every function here takes the
 * already-parsed `MatchRoundDetail[]` and returns numbers; nothing fetches,
 * nothing mutates its input, and nothing invents a value that the payload did
 * not carry. A player absent from a round contributes nothing to that round. */

import type { MatchRoundDetail, MatchRoundPlayer } from '../types';

/* ------------------------------------------------------------------ *
 * Playlist shapes
 * ------------------------------------------------------------------ */

export interface PlaylistRounds {
  /** Most rounds the match can contain before the strip is capped. */
  maxRounds: number;
  /** Rounds a side needs to win in regulation. */
  firstTo: number;
  /** Score level at which overtime starts (both sides at this = OT). */
  otAt: number;
  /** Hard display cap, overtime included. */
  cap: number;
  overtime: boolean;
}

/**
 * Round counts by mode. VALORANT's own numbers:
 *  - standard (competitive / unrated / custom / premier): first to 13, so 24
 *    regulation rounds and a 25th only if 12-12 forces overtime; 27 is the
 *    documented OT cap we display.
 *  - swiftplay: first to 5 → 9 rounds, no overtime.
 *  - spike rush: first to 4 → 7 rounds, never overtime.
 *  - 19: no shipped playlist in our data produces it. It is kept as the
 *    fallback for any long mode we do not recognise, because a wrong cap would
 *    TRUNCATE a real strip — the one failure a timeline must not have.
 * Source: docs/features/round-timeline.md §2.
 */
export const ROUND_FORMATS = {
  standard: { maxRounds: 25, firstTo: 13, otAt: 12, cap: 27, overtime: true },
  long: { maxRounds: 19, firstTo: 10, otAt: 9, cap: 19, overtime: false },
  swiftplay: { maxRounds: 9, firstTo: 5, otAt: 4, cap: 9, overtime: false },
  spikerush: { maxRounds: 7, firstTo: 4, otAt: 3, cap: 7, overtime: false },
} as const satisfies Record<string, PlaylistRounds>;

export type RoundFormatName = keyof typeof ROUND_FORMATS;

/** Map a Riot queue id string onto a round format. Pure. */
export function roundFormatFor(playlistId: string | undefined | null): RoundFormatName {
  const q = String(playlistId ?? '').toLowerCase().trim();
  if (q.includes('swiftplay')) return 'swiftplay';
  if (q.includes('spike') || q.includes('spikerush')) return 'spikerush';
  if (q.includes('competitive') || q.includes('unrated') || q.includes('custom') || q.includes('premier')) {
    return 'standard';
  }
  return 'long';
}

/** The round shape for a playlist. Pure. */
export function roundsForPlaylist(playlistId: string | undefined | null): PlaylistRounds {
  return ROUND_FORMATS[roundFormatFor(playlistId)];
}

/** Halves of a regulation match, as round indices (1-based, inclusive). */
export function halves(firstTo: number): { first: [number, number]; second: [number, number] } {
  const mid = Math.max(1, firstTo - 1);
  return { first: [1, mid], second: [mid + 1, mid * 2] };
}

/* ------------------------------------------------------------------ *
 * Per-round averages
 * ------------------------------------------------------------------ */

export interface RoundAverages {
  /** Rounds the player actually appears in. */
  rounds: number;
  /** Average combat score. NULL unless the caller supplies the scoreboard
   *  score: combat score is a MATCH-LEVEL number in match-details and is not
   *  derivable from roundResults. The modal already computes it from
   *  `players[].stats.score / rounds` — pass that in to get the same value
   *  instead of an approximation, or accept null and render dashes. */
  acs: number | null;
  /** Damage per round. */
  adr: number;
  /** Damage delta per round (dealt - taken). */
  ddPerRound: number;
  /** KAST% — Kill / Assist / Survive / Traded participation per round. */
  kastPct: number;
  /** Headshot % of all hits this player landed. */
  hsPct: number;
}

/** Traded: the player died, but a teammate killed their killer in the same
 *  round. Derived from the round's own kill list. Pure. */
function wasTraded(round: MatchRoundDetail, puuid: string): boolean {
  const key = puuid.toLowerCase();
  const death = round.players
    .flatMap((p) => p.killsDetail)
    .find((k) => k.victimPuuid === key);
  if (!death) return false;
  // Who killed them? Find the attacker whose killsDetail contains this victim.
  const killer = round.players.find((p) =>
    p.killsDetail.some((k) => k.victimPuuid === key)
  );
  if (!killer) return false;
  // Did anyone on the victim's team kill that killer?
  const victimTeamWon = round.winningTeam;
  void victimTeamWon;
  return round.players.some(
    (p) => p.puuid !== key && p.killsDetail.some((k) => k.victimPuuid === killer.puuid)
  );
}

/** Averages for one player across the rounds they appear in. Pure. */
export function perRoundAverages(
  rounds: MatchRoundDetail[],
  puuid: string,
  opts?: { score?: number }
): RoundAverages {
  const key = puuid.toLowerCase();
  const mine: MatchRoundPlayer[] = [];
  let kast = 0;
  let hs = 0;
  let hits = 0;

  for (const round of rounds) {
    const p = round.players.find((x) => x.puuid === key);
    if (!p) continue;
    mine.push(p);
    hits += p.headshots + p.bodyshots + p.legshots;
    hs += p.headshots;
    const participated =
      p.kills > 0 || p.assists > 0 || p.deaths === 0 || wasTraded(round, key);
    if (participated) kast += 1;
  }

  const n = mine.length;
  const sum = (f: (p: MatchRoundPlayer) => number): number => mine.reduce((a, p) => a + f(p), 0);
  const dealt = sum((p) => p.damageDealt);
  const taken = sum((p) => p.damageTaken);

  return {
    rounds: n,
    // See the field comment: null rather than a made-up number.
    acs: n > 0 && typeof opts?.score === 'number' ? Math.round((opts.score / n) * 10) / 10 : null,
    adr: n > 0 ? Math.round((dealt / n) * 10) / 10 : 0,
    ddPerRound: n > 0 ? Math.round(((dealt - taken) / n) * 10) / 10 : 0,
    kastPct: n > 0 ? Math.round((kast / n) * 1000) / 10 : 0,
    hsPct: hits > 0 ? Math.round((hs / hits) * 1000) / 10 : 0,
  };
}

/* ------------------------------------------------------------------ *
 * Economy strip
 * ------------------------------------------------------------------ */

export interface EconomyPoint {
  roundNum: number;
  loadoutValue: number;
  remaining: number;
  spent: number;
  weapon?: string;
  armor?: string;
}

/** Per-round loadout + remaining for one player. Rounds they are absent from
 *  are skipped, never zero-filled — a gap is a gap, not a broke player. Pure. */
export function economyTimeline(rounds: MatchRoundDetail[], puuid: string): EconomyPoint[] {
  const key = puuid.toLowerCase();
  const out: EconomyPoint[] = [];
  for (const round of rounds) {
    const p = round.players.find((x) => x.puuid === key);
    if (!p) continue;
    out.push({
      roundNum: round.roundNum,
      loadoutValue: p.economy.loadoutValue,
      remaining: p.economy.remaining,
      spent: p.economy.spent,
      ...(p.economy.weapon ? { weapon: p.economy.weapon } : {}),
      ...(p.economy.armor ? { armor: p.economy.armor } : {}),
    });
  }
  return out;
}
