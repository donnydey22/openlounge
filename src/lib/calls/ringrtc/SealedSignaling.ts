// RingRTC session-model signaling for the browser port: every call message (offer/answer/ice/restart/bye) is
// end-to-end sealed with an OLX3DH-v1 session and relayed opaquely by the OL server as `rc:msg`
// {callId, dev, envs:{peerDeviceId: Envelope}}. Like Signal multi-device, the caller fans out to every registered
// device of the callee until one device replies, then locks to it. The OL server (DigitalOcean calling droplet)
// sees only callId/device ids/ciphertext. Exposes the RtcSocket shape CallSession already consumes.
import type { RtcSocket } from "../rtc/CallSession";
import { OlSession, type Envelope, type PreKeyBundle } from "./olx3dh";
import type { OlKeyStore } from "./keyStore";

const te = new TextEncoder(), td = new TextDecoder();
type Wire = { callId?: string; dev?: string; envs?: Record<string, Envelope> };

export class SealedSignaling implements RtcSocket {
  private sessions = new Map<string, OlSession>(); // peer deviceId → session
  private locked: string | null = null;
  private ready: Promise<void> | null = null;
  private myDev: Promise<string>;
  private handlers = new Set<(d: unknown) => void>();
  private queue: Promise<void> = Promise.resolve();
  private pending: unknown[] = [];
  private closed = false;
  private onRaw = (d: unknown) => { this.queue = this.queue.then(() => this.receive(d as Wire)).catch((e) => this.o.log?.("rc:open-fail", { err: String(e).slice(0, 120) })); };

  constructor(private sock: RtcSocket, private keys: OlKeyStore, private o: { callId: string; role: "caller" | "callee"; peerUserId: string; log?(ev: string, d?: Record<string, unknown>): void }) {
    this.myDev = keys.deviceId();
    sock.on("rc:msg", this.onRaw);
    if (o.role === "caller") this.ready = this.initiate();
  }

  private async initiate() {
    const r = await this.sock.request<{ ok: boolean; bundles?: PreKeyBundle[] & { deviceId: string }[]; error?: string }>("rc:keys:fetch", { userId: this.o.peerUserId, callId: this.o.callId });
    if (!r?.ok || !r.bundles?.length) throw new Error(`rc:keys:fetch ${r?.error ?? "failed"}`);
    const me = await this.keys.identity();
    for (const b of r.bundles as (PreKeyBundle & { deviceId: string })[]) {
      try { this.sessions.set(b.deviceId, await OlSession.initiate(me, b)); } catch (e) { this.o.log?.("rc:bundle-reject", { dev: b.deviceId, err: String(e).slice(0, 80) }); }
    }
    if (!this.sessions.size) throw new Error("rc: no valid peer device bundle");
  }

  private async receive(m: Wire) {
    if (this.closed || !m || m.callId !== this.o.callId || typeof m.dev !== "string" || !m.envs) return;
    const env = m.envs[await this.myDev];
    if (!env) return; // addressed to another of my devices
    if (this.ready) await this.ready;
    if (this.locked && this.locked !== m.dev) return; // another peer device after lock (accepted elsewhere)
    let s = this.sessions.get(m.dev);
    if (!s) {
      if (this.o.role === "caller") return;
      if (!env.pre) throw new Error("olx3dh: first message lacks prekey header");
      s = await OlSession.respond(await this.keys.identity(), await this.keys.spkPriv(env.pre.spkId), await this.keys.takeOpk(env.pre.opkId), env.pre);
      this.sessions.set(m.dev, s);
    }
    const inner = JSON.parse(td.decode(await s.open(env)));
    if (!this.locked) {
      this.locked = m.dev;
      s.confirmed();
      for (const k of [...this.sessions.keys()]) if (k !== m.dev) this.sessions.delete(k);
      if (this.pending.length) { const p = this.pending; this.pending = []; for (const x of p) await this.sendSealed(x).catch(() => {}); }
    }
    for (const h of this.handlers) h(inner);
  }

  on(ev: string, fn: (d: unknown) => void) { if (ev === "rtc:signal") this.handlers.add(fn); else this.sock.on(ev, fn); }
  off(ev: string, fn: (d: unknown) => void) {
    if (ev !== "rtc:signal") return this.sock.off(ev, fn);
    this.handlers.delete(fn);
    if (!this.handlers.size) this.close(); // CallSession.close() detaches → per-call session state dropped
  }

  async request<T = unknown>(ev: string, data?: unknown, timeoutMs?: number): Promise<T> {
    if (ev !== "rtc:signal") return this.sock.request<T>(ev, data, timeoutMs);
    if (this.ready) await this.ready;
    if (!this.sessions.size) { this.pending.push(data); return { ok: true } as T; } // callee: held until caller's prekey message opens the session
    return this.sendSealed<T>(data, timeoutMs);
  }

  private async sendSealed<T>(data: unknown, timeoutMs?: number): Promise<T> {
    const plain = te.encode(JSON.stringify(data));
    const envs: Record<string, Envelope> = {};
    for (const [dev, s] of this.sessions) if (!this.locked || dev === this.locked) envs[dev] = await s.seal(plain);
    return this.sock.request<T>("rc:msg", { callId: this.o.callId, dev: await this.myDev, envs }, timeoutMs);
  }

  close() { if (this.closed) return; this.closed = true; this.sock.off("rc:msg", this.onRaw); this.handlers.clear(); this.sessions.clear(); }
}
