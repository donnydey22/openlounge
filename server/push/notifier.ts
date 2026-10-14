// Clubhouse-style push notifications: who gets what, with per-user toggles, quiet hours, dedupe/collapse and caps.
import { inQuietHours, mergePrefs, type NotifPrefs, type NotifType } from "./prefs";
import type { PushRepo, Platform } from "./repo";
import { voipService } from "../calls/voip";
import type { PushMessage, PushSender } from "./sender";
import { cleanHashes, pepperHash, clientHash } from "./contacts";

/** In-app copy of a notification for the user's open tabs/apps ("notify:activity" frame). The client shows a banner
 *  when visible, an OS notification from a hidden web tab, and nothing in a hidden native WebView (the push covers it). */
export interface InAppNotice {
  type: string;
  title: string;
  body: string;
  url: string;
  tag: string;
  /** whose avatar the banner shows (new member, host, joiner) */
  actorId?: string;
  roomId?: string;
}

export interface NotifierDeps {
  repo: PushRepo;
  sender: PushSender;
  /** does the user have a visible (foreground) connection right now? */
  isForeground(userId: string): boolean;
  userName(userId: string): string | null;
  userHandle?(userId: string): string | null;
  followerIds(userId: string): string[];
  followingIds(userId: string): string[];
  /** all (non-bot) users with a phone: [userId, e164] — contact matching */
  usersWithPhones(): Iterable<[string, string]>;
  isBot?(userId: string): boolean;
  /** app-icon badge: total unread for the user (unread DMs + unread notifications; main has no notification inbox yet, so = unread DMs) */
  badgeCount?(userId: string): number;
  /** either user blocked the other (live-activity notices never cross a block) */
  blocked?(a: string, b: string): boolean;
  /** send the in-app copy to the user's open connections; true when at least one connection got it */
  inApp?(userId: string, n: InAppNotice): boolean;
  now?(): number;
}

export const ACTIVE_ROOM_TYPES: NotifType[] = ["followedRoom", "trendingRoom", "scheduledRoom", "recentRoom"];
export const ACTIVE_ROOM_INTERVAL_MS = 0; // dropped 10-min active-room cap so every join can notify
export const DEDUPE_MS = 60_000; // loosened from 30 min; join events use per-joiner dedupe keys
export const HOURLY_CAP = 20; // all non-DM pushes per user per hour
export const DM_HOURLY_CAP = 30; // DM pushes per user per hour (collapse per thread anyway)
export const FOLLOWER_BATCH_MS = 10 * 60_000;
export const TRENDING_MIN_FOLLOWED = 3;
export const RECENT_ROOM_MS = 7 * 24 * 3600_000;

/** "in-app": shown in the user's open (visible) app/tab instead of a device push */
export type Outcome = "sent" | "in-app" | "no-tokens" | `skip:${string}`;

export class Notifier {
  private lastActiveRoom = new Map<string, number>();
  private dedupe = new Map<string, number>();
  private hourly = new Map<string, number[]>();
  private followerBuf = new Map<string, { names: string[]; ids: string[]; timer: NodeJS.Timeout | null; lastSentAt: number }>();
  /** host -> (userId -> last time they were in that host's room) */
  private recentByHost = new Map<string, Map<string, number>>();
  constructor(private d: NotifierDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  // ---------- tokens / prefs ----------
  async registerToken(userId: string, token: unknown, platform: unknown) {
    if (typeof token !== "string" || token.length < 20 || token.length > 4096 || /\s/.test(token)) return { ok: false as const, error: "Invalid token" };
    const p: Platform = platform === "ios" || platform === "web" ? platform : platform === "android" ? "android" : "web";
    await this.d.repo.upsertToken({ token, userId, platform: p });
    return { ok: true as const };
  }
  async unregisterToken(userId: string, token: unknown) {
    if (typeof token === "string") await this.d.repo.removeToken(token, userId);
    return { ok: true as const };
  }
  async deleteUserData(userId: string) {
    await this.d.repo.deleteUserData(userId);
    await voipService()?.store.deleteUser(userId); // PushKit tokens (server/calls/voip.ts)
  }
  getPrefs(userId: string) {
    return this.d.repo.getPrefs(userId);
  }
  async updatePrefs(userId: string, patch: unknown) {
    const prev = await this.d.repo.getPrefs(userId);
    const next = mergePrefs(prev, patch);
    await this.d.repo.setPrefs(userId, next);
    // contacts off, or "Tell me when contacts join" switched off → every uploaded code is erased right away
    if (!next.contactsOptIn || (prev.contactsKeep && !next.contactsKeep)) await this.d.repo.deleteContactHashes(userId);
    else if (next.contactsKeep && !prev.contactsKeep) await this.d.repo.keepContactHashes(userId);
    return next;
  }

  // ---------- core gate ----------
  private pruneWindow(list: number[], now: number) {
    return list.filter((t) => now - t < 3600_000);
  }

  /**
   * opts.live: also send the in-app copy (notify:activity) to the user's open connections, and skip the device push
   * while one of them is visible (same rule as DMs: the in-app banner already showed it). Same gates either way.
   * opts.skipPlatforms: leave those devices out (calls: the iPhone already rings through CallKit).
   */
  async deliver(userId: string, type: NotifType, msg: PushMessage, opts: { dedupeKey?: string; live?: { actorId?: string; roomId?: string }; skipPlatforms?: Platform[] } = {}): Promise<Outcome> {
    if (this.d.isBot?.(userId)) return "skip:bot";
    const now = this.now();
    const prefs: NotifPrefs = await this.d.repo.getPrefs(userId);
    if (!prefs[type]) return "skip:pref";
    if (type !== "dm" && type !== "roomInvite" && inQuietHours(prefs.quietHours, now)) return "skip:quiet";
    if (opts.dedupeKey) {
      const k = `${userId}|${opts.dedupeKey}`;
      const at = this.dedupe.get(k);
      if (at !== undefined && now - at < DEDUPE_MS) return "skip:dedupe";
    }
    if (ACTIVE_ROOM_TYPES.includes(type)) {
      const last = this.lastActiveRoom.get(userId);
      if (last !== undefined && now - last < ACTIVE_ROOM_INTERVAL_MS) return "skip:throttle";
    }
    const capKey = `${type === "dm" ? "dm" : "all"}|${userId}`;
    const recent = this.pruneWindow(this.hourly.get(capKey) ?? [], now);
    if (recent.length >= (type === "dm" ? DM_HOURLY_CAP : HOURLY_CAP)) return "skip:cap";

    const tokens = (await this.d.repo.tokensFor(userId)).filter((t) => !opts.skipPlatforms?.includes(t.platform));
    const live = opts.live && this.d.inApp ? opts.live : null;
    const foreground = live ? this.d.isForeground(userId) : false;
    // count it before the network round-trip so bursts can't race past the gates
    const mark = () => {
      if (opts.dedupeKey) this.dedupe.set(`${userId}|${opts.dedupeKey}`, now);
      if (ACTIVE_ROOM_TYPES.includes(type)) this.lastActiveRoom.set(userId, now);
      this.hourly.set(capKey, [...recent, now]);
    };
    let shown = false;
    if (live) {
      shown = this.d.inApp!(userId, { type: msg.type, title: msg.title, body: msg.body, url: msg.url, tag: msg.tag, actorId: live.actorId, roomId: live.roomId });
      if (shown) mark();
      if (foreground && shown) return "in-app";
    }
    if (!tokens.length) return shown ? "in-app" : "no-tokens";
    if (!shown) mark();
    const res = await this.d.sender.send(tokens, this.withBadge(userId, msg));
    for (const t of res.invalidTokens) await this.d.repo.removeToken(t);
    return "sent";
  }

  /** Every push is stamped for client-side stale-delivery suppression and carries the current unread badge. */
  private withBadge(userId: string, msg: PushMessage): PushMessage {
    const data = { ...(msg.data ?? {}), sentAt: String(this.now()) };
    if (!this.d.badgeCount) return { ...msg, data };
    let n = 0;
    try {
      n = Math.max(0, Math.floor(this.d.badgeCount(userId)) || 0);
    } catch {
      return { ...msg, data };
    }
    return { ...msg, badge: n, data: { ...data, badge: String(n) } };
  }

  // ---------- triggers ----------
  /** new DM: push unless the recipient has the app in the foreground. Collapsed per thread. */
  async dm(m: { fromId: string; toId: string; text: string; fromName: string }) {
    if (this.d.isForeground(m.toId)) return "skip:foreground" as Outcome;
    const tag = `dm:${m.fromId}`;
    return this.deliver(m.toId, "dm", {
      type: "dm",
      title: m.fromName,
      body: m.text.length > 140 ? m.text.slice(0, 139) + "…" : m.text,
      channel: "messages",
      tag,
      url: `/messages/${m.fromId}`,
      data: { peerId: m.fromId },
    });
  }

  // ---------- 1:1 calls ----------
  /** Ringing while the app is closed/backgrounded: data message (wrappers build a full-screen call UI from it; see
   *  /workspace/calls/NATIVE_SPEC.md) + a visible "Incoming call" alert on iOS / web. Same tag as the missed call so it's replaced. */
  async callIncoming(calleeId: string, call: { id: string; callerId: string; video: boolean; expiresAt: number; caller: { name: string; photoUrl: string | null } }, opts: { skipIos?: boolean; declineToken?: string } = {}) {
    // skipIos: the iPhone already rings through CallKit (VoIP push, server/calls/voip.ts) → no duplicate "Incoming call" alert
    return this.deliver(calleeId, "dm", {
      type: "call_incoming",
      title: call.caller.name,
      body: call.video ? "📹 Incoming video call" : "📞 Incoming audio call",
      channel: "messages",
      tag: `call:${call.id}`,
      url: `/call/${call.id}`,
      data: { callId: call.id, callerId: call.callerId, callerName: call.caller.name, callerPhoto: call.caller.photoUrl?.startsWith("http") ? call.caller.photoUrl : "", video: call.video ? "1" : "0", expiresAt: String(call.expiresAt), peerId: call.callerId, ...(opts.declineToken ? { declineToken: opts.declineToken } : {}) },
    }, opts.skipIos ? { skipPlatforms: ["ios"] } : {});
  }

  /** stop the native ring UI (caller hung up / answered elsewhere / timeout) */
  async callCancel(calleeId: string, callId: string, reason: string) {
    const tokens = await this.d.repo.tokensFor(calleeId);
    if (!tokens.length) return;
    const res = await this.d.sender.send(tokens, { type: "call_cancel", title: "", body: "", channel: "messages", tag: `call:${callId}`, url: "", clear: true, data: { callId, reason } });
    for (const t of res.invalidTokens) await this.d.repo.removeToken(t);
  }

  /** "Missed call" with a Call back action (deep link opens the chat and starts the call back). */
  async missedCall(m: { fromId: string; toId: string; fromName: string; call?: { id: string; video: boolean } }) {
    if (this.d.isForeground(m.toId)) return "skip:foreground" as Outcome; // the in-app chat shows it
    const video = !!m.call?.video;
    return this.deliver(m.toId, "dm", {
      type: "missedCall",
      title: "Missed call",
      body: `${m.fromName} · ${video ? "video" : "audio"} call`,
      channel: "messages",
      tag: m.call ? `call:${m.call.id}` : `dm:${m.fromId}`,
      url: `/messages/${m.fromId}?call=${video ? "video" : "audio"}`,
      data: { peerId: m.fromId, action: "callback", ...(m.call ? { callId: m.call.id } : {}) },
    });
  }

  /** reader saw the thread: clear the notification on their devices */
  async dmRead(readerId: string, peerId: string) {
    const tokens = await this.d.repo.tokensFor(readerId);
    if (!tokens.length) return;
    const res = await this.d.sender.send(tokens, this.withBadge(readerId, { type: "clear", title: "", body: "", channel: "messages", tag: `dm:${peerId}`, url: "", clear: true }));
    for (const t of res.invalidTokens) await this.d.repo.removeToken(t);
  }

  async inviteToSpeak(roomId: string, roomTitle: string, actorId: string, targetId: string) {
    const name = this.d.userName(actorId) ?? "The host";
    return this.deliver(
      targetId,
      "roomInvite",
      { type: "roomInvite", title: "🎤 You're invited to speak", body: `${name} invited you to speak in “${roomTitle}”`, channel: "rooms", tag: `room:${roomId}`, url: `/room/${roomId}`, data: { roomId } },
      { dedupeKey: `invite:${roomId}` },
    );
  }

  async ping(roomId: string, roomTitle: string, actorId: string, targetId: string) {
    const name = this.d.userName(actorId) ?? "Someone";
    return this.deliver(
      targetId,
      "roomInvite",
      { type: "roomPing", title: `${name} pinged you`, body: `Join “${roomTitle}”`, channel: "rooms", tag: `room:${roomId}`, url: `/room/${roomId}`, data: { roomId } },
      { dedupeKey: `ping:${roomId}:${actorId}` },
    );
  }

  /** a room invite / drop-in card arrived in a DM: the push opens the room itself (one tap to join) */
  async roomInviteDm(roomId: string, roomTitle: string, actorId: string, targetId: string, kind: "room_invite" | "dropin") {
    if (this.d.isForeground(targetId)) return "skip:foreground" as Outcome; // the in-app DM banner shows it
    const name = this.d.userName(actorId) ?? "Someone";
    const dropin = kind === "dropin";
    return this.deliver(
      targetId,
      "roomInvite",
      {
        type: dropin ? "dropIn" : "roomInviteDm",
        title: dropin ? `🎙️ ${name} is live` : `🎙️ ${name} invited you`,
        body: dropin ? "Drop-in audio chat. Tap to join" : `Join “${roomTitle}”`,
        channel: "rooms",
        tag: `room:${roomId}`,
        url: `/room/${roomId}`,
        data: { roomId, peerId: actorId },
      },
      { dedupeKey: `dminvite:${roomId}:${actorId}` },
    );
  }

  /** host opens a room: followers (followedRoom) + people recently in their rooms (recentRoom). Fires on room:create. */
  async roomStarted(roomId: string, roomTitle: string, hostId: string) {
    const name = this.d.userName(hostId) ?? "Someone";
    const out: Record<string, Outcome> = {};
    const followers = new Set(this.d.followerIds(hostId));
    const live = { actorId: hostId, roomId };
    for (const uid of followers) {
      if (uid === hostId) continue;
      if (this.d.blocked?.(uid, hostId)) {
        out[uid] = "skip:blocked";
        continue;
      }
      out[uid] = await this.deliver(
        uid,
        "followedRoom",
        { type: "followedRoom", title: `🎙️ ${name} started a room`, body: roomTitle, channel: "rooms", tag: `room:${roomId}`, url: `/room/${roomId}`, data: { roomId } },
        { dedupeKey: `room:${roomId}`, live },
      );
    }
    const now = this.now();
    for (const [uid, at] of this.recentByHost.get(hostId) ?? []) {
      if (uid === hostId || followers.has(uid) || now - at > RECENT_ROOM_MS || this.d.blocked?.(uid, hostId)) continue;
      out[uid] = await this.deliver(
        uid,
        "recentRoom",
        { type: "recentRoom", title: `🔴 ${name} is live again`, body: roomTitle, channel: "rooms", tag: `room:${roomId}`, url: `/room/${roomId}`, data: { roomId } },
        { dedupeKey: `room:${roomId}`, live },
      );
    }
    return out;
  }

  /**
   * someone joined a room.
   * 1) Every other room member with notifications enabled hears about it (not only the joiner's followers).
   * 2) Followers of the joiner still get followedRoom / trendingRoom (existing feature kept).
   * Dedupe is per joiner (`join:room:user`) so every join can notify; the 15s active-room throttle is the burst floor.
   */
  async roomJoined(room: { id: string; title: string; hostId: string; participantIds: string[] }, userId: string) {
    const recent = this.recentByHost.get(room.hostId) ?? new Map();
    recent.set(userId, this.now());
    this.recentByHost.set(room.hostId, recent);
    const inRoom = new Set(room.participantIds);
    const name = this.d.userName(userId) ?? "Someone";
    const out: Record<string, Outcome> = {};
    const joinKey = `join:${room.id}:${userId}`;
    const live = { actorId: userId, roomId: room.id };

    // Room members already seated (host/speakers/listeners) — notify them first.
    for (const uid of room.participantIds) {
      if (uid === userId) continue;
      if (this.d.blocked?.(uid, userId)) {
        out[uid] = "skip:blocked";
        continue;
      }
      out[uid] = await this.deliver(
        uid,
        "followedRoom",
        {
          type: "followedRoom",
          title: `${name} joined`,
          body: room.title,
          channel: "rooms",
          tag: `room:${room.id}`,
          url: `/room/${room.id}`,
          data: { roomId: room.id, joinerId: userId },
        },
        { dedupeKey: joinKey, live },
      );
    }

    // Followers of the joiner who are not already in the room (existing Clubhouse-style fan-out).
    for (const uid of this.d.followerIds(userId)) {
      if (inRoom.has(uid)) continue;
      if (this.d.blocked?.(uid, userId)) {
        out[uid] = "skip:blocked";
        continue;
      }
      const followedInRoom = this.d.followingIds(uid).filter((f) => inRoom.has(f));
      if (followedInRoom.length >= TRENDING_MIN_FOLLOWED) {
        const names = followedInRoom.slice(0, 2).map((f) => this.d.userName(f) ?? "someone");
        out[uid] = await this.deliver(
          uid,
          "trendingRoom",
          {
            type: "trendingRoom",
            title: "🔥 Popular with people you follow",
            body: `${names.join(", ")} and ${followedInRoom.length - 2} more are in “${room.title}”`,
            channel: "rooms",
            tag: `room:${room.id}`,
            url: `/room/${room.id}`,
            data: { roomId: room.id },
          },
          { dedupeKey: joinKey, live },
        );
      } else {
        out[uid] = await this.deliver(
          uid,
          "followedRoom",
          { type: "followedRoom", title: `${name} joined a room`, body: room.title, channel: "rooms", tag: `room:${room.id}`, url: `/room/${room.id}`, data: { roomId: room.id } },
          { dedupeKey: joinKey, live },
        );
      }
    }
    return out;
  }

  /** Scheduled room starting → people who RSVP'd. (No scheduling/RSVP feature in the app yet: call this from it.) */
  async scheduledRoomStarting(roomId: string, roomTitle: string, rsvpUserIds: string[]) {
    const out: Record<string, Outcome> = {};
    for (const uid of rsvpUserIds)
      out[uid] = await this.deliver(
        uid,
        "scheduledRoom",
        { type: "scheduledRoom", title: "⏰ Starting now", body: roomTitle, channel: "rooms", tag: `room:${roomId}`, url: `/room/${roomId}`, data: { roomId } },
        { dedupeKey: `room:${roomId}`, live: { roomId } },
      );
    return out;
  }

  /** new follower. First one goes out right away; more within 10 min are batched into "A, B and N others followed you". */
  newFollower(targetId: string, followerId: string): Promise<Outcome> | null {
    if (followerId === targetId) return null;
    const now = this.now();
    let b = this.followerBuf.get(targetId);
    if (!b) this.followerBuf.set(targetId, (b = { names: [], ids: [], timer: null, lastSentAt: 0 }));
    if (b.ids.includes(followerId)) return null;
    b.ids.push(followerId);
    b.names.push(this.d.userName(followerId) ?? "Someone");
    if (now - b.lastSentAt >= FOLLOWER_BATCH_MS && !b.timer) return this.flushFollowers(targetId);
    if (!b.timer) {
      const wait = Math.max(0, FOLLOWER_BATCH_MS - (now - b.lastSentAt));
      b.timer = setTimeout(() => void this.flushFollowers(targetId), wait);
      b.timer.unref?.();
    }
    return null;
  }

  async flushFollowers(targetId: string): Promise<Outcome> {
    const b = this.followerBuf.get(targetId);
    if (!b || !b.ids.length) return "skip:empty";
    if (b.timer) clearTimeout(b.timer);
    const { names, ids } = b;
    b.timer = null;
    b.names = [];
    b.ids = [];
    b.lastSentAt = this.now();
    const body =
      names.length === 1 ? `${names[0]} followed you` : names.length === 2 ? `${names[0]} and ${names[1]} followed you` : `${names[0]}, ${names[1]} and ${names.length - 2} other${names.length === 3 ? "" : "s"} followed you`;
    return this.deliver(targetId, "newFollower", {
      type: "newFollower",
      title: "New follower" + (names.length > 1 ? "s" : ""),
      body,
      channel: "social",
      tag: "followers",
      url: names.length === 1 ? `/profile/${ids[0]}` : `/profile/${targetId}`,
      data: { userIds: ids.slice(0, 20).join(",") },
    });
  }

  /** someone you follow opened the app / appeared in the hallway (online). */
  async hallwayPresence(userId: string) {
    const name = this.d.userName(userId) ?? "Someone";
    const out: Record<string, Outcome> = {};
    for (const uid of this.d.followerIds(userId)) {
      if (uid === userId) continue;
      out[uid] = await this.deliver(
        uid,
        "hallwayPresence",
        {
          type: "hallwayPresence",
          title: `${name} is in the hallway`,
          body: "Open Open Lounge to say hi",
          channel: "social",
          tag: `hallway:${userId}`,
          url: `/profile/${userId}`,
          data: { userId },
        },
        { dedupeKey: `hallway:${userId}` },
      );
    }
    return out;
  }

  // ---------- contacts ----------
  /** match uploaded client hashes against members; keeps peppered hashes ≤24 h for "X joined" pushes */
  async matchContacts(ownerId: string, raw: unknown, append = false) {
    const prefs = await this.d.repo.getPrefs(ownerId);
    if (!prefs.contactsOptIn) return { ok: false as const, error: "Turn on “Find friends from contacts” first" };
    const hashes = cleanHashes(raw);
    if (!hashes) return { ok: false as const, error: "Too many contacts" };
    const want = new Set(hashes);
    const keep = prefs.contactsKeep;
    const matches: string[] = [];
    const matchedHashes = new Set<string>();
    for (const [uid, phone] of this.d.usersWithPhones()) {
      if (uid === ownerId) continue;
      const h = clientHash(phone);
      if (want.has(h)) (matches.push(uid), matchedHashes.add(h));
    }
    // Store peppered hashes of the *unmatched* numbers only (matched ones are already members), auto-purged after 24 h
    await this.d.repo.replaceContactHashes(
      ownerId,
      hashes.filter((h) => !matchedHashes.has(h)).map(pepperHash),
      append,
      keep,
    );
    return { ok: true as const, userIds: matches, matchedHashes: [...matchedHashes] };
  }

  /** a new member joined: tell opted-in users who have their number (uploaded in the last 24 h, or kept by
   *  "Tell me when contacts join"): "Maya just joined Open Lounge". Push + live in-app banner. */
  async contactJoined(newUserId: string, e164: string) {
    const owners = await this.d.repo.ownersOfHash(pepperHash(clientHash(e164)));
    const name = this.d.userName(newUserId) ?? "A friend";
    const first = name.split(/\s+/)[0] || name;
    const out: Record<string, Outcome> = {};
    for (const uid of owners) {
      if (uid === newUserId) continue;
      const prefs = await this.d.repo.getPrefs(uid);
      if (!prefs.contactsOptIn) {
        out[uid] = "skip:optout";
        continue;
      }
      out[uid] = await this.deliver(
        uid,
        "contactJoined",
        {
          type: "contactJoined",
          title: `${name} just joined Open Lounge 🎉`,
          body: `${first} is in your contacts. Say hi or follow them.`,
          channel: "social",
          tag: `joined:${newUserId}`,
          url: `/profile/${newUserId}`,
          data: { userId: newUserId },
        },
        { dedupeKey: `joined:${newUserId}`, live: { actorId: newUserId } },
      );
    }
    return out;
  }
}
