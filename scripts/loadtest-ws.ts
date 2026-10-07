// WebSocket load test: N concurrent authenticated sockets, DM fanout latency (send → recipient's dm:message).
//   BASE=http://localhost:3107 SOCKETS=500 ROUNDS=6 npm run loadtest:ws
// Creates SOCKETS demo accounts (demo OTP 000000) — run against a local/staging server only, never production.
import WebSocket from "ws";
import { performance } from "node:perf_hooks";

const BASE = process.env.BASE || "http://localhost:3107";
const N = Number(process.env.SOCKETS || 500);
const ROUNDS = Number(process.env.ROUNDS || 6);
const GAP_MS = Number(process.env.GAP_MS || 1500);
const tag = Date.now().toString(36).slice(-5);

type C = { ws: WebSocket; req: (ev: string, data?: unknown) => Promise<any>; on: (ev: string, fn: (d: any) => void) => void };
function connect(): Promise<C> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws");
    let id = 0;
    const pend = new Map<number, (d: unknown) => void>();
    const ls = new Map<string, (d: any) => void>();
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === "res") (pend.get(m.id)?.(m.data), pend.delete(m.id));
      else ls.get(m.ev)?.(m.data);
    });
    ws.on("open", () => resolve({ ws, on: (e, f) => ls.set(e, f), req: (ev, data = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ t: "req", id: i, ev, data })); }) }));
    ws.on("error", reject);
  });
}
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2) : NaN; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pool<T>(n: number, conc: number, fn: (i: number) => Promise<T>) {
  const out: T[] = new Array(n);
  let next = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (next < n) { const i = next++; out[i] = await fn(i); } }));
  return out;
}

async function main() {
  console.log(`[load] ${BASE}: ${N} sockets, ${ROUNDS} rounds of ${N / 2} DMs`);
  // 1) sign up N accounts (each on its own socket, which stays open as the user's connection)
  const t0 = performance.now();
  const connectMs: number[] = [];
  const clients = await pool(N, 50, async (i) => {
    const a = performance.now();
    const c = await connect();
    connectMs.push(performance.now() - a);
    const phone = `+1999${tag.replace(/\D/g, "").padEnd(3, "7").slice(0, 3)}${String(i).padStart(4, "0")}`;
    await c.req("auth:requestCode", { phone });
    const v = await c.req("auth:verifyCode", { phone, code: "000000" });
    const r = v.status === "new" ? await c.req("auth:register", { ticket: v.ticket, firstName: "Load", lastName: `${i}`, username: `ld${tag}${i}`, bio: "", color: "#64748B", interests: [] }) : v;
    if (!r.ok) throw new Error("signup failed: " + JSON.stringify(r));
    return { c, userId: r.user.id as string };
  });
  console.log(`[load] ${N} sockets connected + authenticated in ${((performance.now() - t0) / 1000).toFixed(1)}s (connect p50 ${pct(connectMs, 50)}ms p95 ${pct(connectMs, 95)}ms)`);

  // 2) DM fanout: pair i ↔ i+N/2; every round all senders fire at once
  const lat: number[] = [];
  const ack: number[] = [];
  const pending = new Map<string, number>();
  let errors = 0;
  const half = N / 2;
  for (let r = 0; r < ROUNDS; r++) {
    const t = performance.now();
    await Promise.all(
      clients.slice(0, half).map(async ({ c }, i) => {
        const key = `load ${r}-${i}`;
        const to = clients[i + half];
        // only the recipient's message counts (sender also gets an echo for its other devices)
        to.c.on("dm:message", (m) => {
          if (m.text !== key) return;
          const s = pending.get(key);
          if (s !== undefined) (lat.push(performance.now() - s), pending.delete(key));
        });
        pending.set(key, performance.now());
        const a = performance.now();
        const res = await c.req("dm:send", { to: to.userId, text: key, clientId: `ld-${tag}-${r}-${i}` });
        ack.push(performance.now() - a);
        if (!res.ok) errors++;
      }),
    );
    await sleep(Math.max(0, GAP_MS - (performance.now() - t)));
  }
  await sleep(1000);
  const sent = ROUNDS * half;
  const res = {
    sockets: N,
    dmsSent: sent,
    delivered: lat.length,
    lost: pending.size,
    errors,
    fanoutMs: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: pct(lat, 100) },
    ackMs: { p50: pct(ack, 50), p95: pct(ack, 95), p99: pct(ack, 99) },
    connectMs: { p50: pct(connectMs, 50), p95: pct(connectMs, 95) },
    rssNote: "see server /metrics",
  };
  console.log(JSON.stringify(res, null, 1));
  for (const { c } of clients) c.ws.close();
  process.exit(0);
}
main().catch((e) => (console.error(e), process.exit(1)));
