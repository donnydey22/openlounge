import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clearOfflineMe, offlineMeId, readOfflineMe, saveOfflineMe } from "../../src/lib/chat/offlineSession";
import { addPending, clearAllPending, failPending, flushPending, pendingFor, readPending, removePending, unfailPending } from "../../src/lib/chat/pendingSends";

class KV {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}
const P = (cid: string, to = "u2", at = 1) => ({ clientId: cid, to, text: `hi ${cid}`, createdAt: at, fromId: "u1" });

test("offline launch snapshot opens only for the same account", () => {
  const kv = new KV();
  saveOfflineMe({ id: "u1", name: "Donny" }, ["u3"], 4, kv);
  assert.equal(readOfflineMe<{ id: string; name: string }>("u1", kv)?.me.name, "Donny");
  assert.equal(readOfflineMe("u1", kv)?.unreadDms, 4);
  assert.equal(offlineMeId(kv), "u1");
});

test("offline snapshot never shown to another account (switch) and wiped", () => {
  const kv = new KV();
  saveOfflineMe({ id: "u1" }, [], 0, kv);
  assert.equal(readOfflineMe("u9", kv), null);
  assert.equal(offlineMeId(kv), "u1", "kept for the caller's account-switch wipe");
  saveOfflineMe({ id: "u1" }, [], 0, kv);
  assert.equal(readOfflineMe(null, kv), null);
  saveOfflineMe({ id: "u1" }, [], 0, kv);
  clearOfflineMe(kv);
  assert.equal(readOfflineMe("u1", kv), null);
});

test("offline send queue survives restart, dedupes by clientId, per user", () => {
  const kv = new KV();
  addPending("u1", P("a"), kv);
  addPending("u1", P("a"), kv);
  addPending("u1", P("b", "g_x", 2), kv);
  assert.equal(readPending("u1", kv).length, 2);
  assert.equal(pendingFor("u1", "g_x", kv).length, 1);
  assert.equal(readPending("u2", kv).length, 0, "another account sees nothing");
  removePending("u1", "a", kv);
  assert.deepEqual(readPending("u1", kv).map((p) => p.clientId), ["b"]);
});

test("offline queue flush on reconnect: in order, stops when offline, failed kept for retry", async () => {
  const kv = new KV();
  addPending("u1", P("c", "u2", 3), kv);
  addPending("u1", P("a", "u2", 1), kv);
  addPending("u1", P("b", "u2", 2), kv);
  const sent: string[] = [];
  const transient = (e: unknown) => (e as Error).message === "net";
  let n = await flushPending("u1", async (p) => { if (p.clientId === "b") throw new Error("net"); sent.push(p.clientId); }, transient, kv);
  assert.equal(n, 1);
  assert.deepEqual(sent, ["a"]);
  assert.deepEqual(readPending("u1", kv).map((p) => p.clientId).sort(), ["b", "c"]);
  n = await flushPending("u1", async (p) => { if (p.clientId === "b") throw new Error("Blocked"); sent.push(p.clientId); }, transient, kv);
  assert.equal(n, 1);
  assert.deepEqual(sent, ["a", "c"]);
  assert.equal(readPending("u1", kv)[0].failed, true);
  n = await flushPending("u1", async () => { sent.push("x"); }, transient, kv);
  assert.equal(n, 0, "failed items are not auto-resent");
  unfailPending("u1", "b", kv);
  n = await flushPending("u1", async (p) => { sent.push(p.clientId); }, transient, kv);
  assert.equal(n, 1);
  assert.equal(readPending("u1", kv).length, 0);
  addPending("u1", P("d"), kv);
  failPending("u1", "d", kv);
  assert.equal(readPending("u1", kv)[0].failed, true);
});

test("logout clears every account's offline queue", () => {
  const kv = new KV();
  addPending("u1", P("a"), kv);
  addPending("u7", { ...P("z"), fromId: "u7" }, kv);
  kv.setItem("other", "keep");
  clearAllPending(kv);
  assert.equal(kv.length, 1);
});

test("offline inbox wiring: cache read/write-through, per-user wipe, snapshot bound to uid", () => {
  const app = readFileSync("src/components/AppProvider.tsx", "utf8");
  const drop = app.slice(app.indexOf("const dropSession"), app.indexOf("const dropSession") + 600);
  for (const k of ["wipeChatCache()", "clearOfflineMe()", "clearAllPending()"]) assert.ok(drop.includes(k), `sign-out wipes ${k}`);
  assert.match(app, /readOfflineMe<Me>\(c\.uid\)/);
  assert.match(app, /cachedId !== c\.uid\) \{\s*void wipeChatCache\(\);\s*clearAllPending\(\);\s*clearOfflineMe\(\);/);
  assert.match(app, /prev !== s\.user\.id\)\s*\{\s*void wipeChatCache\(\);\s*clearAllPending\(\);/);
  const inbox = readFileSync("src/app/messages/page.tsx", "utf8");
  assert.match(inbox, /readInbox<ConversationSummary>\(meId\)/);
  assert.match(inbox, /writeInbox\(meId, conversations\)/);
  assert.match(inbox, /<NetworkStatus \/>/);
  const groups = readFileSync("src/components/groups/GroupBits.tsx", "utf8");
  assert.match(groups, /readInbox<GroupRowItem>\(`\$\{meId\}#groups`\)/);
  const th = readFileSync("src/components/chat/DmThread.tsx", "utf8");
  assert.match(th, /addPending\(me\.id/);
  assert.match(th, /removePending\(me\.id, item\.clientId\)/);
  assert.match(th, /pendingFor\(me\.id, peerId\)/);
});

test("app shell SW: pages network-first (fresh online), cached copy offline, API untouched", async () => {
  const vm = await import("node:vm");
  const store = new Map<string, Map<string, unknown>>();
  const caches = {
    open: async (n: string) => { if (!store.has(n)) store.set(n, new Map()); const m = store.get(n)!; return { put: async (k: any, v: unknown) => void m.set(typeof k === "string" ? k : k.url, v), match: async (k: any) => m.get(typeof k === "string" ? k : k.url), keys: async () => [...m.keys()], delete: async (k: string) => m.delete(k) }; },
    keys: async () => [...store.keys()],
    delete: async (k: string) => store.delete(k),
  };
  let online = true;
  let fetches = 0;
  const fetch = async (r: any) => { fetches++; if (!online) throw new TypeError("offline"); return { ok: true, type: "basic", redirected: false, body: `fresh ${r.url} ${fetches}`, clone() { return { ...this }; } }; };
  const handlers: Record<string, (e: any) => void> = {};
  const self = { addEventListener: (t: string, f: any) => (handlers[t] = f), location: { origin: "https://ol.test" }, clients: { claim: async () => {} }, registration: {} };
  vm.runInNewContext(readFileSync("public/sw.js", "utf8"), { self, caches, fetch, URL, Date, console, setInterval, clearInterval, Promise });
  const go = async (url: string, mode = "navigate"): Promise<any> => {
    let resp: Promise<any> | null = null; const waits: Promise<unknown>[] = [];
    handlers.fetch({ request: { url, method: "GET", mode }, respondWith: (p: Promise<any>) => (resp = p), waitUntil: (p: Promise<unknown>) => waits.push(p) });
    const r: any = resp ? await resp : null; await Promise.all(waits); return r as any;
  };
  const a = await go("https://ol.test/messages");
  assert.match(a.body, /fresh .*messages 1/);
  online = false;
  assert.match((await go("https://ol.test/messages")).body, /messages 1/, "offline: last copy");
  assert.match((await go("https://ol.test/messages/u_unseen")).body, /messages 1/, "unseen chat offline → inbox shell");
  online = true;
  assert.match((await go("https://ol.test/messages")).body, /fresh .*messages 4/, "online: always network");
  assert.equal(await go("https://ol.test/api/me", "cors"), null, "API not intercepted");
  assert.equal(await go("https://other.test/messages"), null, "cross-origin not intercepted");
});
