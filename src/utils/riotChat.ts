/* ------------------------------------------------------------------ */
/* Riot Client social layer — friends, requests, conversations, chat.  */
/*                                                                     */
/* All calls go through the Rust `local_request` command, which talks  */
/* to the Riot Client's own loopback API with fresh lockfile creds     */
/* (same trust boundary as every other local read in this app).        */
/*                                                                     */
/* Endpoints verified against the client's live swagger               */
/* (`/swagger/v3/openapi.json` on the lockfile port):                  */
/*   GET    /chat/v4/friends                                           */
/*   DELETE /chat/v4/friends            {puuid}                        */
/*   PUT    /chat/v4/friends            {puuid, note?, group?}         */
/*   GET    /chat/v6/friendrequests/full                               */
/*   POST   /chat/v4/friendrequests     {puuid|game_name,game_tag}     */
/*   DELETE /chat/v4/friendrequests     {puuid}                        */
/*   GET    /chat/v6/conversations                                     */
/*   GET    /chat/v6/messages?cid=                                     */
/*   POST   /chat/v6/messages           {cid, message, type}           */
/*   POST   /chat/v6/conversations/read {cid}                          */
/*   GET    /chat/v4/blocked  POST/DELETE /chat/v4/blocked {puuid}     */
/*   GET    /chat/v4/presences                                         */
/* ------------------------------------------------------------------ */

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './ipc';

export const RIOT_CHAT_UNAVAILABLE =
  'Riot Client API unavailable — launch the Riot Client and sign in.';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!isTauri()) throw new Error(RIOT_CHAT_UNAVAILABLE);
  const raw = await invoke<string>('local_request', {
    method,
    path,
    bodyArg: body === undefined ? null : JSON.stringify(body),
  });
  if (!raw || !raw.trim()) return undefined as unknown as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('Unexpected response from the Riot Client.');
  }
}

/* ------------------------------- friends ------------------------------- */

export interface RiotFriend {
  puuid: string;
  game_name: string;
  game_tag: string;
  note?: string;
  /** Conversation address: `<puuid>@<region>.pvp.net`. */
  pid?: string;
  group?: string;
  displayGroup?: string;
  last_online_ts?: number | null;
  region?: string;
  /** Client-side, filled from presences. */
  online?: boolean;
  product?: string;
  state?: string;
}

export async function getFriends(): Promise<RiotFriend[]> {
  const res = await req<{ friends?: RiotFriend[] }>('GET', '/chat/v4/friends');
  return res?.friends ?? [];
}

export async function removeFriend(puuid: string): Promise<void> {
  await req('DELETE', '/chat/v4/friends', { puuid });
}

/** Note/alias or group edit on an existing friend. */
export async function updateFriend(puuid: string, patch: { note?: string; group?: string }): Promise<void> {
  await req('PUT', '/chat/v4/friends', { puuid, ...patch });
}

/* --------------------------- friend requests --------------------------- */

export interface RiotFriendRequest {
  puuid: string;
  gameName: string;
  tagLine: string;
  note?: string;
  platform?: string;
  /** `pending_in` = they added you, `pending_out` = you added them. */
  subscription?: string;
}

export async function getFriendRequests(): Promise<RiotFriendRequest[]> {
  const res = await req<{ requests?: RiotFriendRequest[] }>('GET', '/chat/v6/friendrequests/full');
  return res?.requests ?? [];
}

/**
 * Send a friend request. The same call ACCEPTS an incoming request, because
 * the messaging service treats the reciprocal subscription as acceptance.
 * Accepting is unverified here — proving it needs a real account mutation.
 */
export async function addFriend(gameName: string, tagLine: string, puuid?: string): Promise<void> {
  await req('POST', '/chat/v4/friendrequests', {
    ...(puuid ? { puuid } : {}),
    game_name: gameName,
    game_tag: tagLine,
  });
}

/** Decline an incoming request, or cancel one of your own outgoing ones. */
export async function dropFriendRequest(puuid: string): Promise<void> {
  await req('DELETE', '/chat/v4/friendrequests', { puuid });
}

/* ---------------------------- conversations ---------------------------- */

export interface RiotConversation {
  cid: string;
  type: 'chat' | 'groupchat' | string;
  unread_count?: number;
  muted?: boolean;
  direct_messages?: boolean;
  message_history?: boolean;
  uiState?: { hidden?: boolean; changedSinceHidden?: boolean };
}

export async function getConversations(): Promise<RiotConversation[]> {
  const res = await req<{ conversations?: RiotConversation[] }>('GET', '/chat/v6/conversations');
  return res?.conversations ?? [];
}

export interface RiotParticipant {
  cid: string;
  puuid: string;
  game_name?: string;
  game_tag?: string;
  muted?: boolean;
}

/**
 * Every participant of every live conversation. This is the authoritative
 * PUUID -> cid map: a 1:1 DM's cid is the other player's PUUID plus their
 * region (`<puuid>@eu1.pvp.net`), but only this endpoint states which
 * conversations actually exist. Requesting messages for a cid that was never
 * opened answers HTTP 404 RPC_ERROR.
 */
export async function getParticipants(): Promise<RiotParticipant[]> {
  const res = await req<{ participants?: RiotParticipant[] }>('GET', '/chat/v5/participants');
  return res?.participants ?? [];
}

/** Resolve a friend's conversation id from live conversations, else their pid. */
export function resolveCid(friend: RiotFriend, participants: RiotParticipant[]): string | null {
  const key = String(friend.puuid).toLowerCase();
  const hit = participants.find((p) => String(p.puuid).toLowerCase() === key);
  if (hit?.cid) return hit.cid;
  // `pid` is already shaped `<puuid>@<region>.pvp.net` — the DM address.
  if (friend.pid && friend.pid.includes('@')) return friend.pid;
  return null;
}

export interface RiotMessage {
  id?: string;
  mid?: string;
  cid: string;
  body: string;
  type: string;
  time: string;
  read?: boolean;
  puuid?: string;
  game_name?: string;
  game_tag?: string;
}

export async function getMessages(cid: string): Promise<RiotMessage[]> {
  try {
    const res = await req<{ messages?: RiotMessage[] }>(
      'GET',
      `/chat/v6/messages?cid=${encodeURIComponent(cid)}`
    );
    return res?.messages ?? [];
  } catch (e) {
    // A cid with no conversation yet answers 404 RPC_ERROR — that is an empty
    // thread, not a failure, so the view shows "no messages" instead of an error.
    if (String(e).includes('404')) return [];
    throw e;
  }
}

/**
 * Send into a conversation. `type` must match the conversation: `chat` for a
 * 1:1 whisper, `groupchat` for a party/group thread — the messaging service
 * rejects the wrong one for the target cid.
 */
export async function sendMessage(
  cid: string,
  message: string,
  type: 'chat' | 'groupchat' = 'chat'
): Promise<RiotMessage[]> {
  const res = await req<{ messages?: RiotMessage[] }>('POST', '/chat/v6/messages', {
    cid,
    message,
    type,
  });
  return res?.messages ?? [];
}

/** True for party/group threads, which need `type: 'groupchat'` when sending. */
export const isGroupConversation = (c: RiotConversation): boolean => c.type === 'groupchat';

/** Label a group conversation from its members (party chat has no name). */
export function groupLabel(cid: string, participants: RiotParticipant[], selfName?: string): string {
  const members = participants.filter((p) => p.cid === cid);
  const others = members.filter((m) => m.game_name && m.game_name !== selfName);
  if (others.length === 0) return members.length > 1 ? `Party (${members.length})` : 'Party chat';
  const names = others.map((m) => m.game_name).slice(0, 3).join(', ');
  return others.length > 3 ? `${names} +${others.length - 3}` : names;
}

/**
 * Send to a friend, creating the conversation if it does not exist yet.
 *
 * Riot only materialises a DM conversation once something has been sent, so a
 * friend you have never messaged has NO cid and `/chat/v6/messages` answers 404
 * for their address. Ladder: send straight to their conversation address, and
 * if that 404s, ask the messaging service to open the conversation and retry.
 *
 * NOTE: the create step below is schema-verified against the client's swagger
 * but NOT executed live — it writes to a real account and would message a real
 * friend, so it is left to the user's own Send click.
 */
/** Send into any conversation by cid (party/group threads included). */
export async function sendToConversation(
  cid: string,
  text: string,
  type: 'chat' | 'groupchat' = 'chat'
): Promise<RiotMessage[]> {
  return await sendMessage(cid, text, type);
}

export async function sendToFriend(
  friend: RiotFriend,
  text: string,
  knownCid?: string | null
): Promise<RiotMessage[]> {
  const address = knownCid || (friend.pid && friend.pid.includes('@') ? friend.pid : '');
  if (!address) throw new Error('This friend has no conversation address yet.');

  try {
    return await sendMessage(address, text);
  } catch (e) {
    if (!String(e).includes('404')) throw e;
  }

  const [id, domain] = address.split('@');
  await req('POST', '/chat/v6/conversations', { id, domain, type: 'chat' });
  return await sendMessage(address, text);
}

export async function markConversationRead(cid: string): Promise<void> {
  await req('POST', '/chat/v6/conversations/read', { cid });
}

/* ------------------------------- blocklist ----------------------------- */

export interface RiotBlockedPlayer {
  puuid: string;
  pid?: string;
  /** Riot ID parts. `name` is usually EMPTY here — the real label is game_name. */
  game_name?: string;
  game_tag?: string;
  name?: string;
  region?: string;
}

/**
 * Blocked players. `/chat/v4/blocked` carries `game_name` + `game_tag` (its
 * `name` field is blank), so the label must be built from those — reading
 * `name` alone renders nothing but the PUUID.
 */
export async function getBlocked(): Promise<RiotBlockedPlayer[]> {
  const res = await req<{ blocked?: RiotBlockedPlayer[] }>('GET', '/chat/v4/blocked');
  return res?.blocked ?? [];
}

/** Human label for a blocked entry, falling back to a short PUUID when nameless. */
export const blockedLabel = (b: RiotBlockedPlayer): string => {
  const id = b.game_name && b.game_tag ? `${b.game_name}#${b.game_tag}` : b.game_name || b.name || '';
  return id || String(b.puuid || b.pid || '').split('@')[0].slice(0, 13);
};

/**
 * Batched PUUID -> Riot ID through the Riot Client's own account service.
 * Used to label entries whose payload carried no name.
 */
export async function resolveNames(puuids: string[]): Promise<Record<string, { gameName: string; tagLine: string }>> {
  if (!isTauri() || puuids.length === 0) return {};
  try {
    const raw = await invoke<string>('riot_local_namesets', { puuids });
    const list = JSON.parse(raw) as {
      puuid: string;
      alias?: { gameName?: string; tagLine?: string };
    }[];
    const out: Record<string, { gameName: string; tagLine: string }> = {};
    for (const n of list) {
      const name = n?.alias?.gameName;
      if (n?.puuid && name) out[String(n.puuid).toLowerCase()] = { gameName: name, tagLine: n.alias?.tagLine || '' };
    }
    return out;
  } catch {
    return {};
  }
}

export async function blockPlayer(puuid: string): Promise<void> {
  await req('POST', '/chat/v4/blocked', { puuid });
}

export async function unblockPlayer(puuid: string): Promise<void> {
  await req('DELETE', '/chat/v4/blocked', { puuid });
}

/* ------------------------------- presence ------------------------------ */

export interface RiotPresence {
  puuid: string;
  game_name: string;
  game_tag: string;
  product?: string;
  state?: string;
}

export async function getPresences(): Promise<RiotPresence[]> {
  const res = await req<{ presences?: RiotPresence[] }>('GET', '/chat/v4/presences');
  return res?.presences ?? [];
}

/**
 * Friends list + live presence in one pass. Presence only arrives for friends
 * who are online, so a presence entry IS the online signal.
 */
export async function getFriendsWithPresence(): Promise<RiotFriend[]> {
  const [friends, presences] = await Promise.all([
    getFriends(),
    getPresences().catch(() => [] as RiotPresence[]),
  ]);
  const byPuuid = new Map(presences.map((p) => [String(p.puuid).toLowerCase(), p]));
  return friends.map((f) => {
    const p = byPuuid.get(String(f.puuid).toLowerCase());
    return {
      ...f,
      online: !!p,
      product: p?.product,
      state: p?.state,
    };
  });
}

export const productLabel = (product?: string): string => {
  switch ((product || '').toLowerCase()) {
    case 'valorant':
      return 'Valorant';
    case 'league_of_legends':
      return 'League';
    case 'riot_client':
      return 'Riot Client';
    case 'bacon_teamfight_tactics':
      return 'TFT';
    default:
      return product ? product.replace(/_/g, ' ') : '';
  }
};
