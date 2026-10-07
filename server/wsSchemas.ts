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
  "presence:visible": { visible: "bool?" },
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
  "dm:list": {},
  "dm:history": { peerId: "id", before: "number?" },
  "dm:send": { to: "id", text: "string", clientId: "id?" },
  "dm:since": { after: "number?" },
  "dm:read": { peerId: "id", upToMessageId: "id?" },
  "dm:typing": { to: "id" },
  "user:get": { userId: "id" },
  "users:list": {},
  "user:follow": { userId: "id", follow: "bool" },
  "user:update": { name: "string?", bio: "string?", color: "string?", username: "string?", interests: "string-array?" },
  "user:photo": { photo: "nullable-photo" },
};

/** Events whose frames may be large (photo uploads). Everything else is capped at WS_SMALL_FRAME_BYTES. */
export const LARGE_EVENTS = new Set(["user:photo", "auth:register"]);

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
