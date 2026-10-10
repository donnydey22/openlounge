// Integration: real Postgres (TEST_DATABASE_URL, default local ol_hardening_test — DROPPED + recreated) and a real
// server process (needs `npm run build` first). Run: npm run test:hardening
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import pg from "pg";
import http from "node:http";
import WebSocket from "ws";
import { PgPersistence } from "../../server/pg";

const DB = process.env.TEST_DATABASE_URL || "postgresql://openlounge:openlounge@localhost:5432/ol_hardening_test";
const PORT = Number(process.env.HARDENING_PORT || 3191);
const BASE = `http://localhost:${PORT}`;
let srv: ChildProcess | null = null;

async function resetDb() {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await c.end();
}

function startServer(extraEnv: Record<string, string> = {}) {
  return new Promise<ChildProcess>((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), DATABASE_URL: DB, DATA_DIR: "/tmp/olh-it-data", WS_RATE_PER_SEC: "5", WS_RATE_BURST: "10", RL_AUTH_PER_MIN: "1000", LOG_LEVEL: "info", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (d: Buffer) => {
      out += d;
      if (out.includes('"msg":"ready"')) resolve(p);
    };
    p.stdout!.on("data", onData);
    p.stderr!.on("data", (d) => (out += d));
    p.on("exit", (code) => reject(new Error(`server exited ${code}: ${out.slice(-2000)}`)));
    setTimeout(() => reject(new Error("server start timeout: " + out.slice(-2000))), 60_000).unref();
  });
}
async function stopServer(p: ChildProcess | null) {
  if (!p || p.exitCode !== null) return;
  const done = new Promise((r) => p.once("exit", r));
  p.kill("SIGTERM");
  await done;
}

type Client = { ws: WebSocket; req: (ev: string, data?: unknown) => Promise<any>; events: { ev: string; data: any }[]; closed: Promise<{ code: number }> };
function connect(headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers });
    let id = 0;
    const pend = new Map<number, (d: unknown) => void>();
    const events: Client["events"] = [];
    const closed = new Promise<{ code: number }>((r) => ws.on("close", (code) => r({ code })));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === "res") pend.get(m.id)?.(m.data);
      else events.push({ ev: m.ev, data: m.data });
    });
    ws.on("open", () =>
      resolve({ ws, events, closed, req: (ev, data = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ t: "req", id: i, ev, data })); }) }),
    );
    ws.on("error", reject);
    ws.on("unexpected-response", (_r, res) => reject(new Error("HTTP " + res.statusCode)));
  });
}
async function signup(phone: string, username: string) {
  const c = await connect();
  await c.req("auth:requestCode", { phone });
  const v = await c.req("auth:verifyCode", { phone, code: "000000" });
  const r = await c.req("auth:register", { ticket: v.ticket, firstName: "T", lastName: username, username, bio: "", color: "#64748B", interests: [] });
  assert.ok(r.ok, JSON.stringify(r));
  return { c, user: r.user, access: r.access, refresh: r.refresh };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

before(async () => {
  await resetDb();
});
after(async () => {
  await stopServer(srv);
});

test("migrations: concurrent boots are safe (advisory lock) and re-running is a no-op", async () => {
  const a = new PgPersistence(DB);
  const b = new PgPersistence(DB);
  await Promise.all([a.connectAndMigrate(), b.connectAndMigrate()]);
  await a.connectAndMigrate();
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  const v = (await c.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version);
  assert.ok(v.includes("008_hardening.sql"));
  assert.equal(new Set(v).size, v.length);
  const idx = (await c.query("SELECT indexname FROM pg_indexes WHERE schemaname='public'")).rows.map((r) => r.indexname);
  for (const i of ["dms_client_idx", "dms_conversation_desc_idx", "rooms_created_idx", "sessions_user_seen_idx", "dm_reads_peer_idx"]) assert.ok(idx.includes(i), i);
  const st = (await a.ping()).ok;
  assert.ok(st);
  await c.end();
  await a.close();
  await b.close();
});

test("server: healthz / readyz / headers / www redirect / metrics auth", async () => {
  srv = await startServer({ METRICS_TOKEN: "t0k" });
  const h = await fetch(`${BASE}/healthz`);
  assert.equal(h.status, 200);
  const r = await fetch(`${BASE}/readyz`);
  const rj = await r.json();
  assert.equal(r.status, 200);
  assert.equal(rj.db.ok, true);
  const home = await fetch(`${BASE}/`);
  assert.ok(home.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
  assert.equal(home.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
  assert.ok(home.headers.get("x-request-id"));
  // fetch can't override Host; use node:http
  const w = await new Promise<{ status?: number; location?: string }>((resolve) =>
    http.get({ host: "localhost", port: PORT, path: "/settings", headers: { host: "www.openlounge.app" } }, (res) => (res.resume(), resolve({ status: res.statusCode, location: res.headers.location }))),
  );
  assert.equal(w.status, 308);
  assert.equal(w.location, "https://openlounge.app/settings");
  assert.equal((await fetch(`${BASE}/metrics`)).status, 404);
  const m = await fetch(`${BASE}/metrics`, { headers: { authorization: "Bearer t0k" } });
  assert.match(await m.text(), /openlounge_http_requests_total \d+/);
});

test("http: body limit 413, bad JSON 400, CORS foreign origin 403, allowed origin echoed", async () => {
  const big = await fetch(`${BASE}/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: "x".repeat(20_000) }) });
  assert.equal(big.status, 413);
  const bad = await fetch(`${BASE}/auth/refresh`, { method: "POST", body: "{nope" });
  assert.equal(bad.status, 400);
  const evil = await fetch(`${BASE}/auth/refresh`, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
  assert.equal(evil.status, 403);
  const ok = await fetch(`${BASE}/auth/validate`, { headers: { origin: "https://openlounge.app" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://openlounge.app");
});

test("ws: schema validation, oversize frames, rate limit, foreign-origin upgrade refused", async () => {
  const c = await connect();
  const inv = await c.req("dm:send", { to: 123, text: "x" });
  assert.equal(inv.reason, "invalid");
  const big = await c.req("chat:send", { roomId: "abc", text: "x".repeat(20_000) });
  assert.equal(big.reason, "too_large");
  const res = await Promise.all(Array.from({ length: 30 }, () => c.req("ping")));
  assert.ok(res.some((r) => r.reason === "rate_limited"), "expected some rate-limited");
  assert.ok(res.some((r) => r.ok === true));
  c.ws.close();
  await assert.rejects(connect({ origin: "https://evil.example" }), /403/);
});

test("dm:send ack is durable and idempotency survives an abrupt server restart", async () => {
  const a = await signup("+15550001001", "alice_it");
  const b = await signup("+15550001002", "bob_it");
  const m1 = await a.c.req("dm:send", { to: b.user.id, text: "hello", clientId: "cid-123" });
  assert.ok(m1.ok);
  a.c.ws.close();
  b.c.ws.close();
  // SIGKILL bypasses the normal shutdown flush. If the positive ack arrived, the transaction must already be durable.
  const crashed = srv!;
  const exited = new Promise<void>((resolve) => crashed.once("exit", () => resolve()));
  crashed.kill("SIGKILL");
  await exited;
  srv = await startServer();
  const c = await connect();
  const resumed = await c.req("session:resume", { token: a.refresh });
  assert.ok(resumed.ok, JSON.stringify(resumed));
  const m3 = await c.req("dm:send", { to: b.user.id, text: "hello", clientId: "cid-123" });
  assert.equal(m3.message.id, m1.message.id);
  const h = await c.req("dm:history", { peerId: b.user.id });
  assert.equal(h.messages.filter((m: { text: string }) => m.text === "hello").length, 1);
  c.ws.close();
});

test("dm retry delivers one durable message after a simulated lost acknowledgment", async () => {
  const a = await signup("+15550001011", "lossy_alice");
  const b = await signup("+15550001012", "lossy_bob");
  const lossy = await connect();
  assert.ok((await lossy.req("session:resume", { token: a.refresh })).ok);
  const clientId = "simulated-loss-ack";
  // Send a valid request but deliberately never attach a pending response handler: the server's ack is ignored,
  // exactly like a radio handoff that drops the return frame after the request was delivered.
  lossy.ws.send(JSON.stringify({ t: "req", id: 97, ev: "dm:send", data: { to: b.user.id, text: "one resilient message", clientId } }));
  await waitFor(() => b.c.events.some((e) => e.ev === "dm:message" && e.data.text === "one resilient message"), "recipient delivery before simulated link loss");
  lossy.ws.terminate();
  await lossy.closed;

  const retry = await connect();
  assert.ok((await retry.req("session:resume", { token: a.refresh })).ok);
  const recovered = await retry.req("dm:send", { to: b.user.id, text: "one resilient message", clientId });
  assert.ok(recovered.ok);
  const history = await retry.req("dm:history", { peerId: b.user.id });
  assert.equal(history.messages.filter((m: { text: string }) => m.text === "one resilient message").length, 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(b.c.events.filter((e) => e.ev === "dm:message" && e.data.text === "one resilient message").length, 1);
  retry.ws.close();
  a.c.ws.close();
  b.c.ws.close();
});

test("DM replies retain a server-authored parent snapshot and only the author can edit", async () => {
  const a = await signup("+15550001021", "reply_alice");
  const b = await signup("+15550001022", "reply_bob");
  const root = await a.c.req("dm:send", { to: b.user.id, text: "original thought", clientId: "reply-root" });
  assert.ok(root.ok);
  const reply = await b.c.req("dm:send", { to: a.user.id, text: "following up", clientId: "reply-child", replyToId: root.message.id });
  assert.deepEqual(reply.message.replyTo, { id: root.message.id, authorName: root.message.fromName, text: "original thought" });
  const forbidden = await b.c.req("dm:edit", { peerId: a.user.id, messageId: root.message.id, text: "not allowed" });
  assert.equal(forbidden.ok, false);
  const edited = await a.c.req("dm:edit", { peerId: b.user.id, messageId: root.message.id, text: "edited thought" });
  assert.ok(edited.ok);
  assert.equal(edited.message.text, "edited thought");
  const history = await a.c.req("dm:history", { peerId: b.user.id });
  assert.equal(history.messages.find((m: { id: string }) => m.id === root.message.id).text, "edited thought");
  assert.deepEqual(history.messages.find((m: { id: string }) => m.id === reply.message.id).replyTo, reply.message.replyTo);
  a.c.ws.close();
  b.c.ws.close();
});

test("room chat replies and author edits broadcast without granting edits to other participants", async () => {
  const a = await signup("+15550001031", "room_alice");
  const b = await signup("+15550001032", "room_bob");
  const created = await a.c.req("room:create", { title: "Reply test", topic: "Tech" });
  assert.ok(created.ok);
  assert.ok((await a.c.req("room:join", { roomId: created.roomId })).ok);
  assert.ok((await b.c.req("room:join", { roomId: created.roomId })).ok);
  const root = await a.c.req("chat:send", { roomId: created.roomId, text: "room root" });
  assert.ok(root.ok);
  const reply = await b.c.req("chat:send", { roomId: created.roomId, text: "room reply", replyToId: root.message.id });
  assert.deepEqual(reply.message.replyTo, { id: root.message.id, authorName: root.message.authorName, text: "room root" });
  const forbidden = await b.c.req("chat:edit", { roomId: created.roomId, messageId: root.message.id, text: "not allowed" });
  assert.equal(forbidden.ok, false);
  const edited = await a.c.req("chat:edit", { roomId: created.roomId, messageId: root.message.id, text: "room root edited" });
  assert.ok(edited.ok);
  await waitFor(() => b.c.events.some((e) => e.ev === "chat:updated" && e.data.id === root.message.id && e.data.text === "room root edited"), "room edit broadcast");
  a.c.ws.close();
  b.c.ws.close();
});

test("graceful shutdown: sockets get close code 1012, readyz flips, process exits 0", async () => {
  const c1 = await connect();
  const c2 = await connect();
  const exited = new Promise<number | null>((r) => srv!.once("exit", (code) => r(code)));
  srv!.kill("SIGTERM");
  const [a, b] = await Promise.all([c1.closed, c2.closed]);
  assert.equal(a.code, 1012);
  assert.equal(b.code, 1012);
  assert.equal(await exited, 0);
  srv = null;
});
