/**
 * Pure shape gate for the storefront response.
 *
 * The storefront is a POST with an empty body whose response is the shop. This
 * module is the only place that decides "is this a shop?" — no Tauri, no HTTP,
 * so it is testable with plain fixtures. `readStorefront` in `riot.ts` throws on
 * `null` instead of parsing an error into an empty shop (the bug that used to
 * overwrite the memory and localStorage caches).
 */

export interface StorefrontPayload {
  SkinsPanelLayout?: Record<string, unknown>;
  AccessoryStore?: Record<string, unknown>;
  FeaturedBundle?: Record<string, unknown>;
  [k: string]: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Riot's error envelope, never a shop. */
function isRiotError(j: Record<string, unknown>): boolean {
  const status = Number(j.httpStatus ?? 0);
  return Boolean(j.errorCode) || status >= 400;
}

/**
 * Returns the payload when it carries at least one shop section, `null`
 * otherwise. A response with an error envelope is rejected even though
 * `assertRiotOk` normally throws first: the pure gate must be safe on its own.
 * A shop missing any single section is accepted as long as another is present
 * (the caller renders whatever arrived).
 */
export function parseStorefrontPayload(j: unknown): StorefrontPayload | null {
  if (!isObject(j) || isRiotError(j)) return null;
  if (!isObject(j.SkinsPanelLayout) && !isObject(j.AccessoryStore) && !isObject(j.FeaturedBundle)) {
    return null;
  }
  return j as StorefrontPayload;
}
