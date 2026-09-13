import { isTauri } from './ipc';
import { loadWeaponCatalog } from './loadout';

/**
 * The account's daily shop — what the sidebar Store panel renders.
 *
 * Source of truth is Riot's player-data endpoint (the exact call the game
 * client itself makes — verified against `%LOCALAPPDATA%/VALORANT/.../ShooterGame.log`):
 *
 *   POST https://pd.{region}.a.pvp.net/store/v3/storefront/{puuid}   (empty JSON body)
 *
 * Shape (verified against a live 200, 144KB response):
 *   SkinsPanelLayout.SingleItemStoreOffers[]  → daily guns. Each offer's
 *     Rewards[0].ItemID is a skin LEVEL uuid (e.g. "Singularity Butterfly
 *     Knife"), resolved to its parent skin through the weapon catalogue's
 *     level→skin index. Cost key 85ad13f7… = VALORANT POINTS.
 *   AccessoryStore.AccessoryStoreOffers[]    → cards/sprays/buddies, each under
 *     `.Offer` with a ContractID sibling. Cost key 85ca954a… = Kingdom Credits.
 *   FeaturedBundle.Bundle.{ID,DataAssetID}   → banner art + name from
 *     valorant-api `/v1/bundles/{DataAssetID}`.
 *   Each section carries its own `…RemainingDurationInSeconds` for the timers.
 *
 * Polite by construction: one POST per shop rotation (durations come back
 * with the payload), in-flight dedup, persisted cache keyed to the rotation.
 */

export interface StoreOffer {
  offerId: string;
  itemId: string;
  /** Skin name, e.g. "Singularity Butterfly Knife". */
  name: string;
  /** Gun it belongs to, e.g. "Melee". Empty when unknown. */
  weaponName: string;
  icon: string;
  cost: number;
  currency: string;
  currencyIcon: string;
}

export interface StoreAccessory {
  offerId: string;
  name: string;
  icon: string;
  kind: 'card' | 'spray' | 'buddy' | 'cosmetic';
  cost: number;
  currency: string;
  currencyIcon: string;
}

export interface StoreBundleItem {
  itemId: string;
  name: string;
  icon: string;
  kind: 'skin' | 'buddy' | 'card' | 'spray' | 'cosmetic';
  /** Stack size Riot ships (e.g. Radianite ×10) — 1 when single. */
  amount: number;
  price: number;
  currency: string;
  currencyIcon: string;
}

export interface StoreBundle {
  id: string;
  name: string;
  art: string;
  /** Seconds until this bundle leaves, from fetch time. */
  remainingSecs: number;
  /** Bundle price (discounted when Riot marks one), 0 when unknown. */
  price: number;
  currency: string;
  currencyIcon: string;
  /** What's inside — resolved names, art, and per-item prices. */
  items: StoreBundleItem[];
}

export interface AccountStore {
  offers: StoreOffer[];
  accessories: StoreAccessory[];
  bundle: StoreBundle | null;
  /** Every live bundle (featured first) — the in-game carousel. */
  bundles: StoreBundle[];
  /** Seconds until the daily offers rotate, from fetch time. */
  dailySecs: number;
  /** Seconds until the accessory shelf rotates, from fetch time. */
  accSecs: number;
  fetchedAt: number;
}

/** One wallet line: VP, Radianite, or Kingdom Credits. */
export interface WalletBalance {
  amount: number;
  label: string;
  icon: string;
}

const STORE_KEY = 'recon_store_v2';
const COSMETIC_KEY = 'recon_cosmetic_catalog_v2';
const COSMETIC_TTL = 7 * 24 * 3600 * 1000;

let memStore: { at: number; data: AccountStore } | null = null;
let storeInFlight: Promise<AccountStore | null> | null = null;

export const pdHostFor = (region: string): string => {
  const r = region.toLowerCase().trim();
  if (r === 'eu') return 'pd.eu.a.pvp.net';
  if (r === 'ap') return 'pd.ap.a.pvp.net';
  if (r === 'kr') return 'pd.kr.a.pvp.net';
  // na + latam + br accounts all live on the NA shard.
  return 'pd.na.a.pvp.net';
};

/** Verified live against valorant-api `/v1/currencies`. Unknown uuids fall back to initials. */
const currencyShort = (name: string): string => {
  const n = name.toLowerCase();
  if (n.includes('valorant points')) return 'VP';
  if (n.includes('kingdom')) return 'KC';
  if (n.includes('radianite')) return 'R';
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
};

interface CurrencyInfo {
  name: string;
  short: string;
  icon: string;
}

async function currencyMap(): Promise<Record<string, CurrencyInfo>> {
  try {
    const r = await fetch('https://valorant-api.com/v1/currencies');
    const j = await r.json();
    const out: Record<string, CurrencyInfo> = {};
    for (const c of j?.data ?? []) {
      if (!c?.uuid) continue;
      const name = String(c.displayName ?? '');
      out[String(c.uuid).toLowerCase()] = {
        name,
        short: currencyShort(name),
        icon: String(c.displayIcon ?? ''),
      };
    }
    return out;
  } catch {
    return {};
  }
}

interface CosmeticEntry {
  name: string;
  icon: string;
  kind: StoreAccessory['kind'];
}

async function cosmeticCatalog(): Promise<Record<string, CosmeticEntry>> {
  try {
    const raw = localStorage.getItem(COSMETIC_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.data && Date.now() - (parsed.savedAt ?? 0) < COSMETIC_TTL) {
        return parsed.data as Record<string, CosmeticEntry>;
      }
    }
  } catch {}
  const out: Record<string, CosmeticEntry> = {};
  const load = async (endpoint: string, kind: CosmeticEntry['kind'], art = 'displayIcon') => {
    try {
      const r = await fetch(`https://valorant-api.com/v1/${endpoint}`);
      const j = await r.json();
      for (const it of j?.data ?? []) {
        if (!it?.uuid) continue;
        const itemName = String(it.displayName ?? '');
        const itemIcon = String(it[art] ?? it.displayIcon ?? '');
        out[String(it.uuid).toLowerCase()] = {
          name: itemName,
          icon: itemIcon,
          kind,
        };
        if (endpoint === 'buddies') {
          // Bundle payloads reference buddy LEVEL uuids, not the base buddy —
          // index them to the parent name + art.
          for (const lv of it?.levels ?? []) {
            if (!lv?.uuid) continue;
            const key = String(lv.uuid).toLowerCase();
            if (!out[key]) {
              out[key] = {
                name: itemName || String(lv.displayName ?? ''),
                icon: String(lv.displayIcon ?? '') || itemIcon,
                kind,
              };
            }
          }
        }
      }
    } catch {}
  };
  // Player cards paint from smallArt at tile size; fall back to displayIcon.
  await Promise.all([
    load('sprays', 'spray'),
    load('buddies', 'buddy'),
    (async () => {
      try {
        const r = await fetch('https://valorant-api.com/v1/playercards');
        const j = await r.json();
        for (const it of j?.data ?? []) {
          if (!it?.uuid) continue;
          out[String(it.uuid).toLowerCase()] = {
            name: String(it.displayName ?? ''),
            icon: String(it.smallArt ?? it.displayIcon ?? ''),
            kind: 'card',
          };
        }
      } catch {}
    })(),
  ]);
  try {
    localStorage.setItem(COSMETIC_KEY, JSON.stringify({ savedAt: Date.now(), data: out }));
  } catch {}
  return out;
}

/* Raw storefront rows — schema varies per section, parsed defensively below. */

const costOf = (cost: Record<string, number> | undefined): { amount: number; currencyUuid: string } => {
  const entries = Object.entries(cost ?? {});
  if (entries.length === 0) return { amount: 0, currencyUuid: '' };
  // Highest-denomination entry first — multi-currency costs list VP alongside KC.
  entries.sort((a, b) => b[1] - a[1]);
  return { amount: entries[0][1], currencyUuid: entries[0][0].toLowerCase() };
};

const currencyOf = (uuid: string, currencies: Record<string, CurrencyInfo>): { label: string; icon: string } => {
  const hit = currencies[uuid];
  if (hit) return { label: hit.short, icon: hit.icon };
  return { label: '', icon: '' };
};

async function bundleInfo(dataAssetId: string): Promise<{ name: string; art: string }> {
  if (!dataAssetId) return { name: '', art: '' };
  try {
    const r = await fetch(`https://valorant-api.com/v1/bundles/${dataAssetId}`);
    const j = await r.json();
    return {
      name: String(j?.data?.displayName ?? ''),
      // displayIcon is the wide collection banner — exactly the panel's top art.
      art: String(j?.data?.displayIcon ?? ''),
    };
  } catch {
    return { name: '', art: '' };
  }
}

/**
 * The account's current shop. Returns null (never throws) when the client is
 * closed, signed out, or offline — the panel renders a quiet note instead.
 */
export async function getAccountStore(force = false): Promise<AccountStore | null> {
  if (!isTauri()) return null;
  if (!force && memStore) return memStore.data;
  if (!force) {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { at: number; data: AccountStore };
        if (parsed?.data && Date.now() - parsed.at < storeTtlMs(parsed.data)) {
          memStore = { at: parsed.at, data: parsed.data };
          return parsed.data;
        }
      }
    } catch {}
  }
  if (storeInFlight) return storeInFlight;

  const task = (async (): Promise<AccountStore | null> => {
    try {
      const { getEntitlements, detectRegion, riotPost } = await import('./tracker');
      const ent = await getEntitlements().catch(() => null);
      if (!ent?.puuid) return memStore?.data ?? null;
      const region = await detectRegion().catch(() => 'eu');
      const raw = await riotPost(pdHostFor(region), `/store/v3/storefront/${ent.puuid}`);
      const layout = raw?.SkinsPanelLayout ?? {};
      const accStore = raw?.AccessoryStore ?? {};
      const bundle = raw?.FeaturedBundle?.Bundle ?? {};
      // Every live bundle: the featured one first, then `Bundles[]`
      // (deduped by ID) — the in-game carousel, e.g. DOG DAYS + RUN IT BACK.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawBundles: any[] = [
        bundle,
        ...((raw?.FeaturedBundle?.Bundles ?? []) as unknown[]),
      ];
      const seenBundle = new Set<string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const liveBundles = rawBundles.filter((b: any) => {
        const id = String(b?.ID ?? '');
        if (!id || seenBundle.has(id)) return false;
        seenBundle.add(id);
        return true;
      });
      const bundleAssets = liveBundles.map((b) => String(b?.DataAssetID ?? ''));

      const [catalog, cosmetics, currencies, ...bundleMetas] = await Promise.all([
        loadWeaponCatalog().catch(() => null),
        cosmeticCatalog(),
        currencyMap(),
        ...bundleAssets.map((id) => bundleInfo(id)),
      ]);

      const offers: StoreOffer[] = [];
      for (const o of layout.SingleItemStoreOffers ?? []) {
        const rw = o?.Rewards?.[0];
        const itemId = String(rw?.ItemID ?? '').toLowerCase();
        if (!itemId) continue;
        const hit = catalog?.skinIndex[itemId];
        const weaponName = hit?.weaponUuid ? catalog?.weapons[hit.weaponUuid]?.name ?? '' : '';
        const { amount, currencyUuid } = costOf(o?.Cost);
        const cur = currencyOf(currencyUuid, currencies);
        offers.push({
          offerId: String(o?.OfferID ?? itemId),
          itemId,
          name: hit?.name || 'Unknown skin',
          weaponName,
          icon: hit && !hit.isDefault ? hit.icon || '' : '',
          cost: amount,
          currency: cur.label,
          currencyIcon: cur.icon,
        });
      }

      const accessories: StoreAccessory[] = [];
      for (const a of accStore.AccessoryStoreOffers ?? []) {
        const o = a?.Offer ?? {};
        const rw = o?.Rewards?.[0];
        const itemId = String(rw?.ItemID ?? '').toLowerCase();
        if (!itemId) continue;
        const hit = cosmetics[itemId];
        const { amount, currencyUuid } = costOf(o?.Cost);
        const cur = currencyOf(currencyUuid, currencies);
        accessories.push({
          offerId: String(o?.OfferID ?? itemId),
          name: hit?.name || 'Unknown',
          icon: hit?.icon || '',
          kind: hit?.kind ?? 'cosmetic',
          cost: amount,
          currency: cur.label,
          currencyIcon: cur.icon,
        });
      }

      const bundles: StoreBundle[] = liveBundles.map((b, i) => {
        const meta = bundleMetas[i] ?? { name: '', art: '' };
        // Discounted first, then base: Riot sends an EMPTY discounted map
        // (not null) when nothing is on sale, so check the amount, not presence.
        const discounted = costOf(
          b?.TotalDiscountedCost as Record<string, number> | undefined
        );
        const { amount, currencyUuid } =
          discounted.amount > 0
            ? discounted
            : costOf(b?.TotalBaseCost as Record<string, number> | undefined);
        const cur = currencyOf(currencyUuid, currencies);
        // What's inside: ItemIDs resolve through the skin index first
        // (levels/chromas → parent skin art), then the cosmetics catalog
        // (buddies/cards/sprays) — the type id is not needed.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawItems: any[] = Array.isArray(b?.Items) ? b.Items : [];
        const items: StoreBundleItem[] = rawItems.map((it) => {
          const itemId = String(it?.Item?.ItemID ?? '').toLowerCase();
          const skinHit = itemId ? catalog?.skinIndex[itemId] : undefined;
          const cosHit = !skinHit && itemId ? cosmetics[itemId] : undefined;
          const p = Number(it?.DiscountedPrice ?? 0);
          const base = Number(it?.BasePrice ?? 0);
          const price = p > 0 ? p : base;
          const icur = currencyOf(String(it?.CurrencyID ?? ''), currencies);
          return {
            itemId,
            name: skinHit?.name || cosHit?.name || 'Unknown item',
            icon: (skinHit && !skinHit.isDefault ? skinHit.icon : '') || cosHit?.icon || '',
            kind: skinHit ? 'skin' : cosHit?.kind ?? 'cosmetic',
            amount: Math.max(1, Number(it?.Item?.Amount ?? 1)),
            price,
            currency: icur.label,
            currencyIcon: icur.icon,
          };
        });
        const secs =
          i === 0
            ? Number(raw?.FeaturedBundle?.BundleRemainingDurationInSeconds ?? 0)
            : Number(b?.DurationRemainingInSeconds ?? 0);
        return {
          id: String(b?.ID ?? ''),
          name: meta.name,
          art: meta.art,
          remainingSecs: secs,
          price: amount,
          currency: cur.label,
          currencyIcon: cur.icon,
          items,
        };
      });
      const liveNamed = bundles.filter((b) => b.name || b.art);

      const data: AccountStore = {
        offers: offers.slice(0, 4),
        accessories,
        bundle: liveNamed[0] ?? null,
        bundles: liveNamed,
        dailySecs: Number(layout.SingleItemOffersRemainingDurationInSeconds ?? 0),
        accSecs: Number(accStore.AccessoryStoreRemainingDurationInSeconds ?? 0),
        fetchedAt: Date.now(),
      };
      memStore = { at: Date.now(), data };
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ at: Date.now(), data }));
      } catch {}
      return data;
    } catch {
      return memStore?.data ?? null;
    }
  })();
  storeInFlight = task;
  try {
    return await task;
  } finally {
    if (storeInFlight === task) storeInFlight = null;
  }
}

/** Cache lives until the soonest rotation (floored at 5 minutes). */
function storeTtlMs(s: AccountStore): number {
  const remaining = Math.min(
    s.dailySecs > 0 ? s.dailySecs : Infinity,
    s.accSecs > 0 ? s.accSecs : Infinity,
    s.bundle?.remainingSecs && s.bundle.remainingSecs > 0 ? s.bundle.remainingSecs : Infinity
  );
  if (!Number.isFinite(remaining)) return 6 * 3600 * 1000;
  return Math.max(5 * 60, remaining) * 1000;
}

const WALLET_KEY = 'recon_wallet_v1';
const WALLET_TTL = 5 * 60 * 1000;

let memWallet: { at: number; data: WalletBalance[] } | null = null;
let walletInFlight: Promise<WalletBalance[] | null> | null = null;

/**
 * The account's wallet — VP, Radianite, Kingdom Credits, in client-header
 * order. Source of truth is Riot's player-data endpoint (same auth as the
 * storefront, verified against valapidocs):
 *
 *   GET https://pd.{region}.a.pvp.net/store/v1/wallet/{puuid}
 *   → { Balances: { [currencyUuid]: number } }
 *
 * Currency identities resolve by NAME from valorant-api `/v1/currencies`
 * (no hardcoded uuids). Returns null (never throws) when the client is
 * closed, signed out, or offline.
 */
export async function getWallet(force = false): Promise<WalletBalance[] | null> {
  if (!isTauri()) return null;
  if (!force && memWallet && Date.now() - memWallet.at < WALLET_TTL) return memWallet.data;
  if (!force) {
    try {
      const raw = localStorage.getItem(WALLET_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { at: number; data: WalletBalance[] };
        if (parsed?.data && Date.now() - parsed.at < WALLET_TTL) {
          memWallet = { at: parsed.at, data: parsed.data };
          return parsed.data;
        }
      }
    } catch {}
  }
  if (walletInFlight) return walletInFlight;

  const task = (async (): Promise<WalletBalance[] | null> => {
    try {
      const { getEntitlements, detectRegion, riotGet } = await import('./tracker');
      const ent = await getEntitlements().catch(() => null);
      if (!ent?.puuid) return memWallet?.data ?? null;
      const region = await detectRegion().catch(() => 'eu');
      const raw = await riotGet(pdHostFor(region), `/store/v1/wallet/${ent.puuid}`);
      const balances: Record<string, number> = raw?.Balances ?? {};
      const currencies = await currencyMap();
      // Client-header order, matched by name — never hardcoded uuids.
      const want = ['valorant points', 'radianite', 'kingdom'];
      const uuidOf = (needle: string): string => {
        for (const [uuid, info] of Object.entries(currencies)) {
          if (info.name.toLowerCase().includes(needle)) return uuid;
        }
        return '';
      };
      const out: WalletBalance[] = [];
      for (const needle of want) {
        const uuid = uuidOf(needle);
        if (!uuid) continue;
        out.push({
          amount: Math.max(0, Math.floor(Number(balances[uuid] ?? balances[uuid.toUpperCase()] ?? 0))),
          label: currencies[uuid].short,
          icon: currencies[uuid].icon,
        });
      }
      if (out.length === 0) return memWallet?.data ?? null;
      memWallet = { at: Date.now(), data: out };
      try {
        localStorage.setItem(WALLET_KEY, JSON.stringify({ at: Date.now(), data: out }));
      } catch {}
      return out;
    } catch {
      return memWallet?.data ?? null;
    }
  })();
  walletInFlight = task;
  try {
    return await task;
  } finally {
    if (walletInFlight === task) walletInFlight = null;
  }
}
