/**
 * Loadout catalogue + parser.
 *
 * Source of truth for "what is this player holding": the ONLY endpoints that
 * expose equipped skins/sprays are the in-progress loadout routes
 *
 *   GET glz-{region}-1.{shard}.a.pvp.net/core-game/v1/matches/{id}/loadouts
 *   GET glz-{region}-1.{shard}.a.pvp.net/pregame/v1/matches/{id}/loadouts
 *
 * Riot retired the per-player personalization routes (verified 404 both locally
 * and remotely), so there is NO out-of-match equivalent — the viewer is gated
 * on a live match for that reason.
 *
 * ---------------------------------------------------------------------------
 * PAYLOAD SHAPE (verified against a live match, cross-checked with
 * pwall2222/NOWT's C# client, which is the working reference implementation)
 *
 *   Loadouts[]  { CharacterID, Subject, Loadout }
 *   Loadout     { Subject, Items, Expressions, DynamicOptions }
 *   Items       { [WEAPON_UUID]: { ID, TypeID, Sockets } }
 *   Sockets     { ["3ad1b2b2-…"]: { ID, Item: { ID, TypeID } } }
 *
 * Three traps are load-bearing and each one alone breaks the screen:
 *
 *  1. `Items` is keyed by WEAPON UUID (Classic 29a0cfab-…, Vandal 9c82e19d-…),
 *     not an opaque socket id. All 20 weapon UUIDs were confirmed against the
 *     content API.
 *  2. The equipped value is NOT `Items[key].ID` (that is the weapon's default
 *     entry). It lives in the fixed SKIN_SOCKET below, and that value may be a
 *     CHROMA uuid or a SKIN uuid depending on the weapon — both must resolve.
 *  3. `Sprays` IS ABSENT from the payload even though older docs list it.
 *     Sprays now arrive through `Expressions.AESSelections` alongside flex
 *     emotes, so the AssetID must be looked up in the sprays table AND the flex
 *     table. Calling the flex image path for a spray (or vice versa) returns
 *     404 and the whole wheel renders as broken icons.
 *
 * ART SOURCE: `/v1/weapons/skinchromas` is the authoritative per-chroma art
 * table (what NOWT ships). `/v1/weapons` alone is not enough — the DEFAULT
 * ("Standard …") skin entries carry a GREY X PLACEHOLDER as their displayIcon,
 * so resolving a default loadout through skins alone paints an X on every
 * default weapon. When the equipped skin is a default, fall back to the
 * weapon-level displayIcon, which is the canonical gun render.
 * ---------------------------------------------------------------------------
 */

const CATALOG_KEY = 'recon_weapon_catalog_v5';
const API = 'https://valorant-api.com/v1';

/** The socket holding the equipped weapon skin. Fixed across patches so far. */
export const SKIN_SOCKET = '3ad1b2b2-acdb-4524-852f-954a76ddae0a';
/**
 * Full socket map per weapon entry (verified against live pregame + coregame
 * payloads and RXJpaw/Valorant-Companion's working parser):
 *   bcef87d6…  skin        → Item.ID is the SKIN uuid (parent identity)
 *   3ad1b2b2…  skin_chroma → Item.ID is the CHROMA uuid (the equipped variant)
 *   e7c63390…  skin_level  → Item.ID is the LEVEL uuid (VFX/finisher stage)
 *   77258665…  buddy       → Item.ID is the BUDDY uuid (absent when unequipped)
 * (A fifth dd3bf334… entry carries a buddy instance id — not needed for display.)
 */
export const SKIN_ID_SOCKET = 'bcef87d6-209b-46c6-8b19-fbe40bd95abc';
export const SKIN_LEVEL_SOCKET = 'e7c63390-eda7-46e0-bb7a-a6abdacd2433';
export const BUDDY_SOCKET = '77258665-71d1-4623-bc72-44db9bd5b3b3';

/** Category strings Riot ships on `/v1/weapons`, mapped to display headings. */
export const CATEGORY_LABELS: Record<string, string> = {
  'EEquippableCategory::Sidearm': 'Sidearms',
  'EEquippableCategory::SMG': 'SMGs',
  'EEquippableCategory::Shotgun': 'Shotguns',
  'EEquippableCategory::Rifle': 'Rifles',
  'EEquippableCategory::Melee': 'Melee',
  'EEquippableCategory::Sniper': 'Sniper Rifles',
  'EEquippableCategory::Heavy': 'Machine Guns',
};

/** Canonical 5-column layout matching the official Valorant Collection screen. */
export interface WeaponSlotDef {
  id: string; // weapon UUID
  name: string; // e.g. "CLASSIC"
}

export interface ColumnSectionDef {
  title: string;
  weapons: WeaponSlotDef[];
}

export interface ColumnDef {
  sections: ColumnSectionDef[];
}

export const ARSENAL_COLUMNS: ColumnDef[] = [
  // Column 1: SIDEARMS (6 items)
  {
    sections: [
      {
        title: 'SIDEARMS',
        weapons: [
          { id: '29a0cfab-485b-f5d5-779a-b59f85e204a8', name: 'CLASSIC' },
          { id: '42da8ccc-40d5-affc-beec-15aa47b42eda', name: 'SHORTY' },
          { id: '44d4e95c-4157-0037-81b2-17841bf2e8e3', name: 'FRENZY' },
          { id: '1baa85b4-4c70-1284-64bb-6481dfc3bb4e', name: 'GHOST' },
          { id: 'e336c6b8-418d-9340-d77f-7a9e4cfe0702', name: 'SHERIFF' },
        ],
      },
    ],
  },
  // Column 2: SMGS (2 items) & SHOTGUNS (2 items)
  {
    sections: [
      {
        title: 'SMGS',
        weapons: [
          { id: 'f7e1b454-4ad4-1063-ec0a-159e56b58941', name: 'STINGER' },
          { id: '462080d1-4035-2937-7c09-27aa2a5c27a7', name: 'SPECTRE' },
        ],
      },
      {
        title: 'SHOTGUNS',
        weapons: [
          { id: '910be174-449b-c412-ab22-d0873436b21b', name: 'BUCKY' },
          { id: 'ec845bf4-4f79-ddda-a3da-0db3774b2794', name: 'JUDGE' },
        ],
      },
    ],
  },
  // Column 3: RIFLES (4 items) & MELEE (1 item)
  {
    sections: [
      {
        title: 'RIFLES',
        weapons: [
          { id: 'ae3de142-4d85-2547-dd26-4e90bed35cf7', name: 'BULLDOG' },
          { id: '4ade7faa-4cf1-8376-95ef-39884480959b', name: 'GUARDIAN' },
          { id: 'ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a', name: 'PHANTOM' },
          { id: '9c82e19d-4575-0200-1a81-3eacf00cf872', name: 'VANDAL' },
        ],
      },
      {
        title: 'MELEE',
        weapons: [
          { id: '2f59173c-4bed-b6c3-2191-dea9b58be9c7', name: 'MELEE' },
        ],
      },
    ],
  },
  // Column 4: SNIPER RIFLES (3 items) & MACHINE GUNS (2 items)
  {
    sections: [
      {
        title: 'SNIPER RIFLES',
        weapons: [
          { id: 'c4883e50-4494-202c-3ec3-6b8a9284f00b', name: 'MARSHAL' },
          { id: '5f0aaf7a-4289-3998-d5ff-eb9a5cf7ef5c', name: 'OUTLAW' },
          { id: 'a03b24d3-4319-996d-0f8c-94bbfba1dfc7', name: 'OPERATOR' },
        ],
      },
      {
        title: 'MACHINE GUNS',
        weapons: [
          { id: '55d8a0f4-4274-ca67-fe2c-06ab45efdf58', name: 'ARES' },
          { id: '63e6c2b6-4a8e-869c-3d4c-e38355226584', name: 'ODIN' },
        ],
      },
    ],
  },
];

/** Canonical top-to-bottom weapon order, matching the collection screen. */
export const WEAPON_ORDER = [
  'Classic', 'Shorty', 'Frenzy', 'Ghost', 'Sheriff',
  'Stinger', 'Spectre',
  'Bucky', 'Judge',
  'Bulldog', 'Guardian', 'Phantom', 'Vandal',
  'Melee',
  'Marshal', 'Outlaw', 'Operator',
  'Ares', 'Odin',
];

export const orderOf = (weaponName: string): number => {
  const i = WEAPON_ORDER.indexOf(weaponName);
  return i === -1 ? WEAPON_ORDER.length : i;
};

export interface WeaponSkin {
  name: string;
  icon: string;
}

export interface WeaponInfo {
  uuid: string;
  name: string;
  category: string;
  /** Weapon-level art — the canonical render, used for default skins. */
  icon: string;
}

/** A cosmetic resolved from the sprays, flex, or buddy table. */
export interface Cosmetic {
  name: string;
  icon: string;
  kind: 'spray' | 'flex' | 'buddy';
}

export interface WeaponCatalog {
  weapons: Record<string, WeaponInfo>;
  /**
   * Any equipped-socket UUID -> resolved art. Holds chroma UUIDs, skin UUIDs
   * and skin-level UUIDs, because the payload does not promise which it sends.
   */
  skinIndex: Record<string, { weaponUuid: string; name: string; icon: string; isDefault: boolean }>;
  sprays: Record<string, Cosmetic>;
  flex: Record<string, Cosmetic>;
  /** Buddy uuid -> art. The buddy socket is absent when nothing is equipped. */
  buddies: Record<string, Cosmetic>;
  /**
   * Chroma uuid -> Riot's raw chroma label, e.g.
   * "Neptune Odin Level 3 / (Variant 1 Black)". NEVER shown verbatim: the
   * viewer shows the parent skin name plus the extracted "(Variant …)" tag.
   */
  chromaNames: Record<string, string>;
  /** Skin-level uuid -> 1-based level number ("Lv 4"), from levels[] order. */
  levelIndex: Record<string, number>;
}

export interface EquippedWeapon {
  weaponUuid: string;
  weaponName: string;
  category: string;
  skinId: string;
  skinName: string;
  icon: string;
  /** True when the player runs the default (unskinned) weapon entry. */
  isDefaultSkin: boolean;
  /** Riot's variant tag, e.g. "Variant 1 Black". Empty for base skins. */
  variantLabel: string;
  /** Equipped VFX stage, 0 when unknown. */
  level: number;
  buddyName: string;
  buddyIcon: string;
}

/**
 * Riot's "(Variant …)" tag out of a raw chroma label like
 * "Neptune Odin Level 3 / (Variant 1 Black)". Empty when the chroma carries
 * no variant marking (base colors).
 */
export const variantLabelOf = (chromaName: string): string => {
  const m = /\(([^)]*variant[^)]*)\)/i.exec(chromaName ?? '');
  return m ? m[1].trim().replace(/\s+/g, ' ') : '';
};

/** Chroma labels are sometimes just the gun ("Ghost") — never a skin name. */
const isBareWeaponName = (label: string, weaponName: string): boolean => {
  const s = (label ?? '').trim().toLowerCase();
  const w = (weaponName ?? '').trim().toLowerCase();
  return s !== '' && (s === w || s === `standard ${w}`);
};

export interface EquippedExpression {
  assetId: string;
  kind: 'spray' | 'flex' | 'buddy';
  name: string;
  icon: string;
}

export interface PlayerLoadout {
  /** PUUID — present on the payload and the most reliable join key. */
  subject: string;
  characterId: string;
  weapons: EquippedWeapon[];
  expressions: EquippedExpression[];
}

let memCatalog: WeaponCatalog | null = null;

const mediaUrl = (kind: string, uuid: string, file = 'displayicon.png') =>
  `https://media.valorant-api.com/${kind}/${uuid}/${file}`;

export const sprayIcon = (uuid: string) => mediaUrl('sprays', uuid);
export const flexIcon = (uuid: string) => mediaUrl('flex', uuid);
export const playerCardIcon = (uuid: string) => mediaUrl('playercards', uuid);
export const playerCardWide = (uuid: string) => mediaUrl('playercards', uuid, 'wideart.png');
/** Vertical card art — the aspect the collection screen's card slot uses. */
export const playerCardLarge = (uuid: string) => mediaUrl('playercards', uuid, 'largeart.png');

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * Riot's "Standard …" entries are default skins. Their `displayIcon` is a grey
 * X placeholder rather than a weapon render, so they must be drawn with the
 * weapon-level art instead.
 */
export const isDefaultSkinName = (skinName: string, weaponName?: string): boolean => {
  const s = skinName.trim().toLowerCase();
  const w = (weaponName || '').trim().toLowerCase();
  return s.startsWith('standard') || (w !== '' && s === w) || s === 'melee';
};

/**
 * Build the catalogue from the content API.
 *
 * Four tables, in parallel:
 *  - `/weapons`          weapon names, categories, canonical art, skin lists
 *  - `/weapons/skinchromas` per-chroma art (the table NOWT ships)
 *  - `/sprays`           spray names + art
 *  - `/flex`             flex emote names + art
 *
 * The flex table is the one most implementations forget: `AESSelections`
 * carries sprays AND flexes, and the two have different image paths.
 */
export async function loadWeaponCatalog(): Promise<WeaponCatalog> {
  if (memCatalog) return memCatalog;
  try {
    const raw = localStorage.getItem(CATALOG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const age = Date.now() - (parsed?.savedAt ?? 0);
      // Content patches land every few weeks; a day of staleness is harmless.
      if (parsed?.data?.weapons && age < 24 * 60 * 60 * 1000) {
        memCatalog = parsed.data as WeaponCatalog;
        return memCatalog;
      }
    }
  } catch {}

  const get = async (path: string) => {
    try {
      const r = await fetch(`${API}${path}`);
      const j = await r.json();
      return (j?.data ?? []) as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    } catch {
      return [] as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    }
  };

  const [weaponsRaw, chromasRaw, spraysRaw, flexRaw, buddiesRaw] = await Promise.all([
    get('/weapons'),
    get('/weapons/skinchromas'),
    get('/sprays'),
    get('/flex'),
    get('/buddies'),
  ]);

  const weapons: Record<string, WeaponInfo> = {};
  const skinIndex: WeaponCatalog['skinIndex'] = {};
  const chromaNames: Record<string, string> = {};
  const levelIndex: Record<string, number> = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const w of weaponsRaw as any[]) {
    if (!w?.uuid) continue;
    const uuid = String(w.uuid).toLowerCase();
    const weaponName = String(w.displayName ?? '');

    // Default weapon skin: find the default skin entry and its canonical 3D matte-black fullRender
    const defUuid = str(w.defaultSkinUuid).toLowerCase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defSkin = (w.skins ?? []).find((s: any) => str(s.uuid).toLowerCase() === defUuid)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      || (w.skins ?? []).find((s: any) => isDefaultSkinName(str(s.displayName), weaponName))
      || w.skins?.[0];
    const defChroma = defSkin?.chromas?.[0];
    const canonical3dRender = str(
      defChroma?.fullRender || defChroma?.displayIcon || defSkin?.displayIcon || w.displayIcon
    );

    weapons[uuid] = {
      uuid,
      name: weaponName,
      category: String(w.category ?? ''),
      icon: canonical3dRender,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const s of (w.skins ?? []) as any[]) {
      if (!s?.uuid) continue;
      const skinName = String(s.displayName ?? w.displayName ?? '');
      const def = isDefaultSkinName(skinName, weaponName);
      // For default skins: ALWAYS use the 3D textured matte-black fullRender (never the X placeholder!)
      const skinIcon = def
        ? canonical3dRender
        : String(s.displayIcon ?? s.chromas?.[0]?.displayIcon ?? '') || canonical3dRender;
      const entry = { weaponUuid: uuid, name: skinName, icon: skinIcon, isDefault: def };
      skinIndex[String(s.uuid).toLowerCase()] = entry;
      // Chromas inherit the parent skin's identity and art; their positions
      // and raw labels are recorded separately for variant display.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const c of [...(s.chromas ?? [])] as any[]) {
        if (!c?.uuid) continue;
        const cu = String(c.uuid).toLowerCase();
        skinIndex[cu] = skinIndex[cu] ?? entry;
        const cname = String(c.displayName ?? '');
        if (cname) chromaNames[cu] = cname;
      }
      // Levels inherit the parent entry; their 1-based position is the "Lv N" tag.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (let li = 0; li < (s.levels ?? []).length; li++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lv = (s.levels as any[])[li];
        if (!lv?.uuid) continue;
        const lu = String(lv.uuid).toLowerCase();
        skinIndex[lu] = skinIndex[lu] ?? entry;
        levelIndex[lu] = li + 1;
      }
    }
  }

  // `/weapons/skinchromas` is authoritative for chroma art and covers chromas
  // that `/weapons` omits. Art only — never names: chroma displayNames are
  // raw internal labels ("Neptune Odin Level 3 / (Variant 1 Black)", sometimes
  // just the weapon name) and must not replace the parent skin name.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of chromasRaw as any[]) {
    if (!c?.uuid) continue;
    const cu = String(c.uuid).toLowerCase();
    const name = String(c.displayName ?? '');
    const icon = String(c.displayIcon ?? '');
    if (name && !chromaNames[cu]) chromaNames[cu] = name;
    if (!icon) continue;
    const existing = skinIndex[cu];
    if (existing) {
      // NEVER overwrite a default skin with an X placeholder icon from skinchromas!
      if (!existing.isDefault) {
        skinIndex[cu] = { ...existing, icon };
      }
    } else {
      const def = isDefaultSkinName(name);
      skinIndex[cu] = { weaponUuid: '', name, icon: def ? '' : icon, isDefault: def };
    }
  }

  const toCosmetic = (kind: Cosmetic['kind']) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (list: any[]): Record<string, Cosmetic> => {
      const out: Record<string, Cosmetic> = {};
      for (const it of list) {
        if (!it?.uuid) continue;
        const artPath = kind === 'spray' ? 'sprays' : kind === 'buddy' ? 'buddies' : 'flex';
        out[String(it.uuid).toLowerCase()] = {
          name: String(it.displayName ?? ''),
          icon: String(it.displayIcon ?? '') || mediaUrl(artPath, it.uuid),
          kind,
        };
      }
      return out;
    };

  const catalog: WeaponCatalog = {
    weapons,
    skinIndex,
    sprays: toCosmetic('spray')(spraysRaw),
    flex: toCosmetic('flex')(flexRaw),
    buddies: toCosmetic('buddy')(buddiesRaw),
    chromaNames,
    levelIndex,
  };

  memCatalog = catalog;
  try {
    localStorage.setItem(CATALOG_KEY, JSON.stringify({ savedAt: Date.now(), data: catalog }));
  } catch {}
  return catalog;
}

/** Case-insensitive field read that tolerates Riot's PascalCase drift. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pick = (obj: any, ...names: string[]): string => {
  for (const n of names) {
    const v = obj?.[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
};

/**
 * Parse one loadout into the shape the viewer renders.
 *
 * `entry` may be the core-game shape (`{ CharacterID, Loadout }`) or the
 * pregame shape (the loadout object itself) — pregame entries are not nested
 * under a `Loadout` key, and mixing them up yields an empty viewer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseLoadoutEntry(entry: any, catalog: WeaponCatalog): PlayerLoadout {
  const characterId = pick(entry, 'CharacterID', 'CharacterId', 'characterId');
  const data = entry?.Loadout ?? entry?.loadout ?? entry ?? {};
  const subject = pick(data, 'Subject', 'subject') || pick(entry, 'Subject', 'subject');
  const items = data?.Items ?? data?.items ?? entry?.Items ?? {};
  const weapons: EquippedWeapon[] = [];
  const expressions: EquippedExpression[] = [];

  for (const key of Object.keys(items ?? {})) {
    const keyLc = String(key).toLowerCase();
    // `Items` is keyed by weapon UUID; fall back to treating the key as a skin
    // id only if it is not a weapon.
    let weapon = catalog.weapons[keyLc];
    if (!weapon) {
      const viaSkin = catalog.skinIndex[keyLc];
      if (viaSkin?.weaponUuid) weapon = catalog.weapons[viaSkin.weaponUuid];
    }
    if (!weapon) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slot = (items as any)[key] ?? {};
    // Explicit socket reads (keys lowercased — Riot's casing drifted before).
    // The old "first socket wins" fallback is gone: it could grab the buddy
    // socket and paint a buddy uuid as the equipped skin.
    const bySocket: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const [sk, sv] of Object.entries(slot?.Sockets ?? slot?.sockets ?? {})) {
      bySocket[String(sk).toLowerCase()] = sv;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sockItemId = (s: any): string =>
      str(s?.Item?.ID ?? s?.Item?.Id ?? s?.item?.id ?? s?.Item?.itemId).toLowerCase();
    const chromaUuid = sockItemId(bySocket[SKIN_SOCKET]);
    const skinUuid = sockItemId(bySocket[SKIN_ID_SOCKET]);
    const levelUuid = sockItemId(bySocket[SKIN_LEVEL_SOCKET]);
    const buddyUuid = sockItemId(bySocket[BUDDY_SOCKET]);

    const skinHit = skinUuid ? catalog.skinIndex[skinUuid] : undefined;
    const chromaHit = chromaUuid ? catalog.skinIndex[chromaUuid] : undefined;
    // Name: the PARENT skin first. Chroma displayNames are raw internal labels
    // ("Neptune Odin Level 3 / (Variant 1 Black)", sometimes just "Ghost")
    // and must never stand in for the skin name.
    let skinName = weapon.name;
    let isDefault = true;
    if (skinHit && !skinHit.isDefault) {
      skinName = skinHit.name;
      isDefault = false;
    } else if (
      chromaHit &&
      !chromaHit.isDefault &&
      !isBareWeaponName(chromaHit.name, weapon.name)
    ) {
      skinName = chromaHit.name;
      isDefault = false;
    }
    // Art: the equipped variant render when known, else the skin render,
    // else the canonical weapon render (never the grey-X placeholder).
    const icon =
      chromaHit && !chromaHit.isDefault && chromaHit.icon
        ? chromaHit.icon
        : skinHit && !skinHit.isDefault && skinHit.icon
          ? skinHit.icon
          : weapon.icon;
    const skinId = chromaUuid || skinUuid;
    const variantLabel = variantLabelOf(catalog.chromaNames[chromaUuid] ?? '');
    const level = levelUuid ? catalog.levelIndex[levelUuid] ?? 0 : 0;
    const buddy = buddyUuid ? catalog.buddies[buddyUuid] : undefined;

    weapons.push({
      weaponUuid: weapon.uuid,
      weaponName: weapon.name,
      category: weapon.category,
      skinId,
      skinName,
      icon,
      isDefaultSkin: isDefault,
      variantLabel,
      level,
      buddyName: buddy?.name ?? '',
      buddyIcon: buddy?.icon ?? '',
    });
  }

  weapons.sort(
    (a, b) => orderOf(a.weaponName) - orderOf(b.weaponName) || a.weaponName.localeCompare(b.weaponName)
  );

  // Expressions carry sprays AND flexes under one array — resolve AssetID
  // against the sprays table first, then the flex table, so each gets its own
  // (different) image path.
  const aes =
    data?.Expressions?.AESSelections ??
    data?.expressions?.aesSelections ??
    data?.Expressions?.AesSelections ??
    [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const a of (Array.isArray(aes) ? aes : []) as any[]) {
    // AssetID only: TypeID identifies the expression SLOT, not the equipped
    // asset — resolving it paints the wrong icon with a confident label.
    const assetId = pick(a, 'AssetID', 'AssetId');
    if (!assetId) continue;
    const aid = assetId.toLowerCase();
    const spray = catalog.sprays[aid];
    const flex = catalog.flex[aid];
    if (spray) expressions.push({ assetId, ...spray });
    else if (flex) expressions.push({ assetId, ...flex });
    else {
      // Unknown cosmetic: no invented image URL (it 404s into a broken wheel
      // icon). Empty art renders the wheel's neutral empty-slot dot.
      expressions.push({ assetId, kind: 'spray', name: '', icon: '' });
    }
  }

  return { subject, characterId, weapons, expressions };
}

/** Parse the whole `{ Loadouts: [...] }` payload. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseLoadouts(raw: any, catalog: WeaponCatalog): PlayerLoadout[] {
  const list = raw?.Loadouts ?? raw?.loadouts ?? raw;
  if (!Array.isArray(list)) return [];
  return list.map((e) => parseLoadoutEntry(e, catalog));
}

/**
 * Pick the loadout belonging to a lobby player.
 *
 * Precedence, strongest first:
 *   1. `Subject` (PUUID) — exact, immune to ordering changes.
 *   2. `CharacterID` — fine in Competitive/Unrated where agents are unique, but
 *      Deathmatch and Swiftplay can field duplicates.
 *   3. Array position — the payload array is parallel to the match's player
 *      list, which is how the working C# client correlates them.
 *
 * `ambiguous` is set when a weaker key matched several entries, so the caller
 * can disclose that instead of silently showing a stranger's weapons.
 */
export function resolveLoadoutForPlayer(
  all: PlayerLoadout[],
  opts: { puuid?: string; characterId?: string; index?: number }
): { loadout: PlayerLoadout | null; ambiguous: boolean } {
  const puuid = str(opts.puuid).toLowerCase();
  if (puuid) {
    // Exact-key miss is terminal: falling through to agent or positional
    // matching here can return a DIFFERENT player's loadout with
    // ambiguous:false (unique-agent case). Weaker keys apply only when no
    // puuid was supplied at all.
    const hit = all.find((l) => l.subject.toLowerCase() === puuid);
    return hit ? { loadout: hit, ambiguous: false } : { loadout: null, ambiguous: false };
  }

  const cid = str(opts.characterId).toLowerCase();
  if (cid) {
    const hits = all.filter((l) => l.characterId.toLowerCase() === cid);
    if (hits.length === 1) return { loadout: hits[0], ambiguous: false };
    if (hits.length > 1) return { loadout: hits[0], ambiguous: true };
  }

  if (typeof opts.index === 'number' && all[opts.index]) {
    return { loadout: all[opts.index], ambiguous: false };
  }
  return { loadout: null, ambiguous: false };
}

/** Group a player's weapons for the column layout. */
export function groupByCategory(weapons: EquippedWeapon[]): Record<string, EquippedWeapon[]> {
  const out: Record<string, EquippedWeapon[]> = {};
  for (const w of weapons) {
    (out[w.category] ??= []).push(w);
  }
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => orderOf(a.weaponName) - orderOf(b.weaponName));
  }
  return out;
}
