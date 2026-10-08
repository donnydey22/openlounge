// Server-side records for the generic conversation layer (see /workspace/groups/MODEL.md).
export type GroupRole = "owner" | "admin" | "member";

export interface ConvRecord {
  id: string;
  type: "dm" | "group";
  title: string;
  description: string;
  color: string;
  photoVersion: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  memberLimit: number;
  deletedAt: number | null;
}

export interface MemberRecord {
  conversationId: string;
  userId: string;
  role: GroupRole;
  joinedAt: number;
  muted: boolean;
  lastReadAt: number;
  addedBy: string | null;
}

export interface PinRecord {
  conversationId: string;
  messageId: string;
  pinnedBy: string | null;
  pinnedAt: number;
}

export interface InviteRecord {
  token: string;
  conversationId: string;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  uses: number;
  revokedAt: number | null;
}

export interface ServiceRecord {
  messageId: string;
  conversationId: string;
  payload: ServicePayload;
}

export type ServiceType = "created" | "added" | "removed" | "left" | "joined" | "title" | "photo" | "description" | "pinned" | "role" | "owner";
export interface ServicePayload {
  type: ServiceType;
  actorId: string;
  targetIds?: string[];
  value?: string;
}

export interface GroupsSnapshot {
  convs: ConvRecord[];
  members: MemberRecord[];
  pins: PinRecord[];
  invites: InviteRecord[];
  service: ServiceRecord[];
}
