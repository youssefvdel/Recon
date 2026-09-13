import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Crosshair as CrosshairIcon, RefreshCw, Save, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  getCrosshair,
  profileColors,
  profileAdv,
  profileSection,
  withCrosshairColors,
  withCrosshairAdv,
  saveCrosshair,
  crosshairHost,
  renameCrosshairProfile,
  addCrosshairProfile,
  removeCrosshairProfile,
  toHex,
  fromHex,
  COLOR_SLOTS,
  ADV_RANGES,
  type CrosshairState,
  type AdvState,
  type Rgba,
} from '../utils/crosshair';
import { PreviewBanner } from './CrosshairPreview';
import { fetchDisplayInfo } from '../utils/ipc';

/* ------------------------------------------------------------------ */
/* Crosshair tab — recolor any profile to ANY color, like ValorantCC.  */
/* Reads the live settings doc through Riot's player-preferences       */
/* service, edits the profile + global color switches, PUTs the doc    */
/* back. Server-side save: restart Valorant to see it in-game.         */
/* Layout: header, preview wall, color wells, save bar.                */
/* ------------------------------------------------------------------ */

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };
const hexOf = (c: Rgba | undefined): string => toHex(c ?? WHITE);

/* One color well row: swatch + label + hex. */
const ColorRow: React.FC<{
  label: string;
  color: Rgba | undefined;
  onPick: (hex: string) => void;
}> = ({ label, color, onPick }) => (
  <label className="flex items-center gap-2.5 rounded-xl bg-m3-surface-container-low hover:bg-m3-surface-container-high border border-m3-outline-subtle/70 px-2.5 py-1.5 cursor-pointer transition-colors">
    <input
      type="color"
      value={hexOf(color)}
      onChange={(e) => onPick(e.target.value)}
      className="m3-color shrink-0"
      style={{ boxShadow: `0 0 10px ${hexOf(color)}66` }}
      aria-label={label}
    />
    <span className="text-[11px] font-medium text-m3-on-surface flex-1">{label}</span>
    <span className="text-[10px] font-mono text-m3-outline tabular-nums uppercase">
      {hexOf(color)}
    </span>
  </label>
);

/* One toggle row: label + toggle switch. */
const ToggleRow: React.FC<{
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, checked, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className="flex items-center justify-between gap-2.5 w-full rounded-xl bg-m3-surface-container-low hover:bg-m3-surface-container-high border border-m3-outline-subtle/70 px-3 py-1.5 cursor-pointer transition-colors"
  >
    <span className="text-[11px] font-medium text-m3-on-surface text-left flex-1 select-none">
      {label}
    </span>
    <div className="flex items-center gap-2 shrink-0">
      <span
        className={`text-[10px] font-mono tabular-nums uppercase select-none ${
          checked ? 'text-m3-primary font-bold' : 'text-m3-outline/70'
        }`}
      >
        {checked ? 'On' : 'Off'}
      </span>
      <div
        className={`w-7 h-4 flex items-center rounded-full p-0.5 transition-colors ${
          checked ? 'bg-m3-primary' : 'bg-black/40 border border-m3-outline-subtle/60'
        }`}
      >
        <div
          className={`w-3 h-3 rounded-full shadow-sm transition-all ${
            checked ? 'translate-x-3 bg-white' : 'translate-x-0 bg-m3-outline'
          }`}
        />
      </div>
    </div>
  </button>
);

/* One slider row: label + range + value. */
const SizeRow: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, step = 1, onChange }) => (
  <label className="flex items-center gap-2.5 rounded-xl bg-m3-surface-container-low hover:bg-m3-surface-container-high border border-m3-outline-subtle/70 px-2.5 py-1.5 transition-colors">
    <span className="text-[11px] font-medium text-m3-on-surface w-44 shrink-0 truncate">
      {label}
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="flex-1 min-w-0 m3-range"
      aria-label={label}
    />
    <span className="text-[10px] font-mono text-m3-outline tabular-nums w-8 text-right shrink-0">
      {Number.isInteger(value) ? value : String(Math.round(value * 100) / 100)}
    </span>
  </label>
);

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-1 pt-2 text-[9px] font-mono font-bold uppercase tracking-[0.16em] text-m3-outline">
    {children}
  </div>
);

/* Banner data flows straight from wall files — no network, no cache. */
const SCENE_CHOICE_KEY = 'recon_preview_scene_choice_v1';

interface SceneOption {
  name: string;
  art: string;
}

/* ValorantCC-style walls: real in-game wall screenshots bundled locally
 * (Bind teleporter, Ascent A-site, …) — the only preview backdrops. */
const WALL_OPTIONS: SceneOption[] = [
  { name: 'Wall 1 · Ascent A', art: '/preview-walls/crosshairbg0.png' },
  { name: 'Wall 2 · Bind TP', art: '/preview-walls/crosshairbg1.png' },
  { name: 'Wall 3', art: '/preview-walls/crosshairbg2.png' },
  { name: 'Wall 4', art: '/preview-walls/crosshairbg3.png' },
  { name: 'Wall 5', art: '/preview-walls/crosshairbg4.png' },
  { name: 'Wall 6', art: '/preview-walls/crosshairbg5.png' },
];
const DEFAULT_WALL = WALL_OPTIONS[0].name;

const PreviewStrip: React.FC<{
  state: CrosshairState;
  profileIdx: number;
  colors: Rgba[];
  adv: AdvState | null;
  nativeHeight: number;
  pickProfile: (idx: number) => void;
  onRename: (newName: string) => void;
  onAdd: (name: string) => void;
  onDelete: () => void;
}> = ({ state, profileIdx, colors, adv, nativeHeight, pickProfile, onRename, onAdd, onDelete }) => {
  const [wallName, setWallName] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(SCENE_CHOICE_KEY + ':wall') ?? localStorage.getItem(SCENE_CHOICE_KEY + ':map') ?? '';
      return WALL_OPTIONS.some((w) => w.name === saved) ? saved : DEFAULT_WALL;
    } catch {
      return DEFAULT_WALL;
    }
  });
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [newProfileText, setNewProfileText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!confirmDelete) return;
    const id = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(id);
  }, [confirmDelete]);

  const pickWall = (name: string) => {
    setWallName(name);
    try {
      localStorage.setItem(SCENE_CHOICE_KEY + ':wall', name);
    } catch {}
  };
  const sec = useMemo(() => {
    const base = profileSection(state, profileIdx);
    if (!adv) return base;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const innerOf = (o: any): any => o?.innerLines ?? o?.InnerLines ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outerOf = (o: any): any => o?.outerLines ?? o?.OuterLines ?? {};
    const primary = {
      ...(base.primary ?? {}),
      bHasOutline: adv.outlines,
      outlineOpacity: adv.outlineOpacity,
      outlineThickness: adv.outlineThickness,
      bDisplayCenterDot: adv.dotShown,
      centerDotOpacity: adv.dotOpacity,
      centerDotSize: adv.dotSize,
      bHideCrosshair: adv.hideCrosshair,
      innerLines: {
        ...innerOf(base.primary),
        bShowLines: adv.innerShown,
        opacity: adv.innerOpacity,
        lineLength: adv.innerLength,
        lineThickness: adv.innerThickness,
        lineOffset: adv.innerOffset,
        bShowMovementError: adv.innerMoveError,
        movementErrorScale: adv.innerMoveMult,
        bShowShootingError: adv.innerFireError,
        firingErrorScale: adv.innerFireMult,
      },
      outerLines: {
        ...outerOf(base.primary),
        bShowLines: adv.outerShown,
        opacity: adv.outerOpacity,
        lineLength: adv.outerLength,
        lineThickness: adv.outerThickness,
        lineOffset: adv.outerOffset,
        bAllowVertScaling: adv.outerVertScale,
        lineLengthVertical: adv.outerLengthV,
        bShowMovementError: adv.outerMoveError,
        movementErrorScale: adv.outerMoveMult,
        bShowShootingError: adv.outerFireError,
        firingErrorScale: adv.outerFireMult,
      },
    };
    // Use-primary ADS: the game ignores the saved ADS block, so the
    // preview mirrors primary instead of showing overridden values.
    // Sniper: merge pending edits so slider drags preview live.
    const sniper = {
      ...(base.sniper ?? {}),
      bDisplayCenterDot: adv.sniperShown,
      centerDotOpacity: adv.sniperOpacity,
      centerDotSize: adv.sniperDotSize,
    };
    return { ...base, primary, sniper, ...(adv.adsUsePrimary ? { ads: primary } : {}) };
  }, [state, profileIdx, adv]);
  const primaryPal = useMemo(
    () => ({ main: hexOf(colors[0]), outline: hexOf(colors[1]) }),
    [colors]
  );
  const adsPal = useMemo(
    () => (adv?.adsUsePrimary ? { main: hexOf(colors[0]), outline: hexOf(colors[1]) } : { main: hexOf(colors[2]), outline: hexOf(colors[3]) }),
    [colors, adv]
  );
  return (
    <div>
      {/* Aligned controls row: Wall background on left, Crosshair profile actions on right */}
      <div className="flex items-center justify-between gap-2 pb-1.5">
        <select
          value={wallName}
          onChange={(e) => pickWall(e.target.value)}
          className="max-w-44 truncate text-[11px] font-medium bg-m3-surface-container-high border border-m3-outline-subtle rounded-lg px-2 py-1 text-m3-on-surface cursor-pointer focus:outline-none focus:border-m3-primary"
          title="Preview backdrop"
        >
          {WALL_OPTIONS.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>

        {isRenaming ? (
          <div className="flex items-center gap-1 min-w-0">
            <input
              type="text"
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onRename(renameText);
                  setIsRenaming(false);
                } else if (e.key === 'Escape') {
                  setIsRenaming(false);
                }
              }}
              autoFocus
              className="w-36 text-[11px] font-medium bg-m3-surface-container-high border border-m3-primary rounded-lg px-2 py-0.5 text-m3-on-surface focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                onRename(renameText);
                setIsRenaming(false);
              }}
              className="p-1 rounded text-emerald-400 hover:bg-m3-surface-container-high cursor-pointer"
              title="Save name"
            >
              <Check className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => setIsRenaming(false)}
              className="p-1 rounded text-m3-outline hover:text-m3-on-surface hover:bg-m3-surface-container-high cursor-pointer"
              title="Cancel"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ) : isAdding ? (
          <div className="flex items-center gap-1 min-w-0">
            <input
              type="text"
              value={newProfileText}
              onChange={(e) => setNewProfileText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onAdd(newProfileText);
                  setIsAdding(false);
                } else if (e.key === 'Escape') {
                  setIsAdding(false);
                }
              }}
              placeholder="Profile name"
              autoFocus
              className="w-36 text-[11px] font-medium bg-m3-surface-container-high border border-m3-primary rounded-lg px-2 py-0.5 text-m3-on-surface focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                onAdd(newProfileText);
                setIsAdding(false);
              }}
              className="p-1 rounded text-emerald-400 hover:bg-m3-surface-container-high cursor-pointer"
              title="Create profile"
            >
              <Check className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => setIsAdding(false)}
              className="p-1 rounded text-m3-outline hover:text-m3-on-surface hover:bg-m3-surface-container-high cursor-pointer"
              title="Cancel"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1 min-w-0">
            <select
              value={profileIdx}
              onChange={(e) => pickProfile(Number(e.target.value))}
              className="max-w-40 truncate text-[11px] font-medium bg-m3-surface-container-high border border-m3-outline-subtle rounded-lg px-2 py-1 text-m3-on-surface cursor-pointer focus:outline-none focus:border-m3-primary"
              title="Crosshair profile"
            >
              {state.profileNames.map((n, i) => (
                <option key={i} value={i}>
                  {n}
                  {i === state.current ? ' ●' : ''}
                </option>
              ))}
            </select>
            {/* Rename */}
            <button
              type="button"
              onClick={() => {
                setRenameText(state.profileNames[profileIdx] ?? '');
                setIsRenaming(true);
              }}
              className="p-1 rounded-lg text-m3-outline hover:text-m3-on-surface hover:bg-m3-surface-container-high transition-colors cursor-pointer shrink-0"
              title="Rename crosshair"
            >
              <Pencil className="w-3 h-3" />
            </button>
            {/* Add / Clone */}
            <button
              type="button"
              onClick={() => {
                setNewProfileText(`${state.profileNames[profileIdx] ?? 'Profile'} Copy`);
                setIsAdding(true);
              }}
              className="p-1 rounded-lg text-m3-outline hover:text-m3-on-surface hover:bg-m3-surface-container-high transition-colors cursor-pointer shrink-0"
              title="Add / clone crosshair"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            {/* Delete */}
            {state.profileNames.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                  } else {
                    onDelete();
                    setConfirmDelete(false);
                  }
                }}
                className={`p-1 rounded-lg transition-colors cursor-pointer shrink-0 ${
                  confirmDelete
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                    : 'text-m3-outline hover:text-red-400 hover:bg-m3-surface-container-high'
                }`}
                title={confirmDelete ? 'Click again to confirm delete' : 'Delete crosshair profile'}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        )}
      </div>
      <PreviewBanner
        primary={sec.primary}
        ads={sec.ads}
        sniper={sec.sniper}
        primaryPal={primaryPal}
        adsPal={adsPal}
        sniperColor={hexOf(colors[4])}
        nativeHeight={nativeHeight}
        bgUrl={WALL_OPTIONS.find((m) => m.name === wallName)?.art ?? WALL_OPTIONS[0].art}
      />
    </div>
  );
};

/* Save button (single click) + status line. */
const SaveBar: React.FC<{
  saving: boolean;
  saved: boolean;
  saveError: boolean;
  isActiveProfile: boolean;
  onSave: () => void;
}> = ({ saving, saved, saveError, isActiveProfile, onSave }) => (
  <div className="flex items-center gap-2">
    {saved && (
      <span className="text-[10.5px] text-emerald-400 font-medium">
        Saved server-side (restart game)
      </span>
    )}
    {saveError && (
      <span className="text-[10.5px] text-red-400 font-medium">Save failed — retry</span>
    )}
    {!saved && !saveError && (
      <span className="text-[10px] text-m3-outline hidden md:inline">
        {isActiveProfile ? 'Edits active profile' : 'Edits inactive profile'}
      </span>
    )}
    <button
      type="button"
      onClick={onSave}
      disabled={saving}
      className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-[11px] font-bold transition-colors cursor-pointer disabled:opacity-50 shrink-0 bg-m3-primary text-m3-on-primary hover:brightness-110"
    >
      {saving ? (
        <RefreshCw className="w-3 h-3 animate-spin" />
      ) : saved ? (
        <Check className="w-3 h-3" />
      ) : (
        <Save className="w-3 h-3" />
      )}
      {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
    </button>
  </div>
);

export const CrosshairView: React.FC = () => {
  const [state, setState] = useState<CrosshairState | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileIdx, setProfileIdx] = useState(0);
  const [colors, setColors] = useState<Rgba[]>([]);
  const [adv, setAdv] = useState<AdvState | null>(null);
  const [nativeHeight, setNativeHeight] = useState(1080);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const resetFlags = useCallback(() => {
    setSaved(false);
    setSaveError(false);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    resetFlags();
    const res = await getCrosshair();
    if ('error' in res) {
      setState(null);
      setHost(null);
      setError(res.error);
    } else {
      setState(res.state);
      setHost(await crosshairHost());
      try {
        const di = await fetchDisplayInfo();
        if (Number.isFinite(di?.native_height) && di.native_height > 0) {
          setNativeHeight(di.native_height);
        }
      } catch {
        /* keep 1080p fallback */
      }
      const idx = Math.min(res.state.current, res.state.profileNames.length - 1);
      setProfileIdx(idx);
      setColors(profileColors(res.state, idx));
      setAdv(profileAdv(res.state, idx));
    }
    setLoading(false);
  }, [resetFlags]);

  useEffect(() => {
    load();
  }, [load]);

  const pickProfile = useCallback(
    (idx: number) => {
      if (!state) return;
      setProfileIdx(idx);
      setColors(profileColors(state, idx));
      setAdv(profileAdv(state, idx));
      resetFlags();
    },
    [state, resetFlags]
  );

  const setSlot = useCallback(
    (slot: number, hex: string) => {
      setColors((prev) => {
        const next = prev.slice();
        next[slot] = fromHex(hex, prev[slot] ?? WHITE);
        return next;
      });
      resetFlags();
    },
    [resetFlags]
  );

  const setAdvKey = useCallback(
    <K extends keyof AdvState>(key: K, value: AdvState[K]) => {
      setAdv((prev) => (prev ? { ...prev, [key]: value } : prev));
      resetFlags();
    },
    [resetFlags]
  );

  const onRename = useCallback(
    async (newName: string) => {
      if (!state || !newName.trim()) return;
      try {
        const nextDoc = renameCrosshairProfile(state.data, profileIdx, newName);
        const nextNames = state.profileNames.slice();
        nextNames[profileIdx] = newName.trim();
        setState({ ...state, data: nextDoc, profileNames: nextNames });
        if (host) await saveCrosshair(host, nextDoc);
      } catch {}
    },
    [state, profileIdx, host]
  );

  const onAdd = useCallback(
    async (name: string) => {
      if (!state) return;
      try {
        const { doc: nextDoc, newIdx } = addCrosshairProfile(state.data, name, profileIdx);
        const nextNames = [...state.profileNames, name.trim() || `Profile ${newIdx + 1}`];
        setState({ ...state, data: nextDoc, profileNames: nextNames });
        setProfileIdx(newIdx);
        setColors(profileColors({ ...state, data: nextDoc }, newIdx));
        setAdv(profileAdv({ ...state, data: nextDoc }, newIdx));
        if (host) await saveCrosshair(host, nextDoc);
      } catch {}
    },
    [state, profileIdx, host]
  );

  const onDelete = useCallback(
    async () => {
      if (!state || state.profileNames.length <= 1) return;
      try {
        const res = removeCrosshairProfile(state.data, profileIdx);
        if (!res) return;
        const nextNames = state.profileNames.filter((_, i) => i !== profileIdx);
        setState({ ...state, data: res.doc, profileNames: nextNames });
        setProfileIdx(res.newIdx);
        setColors(profileColors({ ...state, data: res.doc }, res.newIdx));
        setAdv(profileAdv({ ...state, data: res.doc }, res.newIdx));
        if (host) await saveCrosshair(host, res.doc);
      } catch {}
    },
    [state, profileIdx, host]
  );

  const onSave = useCallback(async () => {
    if (!state || saving) return;
    setSaving(true);
    setSaveError(false);
    try {
      if (!host) throw new Error('No verified host.');
      const withColors = withCrosshairColors(state, profileIdx, colors);
      const doc = adv ? withCrosshairAdv(withColors, profileIdx, adv) : withColors;
      const ok = await saveCrosshair(host, doc);
      if (ok) {
        setState((prev) => (prev ? { ...prev, data: doc } : prev));
        setSaved(true);
      } else {
        setSaveError(true);
      }
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }, [state, saving, host, profileIdx, colors, adv]);

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="w-full px-4 sm:px-6 pt-3 pb-3 shrink-0 border-b border-m3-outline-subtle/60">
        {/* Header: title + reload on left, Save button on right */}
        <div className="flex items-center justify-between gap-2 px-1 pt-1 pb-2">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-[10.5px] font-display font-bold uppercase tracking-[0.14em] text-m3-on-surface shrink-0">
              <CrosshairIcon className="w-3.5 h-3.5 text-m3-primary" />
              <span>Crosshair</span>
            </span>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="p-1 rounded-full text-m3-outline hover:text-m3-on-surface hover:bg-m3-surface-container-high transition-colors cursor-pointer disabled:opacity-50 shrink-0"
              title="Reload from client"
              aria-label="Reload from client"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          {state && (
            <SaveBar
              saving={saving}
              saved={saved}
              saveError={saveError}
              isActiveProfile={profileIdx === state.current}
              onSave={onSave}
            />
          )}
        </div>

        {loading ? (
          <div className="px-1 pb-2 space-y-2">
            <div className="h-28 rounded-xl bg-m3-surface-container-high animate-pulse" />
            <div className="h-10 rounded-xl bg-m3-surface-container-high animate-pulse" />
          </div>
        ) : !state ? (
          <div className="mx-1 mb-2 px-3 py-2.5 rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle/60 flex items-center gap-2">
            <CrosshairIcon className="w-4 h-4 text-m3-outline shrink-0" />
            <span className="text-[10.5px] text-m3-outline leading-snug">
              {error ?? 'Crosshair unavailable right now.'}
            </span>
          </div>
        ) : (
          <PreviewStrip
            state={state}
            profileIdx={profileIdx}
            colors={colors}
            adv={adv}
            nativeHeight={nativeHeight}
            pickProfile={pickProfile}
            onRename={onRename}
            onAdd={onAdd}
            onDelete={onDelete}
          />
        )}
      </div>
      {!loading && state && (
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        <div className="w-full px-4 sm:px-6 pb-6">
          <div className="px-1 pb-2 space-y-4">
            {adv && (
              <>
                {/* PRIMARY — General */}
                <div className="space-y-1.5">
                  <SectionTitle>Primary · General</SectionTitle>
                  <ToggleRow label="Outlines" checked={adv.outlines} onChange={(v) => setAdvKey('outlines', v)} />
                  {adv.outlines && (
                    <>
                      <SizeRow label="Outline Opacity" value={adv.outlineOpacity} {...ADV_RANGES.opacity} onChange={(v) => setAdvKey('outlineOpacity', v)} />
                      <SizeRow label="Outline Thickness" value={adv.outlineThickness} {...ADV_RANGES.outlineThickness} onChange={(v) => setAdvKey('outlineThickness', v)} />
                    </>
                  )}
                  <ToggleRow label="Center Dot" checked={adv.dotShown} onChange={(v) => setAdvKey('dotShown', v)} />
                  {adv.dotShown && (
                    <>
                      <SizeRow label="Center Dot Opacity" value={adv.dotOpacity} {...ADV_RANGES.opacity} onChange={(v) => setAdvKey('dotOpacity', v)} />
                      <SizeRow label="Center Dot Thickness" value={adv.dotSize} {...ADV_RANGES.dotSize} onChange={(v) => setAdvKey('dotSize', v)} />
                    </>
                  )}
                </div>

                {/* PRIMARY — Inner Lines */}
                <div className="space-y-1.5">
                  <SectionTitle>Primary · Inner Lines</SectionTitle>
                  <ToggleRow label="Show Inner Lines" checked={adv.innerShown} onChange={(v) => setAdvKey('innerShown', v)} />
                  {adv.innerShown && (
                    <>
                      <SizeRow label="Inner Line Opacity" value={adv.innerOpacity} {...ADV_RANGES.opacity} onChange={(v) => setAdvKey('innerOpacity', v)} />
                      <SizeRow label="Inner Line Length" value={adv.innerLength} {...ADV_RANGES.length} onChange={(v) => setAdvKey('innerLength', v)} />
                      <SizeRow label="Inner Line Thickness" value={adv.innerThickness} {...ADV_RANGES.thickness} onChange={(v) => setAdvKey('innerThickness', v)} />
                      <SizeRow label="Inner Line Offset" value={adv.innerOffset} {...ADV_RANGES.offset} onChange={(v) => setAdvKey('innerOffset', v)} />
                      <ToggleRow label="Movement Error" checked={adv.innerMoveError} onChange={(v) => setAdvKey('innerMoveError', v)} />
                      {adv.innerMoveError && (
                        <SizeRow label="Movement Error Multiplier" value={adv.innerMoveMult} {...ADV_RANGES.mult} onChange={(v) => setAdvKey('innerMoveMult', v)} />
                      )}
                      <ToggleRow label="Firing Error" checked={adv.innerFireError} onChange={(v) => setAdvKey('innerFireError', v)} />
                      {adv.innerFireError && (
                        <SizeRow label="Firing Error Multiplier" value={adv.innerFireMult} {...ADV_RANGES.mult} onChange={(v) => setAdvKey('innerFireMult', v)} />
                      )}
                    </>
                  )}
                </div>

                {/* PRIMARY — Outer Lines */}
                <div className="space-y-1.5">
                  <SectionTitle>Primary · Outer Lines</SectionTitle>
                  <ToggleRow label="Show Outer Lines" checked={adv.outerShown} onChange={(v) => setAdvKey('outerShown', v)} />
                  {adv.outerShown && (
                    <>
                      <SizeRow label="Outer Line Opacity" value={adv.outerOpacity} {...ADV_RANGES.opacity} onChange={(v) => setAdvKey('outerOpacity', v)} />
                      <SizeRow label="Outer Line Length" value={adv.outerLength} {...ADV_RANGES.length} onChange={(v) => setAdvKey('outerLength', v)} />
                      <SizeRow label="Outer Line Thickness" value={adv.outerThickness} {...ADV_RANGES.thickness} onChange={(v) => setAdvKey('outerThickness', v)} />
                      <SizeRow label="Outer Line Offset" value={adv.outerOffset} {...ADV_RANGES.offset} onChange={(v) => setAdvKey('outerOffset', v)} />
                      <ToggleRow label="Allow Vertical Scaling" checked={adv.outerVertScale} onChange={(v) => setAdvKey('outerVertScale', v)} />
                      {adv.outerVertScale && (
                        <SizeRow label="Outer Line Length (Vertical)" value={adv.outerLengthV} {...ADV_RANGES.length} onChange={(v) => setAdvKey('outerLengthV', v)} />
                      )}
                      <ToggleRow label="Movement Error" checked={adv.outerMoveError} onChange={(v) => setAdvKey('outerMoveError', v)} />
                      {adv.outerMoveError && (
                        <SizeRow label="Movement Error Multiplier" value={adv.outerMoveMult} {...ADV_RANGES.mult} onChange={(v) => setAdvKey('outerMoveMult', v)} />
                      )}
                      <ToggleRow label="Firing Error" checked={adv.outerFireError} onChange={(v) => setAdvKey('outerFireError', v)} />
                      {adv.outerFireError && (
                        <SizeRow label="Firing Error Multiplier" value={adv.outerFireMult} {...ADV_RANGES.mult} onChange={(v) => setAdvKey('outerFireMult', v)} />
                      )}
                    </>
                  )}
                </div>

                {/* Colors + ADS + Sniper */}
                <div className="flex flex-wrap items-start gap-4">
                  <div className="flex-1 min-w-52 space-y-1.5">
                    <SectionTitle>Crosshair Color</SectionTitle>
                    {COLOR_SLOTS.map((slot, i) => (
                      <ColorRow
                        key={slot.key}
                        label={slot.label}
                        color={colors[i]}
                        onPick={(hex) => setSlot(i, hex)}
                      />
                    ))}
                  </div>
                  <div className="flex-1 min-w-52 space-y-1.5">
                    <SectionTitle>ADS</SectionTitle>
                    <ToggleRow label="Use Primary Crosshair for ADS" checked={adv.adsUsePrimary} onChange={(v) => setAdvKey('adsUsePrimary', v)} />
                    {!adv.adsUsePrimary && (
                      <>
                        <SizeRow label="Inner Line Length" value={adv.adsLength} {...ADV_RANGES.length} onChange={(v) => setAdvKey('adsLength', v)} />
                        <SizeRow label="Inner Line Thickness" value={adv.adsThickness} {...ADV_RANGES.thickness} onChange={(v) => setAdvKey('adsThickness', v)} />
                        <SizeRow label="Inner Line Offset" value={adv.adsOffset} {...ADV_RANGES.offset} onChange={(v) => setAdvKey('adsOffset', v)} />
                        <SizeRow label="Center Dot Thickness" value={adv.adsDotSize} {...ADV_RANGES.dotSize} onChange={(v) => setAdvKey('adsDotSize', v)} />
                      </>
                    )}
                    <SectionTitle>Sniper</SectionTitle>
                    <ToggleRow label="Center Dot" checked={adv.sniperShown} onChange={(v) => setAdvKey('sniperShown', v)} />
                    {adv.sniperShown && (
                      <>
                        <SizeRow label="Center Dot Opacity" value={adv.sniperOpacity} {...ADV_RANGES.opacity} onChange={(v) => setAdvKey('sniperOpacity', v)} />
                        <SizeRow label="Center Dot Thickness" value={adv.sniperDotSize} {...ADV_RANGES.dotSize} onChange={(v) => setAdvKey('sniperDotSize', v)} />
                      </>
                    )}
                  </div>
                </div>

                {/* Other */}
                <div className="space-y-1.5">
                  <SectionTitle>Other</SectionTitle>
                  <ToggleRow label="Use Advanced Options" checked={adv.advOptions} onChange={(v) => setAdvKey('advOptions', v)} />
                  <ToggleRow label="Show Spectated Player's Crosshair" checked={adv.spectated} onChange={(v) => setAdvKey('spectated', v)} />
                  <ToggleRow label="Fade Crosshair With Firing Error" checked={adv.fadeError} onChange={(v) => setAdvKey('fadeError', v)} />
                  <ToggleRow label="Override All Primary Crosshairs" checked={adv.allPrimary} onChange={(v) => setAdvKey('allPrimary', v)} />
                  <ToggleRow label="Fix Min Error Across Weapons" checked={adv.fixMinError} onChange={(v) => setAdvKey('fixMinError', v)} />
                  <ToggleRow label="Disable Crosshair" checked={adv.hideCrosshair} onChange={(v) => setAdvKey('hideCrosshair', v)} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
};
