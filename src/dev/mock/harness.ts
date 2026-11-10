import { coreGamePayload, fakeEntitlementToken, storageFixture } from '../fixtures/tracker';

/** The Linux dev harness: one mock boundary, at the same place the real app
 *  enters Tauri — `window.__TAURI_INTERNALS__.invoke`.
 *
 *  Nothing in `src/components` knows this exists: the UI calls `invoke(...)`
 *  exactly as it does on Windows, and every command is answered here. If a
 *  surface needed a component change to work headless, that would be the bug —
 *  so there is none.
 *
 *  Only loaded from `main.tsx` behind `import.meta.env.DEV` + `?fixture=`. */

type Fixture = 'lobby' | 'act' | 'empty' | 'error';

const now = Date.now();

/** Commands the shell asks for on boot. Values are plausible, not precious:
 *  the point is that the UI renders, not that the numbers are real. */
const staticAnswers: Record<string, unknown> = {
  detect_local_account: {
    puuid: '11111111-2222-3333-4444-555555555555',
    game_name: 'Youssef',
    tagline: 'EUW',
    region: 'eu',
  },
  accounts_list: [
    { puuid: '11111111-2222-3333-4444-555555555555', game_name: 'Youssef', tagline: 'EUW', current: true },
    { puuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', game_name: 'Smurf', tagline: 'EUW', current: false },
  ],
  account_current: { puuid: '11111111-2222-3333-4444-555555555555', game_name: 'Youssef', tagline: 'EUW' },
  get_display_info: {
    current_width: 2560,
    current_height: 1440,
    current_hz: 260,
    native_width: 2560,
    native_height: 1440,
    supported_refresh_rates: [260, 240, 165, 144, 120, 60],
    active_profile: 'native',
    device_name: '\\\\.\\DISPLAY1',
  },
  get_gpu_info: {
    vendor: 'Nvidia',
    name: 'NVIDIA GeForce RTX 3080',
    instructions: ['Set Scaling mode to: Full-screen.', 'Perform scaling on: GPU.'],
  },
  get_gpu_settings: { vendor: 'Nvidia', settings: [], verified: false, detail: 'Linux harness: not read back' },
  get_shortcut_binding: { ctrl: true, shift: false, alt: false, win: false, vk: 0x73 },
  get_preferred_stretched_res: [1440, 1080],
  get_overlay_edit_mode: false,
  get_start_minimized: false,
  get_autostart_enabled: false,
  get_valorant_configs: [],
  get_windows: [],
  get_all_monitors: [],
  /* Self-presence is where the live parser reads the loop state and the score:
   * the private blob is base64 of the same shape the Rust command returns. */
  local_presences: JSON.stringify({
    presences: [
      {
        puuid: '11111111-2222-3333-4444-555555555555',
        game_name: 'Youssef',
        game_tag: 'EUW',
        private: btoa(
          JSON.stringify({
            matchPresenceData: {
              sessionLoopState: 'INGAME',
              queueId: 'competitive',
              partyOwnerMatchScoreAllyTeam: 6,
              partyOwnerMatchScoreEnemyTeam: 4,
            },
            partyId: 'party-1',
          })
        ),
      },
    ],
  }),
  local_entitlements: {
    access_token: fakeEntitlementToken(),
    entitlements: ['valorant'],
    puuid: '11111111-2222-3333-4444-555555555555',
  },
  local_client_version: 'release-13.09-shipping-12-1234567',
  is_riot_client_running: true,
  check_channel_update: { available: false, version: null },
};

export function installDevHarness(): void {
  const params = new URLSearchParams(window.location.search);
  const fixture = (params.get('fixture') ?? 'lobby') as Fixture;

  /* Seed the caches the app already reads. This exercises the real merge path
   * (snapshot -> details -> act) instead of faking a store. */
  for (const [k, v] of Object.entries(storageFixture(fixture))) {
    try {
      if (v === '') localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* quota: a fixture that cannot be stored is not worth crashing for */
    }
  }
  if (fixture === 'empty') localStorage.clear();

  const invoke = async (cmd: string, args?: unknown): Promise<unknown> => {
    if (fixture === 'error') {
      throw new Error(`[harness] ${cmd} failed: Riot Client is closed`);
    }
    if (cmd in staticAnswers) return staticAnswers[cmd];
    /* The transport is routed by path, because the live parser asks three
     * different endpoints and a blanket answer keeps the phase at idle. */
    if (cmd === 'riot_direct_get') {
      const path = String((args as { path?: string })?.path ?? '');
      if (fixture === 'lobby') {
        if (/^\/core-game\/v1\/players\//.test(path)) return { MatchID: 'live-1' };
        if (/^\/core-game\/v1\/matches\/live-1/.test(path)) return coreGamePayload();
      }
      return { httpStatus: 404, errorCode: 'RESOURCE_NOT_FOUND' };
    }
    if (cmd === 'get_entitlements' || cmd === 'detect_entitlements') {
      throw new Error('Riot client not responding — launch it and retry.');
    }
    // Unknown command: an empty answer is better than a crash, and it is
    // visible in the console so a missing fixture is obvious.
    console.info(`[harness] no fixture for "${cmd}"`);
    return null;
  };

  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
    transformCallback: (cb: unknown) => cb,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  };
  console.info(`[harness] fixture=${fixture} · mocked ${Object.keys(staticAnswers).length} commands · ${now}`);
}
