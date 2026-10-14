export const NATIVE_NOTIFICATION_EVENT = "openlounge:native-notification";

export interface NativePushNotice {
  type: string;
  title: string;
  body: string;
  tag: string;
  url: string;
  channel: "messages" | "rooms" | "social";
  clear: boolean;
  badge: number | null;
  /** Server send time used to ignore a delayed replacement for the same collapse tag. */
  sentAt?: number;
  peerId?: string;
  groupId?: string;
  roomId?: string;
}

const TYPE_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function bounded(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function relativePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && value.length <= 300;
}

function optionalId(value: unknown): string | undefined {
  return typeof value === "string" && ID_RE.test(value) ? value : undefined;
}

function badge(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(9999, Math.floor(value)));
  if (typeof value === "string" && /^\d{1,5}$/.test(value)) return Math.min(9999, Number(value));
  return null;
}

function sentAt(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{10,14}$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Native FCM data is untrusted at the WebView boundary. Keep only bounded, app-relative fields before
 * letting a foreground wrapper turn it into the same banner path used by WebSocket activity frames.
 */
export function parseNativePushNotice(value: unknown): NativePushNotice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const clear = raw.clear === true || raw.clear === "1";
  const type = bounded(raw.type, 64);
  const title = bounded(raw.title, 140);
  const body = bounded(raw.body, 500);
  const tag = bounded(raw.tag, 160);
  const url = bounded(raw.url, 300);
  if (!TYPE_RE.test(type) || !tag || (url && !relativePath(url))) return null;
  // A clear event only reconciles a native notification/badge. Display events need an actual title and route.
  if (!clear && (!title || !relativePath(url))) return null;
  const channel = raw.channel === "messages" || raw.channel === "rooms" ? raw.channel : "social";
  const stampedAt = sentAt(raw.sentAt);
  return {
    type,
    title,
    body,
    tag,
    url,
    channel,
    clear,
    badge: badge(raw.badge),
    ...(stampedAt === undefined ? {} : { sentAt: stampedAt }),
    peerId: optionalId(raw.peerId),
    groupId: optionalId(raw.groupId),
    roomId: optionalId(raw.roomId),
  };
}
