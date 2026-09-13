import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeftRight,
  Check,
  RefreshCw,
  Copy,
  Keyboard,
  Layout,
  CheckCircle2,
  ChevronDown,
  Calculator,
} from 'lucide-react';
import type { DisplayInfo, ShortcutBinding, WindowInfo } from '../types';
import { listen } from '@tauri-apps/api/event';
import { logger } from '../utils/logger';
import {
  formatShortcut,
  vkToName,
  fetchWindows,
  makeWindowBorderless,
  restoreWindow,
  isTauri,
  getAutoBorderless,
  setAutoBorderless as setAutoBorderlessIpc,
} from '../utils/ipc';

interface UnifiedStretchProps {
  displayInfo: DisplayInfo | null;
  shortcut: ShortcutBinding | null;
  preferredStretched?: [number, number];
  onToggle: () => Promise<void>;
  onApplyResolution: (w: number, h: number, hz: number) => Promise<void>;
  onSaveShortcut: (binding: ShortcutBinding) => Promise<void>;
  isLoading: boolean;
}

const PRESET_HOTKEYS: { label: string; binding: ShortcutBinding }[] = [
  { label: 'Ctrl + F4 (Default)', binding: { ctrl: true, shift: false, alt: false, win: false, vk: 0x73 } },
  { label: 'F4', binding: { ctrl: false, shift: false, alt: false, win: false, vk: 0x73 } },
  { label: 'F11', binding: { ctrl: false, shift: false, alt: false, win: false, vk: 0x7a } },
  { label: 'F10', binding: { ctrl: false, shift: false, alt: false, win: false, vk: 0x79 } },
  { label: 'F9', binding: { ctrl: false, shift: false, alt: false, win: false, vk: 0x78 } },
  { label: 'F12', binding: { ctrl: false, shift: false, alt: false, win: false, vk: 0x7b } },
  { label: 'F8', binding: { ctrl: false, shift: false, alt: false, win: false, vk: 0x77 } },
];

const QUICK_GAMES = ['VALORANT', 'Counter-Strike 2', 'Aimlabs'];

export const UnifiedStretch: React.FC<UnifiedStretchProps> = ({
  displayInfo,
  shortcut,
  preferredStretched,
  onToggle,
  onSaveShortcut,
  isLoading,
}) => {
  // ---- Resolution switch state ----
  const [showHotkeyModal, setShowHotkeyModal] = useState(false);
  const [customKeyVk, setCustomKeyVk] = useState<number | null>(null);
  const [ctrlMod, setCtrlMod] = useState(false);
  const [shiftMod, setShiftMod] = useState(false);
  const [altMod, setAltMod] = useState(false);
  const [winMod, setWinMod] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  // ---- Borderless state ----
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [selectedHwnd, setSelectedHwnd] = useState<number | null>(null);
  const [blStatus, setBlStatus] = useState<string | null>(null);
  const [blLoading, setBlLoading] = useState(false);
  // ---- Auto-borderless opt-in toggle (default: false / manual control) ----
  const [autoBorderless, setAutoBorderless] = useState<boolean>(() => {
    try {
      return localStorage.getItem('aspect_auto_borderless') === 'true';
    } catch {
      return false;
    }
  });
  const [autoBlState, setAutoBlState] = useState<'idle' | 'waiting' | 'done'>('idle');
  const autoBlHwnd = useRef<number | null>(null);

  useEffect(() => {
    getAutoBorderless().then((enabled) => {
      setAutoBorderless(enabled);
    }).catch(() => {});
  }, []);

  const handleToggleAutoBorderless = (enabled: boolean) => {
    setAutoBorderless(enabled);
    try {
      localStorage.setItem('aspect_auto_borderless', String(enabled));
    } catch {}
    setAutoBorderlessIpc(enabled).catch(() => {});
  };

  // ---- Custom Dropdown state ----
  const [isWindowDropdownOpen, setIsWindowDropdownOpen] = useState(false);
  const windowDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (windowDropdownRef.current && !windowDropdownRef.current.contains(event.target as Node)) {
        setIsWindowDropdownOpen(false);
      }
    };
    if (isWindowDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isWindowDropdownOpen]);

  const isNative = displayInfo ? displayInfo.current_width === displayInfo.native_width : true;
  const nativeW = displayInfo?.native_width || 2560;
  const nativeH = displayInfo?.native_height || 1440;
  const stretchedW = preferredStretched
    ? preferredStretched[0]
    : Math.round((Math.round(nativeH * 1.45) + 4) / 8) * 8;
  const stretchedH = preferredStretched ? preferredStretched[1] : nativeH;
  const currentHz = displayInfo?.current_hz || 260;

  const ratio = stretchedW / stretchedH;
  let ratioTitle = 'True Stretch';
  let ratioBadge = `${ratio.toFixed(2)}:1`;
  if (Math.abs(ratio - 1.451) < 0.03) {
    ratioTitle = 'True Stretch 1.45:1';
    ratioBadge = '1.45:1';
  } else if (Math.abs(ratio - 4 / 3) < 0.03) {
    ratioTitle = '4:3 Classic';
    ratioBadge = '4:3';
  } else if (Math.abs(ratio - 16 / 10) < 0.03) {
    ratioTitle = '16:10 Balanced';
    ratioBadge = '16:10';
  } else if (Math.abs(ratio - 5 / 4) < 0.03) {
    ratioTitle = '5:4 Ultra Wide';
    ratioBadge = '5:4';
  } else {
    ratioTitle = `Custom ${stretchedW}x${stretchedH}`;
    ratioBadge = `${ratio.toFixed(2)}:1`;
  }
  const expansionPct = Math.max(0, Math.round(((16 / 9) / ratio - 1) * 100));
  // Model widening factor (how much wider player models appear when GPU stretches to panel).
  // Inverse of panel-fill scale: native 2560 / stretched 2090 = 1.225x for 1.45:1.
  const modelWiden = (16 / 9) / ratio;

  const isRealGame = (w: WindowInfo): boolean => {
    if (w.is_game) return true;
    const t = w.title.toLowerCase().trim();
    // Exclude third-party companion apps, overlays, launchers, and trackers:
    if (
      t.includes('tracker') ||
      t.includes('overwolf') ||
      t.includes('blitz') ||
      t.includes('riot client') ||
      t.includes('aspect') ||
      t.includes('discord')
    ) {
      return false;
    }
    return (
      t === 'valorant' ||
      t.startsWith('valorant') ||
      t.includes('counter-strike') ||
      t.includes('cs2') ||
      t.includes('aimlabs')
    );
  };

  const loadWindows = async () => {
    setBlLoading(true);
    try {
      const list = await fetchWindows();
      setWindows(list);
      if (list.length > 0) {
        // Auto-select true game window; NEVER select tracker/overlays
        const game = list.find((w) => isRealGame(w));
        if (game) {
          setSelectedHwnd(game.hwnd);
        } else if (!selectedHwnd) {
          setSelectedHwnd(list[0].hwnd);
        }
      }
    } catch (e) {
      if (import.meta.env.DEV) logger.error(e);
    } finally {
      setBlLoading(false);
    }
  };

  useEffect(() => {
    loadWindows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for background auto-borderless events from Rust daemon
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      listen<{ hwnd: number; title: string; message: string }>('auto-borderless-applied', (event) => {
        setSelectedHwnd(event.payload.hwnd);
        setBlStatus(event.payload.message);
        setAutoBlState('done');
        autoBlHwnd.current = event.payload.hwnd;
      }).then((fn) => {
        unlisten = fn;
      });
    }
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // While stretched: fallback poll for the real Valorant window ONLY if auto-borderless is explicitly enabled
  useEffect(() => {
    if (isNative || !autoBorderless) {
      autoBlHwnd.current = null;
      setAutoBlState('idle');
      return;
    }
    setAutoBlState('waiting');
    let stopped = false;
    const tick = async () => {
      if (stopped || autoBlHwnd.current || !autoBorderless) return;
      try {
        const list = await fetchWindows();
        if (stopped || !autoBorderless) return;
        setWindows(list);
        // Strict filter: real game only, never Tracker
        const game = list.find((w) => isRealGame(w));
        if (game) {
          const msg = await makeWindowBorderless(game.hwnd);
          if (stopped || !autoBorderless) return;
          autoBlHwnd.current = game.hwnd;
          setSelectedHwnd(game.hwnd);
          setBlStatus(msg);
          setAutoBlState('done');
        }
      } catch (e) {
        if (import.meta.env.DEV) logger.error('auto-borderless poll', e);
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNative, autoBorderless]);

  const handleApplyBorderless = async () => {
    if (!selectedHwnd) return;
    setBlLoading(true);
    try {
      setBlStatus(await makeWindowBorderless(selectedHwnd));
    } catch (e) {
      setBlStatus(String(e));
    } finally {
      setBlLoading(false);
    }
  };

  const handleRestoreFramed = async () => {
    if (!selectedHwnd) return;
    setBlLoading(true);
    try {
      setBlStatus(await restoreWindow(selectedHwnd));
    } catch (e) {
      setBlStatus(String(e));
    } finally {
      setBlLoading(false);
    }
  };

  const handleKeyDownRecord = (e: React.KeyboardEvent) => {
    if (!isRecording) return;
    e.preventDefault();
    setCtrlMod(e.ctrlKey);
    setShiftMod(e.shiftKey);
    setAltMod(e.altKey);
    setWinMod(e.metaKey);
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
      setCustomKeyVk(e.keyCode);
      setIsRecording(false);
    }
  };

  const selectedWindow = windows.find((w) => w.hwnd === selectedHwnd) ?? null;

  // ---- Sensitivity calculator (reference only — never touches game sens) ----
  // Empty on first boot (placeholders hint at format); every keystroke
  // persists, stretch sens always derives from native.
  const loadSensInput = (key: string): string => {
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null && saved.trim() !== '' && !isNaN(parseFloat(saved)) && parseFloat(saved) > 0) {
        return saved;
      }
    } catch {}
    return '';
  };
  const [dpiInput, setDpiInput] = useState(() => loadSensInput('aspect_sens_dpi'));
  const [nativeSensInput, setNativeSensInput] = useState(() => loadSensInput('aspect_sens_native'));
  const stretchK = nativeW / stretchedW;
  const fmtSens = (n: number): string => (n >= 10 ? n.toFixed(2) : n.toFixed(3));
  const [stretchSensInput, setStretchSensInput] = useState(() => {
    const n = parseFloat(loadSensInput('aspect_sens_native'));
    return n > 0 ? fmtSens(n / stretchK) : '';
  });
  const [copiedStretch, setCopiedStretch] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('aspect_sens_dpi', dpiInput);
    } catch {}
  }, [dpiInput]);
  useEffect(() => {
    try {
      localStorage.setItem('aspect_sens_native', nativeSensInput);
    } catch {}
  }, [nativeSensInput]);

  useEffect(() => {
    if (nativeSensInput) {
      const n = parseFloat(nativeSensInput);
      if (!isNaN(n) && n > 0) {
        setStretchSensInput(fmtSens(n / stretchK));
      }
    }
  }, [stretchK]);

  const handleNativeSensChange = (v: string) => {
    setNativeSensInput(v);
    const n = parseFloat(v);
    setStretchSensInput(v.trim() !== '' && !isNaN(n) && n > 0 ? fmtSens(n / stretchK) : '');
  };

  const handleStretchSensChange = (v: string) => {
    setStretchSensInput(v);
    const s = parseFloat(v);
    setNativeSensInput(v.trim() !== '' && !isNaN(s) && s > 0 ? fmtSens(s * stretchK) : '');
  };

  const handleCopyStretch = async () => {
    if (!stretchSensInput) return;
    try {
      await navigator.clipboard.writeText(stretchSensInput);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = stretchSensInput;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedStretch(true);
    setTimeout(() => setCopiedStretch(false), 1200);
  };

  const dpiNum = parseInt(dpiInput, 10);
  const nativeSensNum = parseFloat(nativeSensInput);
  const edpiNative =
    dpiInput.trim() !== '' &&
    !isNaN(dpiNum) &&
    dpiNum > 0 &&
    nativeSensInput.trim() !== '' &&
    !isNaN(nativeSensNum) &&
    nativeSensNum > 0
      ? Math.round(dpiNum * nativeSensNum)
      : null;

  const resCard = (
    active: boolean,
    title: string,
    badge: React.ReactNode,
    value: string,
    rows: [string, React.ReactNode][],
    action: React.ReactNode,
  ) => (
    <section
      className={`min-h-0 rounded-xl p-2.5 border flex flex-col transition-colors ${
        active
          ? 'bg-m3-surface-container-high border-m3-primary'
          : 'bg-m3-surface-container/60 border-m3-outline-subtle'
      }`}
    >
      <div className="flex items-start justify-between gap-2 min-h-0">
        <div className="min-w-0">
          <h3 className="font-display font-bold text-[13px] text-m3-on-surface leading-tight truncate">{title}</h3>
        </div>
        <div className="shrink-0">{badge}</div>
      </div>
      <div className="mt-1 font-display font-extrabold text-xl text-m3-on-surface tabular-nums tracking-tight leading-none truncate">
        {value}
      </div>
      <dl className="mt-1.5 border-t border-b border-m3-outline-subtle/70 py-1 space-y-0.5 text-[11px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2">
            <dt className="text-m3-on-surface-variant truncate">{k}</dt>
            <dd className="font-mono tabular-nums font-semibold text-m3-secondary truncate">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-auto pt-1.5">{action}</div>
    </section>
  );

  const activePill = (
    <span className="px-2 py-0.5 text-[9px] font-bold rounded-full bg-m3-tertiary text-m3-on-tertiary tracking-wide">
      ACTIVE
    </span>
  );
  const idlePill = (label: string) => (
    <span className="px-2 py-0.5 text-[9px] font-medium text-m3-outline rounded-full bg-m3-surface-container-high border border-m3-outline-subtle truncate max-w-[110px]">
      {label}
    </span>
  );

  const standbyBar = (
    <div className="w-full h-8 px-3 rounded-full text-[11px] font-semibold flex items-center justify-center bg-m3-surface-container-high/50 border border-m3-outline-subtle text-m3-outline select-none">
      <span>Standby</span>
    </div>
  );

  const activeBar = (
    <div className="w-full h-8 px-3 rounded-full text-[11px] font-semibold flex items-center justify-center space-x-1.5 bg-m3-primary-container text-m3-on-primary-container border border-m3-primary/30 select-none">
      <Check className="w-3 h-3 text-m3-primary shrink-0" />
      <span>Active on Monitor</span>
    </div>
  );

  return (
    <div className="h-full min-h-0 overflow-hidden [@media(max-height:720px)]:overflow-y-auto flex flex-col gap-2.5">
      {/* HERO: the single switch action on this page */}
      <section className="rounded-xl bg-m3-surface-container border border-m3-primary/30 p-3 flex items-center gap-3 shrink-0 shadow-m3-1">
        <div
          className={`w-11 h-11 rounded-2xl border flex items-center justify-center shrink-0 ${
            !isNative
              ? 'bg-m3-primary-container border-m3-primary/40 text-m3-primary'
              : 'bg-m3-surface-container-high border-m3-outline-subtle text-m3-outline'
          }`}
        >
          <ArrowLeftRight className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${!isNative ? 'bg-m3-tertiary' : 'bg-m3-primary'}`}
            />
            <span className="text-[11px] font-semibold text-m3-on-surface-variant truncate">
              {isNative ? 'Native 16:9 on monitor' : `${ratioBadge} stretched on monitor`}
            </span>
            {!isNative && activePill}
          </div>
          <div className="font-display font-extrabold text-2xl text-m3-on-surface tabular-nums tracking-tight leading-tight truncate">
            {isNative ? `${nativeW} × ${nativeH}` : `${stretchedW} × ${stretchedH}`}
          </div>
          <div className="text-[11px] text-m3-outline truncate">
            {currentHz} Hz • {isNative ? '1:1 pixels' : `${modelWiden.toFixed(3)}× wider models`}
          </div>
        </div>
        <div className="flex flex-col items-stretch gap-1.5 shrink-0">
          <button
            onClick={() => onToggle()}
            disabled={isLoading}
            className="h-11 px-5 rounded-xl bg-m3-primary hover:bg-m3-primary/90 text-m3-on-primary text-sm font-bold flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-50 cursor-pointer whitespace-nowrap shadow-m3-1"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            <span>{isLoading ? 'Switching…' : isNative ? 'Press to Stretch' : 'Press for Native'}</span>
          </button>
          <button
            onClick={() => setShowHotkeyModal(true)}
            title="Change the global hotkey"
            className="h-7 px-3 rounded-full border border-m3-primary/50 bg-m3-primary-container/40 hover:bg-m3-primary-container/70 text-m3-primary text-[10px] font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap"
          >
            <Keyboard className="w-3.5 h-3.5" />
            <span>{shortcut ? formatShortcut(shortcut) : 'CTRL + F4'} to toggle • change</span>
          </button>
        </div>
      </section>

      {/* MIDDLE: Native vs Stretched spec cards — display only, click inactive card to apply */}
      <div className="grid grid-cols-2 gap-2.5 shrink-0">
        {resCard(
          isNative,
          'Native Desktop',
          isNative ? activePill : idlePill('16:9 Baseline'),
          `${nativeW} × ${nativeH}`,
          [
            ['Refresh', <span key="hz">{currentHz} Hz</span>],
            ['Scaling', <span key="sc">1.00× (1:1)</span>],
          ],
          isNative ? activeBar : standbyBar,
        )}
        {resCard(
          !isNative,
          ratioTitle,
          !isNative ? (
            <span key="a" className="flex items-center gap-1">
              <span className="px-1.5 py-0.5 text-[9px] font-mono font-bold rounded-full bg-m3-tertiary text-m3-on-tertiary">
                +{expansionPct}%
              </span>
              {activePill}
            </span>
          ) : (
            <span key="i" className="flex items-center gap-1">
              <span className="px-1.5 py-0.5 text-[9px] font-mono font-bold rounded-full bg-m3-surface-container-high border border-m3-outline-subtle text-m3-secondary">
                +{expansionPct}%
              </span>
              {idlePill(ratioBadge)}
            </span>
          ),
          `${stretchedW} × ${stretchedH}`,
          [
            ['Refresh', <span key="hz2">{currentHz} Hz</span>],
            ['Models', <span key="ws">{modelWiden.toFixed(3)}× wider</span>],
          ],
          !isNative
            ? activeBar
            : standbyBar,
        )}
      </div>

      {/* SENSITIVITY CALCULATOR — reference only, never changes your game sens */}
      <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-2.5 shrink-0">
        <div className="flex items-center gap-1.5 px-1 pb-2">
          <Calculator className="w-3.5 h-3.5 text-m3-primary shrink-0" />
          <span className="text-[11px] font-bold text-m3-on-surface">Sensitivity Calculator</span>
          <span className="text-[10px] text-m3-outline">— reference only, type the result into Valorant yourself</span>
        </div>
        <div className="grid grid-cols-4 gap-2.5">
          {/* 1: DPI */}
          <div className="rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle/80 p-2 flex flex-col items-center gap-1.5 transition-colors">
            <span className="text-xs font-bold text-m3-on-surface">DPI</span>
            <div className="w-full h-9 rounded-lg bg-m3-surface-container-lowest border border-m3-outline-subtle/70 hover:border-m3-outline focus-within:border-m3-primary focus-within:ring-2 focus-within:ring-m3-primary/30 transition-all flex items-center justify-center shadow-inner">
              <input
                type="text"
                inputMode="numeric"
                value={dpiInput}
                onChange={(e) => setDpiInput(e.target.value)}
                placeholder="1600"
                className="w-full h-full bg-transparent text-center font-mono font-bold text-base text-m3-on-surface focus:outline-none tabular-nums placeholder:text-m3-outline/40"
              />
            </div>
          </div>

          {/* 2: Native sens */}
          <div className="rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle/80 p-2 flex flex-col items-center gap-1.5 transition-colors">
            <span className="text-xs font-bold text-m3-on-surface">Native sens</span>
            <div className="w-full h-9 rounded-lg bg-m3-surface-container-lowest border border-m3-outline-subtle/70 hover:border-m3-outline focus-within:border-m3-primary focus-within:ring-2 focus-within:ring-m3-primary/30 transition-all flex items-center justify-center shadow-inner">
              <input
                type="text"
                inputMode="decimal"
                value={nativeSensInput}
                onChange={(e) => handleNativeSensChange(e.target.value)}
                placeholder="0.333"
                className="w-full h-full bg-transparent text-center font-mono font-bold text-base text-m3-on-surface focus:outline-none tabular-nums placeholder:text-m3-outline/40"
              />
            </div>
          </div>

          {/* 3: Stretch sens */}
          <div className="rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle/80 p-2 flex flex-col items-center gap-1.5 transition-colors relative group">
            <span className="text-xs font-bold text-m3-on-surface">Stretch sens</span>
            <div className="relative w-full h-9 rounded-lg bg-m3-surface-container-lowest border border-m3-outline-subtle/70 hover:border-m3-outline focus-within:border-m3-primary focus-within:ring-2 focus-within:ring-m3-primary/30 transition-all flex items-center justify-center shadow-inner">
              <input
                type="text"
                inputMode="decimal"
                value={stretchSensInput}
                onChange={(e) => handleStretchSensChange(e.target.value)}
                placeholder="0.272"
                className="w-full h-full bg-transparent text-center font-mono font-bold text-base text-m3-on-surface focus:outline-none tabular-nums px-6 placeholder:text-m3-outline/40"
              />
              <button
                type="button"
                onClick={handleCopyStretch}
                disabled={!stretchSensInput}
                title="Copy stretch sensitivity"
                className="absolute right-1.5 w-6 h-6 rounded flex items-center justify-center text-m3-outline hover:text-m3-primary hover:bg-m3-surface-container-high transition-colors disabled:opacity-0 cursor-pointer"
              >
                {copiedStretch ? (
                  <Check className="w-3.5 h-3.5 text-m3-primary" />
                ) : (
                  <Copy className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100" />
                )}
              </button>
            </div>
          </div>

          {/* 4: eDPI */}
          <div className="rounded-xl bg-m3-surface-container-high/60 border border-m3-primary/50 p-2 flex flex-col items-center gap-1.5 transition-colors shadow-sm">
            <span className="text-xs font-bold text-m3-primary">eDPI</span>
            <div className="w-full h-9 rounded-lg bg-m3-surface-container-lowest border border-m3-primary/30 flex items-center justify-center shadow-inner">
              <span className="font-mono font-bold text-base text-m3-primary tabular-nums">
                {edpiNative ?? '—'}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* BOTTOM: borderless full-width, horizontal inner grid */}
      <section className="rounded-xl bg-m3-surface-container border border-m3-outline-subtle p-2.5 flex flex-col gap-2 shrink-0">
        <div className="flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-m3-primary-container border border-m3-primary/30 flex items-center justify-center text-m3-primary shrink-0">
              <Layout className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-display font-bold text-[13px] text-m3-on-surface leading-tight truncate">
                Borderless Valorant
              </h2>
            </div>
          </div>
          <div className="flex items-center gap-2.5 shrink-0 flex-wrap">
            <button
              type="button"
              role="switch"
              aria-checked={autoBorderless}
              onClick={() => handleToggleAutoBorderless(!autoBorderless)}
              className="flex items-center gap-2 text-[10px] text-m3-on-surface cursor-pointer select-none bg-m3-surface-container-high hover:bg-m3-surface-container-highest px-2.5 py-1 rounded-full border border-m3-outline-subtle transition-colors"
            >
              <div
                className={`w-6 h-3.5 flex items-center rounded-full p-0.5 transition-colors shrink-0 ${
                  autoBorderless ? 'bg-m3-primary' : 'bg-m3-surface-container-lowest border border-m3-outline-subtle'
                }`}
              >
                <div
                  className={`w-2.5 h-2.5 rounded-full bg-white shadow-sm transition-transform ${
                    autoBorderless ? 'translate-x-2.5' : 'translate-x-0'
                  }`}
                />
              </div>
              <span className="font-semibold text-m3-on-surface">Auto-borderless</span>
            </button>
            <span className="text-[9px] text-m3-primary font-mono tabular-nums px-1.5 py-0.5 rounded-full bg-m3-surface-container-high border border-m3-outline-subtle">
              {windows.length} found
            </span>
            <button
              onClick={loadWindows}
              disabled={blLoading}
              className="h-7 px-2.5 rounded-full bg-m3-surface-container-high hover:bg-m3-surface-container-highest border border-m3-outline-subtle text-[10px] font-semibold flex items-center gap-1 cursor-pointer shrink-0"
            >
              <RefreshCw className={`w-3 h-3 text-m3-primary ${blLoading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-12 gap-2.5 items-start">
          {/* Left: target window */}
          <div className="col-span-5 min-w-0" ref={windowDropdownRef}>
            <label className="text-[10px] font-semibold text-m3-on-surface block mb-1 truncate">Target Window</label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsWindowDropdownOpen((prev) => !prev)}
                className={`w-full h-8 px-2.5 rounded-lg bg-m3-surface-container-lowest border transition-all flex items-center justify-between gap-1.5 text-left cursor-pointer ${
                  isWindowDropdownOpen
                    ? 'border-m3-primary ring-2 ring-m3-primary/30 shadow-sm'
                    : 'border-m3-outline-subtle hover:border-m3-outline'
                }`}
              >
                <span className="text-[11px] font-medium text-m3-on-surface truncate flex-1">
                  {selectedWindow ? (selectedWindow.title.length > 38 ? `${selectedWindow.title.slice(0, 38)}…` : selectedWindow.title) : (windows.length === 0 ? 'No windows detected' : 'Select a window')}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  {selectedWindow && (
                    <span className="text-[9px] font-mono text-m3-outline bg-m3-surface-container-high px-1 py-0.5 rounded">
                      {selectedWindow.hwnd}
                    </span>
                  )}
                  <ChevronDown className={`w-3.5 h-3.5 text-m3-outline transition-transform duration-200 ${isWindowDropdownOpen ? 'rotate-180 text-m3-primary' : ''}`} />
                </div>
              </button>

              <AnimatePresence>
                {isWindowDropdownOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -4, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.98 }}
                    transition={{ duration: 0.12 }}
                    className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-xl bg-m3-surface-container border border-m3-outline-subtle shadow-2xl p-1 custom-scrollbar max-h-56 overflow-y-auto"
                  >
                    {windows.length === 0 ? (
                      <div className="px-3 py-2 text-[11px] text-m3-outline text-center">
                        No windows detected
                      </div>
                    ) : (
                      windows.map((w) => {
                        const isSelected = w.hwnd === selectedHwnd;
                        return (
                          <button
                            key={w.hwnd}
                            type="button"
                            onClick={() => {
                              setSelectedHwnd(w.hwnd);
                              setIsWindowDropdownOpen(false);
                            }}
                            className={`w-full px-2.5 py-1.5 rounded-lg text-left text-[11px] flex items-center justify-between gap-2 transition-colors cursor-pointer group ${
                              isSelected
                                ? 'bg-m3-primary/15 text-m3-primary font-semibold'
                                : 'text-m3-on-surface hover:bg-m3-surface-container-highest'
                            }`}
                          >
                            <span className="truncate flex-1">
                              {w.title}
                            </span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className="text-[9px] font-mono text-m3-outline group-hover:text-m3-on-surface-variant">
                                {w.hwnd}
                              </span>
                              {isSelected && <Check className="w-3 h-3 text-m3-primary shrink-0" />}
                            </div>
                          </button>
                        );
                      })
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <p className="mt-0.5 text-[10px] text-m3-outline truncate">
              {selectedWindow ? `HWND ${selectedWindow.hwnd} • ${selectedWindow.title}` : 'Select a game window'}
            </p>
          </div>

          {/* Middle: quick chips */}
          <div className="col-span-3 min-w-0">
            <label className="text-[10px] font-semibold text-m3-on-surface block mb-1 truncate">Quick Select</label>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_GAMES.map((g) => {
                const found = windows.find((w) => w.title.toLowerCase().includes(g.toLowerCase()));
                const active = found && found.hwnd === selectedHwnd;
                return (
                  <button
                    key={g}
                    onClick={() => found && setSelectedHwnd(found.hwnd)}
                    disabled={!found}
                    className={`h-7 px-2 rounded-full text-[10px] font-semibold border flex items-center gap-1 transition-colors truncate ${
                      active
                        ? 'bg-m3-primary-container border-m3-primary/50 text-m3-on-primary-container'
                        : found
                          ? 'bg-m3-surface-container-high border-m3-outline text-m3-on-surface cursor-pointer'
                          : 'border-m3-outline-subtle text-m3-outline/50 cursor-not-allowed'
                    }`}
                  >
                    <span className="truncate">{g === 'Counter-Strike 2' ? 'CS2' : g}</span>
                    {found && <span className="w-1.5 h-1.5 rounded-full bg-m3-tertiary shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right: actions + status */}
          <div className="col-span-4 min-w-0">
            <label className="text-[10px] font-semibold text-m3-on-surface block mb-1 truncate">Actions</label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                onClick={handleApplyBorderless}
                disabled={!selectedHwnd || blLoading}
                className="h-8 px-2 rounded-full bg-m3-primary hover:bg-m3-primary/90 text-m3-on-primary text-[11px] font-semibold flex items-center justify-center gap-1.5 active:scale-[0.98] disabled:opacity-50 cursor-pointer truncate"
              >
                <Layout className="w-3 h-3 shrink-0" />
                <span className="truncate">Make Borderless</span>
              </button>
              <button
                onClick={handleRestoreFramed}
                disabled={!selectedHwnd || blLoading}
                className="h-8 px-2 rounded-full bg-m3-surface-container-high hover:bg-m3-surface-container-highest text-m3-on-surface text-[11px] font-semibold border border-m3-outline-subtle flex items-center justify-center gap-1.5 active:scale-[0.98] disabled:opacity-50 cursor-pointer truncate"
              >
                <RefreshCw className="w-3 h-3 shrink-0" />
                <span className="truncate">Restore Frame</span>
              </button>
            </div>
            <div className="mt-1.5 min-w-0">
              {blStatus ? (
                <div className="px-2 py-1.5 rounded-lg bg-m3-primary-container/40 border border-m3-primary/40 text-[10px] text-m3-on-primary-container flex items-start gap-1.5">
                  <CheckCircle2 className="w-3 h-3 text-m3-primary shrink-0 mt-0.5" />
                  <span className="truncate leading-snug">{blStatus}</span>
                </div>
              ) : autoBlState === 'waiting' ? (
                <div className="px-2 py-1.5 rounded-lg border border-m3-tertiary/50 bg-m3-tertiary/10 text-[10px] text-m3-on-surface-variant flex items-center gap-1.5 leading-snug">
                  <span className="w-1.5 h-1.5 rounded-full bg-m3-tertiary animate-pulse shrink-0" />
                  <span className="truncate">Stretched — waiting for Valorant, will auto-borderless on launch…</span>
                </div>
              ) : (
                <div className="px-2 py-1.5 rounded-lg border border-m3-outline-subtle text-[10px] text-m3-outline leading-snug truncate">
                  Ready — select window, then Make Borderless.
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Hotkey modal */}
      <AnimatePresence>
        {showHotkeyModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-m3-surface-container-lowest/80 backdrop-blur-md">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-md rounded-2xl bg-m3-surface-container-high border border-m3-outline-subtle p-5 space-y-4"
            >
              <div className="flex items-center justify-between border-b border-m3-outline-subtle pb-2.5">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-m3-primary-container flex items-center justify-center text-m3-primary">
                    <Keyboard className="w-3.5 h-3.5" />
                  </div>
                  <h3 className="font-display font-bold text-sm text-m3-on-surface">Global Hotkey</h3>
                </div>
                <button
                  onClick={() => setShowHotkeyModal(false)}
                  className="w-7 h-7 rounded-full flex items-center justify-center text-m3-outline hover:bg-m3-surface-container-highest text-sm cursor-pointer"
                >
                  ✕
                </button>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {PRESET_HOTKEYS.map((preset) => {
                  const isSelected =
                    shortcut?.vk === preset.binding.vk &&
                    shortcut?.ctrl === preset.binding.ctrl &&
                    shortcut?.shift === preset.binding.shift &&
                    shortcut?.alt === preset.binding.alt;
                  return (
                    <button
                      key={preset.label}
                      onClick={() => {
                        onSaveShortcut(preset.binding);
                        setShowHotkeyModal(false);
                      }}
                      className={`h-8 text-[11px] rounded-full border font-medium cursor-pointer truncate ${
                        isSelected
                          ? 'bg-m3-primary text-m3-on-primary border-m3-primary'
                          : 'bg-m3-surface-container border-m3-outline-subtle text-m3-on-surface'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
              <div className="pt-2 border-t border-m3-outline-subtle">
                <div
                  tabIndex={0}
                  onKeyDown={handleKeyDownRecord}
                  onClick={() => setIsRecording(true)}
                  className={`h-10 rounded-xl border text-center cursor-pointer flex items-center justify-center ${
                    isRecording
                      ? 'border-m3-primary bg-m3-primary-container/30 text-m3-primary'
                      : 'border-m3-outline-subtle text-m3-on-surface'
                  }`}
                >
                  {isRecording ? (
                    <span className="font-mono text-[11px] font-semibold">Press any key…</span>
                  ) : customKeyVk ? (
                    <span className="text-xs font-bold text-m3-primary">
                      {[ctrlMod ? 'CTRL' : null, altMod ? 'ALT' : null, shiftMod ? 'SHIFT' : null, winMod ? 'WIN' : null, vkToName(customKeyVk)]
                        .filter(Boolean)
                        .join(' + ')}
                    </span>
                  ) : (
                    <span className="text-[11px] text-m3-outline">Click to record custom hotkey</span>
                  )}
                </div>
                {customKeyVk && (
                  <button
                    onClick={() => {
                      onSaveShortcut({ ctrl: ctrlMod, shift: shiftMod, alt: altMod, win: winMod, vk: customKeyVk });
                      setShowHotkeyModal(false);
                    }}
                    className="mt-2 w-full h-8 rounded-full bg-m3-primary text-m3-on-primary text-[11px] font-semibold cursor-pointer"
                  >
                    Save Hotkey
                  </button>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
