// RingRTC session-model signaling for the browser port: every call message (offer/answer/ice/restart/hangup) is
// end-to-end sealed with the OLX3DH-v1 session and relayed opaquely by the OL server as `rc:msg`. The OL server
// (DigitalOcean calling droplet) sees only callId + ciphertext — same trust model as Signal call messages.
// Exposes the RtcSocket shape CallSession already consumes, so the WebRTC media path is unchanged.
import type { RtcSocket } from "../rtc/CallSession";
import { OlSession, type Envelope, type PreKeyBundle } from "./olx3dh";
import type { OlKeyStore } from "./keyStore";

const te = new TextEncoder(), td = new TextDecoder();

export class SealedSignaling implements RtcSocket {
  private session: OlSession | null = null;
  private ready: Promise<void> | null = null;
  private handlers = new Set<(d: unknown) => void>();
  private queue: Promise<void> = Promise.resolve();
  private gotPeerMsg = false;
  private pending: unknown[] = [];
  private onRaw = (d: unknown) => { this.queue = this.queue.then(() => this.receive(d)).catch((e) => this.o.log?.("rc:open-fail", { err: String(e) })); };

  constructor(private sock: RtcSocket, private keys: OlKeyStore, private o: { callId: string; role: "caller" | "callee"; peerUserId: string; log?(ev: string, d?: Record<string, unknown>): void }) {
    sock.on("rc:msg", this.onRaw);
    if (o.role === "caller") this.ready = this.initiate();
  }

  private async initiate() {
    const r = await this.sock.request<{ ok: boolean; bundle?: PreKeyBundle; error?: string }>("rc:keys:fetch", { userId: this.o.peerUserId, callId: this.o.callId });
    if (!r?.ok || !r.bundle) throw new Error(`rc:keys:fetch ${r?.error ?? "failed"}`);
    this.session = await OlSession.initiate(await this.keys.identity(), r.bundle);
  }

  private async receive(d: unknown) {
    const m = d as { callId?: string; env?: Envelope };
    if (!m || m.callId !== this.o.callId || !m.env) return;
    if (this.ready) await this.ready;
    if (!this.session) {
      if (!m.env.pre) throw new Error("olx3dh: first message lacks prekey header");
      const me = await this.keys.identity();
      this.session = await OlSession.respond(me, await this.keys.spkPriv(m.env.pre.spkId), await this.keys.takeOpk(m.env.pre.opkId), m.env.pre);
    }
    if (this.pending.length) { const p = this.pending; this.pending = []; for (const x of p) void this.sendSealed(x).catch(() => {}); }
    const inner = JSON.parse(td.decode(await this.session.open(m.env)));
    if (!this.gotPeerMsg) { this.gotPeerMsg = true; this.session.confirmed(); }
    for (const h of this.handlers) h(inner);
  }

  on(ev: string, fn: (d: unknown) => void) { if (ev === "rtc:signal") this.handlers.add(fn); else this.sock.on(ev, fn); }
  off(ev: string, fn: (d: unknown) => void) {
    if (ev !== "rtc:signal") return this.sock.off(ev, fn);
    this.handlers.delete(fn);
    if (!this.handlers.size) this.close(); // CallSession.close() detaches → session state dropped with the call
  }

  async request<T = unknown>(ev: string, data?: unknown, timeoutMs?: number): Promise<T> {
    if (ev !== "rtc:signal") return this.sock.request<T>(ev, data, timeoutMs);
    if (this.ready) await this.ready;
    if (!this.session) { this.pending.push(data); return { ok: true } as T; } // callee: held until caller's prekey message opens the session
    return this.sendSealed<T>(data, timeoutMs);
  }

  private async sendSealed<T>(data: unknown, timeoutMs?: number): Promise<T> {
    const env = await this.session!.seal(te.encode(JSON.stringify(data)));
    return this.sock.request<T>("rc:msg", { callId: this.o.callId, env }, timeoutMs);
  }

  close() { this.sock.off("rc:msg", this.onRaw); this.handlers.clear(); this.session = null; }
}
