import { isTauri } from './ipc';

/**
 * Crosshair profiles — read and recolored through Riot's player-preferences
 * service (the same route ValorantCC used as its fallback, reimplemented —
 * no foreign code).
 *
 *   GET https://player-preferences-{region}.pp.sgp.pvp.net/playerPref/v3/getPreference/Ares.PlayerSettings
 *   → { type, data: "<base64 raw-deflate of the settings doc>", modified }
 *   PUT .../playerPref/v3/savePreference  { type: "Ares.PlayerSettings", data }
 *
 * Notes from live verification (2026-09-13, EU account):
 * - The LOCAL lockfile route (`player-preferences/v1/data-json/...`) is dead
 *   for third parties: HTTP 500 "Unable to find caller ID for session".
 * - The doc schema is camelCase now (`currentProfile`, `profiles[]`,
 *   `primary.color.{r,g,b,a}`) — not ValorantCC's 2022 PascalCase. Reads
 *   tolerate both; writes use camelCase.
 * - `euc1` serves EU. Other region codes are UNVERIFIED — non-EU accounts get
 *   an honest note instead of a guessed hostname.
 * - Colors in global switches are `(R=255,G=255,B=255,A=255)` strings;
 *   profile color objects are `{r,g,b,a}`.
 *
 * No cache — settings are live state. Never throws: failures surface as
 * `{ error }` so the UI can print a quiet note instead.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Five recolorable slots. */
export const COLOR_SLOTS = [
  { key: 'primary', label: 'Primary' },
  { key: 'outline', label: 'Outline' },
  { key: 'ads', label: 'ADS' },
  { key: 'adsOutline', label: 'ADS outline' },
  { key: 'sniper', label: 'Sniper dot' },
] as const;

export interface CrosshairState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  profileNames: string[];
  current: number;
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };
const clampByte = (n: number): number =>
  Math.max(0, Math.min(255, Math.round(Number.isFinite(n) ? n : 0)));

/** `(R=0,G=255,B=0,A=255)` → {r,g,b,a}. Garbage in, white out. */
export function parseRiotColor(s: unknown): Rgba {
  const nums = String(s ?? '').match(/\d+/g)?.map(Number) ?? [];
  if (nums.length < 3) return { ...WHITE };
  return {
    r: clampByte(nums[0]),
    g: clampByte(nums[1]),
    b: clampByte(nums[2]),
    a: clampByte(nums[3] ?? 255),
  };
}

/** `{r,g,b,a}` or legacy `{R,G,B,A}` → Rgba. Garbage in, white out. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseColorObject(o: any): Rgba {
  if (!o || typeof o !== 'object') return { ...WHITE };
  const pick = (lo: string, hi: string): number =>
    Number.isFinite(Number(o[lo])) ? Number(o[lo]) : Number.isFinite(Number(o[hi])) ? Number(o[hi]) : NaN;
  const r = pick('r', 'R');
  if (!Number.isFinite(r)) return { ...WHITE };
  return {
    r: clampByte(r),
    g: clampByte(pick('g', 'G')),
    b: clampByte(pick('b', 'B')),
    a: Number.isFinite(pick('a', 'A')) ? clampByte(pick('a', 'A')) : 255,
  };
}

export const toRiotColor = (c: Rgba): string =>
  `(R=${clampByte(c.r)},G=${clampByte(c.g)},B=${clampByte(c.b)},A=${clampByte(c.a)})`;

export const toHex = (c: Rgba): string =>
  '#' + [c.r, c.g, c.b].map((n) => clampByte(n).toString(16).padStart(2, '0')).join('');

export function fromHex(hex: string, prev: Rgba): Rgba {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return prev;
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: prev.a };
}

/** Verified region → player-preferences host. Everything else: null (honest). */
export function ppHostFor(region: string): string | null {
  if (region.toLowerCase().trim() === 'eu') return 'player-preferences-euc1.pp.sgp.pvp.net';
  return null;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function inflateRaw(b64: string): Promise<string> {
  const ds = new DecompressionStream('deflate-raw');
  const bytes: BlobPart = b64ToBytes(b64) as unknown as BlobPart;
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Response(stream).text();
}

async function deflateRaw(text: string): Promise<string> {
  const cs = new CompressionStream('deflate-raw');
  // Attach the reader BEFORE writing: writer.write() applies backpressure and
  // never resolves on large docs if nobody is draining the readable side.
  const out = new Response(cs.readable).arrayBuffer();
  const writer = cs.writable.getWriter();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();
  const buf = await out;
  return bytesToB64(new Uint8Array(buf));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Entry = { settingEnum?: string; value?: any };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const strEntries = (data: any): Entry[] =>
  Array.isArray(data?.stringSettings) ? data.stringSettings : [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const boolEntries = (data: any): Entry[] =>
  Array.isArray(data?.boolSettings) ? data.boolSettings : [];

const SAVED_PROFILES = 'EAresStringSettingName::SavedCrosshairProfileData';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function profileListOf(data: any): { raw: any; profiles: any[]; current: number } {
  try {
    const rawStr = strEntries(data).find((e) => e.settingEnum === SAVED_PROFILES)?.value;
    const raw = JSON.parse(String(rawStr ?? 'null'));
    const profiles = Array.isArray(raw?.profiles)
      ? raw.profiles
      : Array.isArray(raw?.Profiles)
        ? raw.Profiles
        : [];
    const current = Number(raw?.currentProfile ?? raw?.CurrentProfile ?? 0);
    return { raw, profiles, current };
  } catch {
    return { raw: null, profiles: [], current: 0 };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const profName = (p: any, i: number): string =>
  String(p?.profileName ?? p?.ProfileName ?? `Profile ${i + 1}`);

/** Fetch the live settings doc + profile roster. `{ error }` when unavailable. */
export async function getCrosshair(): Promise<{ state: CrosshairState } | { error: string }> {
  if (!isTauri()) return { error: 'Desktop app only.' };
  try {
    const { detectRegion, riotGet } = await import('./tracker');
    const region = await detectRegion().catch(() => 'eu');
    const host = ppHostFor(region);
    if (!host) return { error: `Crosshair editing is verified for EU accounts only (yours: ${region.toUpperCase()}).` };
    const res = await riotGet(host, '/playerPref/v3/getPreference/Ares.PlayerSettings');
    if (!res || typeof res.data !== 'string') return { error: 'Unexpected settings response.' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = JSON.parse(await inflateRaw(res.data));
    if (!data || typeof data !== 'object') return { error: 'Unexpected settings response.' };
    const { profiles, current } = profileListOf(data);
    if (profiles.length === 0) {
      return { error: 'No crosshair profiles found — create one in-game first.' };
    }
    return {
      state: {
        data,
        profileNames: profiles.map(profName),
        current: Math.min(Math.max(0, current), profiles.length - 1),
      },
    };
  } catch {
    return { error: 'Open Riot Client or Valorant to edit your crosshair.' };
  }
}

/** The raw profile sub-objects (primary/ads/sniper) for the preview
 *  renderer. Read-only plumbing for the UI — all decisions stay in Rust. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function profileSection(state: CrosshairState, idx: number): { primary: any; ads: any; sniper: any } {
  const { profiles } = profileListOf(state.data);
  const p = profiles[idx] ?? {};
  const primary = p.primary ?? p.Primary ?? {};
  const ads =
    p.ads && typeof p.ads === 'object' && Object.keys(p.ads).length > 0
      ? p.ads
      : p.aDS && typeof p.aDS === 'object' && Object.keys(p.aDS).length > 0
        ? p.aDS
        : primary;
  const sniper = p.sniper ?? p.Sniper ?? {};
  return { primary, ads, sniper };
}

/** Every non-color setting, named like the game names them. */
export interface AdvState {
  // General
  outlines: boolean;
  outlineOpacity: number;
  outlineThickness: number;
  dotShown: boolean;
  dotOpacity: number;
  dotSize: number;
  // Inner lines
  innerShown: boolean;
  innerOpacity: number;
  innerLength: number;
  innerThickness: number;
  innerOffset: number;
  innerMoveError: boolean;
  innerMoveMult: number;
  innerFireError: boolean;
  innerFireMult: number;
  // Outer lines
  outerShown: boolean;
  outerOpacity: number;
  outerLength: number;
  outerThickness: number;
  outerOffset: number;
  outerVertScale: boolean;
  outerLengthV: number;
  outerMoveError: boolean;
  outerMoveMult: number;
  outerFireError: boolean;
  outerFireMult: number;
  // Other (profile-level)
  advOptions: boolean;
  spectated: boolean;
  fadeError: boolean;
  hideCrosshair: boolean;
  allPrimary: boolean;
  fixMinError: boolean;
  // ADS (applies when the profile carries its own ADS block)
  adsUsePrimary: boolean;
  adsLength: number;
  adsThickness: number;
  adsOffset: number;
  adsDotSize: number;
  // Sniper scope dot
  sniperShown: boolean;
  sniperOpacity: number;
  sniperDotSize: number;
}

/** Game slider ranges. Opacity 0–1, multipliers 0–3, dims per pro data. */
export const ADV_RANGES = {
  opacity: { min: 0, max: 1, step: 0.05 },
  outlineThickness: { min: 0, max: 6, step: 1 },
  length: { min: 0, max: 20, step: 1 },
  thickness: { min: 1, max: 10, step: 1 },
  offset: { min: 0, max: 20, step: 1 },
  mult: { min: 0, max: 3, step: 0.1 },
  dotSize: { min: 1, max: 6, step: 1 },
} as const;

const clampNum = (v: unknown, lo: number, hi: number, fb: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.max(lo, Math.min(hi, Math.round(n * 100) / 100));
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gval = (o: any, camel: string, pascal: string): any =>
  o?.[camel] ?? o?.[pascal];

/** Read the full non-color settings of profile `idx`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function profileAdv(state: CrosshairState, idx: number): AdvState {
  const { profiles } = profileListOf(state.data);
  const p = profiles[idx] ?? {};
  const primary = p.primary ?? p.Primary ?? {};
  const inner = primary.innerLines ?? primary.InnerLines ?? {};
  const outer = primary.outerLines ?? primary.OuterLines ?? {};
  const ads = p.ads ?? p.aDS ?? {};
  const adsInner = ads.innerLines ?? ads.InnerLines ?? {};
  const sniper = p.sniper ?? p.Sniper ?? {};
  const on = (v: unknown): boolean => v === true;
  const onByDefault = (v: unknown): boolean => v !== false;
  return {
    outlines: on(primary.bHasOutline),
    outlineOpacity: clampNum(gval(primary, 'outlineOpacity', 'OutlineOpacity'), 0, 1, 1),
    outlineThickness: clampNum(gval(primary, 'outlineThickness', 'OutlineThickness'), 0, 6, 1),
    dotShown: on(primary.bDisplayCenterDot),
    dotOpacity: clampNum(gval(primary, 'centerDotOpacity', 'CenterDotOpacity'), 0, 1, 1),
    dotSize: clampNum(gval(primary, 'centerDotSize', 'CenterDotSize'), 1, 6, 2),
    innerShown: onByDefault(gval(inner, 'bShowLines', 'BShowLines')),
    innerOpacity: clampNum(gval(inner, 'opacity', 'Opacity'), 0, 1, 1),
    innerLength: clampNum(gval(inner, 'lineLength', 'LineLength'), 0, 20, 4),
    innerThickness: clampNum(gval(inner, 'lineThickness', 'LineThickness'), 1, 10, 2),
    innerOffset: clampNum(gval(inner, 'lineOffset', 'LineOffset'), 0, 20, 0),
    innerMoveError: on(gval(inner, 'bShowMovementError', 'BShowMovementError')),
    innerMoveMult: clampNum(gval(inner, 'movementErrorScale', 'MovementErrorScale'), 0, 3, 1),
    innerFireError: on(gval(inner, 'bShowShootingError', 'BShowShootingError')),
    innerFireMult: clampNum(gval(inner, 'firingErrorScale', 'FiringErrorScale'), 0, 3, 1),
    outerShown: on(gval(outer, 'bShowLines', 'BShowLines')),
    outerOpacity: clampNum(gval(outer, 'opacity', 'Opacity'), 0, 1, 1),
    outerLength: clampNum(gval(outer, 'lineLength', 'LineLength'), 0, 20, 2),
    outerThickness: clampNum(gval(outer, 'lineThickness', 'LineThickness'), 1, 10, 2),
    outerOffset: clampNum(gval(outer, 'lineOffset', 'LineOffset'), 0, 20, 10),
    outerVertScale: on(gval(outer, 'bAllowVertScaling', 'BAllowVertScaling')),
    outerLengthV: clampNum(gval(outer, 'lineLengthVertical', 'LineLengthVertical'), 0, 20, 2),
    outerMoveError: on(gval(outer, 'bShowMovementError', 'BShowMovementError')),
    outerMoveMult: clampNum(gval(outer, 'movementErrorScale', 'MovementErrorScale'), 0, 3, 1),
    outerFireError: on(gval(outer, 'bShowShootingError', 'BShowShootingError')),
    outerFireMult: clampNum(gval(outer, 'firingErrorScale', 'FiringErrorScale'), 0, 3, 1),
    advOptions: onByDefault(p.bUseAdvancedOptions ?? p.BUseAdvancedOptions),
    spectated: on(primary.bShowSpectatedPlayerCrosshair ?? primary.BShowSpectatedPlayerCrosshair),
    fadeError: on(primary.bFadeCrosshairWithFiringError ?? primary.BFadeCrosshairWithFiringError),
    hideCrosshair: on(primary.bHideCrosshair ?? primary.BHideCrosshair),
    allPrimary: on(p.bUseCustomCrosshairOnAllPrimary ?? p.BUseCustomCrosshairOnAllPrimary),
    fixMinError: on(primary.bFixMinErrorAcrossWeapons ?? primary.BFixMinErrorAcrossWeapons),
    adsUsePrimary: gval(p, 'bUsePrimaryCrosshairForADS', 'BUsePrimaryCrosshairForADS') !== false,
    adsLength: clampNum(gval(adsInner, 'lineLength', 'LineLength'), 0, 20, 4),
    adsThickness: clampNum(gval(adsInner, 'lineThickness', 'LineThickness'), 1, 10, 2),
    adsOffset: clampNum(gval(adsInner, 'lineOffset', 'LineOffset'), 0, 20, 0),
    adsDotSize: clampNum(gval(ads, 'centerDotSize', 'CenterDotSize'), 1, 6, 2),
    sniperShown: on(gval(sniper, 'bDisplayCenterDot', 'BDisplayCenterDot')),
    sniperOpacity: clampNum(gval(sniper, 'centerDotOpacity', 'CenterDotOpacity'), 0, 1, 1),
    sniperDotSize: clampNum(gval(sniper, 'centerDotSize', 'CenterDotSize'), 1, 6, 1),
  };
}

/**
 * Write the full non-color settings of profile `idx`. Only known keys are
 * touched — opacity, error toggles, multipliers, flags, ADS subset, sniper
 * dot — everything else passes through. Values are clamped to the game
 * slider ranges. ADS dims write only when the profile carries its own ADS
 * block (or stops using primary); otherwise the flag alone is stored.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withCrosshairAdv(doc: any, idx: number, adv: AdvState): any {
  const data = JSON.parse(JSON.stringify(doc));
  const { raw, profiles, current } = profileListOf(data);
  const p = profiles[idx];
  if (!p || typeof p !== 'object') throw new Error('Unknown profile.');
  const pick = (o: object, camel: string, pascal: string): string =>
    camel in o ? camel : pascal in o ? pascal : camel;
  const set = (o: object, camel: string, pascal: string, v: unknown): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (o as any)[pick(o, camel, pascal)] = v;
  };

  // General (primary block).
  const primKey = p.primary !== undefined ? 'primary' : 'Primary';
  const base = p[primKey] ?? {};
  const nextPrimary = { ...base };
  set(nextPrimary, 'bHasOutline', 'BHasOutline', adv.outlines);
  set(nextPrimary, 'outlineOpacity', 'OutlineOpacity', clampNum(adv.outlineOpacity, 0, 1, 1));
  set(nextPrimary, 'outlineThickness', 'OutlineThickness', clampNum(adv.outlineThickness, 0, 6, 1));
  set(nextPrimary, 'bDisplayCenterDot', 'BDisplayCenterDot', adv.dotShown);
  set(nextPrimary, 'centerDotOpacity', 'CenterDotOpacity', clampNum(adv.dotOpacity, 0, 1, 1));
  set(nextPrimary, 'centerDotSize', 'CenterDotSize', clampNum(adv.dotSize, 1, 6, 2));
  set(nextPrimary, 'bShowSpectatedPlayerCrosshair', 'BShowSpectatedPlayerCrosshair', adv.spectated);
  set(nextPrimary, 'bFadeCrosshairWithFiringError', 'BFadeCrosshairWithFiringError', adv.fadeError);
  set(nextPrimary, 'bHideCrosshair', 'BHideCrosshair', adv.hideCrosshair);
  set(nextPrimary, 'bFixMinErrorAcrossWeapons', 'BFixMinErrorAcrossWeapons', adv.fixMinError);

  // Inner lines.
  const inKey = base.innerLines !== undefined || base.InnerLines === undefined ? 'innerLines' : 'InnerLines';
  const inner = { ...(base[inKey] ?? {}) };
  const setLine = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    o: any,
    show: boolean,
    op: number,
    len: number,
    th: number,
    off: number,
    mv: boolean,
    mvm: number,
    fe: boolean,
    fem: number,
    vert: boolean,
    lenV: number
  ): void => {
    set(o, 'bShowLines', 'BShowLines', show);
    set(o, 'opacity', 'Opacity', clampNum(op, 0, 1, 1));
    set(o, 'lineLength', 'LineLength', clampNum(len, 0, 20, 4));
    set(o, 'lineThickness', 'LineThickness', clampNum(th, 1, 10, 2));
    set(o, 'lineOffset', 'LineOffset', clampNum(off, 0, 20, 0));
    set(o, 'bShowMovementError', 'BShowMovementError', mv);
    set(o, 'movementErrorScale', 'MovementErrorScale', clampNum(mvm, 0, 3, 1));
    set(o, 'bShowShootingError', 'BShowShootingError', fe);
    set(o, 'firingErrorScale', 'FiringErrorScale', clampNum(fem, 0, 3, 1));
    set(o, 'bAllowVertScaling', 'BAllowVertScaling', vert);
    set(o, 'lineLengthVertical', 'LineLengthVertical', clampNum(lenV, 0, 20, 2));
  };
  setLine(
    inner, adv.innerShown, adv.innerOpacity, adv.innerLength, adv.innerThickness,
    adv.innerOffset, adv.innerMoveError, adv.innerMoveMult, adv.innerFireError,
    adv.innerFireMult, false, adv.innerLength
  );

  // Outer lines.
  const outKey = base.outerLines !== undefined || base.OuterLines === undefined ? 'outerLines' : 'OuterLines';
  const outer = { ...(base[outKey] ?? {}) };
  setLine(
    outer, adv.outerShown, adv.outerOpacity, adv.outerLength, adv.outerThickness,
    adv.outerOffset, adv.outerMoveError, adv.outerMoveMult, adv.outerFireError,
    adv.outerFireMult, adv.outerVertScale, adv.outerLengthV
  );

  p[primKey] = { ...nextPrimary, [inKey]: inner, [outKey]: outer };
  for (const legacy of ['Primary']) {
    if (legacy !== primKey && p[legacy] !== undefined) delete p[legacy];
  }

  // Profile-level flags.
  set(p, 'bUseAdvancedOptions', 'BUseAdvancedOptions', adv.advOptions);
  set(p, 'bUseCustomCrosshairOnAllPrimary', 'BUseCustomCrosshairOnAllPrimary', adv.allPrimary);
  set(p, 'bUsePrimaryCrosshairForADS', 'BUsePrimaryCrosshairForADS', adv.adsUsePrimary);

  // ADS subset — only when the profile has (or leaves) its own ADS block.
  // An EMPTY ads object counts as absent (same rule as the preview).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nonEmpty = (o: any): boolean => !!o && typeof o === 'object' && Object.keys(o).length > 0;
  const hasAds = nonEmpty(p.ads) || nonEmpty(p.aDS);
  if (hasAds || !adv.adsUsePrimary) {
    const adsKey = p.ads !== undefined || p.aDS === undefined ? 'ads' : 'aDS';
    const adsBase = p[adsKey] ?? {};
    const adsInKey =
      adsBase.innerLines !== undefined || adsBase.InnerLines === undefined ? 'innerLines' : 'InnerLines';
    const adsInner = { ...(adsBase[adsInKey] ?? {}) };
    set(adsInner, 'lineLength', 'LineLength', clampNum(adv.adsLength, 0, 20, 4));
    set(adsInner, 'lineThickness', 'LineThickness', clampNum(adv.adsThickness, 1, 10, 2));
    set(adsInner, 'lineOffset', 'LineOffset', clampNum(adv.adsOffset, 0, 20, 0));
    p[adsKey] = {
      ...adsBase,
      [adsInKey]: adsInner,
    };
    set(p[adsKey], 'centerDotSize', 'CenterDotSize', clampNum(adv.adsDotSize, 1, 6, 2));
  }

  // Sniper scope dot.
  const snKey = p.sniper !== undefined || p.Sniper === undefined ? 'sniper' : 'Sniper';
  const snBase = p[snKey] ?? {};
  p[snKey] = {
    ...snBase,
  };
  set(p[snKey], 'bDisplayCenterDot', 'BDisplayCenterDot', adv.sniperShown);
  set(p[snKey], 'centerDotOpacity', 'CenterDotOpacity', clampNum(adv.sniperOpacity, 0, 1, 1));
  set(p[snKey], 'centerDotSize', 'CenterDotSize', clampNum(adv.sniperDotSize, 1, 6, 1));

  // NOTE: `profiles` is the live array inside `raw` — do NOT re-parse here.
  upsert(strEntries(data), SAVED_PROFILES, JSON.stringify(preserveCurrent(raw, profiles, current)));
  return data;
}
/** The five slot colors of profile `idx`. ADS falls back to primary when the
 *  profile uses the primary crosshair for ADS; everything defaults to white. */
export function profileColors(state: CrosshairState, idx: number): Rgba[] {
  const { profiles } = profileListOf(state.data);
  const p = profiles[idx];
  const blank = (): Rgba[] => Array.from({ length: 5 }, () => ({ ...WHITE }));
  if (!p || typeof p !== 'object') return blank();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sub = (obj: any): any => (obj && typeof obj === 'object' ? obj : {});
  const primary = sub(p.primary ?? p.Primary);
  const ads = sub(p.ads ?? p.aDS);
  const sniper = sub(p.sniper ?? p.Sniper);
  const adsColors = ads.color ?? ads.Color;
  return [
    parseColorObject(primary.color ?? primary.Color),
    parseColorObject(primary.outlineColor ?? primary.OutlineColor),
    parseColorObject(adsColors ?? primary.color ?? primary.Color),
    parseColorObject(ads.outlineColor ?? ads.OutlineColor ?? primary.outlineColor ?? primary.OutlineColor),
    parseColorObject(sniper.centerDotColor ?? sniper.CenterDotColor),
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function upsert(list: Entry[], settingEnum: string, value: any): void {
  const hit = list.find((e) => e.settingEnum === settingEnum);
  if (hit) hit.value = value;
  else list.push({ settingEnum, value });
}

const ACTIVE_STRING_SLOTS: [string, number][] = [
  ['EAresStringSettingName::CrosshairColor', 0],
  ['EAresStringSettingName::CrosshairColorCustom', 0],
  ['EAresStringSettingName::CrosshairOutlineColor', 1],
  ['EAresStringSettingName::CrosshairADSColor', 2],
  ['EAresStringSettingName::CrosshairADSColorCustom', 2],
  ['EAresStringSettingName::CrosshairADSOutlineColor', 3],
  ['EAresStringSettingName::CrosshairSniperCenterDotColor', 4],
  ['EAresStringSettingName::CrosshairSniperCenterDotColorCustom', 4],
];

const ACTIVE_BOOL_SLOTS = [
  'EAresBoolSettingName::CrosshairUseCustomColor',
  'EAresBoolSettingName::CrosshairADSUseCustomColor',
  'EAresBoolSettingName::CrosshairSniperUseCustomColor',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function preserveCurrent(raw: any, profiles: any[], current: number): any {
  const out = { ...(raw ?? {}), profiles };
  // Keep whichever casing the doc already used; default to live camelCase.
  if (raw && 'CurrentProfile' in raw && !('currentProfile' in raw)) out.CurrentProfile = current;
  else out.currentProfile = current;
  return out;
}

/**
 * Rename profile `idx` to `newName`. Returns updated document.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renameCrosshairProfile(doc: any, idx: number, newName: string): any {
  const data = JSON.parse(JSON.stringify(doc));
  const { raw, profiles, current } = profileListOf(data);
  const p = profiles[idx];
  if (!p) throw new Error('Unknown profile index.');
  const trimmed = newName.trim() || `Profile ${idx + 1}`;
  if ('ProfileName' in p && !('profileName' in p)) p.ProfileName = trimmed;
  else p.profileName = trimmed;
  upsert(strEntries(data), SAVED_PROFILES, JSON.stringify(preserveCurrent(raw, profiles, current)));
  return data;
}

/**
 * Add a new profile by cloning `cloneIdx` (or current). Returns `{ doc, newIdx }`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function addCrosshairProfile(doc: any, name: string, cloneIdx: number = 0): { doc: any; newIdx: number } {
  const data = JSON.parse(JSON.stringify(doc));
  const { raw, profiles, current } = profileListOf(data);
  const base = profiles[cloneIdx] ?? profiles[0] ?? {};
  const clone = JSON.parse(JSON.stringify(base));
  const trimmed = name.trim() || `Profile ${profiles.length + 1}`;
  if ('ProfileName' in clone && !('profileName' in clone)) clone.ProfileName = trimmed;
  else clone.profileName = trimmed;
  profiles.push(clone);
  const newIdx = profiles.length - 1;
  upsert(strEntries(data), SAVED_PROFILES, JSON.stringify(preserveCurrent(raw, profiles, current)));
  return { doc: data, newIdx };
}

/**
 * Delete profile `idx`. Returns `{ doc, newIdx }` or null if only 1 profile exists.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function removeCrosshairProfile(doc: any, idx: number): { doc: any; newIdx: number } | null {
  const data = JSON.parse(JSON.stringify(doc));
  const { raw, profiles, current } = profileListOf(data);
  if (profiles.length <= 1) return null;
  profiles.splice(idx, 1);
  let nextCurrent = current;
  if (nextCurrent >= profiles.length) nextCurrent = profiles.length - 1;
  else if (nextCurrent > idx) nextCurrent -= 1;
  const newIdx = Math.min(idx, profiles.length - 1);
  upsert(strEntries(data), SAVED_PROFILES, JSON.stringify(preserveCurrent(raw, profiles, nextCurrent)));
  return { doc: data, newIdx };
}

/**
 * Recolor profile `idx` with the five slot colors. Returns a NEW settings doc
 * (the input is untouched) with the profile entry and, when the profile is
 * the active one, the global EAres color switches updated too. Everything
 * else in the doc passes through untouched.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withCrosshairColors(state: CrosshairState, idx: number, colors: Rgba[]): any {
  const data = JSON.parse(JSON.stringify(state.data));
  const { raw, profiles, current } = profileListOf(data);
  const p = profiles[idx];
  if (!p || typeof p !== 'object') throw new Error('Unknown profile.');
  const [primary, outline, ads, adsOutline, sniper] = colors;
  const col = (c: Rgba): { r: number; g: number; b: number; a: number } => ({
    r: clampByte(c.r),
    g: clampByte(c.g),
    b: clampByte(c.b),
    a: clampByte(c.a),
  });
  p.bUseAdvancedOptions = true;
  p.primary = {
    ...(p.primary ?? p.Primary ?? {}),
    bUseCustomColor: true,
    color: col(primary),
    colorCustom: col(primary),
    outlineColor: col(outline),
  };
  if (p.Primary !== undefined) delete p.Primary;
  const adsBase =
    p.ads && typeof p.ads === 'object' ? p.ads : p.aDS && typeof p.aDS === 'object' ? p.aDS : {};
  p.ads = {
    ...adsBase,
    bUseCustomColor: true,
    color: col(ads),
    colorCustom: col(ads),
    outlineColor: col(adsOutline),
  };
  if (p.aDS !== undefined) delete p.aDS;
  p.sniper = {
    ...(p.sniper && typeof p.sniper === 'object'
      ? p.sniper
      : p.Sniper && typeof p.Sniper === 'object'
        ? p.Sniper
        : {}),
    bUseCustomCenterDotColor: true,
    centerDotColor: col(sniper),
    centerDotColorCustom: col(sniper),
  };
  if (p.Sniper !== undefined) delete p.Sniper;
  upsert(strEntries(data), SAVED_PROFILES, JSON.stringify(preserveCurrent(raw, profiles, current)));
  if (idx === current) {
    for (const [settingEnum, slot] of ACTIVE_STRING_SLOTS) {
      upsert(strEntries(data), settingEnum, toRiotColor(colors[slot]));
    }
    for (const settingEnum of ACTIVE_BOOL_SLOTS) {
      upsert(boolEntries(data), settingEnum, true);
    }
  }
  return data;
}

/** Persist a settings doc. True only when the service answers `{ data: ... }`.
 *  Hard 30s cap — a stalled network/Rust stage must surface as failure,
 *  never as a forever-spinning save button. */
export async function saveCrosshair(host: string, data: any): Promise<boolean> {
  try {
    const { riotPut } = await import('./tracker');
    const payload = JSON.stringify({
      type: 'Ares.PlayerSettings',
      data: await deflateRaw(JSON.stringify(data)),
    });
    const res = await Promise.race([
      riotPut(host, '/playerPref/v3/savePreference', payload),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SAVE_TIMEOUT')), 30000)),
    ]);
    return !!res && typeof res === 'object' && typeof res.data === 'string';
  } catch {
    return false;
  }
}

/** The verified player-preferences host for this account, or null. */
export async function crosshairHost(): Promise<string | null> {
  try {
    const { detectRegion } = await import('./tracker');
    const region = await detectRegion().catch(() => 'eu');
    return ppHostFor(region);
  } catch {
    return null;
  }
}