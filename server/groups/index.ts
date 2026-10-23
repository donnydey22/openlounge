// Wiring for the generic conversation layer: the GroupService singleton, its WebSocket handlers (group:* + conv:*),
// the per-member fan-out and the HTTP routes (/api/groups/<id>/photo, /api/groups/invite/<token>).
import type { PageQuery } from "../chat/paging";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Ack, PublicUser } from "../../src/lib/types";
import type { InboxItem } from "../../src/lib/groups";
import type { Conn, WsHub } from "../ws";
import { store } from "../store";
import { isGroupId } from "../conversation";
import { push, bg } from "../push";
import { createGroupsRepo } from "./repo";
import { GroupService } from "./service";
import { media } from "../media/service";

export const groups = new GroupService(store, createGroupsRepo());

type AckFn = (res: Ack<Record<string, unknown>>) => void;
type Authed = (ack: AckFn | undefined, fn: (userId: string) => void) => void;
type WithOnline = <T extends { id: string }>(u: T) => T & { online: boolean; lastSeenAt: number | null; presence: "online" | "away" | "offline" };
const noop: AckFn = () => {};
const TYPING_MIN_GAP_MS = 1_000;

let hub: WsHub | null = null;
let withOnlineRef: WithOnline | null = null;

/** Called once from registerRealtime (after store.init): hooks the store, loads groups, sets up the emitter. */
export function wireGroups(io: WsHub, withOnline: WithOnline) {
  hub = io;
  withOnlineRef = withOnline;
  store.groups = groups;
  // photos / files in groups: media access + media:update fan-out follow current membership
  media.setConversationResolver((cid) => (isGroupId(cid) ? groups.memberIds(cid) : null));
  // account deletion hook (present once the store-compliance deletion work is in; members of deleted accounts are
  // filtered out of every view regardless, because memberIds() only returns existing users)
  (store as unknown as { onAccountDeleted?: (fn: (id: string) => void) => void }).onAccountDeleted?.((userId) => groups.accountDeleted(userId));
  groups.attach({
    toUsers(ids, ev, data) {
      let b: ReturnType<WsHub["to"]> | null = null;
      for (const id of ids) b = (b ?? io).to(`user:${id}`) as ReturnType<WsHub["to"]>;
      b?.emit(ev, data);
    },
    isForeground(userId) {
      for (const c of io.members(`user:${userId}`)) if (!c.hidden) return true;
      return false;
    },
    push(userId, msg) {
      bg(push()?.deliver(userId, "dm", { type: "dm", channel: "messages", ...msg }));
    },
    clearPush(userId, gid) {
      bg(push()?.dmRead(userId, gid));
    },
    mediaMessageDeleted(messageId) {
      void media.onMessageDeleted(messageId).catch((err) => console.error("[groups] media delete failed:", err));
    },
    mediaConversationDeleted(conversationId) {
      void media.purgeConversation(conversationId).catch((err) => console.error("[groups] media purge failed:", err));
    },
    presence(userId) {
      const u = withOnline({ id: userId });
      return { online: u.online, presence: u.presence, lastSeenAt: u.lastSeenAt };
    },
  });
  groups.ready = groups.init().catch((err) => console.error("[groups] load failed:", err));
}

/** dm:message for a group → per-member fan-out (store.events.dmMessage calls this for toId = group id). */
export function groupMessage(msg: Parameters<GroupService["fanout"]>[0]) {
  groups.fanout(msg);
}

/** typing in a group: "conv:typing" to the other members (never stored). */
const lastTyping = new Map<string, number>();
export function groupTyping(userId: string, gid: string, ev: "dm:typing" | "dm:typing_stop") {
  if (!groups.canAccess(userId, gid)) return;
  const k = `${userId}|${gid}`;
  const now = Date.now();
  if (ev === "dm:typing") {
    if (now - (lastTyping.get(k) ?? 0) < TYPING_MIN_GAP_MS) return;
    lastTyping.set(k, now);
  } else lastTyping.delete(k);
  if (lastTyping.size > 5000) lastTyping.clear();
  const u = store.publicUser(userId);
  const to = groups.memberIds(gid).filter((id) => id !== userId && !store.isBlocked(id, userId));
  for (const id of to)
    hub?.to(`user:${id}`).emit(ev === "dm:typing" ? "conv:typing" : "conv:typing_stop", { conversationId: gid, from: userId, name: u?.name ?? "", color: u?.color ?? "", photoUrl: u?.photoUrl ?? null });
}

/** dm:history with peerId = group id */
export function groupHistory(userId: string, gid: string, before?: number | PageQuery) {
  const h = groups.history(userId, gid, before);
  const info = groups.info(userId, gid);
  const conv = groups.convs.get(gid);
  if (!h || !info || !conv) return { ok: false as const, error: "Group not found" };
  return { ok: true as const, peer: groups.asPeer(conv), group: info, ...h };
}

/** Unified inbox: 1:1 conversations + groups, newest activity first. */
export function inboxFor(userId: string): InboxItem[] {
  const w = withOnlineRef ?? (<T,>(u: T) => u as never);
  const dms: InboxItem[] = store.conversations(userId).map((c) => ({
    type: "dm" as const,
    id: c.peer.id,
    peer: w(c.peer) as PublicUser,
    lastMessage: { ...c.lastMessage, conversationId: [userId, c.peer.id].sort().join("|") },
    unread: c.unread,
  }));
  const all = [...dms, ...groups.inbox(userId)];
  const at = (x: InboxItem) => (x.type === "dm" ? x.lastMessage.createdAt : x.updatedAt);
  return all.sort((a, b) => at(b) - at(a));
}

/** group:* and conv:* WebSocket handlers for one connection. */
export function attachGroupHandlers(socket: Conn, authed: Authed) {
  const on = (ev: string, fn: (userId: string, d: Record<string, unknown>) => unknown) =>
    socket.on(ev, async (data: Record<string, unknown> | undefined, ack: AckFn = noop) => {
      await groups.ready;
      authed(ack, (userId) => {
        try {
          ack(fn(userId, data ?? {}) as Ack<Record<string, unknown>>);
        } catch (err) {
          console.error(`[groups] ${ev} failed:`, err);
          ack({ ok: false, error: "Something went wrong" });
        }
      });
    });
  on("conv:list", (uid) => ({ ok: true, items: inboxFor(uid), unread: store.unreadDmCount(uid) }));
  on("group:create", (uid, d) => groups.create(uid, d));
  on("group:get", (uid, d) => {
    const g = typeof d.id === "string" ? groups.info(uid, d.id) : null;
    return g ? { ok: true, group: g } : { ok: false, error: "Group not found" };
  });
  on("group:update", (uid, d) => groups.update(uid, String(d.id), d));
  on("group:addMembers", (uid, d) => groups.addMembers(uid, String(d.id), d.userIds));
  on("group:removeMember", (uid, d) => groups.removeMember(uid, String(d.id), d.userId));
  on("group:setRole", (uid, d) => groups.setRole(uid, String(d.id), d.userId, d.role));
  on("group:transfer", (uid, d) => groups.transferOwnership(uid, String(d.id), d.userId));
  on("group:leave", (uid, d) => groups.leave(uid, String(d.id)));
  on("group:mute", (uid, d) => groups.setMuted(uid, String(d.id), d.muted));
  on("group:pin", (uid, d) => groups.pin(uid, String(d.id), d.messageId, d.pinned));
  on("group:deleteMessage", (uid, d) => groups.deleteMessage(uid, String(d.id), d.messageId));
  on("group:inviteCreate", (uid, d) => groups.createInvite(uid, String(d.id), { expiresInSec: d.expiresInSec, maxUses: d.maxUses }));
  on("group:inviteRevoke", (uid, d) => groups.revokeInvite(uid, String(d.id), d.token));
  on("group:invitePreview", (uid, d) => groups.previewInvite(d.token, uid));
  on("group:join", (uid, d) => groups.joinByInvite(uid, d.token));
  on("group:report", (uid, d) => store.createReport(uid, { targetType: "group", targetId: d.id, reason: d.reason, note: d.note }));
}

/** /api/groups/<id>/photo (public, immutable per version) and /api/groups/invite/<token> (preview, no auth). */
export async function handleGroupsApi(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
  await groups.ready;
  let m = /^\/api\/groups\/(g_[\w-]{1,40})\/photo$/.exec(url);
  if (m && (req.method === "GET" || req.method === "HEAD")) {
    const p = await groups.photo(m[1]);
    if (!p) {
      res.writeHead(404, { "Cache-Control": "no-store" }).end();
      return true;
    }
    res.writeHead(200, { "Content-Type": p.mime, "Content-Length": p.bytes.length, "Cache-Control": "public, max-age=31536000, s-maxage=600, immutable" }); // edge: 10 min (no per-URL purge)
    res.end(req.method === "HEAD" ? undefined : p.bytes);
    return true;
  }
  m = /^\/api\/groups\/invite\/([\w-]{8,64})$/.exec(url);
  if (m && req.method === "GET") {
    const r = groups.previewInvite(m[1], null);
    res.writeHead(r.ok ? 200 : (r.status ?? 404), { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(r));
    return true;
  }
  return false;
}

export { isGroupId };
