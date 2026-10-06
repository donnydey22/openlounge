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

export type Ack = (res: unknown) => void;
type Handler = (data: any, ack: Ack) => void | Promise<void>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MAX_FRAME_BYTES = 2_000_000; // profile photo uploads ride on the socket
const HEARTBEAT_MS = 25_000;

export class Conn {
  readonly id = randomUUID();
  /** channels this connection belongs to */
  readonly rooms = new Set<string>();
  private handlers = new Map<string, Handler>();
  private closeHandlers: (() => void)[] = [];
  alive = true;

  constructor(
    readonly ws: WebSocket,
    private hub: WsHub,
  ) {}

  on(ev: string, fn: Handler) {
    this.handlers.set(ev, fn);
  }

  onClose(fn: () => void) {
    this.closeHandlers.push(fn);
  }

  emit(ev: string, data: unknown) {
    this.send({ t: "evt", ev, data });
  }

  send(frame: unknown) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(frame));
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
    let msg: { t?: string; id?: number; ev?: string; data?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.ev !== "string") return;
    const fn = this.handlers.get(msg.ev);
    const ack: Ack =
      msg.t === "req" && typeof msg.id === "number" ? (res) => this.send({ t: "res", id: msg.id, data: res }) : () => {};
    if (!fn) return ack({ ok: false, error: `Unknown event ${msg.ev}` });
    try {
      await fn(msg.data ?? {}, ack);
    } catch (err) {
      console.error(`[ws] handler ${msg.ev} failed`, err);
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
          if (c.ws.readyState === c.ws.OPEN) c.ws.send(frame);
        }
  }
}

export class WsHub {
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private conns = new Map<string, Conn>();
  private channels = new Map<string, Set<Conn>>();
  private connectionHandler: (c: Conn, req: IncomingMessage) => void = () => {};

  constructor(server: HttpServer, readonly path = "/ws") {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = (req.url ?? "").split("?")[0];
      if (pathname !== this.path) return; // leave other upgrades (e.g. Next.js HMR) alone
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, req));
    });
    const iv = setInterval(() => {
      for (const c of this.conns.values()) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
    }, HEARTBEAT_MS);
    iv.unref();
  }

  onConnection(fn: (c: Conn, req: IncomingMessage) => void) {
    this.connectionHandler = fn;
  }

  private accept(ws: WebSocket, req: IncomingMessage) {
    const conn = new Conn(ws, this);
    this.conns.set(conn.id, conn);
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
    for (const c of this.conns.values()) if (c.ws.readyState === c.ws.OPEN) c.ws.send(frame);
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
