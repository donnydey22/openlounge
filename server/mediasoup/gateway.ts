import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Conn } from "../ws";
import { metrics } from "../log";
import { usableAdmissionSecret } from "./admission";

const RPC_TIMEOUT_MS = 5_000;
const MIN_GATEWAY_SECRET_BYTES = 32;
const GATEWAY_NOTICES = new Set(["ms:consumer:available", "ms:consumer:closed", "ms:peer:state"]);

export type GatewayNotice = { connectionId: string; event: string; data: unknown };

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout };

function safeEqual(a: string, b: string) {
  const aa = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

/**
 * Single outbound SFU control connection. Browser WebSockets never become gateway connections: they cannot make
 * requests until the SFU proves knowledge of MEDIASOUP_GATEWAY_SECRET, and all browser media actions are separately
 * authorized by the normal call service before they are relayed.
 */
export class MediasoupGateway {
  private conn: Conn | null = null;
  private pending = new Map<string, Pending>();
  private notify: ((notice: GatewayNotice) => void) | null = null;

  constructor(
    private cfg: { gatewaySecret?: string; admissionSecret?: string; now?: () => number } = {},
  ) {}

  get configured() {
    const gatewaySecret = this.cfg.gatewaySecret ?? process.env.MEDIASOUP_GATEWAY_SECRET;
    const admissionSecret = this.cfg.admissionSecret ?? process.env.MEDIASOUP_ADMISSION_SECRET;
    return typeof gatewaySecret === "string" && Buffer.byteLength(gatewaySecret, "utf8") >= MIN_GATEWAY_SECRET_BYTES && usableAdmissionSecret(admissionSecret);
  }

  get connected() {
    return this.configured && this.conn !== null;
  }

  setNotifier(fn: ((notice: GatewayNotice) => void) | null) {
    this.notify = fn;
  }

  attach(conn: Conn, presented: unknown) {
    const expected = this.cfg.gatewaySecret ?? process.env.MEDIASOUP_GATEWAY_SECRET;
    if (!this.configured || typeof presented !== "string" || !expected || !safeEqual(presented, expected)) {
      metrics.inc("mediasoup_gateway_auth_rejected_total");
      return { ok: false as const, error: "Gateway authentication failed" };
    }
    if (this.conn && this.conn !== conn) this.detach(this.conn, "replaced");
    this.conn = conn;
    conn.onClose(() => this.detach(conn, "closed"));
    metrics.inc("mediasoup_gateway_connected_total");
    return { ok: true as const };
  }

  private detach(conn: Conn, reason: string) {
    if (this.conn !== conn) return;
    this.conn = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Media gateway unavailable"));
      this.pending.delete(id);
    }
    metrics.inc(`mediasoup_gateway_disconnected_${reason}_total`);
  }

  /** Server-authorized command to the SFU. Token is a short-lived call/user admission token generated server-side. */
  request(input: { callId: string; userId: string; connectionId: string; method: string; payload: Record<string, unknown>; token: string }): Promise<unknown> {
    const conn = this.conn;
    if (!this.connected || !conn) return Promise.reject(new Error("Media gateway unavailable"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Media gateway timed out"));
      }, RPC_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      conn.emit("ms:gateway:rpc", { id, ...input });
    });
  }

  closeCall(callId: string) {
    if (!this.connected || !this.conn) return;
    this.conn.emit("ms:gateway:close", { callId });
  }

  /** Drop all direct-media state tied to a browser socket. This is server-originated cleanup, not a browser command. */
  closeConnection(connectionId: string) {
    if (!this.connected || !this.conn) return;
    this.conn.emit("ms:gateway:closeConnection", { connectionId });
  }

  handleResponse(conn: Conn, data: unknown) {
    if (conn !== this.conn || !data || typeof data !== "object") return { ok: false as const };
    const d = data as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    if (typeof d.id !== "string") return { ok: false as const };
    const p = this.pending.get(d.id);
    if (!p) return { ok: false as const };
    clearTimeout(p.timer);
    this.pending.delete(d.id);
    if (d.ok === true) p.resolve(d.result);
    else p.reject(new Error(typeof d.error === "string" ? d.error.slice(0, 160) : "Media gateway request failed"));
    return { ok: true as const };
  }

  /** FX-081: SFU-side per-call stats; accepted only from the authenticated gateway connection. */
  handleTelemetry(conn: Conn, data: unknown): { callId: string; data: unknown } | null {
    if (conn !== this.conn || !data || typeof data !== "object") return null;
    const callId = (data as { callId?: unknown }).callId;
    if (typeof callId !== "string" || !/^[\w:.@-]{1,128}$/.test(callId)) return null;
    return { callId, data };
  }

  handleNotice(conn: Conn, data: unknown) {
    if (conn !== this.conn || !data || typeof data !== "object") return { ok: false as const };
    const d = data as { connectionId?: unknown; event?: unknown; data?: unknown };
    if (typeof d.connectionId !== "string" || typeof d.event !== "string" || !GATEWAY_NOTICES.has(d.event)) return { ok: false as const };
    this.notify?.({ connectionId: d.connectionId, event: d.event, data: d.data });
    return { ok: true as const };
  }
}
