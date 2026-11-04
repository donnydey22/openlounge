// Group / room call ringing (Donny 2026-11-04 11:00 AM: ring on every surface for every call type).
// The caller is in a live room; ringing fans out to each target through the SAME surfaces as a 1:1 call:
// in-app "ring:incoming" + iOS VoIP (CallKit) + FCM call_incoming (Android full-screen CallStyle) + web push.
// Accept opens /call/<ringId>?accept=1 → the page joins /room/<roomId>. Cancel/answer/decline/timeout → call_cancel;
// anyone who never answered gets the normal "Missed call". Ring ids are "gr_<hex>" (separate from 1:1 call ids).
import { randomBytes } from "node:crypto";
import { store } from "../store";
import { bg, push } from "../push";
import { voipService } from "./voip";
import { declineTokens } from "./declineToken";
import { voipPayload } from "./index";

export const RING_MS = 45_000;
export const MAX_TARGETS = 50;
export const isGroupRingId = (id: string) => /^gr_[a-f0-9]{16}$/.test(id);

type Ring = { id: string; callerId: string; roomId: string; groupId: string | null; video: boolean; expiresAt: number; pending: Set<string>; answered: Set<string>; timer: ReturnType<typeof setTimeout> };
type Emit = (userId: string, ev: string, data: unknown) => void;

export class GroupRinger {
  rings = new Map<string, Ring>();
  constructor(private emit: Emit, private deps = {
    roomOf: (uid: string) => store.currentRoomOf(uid),
    members: (gid: string): string[] => (store as unknown as { groups?: { memberIds(g: string): string[] } }).groups?.memberIds(gid) ?? [],
    policy: (a: string, b: string) => store.callPolicy(a, b),
    user: (id: string) => store.publicUser(id) as { name: string; photoUrl?: string | null } | null,
    ringNative: (to: string, ring: Ring, caller: { name: string; photoUrl: string | null }) => {
      const call = { id: ring.id, callerId: ring.callerId, video: ring.video, expiresAt: ring.expiresAt, caller };
      const declineToken = declineTokens().mint(ring.id, to, ring.expiresAt);
      bg((async () => {
        const rang = await (voipService()?.ring(to, { ...voipPayload(call, declineToken), kind: "room", roomId: ring.roomId }, ring.expiresAt) ?? Promise.resolve(0)).catch(() => 0);
        await push()?.callIncoming(to, call, { skipIos: rang > 0, declineToken });
      })());
    },
    cancelNative: (to: string, id: string, reason: string) => bg(push()?.callCancel(to, id, reason)),
    missed: (to: string, ring: Ring, fromName: string) => bg(push()?.missedCall({ fromId: ring.callerId, toId: to, fromName, call: { id: ring.id, video: ring.video } })),
  }) {}

  start(callerId: string, input: { groupId?: unknown; userIds?: unknown; video?: unknown; roomId?: unknown }) {
    const roomId = typeof input.roomId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(input.roomId) ? input.roomId : this.deps.roomOf(callerId);
    if (!roomId) return { ok: false as const, error: "Join a room first" };
    const groupId = typeof input.groupId === "string" ? input.groupId : null;
    let targets: string[];
    if (groupId) {
      const m = this.deps.members(groupId);
      if (!m.includes(callerId)) return { ok: false as const, error: "Not a member" };
      targets = m;
    } else targets = Array.isArray(input.userIds) ? input.userIds.filter((x): x is string => typeof x === "string") : [];
    targets = [...new Set(targets)].filter((t) => t !== callerId && this.deps.policy(callerId, t).ok && this.deps.roomOf(t) !== roomId).slice(0, MAX_TARGETS);
    if (!targets.length) return { ok: false as const, error: "No one to ring" };
    const caller = this.deps.user(callerId);
    const c = { name: caller?.name ?? "Open Lounge", photoUrl: caller?.photoUrl ?? null };
    const id = `gr_${randomBytes(8).toString("hex")}`;
    const ring: Ring = { id, callerId, roomId, groupId, video: input.video === true, expiresAt: Date.now() + RING_MS, pending: new Set(targets), answered: new Set(), timer: setTimeout(() => this.finish(id, "timeout"), RING_MS) };
    (ring.timer as { unref?: () => void }).unref?.();
    this.rings.set(id, ring);
    for (const t of targets) {
      this.emit(t, "ring:incoming", { id, kind: groupId ? "group" : "room", roomId, groupId, video: ring.video, expiresAt: ring.expiresAt, caller: { id: callerId, ...c } });
      this.deps.ringNative(t, ring, c);
    }
    return { ok: true as const, id, roomId, rang: targets.length };
  }

  get(id: string, uid: string) {
    const r = this.rings.get(id);
    if (!r || (r.callerId !== uid && !r.pending.has(uid) && !r.answered.has(uid))) return null;
    return { id, roomId: r.roomId, groupId: r.groupId, video: r.video, expiresAt: r.expiresAt, callerId: r.callerId, phase: r.pending.has(uid) ? "ringing" : "ended" };
  }

  /** callee answered or declined: stop the ring on all of THEIR devices */
  respond(id: string, uid: string, answer: boolean) {
    const r = this.rings.get(id);
    if (!r || !r.pending.delete(uid)) return { ok: false as const, error: "Not ringing" };
    if (answer) r.answered.add(uid);
    this.emit(uid, "ring:cancel", { id, reason: answer ? "answered" : "declined" });
    this.deps.cancelNative(uid, id, answer ? "answered_elsewhere" : "declined");
    this.emit(r.callerId, "ring:update", { id, userId: uid, answer });
    if (!r.pending.size) this.finish(id, "done");
    return { ok: true as const, roomId: r.roomId };
  }

  cancel(id: string, uid: string) {
    const r = this.rings.get(id);
    if (!r || r.callerId !== uid) return { ok: false as const, error: "Not found" };
    this.finish(id, "cancelled");
    return { ok: true as const };
  }

  private finish(id: string, reason: "timeout" | "cancelled" | "done") {
    const r = this.rings.get(id);
    if (!r) return;
    clearTimeout(r.timer);
    this.rings.delete(id);
    const name = this.deps.user(r.callerId)?.name ?? "Someone";
    for (const t of r.pending) {
      this.emit(t, "ring:cancel", { id, reason });
      this.deps.cancelNative(t, id, reason);
      this.deps.missed(t, r, name);
    }
    this.emit(r.callerId, "ring:ended", { id, reason, answered: [...r.answered] });
  }
}

let ringer: GroupRinger | null = null;
export const groupRinger = () => ringer;
export function initGroupRinger(emit: Emit) { ringer = new GroupRinger(emit); return ringer; }
