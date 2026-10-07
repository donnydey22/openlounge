// Tiny realtime layer on raw WebSockets (`ws`): named events, request/response
// acks, channels ("rooms" in the pub/sub sense) and heartbeats.
//
// Wire protocol (JSON text frames):
//   client → server  {"t":"req","id":7,"ev":"room:join","data":{...}}   expects {"t":"res","id":7,"data":{...}}
//   client → server  {"t":"evt","ev":"self:typing","data":{...}}         fire-and-forget
//   server → client  {"t":"evt","ev":"room:state","data":{...}}
//
// Served at /ws on the same HTTP(S) server as the app. In production put the app
// behind TLS (Railway/Render/Fly terminate TLS) and the browser automatically
// uses wss:// because the page is https://.

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { log, metrics } from "./log";
import { LARGE_EVENTS, validateEvent } from "./wsSchemas";

export type Ack = (res: unknown) => void;
type Handler = (data: any, ack: Ack) => void | Promise<void>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MAX_FRAME_BYTES = 2_000_000; // profile photo uploads ride on the socket (only LARGE_EVENTS may use it)
const env = (k: string, d: number) => (process.env[k] && Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);
/** every other event: 16 KB is ~4× the largest legit frame (chat text is capped far below) */
export const WS_SMALL_FRAME_BYTES = env("WS_SMALL_FRAME_BYTES", 16_384);
/** slow consumer: a socket with more than this queued in the kernel/userland buffer is closed (1013) */
export const WS_MAX_BUFFERED = env("WS_MAX_BUFFERED_BYTES", 1_000_000);
/** per-connection inbound rate: token bucket (sustained msgs/s, burst) */
const WS_RATE = env("WS_RATE_PER_SEC", 20);
const WS_BURST = env("WS_RATE_BURST", 60);
/** violations (oversize / invalid / rate) tolerated before the socket is closed with 1008 */
const WS_MAX_STRIKES = env("WS_MAX_STRIKES", 50);
// Ping every 10 s; a socket that misses a pong (and sends nothing) for a full interval is
// terminated, so dead connections (app killed, network lost) are dropped within ~10–20 s.
const HEARTBEAT_MS = 10_000;
/**
 * A connection whose client reported it is in the background (presence:visible false) may miss pongs for this many
 * intervals before it is terminated: Android/iOS freeze backgrounded WebViews, so a phone that is merely in a
 * pocket stops answering pings. Dropping it after 10 s made the app look "disconnected" seconds after the user
 * switched apps (and forced a full re-auth on return). A killed app still closes its TCP socket immediately.
 */
const HIDDEN_MAX_MISSED = Number(process.env.WS_HIDDEN_MAX_MISSED || 18); // ~3 min

export class Conn {
  readonly id = randomUUID();
  /** channels this connection belongs to */
  readonly rooms = new Set<string>();
  private handlers = new Map<string, Handler>();
  private closeHandlers: (() => void)[] = [];
  alive = true;
  /** client says it is backgrounded (tolerate missed pongs, see HIDDEN_MAX_MISSED) */
  hidden = false;
  missed = 0;
  /** token bucket for inbound rate limiting */
  private tokens = WS_BURST;
  private refillAt = Date.now();
  strikes = 0;

  constructor(
    readonly ws: WebSocket,
    private hub: WsHub,
  ) {}

  on(ev: string, fn: Handler) {
    this.handlers.set(ev, fn);
  }

  /** called before every dispatched event (presence "last seen" bump on any interaction) */
  onAny: ((ev: string) => void) | null = null;

  onClose(fn: () => void) {
    this.closeHandlers.push(fn);
  }

  emit(ev: string, data: unknown) {
    this.send({ t: "evt", ev, data });
  }

  send(frame: unknown) {
    this.sendRaw(JSON.stringify(frame));
  }

  /** Backpressure-aware send: a socket that can't keep up is closed (client reconnects + catches up via dm:since). */
  sendRaw(frame: string) {
    if (this.ws.readyState !== this.ws.OPEN) return false;
    if (this.ws.bufferedAmount > WS_MAX_BUFFERED) {
      metrics.inc("ws_slow_consumer_closed_total");
      log.warn("ws slow consumer closed", { conn: this.id, buffered: this.ws.bufferedAmount });
      this.ws.close(1013, "slow consumer");
      return false;
    }
    this.ws.send(frame);
    metrics.inc("ws_frames_out_total");
    return true;
  }

  /** @internal token bucket; true = allowed */
  takeToken(now = Date.now()) {
    this.tokens = Math.min(WS_BURST, this.tokens + ((now - this.refillAt) / 1000) * WS_RATE);
    this.refillAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private strike(reason: string) {
    metrics.inc(`ws_rejected_${reason}_total`);
    if (++this.strikes >= WS_MAX_STRIKES) {
      log.warn("ws closing abusive connection", { conn: this.id, reason });
      this.ws.close(1008, "policy violation");
    }
  }

  join(channel: string) {
    this.rooms.add(channel);
    this.hub.addToChannel(channel, this);
  }

  leave(channel: string) {
    this.rooms.delete(channel);
    this.hub.removeFromChannel(channel, this);
  }

  /** @internal */
  async dispatch(raw: string) {
    metrics.inc("ws_frames_in_total");
    if (!this.takeToken()) {
      // answer requests so the client's promise settles; drop fire-and-forget events silently
      const m = /"t"\s*:\s*"req"[^]*?"id"\s*:\s*(\d+)/.exec(raw.slice(0, 200));
      if (m) this.send({ t: "res", id: Number(m[1]), data: { ok: false, error: "Slow down a little 🙂", reason: "rate_limited" } });
      return this.strike("rate");
    }
    let msg: { t?: string; id?: number; ev?: string; data?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.strike("json");
    }
    if (!msg || typeof msg !== "object" || typeof msg.ev !== "string" || msg.ev.length > 64) return this.strike("shape");
    const ack: Ack =
      msg.t === "req" && typeof msg.id === "number" ? (res) => this.send({ t: "res", id: msg.id, data: res }) : () => {};
    if (raw.length > WS_SMALL_FRAME_BYTES && !LARGE_EVENTS.has(msg.ev)) {
      this.strike("size");
      return ack({ ok: false, error: "Message too large", reason: "too_large" });
    }
    const fn = this.handlers.get(msg.ev);
    if (!fn) return ack({ ok: false, error: `Unknown event ${msg.ev}` });
    const invalid = validateEvent(msg.ev, msg.data);
    if (invalid === "unschematized") metrics.inc("ws_unschematized_total");
    else if (invalid) {
      this.strike("schema");
      return ack({ ok: false, error: "Invalid request", reason: "invalid", detail: invalid });
    }
    try {
      this.onAny?.(msg.ev);
      await fn(msg.data ?? {}, ack);
    } catch (err) {
      metrics.inc("ws_handler_errors_total");
      log.error("ws handler failed", { ev: msg.ev, conn: this.id, err });
      ack({ ok: false, error: "Server error" });
    }
  }

  /** @internal */
  closed() {
    for (const ch of this.rooms) this.hub.removeFromChannel(ch, this);
    this.rooms.clear();
    for (const fn of this.closeHandlers) fn();
  }
}

class Broadcast {
  constructor(
    private hub: WsHub,
    private channels: string[],
  ) {}
  to(channel: string) {
    return new Broadcast(this.hub, [...this.channels, channel]);
  }
  emit(ev: string, data: unknown) {
    const seen = new Set<Conn>();
    const frame = JSON.stringify({ t: "evt", ev, data });
    for (const ch of this.channels)
      for (const c of this.hub.members(ch))
        if (!seen.has(c)) {
          seen.add(c);
          c.sendRaw(frame);
        }
  }
}

export class WsHub {
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private conns = new Map<string, Conn>();
  private channels = new Map<string, Set<Conn>>();
  private connectionHandler: (c: Conn, req: IncomingMessage) => void = () => {};

  constructor(
    server: HttpServer,
    readonly path = "/ws",
    /** Origin policy: browsers on other sites are refused; no Origin (native apps, bots) is allowed */
    private allowUpgrade: (req: IncomingMessage) => boolean = () => true,
  ) {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = (req.url ?? "").split("?")[0];
      if (pathname !== this.path) return; // leave other upgrades (e.g. Next.js HMR) alone
      if (this.draining) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 2\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (!this.allowUpgrade(req)) {
        metrics.inc("ws_upgrade_forbidden_total");
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, req));
    });
    const iv = setInterval(() => {
      for (const c of this.conns.values()) {
        if (!c.alive) {
          if (c.hidden && ++c.missed < HIDDEN_MAX_MISSED) {
            c.ws.ping();
            continue;
          }
          metrics.inc("ws_dead_reaped_total");
          c.ws.terminate();
          continue;
        }
        c.missed = 0;
        c.alive = false;
        c.ws.ping();
      }
    }, HEARTBEAT_MS);
    iv.unref();
    this.heartbeat = iv;
    metrics.gauge("ws_connections", () => this.conns.size);
    metrics.gauge("ws_channels", () => this.channels.size);
  }

  private heartbeat: NodeJS.Timeout;
  private draining = false;

  get size() {
    return this.conns.size;
  }

  get isDraining() {
    return this.draining;
  }

  /**
   * Graceful shutdown: refuse new upgrades, close every socket with 1012 ("service restart") so clients reconnect
   * (to the new deploy) with their normal backoff, then wait up to timeoutMs for close handshakes.
   */
  async drain(timeoutMs = 5000) {
    this.draining = true;
    clearInterval(this.heartbeat);
    for (const c of this.conns.values()) {
      try {
        c.ws.close(1012, "server restarting");
      } catch {
        /* ignore */
      }
    }
    const until = Date.now() + timeoutMs;
    while (this.conns.size && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    for (const c of this.conns.values()) c.ws.terminate();
    this.wss.close();
  }

  onConnection(fn: (c: Conn, req: IncomingMessage) => void) {
    this.connectionHandler = fn;
  }

  private accept(ws: WebSocket, req: IncomingMessage) {
    const conn = new Conn(ws, this);
    this.conns.set(conn.id, conn);
    metrics.inc("ws_connections_total");
    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (buf) => {
      conn.alive = true;
      void conn.dispatch(buf.toString());
    });
    ws.on("close", () => {
      this.conns.delete(conn.id);
      conn.closed();
    });
    ws.on("error", () => ws.terminate());
    this.connectionHandler(conn, req);
  }

  get(id: string) {
    return this.conns.get(id);
  }

  members(channel: string): Iterable<Conn> {
    return this.channels.get(channel) ?? [];
  }

  to(channel: string) {
    return new Broadcast(this, [channel]);
  }

  /** broadcast to every connection */
  emit(ev: string, data: unknown) {
    const frame = JSON.stringify({ t: "evt", ev, data });
    for (const c of this.conns.values()) c.sendRaw(frame);
  }

  /** remove every member from a channel */
  clearChannel(channel: string) {
    for (const c of [...this.members(channel)]) c.leave(channel);
  }

  /** @internal */
  addToChannel(channel: string, c: Conn) {
    let set = this.channels.get(channel);
    if (!set) this.channels.set(channel, (set = new Set()));
    set.add(c);
  }

  /** @internal */
  removeFromChannel(channel: string, c: Conn) {
    const set = this.channels.get(channel);
    if (!set) return;
    set.delete(c);
    if (set.size === 0) this.channels.delete(channel);
  }
}
