import React, { useEffect, useState } from 'react';
import {
  detectLocalAccount,
  detectRegion,
  cardArtUrls,
  fetchIdentityDirect,
  fetchMmrDirect,
  gameData,
  isRiotClientRunning,
  readCachedAccount,
  readCachedSidebarMini,
  readCachedTrackerSnapshot,
  writeCachedSidebarMini,
} from '../utils/tracker';
import { fetchTrnActStats } from '../utils/trn';

interface Mini {
  name: string;
  tag: string;
  rank: string;
  rr: number;
  peak: string;
  icon: string;
  peakIcon: string;
  avatarUrl: string;
  bannerUrl: string;
  countryCode: string;
  level: number;
  cardId?: string;
}

/** Compact skeleton shown while the local Riot account resolves. */
const TrackerMiniSkeleton: React.FC = () => (
  <div className="mx-3 mb-2 rounded-2xl overflow-hidden bg-m3-surface-container border border-m3-outline-subtle shrink-0 animate-pulse" aria-hidden="true">
    <div className="h-12 w-full bg-m3-surface-container-highest" />
    <div className="px-2 pb-2 flex flex-col items-center -mt-6">
      <div className="w-12 h-12 rounded-full bg-m3-surface-container-highest border-2 border-m3-surface-container mb-1" />
      <div className="h-3 w-24 rounded bg-m3-surface-container-highest" />
      <div className="grid grid-cols-2 gap-1.5 w-full mt-2 pt-2 border-t border-m3-outline-subtle/40">
        <div className="flex flex-col items-center gap-1">
          <div className="w-6 h-6 rounded bg-m3-surface-container-highest" />
          <div className="h-2 w-14 rounded bg-m3-surface-container-highest" />
        </div>
        <div className="flex flex-col items-center gap-1 border-l border-m3-outline-subtle/40">
          <div className="w-6 h-6 rounded bg-m3-surface-container-highest" />
          <div className="h-2 w-14 rounded bg-m3-surface-container-highest" />
        </div>
      </div>
    </div>
  </div>
);

/** Compact TRN-style player profile card docked in the app sidebar. */
export const TrackerMini: React.FC = () => {
  const [mini, setMini] = useState<Mini | null>(() => {
    // 1. Full cached sidebar mini (banner, avatar, rank icons, level) paints instantly
    const cachedMini = readCachedSidebarMini();
    if (cachedMini?.name) {
      // Self-heal: a cache written while the card endpoint was 404ing has empty
      // art URLs. If the card ID is known, rebuild them so the banner is there
      // on the very first paint instead of only after the live refresh.
      if (cachedMini.cardId && !cachedMini.bannerUrl) {
        const art = cardArtUrls(cachedMini.cardId);
        return { ...cachedMini, bannerUrl: art.wide, avatarUrl: cachedMini.avatarUrl || art.small };
      }
      return cachedMini;
    }

    // 2. Fallback to basic account + profile if full mini hasn't been saved yet
    const acc = readCachedAccount();
    const snap = readCachedTrackerSnapshot();
    if (!acc && !snap?.profile) return null;
    const p = snap?.profile;
    return {
      name: acc?.game_name ?? p?.name ?? '',
      tag: acc?.tagline ?? p?.tag ?? '',
      rank: p?.rank ?? '',
      rr: p?.rr ?? 0,
      peak: p?.peak ?? '',
      icon: '',
      peakIcon: '',
      avatarUrl: '',
      bannerUrl: '',
      countryCode: '',
      level: 0,
    };
  });
  const [loading, setLoading] = useState(() => !readCachedAccount() && !readCachedSidebarMini());

  useEffect(() => {
    let live = true;

    const fetchMini = async () => {
      try {
        const running = await isRiotClientRunning();
        if (!running) {
          if (live) setLoading(false);
          return;
        }
        const region = await detectRegion();
        const acc = await detectLocalAccount().catch(() => null);
        const name = acc?.game_name ?? '';
        const tag = acc?.tagline ?? '';
        const prof = await fetchMmrDirect(region, name, tag);
        const [gd, trn] = await Promise.all([
          gameData().catch(() => null),
          name
            ? fetchTrnActStats(name, tag, prof.currentSeasonId).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (!live) return;

        const peakTier = prof.seasons.reduce((m, s) => Math.max(m, s.tier), 0);
        const rawAvatar = trn?.stats.avatarUrl ?? '';
        const cardMatch = rawAvatar.match(/playercards\/([^/]+)/);
        const ident = await fetchIdentityDirect(region).catch(() => null);
        if (!live) return;
        const cardId = ident?.cardId || cardMatch?.[1] || '';
        const art = cardArtUrls(cardId);
        const bannerUrl = art.wide;

        if (!live) return;
        const fullMini: Mini = {
          name: name || prof.name,
          tag: tag || prof.tag,
          rank: prof.rank,
          rr: prof.rr,
          peak: prof.peak,
          icon: gd?.tierIcons[prof.tier] ?? '',
          peakIcon: gd?.tierIcons[peakTier] ?? (gd?.tierIcons[prof.tier] ?? ''),
          avatarUrl: art.small || rawAvatar,
          bannerUrl,
          countryCode: trn?.countryCode ?? '',
          level: ident?.level ?? 0,
          cardId,
        };
        setMini(fullMini);
        writeCachedSidebarMini(fullMini, acc?.puuid);
      } catch {
        if (live) setMini((m) => m ?? null);
      } finally {
        if (live) setLoading(false);
      }
    };

    const kickoff = setTimeout(() => {
      fetchMini();
    }, 900);

    const onGlobalRefresh = () => {
      fetchMini();
    };
    window.addEventListener('recon:global-refresh', onGlobalRefresh);

    return () => {
      live = false;
      clearTimeout(kickoff);
      window.removeEventListener('recon:global-refresh', onGlobalRefresh);
    };
  }, []);

  if (loading) return <TrackerMiniSkeleton />;
  if (!mini || !mini.name) return null;

  const flagUrl = mini.countryCode ? `https://flagcdn.com/24x18/${mini.countryCode.toLowerCase()}.png` : '';

  return (
    <div className="mx-3 mb-2 rounded-2xl overflow-hidden bg-m3-surface-container border border-m3-outline-subtle shadow-m3-1 shrink-0">
      {/* Banner hero */}
      <div className="relative h-12 w-full bg-m3-surface-container-high overflow-hidden">
        {mini.bannerUrl ? (
          <img
            src={mini.bannerUrl}
            alt=""
            aria-hidden="true"
            className="w-full h-full object-cover object-top"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-r from-m3-primary/30 via-m3-surface-container-high to-m3-tertiary/20" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-m3-surface-container via-m3-surface-container/30 to-transparent" />
      </div>

      {/* Avatar + Identity */}
      <div className="px-2 pb-2 flex flex-col items-center -mt-6 relative">
        <div className="relative mb-1">
          {mini.avatarUrl ? (
            <img
              src={mini.avatarUrl}
              alt={mini.name}
              className="w-12 h-12 rounded-full object-cover border-2 border-m3-surface-container shadow-md bg-m3-surface-container-highest"
            />
          ) : (
            <div className="w-12 h-12 rounded-full border-2 border-m3-surface-container shadow-md bg-m3-surface-container-highest flex items-center justify-center font-bold text-sm text-m3-primary">
              {mini.name[0]?.toUpperCase() ?? '?'}
            </div>
          )}
          {flagUrl ? (
            <img
              src={flagUrl}
              alt={mini.countryCode}
              className="absolute bottom-0 right-0 w-4 h-3 object-cover rounded-sm shadow border border-black/40"
              onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
            />
          ) : null}
          {mini.level > 0 ? (
            <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 px-1 rounded bg-black/70 border border-m3-outline-subtle text-[8px] font-mono font-bold text-m3-on-surface leading-tight whitespace-nowrap">
              {mini.level}
            </span>
          ) : null}
        </div>

        <div className="font-display font-extrabold text-[13px] text-m3-on-surface text-center truncate max-w-full leading-tight">
          {mini.name}
          <span className="text-m3-outline text-[11px] font-semibold ml-0.5">#{mini.tag}</span>
        </div>

        {/* Current & Peak Ranks row */}
        <div className="grid grid-cols-2 gap-1 w-full mt-1.5 pt-1.5 border-t border-m3-outline-subtle/40">
          {/* Current */}
          <div className="flex flex-col items-center text-center px-0.5 min-w-0">
            {mini.icon ? (
              <img src={mini.icon} alt={mini.rank} className="w-6 h-6 object-contain" />
            ) : null}
            <div className="text-[10px] font-bold text-m3-on-surface leading-tight truncate max-w-full">
              {mini.rank}
            </div>
            <div className="text-[8px] font-bold uppercase tracking-wider text-m3-primary">
              {mini.rr} RR
            </div>
          </div>

          {/* Lifetime Peak */}
          <div className="flex flex-col items-center text-center px-0.5 border-l border-m3-outline-subtle/40 min-w-0">
            {mini.peakIcon ? (
              <img src={mini.peakIcon} alt={mini.peak} className="w-6 h-6 object-contain opacity-90" />
            ) : null}
            <div className="text-[10px] font-bold text-m3-tertiary leading-tight truncate max-w-full">
              {mini.peak}
            </div>
            <div className="text-[8px] font-bold uppercase tracking-wider text-m3-outline">
              Peak
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
