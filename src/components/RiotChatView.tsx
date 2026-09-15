import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Users,
  RefreshCw,
  Send,
  Trash2,
  Ban,
  UserPlus,
  UserMinus,
  Check,
  X,
  MessageSquare,
  Search,
  Pencil,
  Undo2,
} from 'lucide-react';
import {
  addFriend,
  blockPlayer,
  blockedLabel,
  dropFriendRequest,
  getBlocked,
  getConversations,
  getFriendsWithPresence,
  getFriendRequests,
  getMessages,
  getParticipants,
  markConversationRead,
  groupLabel,
  isGroupConversation,
  resolveCid,
  resolveNames,
  sendToConversation,
  productLabel,
  removeFriend,
  RIOT_CHAT_UNAVAILABLE,
  sendToFriend,
  unblockPlayer,
  updateFriend,
  type RiotBlockedPlayer,
  type RiotConversation,
  type RiotFriend,
  type RiotFriendRequest,
  type RiotMessage,
  type RiotParticipant,
} from '../utils/riotChat';

/* ------------------------------------------------------------------ */
/* Riot Chat — the Riot Client's own social surface, inside Recon.     */
/*                                                                     */
/* Left rail: friends (with live presence), incoming/outgoing          */
/* requests, and the blocklist. Right pane: the 1:1 thread + composer. */
/* Every write goes through the client's loopback API — the same       */
/* channel the client's own UI uses.                                   */
/* ------------------------------------------------------------------ */

type RailTab = 'friends' | 'requests' | 'blocked';

const fmtTime = (ms: string | number | undefined): string => {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const initials = (name: string): string => (name || '?').trim().charAt(0).toUpperCase();

export const RiotChatView: React.FC = () => {
  const [rail, setRail] = useState<RailTab>('friends');
  const [friends, setFriends] = useState<RiotFriend[]>([]);
  const [requests, setRequests] = useState<RiotFriendRequest[]>([]);
  const [blocked, setBlocked] = useState<RiotBlockedPlayer[]>([]);
  const [conversations, setConversations] = useState<RiotConversation[]>([]);
  const [participants, setParticipants] = useState<RiotParticipant[]>([]);
  const [selected, setSelected] = useState<RiotFriend | null>(null);
  /** Party / group threads are addressed by cid, not by a friend. */
  const [activeGroup, setActiveGroup] = useState<{ cid: string; label: string } | null>(null);
  const [messages, setMessages] = useState<RiotMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [newTag, setNewTag] = useState('');
  const [noting, setNoting] = useState<string | null>(null);
  /** Two-click guard: first click arms, second confirms. Never one-click a delete. */
  const [armRemove, setArmRemove] = useState<string | null>(null);
  const [armBlock, setArmBlock] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const threadRef = useRef<HTMLDivElement>(null);

  const loadAll = useCallback(async (keepSelection = true) => {
    setLoading(true);
    setError(null);
    try {
      const [fr, rq, cv, pa] = await Promise.all([
        getFriendsWithPresence(),
        getFriendRequests().catch(() => [] as RiotFriendRequest[]),
        getConversations().catch(() => [] as RiotConversation[]),
        getParticipants().catch(() => [] as RiotParticipant[]),
      ]);
      setFriends(fr);
      setRequests(rq);
      setConversations(cv);
      setParticipants(pa);
      if (keepSelection) {
        setSelected((prev) => (prev ? fr.find((f) => f.puuid === prev.puuid) ?? prev : prev));
      }
      getBlocked()
        .then(async (rows) => {
          setBlocked(rows);
          // Some entries arrive with no name at all — fill those in from the
          // client's account service rather than showing a bare PUUID.
          const nameless = rows.filter((b) => !b.game_name && !b.name).map((b) => b.puuid);
          if (nameless.length) {
            const names = await resolveNames(nameless);
            setBlocked((prev) =>
              prev.map((b) => {
                const hit = names[String(b.puuid).toLowerCase()];
                return hit ? { ...b, game_name: hit.gameName, game_tag: hit.tagLine } : b;
              })
            );
          }
        })
        .catch(() => setBlocked([]));
    } catch (e) {
      setFriends([]);
      setError(String(e).includes(RIOT_CHAT_UNAVAILABLE) ? RIOT_CHAT_UNAVAILABLE : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll(false);
  }, [loadAll]);

  useEffect(() => {
    if (!armRemove && !armBlock) return;
    const id = setTimeout(() => {
      setArmRemove(null);
      setArmBlock(null);
    }, 4000);
    return () => clearTimeout(id);
  }, [armRemove, armBlock]);

  /* Presence and unread counts move without us asking — poll while visible. */
  useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      getFriendsWithPresence().then(setFriends).catch(() => {});
      getConversations().then(setConversations).catch(() => {});
    };
    const id = setInterval(tick, 15000);
    return () => clearInterval(id);
  }, []);

  const openGroup = useCallback(async (cid: string, label: string) => {
    setSelected(null);
    setActiveGroup({ cid, label });
    setMessages([]);
    setError(null);
    try {
      setMessages(await getMessages(cid));
      markConversationRead(cid).catch(() => {});
      setConversations((prev) => prev.map((c) => (c.cid === cid ? { ...c, unread_count: 0 } : c)));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const openThread = useCallback(async (friend: RiotFriend) => {
    setActiveGroup(null);
    setSelected(friend);
    setMessages([]);
    setError(null);
    const cid = resolveCid(friend, participants);
    if (!cid) {
      // Never opened a DM with this friend: an empty thread, not an error.
      return;
    }
    try {
      const list = await getMessages(cid);
      setMessages(list);
      const known = conversations.find((c) => c.cid === cid);
      if (known && (known.unread_count ?? 0) > 0) {
        markConversationRead(cid).catch(() => {});
        setConversations((prev) => prev.map((c) => (c.cid === cid ? { ...c, unread_count: 0 } : c)));
      }
    } catch (e) {
      setError(String(e));
    }
  }, [conversations, participants]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages]);

  /* The open thread's cid, whether it is a friend DM or the party chat. */
  const activeCid = activeGroup ? activeGroup.cid : selected ? resolveCid(selected, participants) : null;
  /** The DM peer when the open thread is a friend chat (never in a group thread). */
  const peer = activeGroup ? null : selected;

  /* Live thread: incoming messages only reach us if we ask for them.
     The client's own UI gets them over its local websocket; polling the
     conversation on loopback is the same data at ~5ms per call, so an open
     thread refreshes every 2.5s while the window is visible. */
  useEffect(() => {
    if (!activeCid) return;
    const cid = activeCid;
    let cancelled = false;

    const pull = async () => {
      if (cancelled || (typeof document !== 'undefined' && document.hidden)) return;
      try {
        const list = await getMessages(cid);
        if (cancelled) return;
        setMessages((prev) => {
          const key = (m: RiotMessage) => m.id || m.mid || `${m.time}-${m.body}`;
          const seen = new Set(prev.map(key));
          const fresh = list.filter((m) => !seen.has(key(m)));
          if (fresh.length === 0 && list.length === prev.length) return prev; // no repaint
          return [...list];
        });
        // Only touch read-state when something is actually unread, or this
        // fires a POST every poll for no reason.
        setConversations((prev) => {
          const row = prev.find((c) => c.cid === cid);
          if (row && (row.unread_count ?? 0) > 0) {
            markConversationRead(cid).catch(() => {});
            return prev.map((c) => (c.cid === cid ? { ...c, unread_count: 0 } : c));
          }
          return prev;
        });
      } catch {
        /* transient — the next tick retries */
      }
    };

    void pull();
    const id = setInterval(pull, 2500);
    const onFocus = () => void pull();
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onFocus);
    return () => {
      cancelled = true;
      clearInterval(id);
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onFocus);
    };
  }, [activeCid]);

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Confirm-then-run for removing a friend. */
  const confirmRemove = (f: RiotFriend, after?: () => void) => {
    if (armRemove !== f.puuid) {
      setArmRemove(f.puuid);
      setArmBlock(null);
      return;
    }
    setArmRemove(null);
    run(() => removeFriend(f.puuid), after);
  };

  /** Confirm-then-run for blocking a player. */
  const confirmBlock = (f: RiotFriend) => {
    if (armBlock !== f.puuid) {
      setArmBlock(f.puuid);
      setArmRemove(null);
      return;
    }
    setArmBlock(null);
    run(() => blockPlayer(f.puuid), () => loadAll(true));
  };

  const submitMessage = () => {
    const text = draft.trim();
    if (!text || (!selected && !activeGroup)) return;
    setDraft('');
    run(
      async () => {
        if (activeGroup) {
          // Party / group thread — the send must be typed `groupchat`.
          const sent = await sendToConversation(activeGroup.cid, text, 'groupchat');
          if (sent.length) setMessages((prev) => [...prev, ...sent]);
          else
            setMessages((prev) => [
              ...prev,
              { cid: activeGroup.cid, body: text, type: 'groupchat', time: String(Date.now()), read: true },
            ]);
          return;
        }
        const friend = selected as RiotFriend;
        const target = resolveCid(friend, participants);
        const sent = await sendToFriend(friend, text, target);
        if (sent.length) setMessages((prev) => [...prev, ...sent]);
        else
          setMessages((prev) => [
            ...prev,
            { cid: target || friend.pid || '', body: text, type: 'chat', time: String(Date.now()), read: true },
          ]);
      },
      () => loadAll(true)
    );
  };

  const filteredFriends = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = q
      ? friends.filter((f) => `${f.game_name}#${f.game_tag}`.toLowerCase().includes(q))
      : friends;
    return [...rows].sort((a, b) => Number(!!b.online) - Number(!!a.online) || a.game_name.localeCompare(b.game_name));
  }, [friends, search]);

  /** Party / group threads (the party chat lives here). */
  const groups = useMemo(
    () =>
      conversations
        .filter(isGroupConversation)
        .map((c) => ({ cid: c.cid, label: groupLabel(c.cid, participants), unread: c.unread_count ?? 0 })),
    [conversations, participants]
  );

  const incoming = requests.filter((r) => r.subscription !== 'pending_out');
  const outgoing = requests.filter((r) => r.subscription === 'pending_out');

  const railButton = (id: RailTab, label: string, Icon: React.ComponentType<{ className?: string }>, badge?: number) => (
    <button
      key={id}
      type="button"
      onClick={() => setRail(id)}
      className={`relative flex-1 h-9 rounded-xl text-[11px] font-semibold flex items-center justify-center gap-1.5 transition-all duration-200 active:scale-[0.97] cursor-pointer ${
        rail === id
          ? 'bg-m3-primary/20 text-m3-primary border border-m3-primary/40'
          : 'bg-m3-surface-container-high/60 text-m3-on-surface-variant border border-m3-outline-subtle hover:text-m3-on-surface'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      <span>{label}</span>
      {badge ? (
        <span className="px-1.5 rounded-full bg-m3-primary text-m3-on-primary text-[9px] font-bold">{badge}</span>
      ) : null}
    </button>
  );

  return (
    <div className="h-full flex flex-col min-h-0 bg-m3-surface">
      {error && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-xl bg-rose-500/10 border border-rose-400/40 text-rose-300 text-[11px] font-medium flex items-start gap-2">
          <Ban className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {/* Rail */}
        <div className="w-[330px] shrink-0 flex flex-col min-h-0 border-r border-m3-outline-subtle">
          <div className="flex items-center gap-1.5 p-3 pb-2">
            {railButton('friends', 'Friends', Users, 0)}
            {railButton('requests', 'Requests', UserPlus, incoming.length)}
            {railButton('blocked', 'Blocked', Ban, 0)}
            <button
              type="button"
              onClick={() => loadAll(true)}
              disabled={busy}
              className="w-9 h-9 rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle text-m3-on-surface-variant hover:text-m3-on-surface hover:bg-m3-surface-container-high flex items-center justify-center cursor-pointer transition-colors disabled:opacity-50 shrink-0"
              title="Refresh friends and conversations"
              aria-label="Refresh friends and conversations"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin text-m3-primary' : ''}`} />
            </button>
          </div>

          {rail === 'friends' && (
            <motion.div
              key="friends"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="flex-1 min-h-0 flex flex-col"
            >
              <div className="px-3 pb-2 flex items-center gap-1.5">
                <div className="flex-1 flex items-center gap-1.5 px-2.5 h-8 rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle">
                  <Search className="w-3.5 h-3.5 text-m3-outline shrink-0" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search friends"
                    className="flex-1 min-w-0 bg-transparent text-xs text-m3-on-surface outline-none placeholder:text-m3-outline"
                  />
                </div>
              </div>
              <div className="px-3 pb-2 flex items-center gap-1.5">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Game name"
                  className="flex-1 min-w-0 h-8 px-2.5 rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle text-xs text-m3-on-surface outline-none placeholder:text-m3-outline"
                />
                <input
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  placeholder="Tag"
                  className="w-[68px] h-8 px-2.5 rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle text-xs text-m3-on-surface outline-none placeholder:text-m3-outline"
                />
                <button
                  type="button"
                  disabled={busy || !newName.trim() || !newTag.trim()}
                  onClick={() =>
                    run(
                      () => addFriend(newName.trim(), newTag.trim().replace(/^#/, '')),
                      () => {
                        setNewName('');
                        setNewTag('');
                        loadAll(true);
                      }
                    )
                  }
                  className="h-8 px-2.5 rounded-xl bg-m3-primary/20 border border-m3-primary/40 text-m3-primary text-[11px] font-bold flex items-center gap-1 cursor-pointer hover:bg-m3-primary/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  title="Send a friend request"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  Add
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 pb-3 flex flex-col gap-1">
                {groups.length > 0 && (
                  <div className="flex flex-col gap-1 mb-1">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-m3-outline px-1">
                      Party chat
                    </span>
                    {groups.map((g) => (
                      <motion.button
                        key={g.cid}
                        layout
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.18, ease: 'easeOut' }}
                        type="button"
                        onClick={() => openGroup(g.cid, g.label)}
                        className={`rounded-xl border px-2.5 py-2 flex items-center gap-2.5 text-left transition-colors cursor-pointer ${
                          activeGroup?.cid === g.cid
                            ? 'bg-m3-primary/15 border-m3-primary/40'
                            : 'bg-m3-surface-container-high/40 border-m3-outline-subtle hover:bg-m3-surface-container-high/70'
                        }`}
                      >
                        <div className="w-8 h-8 rounded-lg bg-m3-surface-container-highest border border-m3-outline-subtle flex items-center justify-center text-m3-primary shrink-0">
                          <Users className="w-4 h-4" />
                        </div>
                        <span className="flex-1 min-w-0 text-[12.5px] font-bold text-m3-on-surface truncate">
                          {g.label}
                        </span>
                        {g.unread > 0 && (
                          <span className="px-1.5 rounded-full bg-m3-primary text-m3-on-primary text-[9px] font-bold shrink-0">
                            {g.unread}
                          </span>
                        )}
                      </motion.button>
                    ))}
                  </div>
                )}
                {loading && friends.length === 0 && (
                  <span className="text-[11px] text-m3-outline px-1 py-2">Reading friends…</span>
                )}
                {!loading && filteredFriends.length === 0 && (
                  <span className="text-[11px] text-m3-outline px-1 py-2">No friends match that search.</span>
                )}
                {filteredFriends.map((f) => {
                  const active = selected?.puuid === f.puuid;
                  return (
                    <React.Fragment key={f.puuid}>
                    <motion.div
                      layout
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.18, ease: 'easeOut' }}
                      className={`group rounded-xl border px-2.5 py-2 flex items-center gap-2.5 transition-colors ${
                        active
                          ? 'bg-m3-primary/15 border-m3-primary/40'
                          : 'bg-m3-surface-container-high/40 border-m3-outline-subtle hover:bg-m3-surface-container-high/70'
                      }`}
                    >
                      <div className="relative w-8 h-8 rounded-lg bg-m3-surface-container-highest border border-m3-outline-subtle flex items-center justify-center text-xs font-bold text-m3-on-surface shrink-0">
                        {initials(f.game_name)}
                        <span
                          className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-m3-surface ${
                            f.online ? 'bg-m3-mint' : 'bg-m3-outline/60'
                          }`}
                          title={f.online ? `Online${f.product ? ` • ${productLabel(f.product)}` : ''}` : 'Offline'}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => openThread(f)}
                        className="flex-1 min-w-0 text-left cursor-pointer"
                      >
                        <span className="block text-[12.5px] font-bold text-m3-on-surface truncate">
                          {f.game_name}
                          <span className="text-m3-outline font-normal">#{f.game_tag}</span>
                        </span>
                        <span className="block text-[10px] text-m3-on-surface-variant truncate">
                          {f.online
                            ? `${productLabel(f.product) || 'In game'}${f.state === 'mobile' ? ' • Mobile' : ''}`
                            : f.note || 'Offline'}
                        </span>
                      </button>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setNoting(noting === f.puuid ? null : f.puuid);
                            setNoteDraft(f.note || '');
                          }}
                          className="w-6 h-6 rounded-lg bg-m3-surface-container border border-m3-outline-subtle text-m3-on-surface-variant hover:text-m3-on-surface flex items-center justify-center cursor-pointer"
                          title="Set a note for this friend"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => confirmRemove(f, () => loadAll(true))}
                          className={`h-6 rounded-lg border flex items-center justify-center cursor-pointer disabled:opacity-40 transition-colors ${
                            armRemove === f.puuid
                              ? 'px-1.5 bg-rose-500 text-white border-rose-400 text-[9px] font-bold'
                              : 'w-6 bg-rose-500/20 border-rose-400/40 text-rose-300 hover:bg-rose-500/35'
                          }`}
                          title={armRemove === f.puuid ? 'Click again to remove this friend' : 'Remove friend'}
                        >
                          {armRemove === f.puuid ? 'Sure?' : <UserMinus className="w-3 h-3" />}
                        </button>
                      </div>
                    </motion.div>
              <AnimatePresence initial={false}>
              {noting === f.puuid && (
                <motion.div
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginTop: 4 }}
                  exit={{ opacity: 0, height: 0, marginTop: 0 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  className="overflow-hidden"
                >
                <div className="rounded-xl border border-m3-outline-subtle bg-m3-surface-container-high/60 p-2 flex items-center gap-1.5">
                  <input
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder="Note (only you see this)"
                    className="flex-1 min-w-0 h-8 px-2.5 rounded-lg bg-m3-surface-container-lowest/60 border border-m3-outline-subtle text-xs text-m3-on-surface outline-none placeholder:text-m3-outline"
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run(() => updateFriend(noting, { note: noteDraft }), () => {
                        setNoting(null);
                        loadAll(true);
                      })
                    }
                    className="h-8 px-2.5 rounded-lg bg-m3-primary/20 border border-m3-primary/40 text-m3-primary text-[11px] font-bold flex items-center gap-1 cursor-pointer disabled:opacity-40"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setNoting(null)}
                    className="h-8 px-2 rounded-lg border border-m3-outline-subtle text-m3-on-surface-variant cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                </motion.div>
              )}
              </AnimatePresence>
                    </React.Fragment>
                  );
                })}
              </div>
            </motion.div>
          )}

          {rail === 'requests' && (
            <motion.div
              key="requests"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 pb-3 flex flex-col gap-3"
            >
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-mono uppercase tracking-wider text-m3-outline px-1">
                  Incoming ({incoming.length})
                </span>
                {incoming.length === 0 && (
                  <span className="text-[11px] text-m3-outline px-1">No incoming requests.</span>
                )}
                {incoming.map((r, idx) => (
                  <motion.div
                    key={r.puuid}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.18, delay: Math.min(idx * 0.04, 0.2), ease: 'easeOut' }}
                    className="rounded-xl border border-m3-outline-subtle bg-m3-surface-container-high/40 px-2.5 py-2 flex items-center gap-2"
                  >
                    <div className="w-7 h-7 rounded-lg bg-m3-surface-container-highest border border-m3-outline-subtle flex items-center justify-center text-[11px] font-bold text-m3-on-surface shrink-0">
                      {initials(r.gameName)}
                    </div>
                    <span className="flex-1 min-w-0 text-[12px] font-bold text-m3-on-surface truncate">
                      {r.gameName}
                      <span className="text-m3-outline font-normal">#{r.tagLine}</span>
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(() => addFriend(r.gameName, r.tagLine, r.puuid), () => loadAll(true))}
                      className="h-7 px-2 rounded-lg bg-m3-mint/20 border border-m3-mint/40 text-m3-mint text-[10px] font-bold flex items-center gap-1 cursor-pointer disabled:opacity-40"
                      title="Accept — sends the reciprocal subscription"
                    >
                      <Check className="w-3 h-3" />
                      Accept
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(() => dropFriendRequest(r.puuid), () => loadAll(true))}
                      className="h-7 px-2 rounded-lg bg-rose-500/20 border border-rose-400/40 text-rose-300 text-[10px] font-bold flex items-center gap-1 cursor-pointer disabled:opacity-40"
                      title="Decline"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </motion.div>
                ))}
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-mono uppercase tracking-wider text-m3-outline px-1">
                  Sent ({outgoing.length})
                </span>
                {outgoing.length === 0 && <span className="text-[11px] text-m3-outline px-1">No pending invites.</span>}
                {outgoing.map((r, idx) => (
                  <motion.div
                    key={r.puuid}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.18, delay: Math.min(idx * 0.04, 0.2), ease: 'easeOut' }}
                    className="rounded-xl border border-m3-outline-subtle bg-m3-surface-container-high/40 px-2.5 py-2 flex items-center gap-2"
                  >
                    <span className="flex-1 min-w-0 text-[12px] text-m3-on-surface-variant truncate">
                      {r.gameName}
                      <span className="text-m3-outline">#{r.tagLine}</span>
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(() => dropFriendRequest(r.puuid), () => loadAll(true))}
                      className="h-7 px-2 rounded-lg border border-m3-outline-subtle text-m3-on-surface-variant text-[10px] font-bold flex items-center gap-1 cursor-pointer disabled:opacity-40"
                      title="Cancel request"
                    >
                      <Undo2 className="w-3 h-3" />
                      Cancel
                    </button>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}

          {rail === 'blocked' && (
            <motion.div
              key="blocked"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 pb-3 flex flex-col gap-1"
            >
              {blocked.length === 0 && (
                <span className="text-[11px] text-m3-outline px-1 py-2">Nobody is blocked.</span>
              )}
              {blocked.map((b, idx) => {
                const id = b.puuid || b.pid || '';
                return (
                  <motion.div
                    key={id}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.18, delay: Math.min(idx * 0.04, 0.2), ease: 'easeOut' }}
                    className="rounded-xl border border-m3-outline-subtle bg-m3-surface-container-high/40 px-2.5 py-2 flex items-center gap-2"
                  >
                    <div className="w-7 h-7 rounded-lg bg-m3-surface-container-highest border border-m3-outline-subtle flex items-center justify-center text-[11px] font-bold text-m3-on-surface shrink-0">
                      {initials(blockedLabel(b))}
                    </div>
                    <span className="flex-1 min-w-0 text-[12px] font-bold text-m3-on-surface truncate">
                      {blockedLabel(b)}
                    </span>
                    <button
                      type="button"
                      disabled={busy || !b.puuid}
                      onClick={() =>
                        run(
                          () => (b.puuid ? unblockPlayer(b.puuid) : Promise.resolve()),
                          () => loadAll(true)
                        )
                      }
                      className="h-7 px-2 rounded-lg border border-m3-outline-subtle text-m3-on-surface-variant text-[10px] font-bold flex items-center gap-1 cursor-pointer disabled:opacity-40"
                    >
                      <Undo2 className="w-3 h-3" />
                      Unblock
                    </button>
                  </motion.div>
                );
              })}
            </motion.div>
          )}
        </div>

        {/* Thread */}
        <div className="flex-1 min-w-0 flex flex-col">
          {!selected && !activeGroup ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-6">
              <MessageSquare className="w-7 h-7 text-m3-outline" />
              <span className="text-sm font-semibold text-m3-on-surface">Pick a friend to chat</span>
              <span className="text-[11px] text-m3-on-surface-variant max-w-[320px]">
                Reads and sends through the Riot Client's own chat service — the same one the client uses.
              </span>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 px-4 h-12 border-b border-m3-outline-subtle shrink-0">
                <span className="text-[13px] font-bold text-m3-on-surface truncate">
                  {activeGroup ? (
                    activeGroup.label
                  ) : (
                    <>
                      {selected?.game_name}
                      <span className="text-m3-outline font-normal">#{selected?.game_tag}</span>
                    </>
                  )}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  {!activeGroup && (
                    <span
                      className={`w-2 h-2 rounded-full ${selected?.online ? 'bg-m3-mint' : 'bg-m3-outline/60'}`}
                      title={selected?.online ? 'Online' : 'Offline'}
                    />
                  )}
                  {activeGroup ? (
                    <span className="text-[10px] font-mono text-m3-outline px-2 py-0.5 rounded-full bg-m3-surface-container-high/60 border border-m3-outline-subtle">
                      Party
                    </span>
                  ) : (
                  <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => peer && confirmBlock(peer)}
                    className={`h-7 px-2 rounded-lg border text-[10px] font-bold flex items-center gap-1 cursor-pointer disabled:opacity-40 transition-colors ${
                      armBlock === peer?.puuid
                        ? 'bg-rose-500 text-white border-rose-400'
                        : 'bg-rose-500/20 border-rose-400/40 text-rose-300'
                    }`}
                    title={armBlock === peer?.puuid ? 'Click again to block' : 'Block this player'}
                  >
                    <Ban className="w-3 h-3" />
                    {armBlock === peer?.puuid ? 'Sure?' : 'Block'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      peer &&
                      confirmRemove(peer, () => {
                        setSelected(null);
                        setMessages([]);
                        loadAll(false);
                      })
                    }
                    className={`h-7 px-2 rounded-lg border text-[10px] font-bold flex items-center gap-1 cursor-pointer disabled:opacity-40 transition-colors ${
                      armRemove === peer?.puuid
                        ? 'bg-rose-500 text-white border-rose-400'
                        : 'border-m3-outline-subtle text-m3-on-surface-variant'
                    }`}
                    title={armRemove === peer?.puuid ? 'Click again to remove this friend' : 'Remove friend'}
                  >
                    <Trash2 className="w-3 h-3" />
                    {armRemove === peer?.puuid ? 'Sure?' : ''}
                  </button>
                  </>
                  )}
                </div>
              </div>

              <div ref={threadRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-3 flex flex-col gap-2">
                {messages.length === 0 && (
                  <span className="text-[11px] text-m3-outline">
                    No messages yet — type below to start this chat.
                  </span>
                )}
                {messages.map((m, i) => {
                  const peerPuuid = activeGroup ? '' : String(selected?.puuid || '').toLowerCase();
                  const mine = !activeGroup && (!m.puuid || String(m.puuid).toLowerCase() !== peerPuuid);
                  return (
                    <motion.div
                      key={m.id || m.mid || `${m.time}-${i}`}
                      layout
                      initial={{ opacity: 0, y: 8, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{ duration: 0.2, ease: 'easeOut' }}
                      className={`max-w-[78%] rounded-2xl px-3 py-2 border ${
                        mine
                          ? 'self-end bg-m3-primary/20 border-m3-primary/35 text-m3-on-surface'
                          : 'self-start bg-m3-surface-container-high/70 border-m3-outline-subtle text-m3-on-surface'
                      }`}
                    >
                      <span className="block text-[12.5px] break-words whitespace-pre-wrap">{m.body}</span>
                      <span className="block text-[9.5px] font-mono text-m3-outline mt-0.5 text-right">
                        {fmtTime(m.time)}
                      </span>
                    </motion.div>
                  );
                })}
              </div>

              <div className="p-3 border-t border-m3-outline-subtle shrink-0 flex items-center gap-2">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      submitMessage();
                    }
                  }}
                  placeholder={`Message ${activeGroup ? activeGroup.label : selected?.game_name || ''}`}
                  className="flex-1 min-w-0 h-9 px-3 rounded-xl bg-m3-surface-container-high/60 border border-m3-outline-subtle text-xs text-m3-on-surface outline-none placeholder:text-m3-outline focus:border-m3-primary/50"
                />
                <button
                  type="button"
                  disabled={busy || !draft.trim()}
                  onClick={submitMessage}
                  className="h-9 px-3 rounded-xl bg-m3-primary text-m3-on-primary text-[11px] font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-40 shrink-0"
                >
                  <Send className="w-3.5 h-3.5" />
                  Send
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
