/* Match details from the local Riot client, plus the round-timeline parser.
 *
 * Moved verbatim out of utils/tracker.ts. It is a source read with its own
 * forever-cache (`recon_match_v7_*`), and it now goes through the validated
 * reader, so a Riot error payload throws instead of being cached as a match
 * with zero players. */

import type { TrackerMatchDetail, TrackerPlayer } from '../types';
import { mapRoundKills, parseRoundDetails } from './roundMap';
import { gameData } from './gameData';
import { normTeam, readMatchDetailsRaw, rememberPlayerNames, resolvePlayerNames, shardFor } from './riot';

/**
 * Full match straight from Riot via the SAME endpoint TRN/Blitz call locally
 * (match-details/v1 — the singular /match/v1 path 503s for client creds).
 * Immutable → cached forever. Throws when unusable.
 */
export { parseRoundDetails };

export async function fetchMatchDetailDirect(region: string, matchId: string): Promise<TrackerMatchDetail> {
  // v7: roundDetails was added to the payload. A v6 entry has no round data and
  // would render "no round data" forever, so the key bump forces one refetch.
  const cacheKey = `recon_match_v7_${matchId}`;
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) return JSON.parse(raw) as TrackerMatchDetail;
    const legacyRaw = localStorage.getItem(`aspect_match_v5_${matchId}`);
    if (legacyRaw) {
      const parsed = JSON.parse(legacyRaw) as TrackerMatchDetail;
      if (parsed.players?.[0]?.partyId) return parsed;
    }
  } catch {}
  // Validated reader: a Riot error payload throws instead of parsing into a
  // detail with zero players and then being CACHED under recon_match_v7_.
  const j = await readMatchDetailsRaw(matchId, shardFor(region));
  const { agents: amap } = await gameData();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const players: TrackerPlayer[] = ((Array.isArray(j?.players) ? j.players : []) as any[]).map((p) => {
    const st = p?.stats ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dmg = (Array.isArray(p?.roundDamage) ? p.roundDamage : []).reduce((n: number, r: any) => n + Number(r?.damage ?? 0), 0);
    return {
      puuid: String(p?.subject ?? ''),
      name: String(p?.gameName ?? ''),
      tag: String(p?.tagLine ?? ''),
      team: normTeam(p?.teamId),
      agent: amap[String(p?.characterId ?? '').toLowerCase()] ?? 'Agent',
      kills: Number(st.kills ?? 0),
      deaths: Number(st.deaths ?? 0),
      assists: Number(st.assists ?? 0),
      damage: dmg,
      damageTaken: 0,
      score: Number(st.score ?? 0),
      rounds: Number(st.roundsPlayed ?? 0),
      playtimeMs: Number(st.playtimeMillis ?? 0),
      headshots: 0,
      bodyshots: 0,
      legshots: 0,
      accountLevel: Number(p?.accountLevel ?? 0),
      tier: Number(p?.competitiveTier ?? 0),
      partyId: String(p?.partyId ?? ''),
    };
  });
  if (players.length === 0) throw new Error('Empty scoreboard.');

  // Identify parties (players with the same partyId where party size >= 2)
  const matchPartyCounts = new Map<string, number>();
  for (const p of players) {
    if (p.partyId) {
      matchPartyCounts.set(p.partyId, (matchPartyCounts.get(p.partyId) ?? 0) + 1);
    }
  }
  const matchPartyIdxMap = new Map<string, number>();
  let nextMatchPartyIdx = 1;
  for (const [pId, count] of matchPartyCounts.entries()) {
    if (count >= 2) {
      matchPartyIdxMap.set(pId, nextMatchPartyIdx++);
    }
  }
  for (const p of players) {
    if (p.partyId && matchPartyIdxMap.has(p.partyId)) {
      p.partyIndex = matchPartyIdxMap.get(p.partyId);
    }
  }

  // Resolve real player names from PUUIDs using Riot name-service
  try {
    const puuids = players.map((p) => p.puuid).filter(Boolean);
    const nameMap = await resolvePlayerNames(puuids, region);
    for (const p of players) {
      if (nameMap[p.puuid]?.name) {
        p.name = nameMap[p.puuid].name;
        p.tag = nameMap[p.puuid].tag;
      }
    }
  } catch {}
  // Permanent memory: the payload reveals strict-hidden names post-game.
  // Remember them so future live lobbies unmask instantly from cache.
  try {
    rememberPlayerNames(players.map((p) => ({ puuid: p.puuid, name: p.name, tag: p.tag })));
  } catch {}
  const teamOf = (puuid: string): string => players.find((p) => p.puuid === puuid)?.team ?? '';
  // Damage taken: every player's roundDamage lists who they hit — invert it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawPlayers: any[] = Array.isArray(j?.players) ? j.players : [];
  const taken = new Map<string, number>();
  for (const rp of rawPlayers) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of (Array.isArray(rp?.roundDamage) ? rp.roundDamage : []) as any[]) {
      const recv = String(r?.receiver ?? '');
      if (recv) taken.set(recv, (taken.get(recv) ?? 0) + Number(r?.damage ?? 0));
    }
  }
  for (const p of players) p.damageTaken = taken.get(p.puuid) ?? 0;
  // Team scores come straight from the payload — no round counting needed.
  const teamScore: Record<string, number> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const t of (Array.isArray(j?.teams) ? j.teams : []) as any[]) {
    teamScore[normTeam(t?.teamId)] = Number(t?.roundsWon ?? 0);
  }
  const roundsSrc: unknown[] = Array.isArray(j?.roundResults) ? j.roundResults : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rounds = (roundsSrc as any[]).map((r) => ({
    winningTeam: normTeam(r?.winningTeam),
    roundResult: String(r?.roundResult ?? 'Elimination'),
    ceremony: String(r?.roundCeremony ?? ''),
  }));
  const kills = mapRoundKills(roundsSrc, teamOf);
  // Per-player shot tallies stay here: they are match-level stats, not round
  // mapping, and they used to share the kill loop.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of roundsSrc as any[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pstats: any[] = Array.isArray(r?.playerStats) ? r.playerStats : [];
    for (const ps of pstats) {
      const sub = String(ps?.subject ?? '');
      const p = players.find((x) => x.puuid === sub);
      if (!p) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const d of (Array.isArray(ps?.damage) ? ps.damage : []) as any[]) {
        p.headshots += Number(d?.headshots ?? 0);
        p.bodyshots += Number(d?.bodyshots ?? 0);
        p.legshots += Number(d?.legshots ?? 0);
      }
    }
  }
  const roundDetails = parseRoundDetails(roundsSrc);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mi: any = (j as any)?.matchInfo ?? {};
  const out: TrackerMatchDetail = {
    rounds,
    roundDetails,
    players,
    kills,
    mapId: String(mi.mapId ?? ''),
    teamScore,
    queue: String(mi.queueID ?? ''),
    when: Number(mi.gameStartMillis ?? 0),
    durationMs: Number(mi.gameLengthMillis ?? 0),
  };
  try {
    localStorage.setItem(cacheKey, JSON.stringify(out));
  } catch {}
  return out;
}
