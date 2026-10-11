// Weekly "Trending live" pick: once per user per ISO week (UTC), the most-joined live room at send time, for people
// who don't follow its host (followers already hear about it through followedRoom). Same gates as every room push
// (pref "trendingLive", quiet hours, the 1-per-10-min active-room throttle, caps), never across a block.
// Idempotent: the (user, week) claim in the Live now store (migration 032) is taken before sending and given back
// when the pick didn't go out, so a later run that week can try again; a restart or a second instance never doubles it.
import type { LiveInboxRepo } from "./liveInbox";
import type { Notifier, Outcome } from "./notifier";

/** a room needs at least this many people in it to be worth a platform-wide nudge */
export const TRENDING_LIVE_MIN_PEOPLE = 5;
/** how often the scheduler looks for a pick (each user still gets at most one per week) */
export const TRENDING_LIVE_INTERVAL_MS = 60 * 60_000;

export interface TrendingRoom {
  id: string;
  title: string;
  hostId: string;
  /** people in the room now (humans) */
  participantIds: string[];
  seeded?: boolean;
  private?: boolean;
}

export interface TrendingLiveDeps {
  notifier: Pick<Notifier, "trendingLive">;
  inbox: Pick<LiveInboxRepo, "claimWeek" | "releaseWeek">;
  liveRooms(): TrendingRoom[];
  /** every member who could get the pick (non-bot) */
  userIds(): Iterable<string>;
  followingIds(userId: string): string[];
  blocked(a: string, b: string): boolean;
  now?(): number;
}

/** ISO 8601 week in UTC, e.g. "2026-W41" */
export function isoWeek(at: number): string {
  const d = new Date(at);
  const day = d.getUTCDay() || 7; // Mon=1 … Sun=7
  const thu = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day);
  const y = new Date(thu).getUTCFullYear();
  const week = Math.ceil(((thu - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
}

/** the most-joined public, user-created live room right now (ties: earliest id for a stable pick), or null */
export function pickTrendingRoom(rooms: TrendingRoom[]): TrendingRoom | null {
  let best: TrendingRoom | null = null;
  for (const r of rooms) {
    if (r.seeded || r.private || r.participantIds.length < TRENDING_LIVE_MIN_PEOPLE) continue;
    if (!best || r.participantIds.length > best.participantIds.length || (r.participantIds.length === best.participantIds.length && r.id < best.id)) best = r;
  }
  return best;
}

/** outcomes that count as "this week's pick went out" (no-tokens: it still landed in the Live now inbox) */
const DELIVERED = new Set<Outcome>(["sent", "in-app", "no-tokens"]);

export async function runTrendingLive(d: TrendingLiveDeps): Promise<{ week: string; roomId: string | null; out: Record<string, Outcome> }> {
  const now = d.now?.() ?? Date.now();
  const week = isoWeek(now);
  const room = pickTrendingRoom(d.liveRooms());
  const out: Record<string, Outcome> = {};
  if (!room) return { week, roomId: null, out };
  const inRoom = new Set(room.participantIds);
  for (const uid of d.userIds()) {
    if (uid === room.hostId || inRoom.has(uid)) continue;
    if (d.followingIds(uid).includes(room.hostId)) continue; // followers: followedRoom covers it
    if (d.blocked(uid, room.hostId)) {
      out[uid] = "skip:blocked";
      continue;
    }
    if (!(await d.inbox.claimWeek(uid, week, room.id))) {
      out[uid] = "skip:week";
      continue;
    }
    let r: Outcome;
    try {
      r = await d.notifier.trendingLive(uid, { id: room.id, title: room.title, hostId: room.hostId, count: room.participantIds.length });
    } catch (e) {
      await d.inbox.releaseWeek(uid, week);
      throw e;
    }
    if (!DELIVERED.has(r)) await d.inbox.releaseWeek(uid, week);
    out[uid] = r;
  }
  return { week, roomId: room.id, out };
}

/** hourly scheduler (unref'd); one run at a time */
export function startTrendingLive(d: TrendingLiveDeps, intervalMs = TRENDING_LIVE_INTERVAL_MS) {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runTrendingLive(d)
      .catch((e) => console.warn("[push] trending live failed:", (e as Error).message))
      .finally(() => (running = false));
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
