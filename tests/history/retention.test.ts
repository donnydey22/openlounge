// Retention: a conversation over 1000 messages keeps every message in memory and Postgres when new messages arrive
// (the old cap spliced the oldest out and the snapshot diff DELETEd them). Local Postgres only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "./env";
import { setTestEnv, startApp, wipeDb, phoneLogin, sql, type App } from "../unified-auth/harness";

setTestEnv({ providers: false });
let app: App;
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const N = 1500;

before(async () => {
  await wipeDb();
  app = await startApp();
});
after(async () => {
  await app?.close();
});

test("1:1 over 1000 messages: nothing is trimmed from memory or deleted from Postgres on a new send", async () => {
  const { store } = await import("../../server/store");
  const u = () => Math.random().toString(36).slice(2, 8);
  const A = await phoneLogin(app.wsUrl, phone(), { firstName: "Ana", username: `ana_${u()}` });
  const B = await phoneLogin(app.wsUrl, phone(), { firstName: "Ben", username: `ben_${u()}` });
  const a = A.res.user.id as string, b = B.res.user.id as string;
  const key = [a, b].sort().join("|");
  const t0 = Date.now() - N * 1000 - 60_000;
  const list = [];
  for (let i = 1; i <= N; i++) {
    const from = i % 2 ? a : b;
    list.push({ id: `seed-${String(i).padStart(6, "0")}`, fromId: from, fromName: "x", fromColor: "#888", toId: from === a ? b : a, text: `#${i}`, createdAt: t0 + i * 1000, readAt: t0 + i * 1000 });
  }
  store.dms.set(key, list as never);
  store.saveSoon();
  await store.flush();
  const r = await A.client.req("dm:send", { to: b, text: "new", clientId: "ret-1" });
  assert.equal(r.ok, true, JSON.stringify(r));
  await store.flush();
  assert.equal(store.dms.get(key)!.length, N + 1);
  const [row] = await sql<{ n: string }>("SELECT count(*)::text AS n FROM dms WHERE conversation_id = $1", [key]);
  assert.equal(Number(row.n), N + 1);
  const [first] = await sql<{ text: string }>("SELECT text FROM dms WHERE conversation_id = $1 ORDER BY created_at, id LIMIT 1", [key]);
  assert.equal(first.text, "#1");
  A.client.close();
  B.client.close();
});
