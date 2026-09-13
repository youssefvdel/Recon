import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Check,
  RefreshCw,
  FileCode2,
  Lock,
  Unlock,
  ShieldCheck,
  Eye,
  Copy,
  Zap,
  TriangleAlert,
  ChevronDown,
  Search,
  Save,
} from 'lucide-react';
import type { ConfigFileInfo, ValorantSection, ValorantVerifyResult } from '../types';
import {
  fetchValorantConfigs,
  fetchPreferredStretchedRes,
  getValorantConfigSections,
  setValorantConfigValue,
  updateValorantConfigCustom,
  verifyValorantConfigs,
  applyCustomResVerbose,
  getValorantConfigRaw,
} from '../utils/ipc';

/* ------------------------------------------------------------------ */
/* Custom dropdown — app's own UI (same pattern as the window picker), */
/* never a native <select>.                                           */
/* ------------------------------------------------------------------ */

interface DropOption {
  value: string;
  label: string;
  hint?: string;
}

export const CustomDropdown: React.FC<{
  value: string;
  options: DropOption[];
  onChange: (v: string) => void;
  disabled?: boolean;
}> = ({ value, options, onChange, disabled }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open ]);

  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((p) => !p)}
        className={`w-full h-8 px-2.5 rounded-lg bg-m3-surface-container-lowest border transition-all flex items-center justify-between gap-1.5 text-left cursor-pointer disabled:opacity-50 ${
          open
            ? 'border-m3-primary ring-2 ring-m3-primary/30 shadow-sm'
            : 'border-m3-outline-subtle hover:border-m3-outline'
        }`}
      >
        <span className="text-[11px] font-semibold text-m3-on-surface truncate flex-1">
          {current?.label ?? value}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-m3-outline transition-transform duration-200 shrink-0 ${
            open ? 'rotate-180 text-m3-primary' : ''
          }`}
        />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-xl bg-m3-surface-container border border-m3-outline-subtle shadow-2xl p-1 max-h-56 overflow-y-auto custom-scrollbar min-w-[200px]"
          >
            {options.map((o) => {
              const selected = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`w-full px-2.5 py-1.5 rounded-lg text-left flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                    selected
                      ? 'bg-m3-primary/15 text-m3-primary font-semibold'
                      : 'text-m3-on-surface hover:bg-m3-surface-container-highest'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block text-[11px] truncate">{o.label}</span>
                    {o.hint && <span className="block text-[10px] text-m3-outline truncate">{o.hint}</span>}
                  </span>
                  {selected && <Check className="w-3 h-3 text-m3-primary shrink-0" />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Friendly catalog — every known key explained.                       */
/* ------------------------------------------------------------------ */

type EditorKind = 'fullscreen' | 'bool' | 'sgQuality' | 'int' | 'float' | 'text';

interface SettingDef {
  title: string;
  desc: string;
  editor: EditorKind;
  boolLabels?: [string, string]; // [false, true]
  auto?: boolean; // game-managed (still editable — user's game)
  group: string;
}

const BOOL_OFF_ON: [string, string] = ['Off', 'On'];

const FULLSCREEN_OPTS: DropOption[] = [
  { value: '0', label: 'Fullscreen', hint: 'Max FPS — game owns the screen' },
  { value: '1', label: 'Windowed Fullscreen', hint: 'Fast alt-tab, slight cost' },
  { value: '2', label: 'Windowed', hint: 'Required for stretched res' },
];

const SG_OPTS: DropOption[] = [
  { value: '0', label: '0 — Low', hint: 'Max FPS' },
  { value: '1', label: '1 — Medium', hint: 'Balanced' },
  { value: '2', label: '2 — High', hint: 'Pretty' },
  { value: '3', label: '3 — Epic', hint: 'Max detail' },
];

const DEFS: Record<string, SettingDef> = {
  FullscreenMode: { title: 'Display Mode', desc: 'Fullscreen = max FPS. Windowed Fullscreen = fast alt-tab. Windowed = required for stretched resolutions.', editor: 'fullscreen', group: 'Display' },
  LastConfirmedFullscreenMode: { title: 'Confirmed Display Mode', desc: 'Last mode the game launched successfully with. The game rewrites this itself.', editor: 'fullscreen', group: 'Display', auto: true },
  PreferredFullscreenMode: { title: 'Preferred Display Mode', desc: 'Mode the game tries first on launch.', editor: 'fullscreen', group: 'Display' },
  bShouldLetterbox: { title: 'Letterbox Black Bars', desc: 'Off stretches the image edge-to-edge (true stretch). On keeps aspect ratio with black bars.', editor: 'bool', boolLabels: ['Off — stretch edge-to-edge', 'On — black bars'], group: 'Display' },
  bLastConfirmedShouldLetterbox: { title: 'Confirmed Letterbox', desc: 'Last letterbox state the game confirmed. The game rewrites this itself.', editor: 'bool', boolLabels: ['Off — stretch edge-to-edge', 'On — black bars'], group: 'Display', auto: true },

  ResolutionSizeX: { title: 'Render Width', desc: 'Game render width in pixels. Narrower width at the same height = wider enemy models when stretched.', editor: 'int', group: 'Resolution' },
  ResolutionSizeY: { title: 'Render Height', desc: 'Game render height in pixels. Usually your monitor native height (e.g. 1440).', editor: 'int', group: 'Resolution' },
  LastUserConfirmedResolutionSizeX: { title: 'Confirmed Render Width', desc: 'Last width you confirmed in the in-game dialog. The game rewrites this itself.', editor: 'int', group: 'Resolution', auto: true },
  LastUserConfirmedResolutionSizeY: { title: 'Confirmed Render Height', desc: 'Last height you confirmed in the in-game dialog.', editor: 'int', group: 'Resolution', auto: true },
  DesiredScreenWidth: { title: 'Requested Display Width', desc: 'Resolution the game requests from the monitor on launch. Keep equal to render width for stretch.', editor: 'int', group: 'Resolution' },
  DesiredScreenHeight: { title: 'Requested Display Height', desc: 'Resolution the game requests from the monitor on launch.', editor: 'int', group: 'Resolution' },
  LastUserConfirmedDesiredScreenWidth: { title: 'Confirmed Display Width', desc: 'Last confirmed requested width. The game rewrites this itself.', editor: 'int', group: 'Resolution', auto: true },
  LastUserConfirmedDesiredScreenHeight: { title: 'Confirmed Display Height', desc: 'Last confirmed requested height.', editor: 'int', group: 'Resolution', auto: true },

  WindowPosX: { title: 'Window Position X', desc: 'Horizontal pixel position of the game window (windowed modes). 0 = left edge.', editor: 'int', group: 'Window & Monitor' },
  WindowPosY: { title: 'Window Position Y', desc: 'Vertical pixel position of the game window. 0 = top edge.', editor: 'int', group: 'Window & Monitor' },
  DefaultMonitorDeviceID: { title: 'Preferred Monitor ID', desc: 'Windows device ID of the display Valorant opens on. Empty = primary monitor.', editor: 'text', group: 'Window & Monitor' },
  DefaultMonitorIndex: { title: 'Preferred Monitor Number', desc: '0 = primary display. Change if Valorant opens on the wrong screen.', editor: 'int', group: 'Window & Monitor' },
  LastConfirmedDefaultMonitorDeviceID: { title: 'Confirmed Monitor ID', desc: 'Last confirmed monitor. The game rewrites this itself.', editor: 'text', group: 'Window & Monitor', auto: true },
  LastConfirmedDefaultMonitorIndex: { title: 'Confirmed Monitor Number', desc: 'Last confirmed monitor index.', editor: 'int', group: 'Window & Monitor', auto: true },

  FrameRateLimit: { title: 'FPS Cap', desc: '0 = unlimited. Cap slightly above your refresh rate for stable frametimes (e.g. 260 on a 240Hz panel).', editor: 'float', group: 'Performance' },
  bUseVSync: { title: 'V-Sync', desc: 'Syncs FPS to monitor refresh. Adds input lag — competitive players keep it off.', editor: 'bool', boolLabels: BOOL_OFF_ON, group: 'Performance' },
  bUseDynamicResolution: { title: 'Dynamic Resolution', desc: 'Auto-drops render resolution to hold FPS. Causes inconsistent aim feel — keep off.', editor: 'bool', boolLabels: BOOL_OFF_ON, group: 'Performance' },
  bUseHDRDisplayOutput: { title: 'HDR Output', desc: 'High dynamic range output, only matters on an HDR monitor.', editor: 'bool', boolLabels: BOOL_OFF_ON, group: 'Performance' },
  HDRDisplayOutputNits: { title: 'HDR Peak Brightness', desc: 'Monitor peak brightness in nits (common: 400 / 600 / 1000). Only matters with HDR on.', editor: 'int', group: 'Performance' },

  'sg.ResolutionQuality': { title: 'Render Scale %', desc: 'Percent of resolution actually rendered. 100 = full sharpness. Lower = blurrier but faster.', editor: 'float', group: 'Graphics' },
  'sg.ViewDistanceQuality': { title: 'View Distance', desc: 'Detail of far-away objects. High keeps distant enemies crisp.', editor: 'sgQuality', group: 'Graphics' },
  'sg.AntiAliasingQuality': { title: 'Anti-Aliasing', desc: 'Smooths jagged edges. MSAA in Valorant is handled in-game; this is the ini mirror.', editor: 'sgQuality', group: 'Graphics' },
  'sg.ShadowQuality': { title: 'Shadows', desc: '0 = off: max FPS and clearer corners. Pros play low or off.', editor: 'sgQuality', group: 'Graphics' },
  'sg.GlobalIlluminationQuality': { title: 'Bounced Lighting', desc: 'Indirect light realism. Expensive, little competitive gain.', editor: 'sgQuality', group: 'Graphics' },
  'sg.ReflectionQuality': { title: 'Reflections', desc: 'Quality of reflective surfaces.', editor: 'sgQuality', group: 'Graphics' },
  'sg.PostProcessQuality': { title: 'Post-Processing', desc: 'Glow/blur finishing effects. 0 = cleanest image.', editor: 'sgQuality', group: 'Graphics' },
  'sg.TextureQuality': { title: 'Texture Detail', desc: 'Surface sharpness. Costs VRAM, cheap on modern GPUs.', editor: 'sgQuality', group: 'Graphics' },
  'sg.EffectsQuality': { title: 'Ability Effects', desc: 'Particles, flashes and explosion detail.', editor: 'sgQuality', group: 'Graphics' },
  'sg.FoliageQuality': { title: 'Foliage Density', desc: 'Grass and leaves density. Low = less visual clutter.', editor: 'sgQuality', group: 'Graphics' },
  'sg.ShadingQuality': { title: 'Material Shading', desc: 'Surface shading complexity.', editor: 'sgQuality', group: 'Graphics' },

  bUseDesiredScreenHeight: { title: 'Honor Desired Height', desc: 'Lets the engine use your DesiredScreenHeight value on launch.', editor: 'bool', boolLabels: BOOL_OFF_ON, group: 'Engine' },

  LastRecommendedScreenWidth: { title: 'Benchmark Suggestion W', desc: 'Width the auto-benchmark recommends. -1 = no benchmark run yet.', editor: 'float', group: 'Game-Managed', auto: true },
  LastRecommendedScreenHeight: { title: 'Benchmark Suggestion H', desc: 'Height the auto-benchmark recommends.', editor: 'float', group: 'Game-Managed', auto: true },
  LastCPUBenchmarkResult: { title: 'CPU Benchmark Score', desc: 'Cached CPU score. -1 = never benchmarked.', editor: 'float', group: 'Game-Managed', auto: true },
  LastGPUBenchmarkResult: { title: 'GPU Benchmark Score', desc: 'Cached GPU score. -1 = never benchmarked.', editor: 'float', group: 'Game-Managed', auto: true },
  LastGPUBenchmarkMultiplier: { title: 'GPU Score Multiplier', desc: 'Scaling factor derived from the GPU benchmark.', editor: 'float', group: 'Game-Managed', auto: true },
};

const GROUP_ORDER = ['Resolution', 'Display', 'Graphics', 'Performance', 'Window & Monitor', 'Engine', 'More Settings'];

const GROUP_HINTS: Record<string, string> = {
  Resolution: 'Set once — writes to render, desired and confirmed copies together.',
  Display: 'How the game takes over your screen — the core of stretched.',
  Graphics: 'Eye candy. Lower = more FPS. 0 Low · 1 Medium · 2 High · 3 Epic.',
  Performance: 'Frame pacing, sync and HDR.',
  'Window & Monitor': 'Where the game window lives.',
  Engine: 'Low-level engine switches.',
  'More Settings': 'Keys this tool has no description for yet. Raw key shown.',
};

/**
 * Hands-off keys — never rendered. Confirmed/last-user copies stay in sync
 * automatically whenever the main value is written; benchmark caches and
 * recommendation values are the game's own bookkeeping. Showing them only
 * invites breaking a working file.
 */
const HIDDEN_KEYS = new Set([
  'LastConfirmedFullscreenMode',
  'bLastConfirmedShouldLetterbox',
  // Resolution copies — the unified Resolution editor below writes all 8 at once.
  'ResolutionSizeX',
  'ResolutionSizeY',
  'LastUserConfirmedResolutionSizeX',
  'LastUserConfirmedResolutionSizeY',
  'DesiredScreenWidth',
  'DesiredScreenHeight',
  'LastUserConfirmedDesiredScreenWidth',
  'LastUserConfirmedDesiredScreenHeight',
  'LastRecommendedScreenWidth',
  'LastRecommendedScreenHeight',
  'LastCPUBenchmarkResult',
  'LastGPUBenchmarkResult',
  'LastGPUBenchmarkMultiplier',
  'AudioQualityLevel',
  'LastConfirmedAudioQualityLevel',
  'LastConfirmedDefaultMonitorDeviceID',
  'LastConfirmedDefaultMonitorIndex',
]);

/** Friendly fallback for unknown keys: "bShouldLetterbox" → "Should Letterbox". */
const prettify = (key: string): string => {
  const noSg = key.startsWith('sg.') ? key.slice(3) : key;
  const noB = noSg.startsWith('b') && noSg.length > 1 && noSg[1] === noSg[1].toUpperCase() ? noSg.slice(1) : noSg;
  return noB.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
};

const defFor = (key: string): SettingDef =>
  DEFS[key] ?? { title: prettify(key), desc: `Raw setting "${key}". The game reads it as-is — change carefully.`, editor: 'text', group: 'More Settings' };

/* ------------------------------------------------------------------ */
/* One editable row.                                                   */
/* ------------------------------------------------------------------ */

const SettingRowEditor: React.FC<{
  section: string;
  rowKey: string;
  value: string;
  filePath: string;
  lockReadonly: boolean;
  onSaved: (msg: string) => void;
  onReloadFile: () => void;
}> = ({ section, rowKey, value, filePath, lockReadonly, onSaved, onReloadFile }) => {
  const def = defFor(rowKey);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const dirty = draft !== value;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await setValorantConfigValue(filePath, section, rowKey, draft, lockReadonly);
      onSaved(`${def.title} set to ${draft} — re-read from disk.`);
      onReloadFile();
    } catch (e) {
      onSaved(`Failed to write ${def.title}: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const boolOpts: DropOption[] = (def.boolLabels ?? BOOL_OFF_ON).map((label, i) => {
    const boolVal = i === 0 ? 'False' : 'True';
    return { value: boolVal, label: `${label}` };
  });
  const normBool = draft.toLowerCase() === 'true' ? 'True' : draft.toLowerCase() === 'false' ? 'False' : draft;

  return (
    <div className="py-2 flex items-center gap-2.5 border-b border-m3-outline-subtle/50 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] font-bold text-m3-on-surface">{def.title}</span>
          {def.auto && (
            <span className="px-1.5 py-px text-[8px] font-mono font-semibold rounded-full bg-m3-surface-container-high border border-m3-outline-subtle text-m3-outline">
              GAME-MANAGED
            </span>
          )}
        </div>
        <p className="text-[10px] text-m3-on-surface-variant leading-snug mt-0.5">{def.desc}</p>
        <p className="text-[9px] font-mono text-m3-outline/70 mt-0.5 truncate">{rowKey}</p>
      </div>
      <div className="w-44 shrink-0">
        {def.editor === 'fullscreen' && (
          <CustomDropdown value={draft} options={FULLSCREEN_OPTS} onChange={setDraft} disabled={saving} />
        )}
        {def.editor === 'bool' && (
          <CustomDropdown
            value={boolOpts.some((o) => o.value === normBool) ? normBool : draft}
            options={
              boolOpts.some((o) => o.value === normBool)
                ? boolOpts
                : [...boolOpts, { value: draft, label: `${draft} (custom)` }]
            }
            onChange={setDraft}
            disabled={saving}
          />
        )}
        {def.editor === 'sgQuality' && (
          <CustomDropdown
            value={draft}
            options={
              SG_OPTS.some((o) => o.value === draft)
                ? SG_OPTS
                : [...SG_OPTS, { value: draft, label: `${draft} (custom)` }]
            }
            onChange={setDraft}
            disabled={saving}
          />
        )}
        {(def.editor === 'int' || def.editor === 'float' || def.editor === 'text') && (
          <div className="h-8 px-2 rounded-lg bg-m3-surface-container-lowest border border-m3-outline-subtle focus-within:border-m3-primary focus-within:ring-2 focus-within:ring-m3-primary/30 transition-all flex items-center">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              inputMode={def.editor === 'text' ? 'text' : def.editor === 'float' ? 'decimal' : 'numeric'}
              disabled={saving}
              spellCheck={false}
              className="w-full bg-transparent text-m3-on-surface font-mono text-[11px] font-bold focus:outline-none text-center disabled:opacity-50"
            />
          </div>
        )}
      </div>
      <button
        onClick={save}
        disabled={!dirty || saving}
        title={dirty ? `Write ${draft} to file` : 'No changes'}
        className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-all ${
          dirty
            ? 'bg-m3-primary text-m3-on-primary cursor-pointer active:scale-90 shadow-xs'
            : 'bg-m3-surface-container-high text-m3-outline/40 cursor-default'
        }`}
      >
        <Save className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Unified resolution — one input, writes all 8 resolution keys.       */
/* ------------------------------------------------------------------ */

const UnifiedResolution: React.FC<{
  sections: ValorantSection[];
  filePath: string;
  lockReadonly: boolean;
  onSaved: (msg: string) => void;
  onReloadFile: () => void;
}> = ({ sections, filePath, lockReadonly, onSaved, onReloadFile }) => {
  const current = useMemo(() => {
    let w = '2088';
    let h = '1440';
    for (const sec of sections) {
      for (const row of sec.rows) {
        if (row.key === 'ResolutionSizeX' && row.value) w = row.value;
        if (row.key === 'ResolutionSizeY' && row.value) h = row.value;
      }
    }
    return { w, h };
  }, [sections]);

  const [w, setW] = useState(current.w);
  const [h, setH] = useState(current.h);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setW(current.w);
    setH(current.h);
  }, [current]);

  const dirty = w !== current.w || h !== current.h;

  const save = async () => {
    const rw = parseInt(w, 10);
    const rh = parseInt(h, 10);
    if (isNaN(rw) || isNaN(rh) || rw <= 0 || rh <= 0) {
      onSaved('Enter a valid resolution first.');
      return;
    }
    setSaving(true);
    try {
      await updateValorantConfigCustom(filePath, {
        fullscreen_mode: null,
        letterbox: null,
        res: [rw, rh],
        desired: [rw, rh],
        lock_readonly: lockReadonly,
      });
      onSaved(`Resolution set to ${rw}x${rh} everywhere (render + display + confirmed) — re-read from disk.`);
      onReloadFile();
    } catch (e) {
      onSaved(`Failed to write resolution: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl bg-m3-surface-container-low/60 border border-m3-primary/30 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h4 className="text-[10px] font-bold uppercase tracking-[0.12em] text-m3-primary">Resolution</h4>
          <p className="text-[10px] text-m3-outline mt-px">Set once — writes render, display and confirmed copies together.</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="flex items-center gap-1 bg-m3-surface-container-lowest px-2 h-8 rounded-lg border border-m3-outline-subtle focus-within:border-m3-primary transition-all">
            <input value={w} onChange={(e) => setW(e.target.value)} inputMode="numeric" disabled={saving}
              className="w-16 bg-transparent font-mono text-[12px] text-center font-bold focus:outline-none disabled:opacity-50" />
            <span className="font-mono text-m3-outline text-xs">×</span>
            <input value={h} onChange={(e) => setH(e.target.value)} inputMode="numeric" disabled={saving}
              className="w-16 bg-transparent font-mono text-[12px] text-center font-bold focus:outline-none disabled:opacity-50" />
          </div>
          <button onClick={save} disabled={!dirty || saving}
            className={`h-8 px-3.5 rounded-full text-[11px] font-bold flex items-center gap-1.5 transition-all ${
              dirty ? 'bg-m3-primary text-m3-on-primary cursor-pointer active:scale-[0.98]' : 'bg-m3-surface-container-high text-m3-outline/40 cursor-default'
            }`}>
            {saving ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            <span>{saving ? 'Writing…' : 'Set'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* One profile card (one GameUserSettings.ini).                        */
/* ------------------------------------------------------------------ */

const FileCard: React.FC<{
  cfg: ConfigFileInfo;
  sections: ValorantSection[];
  verify?: ValorantVerifyResult;
  search: string;
  onBanner: (msg: string) => void;
  onReloadFile: () => void;
  onShowRaw: (cfg: ConfigFileInfo) => void;
}> = ({ cfg, sections, verify, search, onBanner, onReloadFile, onShowRaw }) => {
  const [lock, setLock] = useState(true);

  const groups = useMemo(() => {
    const map = new Map<string, { section: string; key: string; value: string; def: SettingDef }[]>();
    for (const sec of sections) {
      for (const row of sec.rows) {
        if (HIDDEN_KEYS.has(row.key)) continue;
        const def = defFor(row.key);
        const q = search.trim().toLowerCase();
        if (
          q &&
          !def.title.toLowerCase().includes(q) &&
          !row.key.toLowerCase().includes(q) &&
          !def.desc.toLowerCase().includes(q)
        ) {
          continue;
        }
        if (!map.has(def.group)) map.set(def.group, []);
        map.get(def.group)!.push({ section: sec.name, key: row.key, value: row.value, def });
      }
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ name: g, rows: map.get(g)! }));
  }, [sections, search]);

  return (
    <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-3 flex flex-col gap-2 shrink-0 shadow-m3-1">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-bold text-xs text-m3-on-surface">{cfg.display_name}</span>
            {verify ? (
              verify.is_healthy ?? verify.matches ? (
                <span className="px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-m3-mint/20 text-m3-mint border border-m3-mint/40 flex items-center gap-1">
                  <ShieldCheck className="w-2.5 h-2.5" /> 100% HEALTHY
                </span>
              ) : (
                <span className="px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-m3-coral/20 text-m3-coral border border-m3-coral/40 flex items-center gap-1">
                  <TriangleAlert className="w-2.5 h-2.5" /> HEALTH {verify.health_score ?? 0}%
                </span>
              )
            ) : (
              <span className="px-1.5 py-0.5 text-[9px] font-mono rounded-full bg-m3-surface-container-high text-m3-outline border border-m3-outline-subtle">
                UNCHECKED
              </span>
            )}
            {cfg.is_read_only ? (
              <span className="px-1.5 py-0.5 text-[9px] font-mono rounded-full bg-m3-primary-container text-m3-primary border border-m3-primary/30 flex items-center gap-0.5 font-bold">
                <Lock className="w-2 h-2" /> Locked
              </span>
            ) : (
              <span className="px-1.5 py-0.5 text-[9px] font-mono rounded-full bg-m3-surface-container text-m3-outline border border-m3-outline-subtle flex items-center gap-0.5">
                <Unlock className="w-2 h-2" /> Open
              </span>
            )}
          </div>
          <div className="text-[10px] font-mono text-m3-outline truncate mt-0.5 flex items-center gap-1">
            <span className="truncate">{cfg.path}</span>
            <button
              onClick={() => navigator.clipboard?.writeText(cfg.path).catch(() => {})}
              className="shrink-0 hover:text-m3-primary cursor-pointer"
              title="Copy path"
            >
              <Copy className="w-2.5 h-2.5" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            role="switch"
            aria-checked={lock}
            onClick={() => setLock(!lock)}
            className="flex items-center gap-1.5 text-[10px] text-m3-on-surface-variant cursor-pointer select-none mr-1"
          >
            <div
              className={`w-6 h-3.5 flex items-center rounded-full p-0.5 transition-colors shrink-0 ${
                lock ? 'bg-m3-primary' : 'bg-m3-surface-container-highest border border-m3-outline-subtle'
              }`}
            >
              <div
                className={`w-2.5 h-2.5 rounded-full bg-white shadow-sm transition-transform ${
                  lock ? 'translate-x-2.5' : 'translate-x-0'
                }`}
              />
            </div>
            <span>Lock after write</span>
          </button>
          <button
            onClick={() => onShowRaw(cfg)}
            className="h-7 px-2.5 rounded-full bg-m3-surface-container-high border border-m3-outline-subtle text-[10px] font-semibold flex items-center gap-1 cursor-pointer"
          >
            <Eye className="w-3 h-3 text-m3-primary" />
            <span>File proof</span>
          </button>
        </div>
      </div>

      {verify && (!verify.matches || (verify.is_healthy === false)) && (
        <div className="px-2.5 py-2 rounded-xl bg-m3-coral/10 border border-m3-coral/30 text-[11px] text-m3-coral leading-snug space-y-1">
          <div className="font-bold flex items-center gap-1.5">
            <TriangleAlert className="w-3 h-3 shrink-0" />
            <span>Health Issues ({verify.issues?.length || 1}):</span>
          </div>
          {verify.issues && verify.issues.length > 0 ? (
            <ul className="list-disc list-inside space-y-0.5 text-[10px] opacity-90 pl-1">
              {verify.issues.map((issue, idx) => (
                <li key={idx}>{issue}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[10px]">{verify.details}</p>
          )}
        </div>
      )}

      {verify && (verify.is_healthy ?? verify.matches) && (
        <div className="px-2.5 py-1.5 rounded-xl bg-m3-mint/10 border border-m3-mint/30 text-[10px] text-m3-mint leading-snug flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
          <span>{verify.details}</span>
        </div>
      )}

      <UnifiedResolution
        sections={sections}
        filePath={cfg.path}
        lockReadonly={lock}
        onSaved={onBanner}
        onReloadFile={onReloadFile}
      />

      {groups.map((g) => (
        <div key={g.name} className="rounded-xl bg-m3-surface-container-low/60 border border-m3-outline-subtle/60 px-2.5 pb-1">
          <div className="pt-2 pb-0.5">
            <h4 className="text-[10px] font-bold uppercase tracking-[0.12em] text-m3-primary">{g.name}</h4>
            {GROUP_HINTS[g.name] && <p className="text-[10px] text-m3-outline mt-px">{GROUP_HINTS[g.name]}</p>}
          </div>
          {g.rows.map((r) => (
            <SettingRowEditor
              key={`${r.section}|${r.key}`}
              section={r.section}
              rowKey={r.key}
              value={r.value}
              filePath={cfg.path}
              lockReadonly={lock}
              onSaved={onBanner}
              onReloadFile={onReloadFile}
            />
          ))}
        </div>
      ))}

      {groups.length === 0 && (
        <div className="p-3 text-center text-[11px] text-m3-outline">No settings match "{search}".</div>
      )}
    </section>
  );
};

/* ------------------------------------------------------------------ */
/* Tab root.                                                           */
/* ------------------------------------------------------------------ */

export const ValorantConfig: React.FC = () => {
  const [configs, setConfigs] = useState<ConfigFileInfo[]>([]);
  const [sectionsMap, setSectionsMap] = useState<Record<string, ValorantSection[]>>({});
  const [verifyMap, setVerifyMap] = useState<Record<string, ValorantVerifyResult>>({});
  const [targetW, setTargetW] = useState('2088');
  const [targetH, setTargetH] = useState('1440');
  const [lockAll, setLockAll] = useState(true);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [rawView, setRawView] = useState<{ path: string; text: string } | null>(null);

  const loadSections = async (paths: string[]) => {
    const entries: [string, ValorantSection[]][] = await Promise.all(
      paths.map(async (p): Promise<[string, ValorantSection[]]> => {
        try {
          const secs = await getValorantConfigSections(p);
          return [p, secs];
        } catch {
          return [p, []];
        }
      })
    );
    setSectionsMap((prev) => {
      const next = { ...prev };
      for (const [p, secs] of entries) next[p] = secs;
      return next;
    });
  };

  const load = async () => {
    setIsLoading(true);
    try {
      const [cfgs, pref] = await Promise.all([fetchValorantConfigs(), fetchPreferredStretchedRes()]);
      setConfigs(cfgs);
      setTargetW(String(pref[0]));
      setTargetH(String(pref[1]));
      await loadSections(cfgs.map((c) => c.path));
      if (cfgs.length > 0) {
        const results = await verifyValorantConfigs(pref[0], pref[1]);
        const m: Record<string, ValorantVerifyResult> = {};
        for (const r of results) m[r.path] = r;
        setVerifyMap(m);
      }
    } catch (e) {
      setBanner(`Load failed: ${String(e)}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reloadFile = async (path: string) => {
    await loadSections([path]);
    const cfgs = await fetchValorantConfigs().catch(() => null);
    if (cfgs) setConfigs(cfgs);
  };

  const handleVerifyAll = async () => {
    const w = parseInt(targetW, 10);
    const h = parseInt(targetH, 10);
    if (isNaN(w) || isNaN(h)) {
      setBanner('Enter a valid target resolution first.');
      return;
    }
    try {
      const results = await verifyValorantConfigs(w, h);
      const m: Record<string, ValorantVerifyResult> = {};
      for (const r of results) m[r.path] = r;
      setVerifyMap(m);
      const ok = results.filter((r) => r.matches).length;
      setBanner(`Verified ${ok}/${results.length} file(s) match ${w}x${h} + Fullscreen 2 + Letterbox off.`);
    } catch (e) {
      setBanner(`Verify failed: ${String(e)}`);
    }
  };

  const handleSyncAll = async () => {
    const w = parseInt(targetW, 10);
    const h = parseInt(targetH, 10);
    if (isNaN(w) || isNaN(h)) {
      setBanner('Enter a valid target resolution first.');
      return;
    }
    setIsSyncing(true);
    try {
      const results = await applyCustomResVerbose(w, h, lockAll);
      const cfgs = await fetchValorantConfigs();
      setConfigs(cfgs);
      await loadSections(cfgs.map((c) => c.path));
      const ver = await verifyValorantConfigs(w, h);
      const m: Record<string, ValorantVerifyResult> = {};
      for (const r of ver) m[r.path] = r;
      setVerifyMap(m);
      const ok = results.filter((r) => r.ok && r.verified).length;
      const healthy = Object.values(m).filter((v) => v.is_healthy ?? v.matches).length;
      const fail = results.filter((r) => !r.ok).map((r) => `${r.display_name}: ${r.message}`).join(' | ');
      setBanner(
        fail
          ? `Synced ${ok}/${results.length}. Failures: ${fail}`
          : `Synced & checked ${ok}/${results.length} file(s) at ${w}×${h} (${healthy}/${results.length} 100% Healthy)! Anti-letterbox, Borderless Fullscreen (Mode 2), and (0,0) alignment applied.`
      );
    } catch (e) {
      setBanner(`Sync failed: ${String(e)}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleShowRaw = async (cfg: ConfigFileInfo) => {
    try {
      const text = await getValorantConfigRaw(cfg.path);
      setRawView({ path: cfg.path, text: text.split(/\r?\n/).slice(0, 80).join('\n') });
    } catch (e) {
      setBanner(`Could not read file: ${String(e)}`);
    }
  };

  const verifiedCount = Object.values(verifyMap).filter((v) => v.matches).length;
  const totalRows = Object.values(sectionsMap).reduce((n, secs) => n + secs.reduce((a, s) => a + s.rows.length, 0), 0);

  return (
    <div className="h-full min-h-0 flex flex-col gap-2.5 max-w-6xl mx-auto w-full overflow-y-auto custom-scrollbar pb-2">
      {banner && (
        <div className="p-2.5 rounded-xl bg-m3-primary-container/40 border border-m3-primary/40 text-m3-on-primary-container text-xs font-semibold flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2">
            <Check className="w-3.5 h-3.5 text-m3-primary shrink-0" />
            <span>{banner}</span>
          </div>
          <button onClick={() => setBanner(null)} className="text-m3-primary hover:underline text-xs ml-3 cursor-pointer font-bold shrink-0">
            Dismiss
          </button>
        </div>
      )}

      <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-3 flex flex-col gap-2 shrink-0 shadow-m3-1">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <FileCode2 className="w-4 h-4 text-m3-primary" />
            <h3 className="font-display font-bold text-xs text-m3-on-surface uppercase tracking-wider">
              Valorant Config — every setting, plain words
            </h3>
          </div>
          <span className="text-[10px] font-mono text-m3-outline">
            {configs.length} file(s) • {totalRows} settings • {verifiedCount} verified
          </span>
        </div>
        <p className="text-[11px] text-m3-on-surface-variant leading-relaxed">
          Your game, your rules — change anything. Every write is re-read from disk and confirmed.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 bg-m3-surface-container-lowest px-2 py-1 rounded-lg border border-m3-outline-subtle">
            <input value={targetW} onChange={(e) => setTargetW(e.target.value)} inputMode="numeric"
              className="w-16 bg-transparent text-m3-on-surface font-mono text-xs focus:outline-none text-center font-bold" placeholder="W" />
            <span className="text-m3-outline font-mono text-xs">×</span>
            <input value={targetH} onChange={(e) => setTargetH(e.target.value)} inputMode="numeric"
              className="w-16 bg-transparent text-m3-on-surface font-mono text-xs focus:outline-none text-center font-bold" placeholder="H" />
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={lockAll}
            onClick={() => setLockAll(!lockAll)}
            className="flex items-center gap-1.5 text-[11px] text-m3-on-surface cursor-pointer select-none"
          >
            <div
              className={`w-6 h-3.5 flex items-center rounded-full p-0.5 transition-colors shrink-0 ${
                lockAll ? 'bg-m3-primary' : 'bg-m3-surface-container-highest border border-m3-outline-subtle'
              }`}
            >
              <div
                className={`w-2.5 h-2.5 rounded-full bg-white shadow-sm transition-transform ${
                  lockAll ? 'translate-x-2.5' : 'translate-x-0'
                }`}
              />
            </div>
            <span>Lock read-only</span>
          </button>
          <div className="flex items-center gap-1.5 px-2 h-7 rounded-full bg-m3-surface-container-lowest border border-m3-outline-subtle focus-within:border-m3-primary transition-all">
            <Search className="w-3 h-3 text-m3-outline shrink-0" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search settings…"
              className="w-32 bg-transparent text-[11px] text-m3-on-surface focus:outline-none placeholder:text-m3-outline/50" />
          </div>
          <div className="flex items-center gap-1.5 ml-auto">
            <button onClick={load} disabled={isLoading}
              className="h-7 px-3 rounded-full bg-m3-surface-container-high border border-m3-outline-subtle text-[11px] font-semibold flex items-center gap-1 cursor-pointer disabled:opacity-50">
              <RefreshCw className={`w-3 h-3 text-m3-primary ${isLoading ? 'animate-spin' : ''}`} />
              <span>Rescan</span>
            </button>
            <button onClick={handleVerifyAll}
              className="h-7 px-3 rounded-full bg-m3-surface-container-high border border-m3-primary/40 text-m3-primary text-[11px] font-bold flex items-center gap-1 cursor-pointer">
              <ShieldCheck className="w-3 h-3" />
              <span>Verify all</span>
            </button>
            <button onClick={handleSyncAll} disabled={isSyncing || configs.length === 0}
              className="h-7 px-3 rounded-full bg-m3-primary text-m3-on-primary text-[11px] font-bold flex items-center gap-1 cursor-pointer disabled:opacity-50">
              {isSyncing ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
              <span>{isSyncing ? 'Syncing…' : `Sync all (${configs.length})`}</span>
            </button>
          </div>
        </div>
        <div className="text-[10px] text-m3-outline flex items-center gap-1.5 pt-1 border-t border-m3-outline-subtle/40">
          <span className="font-semibold text-m3-tertiary">Gold Standard (1.450:1):</span>
          <span><strong>2088×1440</strong> and <strong>1568×1080</strong> are 8-pixel aligned for universal hardware compatibility across AMD Radeon, NVIDIA GeForce, and Intel Arc.</span>
        </div>
      </section>

      {configs.length === 0 ? (
        <div className="p-4 rounded-xl bg-m3-surface-container-high/40 border border-m3-outline-subtle text-center text-[11px] text-m3-on-surface-variant shrink-0">
          No VALORANT configs detected in %LOCALAPPDATA%\VALORANT. Launch VALORANT once, then Rescan.
        </div>
      ) : (
        configs.map((cfg) => (
          <FileCard
            key={cfg.path}
            cfg={cfg}
            sections={sectionsMap[cfg.path] ?? []}
            verify={verifyMap[cfg.path]}
            search={search}
            onBanner={setBanner}
            onReloadFile={() => reloadFile(cfg.path)}
            onShowRaw={handleShowRaw}
          />
        ))
      )}

      {rawView && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={() => setRawView(null)}>
          <div className="w-full max-w-lg rounded-2xl bg-m3-surface-container-high border border-m3-outline-subtle p-4 space-y-2" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-xs text-m3-on-surface">File proof — bytes on disk</h4>
              <button onClick={() => setRawView(null)} className="w-7 h-7 rounded-full hover:bg-m3-surface-container-highest text-m3-outline cursor-pointer">✕</button>
            </div>
            <div className="text-[10px] font-mono text-m3-outline break-all">{rawView.path}</div>
            <pre className="max-h-80 overflow-y-auto custom-scrollbar rounded-xl bg-black/40 border border-m3-outline-subtle p-3 text-[11px] font-mono text-m3-on-surface whitespace-pre-wrap">
              {rawView.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
