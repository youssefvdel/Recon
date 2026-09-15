import React, { useEffect, useState } from 'react';
import { FlaskConical, Play, Trash2, Radio, Coffee, Download, Copy, RotateCcw } from 'lucide-react';
import { listen, emit } from '@tauri-apps/api/event';
import {
  fetchDisplayInfo,
  fetchGpuInfo,
  showOverlay,
  hideOverlay,
  setOverlayEditMode,
  getOverlayEditMode,
  isOverlayVisible,
  isTabDown,
  setOverlayWindowed,
  fetchWindows,
  fetchValorantConfigs,
  isTauri,
} from '../utils/ipc';
import { detectLocalAccount } from '../utils/tracker';
import { ServerChip } from './ServerChip';
import { parseGamePodId, extractGamePodId } from '../utils/matchServer';
import {
  TRN_UA_MAJOR,
  TRN_GAP_MIN_MS,
  TRN_GAP_MAX_MS,
  trnJitterGapMs,
  trnCooldownRemainingMs,
  trnCooldownStepCount,
  resetTrnCooldown,
  isTrackerEnabled,
  setTrackerEnabled,
  fetchTrnActStats,
} from '../utils/trn';
import { logger, getRecentLogs } from '../utils/logger';
import { debugSimulateCrash } from '../utils/consent';
import {
  DEV_MOCK_KEY,
  DEV_TAB_KEY,
  DEV_NO_CLIENT_KEY,
  getDevMockPhase,
  type DevMockPhase,
} from '../utils/devTools';

/* Tracker QA fixtures + helpers (merged from the ex-standalone Dev QA tab). */
const QA_FIXTURES: { id: string; label: string; pod: string | null }[] = [
  { id: 'frankfurt', label: 'Frankfurt EU pod', pod: 'aresriot.aws-rclusterprod-eu2-1.eu-gp-frankfurt-1' },
  { id: 'oregon', label: 'Oregon US pod', pod: 'aresriot.aws-rclusterprod-us2-1.na-gp-oregon-1' },
  { id: 'unknown', label: 'Unknown-format pod', pod: 'aresriot.custom-cluster-9.custompod-xyz' },
  { id: 'absent', label: 'Null / absent', pod: null },
];

const isQaRateLimitMsg = (m: string): boolean =>
  m.includes('RATE_LIMITED') || m.includes('429') || m.includes('403') || m.includes('1015');

const readQaCooldown = (): string => {
  const ms = trnCooldownRemainingMs();
  const step = trnCooldownStepCount();
  return ms > 0
    ? `COOLING — step ${step}, retry in ${Math.ceil(ms / 1000)}s (${ms}ms)`
    : `ready — step ${step}, no cooldown`;
};

/**
 * DEV-BUILDS ONLY dashboard (never reachable in release: the Sidebar entry
 * and App route are both gated on IS_DEV). Test overlay + tracker flows
 * with zero Riot dependency: canned matches, Tab override, client-closed
 * simulation, raw IPC smoke tests, and a live backend event log.
 */
export const DevDashboard: React.FC = () => {
  const [phase, setPhase] = useState<DevMockPhase>(() => getDevMockPhase());
  const [tabHeld, setTabHeld] = useState(() => {
    try {
      return localStorage.getItem(DEV_TAB_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [noClient, setNoClient] = useState(() => {
    try {
      return localStorage.getItem(DEV_NO_CLIENT_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<{ t: string; name: string; payload: string }[]>([]);
  const [windowed, setWindowed] = useState(false);

  /* Tracker QA (merged from the ex-standalone Dev QA tab): manual tests for
   * the tracker disguise work. No secrets shown or logged. */
  const [qaName, setQaName] = useState('TenZ');
  const [qaTag, setQaTag] = useState('0000');
  const [qaFetching, setQaFetching] = useState(false);
  const [qaFetchOut, setQaFetchOut] = useState('');
  const [qaJitterOut, setQaJitterOut] = useState('');
  const [qaCoolOut, setQaCoolOut] = useState(() => readQaCooldown());
  const [qaTrackerOn, setQaTrackerOn] = useState<boolean>(() => {
    try {
      return isTrackerEnabled();
    } catch {
      return true;
    }
  });
  const [qaProbeOut, setQaProbeOut] = useState('');
  const [qaFixtureId, setQaFixtureId] = useState('frankfurt');
  const [qaLogN, setQaLogN] = useState(200);
  const [qaLogOut, setQaLogOut] = useState('');

  const runQaFetch = async (): Promise<void> => {
    if (qaFetching) return;
    setQaFetching(true);
    setQaFetchOut('…');
    const t0 = performance.now();
    try {
      const { stats } = await fetchTrnActStats(qaName.trim(), qaTag.trim());
      const ms = Math.round(performance.now() - t0);
      const matches = stats.wins + stats.losses + stats.ties;
      setQaFetchOut(
        `OK · ${ms}ms · UA Chrome ${TRN_UA_MAJOR} · ${stats.wins}W-${stats.losses}L (${matches} matches) · KD ${stats.kd.toFixed(2)}${ms < 50 ? ' · served fast (likely 6h cache, first fetch per identity is live)' : ''}`
      );
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      const msg = e instanceof Error ? e.message : String(e);
      setQaFetchOut(
        isQaRateLimitMsg(msg)
          ? `RATE LIMITED · ${ms}ms · ${readQaCooldown()}`
          : `ERROR · ${ms}ms · UA Chrome ${TRN_UA_MAJOR} · ${msg}`
      );
    } finally {
      setQaCoolOut(readQaCooldown());
      setQaFetching(false);
    }
  };

  const flipQaTracker = (on: boolean): void => {
    setTrackerEnabled(on);
    setQaTrackerOn(on);
    if (import.meta.env.DEV) logger.log(`[tracker-qa] tracker ${on ? 'ON' : 'OFF'}`);
  };

  const probeQaGate = async (): Promise<void> => {
    const t0 = performance.now();
    // Throwaway identity: never cached, so this always reaches trnGet.
    const probe = `qaprobe${Date.now() % 100000}`;
    try {
      await fetchTrnActStats(probe, 'probe');
      setQaProbeOut(`ON path · ${Math.round(performance.now() - t0)}ms · request went through the serial gate`);
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      const msg = e instanceof Error ? e.message : String(e);
      setQaProbeOut(
        msg.includes('TRN_DISABLED')
          ? `OFF path · ${ms}ms · TRN_DISABLED thrown before any network (same TRN_* shape callers already swallow)`
          : `other · ${ms}ms · ${msg}`
      );
    }
  };

  const downloadQaLogs = (): void => {
    try {
      const lines = getRecentLogs(Math.max(1, Math.min(qaLogN || 200, 500)));
      const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `recon-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setQaLogOut(`downloaded ${lines.length} lines`);
    } catch (e) {
      setQaLogOut(`download failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const copyQaLogs = async (): Promise<void> => {
    const lines = getRecentLogs(Math.max(1, Math.min(qaLogN || 200, 500)));
    const text = lines.join('\n');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setQaLogOut(`copied ${lines.length} lines to clipboard`);
    } catch (e) {
      setQaLogOut(`copy failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const qaFixture = QA_FIXTURES.find((f) => f.id === qaFixtureId) ?? QA_FIXTURES[0];
  const qaParsedLabel =
    qaFixture.pod === null ? null : parseGamePodId(extractGamePodId({ GamePodID: qaFixture.pod }));

  const pickPhase = (p: DevMockPhase) => {
    try {
      if (p === 'off') localStorage.removeItem(DEV_MOCK_KEY);
      else localStorage.setItem(DEV_MOCK_KEY, p);
    } catch {}
    setPhase(p);
  };

  const flip = (key: string, cur: boolean, set: (v: boolean) => void) => {
    const next = !cur;
    try {
      if (next) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
    } catch {}
    set(next);
  };

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setOutputs((o) => ({ ...o, [label]: '…' }));
    try {
      const r = await fn();
      setOutputs((o) => ({ ...o, [label]: JSON.stringify(r, null, 1)?.slice(0, 900) ?? 'ok' }));
    } catch (e) {
      setOutputs((o) => ({ ...o, [label]: `ERROR: ${e instanceof Error ? e.message : String(e)}` }));
    }
  };

  useEffect(() => {
    const names = ['overlay-edit-mode-changed', 'overlay-config-changed', 'display-mode-changed', 'auto-borderless-applied'];
    let alive = true;
    const stops: (() => void)[] = [];
    for (const n of names) {
      listen<unknown>(n, (ev) => {
        if (!alive) return;
        const t = new Date().toLocaleTimeString();
        setEvents((prev) =>
          [{ t, name: n, payload: JSON.stringify(ev.payload)?.slice(0, 220) ?? '' }, ...prev].slice(0, 30)
        );
      })
        .then((fn) => stops.push(fn))
        .catch(() => {});
    }
    return () => {
      alive = false;
      stops.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
    };
  }, []);

  const tests: { label: string; fn: () => Promise<unknown> }[] = [
    { label: 'Display info', fn: fetchDisplayInfo },
    { label: 'GPU info', fn: fetchGpuInfo },
    { label: 'Overlay visible?', fn: isOverlayVisible },
    { label: 'Edit mode?', fn: getOverlayEditMode },
    { label: 'Tab down?', fn: isTabDown },
    { label: 'Open overlay', fn: () => showOverlay().then(() => 'shown') },
    { label: 'Close overlay', fn: () => hideOverlay().then(() => 'hidden') },
    { label: 'Edit mode ON', fn: () => setOverlayEditMode(true).then(() => 'editing') },
    { label: 'Edit mode OFF', fn: () => setOverlayEditMode(false).then(() => 'locked') },
    { label: 'Windows list', fn: fetchWindows },
    { label: 'Valorant configs', fn: fetchValorantConfigs },
    { label: 'Local account', fn: detectLocalAccount },
  ];

  const phases: { id: DevMockPhase; label: string }[] = [
    { id: 'off', label: 'Off (real client)' },
    { id: 'pregame', label: 'Agent Select 5v5' },
    { id: 'coregame', label: 'In Match 5v5' },
    { id: 'deathmatch', label: 'Deathmatch' },
  ];

  return (
    <div className="h-full min-h-0 flex flex-col gap-3.5 max-w-6xl mx-auto w-full overflow-y-auto custom-scrollbar px-4 sm:px-6 py-3.5 pb-10">
      <div className="flex items-center gap-2.5 shrink-0">
        <span className="w-8 h-8 rounded-2xl bg-amber-400/15 border border-amber-400/40 flex items-center justify-center">
          <FlaskConical className="w-4 h-4 text-amber-300" />
        </span>
        <div>
          <h2 className="font-display font-black text-m3-on-surface leading-tight">Dev Dashboard</h2>
          <p className="text-[11px] text-m3-outline">Dev builds only — test overlay + tracker with no Riot open. Live views pick up simulators on next poll.</p>
        </div>
      </div>

      {/* Match simulator */}
      <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-4 shrink-0">
        <h4 className="font-display font-bold text-sm text-m3-on-surface mb-1">Mock live match</h4>
        <p className="text-[11px] text-m3-outline mb-2.5">Feeds Live Match tab + in-game overlay with canned data. Open the overlay + edit HUD to position widgets against it.</p>
        <div className="flex flex-wrap gap-1.5">
          {phases.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => pickPhase(p.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer transition-colors ${
                phase === p.id
                  ? 'bg-m3-primary/20 border-m3-primary text-m3-primary'
                  : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      {/* State simulators */}
      <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-4 shrink-0">
        <h4 className="font-display font-bold text-sm text-m3-on-surface mb-2.5">State overrides</h4>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => flip(DEV_TAB_KEY, tabHeld, setTabHeld)}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer transition-colors ${
              tabHeld ? 'bg-m3-primary/20 border-m3-primary text-m3-primary' : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'
            }`}
          >
            Tab held: {tabHeld ? 'ON (scoreboard shows)' : 'OFF'}
          </button>
          <button
            type="button"
            onClick={() => flip(DEV_NO_CLIENT_KEY, noClient, setNoClient)}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer transition-colors ${
              noClient ? 'bg-m3-coral/15 border-m3-coral/50 text-m3-coral' : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'
            }`}
          >
            Riot closed: {noClient ? 'ON (empty states)' : 'OFF'}
          </button>
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem('recon_clove_coffee_dismissed_until');
              localStorage.setItem('recon_dev_trigger_clove', String(Date.now()));
              window.dispatchEvent(new CustomEvent('recon:trigger-clove-donation'));
              if (isTauri()) {
                emit('recon:trigger-clove-donation', {}).catch(() => {});
              }
            }}
            className="px-3 py-1.5 rounded-xl text-xs font-bold border border-amber-400/40 bg-amber-400/15 text-amber-300 hover:bg-amber-400/25 active:scale-95 cursor-pointer transition-all flex items-center gap-1.5 shadow-xs"
            title="Trigger Clove Ko-fi popup on the main window"
          >
            <Coffee className="w-3.5 h-3.5 text-amber-400" />
            <span>Trigger Clove Ko-fi Popup</span>
          </button>
          <button
            type="button"
            onClick={() => debugSimulateCrash()}
            className="px-3 py-1.5 rounded-xl text-xs font-bold border border-m3-outline-subtle bg-m3-surface-container-low text-m3-outline hover:text-m3-on-surface cursor-pointer transition-colors"
            title="Stage a crash offer without touching the opt-in flag (verifies the CrashOffer UI)"
          >
            Simulate crash offer
          </button>
        </div>
      </section>

      {/* Overlay as window (debug the white bar off-fullscreen) */}
      <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-4 shrink-0">
        <h4 className="font-display font-bold text-sm text-m3-on-surface mb-1">Overlay as window</h4>
        <p className="text-[11px] text-m3-outline mb-2.5">
          Drops the overlay out of fullscreen click-through into a framed 1280×800 window you can move, resize, and dock DevTools against. Toggle back to restore fullscreen HUD.
        </p>
        <button
          type="button"
          onClick={() => {
            const next = !windowed;
            setWindowed(next);
            void setOverlayWindowed(next).catch(() => setWindowed(!next));
          }}
          className={`px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer transition-colors ${
            windowed ? 'bg-m3-primary/20 border-m3-primary text-m3-primary' : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'
          }`}
        >
          Windowed overlay: {windowed ? 'ON' : 'OFF'}
        </button>
      </section>

      {/* IPC smoke tests */}
      <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-4 shrink-0">
        <h4 className="font-display font-bold text-sm text-m3-on-surface mb-2.5">IPC smoke tests</h4>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
          {tests.map((t) => (
            <button
              key={t.label}
              type="button"
              onClick={() => void run(t.label, t.fn)}
              className="px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-m3-surface-container-low border border-m3-outline-subtle text-m3-on-surface hover:border-m3-primary/50 flex items-center gap-1.5 cursor-pointer"
            >
              <Play className="w-3 h-3 text-m3-primary shrink-0" />
              <span className="truncate">{t.label}</span>
            </button>
          ))}
        </div>
        {Object.keys(outputs).length > 0 && (
          <div className="mt-2.5 flex flex-col gap-1.5">
            {Object.entries(outputs).map(([k, v]) => (
              <div key={k} className="rounded-xl bg-zinc-950/80 border border-white/10 p-2">
                <div className="text-[10px] font-mono font-bold text-m3-primary mb-1">{k}</div>
                <pre className="text-[10px] font-mono text-zinc-300 whitespace-pre-wrap break-all max-h-32 overflow-y-auto custom-scrollbar">{v}</pre>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Backend event log */}
      <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-4 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-display font-bold text-sm text-m3-on-surface flex items-center gap-1.5">
            <Radio className="w-3.5 h-3.5 text-m3-primary" />
            <span>Backend events</span>
          </h4>
          <button
            type="button"
            onClick={() => setEvents([])}
            className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-m3-surface-container-low border border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface flex items-center gap-1 cursor-pointer"
          >
            <Trash2 className="w-3 h-3" />
            <span>Clear</span>
          </button>
        </div>
        {events.length === 0 ? (
          <p className="text-[11px] text-m3-outline">No events yet — toggle edit mode, switch resolution, or change HUD config.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {events.map((e, i) => (
              <div key={`${e.t}-${i}`} className="rounded-lg bg-zinc-950/80 border border-white/10 px-2 py-1 font-mono text-[10px] flex gap-2 min-w-0">
                <span className="text-zinc-500 shrink-0">{e.t}</span>
                <span className="text-m3-primary font-bold shrink-0">{e.name}</span>
                <span className="text-zinc-300 truncate">{e.payload}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      {/* Tracker QA (merged from the ex-standalone Dev QA tab) */}
      <section className="rounded-2xl bg-m3-surface-container border border-m3-outline-subtle p-4 shrink-0">
        <h4 className="font-display font-bold text-sm text-m3-on-surface mb-1">Tracker QA</h4>
        <p className="text-[11px] text-m3-outline mb-2.5">
          Manual tests for the tracker disguise work. No secrets are shown or logged here.
          {!isTauri() && ' Open the desktop app (tauri dev) for live fetches.'}
        </p>

        <h5 className="text-xs font-bold text-m3-on-surface mt-3 mb-1.5">Fetch test</h5>
        <p className="text-[11px] text-m3-outline mb-2.5">
          One live profile fetch through the serial gate. First fetch per identity hits the network; repeats may serve the 6h cache.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            value={qaName}
            onChange={(e) => setQaName(e.target.value)}
            placeholder="name"
            aria-label="Riot name"
            className="px-2.5 py-1.5 rounded-xl text-xs font-mono bg-m3-surface-container-low border border-m3-outline-subtle text-m3-on-surface w-32"
          />
          <input
            value={qaTag}
            onChange={(e) => setQaTag(e.target.value)}
            placeholder="tag"
            aria-label="Riot tag"
            className="px-2.5 py-1.5 rounded-xl text-xs font-mono bg-m3-surface-container-low border border-m3-outline-subtle text-m3-on-surface w-24"
          />
          <button
            type="button"
            onClick={() => void runQaFetch()}
            disabled={qaFetching}
            className="px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-m3-surface-container-low border border-m3-outline-subtle text-m3-on-surface hover:border-m3-primary/50 flex items-center gap-1.5 cursor-pointer"
          >
            <Play className="w-3 h-3 text-m3-primary shrink-0" />
            <span>{qaFetching ? 'Fetching…' : 'Fetch profile'}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              const samples = Array.from({ length: 5 }, () => Math.round(trnJitterGapMs()));
              setQaJitterOut(`gaps: ${samples.join(', ')}ms · bounds ${TRN_GAP_MIN_MS}-${TRN_GAP_MAX_MS}ms`);
            }}
            className="px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-m3-surface-container-low border border-m3-outline-subtle text-m3-on-surface hover:border-m3-primary/50 cursor-pointer"
            title="Sample the human-pacing jitter (no network)"
          >
            Sample jitter 5×
          </button>
        </div>
        {qaFetchOut && (
          <div className="mt-2.5 rounded-xl bg-zinc-950/80 border border-white/10 p-2 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-all">{qaFetchOut}</div>
        )}
        {qaJitterOut && (
          <div className="mt-2.5 rounded-xl bg-zinc-950/80 border border-white/10 p-2 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-all">{qaJitterOut}</div>
        )}

        <h5 className="text-xs font-bold text-m3-on-surface mt-3 mb-1.5">Cooldown controls</h5>
        <p className="text-[11px] text-m3-outline mb-2.5">Readout refreshes on fetch/reset — no polling here.</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setQaCoolOut(readQaCooldown())}
            className="px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-m3-surface-container-low border border-m3-outline-subtle text-m3-on-surface hover:border-m3-primary/50 cursor-pointer"
          >
            Refresh readout
          </button>
          <button
            type="button"
            onClick={() => {
              resetTrnCooldown();
              setQaCoolOut(readQaCooldown());
            }}
            className="px-3 py-1.5 rounded-xl text-xs font-bold border border-amber-400/40 bg-amber-400/15 text-amber-300 hover:bg-amber-400/25 active:scale-95 cursor-pointer transition-all flex items-center gap-1.5"
            title="Test-only: clears the TRN rate-limit cooldown immediately"
          >
            <RotateCcw className="w-3 h-3 shrink-0" />
            <span>Reset cooldown (test-only)</span>
          </button>
        </div>
        {qaCoolOut && (
          <div className="mt-2.5 rounded-xl bg-zinc-950/80 border border-white/10 p-2 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-all">{qaCoolOut}</div>
        )}

        <h5 className="text-xs font-bold text-m3-on-surface mt-3 mb-1.5">Tracker kill-switch (v1, local)</h5>
        <p className="text-[11px] text-m3-outline mb-2.5">
          Persisted flag. OFF throws TRN_DISABLED before any network (callers already fall back to Riot-direct); cached data may still
          render. ON restores the byte-identical gate. TopBar pill shows OFF distinctly from cooling.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => flipQaTracker(true)}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer transition-colors ${qaTrackerOn ? 'bg-m3-primary/20 border-m3-primary text-m3-primary' : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'}`}
          >
            Tracker ON
          </button>
          <button
            type="button"
            onClick={() => flipQaTracker(false)}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer transition-colors ${!qaTrackerOn ? 'bg-m3-coral/15 border-m3-coral/50 text-m3-coral' : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'}`}
          >
            Tracker OFF
          </button>
          <button
            type="button"
            onClick={() => void probeQaGate()}
            className="px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-m3-surface-container-low border border-m3-outline-subtle text-m3-on-surface hover:border-m3-primary/50 flex items-center gap-1.5 cursor-pointer"
            title="Throwaway identity (never cached) — always reaches trnGet"
          >
            <Play className="w-3 h-3 text-m3-primary shrink-0" />
            <span>Probe gate (no cache)</span>
          </button>
        </div>
        <div className="mt-2.5 rounded-xl bg-zinc-950/80 border border-white/10 p-2 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-all">
          state: {qaTrackerOn ? 'ON' : 'OFF (TopBar shows Tracker OFF pill)'}
        </div>
        {qaProbeOut && (
          <div className="mt-2.5 rounded-xl bg-zinc-950/80 border border-white/10 p-2 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-all">{qaProbeOut}</div>
        )}

        <h5 className="text-xs font-bold text-m3-on-surface mt-3 mb-1.5">Server chip fixtures</h5>
        <p className="text-[11px] text-m3-outline mb-2.5">Renders the existing {'<ServerChip>'} exactly as LiveMatchView does.</p>
        <div className="flex flex-wrap gap-1.5">
          {QA_FIXTURES.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setQaFixtureId(f.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border cursor-pointer transition-colors ${qaFixtureId === f.id ? 'bg-m3-primary/20 border-m3-primary text-m3-primary' : 'bg-m3-surface-container-low border-m3-outline-subtle text-m3-outline hover:text-m3-on-surface'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="mt-2.5 flex items-center gap-2 min-h-7">
          <ServerChip serverName={qaParsedLabel ?? undefined} />
          {qaParsedLabel === null && (
            <span className="text-[11px] font-mono text-m3-outline border border-dashed border-m3-outline-subtle rounded-full px-2.5 py-1">
              hidden — ServerChip returns null when serverName is absent (menus / no match)
            </span>
          )}
        </div>
        <div className="mt-2.5 rounded-xl bg-zinc-950/80 border border-white/10 p-2 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-all">
          raw: {qaFixture.pod ?? '(absent)'}
          {'\n'}parsed: {qaParsedLabel ?? '(null → renders nothing)'}
        </div>

        <h5 className="text-xs font-bold text-m3-on-surface mt-3 mb-1.5">Log export</h5>
        <p className="text-[11px] text-m3-outline mb-2.5">Last N in-app log lines as text for bug reports (buffer holds max 500, dev-only).</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            value={qaLogN}
            onChange={(e) => setQaLogN(Number(e.target.value) || 0)}
            type="number"
            min={1}
            max={500}
            aria-label="Number of log lines"
            className="px-2.5 py-1.5 rounded-xl text-xs font-mono bg-m3-surface-container-low border border-m3-outline-subtle text-m3-on-surface w-24"
          />
          <button
            type="button"
            onClick={downloadQaLogs}
            className="px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-m3-surface-container-low border border-m3-outline-subtle text-m3-on-surface hover:border-m3-primary/50 flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3 h-3 text-m3-primary shrink-0" />
            <span>Download .txt</span>
          </button>
          <button
            type="button"
            onClick={() => void copyQaLogs()}
            className="px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-m3-surface-container-low border border-m3-outline-subtle text-m3-on-surface hover:border-m3-primary/50 flex items-center gap-1.5 cursor-pointer"
          >
            <Copy className="w-3 h-3 text-m3-primary shrink-0" />
            <span>Copy to clipboard</span>
          </button>
        </div>
        {qaLogOut && (
          <div className="mt-2.5 rounded-xl bg-zinc-950/80 border border-white/10 p-2 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-all">{qaLogOut}</div>
        )}
      </section>
    </div>
  );
};
