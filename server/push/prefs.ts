export const NOTIF_TYPES = ["dm", "roomInvite", "followedRoom", "trendingRoom", "scheduledRoom", "recentRoom", "newFollower", "contactJoined", "trendingLive"] as const;
export type NotifType = (typeof NOTIF_TYPES)[number];

export interface QuietHours {
  start: string; // "HH:MM"
  end: string;
  tz: string; // IANA zone
}
/** contactsKeep = "Tell me when contacts join": while on, scrambled codes of contacts who aren't members yet are kept
 *  (no 24 h purge) so we can say "Maya just joined Open Lounge" whenever they join. Off → codes erased right away. */
export type NotifPrefs = Record<NotifType, boolean> & { quietHours: QuietHours | null; contactsOptIn: boolean; contactsKeep: boolean };

export const DEFAULT_PREFS: NotifPrefs = {
  dm: true,
  roomInvite: true,
  followedRoom: true,
  trendingRoom: true,
  scheduledRoom: true,
  recentRoom: false,
  newFollower: true,
  contactJoined: true,
  /** weekly "Trending live" pick: the busiest live room, for people who don't follow its host (server/push/trendingLive.ts) */
  trendingLive: true,
  quietHours: null,
  contactsOptIn: false,
  contactsKeep: false,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validTz(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Merge a (partial, untrusted) patch over prefs; unknown keys dropped. */
export function mergePrefs(base: Partial<NotifPrefs> | null | undefined, patch: unknown): NotifPrefs {
  const out: NotifPrefs = { ...DEFAULT_PREFS, ...(base ?? {}) };
  if (!patch || typeof patch !== "object") return out;
  const p = patch as Record<string, unknown>;
  for (const k of NOTIF_TYPES) if (typeof p[k] === "boolean") out[k] = p[k] as boolean;
  if (typeof p.contactsOptIn === "boolean") out.contactsOptIn = p.contactsOptIn;
  if (typeof p.contactsKeep === "boolean") out.contactsKeep = p.contactsKeep;
  if (!out.contactsOptIn) out.contactsKeep = false; // no contacts uploaded → nothing to keep
  if (p.quietHours === null) out.quietHours = null;
  else if (p.quietHours && typeof p.quietHours === "object") {
    const q = p.quietHours as Record<string, unknown>;
    if (typeof q.start === "string" && HHMM.test(q.start) && typeof q.end === "string" && HHMM.test(q.end) && validTz(q.tz))
      out.quietHours = { start: q.start, end: q.end, tz: q.tz };
  }
  return out;
}

/** Is `at` inside the quiet window (wraps midnight when start > end)? */
export function inQuietHours(q: QuietHours | null, at = Date.now()): boolean {
  if (!q) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: q.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const h = Number(parts.find((x) => x.type === "hour")?.value);
  const m = Number(parts.find((x) => x.type === "minute")?.value);
  const now = h * 60 + m;
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const s = toMin(q.start);
  const e = toMin(q.end);
  if (s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e;
}
