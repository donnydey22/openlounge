import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createWorker } from "mediasoup";
import WebSocket from "ws";
import { readConfig } from "./config.mjs";

const cfg = readConfig();
const MAX_FRAME = 256_000;
const RECONNECT_DELAYS = [500, 1_000, 2_000, 5_000, 10_000];
// Gateway liveness: a proxy/redeploy can leave the control socket half-open (no close event), and the app server
// would then silently route every call to LiveKit. Ping on an interval; no pong/frame within the timeout → terminate
// (the close handler reconnects with backoff).
const GATEWAY_PING_MS = Number(process.env.MEDIASOUP_GATEWAY_PING_MS) || 10_000;
const GATEWAY_DEAD_MS = Number(process.env.MEDIASOUP_GATEWAY_DEAD_MS) || 25_000;
const ROUTER_CODECS = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48_000, channels: 2, parameters: { minptime: 10, useinbandfec: 1, usedtx: 1 } },
  { kind: "video", mimeType: "video/VP8", clockRate: 90_000, parameters: {} },
  { kind: "video", mimeType: "video/H264", clockRate: 90_000, parameters: { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1 } },
];

const safeLog = (event, extra = {}) => console.log(JSON.stringify({ service: "openlounge-mediasoup", event, ...extra }));
const errText = (err) => (err instanceof Error ? err.message.slice(0, 160) : "operation failed");
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const equal = (a, b) => {
  const aa = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};

/** Verify the app-issued HMAC admission without accepting gateway or coturn static secrets from a browser. */
function verifyAdmission(token, callId, userId) {
  if (typeof token !== "string") return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac("sha256", cfg.admissionSecret).update(payload).digest("base64url");
  if (!equal(signature, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      claims?.v !== 1 ||
      claims.callId !== callId ||
      claims.userId !== userId ||
      typeof claims.nonce !== "string" ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= Math.floor(Date.now() / 1000)
    )
      return null;
    return claims;
  } catch {
    return null;
  }
}

let worker;
let router;
let webRtcServer;
let shuttingDown = false;
let gatewayOnline = false;
let reconnectAttempt = 0;
const sessions = new Map(); // connectionId -> session; connection identity is assigned by the app, never the browser.
const sessionsByParticipant = new Map(); // callId:userId -> connectionId; one active browser session per participant.

function callCount() {
  return new Set([...sessions.values()].map((s) => s.callId)).size;
}

function participantKey(callId, userId) {
  return `${callId}:${userId}`;
}

function sessionOf(input) {
  const s = sessions.get(input.connectionId);
  if (!s || s.closed || s.callId !== input.callId || s.userId !== input.userId) throw new Error("Unknown media session");
  return s;
}

function closeSession(s, reason = "closed") {
  if (!s || s.closed) return;
  s.closed = true;
  for (const consumer of s.consumers.values()) consumer.close();
  for (const producer of s.producers.values()) producer.close();
  for (const transport of s.transports.values()) transport.close();
  sessions.delete(s.connectionId);
  if (sessionsByParticipant.get(s.participantKey) === s.connectionId) sessionsByParticipant.delete(s.participantKey);
  safeLog("session_closed", { reason, call: b64(s.callId).slice(0, 12) });
}

function closeCall(callId) {
  for (const s of [...sessions.values()]) if (s.callId === callId) closeSession(s, "call_closed");
}

function closeConnection(connectionId) {
  const s = sessions.get(connectionId);
  if (s) closeSession(s, "browser_socket_closed");
}

function publicTransport(transport) {
  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
    ...(transport.sctpParameters ? { sctpParameters: transport.sctpParameters } : {}),
  };
}

function notifyPeers(source, event, data = {}) {
  for (const peer of sessions.values()) {
    if (peer.callId !== source.callId || peer.connectionId === source.connectionId) continue;
    emitGateway("ms:gateway:notice", { connectionId: peer.connectionId, event, data: { callId: source.callId, ...data } });
  }
}

async function routeRpc(input) {
  if (!input || typeof input !== "object") throw new Error("Invalid gateway request");
  const { callId, userId, connectionId, method, payload = {}, token } = input;
  if (![callId, userId, connectionId, method].every((x) => typeof x === "string")) throw new Error("Invalid gateway request");
  if (method === "join") {
    if (!verifyAdmission(token, callId, userId)) throw new Error("Invalid admission");
    let s = sessions.get(connectionId);
    if (s && (s.callId !== callId || s.userId !== userId)) {
      closeSession(s, "identity_changed");
      s = null;
    }
    if (!s) {
      const participant = participantKey(callId, userId);
      const previousConnection = sessionsByParticipant.get(participant);
      if (previousConnection && previousConnection !== connectionId) closeSession(sessions.get(previousConnection), "participant_replaced");
      if (sessions.size >= cfg.maxSessions) throw new Error("Pilot session capacity reached");
      if (callCount() >= cfg.maxCalls && ![...sessions.values()].some((x) => x.callId === callId)) throw new Error("Pilot call capacity reached");
      s = { callId, userId, connectionId, participantKey: participant, closed: false, transports: new Map(), producers: new Map(), consumers: new Map() };
      sessions.set(connectionId, s);
      sessionsByParticipant.set(participant, connectionId);
      safeLog("session_joined", { call: b64(callId).slice(0, 12), sessions: sessions.size });
    }
    return { routerRtpCapabilities: router.rtpCapabilities };
  }
  const s = sessionOf({ callId, userId, connectionId });
  if (method === "leave") {
    closeSession(s, "browser_left");
    return {};
  }
  if (method === "transport:create") {
    const direction = payload.direction;
    if (direction !== "send" && direction !== "recv") throw new Error("Invalid transport direction");
    const old = s.transports.get(direction);
    old?.close();
    // UDP-first: every transport offers UDP (preferred) plus, when MEDIASOUP_ENABLE_TCP=1, one ICE-TCP candidate on the
    // same server, so ICE itself lands on TCP only if UDP cannot be established. tcpOnly = the app's explicit TCP
    // fallback (netAdapt floor / repeated UDP failure) on this same SFU instead of a different provider.
    const tcpOnly = payload.tcpOnly === true;
    if (tcpOnly && cfg.tcpPort === null) throw new Error("TCP transport not enabled");
    const transport = await router.createWebRtcTransport({
      webRtcServer,
      enableUdp: !tcpOnly,
      enableTcp: cfg.tcpPort !== null,
      preferUdp: !tcpOnly,
      iceConsentTimeout: 30, // hold the UDP pair through blips (was 15 s; client demotes on its own timers)
      initialAvailableOutgoingBitrate: 600_000,
      appData: { direction, callId, userId, connectionId },
    });
    if (s.closed) {
      transport.close();
      throw new Error("Media session closed");
    }
    transport.on("dtlsstatechange", (state) => state === "closed" && s.transports.delete(direction));
    transport.on("icestatechange", (state) => {
      if (state === "disconnected" || state === "closed") notifyPeers(s, "ms:peer:state", { state });
    });
    s.transports.set(direction, transport);
    return { transport: publicTransport(transport) };
  }
  if (method === "transport:connect") {
    const transport = [...s.transports.values()].find((t) => t.id === payload.transportId);
    if (!transport || !payload.dtlsParameters || typeof payload.dtlsParameters !== "object") throw new Error("Unknown transport");
    await transport.connect({ dtlsParameters: payload.dtlsParameters });
    if (s.closed) throw new Error("Media session closed");
    return {};
  }
  if (method === "produce") {
    const transport = s.transports.get("send");
    if (!transport || transport.id !== payload.transportId) throw new Error("Unknown send transport");
    if (payload.kind !== "audio" && payload.kind !== "video") throw new Error("Unsupported media kind");
    if (!payload.rtpParameters || typeof payload.rtpParameters !== "object") throw new Error("Invalid RTP parameters");
    s.producers.get(payload.kind)?.close();
    const producer = await transport.produce({ kind: payload.kind, rtpParameters: payload.rtpParameters, appData: { callId, userId, connectionId, kind: payload.kind } });
    if (s.closed) {
      producer.close();
      throw new Error("Media session closed");
    }
    producer.on("transportclose", () => s.producers.delete(payload.kind));
    s.producers.set(payload.kind, producer);
    notifyPeers(s, "ms:consumer:available");
    return { id: producer.id };
  }
  if (method === "consume") {
    const transport = s.transports.get("recv");
    if (!transport || transport.id !== payload.transportId || !payload.rtpCapabilities || typeof payload.rtpCapabilities !== "object") throw new Error("Unknown receive transport");
    const consumers = [];
    for (const peer of sessions.values()) {
      if (peer.callId !== callId || peer.connectionId === connectionId) continue;
      for (const producer of peer.producers.values()) {
        if (s.consumers.has(producer.id) || !router.canConsume({ producerId: producer.id, rtpCapabilities: payload.rtpCapabilities })) continue;
        const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities: payload.rtpCapabilities, paused: true, appData: { callId, userId, connectionId } });
        if (s.closed) {
          consumer.close();
          throw new Error("Media session closed");
        }
        consumer.on("transportclose", () => s.consumers.delete(producer.id));
        consumer.on("producerclose", () => {
          s.consumers.delete(producer.id);
          consumer.close();
          emitGateway("ms:gateway:notice", { connectionId, event: "ms:consumer:closed", data: { callId, consumerId: consumer.id } });
        });
        s.consumers.set(producer.id, consumer);
        consumers.push({ id: consumer.id, producerId: producer.id, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
      }
    }
    return { consumers };
  }
  if (method === "transport:restartIce") {
    // Audio reliability: a phone that hops Wi-Fi <-> cellular gets fresh ICE credentials on the same transport, so
    // producers/consumers survive without a full renegotiation or a TCP fallback.
    const transport = [...s.transports.values()].find((t) => t.id === payload.transportId);
    if (!transport) throw new Error("Unknown transport");
    const iceParameters = await transport.restartIce();
    if (s.closed) throw new Error("Media session closed");
    return { iceParameters };
  }
  if (method === "consumer:resume") {
    for (const consumer of s.consumers.values()) if (consumer.id === payload.consumerId) {
      await consumer.resume();
      return {};
    }
    throw new Error("Unknown consumer");
  }
  throw new Error("Unsupported media action");
}

let gateway = null;
function emitGateway(ev, data) {
  if (gateway?.readyState === WebSocket.OPEN) gateway.send(JSON.stringify({ t: "evt", ev, data }));
}

function connectGateway() {
  if (shuttingDown) return;
  const ws = new WebSocket(cfg.gatewayUrl, { maxPayload: MAX_FRAME });
  gateway = ws;
  let helloId = 1;
  let helloTimer;
  let lastSeen = Date.now();
  const seen = () => { lastSeen = Date.now(); };
  const pinger = setInterval(() => {
    // a handshake that never completes (redeploy behind the proxy) is just as silent as a half-open socket
    if (ws.readyState === WebSocket.CONNECTING && Date.now() - lastSeen > GATEWAY_DEAD_MS) {
      safeLog("gateway_stale", { phase: "connecting", silentMs: Date.now() - lastSeen });
      return ws.terminate();
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastSeen > GATEWAY_DEAD_MS) {
      safeLog("gateway_stale", { silentMs: Date.now() - lastSeen });
      return ws.terminate();
    }
    try { ws.ping(); } catch { ws.terminate(); }
  }, GATEWAY_PING_MS);
  pinger.unref?.();
  ws.on("pong", seen);
  ws.on("ping", seen);
  ws.on("open", () => {
    seen();
    ws.send(JSON.stringify({ t: "req", id: helloId, ev: "ms:gateway:hello", data: { secret: cfg.gatewaySecret } }));
    helloTimer = setTimeout(() => ws.close(), 5_000);
  });
  ws.on("message", async (raw) => {
    seen();
    if (Buffer.byteLength(raw) > MAX_FRAME) return ws.close();
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { return ws.close(); }
    if (frame.t === "res" && frame.id === helloId) {
      clearTimeout(helloTimer);
      if (!frame.data?.ok) return ws.close();
      gatewayOnline = true;
      reconnectAttempt = 0;
      safeLog("gateway_connected");
      return;
    }
    if (frame.t === "evt" && frame.ev === "ms:gateway:close") return closeCall(frame.data?.callId);
    if (frame.t === "evt" && frame.ev === "ms:gateway:closeConnection" && typeof frame.data?.connectionId === "string") return closeConnection(frame.data.connectionId);
    if (frame.t !== "evt" || frame.ev !== "ms:gateway:rpc" || !gatewayOnline) return;
    const id = frame.data?.id;
    if (typeof id !== "string") return;
    try {
      const result = await routeRpc(frame.data);
      emitGateway("ms:gateway:response", { id, ok: true, result });
    } catch (err) {
      // No token, SDP, user identity, source IP, or raw error object is emitted. The app only needs a bounded reason.
      emitGateway("ms:gateway:response", { id, ok: false, error: errText(err) });
    }
  });
  ws.on("close", () => {
    clearTimeout(helloTimer);
    clearInterval(pinger);
    if (gateway === ws) gateway = null;
    if (!gatewayOnline && shuttingDown) return;
    gatewayOnline = false;
    for (const s of [...sessions.values()]) closeSession(s, "gateway_lost");
    if (!shuttingDown) {
      const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt++, RECONNECT_DELAYS.length - 1)];
      safeLog("gateway_disconnected", { retryMs: delay });
      setTimeout(connectGateway, delay).unref();
    }
  });
  ws.on("error", () => {});
}

async function main() {
  worker = await createWorker({ logLevel: "warn", logTags: ["ice", "dtls", "rtp", "bwe", "score"], rtcMinPort: cfg.minPort, rtcMaxPort: cfg.maxPort });
  worker.on("died", () => {
    safeLog("worker_died");
    process.exitCode = 1;
    // A dead worker invalidates every UDP transport. App-side 4-second failure detection selects LiveKit for each call.
    for (const s of [...sessions.values()]) closeSession(s, "worker_died");
    setTimeout(() => process.exit(1), 500).unref();
  });
  webRtcServer = await worker.createWebRtcServer({
    // UDP range + (opt-in) one ICE-TCP port on the same public address.
    listenInfos: [
      { protocol: "udp", ip: cfg.bindIp, announcedAddress: cfg.announcedAddress, portRange: { min: cfg.minPort, max: cfg.maxPort } },
      ...(cfg.tcpPort !== null ? [{ protocol: "tcp", ip: cfg.bindIp, announcedAddress: cfg.announcedAddress, port: cfg.tcpPort }] : []),
    ],
  });
  router = await worker.createRouter({ mediaCodecs: ROUTER_CODECS });
  const health = http.createServer((req, res) => {
    if (req.url !== "/healthz") return res.writeHead(404).end();
    const body = JSON.stringify({ ok: !!worker && !worker.closed && gatewayOnline, worker: !!worker && !worker.closed, gateway: gatewayOnline, sessions: sessions.size, calls: callCount(), maxCalls: cfg.maxCalls, maxSessions: cfg.maxSessions });
    res.writeHead(gatewayOnline && !worker.closed ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(body);
  });
  await new Promise((resolve) => health.listen(cfg.healthPort, cfg.healthHost, resolve));
  safeLog("ready", { healthHost: cfg.healthHost, healthPort: cfg.healthPort, udpRange: `${cfg.minPort}-${cfg.maxPort}`, maxCalls: cfg.maxCalls });
  connectGateway();
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    gateway?.close();
    for (const s of [...sessions.values()]) closeSession(s, "shutdown");
    webRtcServer?.close();
    router?.close();
    worker?.close();
    health.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((err) => {
  safeLog("boot_failed", { error: errText(err) });
  process.exit(1);
});
