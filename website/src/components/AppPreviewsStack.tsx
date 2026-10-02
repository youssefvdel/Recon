import React, { useState } from 'react';
import ScrollStack, { ScrollStackItem } from './ScrollStack';
import {
  Check,
  Eye,
  RefreshCw,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Hit-zone body mannequin from Recon Overview.tsx                    */
/* ------------------------------------------------------------------ */
const BodyFigure: React.FC<{ head: number; body: number; legs: number }> = ({ head, body, legs }) => {
  const max = Math.max(head, body, legs, 1);
  const o = (v: number): number => +(0.22 + 0.78 * (v / max)).toFixed(2);
  const fill = '#b6abf7';
  return (
    <svg width="46" height="90" viewBox="0 0 48 92" className="shrink-0 drop-shadow-[0_0_12px_rgba(182,171,247,0.35)]" aria-label="Hit zones">
      <circle cx="24" cy="9" r="7.5" fill={fill} opacity={o(head)} />
      <rect x="6" y="22" width="6" height="26" rx="3" fill={fill} opacity={o(body)} />
      <rect x="36" y="22" width="6" height="26" rx="3" fill={fill} opacity={o(body)} />
      <rect x="15" y="20" width="18" height="32" rx="6" fill={fill} opacity={o(body)} />
      <rect x="15.5" y="54" width="7.5" height="32" rx="3.5" fill={fill} opacity={o(legs)} />
      <rect x="25" y="54" width="7.5" height="32" rx="3.5" fill={fill} opacity={o(legs)} />
    </svg>
  );
};

export default function AppPreviewsStack() {
  // ---- Card 1 state: Resolution Switcher ----
  const [selectedAspect, setSelectedAspect] = useState<'1.45:1' | '4:3' | '16:10' | '16:9'>('1.45:1');
  const [nativeSens, setNativeSens] = useState<string>('0.30');
  const [applied, setApplied] = useState(true);

  const aspectResolutions = {
    '1.45:1': { w: 2088, h: 1440, hz: 260, tag: 'OPTIMAL STRETCH (+22.6% HITBOX)', multiplier: 1.226 },
    '4:3': { w: 1920, h: 1440, hz: 260, tag: 'CLASSIC CS STRETCH', multiplier: 1.333 },
    '16:10': { w: 2304, h: 1440, hz: 260, tag: 'BALANCED STRETCH', multiplier: 1.111 },
    '16:9': { w: 2560, h: 1440, hz: 260, tag: 'NATIVE REFERENCE', multiplier: 1.0 },
  };

  const currentPreset = aspectResolutions[selectedAspect];
  const calculatedSens = (parseFloat(nativeSens) / currentPreset.multiplier).toFixed(3);

  // ---- Card 2 state: Streamer Unmasker ----
  const [unmasked, setUnmasked] = useState(true);

  // ---- Card 3 state: Overlay Starting Side ----
  const [startAttack, setStartAttack] = useState(false);

  return (
    <section id="app-previews" className="relative py-24 sm:py-32 px-4 sm:px-6 lg:px-8 max-w-6xl mx-auto z-10">
      <div className="text-center mb-16">
        <h2 className="font-display font-black text-3xl sm:text-5xl text-white tracking-tight text-balance">
          Explore Recon in Action
        </h2>
        <p className="mt-3 text-sm sm:text-base text-zinc-400 max-w-xl mx-auto leading-relaxed">
          Interactive previews built directly from the real application code. Scroll down to cycle through each native module.
        </p>
      </div>

      <ScrollStack
        useWindowScroll={true}
        itemDistance={70}
        itemStackDistance={30}
        stackPosition="12%"
        scaleEndPosition="6%"
        baseScale={0.88}
        itemScale={0.03}
      >
        {/* =================================================================== */}
        {/* CARD 1: Resolution Switcher & True Stretch Engine                    */}
        {/* =================================================================== */}
        <ScrollStackItem itemClassName="border border-[#b6abf7]/30 bg-gradient-to-br from-[#140e21] via-[#0d0915] to-[#07040a] p-6 sm:p-9 shadow-2xl">
          {/* Mock Window Top Bar */}
          <div className="flex items-center justify-between pb-5 mb-6 border-b border-white/10">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-[#f4a390]" />
              <div className="w-3 h-3 rounded-full bg-amber-400/80" />
              <div className="w-3 h-3 rounded-full bg-[#a8f5cc]" />
              <span className="font-mono text-xs font-bold text-zinc-300 ml-2">RECON // RESOLUTION ENGINE</span>
            </div>
            <div className="flex items-center gap-2 font-mono text-[11px]">
              <span className="text-zinc-400">DISPLAY 1:</span>
              <span className="text-[#a8f5cc] font-bold">RTX 3080 • WDDM HARDWARE GDI</span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left: Aspect Ratio Selectors */}
            <div className="lg:col-span-7 space-y-4">
              <div>
                <div className="text-xs font-mono text-[#b6abf7] font-bold mb-1 uppercase">Select Aspect Ratio Preset</div>
                <h3 className="font-display font-black text-xl text-white">True Stretch Mode Switcher</h3>
              </div>

              <div className="grid grid-cols-2 gap-2.5 font-mono text-xs">
                {(['1.45:1', '4:3', '16:10', '16:9'] as const).map((aspect) => {
                  const isSel = selectedAspect === aspect;
                  return (
                    <button
                      key={aspect}
                      type="button"
                      onClick={() => {
                        setSelectedAspect(aspect);
                        setApplied(false);
                      }}
                      className={`p-3 rounded-xl text-left border transition-all cursor-pointer ${
                        isSel
                          ? 'border-[#b6abf7] bg-[#b6abf7]/15 text-white shadow-[0_0_20px_rgba(182,171,247,0.25)]'
                          : 'border-white/10 bg-black/40 text-zinc-400 hover:border-white/20'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-white text-sm">{aspect}</span>
                        {isSel && <Check className="w-4 h-4 text-[#a8f5cc]" />}
                      </div>
                      <div className="text-[11px] text-zinc-400 mt-1">
                        {aspectResolutions[aspect].w}×{aspectResolutions[aspect].h} @ {aspectResolutions[aspect].hz}Hz
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="p-3.5 rounded-xl bg-black/50 border border-white/10 flex items-center justify-between text-xs font-mono">
                <span className="text-zinc-400">{currentPreset.tag}</span>
                <span className="text-[#a8f5cc] font-bold">0.00ms Compositing Lag</span>
              </div>
            </div>

            {/* Right: Sensitivity Auto-Matcher & Apply CTA */}
            <div className="lg:col-span-5 p-5 rounded-xl bg-black/60 border border-white/10 flex flex-col justify-between h-full">
              <div>
                <div className="text-xs font-mono text-[#b6abf7] font-bold mb-1 uppercase">Sensitivity Matcher</div>
                <div className="text-xs text-zinc-400 mb-4 leading-relaxed">
                  Automatically compensates for horizontal FOV stretching to preserve 100% flick muscle memory.
                </div>

                <div className="space-y-3 font-mono text-xs">
                  <div>
                    <label className="text-zinc-400 block mb-1 text-[11px]">Native In-Game Sens (16:9)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={nativeSens}
                      onChange={(e) => setNativeSens(e.target.value || '0.30')}
                      className="w-full bg-[#181122] border border-white/15 rounded-lg px-3 py-2 text-white font-bold outline-none focus:border-[#b6abf7]"
                    />
                  </div>

                  <div className="p-3 rounded-lg bg-[#b6abf7]/10 border border-[#b6abf7]/25 flex items-center justify-between">
                    <div>
                      <div className="text-[10px] text-zinc-400">Matched Stretched Sens</div>
                      <div className="text-base font-bold text-[#a8f5cc]">{calculatedSens}</div>
                    </div>
                    <span className="text-[10px] text-[#b6abf7] px-2 py-0.5 rounded bg-[#b6abf7]/15">
                      ÷ {currentPreset.multiplier}x
                    </span>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setApplied(true)}
                className={`mt-5 w-full py-3 rounded-xl font-display font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-all cursor-pointer ${
                  applied
                    ? 'bg-[#a8f5cc]/20 border border-[#a8f5cc]/50 text-[#a8f5cc]'
                    : 'bg-[#b6abf7] hover:bg-[#c8c0fa] text-[#140e1b] shadow-lg'
                }`}
              >
                {applied ? (
                  <>
                    <Check className="w-4 h-4 stroke-[2.5]" />
                    <span>Active: {currentPreset.w}×{currentPreset.h} @ {currentPreset.hz}Hz</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 stroke-[2.5]" />
                    <span>Apply Resolution ({selectedAspect})</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </ScrollStackItem>

        {/* =================================================================== */}
        {/* CARD 2: Streamer Mode Unmasker & Live Match Scout                    */}
        {/* =================================================================== */}
        <ScrollStackItem itemClassName="border border-[#f4a390]/30 bg-gradient-to-br from-[#1a1118] via-[#100b12] to-[#070409] p-6 sm:p-9 shadow-2xl">
          <div className="flex items-center justify-between pb-5 mb-6 border-b border-white/10">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-[#f4a390]" />
              <div className="w-3 h-3 rounded-full bg-amber-400/80" />
              <div className="w-3 h-3 rounded-full bg-[#a8f5cc]" />
              <span className="font-mono text-xs font-bold text-zinc-300 ml-2">RECON // LIVE MATCH ROSTER SCOUT</span>
            </div>
            <div className="flex items-center gap-2 font-mono text-[11px]">
              <span className="text-zinc-400">MAP:</span>
              <span className="text-white font-bold">LOTUS (COMPETITIVE)</span>
              <span className="text-zinc-500">•</span>
              <span className="text-[#a8f5cc]">SCORE: 9 - 5</span>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <div>
              <div className="text-xs font-mono text-[#f4a390] font-bold uppercase">Identity Decryptor</div>
              <h3 className="font-display font-black text-xl text-white">Streamer Mode Incognito Bypass</h3>
            </div>
            <button
              type="button"
              onClick={() => setUnmasked(!unmasked)}
              className={`px-4 py-2 rounded-xl text-xs font-mono font-bold flex items-center gap-2 border transition-all cursor-pointer ${
                unmasked
                  ? 'bg-[#f4a390] text-[#1a1118] border-[#f4a390] shadow-[0_0_18px_rgba(244,163,144,0.4)]'
                  : 'bg-white/5 text-zinc-400 border-white/10 hover:border-white/20'
              }`}
            >
              <Eye className="w-4 h-4" />
              <span>{unmasked ? 'STREAMER MODE: UNMASKED' : 'STREAMER MODE: HIDDEN'}</span>
            </button>
          </div>

          {/* Roster Table */}
          <div className="rounded-xl border border-white/10 bg-black/60 overflow-hidden font-mono text-xs">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-white/10 bg-white/[0.02] text-zinc-400 text-[11px]">
                  <th className="p-3">AGENT</th>
                  <th className="p-3">RIOT ID</th>
                  <th className="p-3">ACT RANK</th>
                  <th className="p-3">PEAK</th>
                  <th className="p-3 text-right">K/D</th>
                  <th className="p-3 text-right">HS%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-zinc-300">
                {[
                  {
                    agent: 'Reyna',
                    color: 'text-purple-400',
                    fakeName: 'Anonymous Player #1',
                    realName: '4523461375#4135',
                    rank: 'Immortal 2',
                    peak: 'Radiant #340',
                    kd: '1.45',
                    hs: '34%',
                    rankColor: 'text-red-400',
                  },
                  {
                    agent: 'Jett',
                    color: 'text-cyan-400',
                    fakeName: 'Secret Agent #2',
                    realName: 'ジLeViジ#2113',
                    rank: 'Ascendant 3',
                    peak: 'Immortal 1',
                    kd: '1.28',
                    hs: '29%',
                    rankColor: 'text-emerald-400',
                  },
                  {
                    agent: 'Clove',
                    color: 'text-pink-400',
                    fakeName: 'Incognito User #3',
                    realName: 'ViperSensei#EU1',
                    rank: 'Diamond 2',
                    peak: 'Ascendant 1',
                    kd: '1.04',
                    hs: '22%',
                    rankColor: 'text-purple-300',
                  },
                  {
                    agent: 'Sova',
                    color: 'text-blue-400',
                    fakeName: 'GhostPlayer #4',
                    realName: 'LineupLarry#NA1',
                    rank: 'Diamond 1',
                    peak: 'Diamond 3',
                    kd: '0.98',
                    hs: '26%',
                    rankColor: 'text-purple-300',
                  },
                ].map((row, idx) => (
                  <tr key={idx} className="hover:bg-white/[0.02] transition-colors">
                    <td className={`p-3 font-bold ${row.color}`}>{row.agent}</td>
                    <td className="p-3 font-bold">
                      {unmasked ? (
                        <span className="text-[#f4a390]">{row.realName}</span>
                      ) : (
                        <span className="text-zinc-500 line-through">{row.fakeName}</span>
                      )}
                    </td>
                    <td className={`p-3 font-bold ${row.rankColor}`}>{row.rank}</td>
                    <td className="p-3 text-zinc-400">{row.peak}</td>
                    <td className="p-3 text-right font-bold text-white">{row.kd}</td>
                    <td className="p-3 text-right text-[#a8f5cc]">{row.hs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ScrollStackItem>

        {/* =================================================================== */}
        {/* CARD 3: In-Game Weapon Arsenal & Loadout Scout                       */}
        {/* =================================================================== */}
        <ScrollStackItem itemClassName="border border-[#b6abf7]/30 bg-gradient-to-br from-[#120b1e] via-[#0a0712] to-[#050308] p-6 sm:p-9 shadow-2xl">
          <div className="flex items-center justify-between pb-5 mb-6 border-b border-white/10">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-[#b6abf7]" />
              <div className="w-3 h-3 rounded-full bg-amber-400/80" />
              <div className="w-3 h-3 rounded-full bg-[#a8f5cc]" />
              <span className="font-mono text-xs font-bold text-zinc-300 ml-2">RECON // MATERIAL 3 WEAPON ARSENAL</span>
            </div>
            <div className="font-mono text-[11px] text-[#b6abf7]">
              19 WEAPON SLOTS • CHROMAS • SPRAY WHEEL
            </div>
          </div>

          <div className="mb-6">
            <div className="text-xs font-mono text-[#b6abf7] font-bold uppercase">Core Payload Inspection</div>
            <h3 className="font-display font-black text-xl text-white">Live In-Game Weapon Loadout</h3>
          </div>

          {/* 5-Column Weapon Loadout Grid Preview */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 font-mono text-xs">
            {/* Col 1: Sidearms */}
            <div className="p-3.5 rounded-xl bg-black/50 border border-white/10 flex flex-col justify-between h-56">
              <div className="text-[10px] text-zinc-400 uppercase font-bold border-b border-white/5 pb-1">Sidearms</div>
              <div className="space-y-2 my-auto">
                <div className="p-2 rounded bg-white/5 border border-white/10">
                  <div className="font-bold text-white text-[11px]">Ghost</div>
                  <div className="text-[10px] text-[#b6abf7]">Sovereign Ghost</div>
                </div>
                <div className="p-2 rounded bg-white/5 border border-white/10">
                  <div className="font-bold text-white text-[11px]">Classic</div>
                  <div className="text-[10px] text-zinc-400">Prime Classic</div>
                </div>
              </div>
              <div className="text-[9.5px] text-zinc-400">Tier 4 Chroma</div>
            </div>

            {/* Col 2: SMGs / Shotguns */}
            <div className="p-3.5 rounded-xl bg-black/50 border border-white/10 flex flex-col justify-between h-56">
              <div className="text-[10px] text-zinc-400 uppercase font-bold border-b border-white/5 pb-1">SMGs</div>
              <div className="space-y-2 my-auto">
                <div className="p-2 rounded bg-white/5 border border-white/10">
                  <div className="font-bold text-white text-[11px]">Spectre</div>
                  <div className="text-[10px] text-[#b6abf7]">Recon Spectre</div>
                </div>
                <div className="p-2 rounded bg-white/5 border border-white/10">
                  <div className="font-bold text-white text-[11px]">Judge</div>
                  <div className="text-[10px] text-zinc-400">Glitchpop Judge</div>
                </div>
              </div>
              <div className="text-[9.5px] text-zinc-400">Level 4 Finisher</div>
            </div>

            {/* Col 3: Rifles (Flagship) */}
            <div className="p-3.5 rounded-xl bg-gradient-to-b from-[#1b1228] to-black/70 border border-[#b6abf7]/40 flex flex-col justify-between h-56 shadow-inner">
              <div className="text-[10px] text-[#b6abf7] uppercase font-bold border-b border-[#b6abf7]/20 pb-1">Rifles</div>
              <div className="space-y-2 my-auto">
                <div className="p-2 rounded bg-[#b6abf7]/10 border border-[#b6abf7]/30">
                  <div className="font-bold text-white text-[11px]">Vandal</div>
                  <div className="text-[10px] text-[#a8f5cc] font-bold">Prime 2.0 Vandal</div>
                </div>
                <div className="p-2 rounded bg-[#b6abf7]/10 border border-[#b6abf7]/30">
                  <div className="font-bold text-white text-[11px]">Phantom</div>
                  <div className="text-[10px] text-[#b6abf7]">Magepunk Phantom</div>
                </div>
              </div>
              <div className="text-[9.5px] text-[#a8f5cc]">Equipped Gun Buddy</div>
            </div>

            {/* Col 4: Snipers & Melee */}
            <div className="p-3.5 rounded-xl bg-black/50 border border-white/10 flex flex-col justify-between h-56">
              <div className="text-[10px] text-zinc-400 uppercase font-bold border-b border-white/5 pb-1">Melee & Snipers</div>
              <div className="space-y-2 my-auto">
                <div className="p-2 rounded bg-white/5 border border-white/10">
                  <div className="font-bold text-white text-[11px]">Melee</div>
                  <div className="text-[10px] text-[#f4a390] font-bold">Recon Balisong</div>
                </div>
                <div className="p-2 rounded bg-white/5 border border-white/10">
                  <div className="font-bold text-white text-[11px]">Operator</div>
                  <div className="text-[10px] text-zinc-400">Araxys Operator</div>
                </div>
              </div>
              <div className="text-[9.5px] text-zinc-400">Custom Animation</div>
            </div>

            {/* Col 5: Identity & Spray Wheel */}
            <div className="p-3.5 rounded-xl bg-black/50 border border-white/10 flex flex-col justify-between h-56">
              <div className="text-[10px] text-zinc-400 uppercase font-bold border-b border-white/5 pb-1">Spray Wheel</div>
              <div className="relative w-20 h-20 mx-auto my-auto flex items-center justify-center rounded-full border border-white/10 bg-black/40">
                <div className="absolute top-1 text-[8.5px] text-zinc-400 font-bold">SALT</div>
                <div className="absolute right-1 text-[8.5px] text-zinc-400 font-bold">GG</div>
                <div className="absolute bottom-1 text-[8.5px] text-zinc-400 font-bold">NOOB</div>
                <div className="absolute left-1 text-[8.5px] text-zinc-400 font-bold">REVIVE</div>
                {/* Dark plate + one step lighter violet. The old #b6abf7 glyph sat on a
                    translucent chip that never fully covered the stack behind
                    it, so the text inherited an unpredictable backdrop. With
                    the 90%-opaque plate the composited backdrop is a fixed
                    ~#17122c and #cfc6ff clears 11.3:1 — keep the plate. */}
                <div className="w-6 h-6 rounded-full bg-[#1a1430]/90 border border-[#b6abf7]/50 flex items-center justify-center text-[9px] text-[#cfc6ff]">
                  4x
                </div>
              </div>
              <div className="text-[9.5px] text-zinc-400 text-center truncate">Hog Heaven Card</div>
            </div>
          </div>
        </ScrollStackItem>

        {/* =================================================================== */}
        {/* CARD 4: Transparent HUD Overlay Customizer                           */}
        {/* =================================================================== */}
        <ScrollStackItem itemClassName="border border-[#a8f5cc]/30 bg-gradient-to-br from-[#0e1913] via-[#09110d] to-[#050907] p-6 sm:p-9 shadow-2xl">
          <div className="flex items-center justify-between pb-5 mb-6 border-b border-white/10">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-[#a8f5cc]" />
              <div className="w-3 h-3 rounded-full bg-amber-400/80" />
              <div className="w-3 h-3 rounded-full bg-[#b6abf7]" />
              <span className="font-mono text-xs font-bold text-zinc-300 ml-2">RECON // TRANSPARENT DWM OVERLAY</span>
            </div>
            <div className="flex items-center gap-2 font-mono text-[11px]">
              <span className="text-zinc-400">ENGINE:</span>
              <span className="text-[#a8f5cc] font-bold">DirectComposition • Click-Through</span>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <div>
              <div className="text-xs font-mono text-[#a8f5cc] font-bold uppercase">In-Game HUD Architecture</div>
              <h3 className="font-display font-black text-xl text-white">Interactive Widget Customizer</h3>
            </div>
            {/* Starting Side Toggle (Vanguard Privacy feature requested by user) */}
            <div className="flex items-center gap-3 p-2.5 rounded-xl bg-black/50 border border-white/10 font-mono text-xs">
              <span className="text-zinc-400">Starting Side Indicator:</span>
              <button
                type="button"
                onClick={() => setStartAttack(!startAttack)}
                className={`px-3 py-1 rounded-lg font-bold transition-all cursor-pointer ${
                  startAttack ? 'bg-[#f4a390] text-black' : 'bg-blue-500 text-white'
                }`}
              >
                {startAttack ? 'ATTACK' : 'DEFENSE'}
              </button>
            </div>
          </div>

          {/* Simulated Transparent Overlay Viewport */}
          <div className="relative h-60 rounded-xl border border-dashed border-[#a8f5cc]/40 bg-black/40 overflow-hidden flex items-center justify-center">
            {/* Watermark */}
            <div className="absolute inset-0 flex items-center justify-center opacity-10 pointer-events-none font-display font-black text-6xl text-white">
              VALORANT VIEWPORT
            </div>

            {/* Movable Widget 1: Agent Select */}
            <div className="absolute top-4 left-6 p-3 rounded-lg border border-[#a8f5cc] bg-black/80 text-xs font-mono shadow-lg cursor-move">
              <div className="flex items-center justify-between gap-4 text-[10px] text-[#a8f5cc] border-b border-[#a8f5cc]/30 pb-1 mb-1.5">
                <span>AGENT SELECT WIDGET</span>
                <span className="text-zinc-400">X: 767, Y: 447</span>
              </div>
              <div className="text-white font-bold">Team Top Picks: Jett (68%) • Sova (55%)</div>
            </div>

            {/* Movable Widget 2: Match Status */}
            <div className="absolute bottom-4 right-6 p-3 rounded-lg border border-[#b6abf7] bg-black/80 text-xs font-mono shadow-lg cursor-move">
              <div className="flex items-center justify-between gap-4 text-[10px] text-[#b6abf7] border-b border-[#b6abf7]/30 pb-1 mb-1.5">
                <span>IN-GAME TELEMETRY</span>
                <span className="text-zinc-400">DWM HOOK: 0ms</span>
              </div>
              <div className="text-white font-bold">Loopback Port: 52418 • Lockfile Verified</div>
            </div>
          </div>
        </ScrollStackItem>

        {/* =================================================================== */}
        {/* CARD 5: Performance & Hitbox Distribution Tracker                    */}
        {/* =================================================================== */}
        <ScrollStackItem itemClassName="border border-white/20 bg-gradient-to-br from-[#181126] via-[#0e0a16] to-[#07050b] p-6 sm:p-9 shadow-2xl">
          <div className="flex items-center justify-between pb-5 mb-6 border-b border-white/10">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-[#b6abf7]" />
              <div className="w-3 h-3 rounded-full bg-amber-400/80" />
              <div className="w-3 h-3 rounded-full bg-[#a8f5cc]" />
              <span className="font-mono text-xs font-bold text-zinc-300 ml-2">RECON // COMBAT PERFORMANCE TELEMETRY</span>
            </div>
            <div className="font-mono text-[11px] text-[#a8f5cc]">
              EPISODE 9 : ACT 2 • ASCENDANT 3
            </div>
          </div>

          <div className="mb-6">
            <div className="text-xs font-mono text-[#b6abf7] font-bold uppercase">Hitbox Analytics</div>
            <h3 className="font-display font-black text-xl text-white">Anatomical Hit Distribution</h3>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
            {/* Anatomical Mannequin */}
            <div className="md:col-span-5 p-5 rounded-xl bg-black/50 border border-white/10 flex items-center justify-around">
              <BodyFigure head={28.4} body={63.8} legs={7.8} />
              <div className="space-y-3 font-mono text-xs">
                <div>
                  <div className="text-[10px] text-zinc-400 uppercase">Headshot Accuracy</div>
                  <div className="text-lg font-bold text-[#b6abf7]">28.4% <span className="text-[10px] text-[#a8f5cc]">(Top 2.1%)</span></div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-400 uppercase">Body Hits</div>
                  <div className="text-lg font-bold text-white">63.8%</div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-400 uppercase">Leg Hits</div>
                  <div className="text-lg font-bold text-zinc-400">7.8%</div>
                </div>
              </div>
            </div>

            {/* Combat Metrics Matrix */}
            <div className="md:col-span-7 grid grid-cols-2 gap-3 font-mono text-xs">
              <div className="p-4 rounded-xl bg-black/40 border border-white/10">
                <div className="text-zinc-400 text-[10px] uppercase">Damage / Round (ADR)</div>
                <div className="text-2xl font-bold text-white mt-1">168.4</div>
                <div className="text-[10px] text-[#a8f5cc] mt-1">+24.2 vs Lobby Avg</div>
              </div>

              <div className="p-4 rounded-xl bg-black/40 border border-white/10">
                <div className="text-zinc-400 text-[10px] uppercase">Kill / Death (K/D)</div>
                <div className="text-2xl font-bold text-white mt-1">1.38</div>
                <div className="text-[10px] text-[#a8f5cc] mt-1">1.45 First Blood Ratio</div>
              </div>

              <div className="p-4 rounded-xl bg-black/40 border border-white/10">
                <div className="text-zinc-400 text-[10px] uppercase">Win Ratio</div>
                <div className="text-2xl font-bold text-[#a8f5cc] mt-1">64.2%</div>
                <div className="text-[10px] text-zinc-400 mt-1">42 Matches Recorded</div>
              </div>

              <div className="p-4 rounded-xl bg-black/40 border border-white/10">
                <div className="text-zinc-400 text-[10px] uppercase">Average Combat Score</div>
                <div className="text-2xl font-bold text-white mt-1">264.8</div>
                <div className="text-[10px] text-[#b6abf7] mt-1">Top 4% in Act</div>
              </div>
            </div>
          </div>
        </ScrollStackItem>
      </ScrollStack>
    </section>
  );
}
