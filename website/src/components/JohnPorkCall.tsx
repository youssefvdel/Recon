import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Phone, PhoneOff, Volume2, Sparkles } from 'lucide-react';
import gsap from 'gsap';

interface JohnPorkCallProps {
  onDownload: () => void;
  version: string;
}

const ROASTS = [
  'are u gonna get immortall with me gang',
  'skill issue',
  'i bit u need the tracker to improve',
  'your headshot rate should be below 10%',
  'bro is really trying to decline immortal 💀',
  'enjoy hardstuck ascendant forever 😭',
  'even my snout has better crosshair placement 💅',
  'who you gonna blame now? your sensitivity? 🧐',
  'nice spray transfer against the wall lil bro 😼',
  'your teammates are praying you download this 💀',
  'radiant is calling and you are pressing decline? 💀',
  '0.6 KD detected. do not decline 😭',
  'buying an Odin won\'t fix your aim gang 😌',
  'bottom frag energy is crazy right now ',
];

export default function JohnPorkCall({ onDownload, version }: JohnPorkCallProps) {
  const [roastIndex, setRoastIndex] = useState(0);
  const [dodgeCount, setDodgeCount] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const [bubbleKey, setBubbleKey] = useState(0);
  const [isFleeing, setIsFleeing] = useState(false);

  const declineRef = useRef<HTMLDivElement>(null);
  const posRef = useRef({ x: 0, y: 0 });
  const lastRoastTimeRef = useRef(0);
  const fleeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFleeStartRef = useRef(0);

  // Smooth continuous fleeing evasion physics
  const fleeFromCursor = useCallback((cursorX: number, cursorY: number) => {
    if (accepted || !declineRef.current) return;
    // Cooldown: one clean jump per approach. Without this every mousemove
    // pixel restarts the tween mid-flight, so the button jitters and sticks
    // to the cursor instead of escaping it.
    const now0 = Date.now();
    if (now0 - lastFleeStartRef.current < 450) return;
    const btn = declineRef.current;
    const r = btn.getBoundingClientRect();
    const bx = r.left + r.width / 2;
    const by = r.top + r.height / 2;

    const dx = bx - cursorX;
    const dy = by - cursorY;
    const dist = Math.hypot(dx, dy);

    // Proximity radius: start running when cursor gets within 160px
    const PROXIMITY = 160;
    if (dist < PROXIMITY) {
      lastFleeStartRef.current = now0;
      setIsFleeing(true);
      if (fleeTimeoutRef.current) clearTimeout(fleeTimeoutRef.current);
      fleeTimeoutRef.current = setTimeout(() => setIsFleeing(false), 500);

      // Trigger roast update with rate-limit so it paces naturally
      const now = Date.now();
      if (now - lastRoastTimeRef.current > 650) {
        lastRoastTimeRef.current = now;
        setRoastIndex((i) => (i + 1) % ROASTS.length);
        setDodgeCount((c) => c + 1);
        setBubbleKey((k) => k + 1);
      }

      // One leap must clear the proximity radius, or the next mousemove
      // re-triggers instantly and it vibrates on the cursor.
      const angle = Math.atan2(dy, dx);
      const pushDist = Math.max(260, (PROXIMITY - dist) * 2.2 + 140);

      let targetX = posRef.current.x + Math.cos(angle) * pushDist;
      let targetY = posRef.current.y + Math.sin(angle) * pushDist;

      // Arena boundary limits — wide playground so it roams freely
      const LIMIT_X = 700;
      const LIMIT_Y = 240;

      if (targetX > LIMIT_X) targetX = -LIMIT_X * 0.7;
      else if (targetX < -LIMIT_X) targetX = LIMIT_X * 0.7;

      if (targetY > LIMIT_Y) targetY = -LIMIT_Y * 0.7;
      else if (targetY < -LIMIT_Y) targetY = LIMIT_Y * 0.7;

      // Sprint tilt lean: rotates in the direction it runs (from current spot).
      const tilt = Math.max(-18, Math.min(18, Math.cos(angle) * 14));

      // Keep it on-stage: clamp the landing spot inside the section so it can
      // never get stuck off-screen where the cursor can't reach it again.
      // Origin = current center minus accumulated offset.
      const stage = document.getElementById('john-pork-call')?.getBoundingClientRect();
      if (stage) {
        const ox = bx - posRef.current.x;
        const oy = by - posRef.current.y;
        const M = 70;
        const cx = Math.max(stage.left + M, Math.min(stage.right - M, ox + targetX));
        const cy = Math.max(stage.top + M, Math.min(stage.bottom - M, oy + targetY));
        targetX = cx - ox;
        targetY = cy - oy;
      }
      posRef.current = { x: targetX, y: targetY };

      gsap.to(btn, {
        x: targetX,
        y: targetY,
        rotation: tilt,
        duration: 0.42,
        ease: 'power2.out',
        overwrite: 'auto',
        onComplete: () => {
          gsap.to(btn, { rotation: 0, duration: 0.2, ease: 'power1.out' });
        },
      });
    }
  }, [accepted]);

  // Global mousemove tracking for smooth reactive running
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      fleeFromCursor(e.clientX, e.clientY);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        fleeFromCursor(e.touches[0].clientX, e.touches[0].clientY);
      }
    };

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('touchmove', onTouchMove);
      if (fleeTimeoutRef.current) clearTimeout(fleeTimeoutRef.current);
    };
  }, [fleeFromCursor]);

  const handleAccept = () => {
    setAccepted(true);
    setBubbleKey((k) => k + 1);
    onDownload();
  };

  const currentMessage = accepted
    ? 'W GANG! WE HITTING IMMORTAL 3 TONIGHT 👑'
    : ROASTS[roastIndex];

  return (
    <section
      id="john-pork-call"
      className="relative z-10 w-full min-h-[420px] sm:min-h-[440px] overflow-hidden flex flex-col justify-between pt-2 sm:pt-3 pb-8 sm:pb-12 pl-0 pr-4 sm:pr-4 lg:pr-4 select-none"
    >
      {/* Precision ambient background glow */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[500px] bg-[#ff4655]/10 rounded-full blur-[160px] pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-[550px] h-[550px] bg-[#b6abf7]/15 rounded-full blur-[150px] pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-[450px] h-[450px] bg-[#a8f5cc]/10 rounded-full blur-[150px] pointer-events-none" />

      {/* ── TOP: Incoming Call Header — left, tight to John's photo ── */}
      <div className="relative z-20 w-full flex flex-col items-center text-center lg:items-start lg:text-left lg:pl-6">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#ff4655]/15 border border-[#ff4655]/30 text-xs font-mono font-bold text-[#ff4655] mb-3">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[#ff4655] shadow-[0_0_8px_#ff4655]" />
          </span>
          <span>{accepted ? 'CALL CONNECTED' : 'INCOMING CALL...'}</span>
        </div>

        <div className="inline-flex flex-col">
          <h2 className="font-display font-black text-4xl sm:text-6xl text-white tracking-tight drop-shadow-md self-start">
            Immortal John Pork
          </h2>
          <p className="mt-1 font-sans text-lg sm:text-2xl text-zinc-400 font-normal tracking-wide animate-pulse text-center">
            {accepted ? 'Connected • Radiant Lobby' : 'is calling...'}
          </p>
        </div>
      </div>

      {/* ── MAIN ROW: spacer + Full Comparison Table flush right ── */}
      <div className="relative z-20 w-full grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6 items-center my-0 sm:my-1">
        {/* Left Spacer on desktop to reserve space for John Pork + bubble */}
        <div className="hidden lg:block lg:col-span-5 pointer-events-none" />

        {/* Right: Big & Clear Comparison Table */}
        <div className="lg:col-span-7 flex justify-center lg:justify-center lg:pr-0">
          <div className="w-full max-w-2xl lg:max-w-3xl rounded-2xl border border-white/15 bg-[#120d1c]/95 backdrop-blur-xl p-5 sm:p-6 shadow-[0_25px_60px_rgba(0,0,0,0.9)]">
            <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-3">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 px-2.5 py-1 rounded-xl bg-white/[0.05] border border-white/10">
                  <picture>
                    <source srcSet="/recon-mark.webp" type="image/webp" />
                    {/* Decorative: the "Recon {version}" label beside it already
                        names the brand, so the mark is hidden from the tree. */}
                    <img
                      src="/recon-mark.webp"
                      alt=""
                      aria-hidden="true"
                      className="w-6 h-6 object-contain"
                      draggable={false}
                    />
                  </picture>
                  <span className="font-mono text-xs sm:text-sm font-black uppercase tracking-wider text-white">
                    Recon {version}
                  </span>
                </div>
                <span className="font-mono text-xs font-bold text-zinc-400">VS</span>
                <div className="flex items-center gap-2 px-2.5 py-1 rounded-xl bg-white/[0.05] border border-white/10">
                  {/* Decorative: the adjacent "Overwolf" label already names it. */}
                  <img
                    src="/overwolf-logo.png"
                    alt=""
                    aria-hidden="true"
                    className="w-6 h-6 object-contain opacity-85 filter drop-shadow-[0_0_8px_rgba(255,255,255,0.2)]"
                    draggable={false}
                  />
                  <span className="font-mono text-xs sm:text-sm font-black uppercase tracking-wider text-zinc-400">
                    Overwolf
                  </span>
                </div>
              </div>
              <span className="hidden sm:inline px-2.5 py-1 rounded bg-[#b6abf7]/15 border border-[#b6abf7]/30 text-[10px] font-mono font-bold text-[#b6abf7] uppercase tracking-wider">
                Full Benchmark Telemetry
              </span>
            </div>

            {/* Comprehensive Comparison Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm sm:text-[15px] font-mono border-collapse">
                <thead>
                  <tr className="border-b border-white/10 text-zinc-400 text-xs uppercase">
                    <th className="pb-2 font-bold">Parameter</th>
                    <th className="pb-2 font-bold text-[#a8f5cc]">
                      <span className="inline-flex items-center gap-1.5">
                        <img src="/recon-mark.webp" alt="" aria-hidden="true" className="w-3.5 h-3.5 object-contain" />
                        <span>Recon</span>
                      </span>
                    </th>
                    <th className="pb-2 font-bold text-red-400 text-right">
                      <span className="inline-flex items-center justify-end gap-1.5">
                        <span>Overwolf</span>
                        <img src="/overwolf-logo.png" alt="" aria-hidden="true" className="w-3.5 h-3.5 object-contain opacity-75" />
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-sm sm:text-[14px]">
                  {/* Row 1: Spyware & Telemetry */}
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-2 pr-2 text-zinc-300 font-semibold">Spyware &amp; Tracking</td>
                    <td className="py-2 px-2 text-[#a8f5cc] font-bold">Zero Spyware (0% Tracking)</td>
                    <td className="py-2 pl-2 text-red-400 font-bold text-right">Heavy Spyware &amp; Tracking</td>
                  </tr>

                  {/* Row 2: Runtime Engine */}
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-2 pr-2 text-zinc-300 font-semibold">Runtime Engine</td>
                    <td className="py-2 px-2 text-[#a8f5cc] font-bold">Rust + Tauri (Native GDI)</td>
                    <td className="py-2 pl-2 text-red-400 font-medium text-right">Chromium CEF Bloatware</td>
                  </tr>

                  {/* Row 3: Idle RAM */}
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-2 pr-2 text-zinc-300 font-semibold">Idle RAM Usage</td>
                    <td className="py-2 px-2 text-[#a8f5cc] font-bold">~35 MB</td>
                    <td className="py-2 pl-2 text-red-400 font-medium text-right">650 MB – 1.4 GB</td>
                  </tr>

                  {/* Row 4: Input Latency */}
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-2 pr-2 text-zinc-300 font-semibold">Input Latency</td>
                    <td className="py-2 px-2 text-[#a8f5cc] font-bold">0.00 ms (Direct Hardware)</td>
                    <td className="py-2 pl-2 text-red-400 font-medium text-right">+4ms to +11ms (Hook Layer)</td>
                  </tr>

                  {/* Row 5: In-Game Ads */}
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-2 pr-2 text-zinc-300 font-semibold">In-Game Advertising</td>
                    <td className="py-2 px-2 text-[#a8f5cc] font-bold">Zero (100% Ad-Free)</td>
                    <td className="py-2 pl-2 text-red-400 font-medium text-right">Aggressive Video &amp; Banners</td>
                  </tr>

                  {/* Row 6: True Stretched 1.45:1 */}
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-2 pr-2 text-zinc-300 font-semibold">True Stretched 1.45:1</td>
                    <td className="py-2 px-2 text-[#a8f5cc] font-bold">Native Hotkey Switcher</td>
                    <td className="py-2 pl-2 text-red-400 font-medium text-right">Unsupported</td>
                  </tr>

                  {/* Row 7: Vanguard Safety */}
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-2 pr-2 text-zinc-300 font-semibold">Vanguard Anti-Cheat</td>
                    <td className="py-2 px-2 text-[#a8f5cc] font-bold">100% Loopback (Safe)</td>
                    <td className="py-2 pl-2 text-red-400 font-medium text-right">Process Hook Injection</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* ── BOTTOM-LEFT: call buttons under the bubble, next to John ── */}
      <div className="relative z-20 w-full flex justify-start my-6 sm:my-8 lg:pl-[470px]">
        <div className="relative min-h-[110px] w-full max-w-lg flex items-center justify-start gap-[90px] px-4 translate-y-4 sm:translate-y-6">
          {/* 1. ACCEPT (green) */}
          <div className="flex flex-col items-center gap-2 relative z-20">
            <button
              type="button"
              onClick={handleAccept}
              className="relative group w-18 h-18 sm:w-20 sm:h-20 rounded-full bg-gradient-to-b from-[#22c55e] to-[#15803d] hover:from-[#4ade80] hover:to-[#16a34a] text-white flex items-center justify-center shadow-[0_0_40px_rgba(34,197,94,0.65)] hover:shadow-[0_0_60px_rgba(34,197,94,0.9)] cursor-pointer active:scale-95 transition-all animate-pulse"
              aria-label="Accept Call and Download"
            >
              <Phone className="w-8 h-8 sm:w-9 sm:h-9 stroke-[2.2] animate-bounce" />
            </button>
            <span className="font-sans text-xs sm:text-sm text-emerald-400 font-bold tracking-wide flex items-center gap-1">
              <span>Accept</span>
              <Sparkles className="w-3.5 h-3.5 text-emerald-300" />
            </span>
          </div>

          {/* 2. HARDSTUCK (red) — free-roam evasion (global mousemove drives it,
              no per-element handlers so it can't double-trigger and stick) */}
          <div
            ref={declineRef}
            className="flex flex-col items-center gap-2 relative z-30 select-none cursor-pointer"
          >
            <button
              type="button"
              className={`w-18 h-18 sm:w-20 sm:h-20 rounded-full bg-gradient-to-b from-[#ef4444] to-[#b91c1c] text-white flex items-center justify-center shadow-[0_0_35px_rgba(239,68,68,0.6)] cursor-pointer active:scale-95 transition-shadow ${
                isFleeing ? 'ring-4 ring-red-400/40' : ''
              }`}
              aria-label="Decline Call"
            >
              <PhoneOff className="w-8 h-8 sm:w-9 sm:h-9 stroke-[2.2]" />
            </button>
            <span className="font-sans text-xs sm:text-sm text-red-400 font-bold tracking-wide flex items-center gap-1">
              <span>{isFleeing ? 'Hardstuck' : dodgeCount > 3 ? 'Hardstuck' : 'Decline'}</span>
            </span>
          </div>
        </div>
      </div>

      {/* ── FAR-LEFT: John Pork Flush Against Left Border with Mouth Speech Bubble ── */}
      <div className="absolute bottom-0 left-0 z-10 w-[300px] sm:w-[380px] lg:w-[440px] pointer-events-none">
        <div className="relative w-full">
          {/* ── Speech Bubble to the RIGHT of head, tail to mouth corner ── */}
          <div
            key={bubbleKey}
            className="pointer-events-auto absolute z-30 w-[280px] sm:w-[360px] max-w-[90vw] rounded-2xl rounded-bl-xs border-2 border-[#b6abf7] bg-[#160e24]/95 backdrop-blur-md p-3 sm:p-4 shadow-[0_16px_40px_rgba(0,0,0,0.85),0_0_25px_rgba(182,171,247,0.35)] animate-in fade-in zoom-in-95 duration-200"
            style={{
              left: '102%',
              top: '30%',
            }}
          >
            {/* Tail on LEFT edge, mid-height — points left into mouth corner */}
            <div className="absolute -left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 bg-[#160e24] border-b-2 border-l-2 border-[#b6abf7] transform rotate-45" />

            <div className="flex items-center gap-1.5 mb-1 text-[9.5px] font-mono font-bold text-[#a8f5cc] uppercase tracking-wider">
              <Volume2 className="w-3.5 h-3.5 text-[#a8f5cc]" />
              <span>John Pork:</span>
            </div>

            <p className="font-display font-extrabold text-xs sm:text-sm text-white leading-snug tracking-tight">
              &ldquo;{currentMessage}&rdquo;
            </p>

            {dodgeCount > 0 && !accepted && (
              <div className="mt-2 pt-1 border-t border-white/10 flex items-center justify-between text-[9px] font-mono text-[#cfc6ff]">
                <span>Dodges: {dodgeCount}</span>
                <span className="text-red-400 font-bold">Refused</span>
              </div>
            )}
          </div>

          {/* John Pork image sitting flush at the absolute bottom-left corner */}
          <picture>
            <source srcSet="/john-pork.webp" type="image/webp" />
            {/* Intrinsic size is declared so the browser reserves the box before
                the bitmap arrives. Both sources are 1:1 (webp 230x230, png
                1254x1254), so one pair of attributes covers either choice —
                without it the image pops in and drags the speech bubble down
                with it, which is pure layout shift. */}
            <img
              src="/john-pork.png"
              alt="Immortal John Pork"
              width={1254}
              height={1254}
              className="w-full h-auto object-contain block drop-shadow-[0_20px_60px_rgba(0,0,0,0.95)] filter brightness-105"
              draggable={false}
            />
          </picture>
        </div>
      </div>
    </section>
  );
}
