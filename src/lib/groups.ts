// Shared (client + server) types for group conversations. See /workspace/groups/MODEL.md.
import type { DirectMessage, PublicUser } from "./types";

export const GROUP_MAX_MEMBERS = 200;
export const GROUP_TITLE_MAX = 64;
export const GROUP_DESCRIPTION_MAX = 255;
export const isGroupId = (id: unknown): id is string => typeof id === "string" && id.startsWith("g_");

export type GroupRole = "owner" | "admin" | "member";

export type ServiceType = "created" | "added" | "removed" | "left" | "joined" | "title" | "photo" | "description" | "pinned" | "role" | "owner";
export interface ServiceEvent {
  type: ServiceType;
  actorId: string;
  targetIds?: string[];
  value?: string;
}

/** A message in any conversation: the DM payload shape plus the conversation it belongs to. */
export type ConvMessage = DirectMessage & {
  /** "<a>|<b>" for 1:1, "g_…" for groups (to_id is the group id) */
  conversationId?: string;
  /** set on group service messages ("Maya added Ryan") — `text` holds the readable fallback */
  service?: ServiceEvent;
};

export interface GroupMember {
  id: string;
  name: string;
  username: string;
  color: string;
  photoUrl: string | null;
  role: GroupRole;
  joinedAt: number;
  online?: boolean;
  presence?: "online" | "away" | "offline";
  lastSeenAt?: number | null;
}

export interface GroupPin {
  messageId: string;
  pinnedBy: string | null;
  pinnedAt: number;
  /** the pinned message (null if it has since been deleted / trimmed) */
  message: ConvMessage | null;
}

export interface GroupInvite {
  token: string;
  url: string;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  uses: number;
}

/** Inbox / header level info. */
export interface GroupSummary {
  id: string;
  title: string;
  description: string;
  color: string;
  photoUrl: string | null;
  memberCount: number;
  createdAt: number;
}

/** Full group view for a member (group:get, dm:history on a group id). */
export interface GroupInfo extends GroupSummary {
  myRole: GroupRole;
  muted: boolean;
  memberLimit: number;
  members: GroupMember[];
  pins: GroupPin[];
  /** admins/owner only */
  invites?: GroupInvite[];
}

/** One inbox row (conv:list). */
export type InboxItem =
  | { type: "dm"; id: string; peer: PublicUser; lastMessage: ConvMessage; unread: number }
  | { type: "group"; id: string; group: GroupSummary; lastMessage: ConvMessage | null; unread: number; muted: boolean; mentioned: boolean; updatedAt: number };

/** Invite link preview (no membership needed). */
export interface InvitePreview {
  token: string;
  group: GroupSummary;
  /** a few member faces for the sheet */
  sample: { id: string; name: string; color: string; photoUrl: string | null }[];
  alreadyMember: boolean;
  full: boolean;
}

export const canAdmin = (role: GroupRole | null | undefined) => role === "owner" || role === "admin";

/** Readable fallback text for a service event (also stored as the message text). */
export function serviceText(ev: ServiceEvent, nameOf: (id: string) => string, meId?: string): string {
  const who = (id: string) => (id === meId ? "You" : nameOf(id));
  const list = (ids: string[] = []) => {
    const names = ids.map((id) => (id === meId ? "you" : nameOf(id)));
    return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  };
  const a = who(ev.actorId);
  switch (ev.type) {
    case "created":
      return `${a} created the group “${ev.value ?? ""}”`;
    case "added":
      return `${a} added ${list(ev.targetIds)}`;
    case "removed":
      return `${a} removed ${list(ev.targetIds)}`;
    case "left":
      return `${a} left the group`;
    case "joined":
      return `${a} joined the group via invite link`;
    case "title":
      return `${a} changed the group name to “${ev.value ?? ""}”`;
    case "photo":
      return ev.value === "removed" ? `${a} removed the group photo` : `${a} changed the group photo`;
    case "description":
      return `${a} changed the group description`;
    case "pinned":
      return `${a} pinned “${(ev.value ?? "").slice(0, 60)}”`;
    case "role":
      return ev.value === "admin" ? `${a} made ${list(ev.targetIds)} an admin` : `${a} dismissed ${list(ev.targetIds)} as admin`;
    case "owner":
      return `${list(ev.targetIds).replace(/^you$/, "You")} is now the group owner`;
  }
}

/** @handles mentioned in a text (lower-cased, without @). */
export function mentionHandles(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(^|[^\w@])@([A-Za-z0-9_]{3,20})(?![A-Za-z0-9_])/g)) out.add(m[2].toLowerCase());
  return [...out];
}
