import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import ReconApp from '../../../src/App';
import AppErrorBoundary from './AppErrorBoundary';

/**
 * The pinned scroll-driven tour of the real desktop app.
 *
 * Every stage is the genuine article — <ReconApp /> itself, driven through its
 * own tabs and sub-tabs. The lobby and weapon skins come from the seeded
 * preview payloads (see website/src/previewData.ts + the `!isTauri()` branches
 * in Recon/src/utils/tracker.ts), so PlayerTable, the unmask badges and the
 * LoadoutViewer all run their real code paths. Nothing here is a mock-up.
 */

interface Step {
  id: string;
  badge: string;
  title: string;
  description: string;
}

const skinsButtons = () =>
  Array.from(document.querySelectorAll<HTMLElement>('.recon-app-mount button')).filter(
    (b) => (b.textContent ?? '').trim() === 'Skins'
  );

/**
 * Click a tab/sub-tab in the main pane.
 *
 * Labels collide: "Resolution Switch" is both a sidebar nav item AND a
 * UtilityView sub-tab. Prefer the match that is NOT inside the sidebar, so the
 * tour lands on the actual sub-tab instead of re-selecting the sidebar entry.
 */
const clickSubTab = (label: string) => {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('.recon-app-mount button')
  ).filter((b) => (b.textContent ?? '').trim() === label);
  if (!candidates.length) return;
  const sub = candidates.find((b) => !b.closest('aside'));
  (sub ?? candidates[0]).click();
};

/** The row's Skins button — what the tour clicks next. */
const skinsButton = () => skinsButtons()[0] ?? null;

const STEPS: Step[] = [
  {
    id: 'overview',
    badge: 'MODULE 01 // CAREER TRACKER',
    title: 'Combat Performance & Hitbox Telemetry',
    description: 'Real anatomical hit distribution, ADR, K/D and live Act rankings — pulled straight from the Riot client.',
  },
  {
    id: 'live',
    badge: 'MODULE 02 // STREAMER UNMASKER',
    title: 'Live Match — Real Riot IDs Unmasked',
    description: 'Hidden streamer-mode tags recovered from the account UUID. Every ally and enemy is resolved in real time.',
  },
  {
    id: 'loadout',
    badge: 'MODULE 03 // SKIN INSPECTOR',
    title: "シLeVi's Full Loadout — Every Equipped Skin",
    description: 'Open any player in the lobby to inspect their real equipped skins, player card and expressions.',
  },
  {
    id: 'res_switch',
    badge: 'MODULE 04 // RESOLUTION SWITCH',
    title: 'Instant Display Mode Switching',
    description: 'True Stretch 1.45:1 against Native 16:9 — a hardware-level WDDM mode switch with zero input latency.',
  },
  {
    id: 'stretch',
    badge: 'MODULE 05 // STRETCH PREVIEW',
    title: 'Live Stretch Preview & Sens Matcher',
    description: 'See exactly how targets widen at 1.45:1, with the matching sensitivity calculated for you.',
  },
];

/* The real desktop window. Fixed, because the app's layout assumes it. */
const FRAME_W = 1210;
const FRAME_H = 802;
/* Numbered stage rail in the right gutter. */
/* Numbered stage rail and scroll hint in the right gutter. */
const RAIL_W = 58;
const SCROLL_HINT_W = 44;
const TOTAL_RIGHT_W = RAIL_W + SCROLL_HINT_W;
const RAIL_GAP = 20;
/* Scroll units per stage; the tour reserves one viewport of scroll per stage. */
const STAGES_DIV = 5;
/* Rest slightly inside each stage so boundary rounding can't flip the label. */
const STAGE_BIAS = 0.1;
/* Cap the upscale so the app never balloons absurdly on a huge display.
   High enough that the viewport height, not this, decides the fit. */
const MAX_FIT = 1.8;
/* Sticky offset below the site header, the sticky block's own padding, and the
   header margins (getBoundingClientRect does not include margins). */
/* Fraction of the available height the frame should fill. 0.9 leaves a
   breathing margin under it instead of jamming the viewport edge-to-edge. */
const HEIGHT_FILL = 0.9;
const STICKY_TOP = 68;
const STICKY_PAD_Y = 8;
const HEADER_MARGIN = 8;

export default function AppWalkthrough() {
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const railProgressRef = useRef<HTMLDivElement>(null);
  const railPctRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<((i: number) => void) | null>(null);
  const [activeStep, setActiveStep] = useState(0);

  /* The app is designed for a 1210x800 window. Letting it reflow into a
     narrower frame makes its fixed-width grids overflow and clip on the right,
     so render it at its true size and scale the whole frame down instead —
     the internal layout is then always pixel-correct. */
  const [fit, setFit] = useState(1);
  const fitRef = useRef(fit);
  useEffect(() => {
    fitRef.current = fit;
  }, [fit]);

  /* Scroll-settle state. `settling` guards re-entry; `idle` debounces the
     moment the user actually stops scrolling. */
  const settlingRef = useRef(false);
  const settleWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastYRef = useRef(0);
  const lastTRef = useRef(0);
  const velRef = useRef(0);

  /* Layout effect on purpose: `fit` starts at 1, so the frame would first paint
     at its full 1210x802 and only afterwards shrink to the real scale — a
     visible jump that also registers as layout shift. Measuring inside the
     layout phase corrects the reserved box BEFORE the browser paints, so the
     frame simply appears at its final size. Resizes stay on the rAF path. */
  useLayoutEffect(() => {
    let raf = 0;
    const compute = () => {
      const el = containerRef.current;
      if (!el) return;
      /* Reserve the rail gutter on BOTH sides so the frame stays optically
         centred rather than being nudged left by the rail. */
      const availW = el.clientWidth - 64 - (TOTAL_RIGHT_W + RAIL_GAP) * 2;

      /* Measure the real chrome instead of assuming it — the header wraps to
         two lines on narrow screens, and a stale constant leaves a gap. */
      const headerH = headerRef.current?.offsetHeight ?? 104;
      const chrome = STICKY_TOP + STICKY_PAD_Y * 2 + headerH + HEADER_MARGIN;
      const availH = window.innerHeight - chrome - 2;

      /* No cap at 1: on a tall display the frame scales UP toward the
         viewport height, kept a hair short so it breathes (HEIGHT_FILL)
         instead of jamming the edges like before. */
      const next = Math.min(MAX_FIT, availW / FRAME_W, (availH * HEIGHT_FILL) / FRAME_H);
      setFit(next > 0 ? next : 1);
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(compute);
    };
    compute();
    /* Fonts settle after first paint and change the header's height. Watch the
       real elements so a late reflow can never leave the frame oversized. */
    const ro = new ResizeObserver(schedule);
    if (headerRef.current) ro.observe(headerRef.current);
    window.addEventListener('resize', schedule);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  /** Scroll range the pinned section occupies, and the resting point of each stage. */
  const geometry = useCallback(() => {
    const el = containerRef.current;
    if (!el) return null;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const span = Math.max(1, el.offsetHeight - window.innerHeight);
    const stage = span / STAGES_DIV;
    /* Published so the scroll engine in App.tsx can find the tour's entry and
       soften the arrival instead of letting a fast flick slam into the pin. */
    (window as unknown as { __reconTour?: unknown }).__reconTour = { top, span, stage };
    return { top, span, stage };
  }, []);

  /**
   * Resting scroll position for a stage.
   *
   * Deliberately biased slightly INTO the stage rather than sitting exactly on
   * its boundary: landing on the boundary leaves progress a hair under it after
   * floating-point rounding, so the stage would read as the previous one.
   */
  const restFor = useCallback((g: { top: number; stage: number }, index: number) => {
    return g.top + (index + STAGE_BIAS) * g.stage;
  }, []);

  /* Publish the tour range immediately rather than waiting for the first
     scroll, so the engine can soften the entry on the very first approach. */
  useEffect(() => {
    geometry();
    const onResize = () => geometry();
    window.addEventListener('resize', onResize);
    /* Fonts/images settle after first paint and shift the section's top. */
    const t = setTimeout(geometry, 900);
    return () => {
      window.removeEventListener('resize', onResize);
      clearTimeout(t);
    };
  }, [geometry]);

  /**
   * Soft landing with recoil.
   *
   * Carries the incoming velocity a little PAST the resting point, then eases
   * back to it — a settle, not a snap. Faster scroll = bigger overshoot, so the
   * section absorbs momentum instead of jamming to a halt on arrival.
   */
  const settleTo = useCallback((y: number, velocity: number) => {
    if (settlingRef.current) return;
    settlingRef.current = true;
    /* Watchdog + onInterrupt: the wheel engine overwrites this timeline when the
       user scrolls again, which kills it WITHOUT firing onComplete. Without
       these the guard would stick true and block every later settle. */
    const release = () => {
      settlingRef.current = false;
      if (settleWatchdog.current) clearTimeout(settleWatchdog.current);
    };
    if (settleWatchdog.current) clearTimeout(settleWatchdog.current);
    settleWatchdog.current = setTimeout(release, 2600);

    /* Take ownership of the scroll: a wheel tween may still be running its 1.6s
       glide, and two tweens writing window.scrollTo each frame fight, leaving
       whichever finishes last to win. The tour's settle is the final word. */
    gsap.killTweensOf(window);

    /* Recoil: continue a little past the resting point in the direction of
       travel, then ease back onto it. Faster scroll = further overshoot, so the
       section absorbs momentum instead of jamming to a halt on arrival. */
    const dir = Math.sign(y - window.scrollY) || 1;
    const mag = Math.min(90, Math.abs(velocity) * 12);
    const overshoot = dir * mag;
    const tl = gsap.timeline({
      onUpdate: () => ScrollTrigger.update(),
      onComplete: release,
      onInterrupt: release,
    });
    if (Math.abs(overshoot) > 4) {
      /* glide past … */
      tl.to(window, {
        scrollTo: { y: y + overshoot, autoKill: false },
        duration: 0.42,
        ease: 'power2.out',
      });
    }
    /* … then take its time arriving. */
    tl.to(window, {
      scrollTo: { y, autoKill: false },
      duration: 0.95,
      ease: 'power2.inOut',
    });
  }, []);

  /* Momentum-aware proximity settle: when the user stops near a stage, ease
     onto it. Deliberately generous thresholds so it assists rather than
     hijacks — scrolling straight through is never blocked. */
  useEffect(() => {
    /* Seed the velocity clock, otherwise the very first scroll event divides by
       a page-lifetime delta and reports ~0 velocity (no recoil on first entry). */
    lastYRef.current = window.scrollY;
    lastTRef.current = performance.now();

    const onScroll = () => {
      const now = performance.now();
      const y = window.scrollY;
      /* Clamp dt: a stalled frame must not read as an enormous velocity. */
      const dt = Math.min(64, Math.max(4, now - lastTRef.current));
      const v = (y - lastYRef.current) / dt;
      velRef.current = velRef.current * 0.6 + v * 0.4;
      lastYRef.current = y;
      lastTRef.current = now;

      if (idleRef.current) clearTimeout(idleRef.current);
      idleRef.current = setTimeout(() => {
        const g = geometry();
        if (!g || settlingRef.current) return;
        const local = y - g.top;
        if (local < 0 || local > g.span) return; /* outside the tour */

        const idx = local / g.stage;
        /* Solve for the stage whose biased rest point is nearest. */
        const nearest = Math.round(idx - STAGE_BIAS);
        if (nearest < 0 || nearest >= STEPS.length) return;
        const rest = restFor(g, nearest);
        const distance = Math.abs(y - rest);
        /* Only assist within 40% of a stage — otherwise leave the user alone. */
        if (distance > g.stage * 0.4) return;
        if (distance < 2) {
          velRef.current = 0;
          return;
        }
        settleTo(rest, velRef.current);
        velRef.current = 0;
      }, 170);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (idleRef.current) clearTimeout(idleRef.current);
    };
  }, [geometry, restFor, settleTo]);

  /* Drive the app to the state this stage needs. */
  const applyStep = useCallback(async (index: number) => {
    const step = STEPS[index];

    const clickTab = (label: string) => clickSubTab(label);
    const navigate = (tab: string) =>
      window.dispatchEvent(new CustomEvent('recon_navigate_tab', { detail: tab }));

    /* Any stage other than the loadout must not inherit an open modal. */
    if (index !== 2) {
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(esc);
      window.dispatchEvent(esc);
    }

    if (step.id === 'overview') {
      navigate('overview');
      await new Promise((r) => setTimeout(r, 80));
      clickTab('Overview');
      return;
    }

    if (step.id === 'live' || step.id === 'loadout') {
      navigate('overview');
      await new Promise((r) => setTimeout(r, 100));
      clickTab('Live Match');
      if (step.id === 'loadout') {
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline && !skinsButton()) {
          await new Promise((r) => setTimeout(r, 35));
        }
        skinsButton()?.click();
      }
      return;
    }

    if (step.id === 'res_switch' || step.id === 'stretch') {
      /* Both live under the utility tab. Land on Resolution Switch first,
         then move to Stretch Preview — do NOT jump straight to the preview. */
      navigate('switcher');
      await new Promise((r) => setTimeout(r, 140));
      clickSubTab(step.id === 'stretch' ? 'Stretch Preview' : 'Resolution Switch');
      return;
    }
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let lastIndex = -1;
    let currentRunId = 0;

    const run = (index: number) => {
      const runId = ++currentRunId;
      (async () => {
        /* Soft, clean transition on the demo app frame so tab swaps dissolve
           rather than hard-cutting or flashing. */
        const z = zoomerRef.current;
        if (z) {
          gsap.to(z, { opacity: 0.72, duration: 0.14, ease: 'power2.out' });
        }

        await applyStep(index);
        if (runId !== currentRunId) return;

        /* Let the stage's view paint before fading back in — the live table in
           particular resolves asynchronously. */
        await new Promise((r) => setTimeout(r, 180));
        if (runId !== currentRunId) return;

        if (z) {
          gsap.to(z, { opacity: 1, duration: 0.28, ease: 'power2.out' });
        }
      })();
    };

    const trigger = ScrollTrigger.create({
      trigger: el,
      start: 'top top',
      end: 'bottom bottom',
      scrub: true,
      onUpdate: (self) => {
        const p = self.progress;

        // 1. Demo scrolling progress: track line and percentage readout
        if (railProgressRef.current) {
          railProgressRef.current.style.height = `calc((100% - 32px) * ${p})`;
        }
        if (railPctRef.current) {
          railPctRef.current.textContent = `${Math.round(p * 100)}%`;
        }

        // 2. Smooth stage transition. The settle glide also moves the scroll
        // position, which re-fires this handler — but the step hasn't actually
        // changed, so skip it instead of re-running the transition (the old
        // behaviour re-dimmed the frame to 0.72 mid-settle, i.e. the flicker).
        const step = Math.min(STEPS.length - 1, Math.floor(p * STEPS.length));
        if (step !== lastIndex && !settlingRef.current) {
          lastIndex = step;
          setActiveStep(step);
          if (headerRef.current) {
            gsap.fromTo(
              headerRef.current,
              { opacity: 0.45, y: 3 },
              { opacity: 1, y: 0, duration: 0.28, ease: 'power2.out' }
            );
          }
          run(step);
        }
      },
    });

    runRef.current = run;
    setActiveStep(0);
    run(0);
    if (railProgressRef.current) railProgressRef.current.style.height = '0%';
    if (railPctRef.current) railPctRef.current.textContent = '0%';

    return () => {
      trigger.kill();
    };
  }, [applyStep]);

  /** Rail click: glide to that stage's resting point (same soft recoil). */
  const goToStage = useCallback(
    (index: number) => {
      const g = geometry();
      if (!g) return;
      setActiveStep(index);
      runRef.current?.(index);
      settleTo(restFor(g, index), 0);
    },
    [geometry, restFor, settleTo]
  );

  const current = STEPS[activeStep];

  return (
    <section
      id="app-walkthrough"
      ref={containerRef}
      className="relative z-10 w-full"
      style={{ minHeight: `${STEPS.length * 100}vh` }}
    >
      {/* top-[68px] clears the 65px sticky site header with a small gap. The
          chrome below is deliberately tight: the app frame must keep its full
          802px or the app's own panes start scrolling internally. */}
      <div className="sticky top-[68px] w-full max-w-[2200px] mx-auto px-4 sm:px-6 lg:px-8 py-2">
        {/* Header row: aligned to start exactly where the demo app frame starts */}
        <div className="flex justify-center mb-2">
          {/* symmetric spacer matches the frame's left spacer */}
          <div aria-hidden="true" style={{ width: TOTAL_RIGHT_W + RAIL_GAP }} className="shrink-0" />

          {/* Header content box: starts at the exact X coordinate where the demo frame starts */}
          <div style={{ width: FRAME_W * fit }} className="shrink-0">
            <div ref={headerRef} className="min-h-[110px]">
              <div className="flex items-center gap-2 font-mono text-xs text-[#b6abf7] font-bold uppercase tracking-wider">
                <span>{current.badge}</span>
                <span className="text-zinc-400">•</span>
                <span className="text-[#a8f5cc]">
                  STEP {activeStep + 1} OF {STEPS.length}
                </span>
              </div>
              <h2 className="font-display font-black text-2xl sm:text-4xl text-white tracking-tight mt-1 text-balance">
                {current.title}
              </h2>
              <p className="text-xs sm:text-sm text-zinc-400 mt-1 max-w-3xl line-clamp-2">{current.description}</p>
            </div>
          </div>

          {/* symmetric spacer matches the rail + scroll hint on the right */}
          <div aria-hidden="true" style={{ width: TOTAL_RIGHT_W, marginLeft: RAIL_GAP }} className="shrink-0" />
        </div>

        {/* Fixed at the real window size, then scaled to fit the viewport. The
            outer box reserves the SCALED footprint so the page lays out around
            it; the inner box is the untouched 1210x802 app. */}
        <div className="flex items-center justify-center">
          {/* symmetric spacer keeps the frame optically centred beside the rail */}
          <div aria-hidden="true" style={{ width: TOTAL_RIGHT_W + RAIL_GAP }} className="shrink-0" />

          <div className="mx-0" style={{ width: FRAME_W * fit, height: FRAME_H * fit }}>
            <div
              className="recon-app-mount rounded-2xl border border-m3-outline-subtle bg-m3-surface overflow-hidden shadow-[0_30px_90px_rgba(0,0,0,0.85)] relative flex flex-col"
              style={{
                width: FRAME_W,
                height: FRAME_H,
                transform: `scale(${fit})`,
                transformOrigin: '0 0',
              }}
            >
              <AppErrorBoundary>
                <div ref={zoomerRef} className="relative w-full h-full">
                  {/* Explicit host so the w-screen/h-screen override in index.css
                      can't silently stop matching when this tree changes. */}
                  <div className="recon-app-host w-full h-full">
                    <ReconApp />
                  </div>
                </div>
              </AppErrorBoundary>
            </div>
          </div>

          {/* ── Stage rail: vertical numbered timeline + scroll instruction ── */}
          <div
            className="shrink-0 flex items-center self-center my-auto"
            style={{ width: TOTAL_RIGHT_W, marginLeft: RAIL_GAP }}
          >
            {/* Step rail + live percentage */}
            <div className="flex flex-col items-center justify-center" style={{ width: RAIL_W }}>
              <div className="relative w-full h-[320px] flex flex-col items-center justify-between">
                {/* Continuous background track line */}
                <div className="absolute left-1/2 -translate-x-1/2 top-4 bottom-4 w-[2px] bg-white/[0.12] rounded-full pointer-events-none" />

                {/* Continuous live filled progress line */}
                <div
                  ref={railProgressRef}
                  className="absolute left-1/2 -translate-x-1/2 top-4 w-[2px] bg-gradient-to-b from-[#b6abf7] via-[#a8f5cc] to-[#b6abf7] rounded-full shadow-[0_0_8px_rgba(182,171,247,0.8)] pointer-events-none origin-top"
                  style={{ height: '0%' }}
                />

                {STEPS.map((step, i) => {
                  const isActive = i === activeStep;
                  const isDone = i < activeStep;
                  return (
                    <button
                      key={step.id}
                      type="button"
                      onClick={() => goToStage(i)}
                      title={`${i + 1}. ${step.title}`}
                      aria-label={`Go to stage ${i + 1}: ${step.title}`}
                      aria-current={isActive ? 'step' : undefined}
                      className={`relative z-10 shrink-0 rounded-full font-mono font-bold transition-all duration-300 cursor-pointer flex items-center justify-center ${
                        isActive
                          ? 'w-8 h-8 text-[12px] bg-[#b6abf7] text-[#2b1d47] shadow-[0_0_18px_rgba(182,171,247,0.7)] scale-110 ring-2 ring-[#b6abf7]/50 ring-offset-2 ring-offset-[#09060d]'
                          : isDone
                            ? 'w-7 h-7 text-[11px] bg-[#221a33] text-[#b6abf7] border border-[#b6abf7]/50 hover:bg-[#2e2345] shadow-[0_0_8px_rgba(182,171,247,0.25)]'
                            : 'w-7 h-7 text-[11px] bg-[#140e1b] text-zinc-400 border border-white/[0.14] hover:text-white hover:border-white/30'
                      }`}
                    >
                      {i + 1}
                    </button>
                  );
                })}
              </div>

              {/* Live progress percentage readout */}
              <div
                ref={railPctRef}
                data-rail-pct="true"
                className="mt-3 font-mono text-[10px] text-[#b6abf7] tracking-widest uppercase opacity-75 select-none"
              >
                0%
              </div>
            </div>

            {/* Scroll down instruction (as drawn in red marker) */}
            <div
              className="ml-2 flex flex-col items-center justify-center gap-1.5 select-none pointer-events-none"
              style={{ width: SCROLL_HINT_W }}
            >
              <span className="font-mono text-[9px] uppercase tracking-widest text-[#cfc6ff] font-bold">
                SCROLL
              </span>
              <div className="h-28 w-[1.5px] bg-gradient-to-b from-[#b6abf7]/80 via-[#a8f5cc] to-transparent rounded-full relative my-1">
                <svg
                  className="w-3.5 h-3.5 text-[#a8f5cc] absolute -bottom-3 left-1/2 -translate-x-1/2 animate-bounce"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
