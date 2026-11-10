import { describe, expect, test } from 'bun:test';
import { parseStorefrontPayload } from '../src/sources/storefront';

const SHOP = {
  SkinsPanelLayout: { SingleItemStoreOffers: [{ OfferID: 'o1' }] },
  AccessoryStore: { AccessoryStoreOffers: [] },
  FeaturedBundle: { Bundle: { ID: 'b1' }, Bundles: [] },
};

describe('parseStorefrontPayload', () => {
  test('accepts a well-formed shop', () => {
    expect(parseStorefrontPayload(SHOP)).toEqual(SHOP);
    expect(parseStorefrontPayload({ SkinsPanelLayout: {} })).toEqual({ SkinsPanelLayout: {} });
  });

  test('rejects a Riot error envelope (the empty-shop bug)', () => {
    // The old path parsed these into empty sections, produced an empty shop and
    // overwrote the memory + localStorage caches.
    expect(parseStorefrontPayload({ errorCode: 'SCHEDULED_DOWNTIME', httpStatus: 403 })).toBeNull();
    expect(parseStorefrontPayload({ httpStatus: 500 })).toBeNull();
    expect(parseStorefrontPayload({ errorCode: 'RESOURCE_NOT_FOUND' })).toBeNull();
    // Even when an error response also carries shop-shaped keys.
    expect(parseStorefrontPayload({ ...SHOP, errorCode: 'X', httpStatus: 400 })).toBeNull();
  });

  test('rejects a payload missing all shop sections', () => {
    expect(parseStorefrontPayload({})).toBeNull();
    expect(parseStorefrontPayload({ SkinsPanelLayout: null })).toBeNull();
    expect(parseStorefrontPayload({ SkinsPanelLayout: 'nope' })).toBeNull();
  });

  test('accepts a shop missing SkinsPanelLayout but carrying another section', () => {
    // Rule: one section is enough; the caller renders whatever arrived.
    expect(parseStorefrontPayload({ AccessoryStore: {} })).toEqual({ AccessoryStore: {} });
    expect(parseStorefrontPayload({ FeaturedBundle: {} })).toEqual({ FeaturedBundle: {} });
  });

  test('rejects an unexpected shape', () => {
    for (const bad of [null, undefined, 'x', 42, true, [], [SHOP]]) {
      expect(parseStorefrontPayload(bad)).toBeNull();
    }
  });
});
