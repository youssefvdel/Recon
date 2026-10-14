/* Synthetic check: equipped Goldwing Judge chroma must resolve to the
 * chroma's fullRender (variant photo), never the base skin or default art.
 * Run: bun scripts/loadout-goldwing-check.ts (repo root). */
import { parseLoadoutEntry, type WeaponCatalog } from '../src/utils/loadout';

const JUDGE = 'ec845bf4-4f79-ddda-a3da-0db3774b2794';
const GOLDWING_SKIN = '37735cf0-4c4f-6efd-6222-8582622d68a0';
const GOLDWING_CHROMA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FULL = 'https://media.valorant-api.com/weaponskinchromas/xxx/fullrender.png';
const SKIN_ICON = 'https://media.valorant-api.com/weaponskins/37735cf0/displayicon.png';

const catalog = {
  weapons: {
    [JUDGE]: { uuid: JUDGE, name: 'Judge', category: 'EEquippableCategory::Shotgun', icon: 'weapon.png' },
  },
  skinIndex: {
    [GOLDWING_SKIN]: { weaponUuid: JUDGE, name: 'Goldwing Judge', icon: SKIN_ICON, fullRender: '', isDefault: false },
    [GOLDWING_CHROMA]: { weaponUuid: JUDGE, name: 'Goldwing Judge', icon: '', fullRender: FULL, isDefault: false },
  },
  sprays: {},
  flex: {},
  buddies: {},
  chromaNames: {},
  levelIndex: {},
} as unknown as WeaponCatalog;

// Payload shape: Items keyed by weapon UUID, equipped chroma in SKIN_SOCKET.
const entry = {
  Subject: 'puuid-here',
  CharacterID: 'agent-id',
  Loadout: {
    Subject: 'puuid-here',
    Items: {
      [JUDGE]: {
        Sockets: {
          '3ad1b2b2-acdb-4524-852f-954a76ddae0a': { Item: { ID: GOLDWING_CHROMA } },
          'bcef87d6-209b-46c6-8b19-fbe40bd95abc': { Item: { ID: GOLDWING_SKIN } },
        },
      },
    },
  },
};

const parsed = parseLoadoutEntry(entry, catalog);
const w = parsed.weapons.find((x) => x.weaponUuid === JUDGE);
if (!w) {
  console.error('FAIL: judge missing from parsed weapons');
  process.exit(1);
}
let fail = 0;
const check = (label: string, cond: boolean, got: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond ? '' : ` (got ${JSON.stringify(got)})`}`);
  if (!cond) fail += 1;
};
check('skin name resolves', w.skinName === 'Goldwing Judge', w.skinName);
check('not default', w.isDefaultSkin === false, w.isDefaultSkin);
check('icon is the variant fullRender', w.icon === FULL, w.icon);
process.exit(fail ? 1 : 0);
