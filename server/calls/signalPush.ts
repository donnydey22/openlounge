// call-signal (droplet, PJSIP rebuild) → app server: ring a callee whose phone has no live signal socket.
// POST /api/internal/call-signal-push  Authorization: Bearer $CALL_SIGNAL_PUSH_SECRET
//   { to, callId, from, kind: "audio"|"video", ttlSec }  →  { ok, voipSent, fcm, ms }
// iOS: APNs VoIP (PushKit → CallKit), apns-priority 10. Android: FCM high-priority data (call_incoming), skipped for
// iOS when VoIP already rang. Disabled (404) unless the secret is set. Secrets are never logged.
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { voipService } from "./voip";
import { voipPayload } from "./index";
import { declineTokens } from "./declineToken";
import { push } from "../push";
import { store } from "../store";

export const SIGNAL_PUSH_PATH = "/api/internal/call-signal-push";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const authed = (req: IncomingMessage, secret = process.env.CALL_SIGNAL_PUSH_SECRET) => {
  if (!secret) return false;
  const got = Buffer.from(String(req.headers.authorization || "")), want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};

type Call = { id: string; callerId: string; video: boolean; expiresAt: number; caller: { name: string; photoUrl: string | null } };
export interface SignalPushDeps {
  voipRing: (to: string, payload: Record<string, string>, expiresAt: number) => Promise<number>;
  fcmIncoming: (to: string, call: Call, opts: { skipIos: boolean; declineToken: string }) => Promise<string>;
  user: (id: string) => { name: string; photoUrl?: string | null } | null | undefined;
  mintDecline: (callId: string, to: string, expiresAt: number) => string;
}
const defaultDeps = (): SignalPushDeps => ({
  voipRing: (to, p, e) => voipService()?.ring(to, p, e) ?? Promise.resolve(0),
  fcmIncoming: async (to, c, o) => String((await push()?.callIncoming(to, c, o)) ?? "no-notifier"),
  user: (id) => store.publicUser(id),
  mintDecline: (c, t, e) => declineTokens().mint(c, t, e),
});

export async function handleSignalPush(req: IncomingMessage, res: ServerResponse, json: (r: ServerResponse, s: number, b: unknown) => void, readJson: (r: IncomingMessage) => Promise<Record<string, unknown>>, deps: SignalPushDeps = defaultDeps()) {
  if (!process.env.CALL_SIGNAL_PUSH_SECRET) return json(res, 404, { ok: false });
  if (req.method !== "POST") return json(res, 405, { ok: false });
  if (!authed(req)) return json(res, 401, { ok: false });
  const b = await readJson(req);
  const to = String(b.to ?? ""), callId = String(b.callId ?? ""), from = String(b.from ?? "");
  if (!ID.test(to) || !ID.test(callId) || !ID.test(from)) return json(res, 400, { ok: false, error: "bad ids" });
  const t0 = Date.now(), ttl = Math.min(Math.max(Number(b.ttlSec) || 45, 5), 120);
  const u = deps.user(from);
  const call: Call = { id: callId, callerId: from, video: b.kind === "video", expiresAt: t0 + ttl * 1000, caller: { name: u?.name ?? "Open Lounge", photoUrl: u?.photoUrl ?? null } };
  const declineToken = deps.mintDecline(call.id, to, call.expiresAt);
  const voipSent = await deps.voipRing(to, voipPayload(call, declineToken), call.expiresAt).catch(() => 0);
  const fcm = await deps.fcmIncoming(to, call, { skipIos: voipSent > 0, declineToken }).catch((e) => `error:${(e as Error).message}`.slice(0, 80));
  const r = { ok: true, callId, voipSent, fcm, ms: Date.now() - t0 };
  console.log(`[signal-push] ${JSON.stringify(r)}`); // ids + outcomes only
  return json(res, 200, r);
}
