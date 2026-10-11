// Wires the Notifier to the Store. Created after store.init() so migration 007 has run.
import { store } from "../store";
import { firebaseConfigured } from "../firebase";
import { Notifier, type InAppNotice } from "./notifier";
import { MemoryPushRepo, PgPushRepo, type PushRepo } from "./repo";
import { FcmSender, MemorySender, type PushSender } from "./sender";
import { MemoryLiveInbox, PgLiveInbox, type LiveInboxRepo, type LiveNotice } from "./liveInbox";
import { startTrendingLive } from "./trendingLive";

let notifier: Notifier | null = null;
let inbox: LiveInboxRepo | null = null;
let isForeground: (userId: string) => boolean = () => false;

export function setForegroundCheck(fn: (userId: string) => boolean) {
  isForeground = fn;
}

/** realtime.ts plugs in the WebSocket fan-out for in-app notices ("notify:activity") */
let inAppSink: ((userId: string, n: InAppNotice) => boolean) | null = null;
export function setInAppSink(fn: ((userId: string, n: InAppNotice) => boolean) | null) {
  inAppSink = fn;
}

/** realtime.ts plugs in the WebSocket fan-out for Live now inbox changes ("notify:inbox") */
let inboxSink: ((userId: string, n: LiveNotice) => void) | null = null;
export function setInboxSink(fn: ((userId: string, n: LiveNotice) => void) | null) {
  inboxSink = fn;
}

export function initPush(opts: { repo?: PushRepo; sender?: PushSender; inbox?: LiveInboxRepo } = {}) {
  const repo = opts.repo ?? (process.env.DATABASE_URL ? new PgPushRepo(process.env.DATABASE_URL) : new MemoryPushRepo());
  inbox = opts.inbox ?? (process.env.DATABASE_URL ? new PgLiveInbox(process.env.DATABASE_URL) : new MemoryLiveInbox());
  const sender = opts.sender ?? (firebaseConfigured() ? new FcmSender() : new MemorySender());
  notifier = new Notifier({
    repo,
    sender,
    isForeground: (id) => isForeground(id),
    userName: (id) => store.users.get(id)?.name ?? null,
    userHandle: (id) => store.users.get(id)?.username ?? null,
    followerIds: (id) => store.followerIds(id),
    followingIds: (id) => store.followingIds(id),
    usersWithPhones: function* () {
      for (const u of store.users.values()) if (!u.isBot && u.phone) yield [u.id, u.phone] as [string, string];
    },
    isBot: (id) => store.users.get(id)?.isBot ?? false,
    badgeCount: (id) => store.unreadDmCount(id),
    inApp: (id, n) => inAppSink?.(id, n) ?? false,
    blocked: (a, b) => store.isBlockedEither(a, b),
    inbox,
    inboxChanged: (id, n) => inboxSink?.(id, n),
  });
  console.log(`[push] ${sender.name === "fcm" ? "FCM HTTP v1 (firebase-admin)" : "disabled (no FIREBASE_SERVICE_ACCOUNT_JSON) — pushes are recorded, not sent"}; storage ${repo instanceof PgPushRepo ? "Postgres" : "memory"}`);
  const purge = setInterval(() => void repo.purgeExpiredHashes().catch(() => {}), 3600_000);
  purge.unref();
  void repo.purgeExpiredHashes().catch(() => {});
  // weekly "Trending live" pick (hourly look; at most one per user per week, see trendingLive.ts)
  const n = notifier;
  const box = inbox;
  startTrendingLive({
    notifier: n,
    inbox: box,
    liveRooms: () =>
      [...store.rooms.values()]
        .filter((r) => !r.ended)
        .map((r) => ({ id: r.id, title: r.title, hostId: r.hostId, seeded: r.seeded, private: r.private, participantIds: [...r.participants.keys()].filter((id) => !store.users.get(id)?.isBot) })),
    userIds: function* () {
      for (const u of store.users.values()) if (!u.isBot) yield u.id;
    },
    followingIds: (id) => store.followingIds(id),
    blocked: (a, b) => store.isBlockedEither(a, b),
  });
  return notifier;
}

export function liveInbox(): LiveInboxRepo | null {
  return inbox;
}

export function push(): Notifier | null {
  return notifier;
}

/** fire-and-forget: notifications never break the action that triggered them */
export function bg(p: Promise<unknown> | null | undefined) {
  p?.catch((err) => console.warn("[push] failed:", (err as Error).message));
}
