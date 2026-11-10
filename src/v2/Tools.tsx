import React, { useEffect, useRef, useState } from 'react';
import { StorePanel } from '../components/StorePanel';
import { CrosshairView } from '../components/CrosshairView';
import { PrepickView } from '../components/PrepickView';
import { RiotChatView } from '../components/RiotChatView';
import { AccountsView } from '../components/AccountsView';
import { UnifiedStretch } from '../components/UnifiedStretch';
import { ResolutionVisualizer } from '../components/ResolutionVisualizer';
import { CustomResolution } from '../components/CustomResolution';
import { HardwareScaling } from '../components/HardwareScaling';
import { NoticeToast } from '../components/NoticeToast';
import { TOOL_SECTIONS, type ToolAnchor } from './nav';
import { useToolsState } from './tools/useToolsState';

/** Tools: one page, six anchored sections, no inner tabs.
 *
 *  A section's body mounts on first visit and is never unmounted — scrolling
 *  away and back must not throw away a store page or a half-typed chat draft.
 *  Nothing here polls until its section has been visited, so opening the sheet
 *  at #store does not start the store, the chat and the account watchers at once.
 *
 *  Headings and hairlines are the only chrome the sheet adds: no cards, no
 *  per-section page headers. Three of the six surfaces still carry their own
 *  full-height scroll shell, so they are given a bounded pane here rather than
 *  being rewritten (their owners are de-carding them in parallel). */

/** Reserved height per unvisited section — roughly what the body measures when
 *  it lands. Without a reservation the page is six headings tall on first paint,
 *  every section sits inside the viewport, and opening the sheet mounts all six
 *  (and a deep link then shifts under the scroll). A reservation is not a
 *  container: no fill, no border, and it disappears the moment the body mounts. */
const RESERVE: Record<ToolAnchor, number> = {
  store: 300,
  crosshair: 700,
  prepick: 700,
  resolution: 1200,
  chat: 700,
  accounts: 700,
};

/** A bounded pane for a surface that needs a fixed viewport to scroll inside
 *  (the chat thread). The others flow with the page: a sheet is one scroll. */
const PANE: React.CSSProperties = { height: '72vh', minHeight: 420 };

const Section: React.FC<{
  id: ToolAnchor;
  label: string;
  /** True when a navigation asked for this section: mount it now, do not wait. */
  force: boolean;
  /** Observers stay off until a deep-link jump has landed, or the sections it
   *  skipped past would mount first and move the target out from under it. */
  armed: boolean;
  children: React.ReactNode;
}> = ({ id, label, force, armed, children }) => {
  const ref = useRef<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);
  const mounted = seen || force;

  /* A navigation-mounted section must STAY mounted after the anchor is
     consumed — force is a request, not the only reason it is on screen. */
  useEffect(() => {
    if (force && !seen) setSeen(true);
  }, [force, seen]);

  useEffect(() => {
    if (mounted || !armed) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [mounted, armed]);

  return (
    <section
      id={id}
      ref={ref}
      data-tools-section={id}
      data-mounted={mounted ? 'true' : 'false'}
      className="mt-10 first:mt-0 scroll-mt-[72px]"
      style={{ minHeight: mounted ? undefined : RESERVE[id] }}
    >
      <h2
        tabIndex={-1}
        className="text-[10px] uppercase tracking-[0.18em] pb-2 outline-none"
        style={{ color: 'var(--on-surface-muted)' }}
      >
        {label}
      </h2>
      <div className="border-b" style={{ borderColor: 'var(--outline)' }} />
      {mounted && <div className="pt-4">{children}</div>}
    </section>
  );
};

export interface ToolsProps {
  /** Section a menu/palette/hash navigation asked for; cleared once applied. */
  anchor: ToolAnchor | null;
  onAnchorApplied: () => void;
}

export const Tools: React.FC<ToolsProps> = ({ anchor, onAnchorApplied }) => {
  const s = useToolsState();
  const [armed, setArmed] = useState(false);

  /* Jump one frame after the forced section painted: the heading exists either
     way, but its body has to be in the flow or the scroll lands past it. Only
     then do the observers arm, so a deep link mounts the section it asked for
     and not the four it skipped over. */
  useEffect(() => {
    if (!anchor) {
      setArmed(true);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(anchor);
      if (el) {
        el.scrollIntoView({ block: 'start', behavior: 'auto' });
        el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
      }
      setArmed(true);
      onAnchorApplied();
    });
    return () => cancelAnimationFrame(frame);
  }, [anchor, onAnchorApplied]);

  return (
    <div className="max-w-[940px] mx-auto w-full px-6 pt-8 pb-16">
      <Section id="store" label={TOOL_SECTIONS[0].label} force={anchor === 'store'} armed={armed}>
        <StorePanel />
      </Section>

      <Section id="crosshair" label={TOOL_SECTIONS[1].label} force={anchor === 'crosshair'} armed={armed}>
        <CrosshairView />
      </Section>

      <Section id="prepick" label={TOOL_SECTIONS[2].label} force={anchor === 'prepick'} armed={armed}>
        <div style={PANE}>
          <PrepickView />
        </div>
      </Section>

      <Section id="resolution" label={TOOL_SECTIONS[3].label} force={anchor === 'resolution'} armed={armed}>
        <div className="flex flex-col gap-8">
          <UnifiedStretch
            displayInfo={s.displayInfo}
            shortcut={s.shortcut}
            preferredStretched={s.preferredStretched}
            onToggle={s.toggle}
            onApplyResolution={s.applyRes}
            onSaveShortcut={s.saveBinding}
            isLoading={s.isLoading}
          />
          <ResolutionVisualizer displayInfo={s.displayInfo} onApplyResolution={s.applyRes} />
          <CustomResolution displayInfo={s.displayInfo} onRefreshDisplayInfo={() => void s.refresh()} />
          <HardwareScaling gpuInfo={s.gpuInfo} onOpenControlPanel={s.openControlPanel} />
        </div>
      </Section>

      <Section id="chat" label={TOOL_SECTIONS[4].label} force={anchor === 'chat'} armed={armed}>
        <div style={PANE}>
          <RiotChatView />
        </div>
      </Section>

      <Section id="accounts" label={TOOL_SECTIONS[5].label} force={anchor === 'accounts'} armed={armed}>
        <AccountsView />
      </Section>

      {s.toast && <NoticeToast key={s.toast} message={s.toast} onClose={s.dismissToast} />}
    </div>
  );
};
