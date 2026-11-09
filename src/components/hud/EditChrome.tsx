import React from 'react';
import {
  Check,
  Crosshair,
  Layers,
  Move,
  RotateCcw,
  Shield,
  Trophy,
  Users,
} from 'lucide-react';
import type { OverlayCrosshairShape } from '../../utils/crosshairOverlay';
import {
  getDefaultOverlayConfig,
  getDefaultOverlayPositions,
  type OverlayConfig,
} from './overlayConfig';

export interface EditChromeProps {
  isEditMode: boolean;
  config: OverlayConfig;
  xhair: OverlayCrosshairShape;
  saveConfig: (next: OverlayConfig) => void;
  exitEditMode: () => void;
}

/* Edit-mode dimmer, top controls and widget drawer: moved verbatim from
 * OverlayView (split 6/8). Inline failure notice stays in the canvas. */

export const EditChrome: React.FC<EditChromeProps> = ({
  isEditMode,
  config,
  xhair,
  saveConfig,
  exitEditMode,
}) => (
  <>
    {/* Edit Mode Dimmer: subtle 40% darkness so desktop/game remains visible */}
    {isEditMode && (
      <>
        <div
          className="fixed inset-0 pointer-events-auto bg-black/40 transition-opacity duration-200 z-0"
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
        />
        {/* Screen Boundary Frame so users clearly see their display perimeter */}
        <div className="fixed inset-3 pointer-events-none border-2 border-dashed border-m3-primary/40 rounded-3xl z-40 flex items-start justify-between p-3 select-none">
          <span className="px-3 py-1 rounded-xl bg-m3-surface-container/[0.85] border border-m3-primary/40 text-[10px] font-mono font-bold text-m3-primary shadow-md">
            SCREEN BOUNDS • {typeof window !== 'undefined' ? `${window.innerWidth}×${window.innerHeight}` : 'DISPLAY'}
          </span>
          <span className="px-3 py-1 rounded-xl bg-m3-surface-container/[0.85] border border-m3-primary/40 text-[10px] font-mono font-bold text-m3-on-surface-variant shadow-md">
            DRAG WIDGETS BY TOP BAR • PRESS ESC TO LOCK
          </span>
        </div>
      </>
    )}

    {/* ============================================================ */}
    {/* EDIT MODE TOP CONTROLS (Center Top)                          */}
    {/* ============================================================ */}
    {isEditMode && (
      <div className="fixed top-4 inset-x-0 mx-auto w-fit z-50 pointer-events-auto flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-m3-surface-container/[0.85] border border-m3-primary/40 shadow-2xl">
        <div className="flex items-center gap-2 pr-2 border-r border-m3-outline-subtle/55">
          <span className="w-2.5 h-2.5 rounded-full bg-m3-mint shadow-[0_0_8px_rgba(58,227,116,0.8)]" />
          <span className="font-display font-black text-xs text-m3-on-surface tracking-wider uppercase">
            HUD Edit Mode
          </span>
        </div>

        <button
          type="button"
          onClick={() => {
            const def = getDefaultOverlayPositions();
            saveConfig({
              ...config,
              showPregame: true,
              positions: {
                ...config.positions,
                pregame: def.pregame,
              },
            });
          }}
          className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-m3-surface-container-high/60 hover:bg-m3-surface-container-highest border border-m3-outline-subtle/55 text-m3-on-surface-variant hover:text-white flex items-center gap-1.5 cursor-pointer transition-colors"
          data-tip="Center Agent Select in middle of screen"
        >
          <Move className="w-3.5 h-3.5 text-m3-primary" />
          <span>Center Agent Select</span>
        </button>

        <button
          type="button"
          onClick={() => saveConfig(getDefaultOverlayConfig())}
          className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-m3-surface-container-high/60 hover:bg-m3-surface-container-highest border border-m3-outline-subtle/55 text-m3-on-surface-variant hover:text-white flex items-center gap-1.5 cursor-pointer transition-colors"
          data-tip="Reset all widget positions to defaults"
        >
          <RotateCcw className="w-3.5 h-3.5 text-m3-on-surface-variant" />
          <span>Reset All</span>
        </button>

        <button
          type="button"
          onClick={() => void exitEditMode()}
          className="px-4 py-1.5 rounded-xl bg-m3-mint text-m3-on-primary text-xs font-extrabold shadow-md border border-white/20 hover:brightness-110 flex items-center gap-1.5 cursor-pointer transition-all ml-1"
        >
          <Check className="w-4 h-4 stroke-[2.5]" />
          <span>Lock HUD (Esc)</span>
        </button>
      </div>
    )}
    {/* ============================================================ */}
    {/* EDIT MODE WIDGETS DRAWER (Top Right Panel)                   */}
    {/* ============================================================ */}
    {isEditMode && (
      <div className="fixed top-4 right-4 z-50 pointer-events-auto w-72 flex flex-col gap-2 p-3 rounded-3xl bg-m3-surface-container/[0.85] border border-m3-primary/40 shadow-2xl">
        <div className="flex items-center justify-between px-1 pb-1.5 border-b border-m3-outline-subtle/55">
          <span className="font-display font-black text-xs text-m3-on-surface uppercase tracking-wider flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-m3-primary" />
            <span>Widgets List</span>
          </span>
          <span className="text-[10px] font-mono text-m3-primary font-bold">
            {[config.showPregame, config.showLobby, config.showTopAgents, config.showPrepick, config.showStartingSide, config.showCrosshair].filter(Boolean).length} / 6 ON
          </span>
        </div>

        {/* 1. AGENT SELECT */}
        <div className={`p-2.5 rounded-2xl border transition-all flex flex-col gap-1.5 ${
          config.showPregame ? 'bg-m3-primary/10 border-m3-primary/45 shadow-md ring-1 ring-m3-primary/40' : 'bg-m3-surface-container-low/70 border-m3-outline-subtle/55 opacity-60'
        }`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-m3-on-surface flex items-center gap-1.5 min-w-0">
              <Shield className="w-3.5 h-3.5 text-m3-primary" />
              <span>Agent Select</span>
            </span>
            <button
              type="button"
              onClick={() => saveConfig({ ...config, showPregame: !config.showPregame })}
              className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-black border transition-colors cursor-pointer shrink-0 whitespace-nowrap ${
                config.showPregame
                  ? 'bg-m3-mint/20 text-m3-mint border-m3-mint/40'
                  : 'bg-m3-surface-container-high/60 text-m3-on-surface-variant border-m3-outline-subtle/55'
              }`}
            >
              {config.showPregame ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="flex items-center justify-between text-[10px] text-m3-on-surface-variant font-mono">
            <span>X: {Math.round(config.positions.pregame.x)} Y: {Math.round(config.positions.pregame.y)}</span>
            <button
              type="button"
              onClick={() => saveConfig({
                ...config,
                showPregame: true,
                positions: { ...config.positions, pregame: getDefaultOverlayPositions().pregame },
              })}
              className="text-m3-primary hover:text-white underline cursor-pointer text-[9px]"
            >
              Reset pos
            </button>
          </div>
        </div>

        {/* 2. MATCH STATUS (SCOREBOARD) */}
        <div className={`p-2.5 rounded-2xl border transition-all flex flex-col gap-1.5 ${
          config.showLobby ? 'bg-m3-primary/10 border-m3-primary/45 shadow-md ring-1 ring-m3-primary/40' : 'bg-m3-surface-container-low/70 border-m3-outline-subtle/55 opacity-60'
        }`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-m3-on-surface flex items-center gap-1.5 min-w-0">
              <Users className="w-3.5 h-3.5 text-m3-gold" />
              <span>Match Status</span>
            </span>
            <button
              type="button"
              onClick={() => saveConfig({ ...config, showLobby: !config.showLobby })}
              className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-black border transition-colors cursor-pointer shrink-0 whitespace-nowrap ${
                config.showLobby
                  ? 'bg-m3-mint/20 text-m3-mint border-m3-mint/40'
                  : 'bg-m3-surface-container-high/60 text-m3-on-surface-variant border-m3-outline-subtle/55'
              }`}
            >
              {config.showLobby ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="flex items-center justify-between text-[10px] text-m3-on-surface-variant font-mono">
            <span>X: {Math.round(config.positions.lobby.x)} Y: {Math.round(config.positions.lobby.y)}</span>
            <button
              type="button"
              onClick={() => saveConfig({
                ...config,
                showLobby: true,
                positions: { ...config.positions, lobby: getDefaultOverlayPositions().lobby },
              })}
              className="text-m3-primary hover:text-white underline cursor-pointer text-[9px]"
            >
              Reset pos
            </button>
          </div>
        </div>

        {/* 3. TOP AGENTS */}
        <div className={`p-2.5 rounded-2xl border transition-all flex flex-col gap-1.5 ${
          config.showTopAgents ? 'bg-m3-primary/10 border-m3-primary/45 shadow-md ring-1 ring-m3-primary/40' : 'bg-m3-surface-container-low/70 border-m3-outline-subtle/55 opacity-60'
        }`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-m3-on-surface flex items-center gap-1.5 min-w-0">
              <Trophy className="w-3.5 h-3.5 text-m3-gold" />
              <span>Top Agents</span>
            </span>
            <button
              type="button"
              onClick={() => saveConfig({ ...config, showTopAgents: !config.showTopAgents })}
              className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-black border transition-colors cursor-pointer shrink-0 whitespace-nowrap ${
                config.showTopAgents
                  ? 'bg-m3-mint/20 text-m3-mint border-m3-mint/40'
                  : 'bg-m3-surface-container-high/60 text-m3-on-surface-variant border-m3-outline-subtle/55'
              }`}
            >
              {config.showTopAgents ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="flex items-center justify-between text-[10px] text-m3-on-surface-variant font-mono">
            <span>X: {Math.round(config.positions.topAgents.x)} Y: {Math.round(config.positions.topAgents.y)}</span>
            <button
              type="button"
              onClick={() => saveConfig({
                ...config,
                showTopAgents: true,
                positions: { ...config.positions, topAgents: getDefaultOverlayPositions().topAgents },
              })}
              className="text-m3-primary hover:text-white underline cursor-pointer text-[9px]"
            >
              Reset pos
            </button>
          </div>
        </div>

        {/* 4. SAFE PRE-PICK (LOBBY ONLY, SELF-HIDES WHEN UNARMED) */}
        <div className={`p-2.5 rounded-2xl border transition-all flex items-center justify-between ${
          config.showPrepick ? 'bg-m3-primary/10 border-m3-primary/45 shadow-md ring-1 ring-m3-primary/40' : 'bg-m3-surface-container-low/70 border-m3-outline-subtle/55 opacity-60'
        }`}>
          <div className="flex flex-col">
            <span className="text-xs font-bold text-m3-on-surface flex items-center gap-1.5 min-w-0">
              <Crosshair className="w-3.5 h-3.5 text-m3-primary" />
              <span>Pre-Pick Reminder</span>
            </span>
            <span className="text-[10px] text-m3-on-surface-variant">Lobby only • hides in Agent Select & game</span>
          </div>
          <button
            type="button"
            onClick={() => saveConfig({ ...config, showPrepick: !config.showPrepick })}
            className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-black border transition-colors cursor-pointer shrink-0 whitespace-nowrap ${
              config.showPrepick
                ? 'bg-m3-mint/20 text-m3-mint border-m3-mint/40'
                : 'bg-m3-surface-container-high/60 text-m3-on-surface-variant border-m3-outline-subtle/55'
            }`}
          >
            {config.showPrepick ? 'ON' : 'OFF'}
          </button>
        </div>

        {/* 5. STARTING SIDE (ATTACK / DEFENSE) */}
        <div className={`p-2.5 rounded-2xl border transition-all flex items-center justify-between ${
          config.showStartingSide ? 'bg-m3-primary/10 border-m3-primary/45 shadow-md ring-1 ring-m3-primary/40' : 'bg-m3-surface-container-low/70 border-m3-outline-subtle/55 opacity-60'
        }`}>
          <div className="flex flex-col">
            <span className="text-xs font-bold text-m3-on-surface flex items-center gap-1.5 min-w-0">
              <Shield className="w-3.5 h-3.5 text-m3-mint" />
              <span>Starting Side (Atk/Def)</span>
            </span>
            <span className="text-[10px] text-m3-on-surface-variant">Show in Agent Select & HUD</span>
          </div>
          <button
            type="button"
            onClick={() => saveConfig({ ...config, showStartingSide: !config.showStartingSide })}
            className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-black border transition-colors cursor-pointer shrink-0 whitespace-nowrap ${
              config.showStartingSide
                ? 'bg-m3-mint/20 text-m3-mint border-m3-mint/40'
                : 'bg-m3-surface-container-high/60 text-m3-on-surface-variant border-m3-outline-subtle/55'
            }`}
          >
            {config.showStartingSide ? 'ON' : 'OFF'}
          </button>
        </div>

        {/* 6. OVERLAY CROSSHAIR (CENTRE-ANCHORED, IN-MATCH ONLY) */}
        <div className={`p-2.5 rounded-2xl border transition-all flex flex-col gap-2 ${
          config.showCrosshair ? 'bg-m3-primary/10 border-m3-primary/45 shadow-md ring-1 ring-m3-primary/40' : 'bg-m3-surface-container-low/70 border-m3-outline-subtle/55 opacity-60'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-xs font-bold text-m3-on-surface flex items-center gap-1.5 min-w-0">
                <Crosshair className="w-3.5 h-3.5 text-m3-primary" />
                <span>Overlay Crosshair</span>
              </span>
              <span className="text-[10px] text-m3-on-surface-variant">Centred overlay reticle • disable your in-game crosshair to avoid two</span>
            </div>
            <button
              type="button"
              onClick={() => saveConfig({ ...config, showCrosshair: !config.showCrosshair })}
              className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-black border transition-colors cursor-pointer shrink-0 whitespace-nowrap ${
                config.showCrosshair
                  ? 'bg-m3-mint/20 text-m3-mint border-m3-mint/40'
                  : 'bg-m3-surface-container-high/60 text-m3-on-surface-variant border-m3-outline-subtle/55'
              }`}
            >
              {config.showCrosshair ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* Reticle is fed by an adapter, so the editor only covers the
              fields in OverlayCrosshairShape. */}
          {config.showCrosshair && (
            <div className="flex flex-col gap-1.5 border-t border-m3-outline-subtle/55 pt-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-m3-on-surface-variant">Core colour</span>
                <input
                  type="color"
                  className="m3-color"
                  value={xhair.core}
                  onChange={(e) => saveConfig({ ...config, crosshair: { ...xhair, core: e.target.value } })}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-m3-on-surface-variant">Outline colour</span>
                <input
                  type="color"
                  className="m3-color"
                  value={xhair.outline}
                  onChange={(e) => saveConfig({ ...config, crosshair: { ...xhair, outline: e.target.value } })}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-m3-on-surface-variant">Outline</span>
                <button
                  type="button"
                  onClick={() => saveConfig({ ...config, crosshair: { ...xhair, outlineOn: !xhair.outlineOn } })}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-black border transition-colors cursor-pointer shrink-0 whitespace-nowrap ${
                    xhair.outlineOn
                      ? 'bg-m3-mint/20 text-m3-mint border-m3-mint/40'
                      : 'bg-m3-surface-container-high/60 text-m3-on-surface-variant border-m3-outline-subtle/55'
                  }`}
                >
                  {xhair.outlineOn ? 'ON' : 'OFF'}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-m3-on-surface-variant w-24 shrink-0">Outline thickness</span>
                <input type="range" min={0} max={6} step={1} className="flex-1 min-w-0 m3-range" value={xhair.outlineThickness}
                  onChange={(e) => saveConfig({ ...config, crosshair: { ...xhair, outlineThickness: Number(e.target.value) } })} />
                <span className="text-[10px] font-mono text-m3-on-surface w-5 text-right">{xhair.outlineThickness}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-m3-on-surface-variant w-24 shrink-0">Length</span>
                <input type="range" min={0} max={20} step={1} className="flex-1 min-w-0 m3-range" value={xhair.length}
                  onChange={(e) => saveConfig({ ...config, crosshair: { ...xhair, length: Number(e.target.value) } })} />
                <span className="text-[10px] font-mono text-m3-on-surface w-5 text-right">{xhair.length}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-m3-on-surface-variant w-24 shrink-0">Thickness</span>
                <input type="range" min={1} max={10} step={1} className="flex-1 min-w-0 m3-range" value={xhair.thickness}
                  onChange={(e) => saveConfig({ ...config, crosshair: { ...xhair, thickness: Number(e.target.value) } })} />
                <span className="text-[10px] font-mono text-m3-on-surface w-5 text-right">{xhair.thickness}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-m3-on-surface-variant w-24 shrink-0">Gap</span>
                <input type="range" min={0} max={20} step={1} className="flex-1 min-w-0 m3-range" value={xhair.gap}
                  onChange={(e) => saveConfig({ ...config, crosshair: { ...xhair, gap: Number(e.target.value) } })} />
                <span className="text-[10px] font-mono text-m3-on-surface w-5 text-right">{xhair.gap}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-m3-on-surface-variant">Centre dot</span>
                <button
                  type="button"
                  onClick={() => saveConfig({ ...config, crosshair: { ...xhair, dotOn: !xhair.dotOn } })}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-black border transition-colors cursor-pointer shrink-0 whitespace-nowrap ${
                    xhair.dotOn
                      ? 'bg-m3-mint/20 text-m3-mint border-m3-mint/40'
                      : 'bg-m3-surface-container-high/60 text-m3-on-surface-variant border-m3-outline-subtle/55'
                  }`}
                >
                  {xhair.dotOn ? 'ON' : 'OFF'}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-m3-on-surface-variant w-24 shrink-0">Dot size</span>
                <input type="range" min={0} max={6} step={1} className="flex-1 min-w-0 m3-range" value={xhair.dotSize}
                  onChange={(e) => saveConfig({ ...config, crosshair: { ...xhair, dotSize: Number(e.target.value) } })} />
                <span className="text-[10px] font-mono text-m3-on-surface w-5 text-right">{xhair.dotSize}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-m3-on-surface-variant w-24 shrink-0">Opacity</span>
                <input type="range" min={0} max={1} step={0.05} className="flex-1 min-w-0 m3-range" value={xhair.opacity}
                  onChange={(e) => saveConfig({ ...config, crosshair: { ...xhair, opacity: Number(e.target.value) } })} />
                <span className="text-[10px] font-mono text-m3-on-surface w-5 text-right">{xhair.opacity}</span>
              </div>
            </div>
          )}
        </div>

      </div>
    )}
  </>
);

