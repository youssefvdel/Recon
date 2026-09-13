import type { LiveMatchPlayer } from '../types';

/* Shared player-display helpers.
   The in-app Live Match page and the in-game overlay widget must present a
   player identically — same flag resolution, same K/D colour bands, same party
   colours, same rank tooltip. Keeping one copy here prevents the two surfaces
   from drifting apart. */

/** Country code → flag image. Rejects Riot's region codes (EU/NA/AP/KR) so we
 *  never show a flag we don't actually know. */
export function getFlagUrl(code?: string): string | null {
  if (!code || !/^[a-z]{2}$/i.test(code) || ['EU', 'NA', 'AP', 'KR'].includes(code.toUpperCase())) return null;
  let lower = code.toLowerCase();
  if (lower === 'uk') lower = 'gb';
  return `https://flagcdn.com/24x18/${lower}.png`;
}

const regionNames = typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;

/** Full human-readable country name (e.g. 'EG' → 'Egypt', 'DE' → 'Germany'). */
export function getCountryName(code?: string): string | null {
  if (!code || !/^[a-z]{2}$/i.test(code) || ['EU', 'NA', 'AP', 'KR'].includes(code.toUpperCase())) return null;
  let upper = code.toUpperCase();
  if (upper === 'UK') upper = 'GB';
  try {
    return regionNames?.of(upper) || upper;
  } catch {
    return upper;
  }
}

/** Canonical search & profile URLs across Tracker.gg (TRN), Blitz.gg, and OP.GG */
export function getTrackerUrls(name: string, tag?: string) {
  const cleanName = (name || '').trim();
  const cleanTag = (tag || '').trim();
  const riotIdEncoded = `${encodeURIComponent(cleanName)}%23${encodeURIComponent(cleanTag)}`;
  // No trailing dash when the tag is unknown — "TenZ-" matches nothing.
  const blitzSlug = cleanTag
    ? `${encodeURIComponent(cleanName)}-${encodeURIComponent(cleanTag)}`
    : encodeURIComponent(cleanName);

  return {
    trn: `https://tracker.gg/valorant/profile/riot/${riotIdEncoded}/overview`,
    blitz: `https://blitz.gg/valorant/profile/${blitzSlug}`,
    opgg: `https://op.gg/valorant/profile/${riotIdEncoded}`,
  };
}

/** Full MMR picture for a lobby player, surfaced on hover. */
export function rankTooltip(p: LiveMatchPlayer, actLabel?: string): string {
  const bits: string[] = [];
  bits.push(p.tier > 0 ? `${p.rank}` : 'Unranked');
  if (p.rr > 0) bits.push(`${p.rr} RR`);
  if (p.actGames && p.actGames > 0) {
    bits.push(`${p.actWins ?? 0}W-${Math.max(0, p.actGames - (p.actWins ?? 0))}L this act`);
  }
  if (p.leaderboardRank && p.leaderboardRank > 0) bits.push(`#${p.leaderboardRank} Leaderboard`);
  if (p.peakTier > 0) bits.push(`Peak ${p.peakRank}${actLabel ? ` (${actLabel})` : ''}`);
  if (p.isRankHidden) bits.push('Act rank hidden (unmasked)');
  return bits.join(' • ');
}

/** "V25 · ACT III" → "V25·III" — fits under a 16px emblem. */
export function shortAct(label?: string): string {
  if (!label) return '';
  return label
    .replace(/\bACT\b\s*/i, '')
    .replace(/\s*·\s*/g, '·')
    .trim();
}

/** K/D with the same colour bands everywhere: green ≥1.2, mint ≥1.0, rose below. */
export function formatKd(kd?: number | string): { text: string; color: string } {
  if (kd == null || kd === '' || kd === 0) return { text: '—', color: 'text-zinc-500' };
  const num = typeof kd === 'number' ? kd : parseFloat(kd);
  if (isNaN(num) || num <= 0) return { text: '—', color: 'text-zinc-500' };
  const text = num.toFixed(2);
  const color =
    num >= 1.2
      ? 'text-emerald-400 font-bold'
      : num >= 1.0
      ? 'text-m3-mint font-semibold'
      : 'text-rose-400 font-medium';
  return { text, color };
}

/** Last-24h record for a player, or null when we have no games to report. */
export function recentLabel(p: LiveMatchPlayer): { text: string; color: string } | null {
  const won = p.recentWon ?? 0;
  const lost = p.recentLost ?? 0;
  if (won === 0 && lost === 0) return null;
  const pct = won + lost > 0 ? won / (won + lost) : 0;
  const color = pct >= 0.5 ? 'text-m3-mint' : 'text-rose-400';
  return { text: `${won}W-${lost}L`, color };
}

/** Party colour coding. 0/undefined = solo (no style). */
export const PARTY_STYLES: Record<
  number,
  { border: string; bg: string; dot: string; text: string; badge: string; name: string; bar: string }
> = {
  1: {
    border: 'border-l-[4px] border-l-amber-400',
    bg: 'bg-amber-500/10',
    dot: 'bg-amber-400',
    bar: 'bg-amber-400',
    text: 'text-amber-300',
    badge: 'bg-amber-500/20 text-amber-300 border-amber-400/40',
    name: 'Party 1',
  },
  2: {
    border: 'border-l-[4px] border-l-cyan-400',
    bg: 'bg-cyan-500/10',
    dot: 'bg-cyan-400',
    bar: 'bg-cyan-400',
    text: 'text-cyan-300',
    badge: 'bg-cyan-500/20 text-cyan-300 border-cyan-400/40',
    name: 'Party 2',
  },
  3: {
    border: 'border-l-[4px] border-l-fuchsia-400',
    bg: 'bg-fuchsia-500/10',
    dot: 'bg-fuchsia-400',
    bar: 'bg-fuchsia-400',
    text: 'text-fuchsia-300',
    badge: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-400/40',
    name: 'Party 3',
  },
  4: {
    border: 'border-l-[4px] border-l-emerald-400',
    bg: 'bg-emerald-500/10',
    dot: 'bg-emerald-400',
    bar: 'bg-emerald-400',
    text: 'text-emerald-300',
    badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40',
    name: 'Party 4',
  },
  5: {
    border: 'border-l-[4px] border-l-indigo-400',
    bg: 'bg-indigo-500/10',
    dot: 'bg-indigo-400',
    bar: 'bg-indigo-400',
    text: 'text-indigo-300',
    badge: 'bg-indigo-500/20 text-indigo-300 border-indigo-400/40',
    name: 'Party 5',
  },
  6: {
    border: 'border-l-[4px] border-l-rose-400',
    bg: 'bg-rose-500/10',
    dot: 'bg-rose-400',
    bar: 'bg-rose-400',
    text: 'text-rose-300',
    badge: 'bg-rose-500/20 text-rose-300 border-rose-400/40',
    name: 'Party 6',
  },
};

/** Safe party style resolver with wraparound if party count exceeds 6 */
export function getPartyStyle(partyIndex?: number) {
  if (!partyIndex || partyIndex <= 0) return null;
  const idx = ((partyIndex - 1) % 6) + 1;
  const base = PARTY_STYLES[idx] || PARTY_STYLES[1];
  if (partyIndex > 6) {
    return { ...base, name: `Party ${partyIndex}` };
  }
  return base;
}

/** Human label for a Riot queue id — captions the queue-scoped columns so a
 *  "24H — Ranked" column can't be mistaken for all modes. */
export function queueLabel(queueId?: string): string {
  switch ((queueId ?? '').toLowerCase()) {
    case 'competitive':
      return 'Ranked';
    case 'unrated':
      return 'Unrated';
    case 'swiftplay':
      return 'Swiftplay';
    case 'quickbomb':
      return 'Swiftplay';
    case 'deathmatch':
      return 'Deathmatch';
    case 'spikerush':
      return 'Spike Rush';
    case 'ggteam':
      return 'Escalation';
    case 'onefa':
      return 'Replication';
    case 'snowball':
      return 'Snowball Fight';
    default:
      return '';
  }
}

/** Which of blue/red is the local player's side, so labels read "Your Team"
 *  rather than a colour. Deathmatch has no teams at all. */
export function splitTeams(state: {
  isDeathmatch: boolean;
  blueTeam: LiveMatchPlayer[];
  redTeam: LiveMatchPlayer[];
  isRange?: boolean;
}): { yours: LiveMatchPlayer[]; theirs: LiveMatchPlayer[]; isFfa: boolean; isRange?: boolean } {
  if (state.isDeathmatch) {
    return { yours: [...state.blueTeam, ...state.redTeam], theirs: [], isFfa: true, isRange: false };
  }
  if (state.isRange) {
    return { yours: [...state.blueTeam, ...state.redTeam], theirs: [], isFfa: false, isRange: true };
  }
  const mineOnBlue = state.blueTeam.some((p) => p.isMe);
  const mineOnRed = state.redTeam.some((p) => p.isMe);
  if (mineOnRed && !mineOnBlue) return { yours: state.redTeam, theirs: state.blueTeam, isFfa: false };
  return { yours: state.blueTeam, theirs: state.redTeam, isFfa: false };
}

/** Strongest combat score first. Ties are deterministically resolved by tier
 *  then PUUID so rows never jitter or swap positions between polls. */
export function byAcsDesc(a: LiveMatchPlayer, b: LiveMatchPlayer): number {
  const diff = (b.acs ?? -1) - (a.acs ?? -1);
  if (diff !== 0) return diff;
  const tierDiff = (b.tier || 0) - (a.tier || 0);
  if (tierDiff !== 0) return tierDiff;
  return (a.puuid ?? '').localeCompare(b.puuid ?? '');
}
