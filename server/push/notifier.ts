// Clubhouse-style push notifications: who gets what, with per-user toggles, quiet hours, dedupe/collapse and caps.
import { inQuietHours, mergePrefs, type NotifPrefs, type NotifType } from "./prefs";
import type { PushRepo, Platform } from "./repo";
import type { PushMessage, PushSender } from "./sender";
import { cleanHashes, pepperHash, clientHash } from "./contacts";

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
  now?(): number;
}

export const ACTIVE_ROOM_TYPES: NotifType[] = ["followedRoom", "trendingRoom", "scheduledRoom", "recentRoom"];
export const ACTIVE_ROOM_INTERVAL_MS = 10 * 60_000; // max 1 "active rooms" push per user per 10 min
export const DEDUPE_MS = 30 * 60_000; // same (user, dedupe key) at most once per 30 min
export const HOURLY_CAP = 20; // all non-DM pushes per user per hour
export const DM_HOURLY_CAP = 30; // DM pushes per user per hour (collapse per thread anyway)
export const FOLLOWER_BATCH_MS = 10 * 60_000;
export const TRENDING_MIN_FOLLOWED = 3;
export const RECENT_ROOM_MS = 7 * 24 * 3600_000;

export type Outcome = "sent" | "no-tokens" | `skip:${string}`;

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
  deleteUserData(userId: string) {
    return this.d.repo.deleteUserData(userId);
  }
  getPrefs(userId: string) {
    return this.d.repo.getPrefs(userId);
  }
  async updatePrefs(userId: string, patch: unknown) {
    const next = mergePrefs(await this.d.repo.getPrefs(userId), patch);
    await this.d.repo.setPrefs(userId, next);
    if (!next.contactsOptIn) await this.d.repo.deleteContactHashes(userId);
    return next;
  }

  // ---------- core gate ----------
  private pruneWindow(list: number[], now: number) {
    return list.filter((t) => now - t < 3600_000);
  }

  async deliver(userId: string, type: NotifType, msg: PushMessage, opts: { dedupeKey?: string } = {}): Promise<Outcome> {
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

    const tokens = await this.d.repo.tokensFor(userId);
    if (!tokens.length) return "no-tokens";
    // count it before the network round-trip so bursts can't race past the gates
    if (opts.dedupeKey) this.dedupe.set(`${userId}|${opts.dedupeKey}`, now);
    if (ACTIVE_ROOM_TYPES.includes(type)) this.lastActiveRoom.set(userId, now);
    this.hourly.set(capKey, [...recent, now]);
    const res = await this.d.sender.send(tokens, this.withBadge(userId, msg));
    for (const t of res.invalidTokens) await this.d.repo.removeToken(t);
    return "sent";
  }

  /** every push carries the current total unread as data.badge (Android launcher badge / iOS aps.badge) */
  private withBadge(userId: string, msg: PushMessage): PushMessage {
    if (!this.d.badgeCount) return msg;
    let n = 0;
    try {
      n = Math.max(0, Math.floor(this.d.badgeCount(userId)) || 0);
    } catch {
      return msg;
    }
    return { ...msg, badge: n, data: { ...(msg.data ?? {}), badge: String(n) } };
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

  /** someone started a room: their followers (followedRoom) + people recently in their rooms (recentRoom) */
  async roomStarted(roomId: string, roomTitle: string, hostId: string) {
    const name = this.d.userName(hostId) ?? "Someone";
    const out: Record<string, Outcome> = {};
    const followers = new Set(this.d.followerIds(hostId));
    for (const uid of followers) {
      if (uid === hostId) continue;
      out[uid] = await this.deliver(
        uid,
        "followedRoom",
        { type: "followedRoom", title: `${name} started a room`, body: roomTitle, channel: "rooms", tag: `room:${roomId}`, url: `/room/${roomId}`, data: { roomId } },
        { dedupeKey: `room:${roomId}` },
      );
    }
    const now = this.now();
    for (const [uid, at] of this.recentByHost.get(hostId) ?? []) {
      if (uid === hostId || followers.has(uid) || now - at > RECENT_ROOM_MS) continue;
      out[uid] = await this.deliver(
        uid,
        "recentRoom",
        { type: "recentRoom", title: `${name} is live again`, body: roomTitle, channel: "rooms", tag: `room:${roomId}`, url: `/room/${roomId}`, data: { roomId } },
        { dedupeKey: `room:${roomId}` },
      );
    }
    return out;
  }

  /**
   * someone joined a room. Their followers hear about it (followedRoom); when ≥3 people you follow are in a
   * room it's "trending for you" (trendingRoom). One push per room per user (dedupe), max 1/10 min overall.
   */
  async roomJoined(room: { id: string; title: string; hostId: string; participantIds: string[] }, userId: string) {
    const recent = this.recentByHost.get(room.hostId) ?? new Map();
    recent.set(userId, this.now());
    this.recentByHost.set(room.hostId, recent);
    const inRoom = new Set(room.participantIds);
    const name = this.d.userName(userId) ?? "Someone";
    const out: Record<string, Outcome> = {};
    for (const uid of this.d.followerIds(userId)) {
      if (inRoom.has(uid)) continue;
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
          { dedupeKey: `room:${room.id}` },
        );
      } else {
        out[uid] = await this.deliver(
          uid,
          "followedRoom",
          { type: "followedRoom", title: `${name} joined a room`, body: room.title, channel: "rooms", tag: `room:${room.id}`, url: `/room/${room.id}`, data: { roomId: room.id } },
          { dedupeKey: `room:${room.id}` },
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
        { dedupeKey: `room:${roomId}` },
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

  // ---------- contacts ----------
  /** match uploaded client hashes against members; keeps peppered hashes ≤24 h for "X joined" pushes */
  async matchContacts(ownerId: string, raw: unknown, append = false) {
    const prefs = await this.d.repo.getPrefs(ownerId);
    if (!prefs.contactsOptIn) return { ok: false as const, error: "Turn on “Find friends from contacts” first" };
    const hashes = cleanHashes(raw);
    if (!hashes) return { ok: false as const, error: "Too many contacts" };
    const want = new Set(hashes);
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
    );
    return { ok: true as const, userIds: matches, matchedHashes: [...matchedHashes] };
  }

  /** a new member joined: tell opted-in users who uploaded their number in the last 24 h */
  async contactJoined(newUserId: string, e164: string) {
    const owners = await this.d.repo.ownersOfHash(pepperHash(clientHash(e164)));
    const name = this.d.userName(newUserId) ?? "A friend";
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
        { type: "contactJoined", title: "A friend joined Open Lounge 🎉", body: `Your contact ${name} just joined — say hi!`, channel: "social", tag: `joined:${newUserId}`, url: `/profile/${newUserId}`, data: { userId: newUserId } },
        { dedupeKey: `joined:${newUserId}` },
      );
    }
    return out;
  }
}
