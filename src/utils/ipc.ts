import { invoke } from '@tauri-apps/api/core';
import { isDevTabHeld } from './devTools';
import type { DisplayInfo, ShortcutBinding, GpuInfo, GpuSettingsReport, WindowInfo, ConfigFileInfo, QuickShortcut, MonitorDevice, UpdateInfo } from '../types';
import { APP_VERSION } from './version';

export const isTauri = () => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

// Mock fallbacks for preview mode
const mockDisplayInfo: DisplayInfo = {
  current_width: 2560,
  current_height: 1440,
  current_hz: 260,
  native_width: 2560,
  native_height: 1440,
  supported_refresh_rates: [260, 240, 165, 144, 120, 60],
  active_profile: 'native',
  device_name: '\\\\.\\DISPLAY1',
};

const mockShortcut: ShortcutBinding = {
  ctrl: true,
  shift: false,
  alt: false,
  win: false,
  vk: 0x73, // F4
};

const mockGpuInfo: GpuInfo = {
  vendor: 'Nvidia',
  name: 'NVIDIA GeForce RTX 3080',
  instructions: [
    "Set Scaling mode to: 'Full-screen'.",
    "Set 'Perform scaling on:' to: 'GPU'.",
    "Check 'Override the scaling mode set by games and programs'.",
    "Bypass DWM desktop letterbox buffers.",
    "Enable DirectFlip ultra-low latency hardware scanout.",
  ],
};

const mockGpuSettings: GpuSettingsReport = {
  vendor: 'Nvidia',
  name: 'NVIDIA GeForce RTX 3080',
  settings: [
    {
      id: 'full_screen_scaling',
      name: 'Full-Screen Hardware Scaling (0 Black Bars)',
      description: 'Forces RTX hardware display pipe to stretch custom 1.45:1 resolutions to panel borders with zero black bars.',
      enabled: true,
      verified: false,
      detail: 'Sample value — this is the offline mock, not your machine.',
      badge: 'Win32 CCD • Full-Screen',
    },
    {
      id: 'gpu_scaling_engine',
      name: 'Perform Scaling on: GPU',
      description: 'Offloads image expansion to RTX hardware scanout pipeline instead of monitor display scalar.',
      enabled: true,
      verified: false,
      detail: 'Sample value — this is the offline mock, not your machine.',
      badge: 'NVIDIA Hardware Scaler',
    },
    {
      id: 'override_game_scaling',
      name: 'Override Scaling Mode Set by Games & Programs',
      description: 'Forces driver-level stretched scanout over in-game letterbox enforcement (sets bShouldLetterbox=False).',
      enabled: true,
      verified: false,
      detail: 'Sample value — this is the offline mock, not your machine.',
      badge: 'Driver Scanout Priority',
    },
    {
      id: 'low_latency_scanout',
      name: 'Ultra-Low Latency Direct Scanout Engine',
      description: 'Bypasses DWM windowed presentation buffer, enabling 0.0 ms DirectFlip scanout with zero delay.',
      enabled: true,
      verified: false,
      detail: 'Sample value — this is the offline mock, not your machine.',
      badge: 'DirectFlip Scanout',
    },
    {
      id: 'integer_scaling_bypass',
      name: 'Bypass Integer Scaling Aspect Lock',
      description: 'Prevents fixed-pixel integer scaling clamps, allowing arbitrary golden-ratio custom resolutions.',
      enabled: true,
      verified: false,
      detail: 'Sample value — this is the offline mock, not your machine.',
      badge: 'Uncapped Aspect Ratio',
    },
  ],
};

const mockWindows: WindowInfo[] = [
  { hwnd: 12345, title: 'VALORANT  ' },
  { hwnd: 23456, title: 'Counter-Strike 2' },
  { hwnd: 34567, title: 'Discord' },
  { hwnd: 45678, title: 'Google Chrome' },
];

const mockConfigs: ConfigFileInfo[] = [
  {
    path: 'C:\\Users\\Administrator\\AppData\\Local\\VALORANT\\Saved\\Config\\WindowsClient\\GameUserSettings.ini',
    display_name: 'Global Default Settings (WindowsClient)',
    is_read_only: false,
    fullscreen_mode: 2,
    should_letterbox: false,
    res_x: 2088,
    res_y: 1440,
  },
];

const mockShortcuts: QuickShortcut[] = [
  {
    id: 'valorant',
    name: 'VALORANT',
    window_match: 'VALORANT',
    icon: 'valorant',
    is_removable: false,
  },
  {
    id: 'cs2',
    name: 'Counter-Strike 2',
    window_match: 'Counter-Strike 2',
    icon: 'crosshair',
    is_removable: true,
  },
];

export async function fetchDisplayInfo(): Promise<DisplayInfo> {
  if (!isTauri()) return mockDisplayInfo;
  return await invoke<DisplayInfo>('get_display_info');
}

export async function applyResolution(width: number, height: number, hz: number): Promise<void> {
  if (!isTauri()) {
    mockDisplayInfo.current_width = width;
    mockDisplayInfo.current_height = height;
    mockDisplayInfo.current_hz = hz;
    mockDisplayInfo.active_profile = width === mockDisplayInfo.native_width ? 'native' : 'stretched';
    return;
  }
  try {
    await invoke('apply_resolution', { width, height, hz });
  } catch (e) {
    throw new Error(friendlyApplyResolutionError(width, height, hz, e));
  }
}

export async function toggleProfile(): Promise<DisplayInfo> {
  if (!isTauri()) {
    if (mockDisplayInfo.active_profile === 'native') {
      mockDisplayInfo.current_width = 2088;
      mockDisplayInfo.current_height = 1440;
      mockDisplayInfo.active_profile = 'stretched';
    } else {
      mockDisplayInfo.current_width = 2560;
      mockDisplayInfo.current_height = 1440;
      mockDisplayInfo.active_profile = 'native';
    }
    return { ...mockDisplayInfo };
  }
  try {
    return await invoke<DisplayInfo>('toggle_profile');
  } catch (e) {
    // toggle_profile resolves its target internally; use 0x0 placeholder when
    // the backend message already names the mode, else keep generic Hz.
    throw new Error(friendlyToggleProfileError(e));
  }
}

export async function fetchShortcut(): Promise<ShortcutBinding> {
  if (!isTauri()) return mockShortcut;
  return await invoke<ShortcutBinding>('get_shortcut_binding');
}

export async function saveShortcut(binding: ShortcutBinding): Promise<void> {
  if (!isTauri()) {
    Object.assign(mockShortcut, binding);
    return;
  }
  await invoke('save_shortcut_binding', { binding });
}

export async function fetchGpuInfo(): Promise<GpuInfo> {
  if (!isTauri()) return mockGpuInfo;
  return await invoke<GpuInfo>('get_gpu_info');
}

export async function fetchGpuSettings(): Promise<GpuSettingsReport> {
  if (!isTauri()) return mockGpuSettings;
  return await invoke<GpuSettingsReport>('get_gpu_settings');
}

export async function setGpuSetting(id: string, value: boolean): Promise<GpuSettingsReport> {
  if (!isTauri()) {
    const s = mockGpuSettings.settings.find((item) => item.id === id);
    if (s) s.enabled = value;
    return { ...mockGpuSettings };
  }
  return await invoke<GpuSettingsReport>('set_gpu_setting', { id, value });
}

export async function openGpuControlPanel(vendor: string): Promise<void> {
  if (!isTauri()) {
    alert(`Launched GPU Control Panel for ${vendor}`);
    return;
  }
  await invoke('open_gpu_panel', { vendor });
}

export async function autoConfigureGpuScaling(): Promise<string> {
  if (!isTauri()) {
    return 'Applied Full-Screen GPU hardware scaling and configured driver registry profiles!';
  }
  return await invoke<string>('auto_configure_gpu_scaling');
}

export async function fetchWindows(): Promise<WindowInfo[]> {
  if (!isTauri()) return mockWindows;
  return await invoke<WindowInfo[]>('get_windows');
}

export async function setAutoBorderless(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_auto_borderless', { enabled });
}

export async function getAutoBorderless(): Promise<boolean> {
  if (!isTauri()) return false;
  return await invoke<boolean>('get_auto_borderless');
}

export async function makeWindowBorderless(hwnd: number): Promise<string> {
  if (!isTauri()) return `Window ${hwnd} set to borderless (2560x1440)`;
  return await invoke<string>('make_window_borderless', { hwnd });
}

export async function restoreWindow(hwnd: number): Promise<string> {
  if (!isTauri()) return `Window ${hwnd} restored to windowed frame`;
  return await invoke<string>('restore_window_framed', { hwnd });
}

export async function showOverlay(): Promise<void> {
  if (!isTauri()) return;
  await invoke('show_overlay');
}

export async function hideOverlay(): Promise<void> {
  if (!isTauri()) return;
  await invoke('hide_overlay');
}

export async function setOverlayClickthrough(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_overlay_clickthrough', { enabled });
}

export async function setOverlayEditMode(inEditMode: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_overlay_edit_mode', { inEditMode });
}

export async function getOverlayEditMode(): Promise<boolean> {
  if (!isTauri()) return false;
  return await invoke<boolean>('get_overlay_edit_mode');
}

export async function isOverlayVisible(): Promise<boolean> {
  if (!isTauri()) return false;
  return await invoke<boolean>('is_overlay_visible');
}

export async function isTabDown(): Promise<boolean> {
  if (isDevTabHeld()) return true;
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>('is_tab_down');
  } catch {
    return false;
  }
}

export async function setOverlayWindowed(windowed: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_overlay_windowed', { windowed });
}

export async function openDevWindow(): Promise<void> {
  if (!isTauri()) return;
  await invoke('open_dev_window');
}

export async function appMinimize(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('window_minimize');
  } catch {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().minimize();
  }
}

/** Lock the window's minimum size to its current size — it can never be
 *  resized smaller than this. Main window only; no-op in overlay/dev. */
export async function lockMinSizeToCurrent(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (win.label !== 'main') return;
    const size = await win.outerSize();
    await win.setMinSize(size);
  } catch {}
}

export async function appToggleMaximize(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('window_toggle_maximize');
  } catch {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().toggleMaximize();
  }
}

export async function appClose(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('window_close');
  } catch {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  }
}

export async function appStartDragging(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('window_start_dragging');
  } catch {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().startDragging();
  }
}

export async function appIsMaximized(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>('window_is_maximized');
  } catch {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return await getCurrentWindow().isMaximized();
  }
}

/**
 * Enables smooth window dragging across the entire application surface,
 * skipping any interactive controls (buttons, links, inputs, selects, tabs, etc.).
 */
export function setupGlobalWindowDrag(): () => void {
  if (!isTauri()) return () => {};

  const handleMouseDown = (e: MouseEvent) => {
    // Only primary left button
    if (e.button !== 0) return;

    // Do not initiate drag on double-click
    if (e.detail > 1) return;

    let target = e.target as HTMLElement | null;
    if (!target) return;

    // Traverse ancestors to check for any interactive elements
    while (target && target !== document.body && target !== document.documentElement) {
      const tag = target.tagName.toUpperCase();
      if (['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'LABEL'].includes(tag)) {
        return;
      }

      if (
        target.hasAttribute('data-no-drag') ||
        target.classList.contains('no-drag') ||
        target.getAttribute('role') === 'button' ||
        target.getAttribute('role') === 'tab' ||
        target.getAttribute('role') === 'checkbox' ||
        target.getAttribute('role') === 'switch' ||
        target.getAttribute('role') === 'slider' ||
        target.isContentEditable
      ) {
        return;
      }

      // Check if clicking on vertical scrollbar gutter
      if (target.scrollHeight > target.clientHeight && target.clientHeight > 0) {
        const rect = target.getBoundingClientRect();
        if (e.clientX >= rect.left + target.clientWidth) {
          return;
        }
      }

      // If element has pointer or text cursor, treat as interactive
      const style = window.getComputedStyle(target);
      if (style.cursor === 'pointer' || style.cursor === 'text') {
        return;
      }

      target = target.parentElement;
    }

    // Surface is non-interactive: drag the window
    appStartDragging().catch(() => {});
  };

  window.addEventListener('mousedown', handleMouseDown);
  return () => {
    window.removeEventListener('mousedown', handleMouseDown);
  };
}

export async function fetchValorantConfigs(): Promise<ConfigFileInfo[]> {
  if (!isTauri()) return mockConfigs;
  return await invoke<ConfigFileInfo[]>('get_valorant_configs');
}

export async function updateValorantConfig(
  path: string,
  setWindowed: boolean,
  res?: [number, number],
  lockReadonly: boolean = false
): Promise<void> {
  if (!isTauri()) {
    const cfg = mockConfigs.find(c => c.path === path);
    if (cfg) {
      if (setWindowed) {
        cfg.fullscreen_mode = 2;
        cfg.should_letterbox = false;
      }
      if (res) {
        cfg.res_x = res[0];
        cfg.res_y = res[1];
      }
      cfg.is_read_only = lockReadonly;
    }
    return;
  }
  await invoke('update_valorant_config', {
    path,
    setWindowed,
    res: res ?? null,
    lockReadonly,
  });
}

export async function updateValorantConfigCustom(
  path: string,
  options: import('../types').ValorantCustomOptions
): Promise<void> {
  if (!isTauri()) {
    const cfg = mockConfigs.find((c) => c.path === path);
    if (cfg) {
      if (options.fullscreen_mode !== undefined && options.fullscreen_mode !== null) {
        cfg.fullscreen_mode = options.fullscreen_mode;
      }
      if (options.letterbox !== undefined && options.letterbox !== null) {
        cfg.should_letterbox = options.letterbox;
      }
      if (options.res) {
        cfg.res_x = options.res[0];
        cfg.res_y = options.res[1];
      }
      if (options.desired) {
        cfg.desired_w = options.desired[0];
        cfg.desired_h = options.desired[1];
      }
      cfg.is_read_only = options.lock_readonly;
    }
    return;
  }
  // Tauri snake_case mapping: lock_readonly / fullscreen_mode / letterbox / res / desired
  await invoke('update_valorant_config_custom', {
    path,
    options: {
      fullscreen_mode: options.fullscreen_mode ?? null,
      letterbox: options.letterbox ?? null,
      res: options.res ?? null,
      desired: options.desired ?? null,
      lock_readonly: options.lock_readonly,
    },
  });
}

export async function verifyValorantConfigs(
  width: number,
  height: number
): Promise<import('../types').ValorantVerifyResult[]> {
  if (!isTauri()) {
    return mockConfigs.map((c) => {
      const matches =
        c.res_x === width && c.res_y === height && c.fullscreen_mode === 2 && c.should_letterbox === false;
      return {
        path: c.path,
        display_name: c.display_name,
        matches,
        details: matches
          ? `Verified: FullscreenMode=2, bShouldLetterbox=False, ${width}x${height} in file`
          : `Mismatch: file has FullscreenMode=${c.fullscreen_mode}, Letterbox=${c.should_letterbox}, Res=${c.res_x}x${c.res_y} (want ${width}x${height})`,
      };
    });
  }
  return await invoke<import('../types').ValorantVerifyResult[]>('verify_valorant_configs', {
    width,
    height,
  });
}

export async function applyCustomResVerbose(
  width: number,
  height: number,
  lockReadonly: boolean
): Promise<import('../types').ValorantApplyResult[]> {
  if (!isTauri()) {
    mockConfigs.forEach((c) => {
      c.fullscreen_mode = 2;
      c.should_letterbox = false;
      c.res_x = width;
      c.res_y = height;
      c.is_read_only = lockReadonly;
    });
    return mockConfigs.map((c) => ({
      path: c.path,
      display_name: c.display_name,
      ok: true,
      verified: true,
      message: `${width}x${height} verified in file`,
    }));
  }
  return await invoke<import('../types').ValorantApplyResult[]>('apply_custom_res_verbose', {
    width,
    height,
    lockReadonly,
  });
}

export async function getValorantConfigRaw(path: string): Promise<string> {
  if (!isTauri()) return '[ShooterGameUserSettings]\nFullscreenMode=2\nbShouldLetterbox=False\nResolutionSizeX=2088\nResolutionSizeY=1440\n';
  return await invoke<string>('get_valorant_config_raw', { path });
}

export async function getValorantConfigSections(
  path: string
): Promise<import('../types').ValorantSection[]> {
  if (!isTauri()) {
    return [
      {
        name: '[/Script/ShooterGame.ShooterGameUserSettings]',
        rows: [
          { key: 'FullscreenMode', value: '2' },
          { key: 'bShouldLetterbox', value: 'False' },
          { key: 'ResolutionSizeX', value: '2088' },
          { key: 'ResolutionSizeY', value: '1440' },
          { key: 'FrameRateLimit', value: '0.000000' },
          { key: 'bUseVSync', value: 'False' },
        ],
      },
      {
        name: '[ScalabilityGroups]',
        rows: [
          { key: 'sg.ShadowQuality', value: '0' },
          { key: 'sg.TextureQuality', value: '0' },
        ],
      },
    ];
  }
  return await invoke<import('../types').ValorantSection[]>('get_valorant_config_sections', { path });
}

export async function setValorantConfigValue(
  path: string,
  section: string,
  key: string,
  value: string,
  lockReadonly: boolean
): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_valorant_config_value', { path, section, key, value, lockReadonly });
}

export async function fetchQuickShortcuts(): Promise<QuickShortcut[]> {
  if (!isTauri()) return mockShortcuts;
  return await invoke<QuickShortcut[]>('get_quick_shortcuts');
}

let mockPreferredStretched: [number, number] = [2088, 1440];

export async function fetchPreferredStretchedRes(): Promise<[number, number]> {
  if (!isTauri()) return mockPreferredStretched;
  return await invoke<[number, number]>('get_preferred_stretched_res');
}

export async function savePreferredStretchedRes(width: number, height: number): Promise<[number, number]> {
  if (!isTauri()) {
    mockPreferredStretched = [width, height];
    return mockPreferredStretched;
  }
  return await invoke<[number, number]>('set_preferred_stretched_res', { width, height });
}

export async function applyCustomResToAllConfigs(
  width: number,
  height: number,
  lockReadonly: boolean
): Promise<string> {
  if (!isTauri()) {
    mockConfigs.forEach(c => {
      c.fullscreen_mode = 2;
      c.should_letterbox = false;
      c.res_x = width;
      c.res_y = height;
      c.is_read_only = lockReadonly;
    });
    return `Successfully applied ${width}×${height} and bypassed letterbox across ${mockConfigs.length} game config(s)!`;
  }
  return await invoke<string>('apply_custom_res_to_all_configs', {
    width,
    height,
    lockReadonly,
  });
}

export async function checkRequestedTab(): Promise<string | null> {
  if (!isTauri()) return null;
  return await invoke<string | null>('check_requested_tab');
}

export function vkToName(vk: number): string {
  if (vk >= 0x70 && vk <= 0x87) return `F${vk - 0x70 + 1}`;
  if (vk >= 0x41 && vk <= 0x5A) return String.fromCharCode(vk);
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  if (vk >= 0x60 && vk <= 0x69) return `Num ${vk - 0x60}`;
  
  switch (vk) {
    case 0x2D: return 'Insert';
    case 0x2E: return 'Delete';
    case 0x24: return 'Home';
    case 0x23: return 'End';
    case 0x21: return 'Page Up';
    case 0x22: return 'Page Down';
    case 0x20: return 'Space';
    case 0x09: return 'Tab';
    case 0x0D: return 'Enter';
    case 0x1B: return 'Esc';
    case 0x14: return 'Caps';
    case 0x2C: return 'PrintScreen';
    case 0x90: return 'NumLock';
    case 0xC0: return '`';
    case 0xBA: return ';';
    case 0xBB: return '=';
    case 0xBC: return ',';
    case 0xBD: return '-';
    case 0xBE: return '.';
    case 0xBF: return '/';
    case 0xDB: return '[';
    case 0xDC: return '\\';
    case 0xDD: return ']';
    case 0xDE: return "'";
    case 0x04: return 'Mouse 3';
    case 0x05: return 'Mouse 4';
    case 0x06: return 'Mouse 5';
    default: return `Key 0x${vk.toString(16).toUpperCase()}`;
  }
}

export function formatShortcut(binding: ShortcutBinding): string {
  if (!binding.vk) return 'Unbound';
  const parts: string[] = [];
  if (binding.ctrl) parts.push('CTRL');
  if (binding.alt) parts.push('ALT');
  if (binding.shift) parts.push('SHIFT');
  if (binding.win) parts.push('WIN');
  parts.push(vkToName(binding.vk));
  return parts.join(' + ');
}

export const trimMemory = async (): Promise<void> => {
  if (!isTauri()) return;
  try {
    await invoke('trim_memory');
  } catch (_) {}
};

let mockMonitors: MonitorDevice[] = [
  {
    device_name: '\\\\.\\DISPLAY1',
    adapter_name: 'NVIDIA GeForce RTX 3080',
    monitor_name: 'Secondary Portrait Monitor',
    is_attached: true,
    is_primary: false,
    width: 1080,
    height: 1920,
    refresh_rate: 60,
    position_x: -1080,
    position_y: -477,
    orientation: 'Portrait (90°)',
    device_id: 'MONITOR\\PHLC401\\MOCK1\\0001',
    is_device_disabled: false,
  },
  {
    device_name: '\\\\.\\DISPLAY2',
    adapter_name: 'NVIDIA GeForce RTX 3080',
    monitor_name: 'Philips 27" 260Hz Gaming Display',
    is_attached: true,
    is_primary: true,
    width: 2560,
    height: 1440,
    refresh_rate: 260,
    position_x: 0,
    position_y: 0,
    orientation: 'Landscape',
    device_id: 'MONITOR\\PHLC402\\MOCK2\\0002',
    is_device_disabled: false,
  },
  {
    device_name: '\\\\.\\DISPLAY3',
    adapter_name: 'NVIDIA GeForce RTX 3080',
    monitor_name: 'Auxiliary Overhead Monitor',
    is_attached: true,
    is_primary: false,
    width: 1920,
    height: 1080,
    refresh_rate: 60,
    position_x: 0,
    position_y: -1080,
    orientation: 'Landscape',
    device_id: 'MONITOR\\PHLC403\\MOCK3\\0003',
    is_device_disabled: false,
  },
];

export async function fetchAllMonitors(): Promise<MonitorDevice[]> {
  if (!isTauri()) return mockMonitors;
  return await invoke<MonitorDevice[]>('get_all_monitors');
}

export async function fetchOverlayMonitor(): Promise<string> {
  if (!isTauri()) return localStorage.getItem('recon_overlay_monitor') || 'auto';
  try {
    return await invoke<string>('get_overlay_monitor');
  } catch {
    return 'auto';
  }
}

export async function setOverlayMonitor(monitor: string): Promise<string> {
  if (!isTauri()) {
    localStorage.setItem('recon_overlay_monitor', monitor);
    return monitor;
  }
  return await invoke<string>('set_overlay_monitor', { monitor });
}

/**
 * @deprecated Kept for backend compat only. The Display Manager UI no longer
 * uses CCD Attached/Detached — use {@link setMonitorDeviceEnabled} instead.
 * Do not call from new UI code.
 */
export async function setMonitorAttached(
  deviceName: string,
  attached: boolean
): Promise<MonitorDevice[]> {
  if (!isTauri()) {
    mockMonitors = mockMonitors.map((m) =>
      m.device_name === deviceName ? { ...m, is_attached: attached } : m
    );
    return mockMonitors;
  }
  return await invoke<MonitorDevice[]>('set_monitor_attached', {
    deviceName,
    attached,
  });
}

/**
 * True Device Manager disable/enable (SetupDi, admin). This is the ONLY
 * supported path in the Display Manager UI.
 * Always pass the PnP instance path (`device_id`, `MONITOR\...`) when
 * available, falling back to `\\.\DISPLAYx` only if `device_id` is empty.
 * Tauri camelCase: `{ monitorId, enabled }` maps to backend
 * `set_monitor_device_enabled(monitor_id, enabled)`.
 */
export async function setMonitorDeviceEnabled(
  monitorId: string,
  enabled: boolean
): Promise<MonitorDevice[]> {
  if (!isTauri()) {
    mockMonitors = mockMonitors.map((m) =>
      m.device_name === monitorId || m.device_id === monitorId
        ? { ...m, is_device_disabled: !enabled, is_attached: enabled ? m.is_attached : false }
        : m
    );
    return mockMonitors;
  }
  return await invoke<MonitorDevice[]>('set_monitor_device_enabled', {
    monitorId,
    enabled,
  });
}

export async function setMonitorPrimary(
  deviceName: string
): Promise<MonitorDevice[]> {
  if (!isTauri()) {
    mockMonitors = mockMonitors.map((m) => ({
      ...m,
      is_primary: m.device_name === deviceName,
    }));
    return mockMonitors;
  }
  return await invoke<MonitorDevice[]>('set_monitor_primary', { deviceName });
}
export async function restartGraphicsDriver(): Promise<string> {
  if (!isTauri()) {
    return 'Mock: Graphics driver restarted successfully!';
  }
  return await invoke<string>('restart_graphics_driver');
}

export async function resetAllEdidOverrides(): Promise<string> {
  if (!isTauri()) {
    return 'Mock: All EDID overrides reset successfully!';
  }
  return await invoke<string>('reset_all_edid_overrides');
}

/** Back-compat alias for resetAllEdidOverrides */
export const resetAllCruOverrides = resetAllEdidOverrides;

export interface CustomModeTest {
  exists: boolean;
  code: number;
}

export interface DisplayMode {
  width: number;
  height: number;
  refresh_rate: number;
}

export function cdsCodeToText(code: number): string {
  switch (code) {
    case 0: return 'SUCCESSFUL';
    case 1: return 'RESTART_REQUIRED';
    case -1: return 'FAILED';
    case -2: return 'BADMODE (mode not in driver list — Add it first)';
    case -3: return 'NOTUPDATED';
    case -4: return 'BADFLAGS';
    case -5: return 'BADPARAM';
    case -6: return 'BADDUALVIEW';
    default: return `UNKNOWN (${code})`;
  }
}

/** Raw invoke rejection -> plain string (Tauri rejects with the backend Err String). */
export function extractInvokeMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in (e as Record<string, unknown>)) {
    return String((e as Record<string, unknown>).message);
  }
  return String(e);
}

/** True for driver-missing-mode failures: BADMODE text, -2 code, or friendly preflight text. */
export function isBadModeErrorMessage(msg: string): boolean {
  if (!msg) return false;
  const upper = msg.toUpperCase();
  if (upper.includes('BADMODE')) return true;
  if (msg.includes('not in driver list')) return true;
  // Standalone -2 (avoid matching 2090x1440 widths): non-digit boundaries.
  if (/(^|[^0-9])-2([^0-9]|$)/.test(msg)) return true;
  return false;
}

/**
 * Maps a raw apply_resolution failure to a friendly actionable message.
 * Preserves the backend friendly message verbatim when it already contains
 * the Custom Res Add guidance; otherwise enriches a bare BADMODE/-2 with
 * cdsCodeToText + Add steps so the toast never shows a cryptic code alone.
 */
export function friendlyApplyResolutionError(
  width: number,
  height: number,
  hz: number,
  raw: unknown
): string {
  const msg = extractInvokeMessage(raw);
  // Backend (display.rs preflight) already friendly — preserve it.
  if (/Custom Res.*Add Mode/i.test(msg) && msg.includes(`${width}x${height}`)) {
    return msg;
  }
  if (msg.includes('not in driver list')) {
    return msg;
  }
  if (isBadModeErrorMessage(msg)) {
    // Try to surface the symbolic name for any embedded numeric code.
    const codeMatch = msg.match(/-?\d+/g)?.map(Number).find((n) => n <= 1 && n >= -6);
    const symbol = codeMatch !== undefined ? cdsCodeToText(codeMatch) : cdsCodeToText(-2);
    return (
      `Mode ${width}x${height}@${hz}Hz not in driver list (BADMODE -2, ${symbol}). ` +
      `Go to Custom Res & Test > Add Mode ${width}x${height}@${hz}Hz as admin ` +
      `(EDID override + driver restart), then Test. [driver said: ${msg}]`
    );
  }
  // Non-BADMODE numeric codes: append symbolic text so they are never cryptic.
  const numMatch = msg.match(/(-?\d+)/);
  if (numMatch) {
    const code = Number(numMatch[1]);
    if (Number.isInteger(code) && code <= 1 && code >= -6) {
      return `${msg} (${cdsCodeToText(code)})`;
    }
  }
  return msg;
}

/** toggle_profile targets are resolved backend-side; keep its BADMODE mapping generic. */
export function friendlyToggleProfileError(raw: unknown): string {
  const msg = extractInvokeMessage(raw);
  if (/Custom Res.*Add Mode/i.test(msg) || msg.includes('not in driver list')) {
    return msg;
  }
  if (isBadModeErrorMessage(msg)) {
    return (
      `${msg} Go to Custom Res & Test > Add the stretched mode as admin ` +
      `(EDID override + driver restart), then Test.`
    );
  }
  return msg;
}

export async function testCustomMode(width: number, height: number, hz: number): Promise<CustomModeTest> {
  if (!isTauri()) {
    const exists = mockDisplayInfo.current_width === width && mockDisplayInfo.current_height === height && mockDisplayInfo.current_hz === hz;
    return { exists, code: exists ? 0 : -2 };
  }
  return await invoke<CustomModeTest>('test_custom_mode', { width, height, hz });
}

export async function addCustomResolution(monitorId: string, width: number, height: number, hz: number): Promise<string> {
  if (!isTauri()) {
    return `Mock: Added ${width}×${height} @ ${hz}Hz on ${monitorId} (EDID override + driver restart).`;
  }
  return await invoke<string>('add_custom_resolution', { monitorId, width, height, hz });
}

export async function removeCustomOverride(monitorId: string): Promise<string> {
  if (!isTauri()) {
    return `Mock: Removed EDID override on ${monitorId}.`;
  }
  return await invoke<string>('remove_custom_override', { monitorId });
}

export async function listSupportedModes(): Promise<DisplayMode[]> {
  if (!isTauri()) return [];
  return await invoke<DisplayMode[]>('list_supported_modes');
}

export async function checkAppUpdates(): Promise<UpdateInfo> {
  if (!isTauri()) {
    // Dev-browser fallback only — version comes from package.json at build
    // time, never hardcoded (bump script keeps it = Cargo.toml).
    return {
      has_update: false,
      current_version: APP_VERSION,
      latest_version: APP_VERSION,
      release_title: `Recon v${APP_VERSION}`,
      release_notes: 'Running latest dev build.',
      published_at: new Date().toISOString(),
      html_url: 'https://github.com/youssefvdel/Recon',
      download_url: null,
    };
  }
  return await invoke<UpdateInfo>('check_app_updates');
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, '_blank');
    return;
  }
  await invoke('open_external_url', { url });
}

export async function installAppUpdate(downloadUrl: string): Promise<string> {
  if (!isTauri()) {
    window.open(downloadUrl, '_blank');
    return 'Browser download initiated';
  }
  return await invoke<string>('install_app_update', { downloadUrl });
}

export async function getAutostartEnabled(): Promise<boolean> {
  if (!isTauri()) {
    return localStorage.getItem('aspect_autostart') === 'true';
  }
  try {
    return await invoke<boolean>('get_autostart_enabled');
  } catch {
    return false;
  }
}

export async function setAutostartEnabled(enabled: boolean): Promise<boolean> {
  if (!isTauri()) {
    localStorage.setItem('aspect_autostart', enabled ? 'true' : 'false');
    return enabled;
  }
  try {
    return await invoke<boolean>('set_autostart_enabled', { enabled });
  } catch {
    return false;
  }
}


