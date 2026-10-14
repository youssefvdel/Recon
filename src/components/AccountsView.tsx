import React, { useCallback, useEffect, useState } from 'react';
import { Users, RefreshCw, ArrowLeftRight, Trash2, Check, UserPlus, MonitorCog, ChevronDown, HardDrive, ShieldCheck, FileKey2 } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import {
  accountsList,
  accountCurrent,
  accountsAutoTick,
  accountsGetAutoStart,
  accountsSetAutoStart,
  accountAddNew,
  accountSwitch,
  accountRemove,
  fmtWhen,
  type AccountMeta,
  type AccountsProgress,
} from '../utils/accounts';
import { readAccountVideo, type ConfigAccountCtx } from '../utils/accountVideo';

/** What's inside every snapshot — mirrors SWAP_ENTRIES in accounts.rs. */
const SNAPSHOT_FILES = ['Cookies', 'Sessions', 'RiotClientPrivateSettings.yaml', 'RiotGamesPrivateSettings.yaml', 'RiotClientSettings.yaml'];

const fmtBytes = (n: number): string => {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};

const STEP_LABELS: Record<string, string[]> = {
  switch: ['kill', 'save', 'restore', 'relaunch', 'done'],
  add: ['kill', 'save', 'clear', 'relaunch', 'done'],
};

const STEP_TITLES: Record<string, string> = {
  kill: 'Closing Riot Client',
  save: 'Parking current login',
  restore: 'Swapping saved session in',
  clear: 'Wiping live session',
  relaunch: 'Relaunching client',
  done: 'Done',
};

/* ------------------------------------------------------------------ */
/* Accounts tab — quick-switch Riot logins without logout/login.       */
/* Pixels and confirms only: Rust owns snapshots, kills, swaps,        */
/* relaunch. Switching closes the Riot Client (and the game if open)   */
/* after auto-saving the current login — hence the two-click guards.   */
/* ------------------------------------------------------------------ */

export const AccountsView: React.FC<{
  onEditConfig?: (account: ConfigAccountCtx) => void;
}> = ({ onEditConfig }) => {
  const [accounts, setAccounts] = useState<AccountMeta[]>([]);
  const [liveId, setLiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [armSwitch, setArmSwitch] = useState<string | null>(null);
  const [armRemove, setArmRemove] = useState<string | null>(null);
  const [armNew, setArmNew] = useState(false);
  const [autoStart, setAutoStart] = useState(true);
  const [progress, setProgress] = useState<AccountsProgress | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, live] = await Promise.all([
        accountsList(),
        accountCurrent().catch(() => null),
      ]);
      setAccounts(list);
      setLiveId(live);
    } catch {
      setNote({ ok: false, text: 'Could not read the vault.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    accountsGetAutoStart()
      .then(setAutoStart)
      .catch(() => {});
    // Long switch/add operations narrate themselves from Rust.
    let unlisten: (() => void) | undefined;
    listen<AccountsProgress>('recon:accounts-progress', (e) => {
      setProgress(e.payload.step === 'done' ? null : e.payload);
      if (e.payload.step === 'done') {
        // Refresh right as the ritual lands.
        setTimeout(() => load(), 1200);
      }
    })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, [load]);

  // Autopilot: Rust notices new logins and refreshes stale credentials by
  // itself — the UI just re-renders and mentions what changed. Silent when
  // the binary predates the tick command (pre-rebuild) or the client is shut.
  useEffect(() => {
    let dead = false;
    const tick = async () => {
      // Hidden-tab skip: the tab is unmounted at idle overview anyway; this
      // covers idling with the accounts tab open in a hidden window.
      if (typeof document !== 'undefined' && document.hidden) return;
      const r = await accountsAutoTick();
      if (dead || !r || !r.changed) return;
      await load();
      if (dead) return;
      setNote({
        ok: true,
        text: r.is_new
          ? `${r.current} signed in — auto-saved to the list.`
          : `Credentials renewed for ${r.current}.`,
      });
    };
    tick();
    const onVis = () => {
      if (typeof document === 'undefined' || document.hidden) return;
      void tick();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVis);
      window.addEventListener('focus', onVis);
    }
    const id = setInterval(tick, 30000);
    return () => {
      dead = true;
      clearInterval(id);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('focus', onVis);
      }
    };
  }, [load]);

  // Two-click guards disarm shortly after arming.
  useEffect(() => {
    if (!armSwitch && !armRemove && !armNew) return;
    const id = setTimeout(() => {
      setArmSwitch(null);
      setArmRemove(null);
      setArmNew(false);
    }, 5000);
    return () => clearTimeout(id);
  }, [armSwitch, armRemove, armNew]);

  const say = (ok: boolean, text: string) => setNote({ ok, text });

  const onToggleAutoStart = async () => {
    const next = !autoStart;
    setAutoStart(next);
    try {
      await accountsSetAutoStart(next);
    } catch {
      setAutoStart(!next);
      say(false, 'Could not save the relaunch setting.');
    }
  };

  const onAddNew = async () => {
    if (!armNew) {
      setArmNew(true);
      setArmSwitch(null);
      setArmRemove(null);
      return;
    }
    setArmNew(false);
    setBusy(true);
    setNote(null);
    setProgress({ op: 'add', step: 'kill', detail: 'Starting…' });
    try {
      await accountAddNew();
      say(true, 'Client cleared — log into the new account, it saves itself.');
      await load();
    } catch (e) {
      say(false, String(e ?? 'Could not clear the client.').replace(/^.*?-\s*/, ''));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const onSwitch = async (id: string, label: string) => {
    if (armSwitch !== id) {
      setArmSwitch(id);
      setArmRemove(null);
      return;
    }
    setArmSwitch(null);
    setBusy(true);
    setNote(null);
    setProgress({ op: 'switch', step: 'kill', detail: 'Starting…' });
    try {
      const r = await accountSwitch(id);
      say(
        true,
        r.relaunched === false
          ? `Swapped to ${label} — launch the client yourself (auto-relaunch off).`
          : `Switched to ${label} — client relaunching.${r.auto_saved ? '' : ' Previous login was NOT snapshotted.'}`
      );
      await load();
    } catch (e) {
      say(false, String(e ?? 'Switch failed.').replace(/^.*?-\s*/, ''));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const onRemove = async (id: string, label: string) => {
    if (armRemove !== id) {
      setArmRemove(id);
      setArmSwitch(null);
      return;
    }
    setArmRemove(null);
    setBusy(true);
    setNote(null);
    try {
      await accountRemove(id);
      say(true, `Forgot ${label}. Live login untouched.`);
      await load();
    } catch {
      say(false, 'Remove failed.');
    } finally {
      setBusy(false);
    }
  };

  const isLive = (m: AccountMeta): boolean =>
    liveId !== null &&
    `${m.game_name}#${m.tag_line}`.toLowerCase() === liveId.toLowerCase();

  const liveAccount = accounts.find((m) => isLive(m)) ?? null;
  const savedAccounts = accounts.filter((m) => !isLive(m));

  const renderStoredDetails = (m: AccountMeta) => {
    const savedVideo = readAccountVideo(m.id);
    return (
      <div className="mt-2 pt-2 border-t border-m3-outline-subtle/50">
        <div className="text-[9px] font-mono font-bold uppercase tracking-[0.14em] text-m3-outline mb-1.5">
          What's stored for this account
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10.5px]">
          <div className="flex items-center gap-1.5 text-m3-on-surface-variant">
            <HardDrive className="w-3 h-3 text-m3-outline shrink-0" />
            <span className="font-mono tabular-nums">{fmtBytes(m.snapshot_bytes ?? 0)} sealed (DPAPI)</span>
          </div>
          <div className="flex items-center gap-1.5 text-m3-on-surface-variant">
            <ShieldCheck className="w-3 h-3 text-emerald-400 shrink-0" />
            <span>passwords never stored</span>
          </div>
          <div className="flex items-center gap-1.5 text-m3-on-surface-variant">
            <FileKey2 className="w-3 h-3 text-m3-outline shrink-0" />
            <span className="font-mono">saved {fmtWhen(m.saved_at)}</span>
          </div>
          <div className="flex items-center gap-1.5 text-m3-on-surface-variant">
            <MonitorCog className="w-3 h-3 text-m3-outline shrink-0" />
            <span className="font-mono tabular-nums">
              {savedVideo ? `${savedVideo.w}×${savedVideo.h}` : 'no video memory'}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1 mt-1.5">
          {SNAPSHOT_FILES.map((f) => (
            <span key={f} className="text-[9px] font-mono text-m3-outline bg-m3-surface-container-high rounded-md px-1.5 py-0.5">
              {f}
            </span>
          ))}
        </div>
      </div>
    );
  };

  const renderActions = (m: AccountMeta, label: string, live: boolean) => (
    <>
      {onEditConfig && (
        <button
          type="button"
          onClick={() => onEditConfig({ id: m.id, label })}
          disabled={busy}
          data-tip={`Edit video settings for ${label}`}
          aria-label={`Video settings for ${label}`}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold transition-colors cursor-pointer disabled:opacity-50 shrink-0 bg-m3-surface-container-high text-m3-on-surface hover:border-m3-primary/60 border border-transparent"
        >
          <MonitorCog className="w-3 h-3" />
          Video
        </button>
      )}
      {!live ? (
        <button
          type="button"
          onClick={() => onSwitch(m.id, label)}
          disabled={busy}
          data-tip="Auto-saves the current login, closes Riot Client + game, swaps, relaunches"
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold transition-colors cursor-pointer disabled:opacity-50 shrink-0 ${
            armSwitch === m.id
              ? 'bg-amber-500 text-black hover:bg-amber-400'
              : 'bg-m3-primary text-m3-on-primary hover:bg-m3-primary/90'
          }`}
        >
          {armSwitch === m.id ? <Check className="w-3 h-3" /> : <ArrowLeftRight className="w-3 h-3" />}
          {armSwitch === m.id ? 'Confirm switch' : 'Switch'}
        </button>
      ) : (
        <span className="text-[10px] text-m3-outline shrink-0 px-1">signed in</span>
      )}
      <button
        type="button"
        onClick={() => onRemove(m.id, label)}
        disabled={busy}
        data-tip="Forget this snapshot (live login untouched)"
        aria-label={`Forget ${label}`}
        className={`p-1.5 rounded-lg transition-colors cursor-pointer disabled:opacity-50 shrink-0 ${
          armRemove === m.id
            ? 'bg-red-500 text-white'
            : 'text-m3-outline hover:text-red-300 hover:bg-red-500/10'
        }`}
      >
        {armRemove === m.id ? <Check className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
      </button>
    </>
  );

  const renderStepper = () => {
    if (!progress) return null;
    const steps = STEP_LABELS[progress.op] ?? [];
    const currentIdx = steps.indexOf(progress.step);
    return (
      <div className="mx-1 mb-2.5 px-3 py-2.5 rounded-xl bg-m3-primary-container/20 border border-m3-primary/50">
        <div className="text-[11px] font-bold text-m3-on-surface mb-1.5">
          {progress.op === 'add' ? 'Adding a new login…' : 'Switching account…'}
        </div>
        {steps.filter((s) => s !== 'done').map((s) => {
          const idx = steps.indexOf(s);
          const done = currentIdx === -1 || idx < currentIdx;
          const current = idx === currentIdx;
          return (
            <div key={s} className="flex items-center gap-2 py-0.5">
              <span
                className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 ${
                  done ? 'bg-emerald-500 text-black' : current ? 'bg-m3-primary text-m3-on-primary animate-pulse' : 'border border-m3-outline/40 text-m3-outline'
                }`}
              >
                {done ? <Check className="w-2.5 h-2.5" /> : idx + 1}
              </span>
              <span className={`text-[11px] ${current ? 'text-m3-on-surface font-semibold' : 'text-m3-outline'}`}>
                {STEP_TITLES[s] ?? s}
              </span>
            </div>
          );
        })}
        <div className="text-[10.5px] text-m3-primary mt-1 font-mono">{progress.detail}</div>
      </div>
    );
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto custom-scrollbar">
      <div className="w-full px-4 sm:px-6 pt-3 pb-6">
        {/* Header: title + quicksave + refresh */}
        <div className="flex items-center justify-between gap-2 px-1 pt-1 pb-3">
          <span className="flex items-center gap-1.5 text-[10.5px] font-display font-bold uppercase tracking-[0.14em] text-m3-on-surface shrink-0">
            <Users className="w-3.5 h-3.5 text-m3-primary" />
            <span>Accounts</span>
          </span>
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-[10px] font-mono text-emerald-300"
              data-tip="New logins save themselves; stored credentials renew automatically"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              auto-save on
            </span>
            <button
              type="button"
              onClick={onAddNew}
              disabled={busy}
              data-tip="Save the current login aside, clear the client, reopen to a fresh login screen"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold transition-colors cursor-pointer disabled:opacity-50 shrink-0 ${
                armNew
                  ? 'bg-amber-500 text-black hover:bg-amber-400'
                  : 'bg-m3-surface-container-high text-m3-on-surface hover:border-m3-primary/60 border border-transparent'
              }`}
            >
              <UserPlus className="w-3 h-3" />
              {armNew ? 'Confirm new login' : 'Log in new'}
            </button>
            <button
              type="button"
              onClick={onToggleAutoStart}
              data-tip="Relaunch the Riot Client automatically after a switch"
              aria-pressed={autoStart}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[10px] font-mono transition-colors cursor-pointer border shrink-0 ${
                autoStart
                  ? 'bg-m3-primary-container/30 border-m3-primary/50 text-m3-on-surface'
                  : 'bg-m3-surface-container-high text-m3-outline border-transparent hover:text-m3-on-surface'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${autoStart ? 'bg-emerald-400' : 'bg-m3-outline/50'}`} />
              relaunch {autoStart ? 'on' : 'off'}
            </button>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="p-1 rounded-full text-m3-outline hover:text-m3-on-surface hover:bg-m3-surface-container-high transition-colors cursor-pointer disabled:opacity-50 shrink-0"
              data-tip="Reload vault"
              aria-label="Reload vault"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {note && (
          <div
            className={`mx-1 mb-2.5 px-3 py-2 rounded-xl border text-[11px] leading-snug ${
              note.ok
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-red-500/10 border-red-500/30 text-red-300'
            }`}
          >
            {note.text}
          </div>
        )}

        {renderStepper()}

        {loading ? (
          <div className="px-1 pb-2 space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-16 rounded-xl bg-m3-surface-container-high animate-pulse" />
            ))}
          </div>
        ) : accounts.length === 0 ? (
          <div className="mx-1 mb-2 px-3 py-2.5 rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle/60 flex items-center gap-2">
            <Users className="w-4 h-4 text-m3-outline shrink-0" />
            <span className="text-[10.5px] text-m3-outline leading-snug">
              No saved logins yet — sign into Riot Client and this list fills itself.
            </span>
          </div>
        ) : (
          <div className="px-1 pb-2 space-y-2.5">
            {/* Live login hero (A): identity + freshness + stored details. */}
            {liveAccount && (() => {
              const m = liveAccount;
              const label = `${m.game_name} #${m.tag_line}`;
              const savedVideo = readAccountVideo(m.id);
              const open = expanded === m.id;
              return (
                <div className="rounded-2xl border border-m3-primary/50 bg-m3-primary-container/15 px-3.5 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-2xl bg-m3-primary/25 border border-m3-primary/50 text-m3-primary flex items-center justify-center font-display font-black text-xl shrink-0">
                      {(m.game_name || '?').trim().charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[14px] font-bold text-m3-on-surface truncate">
                          {m.game_name} <span className="text-m3-outline font-medium">#{m.tag_line}</span>
                        </span>
                        <span className="flex items-center gap-1 text-[9px] font-mono font-bold uppercase tracking-wider text-emerald-300 shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          live
                        </span>
                        {savedVideo && (
                          <span
                            className="text-[9px] font-mono text-m3-primary border border-m3-primary/40 rounded-full px-1.5 py-px shrink-0 tabular-nums"
                            data-tip="Last resolution set for this account"
                          >
                            {savedVideo.w}×{savedVideo.h}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] font-mono text-m3-outline tabular-nums">
                        session fresh · renewed {fmtWhen(m.saved_at)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {renderActions(m, label, true)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : m.id)}
                    className="flex items-center gap-1 mt-1 text-[10px] font-semibold text-m3-outline hover:text-m3-primary transition-colors cursor-pointer"
                  >
                    <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
                    {open ? 'Hide stored session' : "What's stored"}
                  </button>
                  {open && renderStoredDetails(m)}
                </div>
              );
            })()}
            {/* Saved accounts grid (A) with per-card inspectors (B). */}
            {savedAccounts.length > 0 && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                {savedAccounts.map((m) => {
                  const label = `${m.game_name} #${m.tag_line}`;
                  const savedVideo = readAccountVideo(m.id);
                  const open = expanded === m.id;
                  return (
                    <div
                      key={m.id}
                      className="rounded-xl border bg-m3-surface-container-low border-m3-outline-subtle/70 hover:border-m3-outline px-3 py-2.5 transition-colors"
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-xl bg-m3-surface-container-high border border-m3-outline-subtle text-m3-outline flex items-center justify-center font-display font-black text-base shrink-0">
                          {(m.game_name || '?').trim().charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[13px] font-bold text-m3-on-surface truncate">
                              {m.game_name} <span className="text-m3-outline font-medium">#{m.tag_line}</span>
                            </span>
                            {savedVideo && (
                              <span
                                className="text-[9px] font-mono text-m3-primary border border-m3-primary/40 rounded-full px-1.5 py-px shrink-0 tabular-nums"
                                data-tip="Last resolution set for this account"
                              >
                                {savedVideo.w}×{savedVideo.h}
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] font-mono text-m3-outline tabular-nums">
                            used {fmtWhen(m.last_used)}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 mt-2">
                        {renderActions(m, label, false)}
                        <button
                          type="button"
                          onClick={() => setExpanded(open ? null : m.id)}
                          data-tip="Show exactly what is stored for this account"
                          className="flex items-center gap-1 px-2 py-1.5 rounded-xl text-[10px] font-semibold text-m3-outline hover:text-m3-primary transition-colors cursor-pointer shrink-0"
                        >
                          <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
                          Stored
                        </button>
                      </div>
                      {open && renderStoredDetails(m)}
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-[10px] text-m3-outline leading-snug px-1 pt-1">
              Log in new parks the current login, wipes the live session, and opens a
              blank login screen — sign in there and the new account saves itself.
              Switching auto-saves first, then closes Riot Client (and your game if
              open) and reopens it on the chosen account.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
