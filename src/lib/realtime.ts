// Browser side of the raw-WebSocket realtime layer (see server/ws.ts for the protocol).
// Features: named events, request/response with timeouts, auto-reconnect with backoff.
// Uses wss:// automatically when the page is served over https:// (production/TLS).

type Listener = (data: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private retry = 0;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  connected = false;

  constructor(private url: string = defaultUrl()) {}

  connect() {
    this.closedByUser = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
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
      const was = this.connected;
      this.connected = false;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Connection lost"));
        this.pending.delete(id);
      }
      if (was) this.fire("disconnect", null);
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    const delay = Math.min(5000, 400 * 2 ** this.retry++) + Math.random() * 300;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
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
