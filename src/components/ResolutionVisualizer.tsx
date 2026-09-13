import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  Eye,
  Check,
  Columns,
  Square,
} from 'lucide-react';
import type { DisplayInfo } from '../types';

interface ResolutionVisualizerProps {
  displayInfo: DisplayInfo | null;
  onApplyResolution: (w: number, h: number, hz: number) => Promise<void>;
}

interface RatioPreset {
  name: string;
  ratio: number;
  label: string;
  isBlackBar: boolean;
  isTrueStretch: boolean;
}

interface AgentProfile {
  id: string;
  name: string;
  role: string;
  roleBadge: string;
  portrait: string;
  icon: string;
  bio: string;
}

/** Agent icon button with graceful fallback: original -> initial-letter avatar. Never shows another agent's image or broken-image icon. */
function SafeAgentIcon({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setFailed(false);
  }, [src]);
  if (failed) {
    return (
      <span
        aria-label={alt}
        title={`${alt} (image missing: ${src} - save file to public${src})`}
        className="w-7 h-7 rounded-full bg-m3-primary-container text-m3-on-primary-container text-xs font-bold flex items-center justify-center shrink-0"
      >
        {alt.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="w-7 h-7 rounded-full object-cover shrink-0"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/** Full-body portrait with graceful fallback: original -> initial-letter placeholder. Never shows another agent. */
function SafeAgentPortrait({ src, alt, className }: { src: string; alt: string; className: string }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setFailed(false);
  }, [src]);
  if (failed) {
    return (
      <div className={`${className} flex items-center justify-center`} title={`${alt} (image missing: ${src})`}>
        <div className="w-24 h-28 rounded-2xl bg-m3-primary-container/40 border border-m3-primary/30 flex flex-col items-center justify-center gap-1 pointer-events-none">
          <span className="text-4xl font-display font-extrabold text-m3-primary leading-none">
            {alt.charAt(0).toUpperCase()}
          </span>
          <span className="text-[10px] font-mono text-m3-on-surface-variant font-semibold">{alt}</span>
          <span className="text-[8px] font-mono text-m3-outline px-2 text-center leading-tight">
            Missing: {src} - save file to public{src}
          </span>
        </div>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

const AGENTS: AgentProfile[] = [
  {
    id: 'clove',
    name: 'Clove',
    role: 'Controller',
    roleBadge: 'Kingdom Archives 3D',
    portrait: '/agents/clove.png',
    icon: '/agents/clove_ka_thumb.png',
    bio: 'Scottish immortal troublemaker. Official 3D in-game model in upright combat posture.',
  },
  {
    id: 'jett',
    name: 'Jett',
    role: 'Duelist',
    roleBadge: 'Kingdom Archives 3D',
    portrait: '/agents/jett.png',
    icon: '/agents/jett_ka_thumb.png',
    bio: 'South Korean agile entry fragger. Official 3D in-game model in upright combat posture.',
  },
  {
    id: 'reyna',
    name: 'Reyna',
    role: 'Duelist',
    roleBadge: 'Kingdom Archives 3D',
    portrait: '/agents/reyna.png',
    icon: '/agents/reyna_ka_thumb.png',
    bio: 'Mexican aggressive duelist. Official 3D in-game model in upright combat posture.',
  },
  {
    id: 'omen',
    name: 'Omen',
    role: 'Controller',
    roleBadge: 'Kingdom Archives 3D',
    portrait: '/agents/omen.png',
    icon: '/agents/omen_ka_thumb.png',
    bio: 'Shadow hunter with broad silhouette. Official 3D in-game model in upright combat posture.',
  },
  {
    id: 'sova',
    name: 'Sova',
    role: 'Initiator',
    roleBadge: 'Kingdom Archives 3D',
    portrait: '/agents/sova.png',
    icon: '/agents/sova_ka_thumb.png',
    bio: 'Russian master scout with tactical bow. Official 3D in-game model in upright combat posture.',
  },
  {
    id: 'iso',
    name: 'Iso',
    role: 'Duelist',
    roleBadge: 'Kingdom Archives 3D',
    portrait: '/agents/iso.png',
    icon: '/agents/iso_ka_thumb.png',
    bio: 'Chinese bulletproof fixer with kinetic armor. Official 3D in-game model in upright combat posture.',
  },
  {
    id: 'viper',
    name: 'Viper',
    role: 'Controller',
    roleBadge: 'Kingdom Archives 3D',
    portrait: '/agents/viper.png',
    icon: '/agents/viper_ka_thumb.png',
    bio: 'American toxic chemist. Official 3D in-game model in upright combat posture.',
  },
  {
    id: 'brimstone',
    name: 'Brimstone',
    role: 'Controller',
    roleBadge: 'Kingdom Archives 3D',
    portrait: '/agents/brimstone.png',
    icon: '/agents/brimstone_ka_thumb.png',
    bio: 'American commander. Orbital support specialist.',
  },
];

const PRESETS: RatioPreset[] = [
  {
    name: '1.45:1',
    ratio: 1.451,
    label: 'True Stretch 1.45:1',
    isBlackBar: false,
    isTrueStretch: true,
  },
  {
    name: '4:3',
    ratio: 1.333,
    label: '4:3 Classic',
    isBlackBar: true,
    isTrueStretch: false,
  },
  {
    name: '16:10',
    ratio: 1.6,
    label: '16:10 Balanced',
    isBlackBar: false,
    isTrueStretch: false,
  },
  {
    name: '5:4',
    ratio: 1.25,
    label: '5:4 Ultra Wide',
    isBlackBar: true,
    isTrueStretch: false,
  },
  {
    name: '16:9',
    ratio: 1.777,
    label: '16:9 Native',
    isBlackBar: false,
    isTrueStretch: false,
  },
];

export const ResolutionVisualizer: React.FC<ResolutionVisualizerProps> = ({
  displayInfo,
  onApplyResolution,
}) => {
  const [selectedAgent, setSelectedAgent] = useState<AgentProfile>(AGENTS[0]);
  const [selectedRatio, setSelectedRatio] = useState<number>(1.451);
  const [activePresetName, setActivePresetName] = useState<string>('1.45:1');
  const [viewMode, setViewMode] = useState<'single' | 'split'>('split');

  const nativeH = displayInfo?.native_height || 1440;
  const currentHz = displayInfo?.current_hz || 260;

  // Calculate calculated width for current selected ratio
  const calcWidth = Math.round(nativeH * selectedRatio);
  const evenWidth = calcWidth % 2 === 0 ? calcWidth : calcWidth + 1;

  // Horizontal stretch multiplier compared to 16:9 (1.777)
  const percentageWider = Math.max(0, Math.round(((1.777 / selectedRatio) - 1) * 100));

  // Character model width scale (1.0 at 16:9, expands at lower aspect ratios)
  const hitboxWidthScale = Math.min(1.6, 1.777 / selectedRatio);

  const handleSelectPreset = (preset: RatioPreset) => {
    setSelectedRatio(preset.ratio);
    setActivePresetName(preset.name);
  };

  // Slider drag fires dozens of input events/sec; each one restarts the
  // spring + re-renders the tab, which tears frames when dragged fast.
  // Collapse to one commit per animation frame — the spring smooths between.
  const sliderRaf = useRef<number | null>(null);
  const pendingRatio = useRef<number | null>(null);
  // While the finger is on the slider, the stretch follows 1:1 with no
  // spring — a chasing spring under a 60Hz commit storm is what tore frames.
  const [isDragging, setIsDragging] = useState(false);
  const stretchTransition = isDragging
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 280, damping: 24 };
  useEffect(
    () => () => {
      if (sliderRaf.current !== null) cancelAnimationFrame(sliderRaf.current);
    },
    [],
  );
  const commitSliderRatio = (v: number) => {
    pendingRatio.current = v;
    if (sliderRaf.current !== null) return;
    sliderRaf.current = requestAnimationFrame(() => {
      sliderRaf.current = null;
      const next = pendingRatio.current;
      pendingRatio.current = null;
      if (next !== null) {
        setSelectedRatio(next);
        setActivePresetName('Custom');
      }
    });
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-2.5 max-w-6xl mx-auto overflow-hidden [@media(max-height:720px)]:overflow-y-auto">
      {/* Sleek Top Toolbar: Agent Selection + View Mode + Apply CTA */}
      <div className="px-3 py-1.5 rounded-2xl bg-m3-surface-container border border-m3-outline-subtle shadow-m3-1 shrink-0 flex items-center justify-between gap-3">
        {/* Left: Agent picker — icon-only M3 buttons, everything fits, zero scroll.
            Selected agent name + role always shown in the simulator OSD below. */}
        <div className="flex-1 min-w-0 flex items-center overflow-visible p-1 -m-1">
          <div className="flex items-center gap-1.5 shrink-0 pr-1">
            {AGENTS.map((agent) => {
              const isSelected = selectedAgent.id === agent.id;
              return (
                <button
                  key={agent.id}
                  onClick={() => setSelectedAgent(agent)}
                  title={`${agent.name} (${agent.role})`}
                  aria-label={`Preview ${agent.name}`}
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer shrink-0 ${
                    isSelected
                      ? 'bg-m3-primary-container ring-2 ring-m3-primary shadow-m3-1 scale-105'
                      : 'bg-m3-surface-container-high hover:bg-m3-surface-container-highest border border-m3-outline-subtle opacity-70 hover:opacity-100'
                  }`}
                >
                  <SafeAgentIcon src={agent.icon} alt={agent.name} />
                </button>
              );
            })}
          </div>
        </div>

        {/* Right: View Mode Toggle & Apply Resolution CTA */}
        <div className="flex items-center space-x-2 shrink-0 pl-2 border-l border-m3-outline-subtle/60">
          <div className="flex rounded-full bg-m3-surface-container-lowest p-0.5 border border-m3-outline-subtle">
            <button
              onClick={() => setViewMode('split')}
              className={`px-2.5 py-1 rounded-full text-[11px] transition-all flex items-center space-x-1 cursor-pointer ${
                viewMode === 'split'
                  ? 'bg-m3-primary text-m3-on-primary font-semibold shadow-xs'
                  : 'text-m3-outline hover:text-m3-on-surface font-medium'
              }`}
              title="Side-by-Side Comparison (Native vs Stretched)"
            >
              <Columns className="w-3.5 h-3.5" />
              <span>Side-by-Side</span>
            </button>
            <button
              onClick={() => setViewMode('single')}
              className={`px-2.5 py-1 rounded-full text-[11px] transition-all flex items-center space-x-1 cursor-pointer ${
                viewMode === 'single'
                  ? 'bg-m3-primary text-m3-on-primary font-semibold shadow-xs'
                  : 'text-m3-outline hover:text-m3-on-surface font-medium'
              }`}
              title="Single Monitor View"
            >
              <Square className="w-3.5 h-3.5" />
              <span>Single</span>
            </button>
          </div>

          <button
            onClick={() => onApplyResolution(evenWidth, nativeH, currentHz)}
            className="px-3.5 py-1.5 rounded-full bg-m3-primary hover:bg-m3-primary/90 active:bg-m3-primary/80 text-m3-on-primary text-xs font-semibold shadow-m3-1 hover:shadow-m3-2 active:scale-[0.98] transition-all flex items-center space-x-1.5 cursor-pointer shrink-0"
          >
            <Check className="w-3.5 h-3.5 text-m3-on-primary" />
            <span>
              Apply <span className="font-mono tabular-nums">{evenWidth}×{nativeH}</span> @{' '}
              <span className="font-mono tabular-nums">{currentHz}Hz</span>
            </span>
          </button>
        </div>
      </div>

      {/* Main Interactive Stage */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5 items-stretch flex-1 min-h-0">
        {/* Left 7 Cols: The Simulated Gaming Monitor Screen */}
        <div className="lg:col-span-7 flex flex-col h-full min-h-0">
          {/* Monitor Frame */}
          <div className="w-full h-full flex flex-col min-h-0 bg-m3-surface-container-lowest p-2 rounded-2xl border border-m3-outline-subtle shadow-m3-2 relative">
            {/* Monitor OSD Brand & Power LED */}
            <div className="flex justify-between items-center px-2 pb-1 text-[10px] font-mono text-m3-outline shrink-0">
              <div className="flex items-center space-x-2">
                <span className="tracking-widest uppercase text-m3-secondary font-bold">TRUESTRETCH SIMULATOR 240+</span>
                <span>•</span>
                <span className="text-m3-primary font-semibold">{selectedAgent.name} ({selectedAgent.role})</span>
              </div>
              <div className="flex items-center space-x-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                <span className="text-emerald-400 font-bold tabular-nums">{currentHz}Hz ACTIVE</span>
              </div>
            </div>

            {/* Screen Glass Surface */}
            <div className="relative w-full flex-1 min-h-0 bg-[#0a0712] rounded-xl overflow-hidden border border-m3-outline-subtle/80 flex flex-col select-none">
              {/* Tactical Range Grid Canvas */}
              <div
                className="absolute inset-0 opacity-20 pointer-events-none"
                style={{
                  backgroundImage: `
                    linear-gradient(to right, rgba(208, 188, 255, 0.1) 1px, transparent 1px),
                    linear-gradient(to bottom, rgba(208, 188, 255, 0.1) 1px, transparent 1px)
                  `,
                  backgroundSize: '36px 36px',
                }}
              />

              {/* Authentic Vertical Pillarbox Bars (Only in Single View when ratio triggers UE clamp) */}
              {viewMode === 'single' && selectedRatio < 1.44 && (
                <>
                  <div
                    className="absolute left-0 top-0 bottom-0 bg-black/95 border-r border-m3-coral/60 flex items-center justify-center z-30"
                    style={{ width: `${Math.min(16, Math.max(4, (1.444 - selectedRatio) * 32))}%` }}
                  >
                    <span className="text-[9px] text-m3-coral font-mono font-bold tracking-widest [writing-mode:vertical-rl] select-none">
                      LETTERBOX
                    </span>
                  </div>
                  <div
                    className="absolute right-0 top-0 bottom-0 bg-black/95 border-l border-m3-coral/60 flex items-center justify-center z-30"
                    style={{ width: `${Math.min(16, Math.max(4, (1.444 - selectedRatio) * 32))}%` }}
                  >
                    <span className="text-[9px] text-m3-coral font-mono font-bold tracking-widest [writing-mode:vertical-rl] select-none">
                      LETTERBOX
                    </span>
                  </div>
                </>
              )}

              {/* VIEW MODE: SIDE-BY-SIDE COMPARISON */}
              {viewMode === 'split' && (
                <div className="relative w-full flex-1 min-h-0 grid grid-cols-2 divide-x divide-m3-outline-subtle">
                  {/* Left: Native 16:9 Baseline */}
                  <div className="relative h-full flex flex-col min-h-0 p-2">
                    <div className="flex justify-start items-center shrink-0">
                      <span className="px-2 py-0.5 rounded-full bg-m3-surface-container-highest/90 border border-m3-outline-subtle text-[9px] font-mono text-m3-on-surface shadow-xs">
                        16:9 Native (1.00×)
                      </span>
                    </div>

                    {/* Character Viewport */}
                    <div className="flex-1 min-h-0 flex items-center justify-center relative my-1 px-1">
                      <SafeAgentPortrait
                        src={selectedAgent.portrait}
                        alt={selectedAgent.name}
                        className="h-full max-h-full w-auto max-w-full object-contain filter drop-shadow-[0_8px_16px_rgba(0,0,0,0.8)] opacity-90 pointer-events-none"
                      />
                    </div>

                    {/* Bottom Ground Reference Line */}
                    <div className="shrink-0 text-center py-1 border-t border-m3-outline-subtle/40 bg-black/20 rounded-b-lg">
                      <span className="text-[10px] font-mono text-m3-outline font-semibold">
                        Baseline Hitbox: 100%
                      </span>
                    </div>
                  </div>

                  {/* Right: Selected Stretched Profile */}
                  <div className="relative h-full flex flex-col min-h-0 p-2 bg-m3-primary-container/10 overflow-hidden">
                    <div className="flex justify-between items-center shrink-0">
                      <span className="px-2 py-0.5 rounded-full bg-m3-primary-container/90 border border-m3-primary/40 text-[9px] font-mono text-m3-primary font-bold shadow-xs">
                        {activePresetName} (+{percentageWider}%)
                      </span>
                      {selectedRatio < 1.44 && (
                        <span className="text-m3-coral text-[9px] font-mono font-bold">
                          • UE Clamped
                        </span>
                      )}
                    </div>

                    {/* Character Viewport with horizontal stretch */}
                    <div className="flex-1 min-h-0 flex items-center justify-center relative my-1 px-1">
                      {/* Static ambient glow — painted once, never re-rastered mid-stretch */}
                      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[70%] aspect-[1/2] rounded-full bg-m3-primary/15 blur-2xl pointer-events-none" />
                      <motion.div
                        animate={{ scaleX: hitboxWidthScale }}
                        transition={stretchTransition}
                        className="h-full max-h-full flex items-center justify-center will-change-transform"
                      >
                        <SafeAgentPortrait
                          src={selectedAgent.portrait}
                          alt={selectedAgent.name}
                          className="h-full max-h-full w-auto max-w-full object-contain pointer-events-none"
                        />
                      </motion.div>
                    </div>

                    {/* Bottom Ground Reference Line */}
                    <div className="shrink-0 text-center py-1 border-t border-m3-primary/30 bg-m3-primary-container/20 rounded-b-lg">
                      <span className="text-[10px] font-mono text-m3-primary font-bold">
                        +{percentageWider}% Wider Hitbox
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* VIEW MODE: SINGLE SCREEN */}
              {viewMode === 'single' && (
                <div className="relative w-full flex-1 min-h-0 flex flex-col p-2">
                  <div className="flex justify-between items-center shrink-0">
                    <span className="px-2.5 py-0.5 rounded-full bg-m3-primary-container/90 border border-m3-primary/40 text-[10px] font-mono text-m3-primary font-bold shadow-xs">
                      {activePresetName} Stretched Simulation
                    </span>
                    <span className="text-[10px] font-mono text-m3-primary font-semibold">
                      +{percentageWider}% Wider Hitbox
                    </span>
                  </div>

                  <div className="flex-1 min-h-0 flex items-center justify-center relative my-1 px-2">
                    {/* Static ambient glow — painted once, never re-rastered mid-stretch */}
                    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[70%] aspect-[1/2] rounded-full bg-m3-primary/15 blur-2xl pointer-events-none" />
                    <motion.div
                      animate={{ scaleX: hitboxWidthScale }}
                      transition={stretchTransition}
                      className="h-full max-h-full flex items-center justify-center will-change-transform"
                    >
                      <SafeAgentPortrait
                        src={selectedAgent.portrait}
                        alt={selectedAgent.name}
                        className="h-full max-h-full w-auto max-w-full object-contain pointer-events-none"
                      />
                    </motion.div>
                  </div>

                  <div className="shrink-0 text-center py-1 border-t border-m3-outline-subtle/40 bg-black/20 rounded-b-lg">
                    <span className="text-[10px] font-mono text-m3-on-surface-variant font-semibold">
                      Optical Panel Stretch: {selectedRatio.toFixed(3)}:1 Ratio
                    </span>
                  </div>
                </div>
              )}

              {/* Bottom Monitor OSD Metrics Bar */}
              <div className="shrink-0 px-3 py-1.5 bg-[#06040a] border-t border-m3-outline-subtle/60 flex items-center justify-between text-[10px] font-mono">
                <div className="flex items-center space-x-2 text-m3-on-surface-variant">
                  <span>BUFFER:</span>
                  <span className="text-m3-primary font-bold tabular-nums">{evenWidth} × {nativeH}</span>
                  <span className="text-m3-outline">({selectedRatio.toFixed(3)}:1)</span>
                </div>
                <div className="flex items-center space-x-2">
                  <span className="text-m3-on-surface-variant">TARGET SCALE:</span>
                  <span className="text-emerald-400 font-bold tabular-nums">+{percentageWider}% WIDER</span>
                </div>
              </div>
            </div>

            {/* Monitor Stand Base */}
            <div className="w-14 h-1 bg-m3-surface-container mx-auto rounded-b-lg border-x border-b border-m3-outline-subtle shrink-0 mt-1" />
            <div className="w-24 h-0.5 bg-m3-surface-container-high mx-auto rounded-full mt-0.5 shrink-0" />
          </div>
        </div>

        {/* Right 5 Cols: Presets & Controls */}
        <div className="lg:col-span-5 flex flex-col h-full min-h-0">
          <section className="bg-m3-surface-container border border-m3-outline-subtle rounded-2xl p-3 shadow-m3-1 h-full flex flex-col justify-between min-h-0">
            <div className="flex items-center justify-between border-b border-m3-outline-subtle pb-2 shrink-0">
              <div className="flex items-center space-x-1.5">
                <Eye className="w-4 h-4 text-m3-primary" />
                <h3 className="font-display font-bold text-xs text-m3-on-surface">
                  Aspect Ratio Presets
                </h3>
              </div>
              <span className="text-[10px] font-mono text-m3-primary font-bold px-2 py-0.5 rounded-full bg-m3-primary/10 border border-m3-primary/20">
                {selectedRatio.toFixed(3)}:1 Ratio
              </span>
            </div>

            <div className="flex-none flex flex-col gap-1.5 py-1.5">
              {PRESETS.map((preset) => {
                const isSelected = activePresetName === preset.name;
                return (
                  <button
                    key={preset.name}
                    onClick={() => handleSelectPreset(preset)}
                    className={`w-full px-3 py-2 rounded-xl border text-left transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-m3-primary-container/40 border-2 border-m3-primary text-m3-on-primary-container shadow-xs'
                        : 'bg-m3-surface-container-high/60 hover:bg-m3-surface-container-high border-m3-outline-subtle text-m3-on-surface-variant'
                    }`}
                  >
                    <div className="flex justify-between items-center">
                      <div className="flex items-center space-x-2">
                        <span className="font-display font-bold text-xs text-m3-on-surface">{preset.label}</span>
                        {preset.isTrueStretch && (
                          <span className="px-1.5 py-0.2 rounded-full bg-m3-tertiary text-m3-on-tertiary text-[8px] font-bold uppercase tracking-wider shadow-xs">
                            OPTIMAL
                          </span>
                        )}
                      </div>
                      <span className="font-mono tabular-nums text-xs text-m3-outline font-semibold">
                        {Math.round(nativeH * preset.ratio)}×{nativeH}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Custom Ratio Slider */}
            <div className="pt-2 border-t border-m3-outline-subtle space-y-1.5 shrink-0">
              <div className="flex justify-between items-center text-xs">
                <span className="text-m3-on-surface-variant font-medium">Aspect Ratio</span>
                <span className="font-mono tabular-nums font-bold text-m3-primary">
                  {selectedRatio.toFixed(3)}:1
                </span>
              </div>
              <input
                type="range"
                min="1.0"
                max="1.777"
                step="0.005"
                value={selectedRatio}
                onPointerDown={() => setIsDragging(true)}
                onPointerUp={() => setIsDragging(false)}
                onPointerLeave={() => setIsDragging(false)}
                onPointerCancel={() => setIsDragging(false)}
                onChange={(e) => commitSliderRatio(parseFloat(e.target.value))}
                className="w-full m3-range"
              />
              <div className="flex justify-between text-[9px] text-m3-outline font-mono tabular-nums font-medium">
                <span>1.0:1</span>
                <span className="text-m3-primary font-bold">1.45:1</span>
                <span>1.78:1</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
