// FCM HTTP v1 sender (firebase-admin). Android gets data-only high-priority messages so the wrapper's
// FirebaseMessagingService always builds the notification (channel, tag/collapse, deep link). iOS gets an APNs
// alert with apns-collapse-id; web gets a webpush notification.
import { firebaseApp } from "../firebase";
import type { DeviceToken } from "./repo";
import type { Message } from "firebase-admin/messaging";

export interface PushMessage {
  title: string;
  body: string;
  /** "messages" | "rooms" | "social" → Android channel */
  channel: "messages" | "rooms" | "social";
  /** notifications with the same tag replace each other on the device (per DM thread, "followers", room id) */
  tag: string;
  /** relative deep link, e.g. /messages/u_123 or /room/ab12cd34 */
  url: string;
  type: string;
  data?: Record<string, string>;
  /** data-only "clear this tag" message (DM read on another device) */
  clear?: boolean;
  /** total unread for the recipient (also sent as data.badge) → iOS aps.badge, Android launcher badge */
  badge?: number;
}

export interface SendResult {
  sent: number;
  invalidTokens: string[];
}

export interface PushSender {
  readonly name: string;
  send(tokens: DeviceToken[], msg: PushMessage): Promise<SendResult>;
}

// Only a token FCM says is gone is pruned. invalid-argument / mismatched-credential describe the MESSAGE or our project,
// not the device: deleting on them silently removed good tokens whenever a payload was malformed.
const INVALID = new Set(["messaging/registration-token-not-registered"]);

export class FcmSender implements PushSender {
  readonly name = "fcm";
  async send(tokens: DeviceToken[], msg: PushMessage): Promise<SendResult> {
    if (!tokens.length) return { sent: 0, invalidTokens: [] };
    const app = await firebaseApp();
    if (!app) return { sent: 0, invalidTokens: [] };
    const { getMessaging } = await import("firebase-admin/messaging");
    const data: Record<string, string> = {
      type: msg.type,
      title: msg.title,
      body: msg.body,
      channel: msg.channel,
      tag: msg.tag,
      url: msg.url,
      ...(msg.clear ? { clear: "1" } : {}),
      ...(msg.data ?? {}),
    };
    const res = await getMessaging(app).sendEach(
      tokens.map((t): Message => {
        if (t.platform === "android") return { token: t.token, data, android: { priority: "high" as const, collapseKey: msg.tag.slice(0, 64), ttl: 6 * 3600_000 } };
        if (t.platform === "ios")
          return {
            token: t.token,
            data,
            apns: msg.clear
              ? // iOS ignores/throttles aps.badge on background (content-available) pushes and drops them entirely for a
                // force-quit app, so a read on web/Android never cleared the iPhone icon. A badge-only ALERT push (no
                // alert/sound → nothing is displayed) is applied by iOS itself, even when the app is killed.
                msg.badge !== undefined
                ? { headers: { "apns-push-type": "alert", "apns-priority": "5" }, payload: { aps: { badge: msg.badge } } }
                : { headers: { "apns-push-type": "background", "apns-priority": "5" }, payload: { aps: { contentAvailable: true } } }
              : {
                  headers: { "apns-collapse-id": msg.tag.slice(0, 64), "apns-priority": "10" },
                  payload: { aps: { alert: { title: msg.title, body: msg.body }, sound: "default", threadId: msg.tag, mutableContent: true, ...(msg.badge !== undefined ? { badge: msg.badge } : {}) } },
                },
          };
        return {
          token: t.token,
          data,
          ...(msg.clear ? {} : { webpush: { notification: { title: msg.title, body: msg.body, tag: msg.tag, icon: "/icons/icon-192.png" }, fcmOptions: { link: msg.url } } }),
        };
      }),
    );
    const invalidTokens: string[] = [];
    res.responses.forEach((r, i) => {
      if (!r.success && r.error && INVALID.has(r.error.code)) invalidTokens.push(tokens[i].token);
      else if (!r.success) console.warn("[push] send failed:", r.error?.code);
    });
    return { sent: res.successCount, invalidTokens };
  }
}

/** Records instead of sending (tests, servers without Firebase). */
export class MemorySender implements PushSender {
  readonly name = "memory";
  sent: { tokens: DeviceToken[]; msg: PushMessage }[] = [];
  invalid = new Set<string>();
  async send(tokens: DeviceToken[], msg: PushMessage) {
    if (tokens.length) this.sent.push({ tokens, msg });
    return { sent: tokens.length, invalidTokens: tokens.filter((t) => this.invalid.has(t.token)).map((t) => t.token) };
  }
}
