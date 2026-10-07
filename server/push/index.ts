// Wires the Notifier to the Store. Created after store.init() so migration 007 has run.
import { store } from "../store";
import { firebaseConfigured } from "../firebase";
import { Notifier } from "./notifier";
import { MemoryPushRepo, PgPushRepo, type PushRepo } from "./repo";
import { FcmSender, MemorySender, type PushSender } from "./sender";

let notifier: Notifier | null = null;
let isForeground: (userId: string) => boolean = () => false;

export function setForegroundCheck(fn: (userId: string) => boolean) {
  isForeground = fn;
}

export function initPush(opts: { repo?: PushRepo; sender?: PushSender } = {}) {
  const repo = opts.repo ?? (process.env.DATABASE_URL ? new PgPushRepo(process.env.DATABASE_URL) : new MemoryPushRepo());
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
  });
  console.log(`[push] ${sender.name === "fcm" ? "FCM HTTP v1 (firebase-admin)" : "disabled (no FIREBASE_SERVICE_ACCOUNT_JSON) — pushes are recorded, not sent"}; storage ${repo instanceof PgPushRepo ? "Postgres" : "memory"}`);
  const purge = setInterval(() => void repo.purgeExpiredHashes().catch(() => {}), 3600_000);
  purge.unref();
  void repo.purgeExpiredHashes().catch(() => {});
  return notifier;
}

export function push(): Notifier | null {
  return notifier;
}

/** fire-and-forget: notifications never break the action that triggered them */
export function bg(p: Promise<unknown> | null | undefined) {
  p?.catch((err) => console.warn("[push] failed:", (err as Error).message));
}
