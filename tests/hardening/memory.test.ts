// Memory / leak check: 50 room join/leave cycles and 50 connect/disconnect cycles against a real server process.
// Asserts room membership, WS channels/connections return to baseline and heap growth stays bounded.
// Needs Postgres + `npm run build`. Run: node --import tsx --test tests/hardening/memory.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import pg from "pg";
import WebSocket from "ws";

const DB = process.env.TEST_DATABASE_URL || "postgresql://openlounge:openlounge@localhost:5432/ol_hardening_test";
const PORT = 3193;
let srv: ChildProcess | null = null;

async function ensureDb() {
  const u = new URL(DB);
  const name = u.pathname.slice(1);
  u.pathname = "/postgres";
  const a = new pg.Client({ connectionString: u.toString() });
  await a.connect();
  const ex = await a.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]);
  if (!ex.rowCount) throw new Error(`test database ${name} missing (set TEST_DATABASE_URL)`);
  await a.end();
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await c.end();
}
function start() {
  return new Promise<ChildProcess>((resolve, reject) => {
    const p = spawn(process.execPath, ["--expose-gc", "--import", "tsx", "server/index.ts"], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), DATABASE_URL: DB, DATA_DIR: `${process.env.TMPDIR || "/tmp"}/olm-data`, METRICS_TOKEN: "m", RL_AUTH_PER_MIN: "10000", WS_RATE_PER_SEC: "200", WS_RATE_BURST: "400", LOG_LEVEL: "info" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const on = (d: Buffer) => { out += d; if (out.includes('"msg":"ready"')) resolve(p); };
    p.stdout!.on("data", on);
    p.stderr!.on("data", on);
    p.on("exit", (c) => reject(new Error(`exit ${c}: ${out.slice(-1500)}`)));
    setTimeout(() => reject(new Error("timeout " + out.slice(-1500))), 60_000).unref();
  });
}
type C = { ws: WebSocket; req: (ev: string, d?: unknown) => Promise<any> };
function connect(): Promise<C> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    let id = 0;
    const pend = new Map<number, (d: unknown) => void>();
    ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.t === "res") pend.get(m.id)?.(m.data); });
    ws.on("open", () => resolve({ ws, req: (ev, d = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ t: "req", id: i, ev, data: d })); }) }));
    ws.on("error", reject);
  });
}
async function signup(phone: string, username: string) {
  const c = await connect();
  await c.req("auth:requestCode", { phone });
  const v = await c.req("auth:verifyCode", { phone, code: "000000" });
  const r = await c.req("auth:register", { ticket: v.ticket, firstName: "M", lastName: username, username, bio: "", color: "#64748B", interests: [] });
  assert.ok(r.ok, JSON.stringify(r));
  return { c, access: r.access as string, user: r.user };
}
async function metrics() {
  const t = await (await fetch(`http://localhost:${PORT}/metrics`, { headers: { authorization: "Bearer m" } })).text();
  const g = (n: string) => Number(t.match(new RegExp(`openlounge_${n} (\\d+)`))?.[1] ?? NaN);
  return { conns: g("ws_connections"), channels: g("ws_channels"), heap: g("process_heap_used_bytes") };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

after(() => srv?.kill("SIGTERM"));

test("room join/leave x50 + connect/disconnect x50: no leaked membership, channels, sockets; bounded heap", { timeout: 180_000 }, async () => {
  await ensureDb();
  srv = await start();
  const host = await signup("+15550001001", "memhost");
  const room = await host.c.req("room:create", { title: "Leak check", topic: "Tech" });
  assert.ok(room.ok, JSON.stringify(room));
  const guest = await signup("+15550001002", "memguest");
  // warm-up so lazy caches/JIT don't count as growth
  for (let i = 0; i < 5; i++) { await guest.c.req("room:join", { roomId: room.roomId }); await guest.c.req("room:leave", { roomId: room.roomId }); }
  await sleep(300);
  const base = await metrics();
  for (let i = 0; i < 50; i++) {
    const j = await guest.c.req("room:join", { roomId: room.roomId });
    assert.ok(j.ok, JSON.stringify(j));
    assert.ok(j.room.participants.some((p: any) => p.userId === guest.user.id));
    assert.ok((await guest.c.req("room:leave", { roomId: room.roomId })).ok);
  }
  // 50 short-lived sockets that join the room then drop without leaving (tab closed / network loss)
  for (let i = 0; i < 50; i++) {
    const c = await connect();
    const r = await c.req("session:resume", { token: guest.access });
    assert.ok(r?.ok, JSON.stringify(r));
    await c.req("room:join", { roomId: room.roomId });
    c.ws.terminate();
  }
  await sleep(1500);
  const state = await host.c.req("room:join", { roomId: room.roomId });
  const guestStill = state.room.participants.filter((p: any) => p.userId === guest.user.id);
  // dropped sockets keep ONE seat in the 45 s away-grace (by design, store.markAway); 50 drops must never stack seats
  assert.ok(guestStill.length <= 1, `guest seated ${guestStill.length}x`);
  if (guestStill.length) assert.equal(guestStill[0].socketId ?? null, null);
  const end = await metrics();
  assert.equal(end.conns, base.conns, `ws connections ${base.conns} → ${end.conns}`);
  assert.ok(end.channels <= base.channels + 1, `ws channels ${base.channels} → ${end.channels}`);
  const growMb = (end.heap - base.heap) / 1048576;
  console.log(`[memory] heap ${(base.heap / 1048576).toFixed(1)} MB → ${(end.heap / 1048576).toFixed(1)} MB (Δ ${growMb.toFixed(2)} MB), channels ${base.channels}→${end.channels}, conns ${base.conns}→${end.conns}`);
  assert.ok(growMb < 15, `heap grew ${growMb.toFixed(1)} MB over 100 cycles`);
});
