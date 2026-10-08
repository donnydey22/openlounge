// Inbound LiveKit server webhooks: POST /api/livekit/webhook (foundation for recordings / egress / ingress and
// streaming integrations — see /workspace/streaming/WEBHOOKS_DESIGN.md).
//
// LiveKit signs every delivery: the Authorization header is a JWT (our API key/secret) whose `sha256` claim is the
// SHA-256 of the raw body. We verify that, drop replays by event id, count + log, and hand the event to subscribers.
// Configure on the LiveKit server (livekit.yaml):
//   webhook:
//     api_key: <LIVEKIT_API_KEY>
//     urls: [https://openlounge.app/api/livekit/webhook]

import type { IncomingMessage, ServerResponse } from "node:http";
import { WebhookReceiver, type WebhookEvent } from "livekit-server-sdk";
import { log, metrics } from "./log";

const MAX_BODY = 64 * 1024;
const SEEN_MAX = 2_000;
const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
const receiver = LIVEKIT_API_KEY && LIVEKIT_API_SECRET ? new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET) : null;

type Listener = (ev: WebhookEvent) => void | Promise<void>;
const listeners = new Set<Listener>();
/** Subscribe to verified LiveKit events (room_started/finished, participant_*, track_*, egress_*, ingress_*). */
export function onLiveKitEvent(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const seen = new Set<string>();
/** last few verified events (ops / tests) */
export const recentLiveKitEvents: { id: string; event: string; room: string | null; at: number }[] = [];

function readRaw(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

export async function handleLiveKitWebhook(req: IncomingMessage, res: ServerResponse) {
  const reply = (status: number, body: Record<string, unknown>) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (!receiver) return reply(503, { ok: false, error: "LiveKit isn't configured" });
  const body = await readRaw(req);
  if (body === null) return reply(413, { ok: false, error: "Too large" });
  let ev: WebhookEvent;
  try {
    ev = await receiver.receive(body, String(req.headers.authorization ?? ""));
  } catch {
    metrics.inc("livekit_webhook_rejected_total");
    return reply(401, { ok: false, error: "Invalid signature" });
  }
  if (ev.id && seen.has(ev.id)) return reply(200, { ok: true, duplicate: true }); // LiveKit retries on non-2xx/timeouts
  if (ev.id) {
    seen.add(ev.id);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
  }
  metrics.inc(`livekit_webhook_${ev.event || "unknown"}_total`);
  recentLiveKitEvents.push({ id: ev.id, event: ev.event, room: ev.room?.name ?? null, at: Date.now() });
  if (recentLiveKitEvents.length > 100) recentLiveKitEvents.shift();
  log.info("livekit webhook", { event: ev.event, room: ev.room?.name, participant: ev.participant?.identity, egress: ev.egressInfo?.egressId });
  reply(200, { ok: true }); // answer fast; subscribers run after
  for (const fn of listeners) {
    try {
      await fn(ev);
    } catch (err) {
      log.warn("livekit webhook listener failed", { event: ev.event, err });
    }
  }
}
