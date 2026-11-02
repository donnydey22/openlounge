// Inbound WebSocket event schemas. Every frame's `data` is validated before its handler runs.
// Deliberately small (no dependency): field → type spec. Extra fields are allowed (forward compatible with other
// branches adding optional fields); declared fields must match. Events without a schema still pass (counted in
// metrics as ws_unschematized) so a new handler can't be silently broken — add its schema here.

type Spec = "string" | "string?" | "id" | "id?" | "bool" | "bool?" | "number?" | "nullable-id" | "string-array?" | "photo?" | "nullable-photo";
export type Schema = Record<string, Spec>;

const ID = /^[\w:.@-]{1,128}$/;
const MAX_STR = 4_000;
const MAX_PHOTO = 1_900_000; // data URL; frame cap is 2 MB

export const WS_SCHEMAS: Record<string, Schema> = {
  "auth:requestCode": { phone: "string" },
  "auth:verifyCode": { phone: "string", code: "string", device: "string?" },
  "auth:verifyFirebase": { idToken: "string", device: "string?" },
  "auth:config": {},
  "account:linkPhone": { phone: "string", code: "string" },
  "account:linkPhoneFirebase": { idToken: "string" },
  "room:ping": { roomId: "id", userId: "id" },
  "auth:checkUsername": { username: "string" },
  "auth:register": { ticket: "string", firstName: "string?", lastName: "string?", username: "string?", bio: "string?", color: "string?", interests: "string-array?", photo: "photo?", device: "string?" },
  "session:resume": { token: "string" },
  "session:logout": { all: "bool?" },
  ping: {},
  "presence:visible": { visible: "bool?", hallway: "bool?" },
  "onboarding:suggestions": {},
  "rooms:list": {},
  "room:create": { title: "string?", topic: "string?", description: "string?" },
  "room:join": { roomId: "id" },
  "room:leave": { roomId: "id" },
  "room:end": { roomId: "id" },
  "hand:set": { roomId: "id", raised: "bool" },
  "self:mute": { roomId: "id", muted: "bool" },
  "stage:toAudience": { roomId: "id", userId: "id" },
  "host:invite": { roomId: "id", userId: "id" },
  "host:mute": { roomId: "id", userId: "id" },
  "podium:set": { roomId: "id", userId: "nullable-id" },
  "reaction:send": { roomId: "id", emoji: "string" },
  "chat:send": { roomId: "id", text: "string" },
  "chat:delete": { roomId: "id", messageId: "id" },
  "chat:edit": { roomId: "id", messageId: "id", text: "string" },
  "dm:list": {},
  // groups + unified inbox (server/groups). memberIds / userIds arrays are validated in the service (up to 200).
  "conv:list": {},
  "group:create": { title: "string", description: "string?", photo: "photo?" },
  "group:get": { id: "id" },
  "group:update": { id: "id", title: "string?", description: "string?", photo: "photo?" },
  "group:addMembers": { id: "id" },
  "group:removeMember": { id: "id", userId: "id" },
  "group:setRole": { id: "id", userId: "id", role: "string" },
  "group:transfer": { id: "id", userId: "id" },
  "group:leave": { id: "id" },
  "group:mute": { id: "id", muted: "bool" },
  "group:pin": { id: "id", messageId: "id", pinned: "bool?" },
  "group:deleteMessage": { id: "id", messageId: "id" },
  "group:inviteCreate": { id: "id", expiresInSec: "number?", maxUses: "number?" },
  "group:inviteRevoke": { id: "id", token: "id" },
  "group:invitePreview": { token: "id" },
  "group:join": { token: "id" },
  "group:report": { id: "id", reason: "string", note: "string?" },
  "dm:history": { peerId: "id", before: "number?" },
  "dm:send": { to: "id", text: "string", clientId: "id?" },
  "dm:since": { after: "number?" },
  "dm:read": { peerId: "id", upToMessageId: "id?" },
  "dm:chat": { peerId: "id", action: "string" },
  "dm:typing": { to: "id" },
  "dm:typing_stop": { to: "id" },
  "room:inviteDm": { roomId: "id", to: "string-array?" },
  "dropin:start": { peerId: "id" },
  "room:cards": { roomIds: "string-array?" },
  "room:current": {},
  "call:start": { peerId: "id", video: "bool?", platform: "string?" },
  "call:ack": { callId: "id" },
  "call:accept": { callId: "id" },
  "call:decline": { callId: "id", message: "string?" },
  "call:hangup": { callId: "id" },
  "call:video": { callId: "id", on: "bool" },
  "call:get": { callId: "id" },
  "call:current": {},
  "call:history": { before: "number?" },
  "call:metric": { callId: "id", acceptToAudioMs: "number?" },
  "call:mediaFallback": { callId: "id" },
  "call:diag": { callId: "id", ev: "string" },
  "call:telemetry": { callId: "id", seq: "number?", t: "number?", platform: "string?", net: "string?" },
  "ms:gateway:telemetry": { callId: "id" },
  "call:mediaRestore": { callId: "id" },
  // Server-brokered Mediasoup signaling. Extra structured fields (DTLS/RTP parameters) are validated by the SFU
  // adapter rather than serialized into this intentionally tiny generic schema layer.
  "ms:gateway:hello": { secret: "string" },
  "ms:gateway:response": { id: "id" },
  "ms:gateway:notice": { connectionId: "id", event: "string" },
  "ms:join": { callId: "id" },
  "ms:leave": { callId: "id" },
  "ms:transport:create": { callId: "id", direction: "string" },
  "ms:transport:connect": { callId: "id", direction: "string", transportId: "id" },
  "ms:transport:restartIce": { callId: "id", direction: "string", transportId: "id" },
  "ms:produce": { callId: "id", transportId: "id", kind: "string" },
  "ms:consume": { callId: "id", transportId: "id" },
  "ms:consumer:resume": { callId: "id", consumerId: "id" },
  "dm:reaction_add": { peerId: "id", messageId: "id", emoji: "string" },
  "dm:reaction_remove": { peerId: "id", messageId: "id", emoji: "string" },
  "dm:delete": { peerId: "id", messageIds: "string-array?", forEveryone: "bool?" },
  "dm:edit": { chatId: "id", messageId: "id", text: "string" },
  "dm:emoji_interaction": { to: "id", messageId: "id", emoji: "string" },
  "user:get": { userId: "id" },
  "users:list": {},
  "user:follow": { userId: "id", follow: "bool" },
  "user:update": { name: "string?", bio: "string?", color: "string?", username: "string?", interests: "string-array?" },
  "user:photo": { photo: "nullable-photo" },
};

/** Events whose frames may be large (photo uploads). Everything else is capped at WS_SMALL_FRAME_BYTES. */
export const LARGE_EVENTS = new Set(["user:photo", "auth:register", "group:create", "group:update"]);

function check(spec: Spec, v: unknown): boolean {
  const optional = spec.endsWith("?");
  if (v === undefined) return optional;
  if (v === null && optional) return true; // clients send null for "not set"
  switch (spec) {
    case "string":
    case "string?":
      return typeof v === "string" && v.length <= MAX_STR;
    case "id":
    case "id?":
      return typeof v === "string" && ID.test(v);
    case "nullable-id":
      return v === null || (typeof v === "string" && ID.test(v));
    case "bool":
    case "bool?":
      return typeof v === "boolean";
    case "number?":
      return typeof v === "number" && Number.isFinite(v);
    case "string-array?":
      return Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === "string" && x.length <= 100);
    case "photo?":
      return v === null || (typeof v === "string" && v.length <= MAX_PHOTO);
    case "nullable-photo":
      return v === null || (typeof v === "string" && v.length <= MAX_PHOTO);
  }
}

/** Returns null when valid, else a short reason (field name). */
export function validateEvent(ev: string, data: unknown): string | null | "unschematized" {
  const schema = WS_SCHEMAS[ev];
  if (!schema) return "unschematized";
  if (data === undefined || data === null) data = {};
  if (typeof data !== "object" || Array.isArray(data)) return "data must be an object";
  const d = data as Record<string, unknown>;
  for (const [k, spec] of Object.entries(schema)) if (!check(spec, d[k])) return `invalid field "${k}"`;
  return null;
}
