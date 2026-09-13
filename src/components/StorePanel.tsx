import React, { useCallback, useEffect, useState } from 'react';
import { ShoppingBag, RefreshCw, Clock, Store as StoreIcon, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { getAccountStore, getWallet, type AccountStore, type WalletBalance } from '../utils/store';

/* ------------------------------------------------------------------ */
/* Store tab — the account's daily shop, mirroring the in-game client. */
/* Wallet strip (VP · R · KC) on top, featured-bundle carousel, daily  */
/* gun offers with rotation timer, weekly accessories with theirs.     */
/* Every countdown ships inside Riot's payload — no guessing.          */
/* ------------------------------------------------------------------ */

/** In-game clock: 07:34:55, or 9:12:35:12 past a day — like the client. */
const fmtClock = (expiresAt: number, now: number): string => {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return d > 0 ? `${d}:${p(h)}:${p(m)}:${p(sec)}` : `${p(h)}:${p(m)}:${p(sec)}`;
};

const TimerChip: React.FC<{ expiresAt: number; now: number; title: string }> = ({ expiresAt, now, title }) => (
  <span
    className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-m3-surface-container-high border border-m3-outline-subtle text-[9px] font-mono text-m3-outline"
    title={title}
  >
    <Clock className="w-2.5 h-2.5" />
    <span className="tabular-nums">{fmtClock(expiresAt, now)}</span>
  </span>
);

const CostPill: React.FC<{ amount: number; label: string; icon: string }> = ({ amount, label, icon }) => {
  if (!amount) return null;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-px rounded-full bg-m3-surface-container-highest border border-m3-outline-subtle text-[9px] font-mono font-bold text-m3-on-surface"
      title={amount.toLocaleString()}
    >
      {icon ? (
        <img src={icon} alt="" className="w-2.5 h-2.5 object-contain" loading="lazy" />
      ) : (
        <span className="text-m3-primary">{label}</span>
      )}
      <span className="tabular-nums">{amount.toLocaleString()}</span>
      {!icon && label && <span className="text-m3-outline font-semibold">{label}</span>}
    </span>
  );
};

export const StorePanel: React.FC = () => {
  const [store, setStore] = useState<AccountStore | null>(null);
  const [wallet, setWallet] = useState<WalletBalance[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [bundleIdx, setBundleIdx] = useState(0);
  /** Bundle whose contents are expanded, by id — null when collapsed. */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Hover pauses the auto-rotation so it never yanks the banner away. */
  const [hoverPause, setHoverPause] = useState(false);

  const load = useCallback(async (force = false) => {
    if (force) setLoading(true);
    try {
      const [s, w] = await Promise.all([getAccountStore(force), getWallet(force)]);
      if (s) {
        setStore(s);
        setUnavailable(false);
      } else {
        setUnavailable(true);
      }
      if (w) setWallet(w);
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // New rotation (or refresh) resets the carousel to the featured bundle.
  useEffect(() => {
    setBundleIdx(0);
    setExpandedId(null);
  }, [store?.fetchedAt]);

  // Clocks tick every second — countdowns come from the payload, never refetched.
  useEffect(() => {
    if (!store) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [store]);

  // Auto-rotation, like the client: advance every 6s while several bundles
  // are live. Paused on hover, while contents are open, or when hidden.
  const bundleCount = store?.bundles.length ?? 0;
  useEffect(() => {
    if (bundleCount < 2 || hoverPause || expandedId) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      setBundleIdx((i) => (i + 1) % bundleCount);
    }, 6000);
    return () => clearInterval(id);
  }, [bundleCount, hoverPause, expandedId]);

  const bundles = store?.bundles ?? [];
  const bundle = bundles.length > 0 ? bundles[Math.min(bundleIdx, bundles.length - 1)] : store?.bundle ?? null;
  // Stale persisted caches (saved before bundle items existed) lack `items`.
  const bundleItems = bundle?.items ?? [];

  return (
    <div className="w-full">
        {/* Header: title + wallet + refresh */}
        <div className="flex items-center justify-between gap-2 px-1 pt-1 pb-2">
          <span className="flex items-center gap-1.5 text-[10.5px] font-display font-bold uppercase tracking-[0.14em] text-m3-on-surface shrink-0">
            <ShoppingBag className="w-3.5 h-3.5 text-m3-primary" />
            <span>Store</span>
          </span>
          <div className="flex items-center gap-1.5 min-w-0">
            {wallet && wallet.length > 0 && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-m3-surface-container-high border border-m3-outline-subtle text-[9.5px] font-mono font-bold text-m3-on-surface truncate">
                {wallet.map((b, i) => (
                  <React.Fragment key={b.label}>
                    {i > 0 && <span className="text-m3-outline/60">·</span>}
                    <span className="flex items-center gap-1 tabular-nums" title={b.label}>
                      {b.icon ? (
                        <img src={b.icon} alt="" className="w-3 h-3 object-contain" loading="lazy" />
                      ) : (
                        <span className="text-m3-primary">{b.label}</span>
                      )}
                      {b.amount.toLocaleString()}
                    </span>
                  </React.Fragment>
                ))}
              </span>
            )}
            <button
              type="button"
              onClick={() => load(true)}
              disabled={loading}
              className="p-1 rounded-full text-m3-outline hover:text-m3-on-surface hover:bg-m3-surface-container-high transition-colors cursor-pointer disabled:opacity-50 shrink-0"
              title="Refresh store"
              aria-label="Refresh store"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {loading && !store ? (
          <div className="px-1 pb-2 space-y-2">
            <div className="h-20 rounded-xl bg-m3-surface-container-high animate-pulse" />
            <div className="grid grid-cols-2 gap-1.5">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-16 rounded-xl bg-m3-surface-container-high animate-pulse" />
              ))}
            </div>
          </div>
        ) : !store ? (
          <div className="mx-1 mb-2 px-3 py-2.5 rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle/60 flex items-center gap-2">
            <StoreIcon className="w-4 h-4 text-m3-outline shrink-0" />
            <span className="text-[10.5px] text-m3-outline leading-snug">
              {unavailable ? 'Open Valorant to load your daily shop.' : 'Store unavailable right now.'}
            </span>
          </div>
        ) : (
          <div className="px-1 pb-2 space-y-4">
            {/* Featured-bundle carousel (featured first, then the rest) */}
            {bundle && (bundle.art || bundle.name) && (
              <div
                onMouseEnter={() => setHoverPause(true)}
                onMouseLeave={() => setHoverPause(false)}
              >
                <div
                  className={`relative rounded-xl overflow-hidden border border-m3-outline-subtle/70 group transition-colors ${bundleItems.length > 0 ? 'cursor-pointer hover:border-m3-primary/60' : ''}`}
                  onClick={() => {
                    if (bundleItems.length === 0) return;
                    setExpandedId(expandedId === bundle.id ? null : bundle.id);
                  }}
                  title={bundleItems.length > 0 ? `View ${bundleItems.length} bundle items` : bundle.name}
                >
                  {bundle.art ? (
                    <img
                      key={bundle.id}
                      src={bundle.art}
                      alt={bundle.name}
                      loading="lazy"
                      className="w-full aspect-[16/7] object-cover group-hover:scale-[1.02] transition-transform duration-300"
                    />
                  ) : (
                    <div className="w-full aspect-[16/7] bg-m3-surface-container-high" />
                  )}
                  {/* Bundle timer, top-right — like the client */}
                  {bundle.remainingSecs > 0 && (
                    <div className="absolute top-1.5 right-1.5">
                      <TimerChip
                        expiresAt={store.fetchedAt + bundle.remainingSecs * 1000}
                        now={now}
                        title="This bundle leaves at this timer"
                      />
                    </div>
                  )}
                  {/* Title bottom-left, price CTA bottom-right */}
                  <div className="absolute inset-x-0 bottom-0 pt-8 pb-1.5 px-2 bg-gradient-to-t from-black/85 via-black/50 to-transparent pointer-events-none">
                    <div className="flex items-end justify-between gap-2">
                      <div className="flex items-center gap-1 min-w-0">
                        <div className="font-display font-black text-[11px] text-white uppercase tracking-wider truncate drop-shadow min-w-0">
                          {bundle.name || 'Featured Bundle'}
                        </div>
                        {bundleItems.length > 0 && (
                          <span className="flex items-center gap-0.5 text-[9px] font-mono text-white/80 shrink-0">
                            {bundleItems.length} items
                            <ChevronDown
                              className={`w-3 h-3 transition-transform ${expandedId === bundle.id ? 'rotate-180' : ''}`}
                            />
                          </span>
                        )}
                      </div>
                      {bundle.price > 0 && (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-m3-primary text-m3-on-primary text-[10px] font-mono font-black tabular-nums shrink-0 shadow-lg">
                          {bundle.currencyIcon && (
                            <img src={bundle.currencyIcon} alt="" className="w-3 h-3 object-contain" loading="lazy" />
                          )}
                          {bundle.price.toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Contents overlay — covers the banner art, no layout shift */}
                  {expandedId === bundle.id && bundleItems.length > 0 && (
                    <div
                      className="absolute inset-0 z-10 rounded-xl bg-black/85 backdrop-blur-[2px] p-2 flex flex-col min-h-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-between px-1 pb-1.5 shrink-0">
                        <span className="text-[9px] font-mono font-bold uppercase tracking-[0.16em] text-white/80">
                          {bundle.name} · {bundleItems.length} items
                        </span>
                        <button
                          type="button"
                          aria-label="Close bundle contents"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedId(null);
                          }}
                          className="px-2 py-0.5 rounded-full bg-white/10 hover:bg-white/20 text-white text-[10px] font-bold transition-colors cursor-pointer"
                        >
                          ✕
                        </button>
                      </div>
                      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar flex items-end justify-center pb-1">
                        <div className="flex items-stretch justify-center gap-1.5 flex-wrap">
                          {bundleItems.map((it) => (
                            <div
                              key={it.itemId || it.name}
                              title={`${it.name}${it.amount > 1 ? ` ×${it.amount}` : ''}${it.price ? ` • ${it.price.toLocaleString()}${it.currency ? ` ${it.currency}` : ''}` : ''}`}
                              className="w-24 sm:w-28 shrink-0 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 transition-colors overflow-hidden flex flex-col items-center p-1.5 gap-1"
                            >
                              {it.icon ? (
                                <img
                                  src={it.icon}
                                  alt={it.name}
                                  loading="lazy"
                                  className="w-full h-14 object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,0.5)]"
                                />
                              ) : (
                                <div className="w-full h-14 flex items-center justify-center text-[10px] font-black text-white/60">
                                  {it.name.slice(0, 2).toUpperCase()}
                                </div>
                              )}
                              <span className="text-[8.5px] font-medium text-white/85 truncate w-full text-center leading-tight">
                                {it.name}
                                {it.amount > 1 && <span className="text-white/50"> ×{it.amount}</span>}
                              </span>
                              <CostPill amount={it.price} label={it.currency} icon={it.currencyIcon} />
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  {/* Carousel arrows when Riot lists more than one bundle */}
                  {bundles.length > 1 && (
                    <>
                      <button
                        type="button"
                        aria-label="Previous bundle"
                        onClick={(e) => {
                          e.stopPropagation();
                          setBundleIdx((i) => (i - 1 + bundles.length) % bundles.length);
                        }}
                        className="absolute left-1 top-1/2 -translate-y-1/2 p-1 rounded-full bg-black/55 text-white/90 hover:bg-black/80 hover:text-white transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label="Next bundle"
                        onClick={(e) => {
                          e.stopPropagation();
                          setBundleIdx((i) => (i + 1) % bundles.length);
                        }}
                        className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-full bg-black/55 text-white/90 hover:bg-black/80 hover:text-white transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
                      >
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
                {/* Carousel dots + position counter mirror the client's toggle */}
                {bundles.length > 1 && (
                  <div className="flex items-center justify-center gap-1.5 pt-1.5">
                    {bundles.map((b, i) => (
                      <button
                        key={b.id || i}
                        type="button"
                        onClick={() => setBundleIdx(i)}
                        title={b.name || `Bundle ${i + 1}`}
                        aria-label={b.name || `Bundle ${i + 1}`}
                        className={`h-1.5 rounded-full transition-all cursor-pointer ${
                          i === Math.min(bundleIdx, bundles.length - 1)
                            ? 'w-5 bg-m3-primary'
                            : 'w-1.5 bg-m3-outline/40 hover:bg-m3-outline'
                        }`}
                      />
                    ))}
                    <span className="text-[9px] font-mono text-m3-outline tabular-nums pl-1">
                      {Math.min(bundleIdx, bundles.length - 1) + 1} / {bundles.length}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Daily gun offers + rotation clock */}
            {store.offers.length > 0 && (
              <div>
                <div className="px-1 pb-1 flex items-center justify-between gap-2">
                  <span className="text-[9px] font-mono font-bold uppercase tracking-[0.16em] text-m3-outline">
                    Daily offers
                  </span>
                  {store.dailySecs > 0 && (
                    <TimerChip
                      expiresAt={store.fetchedAt + store.dailySecs * 1000}
                      now={now}
                      title="Daily offers rotate at this timer"
                    />
                  )}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                  {store.offers.map((o) => (
                    <div
                      key={o.offerId}
                      title={`${o.name}${o.weaponName ? ` • ${o.weaponName}` : ''}`}
                      className="rounded-xl bg-m3-surface-container-low hover:bg-m3-surface-container-high border border-m3-outline-subtle/70 hover:border-m3-primary/50 transition-colors overflow-hidden flex flex-col"
                    >
                      {o.icon ? (
                        <img
                          src={o.icon}
                          alt={o.name}
                          loading="lazy"
                          className="w-full h-14 object-contain p-1 drop-shadow-[0_2px_6px_rgba(0,0,0,0.5)]"
                        />
                      ) : (
                        <div className="w-full h-14 flex items-center justify-center text-[10px] font-black text-m3-outline">
                          {o.name.slice(0, 2).toUpperCase()}
                        </div>
                      )}
                      <div className="px-1.5 pb-1.5 pt-0.5 flex flex-col gap-1 min-w-0 border-t border-m3-outline-subtle/30">
                        <span className="text-[9.5px] font-semibold text-m3-on-surface truncate leading-tight">
                          {o.name}
                        </span>
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[8px] font-mono uppercase tracking-wider text-m3-outline truncate">
                            {o.weaponName || 'Skin'}
                          </span>
                          <CostPill amount={o.cost} label={o.currency} icon={o.currencyIcon} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Weekly accessories shelf + its own rotation clock */}
            {store.accessories.length > 0 && (
              <div>
                <div className="px-1 pb-1 flex items-center justify-between gap-2">
                  <span className="text-[9px] font-mono font-bold uppercase tracking-[0.16em] text-m3-outline">
                    Accessories · Weekly
                  </span>
                  {store.accSecs > 0 && (
                    <TimerChip
                      expiresAt={store.fetchedAt + store.accSecs * 1000}
                      now={now}
                      title="Accessories rotate weekly at this timer"
                    />
                  )}
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {store.accessories.slice(0, 8).map((a) => (
                    <div
                      key={a.offerId}
                      title={`${a.name}${a.cost ? ` • ${a.cost.toLocaleString()}${a.currency ? ` ${a.currency}` : ''}` : ''}`}
                      className="rounded-xl bg-m3-surface-container-low hover:bg-m3-surface-container-high border border-m3-outline-subtle/70 hover:border-m3-primary/50 transition-colors overflow-hidden flex flex-col items-center p-1.5 gap-1"
                    >
                      {a.icon ? (
                        <img
                          src={a.icon}
                          alt={a.name}
                          loading="lazy"
                          className="w-9 h-9 object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,0.5)]"
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-lg bg-m3-surface-container-high flex items-center justify-center text-[9px] font-black text-m3-outline">
                          {a.name.slice(0, 2).toUpperCase()}
                        </div>
                      )}
                      <span className="text-[8px] font-medium text-m3-on-surface-variant truncate w-full text-center leading-tight">
                        {a.name}
                      </span>
                      <CostPill amount={a.cost} label={a.currency} icon={a.currencyIcon} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
    </div>
  );
};
