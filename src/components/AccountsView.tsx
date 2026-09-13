import React, { useCallback, useEffect, useState } from 'react';
import { Users, RefreshCw, ArrowLeftRight, Trash2, Check, UserPlus } from 'lucide-react';
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
} from '../utils/accounts';

/* ------------------------------------------------------------------ */
/* Accounts tab — quick-switch Riot logins without logout/login.       */
/* Pixels and confirms only: Rust owns snapshots, kills, swaps,        */
/* relaunch. Switching closes the Riot Client (and the game if open)   */
/* after auto-saving the current login — hence the two-click guards.   */
/* ------------------------------------------------------------------ */

export const AccountsView: React.FC = () => {
  const [accounts, setAccounts] = useState<AccountMeta[]>([]);
  const [liveId, setLiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [armSwitch, setArmSwitch] = useState<string | null>(null);
  const [armRemove, setArmRemove] = useState<string | null>(null);
  const [armNew, setArmNew] = useState(false);
  const [autoStart, setAutoStart] = useState(true);

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
  }, [load]);

  // Autopilot: Rust notices new logins and refreshes stale credentials by
  // itself — the UI just re-renders and mentions what changed. Silent when
  // the binary predates the tick command (pre-rebuild) or the client is shut.
  useEffect(() => {
    let dead = false;
    const tick = async () => {
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
    const id = setInterval(tick, 30000);
    return () => {
      dead = true;
      clearInterval(id);
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
    try {
      await accountAddNew();
      say(true, 'Client cleared — log into the new account, it saves itself.');
      await load();
    } catch (e) {
      say(false, String(e ?? 'Could not clear the client.').replace(/^.*?-\s*/, ''));
    } finally {
      setBusy(false);
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
              title="New logins save themselves; stored credentials renew automatically"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              auto-save on
            </span>
            <button
              type="button"
              onClick={onAddNew}
              disabled={busy}
              title="Save the current login aside, clear the client, reopen to a fresh login screen"
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
              title="Relaunch the Riot Client automatically after a switch"
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
              title="Reload vault"
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
          <div className="px-1 pb-2 space-y-2">
            {accounts.map((m) => {
              const live = isLive(m);
              const label = `${m.game_name} #${m.tag_line}`;
              return (
                <div
                  key={m.id}
                  className={`rounded-xl border px-3 py-2.5 flex items-center gap-3 transition-colors ${
                    live
                      ? 'bg-m3-primary-container/20 border-m3-primary/50'
                      : 'bg-m3-surface-container-low border-m3-outline-subtle/70'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[13px] font-bold text-m3-on-surface truncate">
                        {m.game_name} <span className="text-m3-outline font-medium">#{m.tag_line}</span>
                      </span>
                      {live && (
                        <span className="flex items-center gap-1 text-[9px] font-mono font-bold uppercase tracking-wider text-emerald-300 shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          live
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] font-mono text-m3-outline tabular-nums">
                      used {fmtWhen(m.last_used)} · saved {fmtWhen(m.saved_at)}
                    </div>
                  </div>
                  {!live ? (
                    <button
                      type="button"
                      onClick={() => onSwitch(m.id, label)}
                      disabled={busy}
                      title="Auto-saves the current login, closes Riot Client + game, swaps, relaunches"
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold transition-colors cursor-pointer disabled:opacity-50 shrink-0 ${
                        armSwitch === m.id
                          ? 'bg-amber-500 text-black hover:bg-amber-400'
                          : 'bg-m3-surface-container-high text-m3-on-surface hover:border-m3-primary/60 border border-transparent'
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
                    title="Forget this snapshot (live login untouched)"
                    aria-label={`Forget ${label}`}
                    className={`p-1.5 rounded-lg transition-colors cursor-pointer disabled:opacity-50 shrink-0 ${
                      armRemove === m.id
                        ? 'bg-red-500 text-white'
                        : 'text-m3-outline hover:text-red-300 hover:bg-red-500/10'
                    }`}
                  >
                    {armRemove === m.id ? <Check className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
                  </button>
                </div>
              );
            })}
            <p className="text-[10px] text-m3-outline leading-snug px-1 pt-1">
              New logins save themselves here — no button needed. Stored credentials
              renew automatically, and switching auto-saves the current login first,
              then closes Riot Client (and your game if open) and reopens it on the
              chosen account. Snapshots hold live session tokens — they stay on this
              PC, inside the app vault.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
