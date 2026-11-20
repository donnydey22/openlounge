// Desktop-web signaling to the olcall Pion server (Donny t6081u item 1): the browser joins its own leg on the call
// server (surface "browser", the Pion webleg) with the per-user join token from CallMedia, gets the "joined" frame
// (TURN-only iceServers, minted per leg), offers to the server, and trickles ICE. Same WebSocket protocol the phones
// use (olcall/server/protocol.go); the old sealed rc:* peer-to-peer exchange is gone. Exposes the RtcSocket shape
// CallSession already consumes, so the browser media code (mic, camera, playback, ICE restart) is unchanged.
import type { CallMedia, TurnIceServer } from "../../types";
import type { RtcSocket } from "./CallSession";

type Frame = { t: string; [k: string]: unknown };
type Handler = (d: unknown) => void;

export interface OlcallSignalingOpts {
  callId: string;
  /** Fresh TURN logins for an ICE restart after the joined list's credentials aged (backend call:get media). */
  freshIce?(): Promise<TurnIceServer[] | null>;
  onPeer?(state: string): void;
  /** the other side's mute / camera state, relayed by the call server ("media" frame) */
  onPeerMedia?(state: { muted?: boolean; video?: string }): void;
  onBye?(detail: string): void;
  log?(ev: string, d?: Record<string, unknown>): void;
  /** test seam */
  createSocket?(url: string): WebSocket;
}

const turnOnly = (list: TurnIceServer[] | undefined): TurnIceServer[] =>
  (list ?? []).map((s) => ({ ...s, urls: ([] as string[]).concat(s.urls as string | string[]).filter((u) => /^turns?:/i.test(u)) })).filter((s) => s.urls.length > 0) as TurnIceServer[];

export class OlcallSignaling implements RtcSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private gen = 0;
  private closed = false;
  private leg = "";
  private resumeKey = "";
  private ice: TurnIceServer[] = [];
  private joinedResolve!: (ice: TurnIceServer[]) => void;
  private joinedReject!: (e: Error) => void;
  /** Resolves with the joined frame's TURN-only list (the browser's ICE servers). */
  readonly joined: Promise<TurnIceServer[]>;
  private outbox: Frame[] = [];
  private ping: ReturnType<typeof setInterval> | null = null;
  private resumes = 0;
  private lastMedia: Frame | null = null;
  readonly t: Record<string, number> = {};

  constructor(private media: CallMedia, private o: OlcallSignalingOpts) {
    this.joined = new Promise((res, rej) => { this.joinedResolve = res; this.joinedReject = rej; });
    this.joined.catch(() => {});
  }

  /** Open the leg now (press time): join -> joined frame. ICE servers come from that frame. */
  connect() {
    this.t.join = Date.now();
    this.open({ t: "join", token: this.media.token, surface: "browser", platform: "web", engine: "web-webleg", callId: this.o.callId,
      traceId: `web-${this.o.callId.slice(0, 8)}-${Date.now().toString(36)}` });
    return this.joined;
  }

  private open(first: Frame) {
    if (this.closed) return;
    const ws = this.o.createSocket ? this.o.createSocket(this.media.url) : new WebSocket(this.media.url);
    this.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify(first)); };
    ws.onmessage = (e) => { let f: Frame; try { f = JSON.parse(String(e.data)); } catch { return; } this.onFrame(f); };
    ws.onclose = () => { if (this.ws === ws) this.lost(); };
    ws.onerror = () => {};
  }

  private onFrame(f: Frame) {
    switch (f.t) {
      case "joined": {
        this.t.joined = Date.now();
        this.leg = String(f.leg ?? "");
        this.resumeKey = String(f.resume ?? "");
        this.ice = turnOnly(f.iceServers as TurnIceServer[] | undefined);
        this.o.log?.("olcall-joined", { leg: this.leg, ms: this.t.joined - this.t.join, turn: this.ice.length });
        this.ping ??= setInterval(() => this.raw({ t: "ping" }), 15_000);
        this.flush();
        this.joinedResolve(this.ice);
        return;
      }
      case "resumed":
        this.resumes = 0;
        this.o.log?.("olcall-resumed", {});
        this.flush();
        return;
      case "answer":
        this.emit({ kind: "answer", sdp: f.sdp });
        return;
      case "ice":
        this.emit({ kind: "candidate", candidate: f.candidate ?? null });
        return;
      case "peer":
        this.o.onPeer?.(String(f.peer ?? ""));
        return;
      case "bye":
        this.o.log?.("olcall-bye", { detail: String(f.detail ?? "") });
        this.shut();
        this.emit({ kind: "bye" });
        this.o.onBye?.(String(f.detail ?? ""));
        return;
      case "error":
        this.o.log?.("olcall-error", { error: String(f.error ?? "") });
        if (!this.t.joined) { this.shut(); this.joinedReject(new Error(String(f.error ?? "join failed"))); }
        return;
      case "media":
        if (f.state && typeof f.state === "object") this.o.onPeerMedia?.(f.state as { muted?: boolean; video?: string });
        return;
      default:
        return; // stats, call:state (the backend relays state), pong
    }
  }

  private emit(m: Record<string, unknown>) {
    const msg = { callId: this.o.callId, gen: this.gen, ...m };
    for (const h of this.handlers) h(msg);
  }

  /** Socket dropped mid-call: rebind the same leg with the resume key (server keeps it ~40 s). */
  private lost() {
    if (this.closed) return;
    if (!this.t.joined || !this.resumeKey || this.resumes >= 6) {
      this.o.log?.("olcall-socket-lost", { joined: !!this.t.joined, resumes: this.resumes });
      this.shut();
      if (!this.t.joined) this.joinedReject(new Error("socket closed before joined"));
      else { this.emit({ kind: "bye" }); this.o.onBye?.("socket-lost"); }
      return;
    }
    const n = ++this.resumes;
    setTimeout(() => this.open({ t: "resume", callId: this.o.callId, leg: this.leg, resume: this.resumeKey }), Math.min(500 * n, 3000));
  }

  private raw(f: Frame): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(f));
    return true;
  }
  private send(f: Frame) { if (!this.t.joined || !this.raw(f)) this.outbox.push(f); }
  private flush() { const q = this.outbox.splice(0); for (const f of q) if (!this.raw(f)) this.outbox.push(f); if (this.lastMedia) this.raw(this.lastMedia); }

  /** Tell the server (and through it the other side) this leg's mute / camera state. Local only otherwise. */
  mediaState(muted: boolean, videoOn: boolean) {
    this.lastMedia = { t: "media", state: { muted, video: videoOn ? "active" : "inactive", rotation: 0, screencast: "inactive", lowBattery: false } };
    if (this.t.joined) this.raw(this.lastMedia);
  }

  // ---- RtcSocket (what CallSession calls) ----
  on(ev: string, fn: Handler) { if (ev === "rtc:signal") this.handlers.add(fn); }
  off(ev: string, fn: Handler) {
    if (ev !== "rtc:signal") return;
    this.handlers.delete(fn);
    if (!this.handlers.size) this.close();
  }
  async request<T = unknown>(ev: string, data?: unknown): Promise<T> {
    if (ev === "rtc:iceConfig") {
      const fresh = (await this.o.freshIce?.().catch(() => null)) ?? null;
      const list = fresh ? turnOnly(fresh) : [];
      if (list.length) this.ice = list;
      return { ok: true, config: { iceServers: this.ice } } as T;
    }
    if (ev !== "rtc:signal") return { ok: false, error: "unsupported" } as T;
    const m = (data ?? {}) as { gen?: number; kind?: string; sdp?: string; candidate?: RTCIceCandidateInit | null };
    if (typeof m.gen === "number") this.gen = m.gen;
    if (m.kind === "offer" && m.sdp) {
      this.t.offer ??= Date.now();
      this.send({ t: "offer", sdp: m.sdp });
    } else if (m.kind === "candidate") {
      this.t.firstCandidate ??= Date.now();
      if (m.candidate) this.send({ t: "ice", candidate: m.candidate });
    }
    return { ok: true } as T;
  }

  /** Explicit hang-up: the server ends a rung call / drops only this leg of a link. */
  hangup() {
    if (this.closed) return;
    this.raw({ t: "hangup" });
    setTimeout(() => this.close(), 100);
  }

  private shut() {
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* ignore */ }
  }
  close() { if (this.closed) return; this.shut(); this.handlers.clear(); }
}
