// Generic conversation layer: Telegram-style groups on top of the existing DM pipeline.
//
// Group messages are ordinary DirectMessage rows in store.dms keyed by the group id (toId = group id), so everything
// that operates on a conversation's message list (reactions, invite cards, stickers, expiring files, moderation,
// persistence) applies to groups. This service owns membership, roles, pins, invite links, service messages,
// read cursors and the per-member fan-out / push. See /workspace/groups/MODEL.md.
import { randomBytes, randomUUID } from "node:crypto";
import type { DirectMessage, DmReadReceipt, PublicUser } from "../../src/lib/types";
import { AVATAR_COLORS, CHAT_MAX_LENGTH } from "../../src/lib/types";
import {
  GROUP_DESCRIPTION_MAX,
  GROUP_MAX_MEMBERS,
  GROUP_TITLE_MAX,
  canAdmin,
  mentionHandles,
  serviceText,
  type ConvMessage,
  type GroupInfo,
  type GroupInvite,
  type GroupMember,
  type GroupPin,
  type GroupSummary,
  type InboxItem,
  type InvitePreview,
} from "../../src/lib/groups";
import { filterText } from "../moderation";
import { isGroupId } from "../conversation";
import { log } from "../log";
import { replyReference } from "../../src/lib/chat/reply";
import type { GroupsRepo } from "./repo";
import type { ConvRecord, GroupRole, InviteRecord, MemberRecord, PinRecord, ServicePayload } from "./types";

/** What the service needs from the Store (kept narrow so tests can fake it and imports stay acyclic). */
export interface StoreLike {
  users: Map<string, { id: string; name: string; username: string; color: string; isBot: boolean }>;
  dms: Map<string, DirectMessage[]>;
  publicUser(id: string): PublicUser | null;
  isBlocked(blockerId: string, targetId: string): boolean;
  isBlockedEither(a: string, b: string): boolean;
  pushConversationMessage(key: string, msg: DirectMessage): void;
  removeConversationMessage(key: string, messageId: string): boolean;
  /** schedule a persistence snapshot (message fields changed in place) */
  saveSoon(): void;
  /** combined DM + group unread badge for a user */
  unreadDmCount(userId: string): number;
  /** per-user inbox state (pin) — shared with 1:1 chats, keyed (userId, gid) for groups */
  chatPrefs?: { get(userId: string, peerId: string): { pinnedAt: number | null } | undefined; set(userId: string, peerId: string, patch: { pinnedAt: number | null }): void };
}

export interface GroupEmitter {
  toUsers(userIds: Iterable<string>, ev: string, data: unknown): void;
  isForeground(userId: string): boolean;
  /** sends a push (best effort); type is the notification preference bucket */
  push(userId: string, msg: { title: string; body: string; tag: string; url: string; data: Record<string, string> }): void;
  /** the reader saw the group: clear its notification on their other devices */
  clearPush?(userId: string, conversationId: string): void;
  /** presence decoration for member lists */
  presence?(userId: string): { online: boolean; presence: "online" | "away" | "offline"; lastSeenAt: number | null };
  /** attachments: a group message was deleted for everyone → erase its files (server/media onMessageDeleted) */
  mediaMessageDeleted?(messageId: string): void;
  /** attachments: a group was deleted (last member out) → erase every file sent in it (server/media purgeConversation) */
  mediaConversationDeleted?(conversationId: string): void;
}

type Err = { ok: false; error: string; status?: number };
const err = (error: string, status = 400): Err => ({ ok: false, error, status });

const PIN_MAX = 50;
const INVITES_MAX = 20;
const CREATE_MAX_PER_HOUR = 10;
const MSG_MAX_PER_10S = 8;
const INVITE_MAX_TTL_MS = 365 * 86_400_000;
const PHOTO_MAX_BYTES = 400_000;
const HISTORY_CAP = 1000;

const clamp = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const cleanText = (s: unknown, max: number): { text: string } | { text: null; error: string } => {
  const text = String(s ?? "").trim().slice(0, max);
  if (!text) return { text };
  const r = filterText(text);
  return r.ok ? { text: r.text } : { text: null, error: r.error };
};

export class GroupService {
  convs = new Map<string, ConvRecord>();
  /** groupId -> userId -> member */
  members = new Map<string, Map<string, MemberRecord>>();
  /** userId -> groupIds */
  byUser = new Map<string, Set<string>>();
  pins = new Map<string, PinRecord[]>();
  invites = new Map<string, InviteRecord>();
  /** messageId -> structured service event */
  service = new Map<string, ServicePayload>();
  /** 1:1 conversations already mirrored into the conversations table */
  private dmKnown = new Set<string>();
  private emitter: GroupEmitter | null = null;
  private createRate = new Map<string, number[]>();
  private msgRate = new Map<string, number[]>();
  ready: Promise<void> = Promise.resolve();
  publicOrigin = process.env.PUBLIC_ORIGIN || "https://openlounge.app";

  constructor(
    private store: StoreLike,
    private repo: GroupsRepo,
  ) {}

  attach(emitter: GroupEmitter) {
    this.emitter = emitter;
  }

  async init() {
    const snap = await this.repo.load();
    for (const c of snap.convs) if (c.type === "group" && !c.deletedAt) this.convs.set(c.id, c);
    // groups deleted earlier: make sure their attachments are gone too (idempotent; server/media waits for its own load)
    for (const c of snap.convs) if (c.type === "group" && c.deletedAt) this.emitter?.mediaConversationDeleted?.(c.id);
    for (const m of snap.members) if (this.convs.has(m.conversationId)) this.indexMember(m);
    for (const p of snap.pins) if (this.convs.has(p.conversationId)) (this.pins.get(p.conversationId) ?? this.pins.set(p.conversationId, []).get(p.conversationId)!).push(p);
    for (const i of snap.invites) if (this.convs.has(i.conversationId)) this.invites.set(i.token, i);
    for (const s of snap.service) this.service.set(s.messageId, s.payload);
    for (const list of this.pins.values()) list.sort((a, b) => a.pinnedAt - b.pinnedAt);
    for (const key of this.store.dms.keys()) if (key.includes("|")) this.dmKnown.add(key);
    log.info("groups loaded", { groups: this.convs.size, members: snap.members.length });
  }

  // ---------- helpers ----------

  private indexMember(m: MemberRecord) {
    let map = this.members.get(m.conversationId);
    if (!map) this.members.set(m.conversationId, (map = new Map()));
    map.set(m.userId, m);
    let set = this.byUser.get(m.userId);
    if (!set) this.byUser.set(m.userId, (set = new Set()));
    set.add(m.conversationId);
  }
  private unindexMember(gid: string, userId: string) {
    this.members.get(gid)?.delete(userId);
    this.byUser.get(userId)?.delete(gid);
    if (this.store.chatPrefs?.get(userId, gid)?.pinnedAt) this.store.chatPrefs.set(userId, gid, { pinnedAt: null }); // a re-join starts unpinned
  }
  /** group service rows ("Maya added Ryan") take no reactions / pins */
  isService(messageId: string) {
    return this.service.has(messageId);
  }
  member(gid: string, userId: string) {
    return this.members.get(gid)?.get(userId) ?? null;
  }
  memberIds(gid: string) {
    return [...(this.members.get(gid)?.keys() ?? [])].filter((id) => this.store.users.has(id));
  }
  canAccess(userId: string, gid: string) {
    return !!this.convs.get(gid) && !!this.member(gid, userId);
  }
  /** everyone who should get events for a conversation: members of a group, the two people of a 1:1 */
  audience(conversationKey: string): string[] {
    if (isGroupId(conversationKey)) return this.memberIds(conversationKey);
    return conversationKey.split("|").filter(Boolean);
  }
  private name(id: string) {
    return this.store.users.get(id)?.name ?? "Deleted account";
  }
  private emitTo(ids: Iterable<string>, ev: string, data: unknown) {
    this.emitter?.toUsers(ids, ev, data);
  }
  private photoUrl(c: ConvRecord) {
    return c.photoVersion ? `/api/groups/${c.id}/photo?v=${c.photoVersion}` : null;
  }
  private slide(map: Map<string, number[]>, key: string, windowMs: number, max: number) {
    const now = Date.now();
    const recent = (map.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      map.set(key, recent);
      return true;
    }
    recent.push(now);
    map.set(key, recent);
    return false;
  }
  private requireAdmin(userId: string, gid: string): { conv: ConvRecord; me: MemberRecord } | Err {
    const conv = this.convs.get(gid);
    const me = this.member(gid, userId);
    if (!conv || !me) return err("Group not found", 404);
    if (!canAdmin(me.role)) return err("Only admins can do that", 403);
    return { conv, me };
  }
  private touch(conv: ConvRecord) {
    conv.updatedAt = Date.now();
    this.repo.upsertConv(conv);
  }

  summary(c: ConvRecord): GroupSummary {
    return { id: c.id, title: c.title, description: c.description, color: c.color, photoUrl: this.photoUrl(c), memberCount: this.memberIds(c.id).length, createdAt: c.createdAt };
  }

  /** the group as a PublicUser-shaped "peer" so DM UI that expects a peer (headers, avatars) renders it */
  asPeer(c: ConvRecord): PublicUser {
    return { id: c.id, name: c.title, username: "", color: c.color, photoUrl: this.photoUrl(c), interests: [], bio: c.description, isBot: false, createdAt: c.createdAt, followers: 0, following: 0 };
  }

  private decorate(m: DirectMessage): ConvMessage {
    const svc = this.service.get(m.id);
    return { ...m, conversationId: m.toId, ...(svc ? { service: svc } : {}), fromPhotoUrl: this.store.publicUser(m.fromId)?.photoUrl ?? null };
  }

  info(userId: string, gid: string): GroupInfo | null {
    const c = this.convs.get(gid);
    const me = this.member(gid, userId);
    if (!c || !me) return null;
    const list = this.store.dms.get(gid) ?? [];
    const byId = new Map(list.map((m) => [m.id, m]));
    const roleRank: Record<GroupRole, number> = { owner: 0, admin: 1, member: 2 };
    const members: GroupMember[] = [];
    for (const [uid, m] of this.members.get(gid) ?? []) {
      const u = this.store.publicUser(uid);
      if (!u || !this.store.users.has(uid)) continue;
      const pres = this.emitter?.presence?.(uid);
      members.push({ id: uid, name: u.name, username: u.username, color: u.color, photoUrl: u.photoUrl, role: m.role, joinedAt: m.joinedAt, ...(pres ?? {}) });
    }
    members.sort((a, b) => roleRank[a.role] - roleRank[b.role] || Number(b.online ?? false) - Number(a.online ?? false) || a.name.localeCompare(b.name));
    const pins: GroupPin[] = (this.pins.get(gid) ?? []).map((p) => {
      const msg = byId.get(p.messageId);
      return { messageId: p.messageId, pinnedBy: p.pinnedBy, pinnedAt: p.pinnedAt, message: msg ? this.decorate(msg) : null };
    });
    return {
      ...this.summary(c),
      myRole: me.role,
      muted: me.muted,
      memberLimit: c.memberLimit,
      members,
      pins,
      ...(canAdmin(me.role) ? { invites: this.inviteList(gid) } : {}),
    };
  }

  private broadcastUpdate(gid: string) {
    const c = this.convs.get(gid);
    if (!c) return;
    // per-member view (myRole, muted, invites differ), but the payload is small and groups are capped at 200
    for (const uid of this.memberIds(gid)) {
      const view = this.info(uid, gid);
      if (view) this.emitTo([uid], "group:update", { group: view });
    }
  }

  // ---------- service messages ----------

  private postService(gid: string, actorId: string, payload: Omit<ServicePayload, "actorId">) {
    const ev: ServicePayload = { actorId, ...payload };
    const msg = this.buildMessage(gid, actorId, serviceText(ev, (id) => this.name(id)));
    this.service.set(msg.id, ev);
    this.repo.addService({ messageId: msg.id, conversationId: gid, payload: ev });
    this.store.pushConversationMessage(gid, msg);
    return msg;
  }

  private buildMessage(gid: string, fromId: string, text: string, clientId?: string): DirectMessage {
    const list = this.store.dms.get(gid) ?? [];
    const from = this.store.users.get(fromId);
    return {
      id: randomUUID(),
      fromId,
      fromName: from?.name ?? "Someone",
      fromColor: from?.color ?? "#64748B",
      toId: gid,
      text,
      createdAt: Math.max(Date.now(), (list[list.length - 1]?.createdAt ?? 0) + 1),
      readAt: null,
      ...(clientId ? { clientId } : {}),
    };
  }

  // ---------- create / edit ----------

  /** Who `actorId` may add: real accounts, not themselves, no block either way ("blocked users can't add you"). */
  private addable(actorId: string, ids: unknown): { ok: string[]; refused: { id: string; error: string }[] } {
    const ok: string[] = [];
    const refused: { id: string; error: string }[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(ids) ? ids : []) {
      if (typeof raw !== "string" || seen.has(raw) || raw === actorId) continue;
      seen.add(raw);
      const u = this.store.users.get(raw);
      if (!u || u.isBot) refused.push({ id: raw, error: "User not found" });
      else if (this.store.isBlocked(raw, actorId)) refused.push({ id: raw, error: `${u.name} can't be added` });
      else if (this.store.isBlocked(actorId, raw)) refused.push({ id: raw, error: `You blocked ${u.name}` });
      else ok.push(raw);
    }
    return { ok, refused };
  }

  create(userId: string, input: { title?: unknown; memberIds?: unknown; description?: unknown; photo?: unknown }) {
    const creator = this.store.users.get(userId);
    if (!creator || creator.isBot) return err("Not signed in", 401);
    const t = cleanText(clamp(input.title, GROUP_TITLE_MAX), GROUP_TITLE_MAX);
    if (t.text === null) return err(t.error);
    if (!t.text) return err("Give the group a name");
    const d = cleanText(input.description ?? "", GROUP_DESCRIPTION_MAX);
    if (d.text === null) return err(d.error);
    const { ok: ids, refused } = this.addable(userId, input.memberIds);
    if (ids.length + 1 > GROUP_MAX_MEMBERS) return err(`Groups can have up to ${GROUP_MAX_MEMBERS} members`);
    if (this.slide(this.createRate, userId, 3600_000, CREATE_MAX_PER_HOUR)) return err("You've created a lot of groups — try again later", 429);
    const now = Date.now();
    const conv: ConvRecord = {
      id: `g_${randomBytes(9).toString("base64url")}`,
      type: "group",
      title: t.text,
      description: d.text,
      color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      photoVersion: null,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
      memberLimit: GROUP_MAX_MEMBERS,
      deletedAt: null,
    };
    this.convs.set(conv.id, conv);
    this.repo.upsertConv(conv);
    const add = (uid: string, role: GroupRole) => {
      const m: MemberRecord = { conversationId: conv.id, userId: uid, role, joinedAt: now, muted: false, lastReadAt: now, addedBy: uid === userId ? null : userId };
      this.indexMember(m);
      this.repo.upsertMember(m);
    };
    add(userId, "owner");
    for (const id of ids) add(id, "member");
    if (input.photo) this.setPhotoInternal(conv, input.photo);
    this.postService(conv.id, userId, { type: "created", value: conv.title });
    if (ids.length) this.postService(conv.id, userId, { type: "added", targetIds: ids });
    // creator has read their own service messages
    this.member(conv.id, userId)!.lastReadAt = (this.store.dms.get(conv.id) ?? []).at(-1)?.createdAt ?? now;
    this.repo.upsertMember(this.member(conv.id, userId)!);
    this.broadcastUpdate(conv.id);
    return { ok: true as const, group: this.info(userId, conv.id)!, refused };
  }

  update(userId: string, gid: string, patch: { title?: unknown; description?: unknown; photo?: unknown }) {
    const a = this.requireAdmin(userId, gid);
    if ("error" in a) return a;
    const { conv } = a;
    let changed = false;
    if (patch.title !== undefined) {
      const t = cleanText(clamp(patch.title, GROUP_TITLE_MAX), GROUP_TITLE_MAX);
      if (t.text === null) return err(t.error);
      if (!t.text) return err("Give the group a name");
      if (t.text !== conv.title) {
        conv.title = t.text;
        changed = true;
        this.postService(gid, userId, { type: "title", value: t.text });
      }
    }
    if (patch.description !== undefined) {
      const d = cleanText(patch.description, GROUP_DESCRIPTION_MAX);
      if (d.text === null) return err(d.error);
      if (d.text !== conv.description) {
        conv.description = d.text;
        changed = true;
        this.postService(gid, userId, { type: "description" });
      }
    }
    if (patch.photo !== undefined) {
      const r = this.setPhotoInternal(conv, patch.photo);
      if (!r.ok) return r;
      changed = true;
      this.postService(gid, userId, { type: "photo", value: patch.photo ? "changed" : "removed" });
    }
    if (changed) {
      this.touch(conv);
      this.broadcastUpdate(gid);
    }
    return { ok: true as const, group: this.info(userId, gid)! };
  }

  private setPhotoInternal(conv: ConvRecord, photo: unknown): { ok: true } | Err {
    if (photo === null || photo === "") {
      conv.photoVersion = null;
      this.repo.putPhoto(conv.id, "", Buffer.alloc(0), 0);
      this.repo.upsertConv(conv);
      return { ok: true };
    }
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(photo));
    if (!m) return err("Use a JPEG, PNG or WebP photo");
    const buf = Buffer.from(m[2], "base64");
    if (!buf.length || buf.length > PHOTO_MAX_BYTES) return err("That photo is too large");
    conv.photoVersion = Date.now();
    this.photoCache.set(conv.id, { mime: `image/${m[1]}`, bytes: buf, version: conv.photoVersion });
    this.repo.putPhoto(conv.id, `image/${m[1]}`, buf, conv.photoVersion);
    this.repo.upsertConv(conv);
    return { ok: true };
  }
  private photoCache = new Map<string, { mime: string; bytes: Buffer; version: number }>();
  async photo(gid: string) {
    const c = this.convs.get(gid);
    if (!c?.photoVersion) return null;
    const hit = this.photoCache.get(gid);
    if (hit && hit.version === c.photoVersion) return hit;
    const p = await this.repo.getPhoto(gid);
    if (p) {
      if (this.photoCache.size > 200) this.photoCache.delete(this.photoCache.keys().next().value as string);
      this.photoCache.set(gid, p);
    }
    return p;
  }

  // ---------- membership ----------

  addMembers(userId: string, gid: string, ids: unknown) {
    const a = this.requireAdmin(userId, gid);
    if ("error" in a) return a;
    const { ok: candidates, refused } = this.addable(userId, ids);
    const fresh = candidates.filter((id) => !this.member(gid, id));
    if (!fresh.length) return refused.length ? err(refused[0].error) : err("They're already in the group");
    if (this.memberIds(gid).length + fresh.length > a.conv.memberLimit) return err(`Groups can have up to ${a.conv.memberLimit} members`);
    const now = Date.now();
    for (const id of fresh) {
      const m: MemberRecord = { conversationId: gid, userId: id, role: "member", joinedAt: now, muted: false, lastReadAt: 0, addedBy: userId };
      this.indexMember(m);
      this.repo.upsertMember(m);
    }
    this.postService(gid, userId, { type: "added", targetIds: fresh });
    this.touch(a.conv);
    this.broadcastUpdate(gid);
    return { ok: true as const, added: fresh, refused, group: this.info(userId, gid)! };
  }

  removeMember(userId: string, gid: string, target: unknown) {
    const a = this.requireAdmin(userId, gid);
    if ("error" in a) return a;
    if (typeof target !== "string" || target === userId) return err("Use Leave group to leave");
    const t = this.member(gid, target);
    if (!t) return err("They're not in the group", 404);
    if (t.role === "owner") return err("The owner can't be removed", 403);
    if (t.role === "admin" && a.me.role !== "owner") return err("Only the owner can remove admins", 403);
    this.dropMember(gid, target);
    this.postService(gid, userId, { type: "removed", targetIds: [target] });
    this.emitTo([target], "group:removed", { id: gid, reason: "removed" });
    this.touch(a.conv);
    this.broadcastUpdate(gid);
    return { ok: true as const, group: this.info(userId, gid)! };
  }

  private dropMember(gid: string, uid: string) {
    this.unindexMember(gid, uid);
    this.repo.deleteMember(gid, uid);
  }

  setRole(userId: string, gid: string, target: unknown, role: unknown) {
    const conv = this.convs.get(gid);
    const me = this.member(gid, userId);
    if (!conv || !me) return err("Group not found", 404);
    if (me.role !== "owner") return err("Only the owner can change admins", 403);
    if (role !== "admin" && role !== "member") return err("Unknown role");
    const t = typeof target === "string" ? this.member(gid, target) : null;
    if (!t || t.userId === userId) return err("Pick a member");
    if (t.role === role) return { ok: true as const, group: this.info(userId, gid)! };
    t.role = role;
    this.repo.upsertMember(t);
    this.postService(gid, userId, { type: "role", targetIds: [t.userId], value: role });
    this.broadcastUpdate(gid);
    return { ok: true as const, group: this.info(userId, gid)! };
  }

  transferOwnership(userId: string, gid: string, target: unknown) {
    const conv = this.convs.get(gid);
    const me = this.member(gid, userId);
    if (!conv || !me) return err("Group not found", 404);
    if (me.role !== "owner") return err("Only the owner can transfer the group", 403);
    const t = typeof target === "string" ? this.member(gid, target) : null;
    if (!t || t.userId === userId) return err("Pick a member");
    this.makeOwner(gid, me, t);
    this.broadcastUpdate(gid);
    return { ok: true as const, group: this.info(userId, gid)! };
  }

  private makeOwner(gid: string, prev: MemberRecord | null, next: MemberRecord) {
    if (prev) {
      prev.role = "admin";
      this.repo.upsertMember(prev);
    }
    next.role = "owner";
    this.repo.upsertMember(next);
    this.postService(gid, prev?.userId ?? next.userId, { type: "owner", targetIds: [next.userId] });
  }

  leave(userId: string, gid: string, opts: { silent?: boolean } = {}) {
    const conv = this.convs.get(gid);
    const me = this.member(gid, userId);
    if (!conv || !me) return err("Group not found", 404);
    this.dropMember(gid, userId);
    const rest = [...(this.members.get(gid)?.values() ?? [])].filter((m) => this.store.users.has(m.userId));
    if (!rest.length) {
      conv.deletedAt = Date.now();
      this.repo.upsertConv(conv);
      this.convs.delete(gid);
      for (const [tok, inv] of this.invites) if (inv.conversationId === gid) this.invites.delete(tok);
      this.emitter?.mediaConversationDeleted?.(gid);
      this.emitTo([userId], "group:removed", { id: gid, reason: "left" });
      return { ok: true as const, deleted: true };
    }
    if (!opts.silent) this.postService(gid, userId, { type: "left" });
    if (me.role === "owner") {
      // Telegram-style succession: the longest-serving admin, else the longest-serving member
      const next = rest.filter((m) => m.role === "admin").sort((a, b) => a.joinedAt - b.joinedAt)[0] ?? rest.sort((a, b) => a.joinedAt - b.joinedAt)[0];
      this.makeOwner(gid, null, next);
    }
    this.emitTo([userId], "group:removed", { id: gid, reason: "left" });
    this.touch(conv);
    this.broadcastUpdate(gid);
    return { ok: true as const, deleted: false };
  }

  setMuted(userId: string, gid: string, muted: unknown) {
    const me = this.member(gid, userId);
    if (!me || !this.convs.has(gid)) return err("Group not found", 404);
    me.muted = !!muted;
    this.repo.upsertMember(me);
    this.emitTo([userId], "group:update", { group: this.info(userId, gid) });
    this.emitTo([userId], "dm:unread", { count: this.store.unreadDmCount(userId) });
    return { ok: true as const, muted: me.muted };
  }

  // ---------- pins + deletes ----------

  pin(userId: string, gid: string, messageId: unknown, on: unknown) {
    const a = this.requireAdmin(userId, gid);
    if ("error" in a) return a;
    const list = this.store.dms.get(gid) ?? [];
    const msg = list.find((m) => m.id === messageId);
    const pins = this.pins.get(gid) ?? [];
    if (on !== false) {
      if (!msg) return err("Message not found", 404);
      if (this.service.has(msg.id)) return err("That message can't be pinned");
      if (!pins.some((p) => p.messageId === msg.id)) {
        if (pins.length >= PIN_MAX) return err(`Up to ${PIN_MAX} pinned messages`);
        const p: PinRecord = { conversationId: gid, messageId: msg.id, pinnedBy: userId, pinnedAt: Date.now() };
        pins.push(p);
        this.pins.set(gid, pins);
        this.repo.setPin(p, true);
        this.postService(gid, userId, { type: "pinned", value: msg.text });
      }
    } else {
      const i = pins.findIndex((p) => p.messageId === messageId);
      if (i >= 0) {
        this.repo.setPin(pins[i], false);
        pins.splice(i, 1);
      }
    }
    const view = this.info(userId, gid)!;
    this.emitTo(this.memberIds(gid), "group:pins", { id: gid, pins: view.pins });
    return { ok: true as const, pins: view.pins };
  }

  /** Delete for everyone: the sender, or an admin for anyone's message. */
  deleteMessage(userId: string, gid: string, messageId: unknown) {
    const conv = this.convs.get(gid);
    const me = this.member(gid, userId);
    if (!conv || !me) return err("Group not found", 404);
    const msg = (this.store.dms.get(gid) ?? []).find((m) => m.id === messageId);
    if (!msg) return err("Message not found", 404);
    if (msg.fromId !== userId && !canAdmin(me.role)) return err("Only admins can delete other people's messages", 403);
    this.store.removeConversationMessage(gid, msg.id);
    this.emitter?.mediaMessageDeleted?.(msg.id);
    const pins = this.pins.get(gid) ?? [];
    const pi = pins.findIndex((p) => p.messageId === msg.id);
    if (pi >= 0) {
      this.repo.setPin(pins[pi], false);
      pins.splice(pi, 1);
      this.emitTo(this.memberIds(gid), "group:pins", { id: gid, pins: this.info(userId, gid)!.pins });
    }
    this.emitTo(this.memberIds(gid), "conv:deleted", { conversationId: gid, messageId: msg.id, by: userId });
    return { ok: true as const };
  }

  // ---------- invite links ----------

  private inviteView(i: InviteRecord): GroupInvite {
    return { token: i.token, url: `${this.publicOrigin}/join/${i.token}`, createdBy: i.createdBy, createdAt: i.createdAt, expiresAt: i.expiresAt, maxUses: i.maxUses, uses: i.uses };
  }
  private inviteLive(i: InviteRecord, now = Date.now()) {
    return !i.revokedAt && (!i.expiresAt || i.expiresAt > now) && (i.maxUses === null || i.uses < i.maxUses);
  }
  inviteList(gid: string) {
    const now = Date.now();
    return [...this.invites.values()].filter((i) => i.conversationId === gid && this.inviteLive(i, now)).sort((a, b) => b.createdAt - a.createdAt).map((i) => this.inviteView(i));
  }

  createInvite(userId: string, gid: string, opts: { expiresInSec?: unknown; maxUses?: unknown }) {
    const a = this.requireAdmin(userId, gid);
    if ("error" in a) return a;
    if (this.inviteList(gid).length >= INVITES_MAX) return err(`Up to ${INVITES_MAX} active links — revoke one first`);
    const ttl = Number(opts.expiresInSec);
    const max = Number(opts.maxUses);
    if (opts.expiresInSec !== undefined && opts.expiresInSec !== null && (!Number.isFinite(ttl) || ttl < 60 || ttl * 1000 > INVITE_MAX_TTL_MS)) return err("Pick an expiry between 1 minute and 1 year");
    if (opts.maxUses !== undefined && opts.maxUses !== null && (!Number.isInteger(max) || max < 1 || max > 100_000)) return err("Member limit must be 1 or more");
    const now = Date.now();
    const inv: InviteRecord = {
      token: randomBytes(12).toString("base64url"),
      conversationId: gid,
      createdBy: userId,
      createdAt: now,
      expiresAt: opts.expiresInSec ? now + ttl * 1000 : null,
      maxUses: opts.maxUses ? max : null,
      uses: 0,
      revokedAt: null,
    };
    this.invites.set(inv.token, inv);
    this.repo.upsertInvite(inv);
    this.broadcastAdmins(gid);
    return { ok: true as const, invite: this.inviteView(inv) };
  }

  revokeInvite(userId: string, gid: string, token: unknown) {
    const a = this.requireAdmin(userId, gid);
    if ("error" in a) return a;
    const inv = typeof token === "string" ? this.invites.get(token) : undefined;
    if (!inv || inv.conversationId !== gid) return err("Link not found", 404);
    inv.revokedAt = Date.now();
    this.repo.upsertInvite(inv);
    this.invites.delete(inv.token);
    this.broadcastAdmins(gid);
    return { ok: true as const, invites: this.inviteList(gid) };
  }

  private broadcastAdmins(gid: string) {
    for (const uid of this.memberIds(gid)) if (canAdmin(this.member(gid, uid)?.role)) this.emitTo([uid], "group:update", { group: this.info(uid, gid) });
  }

  private resolveInvite(token: unknown): { inv: InviteRecord; conv: ConvRecord } | Err {
    const inv = typeof token === "string" ? this.invites.get(token) : undefined;
    const conv = inv ? this.convs.get(inv.conversationId) : undefined;
    if (!inv || !conv) return err("This invite link is invalid or was revoked", 404);
    if (inv.revokedAt) return err("This invite link was revoked", 410);
    if (inv.expiresAt && inv.expiresAt <= Date.now()) return err("This invite link has expired", 410);
    if (inv.maxUses !== null && inv.uses >= inv.maxUses) return err("This invite link has reached its member limit", 410);
    return { inv, conv };
  }

  previewInvite(token: unknown, viewerId: string | null): { ok: true; preview: InvitePreview } | Err {
    const r = this.resolveInvite(token);
    if ("error" in r) return r;
    const ids = this.memberIds(r.conv.id);
    const sample = ids.slice(0, 6).map((id) => {
      const u = this.store.publicUser(id)!;
      return { id, name: u.name, color: u.color, photoUrl: u.photoUrl };
    });
    return {
      ok: true,
      preview: { token: r.inv.token, group: this.summary(r.conv), sample, alreadyMember: !!viewerId && !!this.member(r.conv.id, viewerId), full: ids.length >= r.conv.memberLimit },
    };
  }

  joinByInvite(userId: string, token: unknown) {
    const u = this.store.users.get(userId);
    if (!u || u.isBot) return err("Not signed in", 401);
    const known = typeof token === "string" ? this.invites.get(token) : undefined;
    if (known && this.convs.has(known.conversationId) && this.member(known.conversationId, userId)) return { ok: true as const, groupId: known.conversationId, already: true };
    const r = this.resolveInvite(token);
    if ("error" in r) return r;
    const { inv, conv } = r;
    if (this.memberIds(conv.id).length >= conv.memberLimit) return err("This group is full", 409);
    if (inv.createdBy && this.store.isBlockedEither(inv.createdBy, userId)) return err("You can't join this group", 403);
    inv.uses += 1;
    this.repo.upsertInvite(inv);
    const m: MemberRecord = { conversationId: conv.id, userId, role: "member", joinedAt: Date.now(), muted: false, lastReadAt: 0, addedBy: inv.createdBy };
    this.indexMember(m);
    this.repo.upsertMember(m);
    this.postService(conv.id, userId, { type: "joined" });
    this.touch(conv);
    this.broadcastUpdate(conv.id);
    return { ok: true as const, groupId: conv.id, already: false };
  }

  // ---------- messaging (called through the generic DM endpoints with peerId = group id) ----------

  send(fromId: string, gid: string, rawText: unknown, clientId?: unknown, replyToId?: unknown): { ok: true; message: DirectMessage } | { ok: false; error: string } {
    const conv = this.convs.get(gid);
    if (!conv || !this.member(gid, fromId)) return { ok: false, error: "You're not a member of this group" };
    const c = cleanText(rawText, CHAT_MAX_LENGTH);
    if (c.text === null) return { ok: false, error: c.error };
    if (!c.text) return { ok: false, error: "Message is empty" };
    const cid = typeof clientId === "string" && /^[\w-]{1,64}$/.test(clientId) ? clientId : undefined;
    const list = this.store.dms.get(gid) ?? [];
    if (cid) for (let i = list.length - 1; i >= Math.max(0, list.length - 50); i--) if (list[i].clientId === cid && list[i].fromId === fromId) return { ok: true, message: this.decorate(list[i]) };
    if (this.slide(this.msgRate, fromId, 10_000, MSG_MAX_PER_10S)) return { ok: false, error: "Slow down a little 🙂" };
    const target = typeof replyToId === "string" ? list.find((m) => m.id === replyToId) : undefined;
    if (replyToId !== undefined && !target) return { ok: false, error: "Original message is no longer available" };
    const msg = { ...this.buildMessage(gid, fromId, c.text, cid), ...(target ? { replyTo: replyReference(target) } : {}) };
    this.store.pushConversationMessage(gid, msg);
    const me = this.member(gid, fromId)!;
    me.lastReadAt = msg.createdAt;
    this.repo.upsertMember(me);
    return { ok: true, message: this.decorate(msg) };
  }

  /** A photo / video / file / voice note / album into a group (server/media builds the attachments; same fan-out). */
  sendMedia(fromId: string, gid: string, text: string, clientId: unknown, media: NonNullable<DirectMessage["media"]>, attachments?: DirectMessage["attachments"], replyToId?: unknown): { ok: true; message: DirectMessage; duplicate: boolean } | { ok: false; error: string } {
    const conv = this.convs.get(gid);
    const me = this.member(gid, fromId);
    if (!conv || !me) return { ok: false, error: "You're not a member of this group" };
    const cid = typeof clientId === "string" && /^[\w-]{1,64}$/.test(clientId) ? clientId : undefined;
    const list = this.store.dms.get(gid) ?? [];
    if (cid) for (let i = list.length - 1; i >= Math.max(0, list.length - 50); i--) if (list[i].clientId === cid && list[i].fromId === fromId) return { ok: true, message: this.decorate(list[i]), duplicate: true };
    // no per-message limit (albums are one message; uploads are rate limited in server/media)
    const target = typeof replyToId === "string" ? list.find((m) => m.id === replyToId) : undefined;
    if (replyToId !== undefined && !target) return { ok: false, error: "Original message is no longer available" };
    const msg: DirectMessage = { ...this.buildMessage(gid, fromId, text.slice(0, CHAT_MAX_LENGTH), cid), media, ...(attachments?.length ? { attachments } : {}), ...(target ? { replyTo: replyReference(target) } : {}) };
    this.store.pushConversationMessage(gid, msg);
    me.lastReadAt = msg.createdAt;
    this.repo.upsertMember(me);
    return { ok: true, message: this.decorate(msg), duplicate: false };
  }

  /** store.events.dmMessage for a group message → every member's devices + pushes (mentions, mute aware). */
  fanout(msg: DirectMessage) {
    const gid = msg.toId;
    const conv = this.convs.get(gid);
    if (!conv) return;
    const ids = this.memberIds(gid);
    const out = { ...this.decorate(msg), conversationTitle: conv.title };
    const svc = this.service.get(msg.id);
    const handles = svc ? [] : mentionHandles(msg.text);
    for (const uid of ids) {
      if (uid === msg.fromId) {
        this.emitTo([uid], "dm:message", out);
        continue;
      }
      const mem = this.member(gid, uid)!;
      const u = this.store.users.get(uid);
      const mentioned = !!u && handles.includes(u.username.toLowerCase());
      const blocked = this.store.isBlocked(uid, msg.fromId);
      // per-member flags for the in-app banner (old clients ignore unknown fields): muted groups stay quiet unless @mentioned
      const notify = !blocked && (svc ? (svc.targetIds ?? []).includes(uid) : !mem.muted || mentioned);
      this.emitTo([uid], "dm:message", { ...out, notify, ...(mentioned ? { mentioned: true } : {}) });
      this.emitTo([uid], "dm:unread", { count: this.store.unreadDmCount(uid) });
      if (!notify) continue; // service pushes only for "you were added" etc.; muted → mentions only; never from blocked senders
      if (this.emitter?.isForeground(uid)) continue;
      const body = svc ? msg.text : `${mentioned ? "@ " : ""}${msg.fromName.split(" ")[0]}: ${msg.text}`;
      this.emitter?.push(uid, {
        title: conv.title,
        body: body.length > 140 ? body.slice(0, 139) + "…" : body,
        tag: `dm:${gid}`,
        url: `/messages/${gid}`,
        data: { peerId: gid, groupId: gid, ...(mentioned ? { mention: "1" } : {}) },
      });
    }
  }

  history(userId: string, gid: string, before?: number, limit = 60) {
    if (!this.canAccess(userId, gid)) return null;
    const list = this.store.dms.get(gid) ?? [];
    const older = before ? list.filter((m) => m.createdAt < before) : list;
    return { messages: older.slice(-limit).map((m) => this.decorate(m)), hasMore: older.length > limit };
  }

  since(userId: string, after: number): ConvMessage[] {
    const out: ConvMessage[] = [];
    for (const gid of this.byUser.get(userId) ?? []) {
      const list = this.store.dms.get(gid) ?? [];
      for (let i = list.length - 1; i >= 0 && list[i].createdAt >= after; i--) out.push(this.decorate(list[i]));
    }
    return out;
  }

  /**
   * Member saw the group up to `upToMessageId` (default: everything). Moves their cursor; the first time someone
   * other than the sender sees a message it gets readAt (Telegram ✓✓ = "read by someone"), and each sender gets a
   * dm:read-receipt with readerId = the group id — the DM thread UI applies it unchanged.
   */
  markRead(userId: string, gid: string, upToMessageId?: unknown): { changed: boolean; receipt: DmReadReceipt | null } {
    const me = this.member(gid, userId);
    if (!me || !this.convs.has(gid)) return { changed: false, receipt: null };
    const list = this.store.dms.get(gid) ?? [];
    let target = list.length - 1;
    if (typeof upToMessageId === "string" && upToMessageId) {
      target = list.findIndex((m) => m.id === upToMessageId);
      if (target < 0) return { changed: false, receipt: null };
    }
    const now = Date.now();
    const bySender = new Map<string, string>();
    for (let i = 0; i <= target; i++) {
      const m = list[i];
      if (m.fromId === userId || m.readAt || this.service.has(m.id)) continue;
      m.readAt = now;
      bySender.set(m.fromId, m.id);
    }
    const cursor = target >= 0 ? list[target].createdAt : now;
    const changed = me.lastReadAt < cursor;
    if (changed) {
      me.lastReadAt = cursor;
      this.repo.upsertMember(me);
      this.emitter?.clearPush?.(userId, gid);
      // the reader's other devices / inbox clear this group's badge (new event: old clients ignore it)
      this.emitTo([userId], "conv:read", { conversationId: gid, upTo: cursor });
    }
    if (bySender.size) this.store.saveSoon(); // persist the readAt stamps with the next snapshot
    for (const [senderId, mid] of bySender) this.emitTo([senderId], "dm:read-receipt", { peerId: senderId, readerId: gid, upToMessageId: mid, readAt: now } satisfies DmReadReceipt);
    return { changed, receipt: null };
  }

  unread(userId: string, gid: string) {
    const me = this.member(gid, userId);
    if (!me) return 0;
    const list = this.store.dms.get(gid) ?? [];
    let n = 0;
    for (let i = list.length - 1; i >= 0 && list[i].createdAt > me.lastReadAt; i--) if (list[i].fromId !== userId) n++;
    return n;
  }
  /** groups only, muted ones excluded (Telegram default); store.unreadDmCount adds this to the DM total */
  unreadTotal(userId: string) {
    let n = 0;
    for (const gid of this.byUser.get(userId) ?? []) if (this.convs.has(gid) && !this.member(gid, userId)?.muted) n += this.unread(userId, gid);
    return n;
  }

  private mentionedSince(userId: string, gid: string) {
    const me = this.member(gid, userId);
    const u = this.store.users.get(userId);
    if (!me || !u) return false;
    const list = this.store.dms.get(gid) ?? [];
    const h = u.username.toLowerCase();
    for (let i = list.length - 1; i >= 0 && list[i].createdAt > me.lastReadAt; i--) if (list[i].fromId !== userId && !this.service.has(list[i].id) && mentionHandles(list[i].text).includes(h)) return true;
    return false;
  }

  inbox(userId: string): InboxItem[] {
    const out: InboxItem[] = [];
    for (const gid of this.byUser.get(userId) ?? []) {
      const conv = this.convs.get(gid);
      const me = this.member(gid, userId);
      if (!conv || !me) continue;
      const list = this.store.dms.get(gid) ?? [];
      const last = list[list.length - 1];
      out.push({
        type: "group",
        id: gid,
        group: this.summary(conv),
        lastMessage: last ? this.decorate(last) : null,
        unread: this.unread(userId, gid),
        muted: me.muted,
        mentioned: this.mentionedSince(userId, gid),
        updatedAt: Math.max(last?.createdAt ?? 0, me.joinedAt),
        pinnedAt: this.store.chatPrefs?.get(userId, gid)?.pinnedAt ?? undefined,
      });
    }
    return out;
  }

  /** Mirror a 1:1 conversation into conversations/conversation_members the first time it gets a message. */
  noteDm(msg: DirectMessage) {
    const key = msg.fromId < msg.toId ? `${msg.fromId}|${msg.toId}` : `${msg.toId}|${msg.fromId}`;
    if (this.dmKnown.has(key)) return;
    this.dmKnown.add(key);
    const now = msg.createdAt;
    this.repo.upsertConv({ id: key, type: "dm", title: "", description: "", color: "#10B981", photoVersion: null, createdBy: msg.fromId, createdAt: now, updatedAt: now, memberLimit: 2, deletedAt: null });
    for (const uid of [msg.fromId, msg.toId])
      if (this.store.users.has(uid) && !this.store.users.get(uid)!.isBot)
        this.repo.upsertMember({ conversationId: key, userId: uid, role: "member", joinedAt: now, muted: false, lastReadAt: 0, addedBy: null });
  }

  /** Account deleted: leave every group quietly (ownership passes on as usual). */
  accountDeleted(userId: string) {
    for (const gid of [...(this.byUser.get(userId) ?? [])]) this.leave(userId, gid, { silent: true });
    this.byUser.delete(userId);
  }

  reportSnapshot(reporterId: string, gid: string): { ok: true; ownerId: string | null; snapshot: string } | Err {
    const conv = this.convs.get(gid);
    if (!conv) return err("Group not found", 404);
    if (!this.member(gid, reporterId) && ![...this.invites.values()].some((i) => i.conversationId === gid)) return err("Group not found", 404);
    const owner = [...(this.members.get(gid)?.values() ?? [])].find((m) => m.role === "owner")?.userId ?? null;
    const recent = (this.store.dms.get(gid) ?? []).slice(-5).map((m) => `${m.fromName}: ${m.text}`).join("\n");
    return { ok: true, ownerId: owner, snapshot: `Group “${conv.title}” (${this.memberIds(gid).length} members)${conv.description ? ` — ${conv.description}` : ""}\n${recent}` };
  }
}
