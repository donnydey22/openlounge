// Browser side of the raw-WebSocket realtime layer (see server/ws.ts for the protocol).
// Features: named events, request/response with timeouts, auto-reconnect with backoff,
// an app-level heartbeat (detects half-open sockets the browser hasn't noticed yet) and
// instant reconnect when the page comes back to the foreground / network returns
// (Android WebView backgrounding, laptop sleep, Wi-Fi ↔ cellular switches).
// Uses wss:// automatically when the page is served over https:// (production/TLS).

const HEARTBEAT_MS = 20_000; // client → server "ping" while the page is visible
const HEARTBEAT_TIMEOUT_MS = 10_000; // no "pong" in this long → socket is dead, reconnect
const WAKE_PING_TIMEOUT_MS = 4_000; // quick health check when returning to the foreground
const CONNECT_TIMEOUT_MS = 10_000; // a CONNECTING socket stuck this long is retried

type Listener = (data: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private retry = 0;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private wakeBound = false;
  private checking = false;
  connected = false;

  constructor(private url: string = defaultUrl()) {}

  connect() {
    this.closedByUser = false;
    this.bindWake();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.CONNECTING) this.drop(ws);
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.retry = 0;
      this.connected = true;
      this.startHeartbeat();
      this.fire("connect", null);
    };
    ws.onmessage = (e) => {
      let msg: { t: string; id?: number; ev?: string; data?: unknown };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.t === "res" && typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve(msg.data);
        }
      } else if (msg.t === "evt" && msg.ev) {
        this.fire(msg.ev, msg.data);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.handleLost(false);
    };
    ws.onerror = () => ws.close();
  }

  /** Socket is gone (closed, or declared dead by us): clean up, notify, maybe reconnect. */
  private handleLost(immediate: boolean) {
    const was = this.connected;
    this.connected = false;
    this.ws = null;
    this.stopHeartbeat();
    if (this.connectTimer) clearTimeout(this.connectTimer);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Connection lost"));
      this.pending.delete(id);
    }
    if (was) this.fire("disconnect", null);
    if (this.closedByUser) return;
    if (immediate) this.connect();
    else this.scheduleReconnect();
  }

  /** Abandon a socket we believe is dead (no heartbeat reply) and reconnect right away. */
  private drop(ws: WebSocket) {
    if (this.ws !== ws) return;
    try {
      ws.onclose = null;
      ws.close();
    } catch {
      /* already closing */
    }
    this.handleLost(true);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    // jittered exponential backoff: ~0.2 s first retry, then 0.5, 1, 2, 4, 8 s … capped at 10 s
    const n = this.retry++;
    const base = n === 0 ? 200 : Math.min(10_000, 500 * 2 ** (n - 1));
    const delay = base * (0.75 + Math.random() * 0.5);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      // hidden pages get their timers throttled; the wake check covers them on return
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void this.check(HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Round-trip a ping; if it doesn't come back in time the socket is half-open → reconnect. */
  private async check(timeoutMs: number) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.checking) return;
    this.checking = true;
    try {
      await this.request("ping", {}, timeoutMs);
    } catch {
      this.drop(ws);
    } finally {
      this.checking = false;
    }
  }

  /** Page back in the foreground / network back: reconnect now instead of waiting out the backoff. */
  wake() {
    if (this.closedByUser) return;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      this.retry = 0;
      if (ws) this.drop(ws);
      else this.connect();
      return;
    }
    if (ws.readyState === WebSocket.OPEN) void this.check(WAKE_PING_TIMEOUT_MS);
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible") this.wake();
  };
  private onWake = () => this.wake();

  private bindWake() {
    if (this.wakeBound || typeof window === "undefined") return;
    this.wakeBound = true;
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("online", this.onWake);
    window.addEventListener("pageshow", this.onWake);
    window.addEventListener("focus", this.onWake);
  }

  private unbindWake() {
    if (!this.wakeBound) return;
    this.wakeBound = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("online", this.onWake);
    window.removeEventListener("pageshow", this.onWake);
    window.removeEventListener("focus", this.onWake);
  }

  close() {
    this.closedByUser = true;
    this.unbindWake();
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  on(ev: string, fn: Listener) {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(fn);
  }

  off(ev: string, fn: Listener) {
    this.listeners.get(ev)?.delete(fn);
  }

  removeAllListeners() {
    this.listeners.clear();
  }

  /** Deliver an event to local listeners as if the server had pushed it (reconnect catch-up). */
  dispatch(ev: string, data: unknown) {
    this.fire(ev, data);
  }

  private fire(ev: string, data: unknown) {
    for (const fn of [...(this.listeners.get(ev) ?? [])]) {
      try {
        fn(data);
      } catch (err) {
        console.error(`[realtime] listener for ${ev} failed`, err);
      }
    }
  }

  /** fire-and-forget */
  emit(ev: string, data: unknown = {}) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "evt", ev, data }));
  }

  /** request/response; rejects on timeout or disconnect */
  request<T = unknown>(ev: string, data: unknown = {}, timeoutMs = 10_000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error("Not connected"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Request timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ t: "req", id, ev, data }));
    });
  }
}

function defaultUrl() {
  const override = process.env.NEXT_PUBLIC_WS_URL;
  if (override) return override;
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/ws`;
}
