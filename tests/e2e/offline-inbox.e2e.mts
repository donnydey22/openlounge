// Offline inbox E2E (Playwright): offline open, offline send queue, reconnect sync (no dupes), account switch.
// Usage: BASE=http://127.0.0.1:3380 node --import tsx tests/e2e/offline-inbox.e2e.mts  [ENGINES=chrome,webview,webkit]
const pw = (await import("playwright")).default;
import { phoneLogin } from "../unified-auth/harness";
import net from "node:net";
// WebKit (Playwright) can't serve a SW navigation under ctx.setOffline, so there "no signal" = the server becomes
// unreachable through this local proxy (connections refused / cut), which is what a phone with no data sees.
function proxy(listen: number, target: number) {
  let black = false; const socks = new Set<net.Socket>();
  const srv = net.createServer((c) => { if (black) return c.destroy(); const t = net.connect(target, "127.0.0.1"); socks.add(c); socks.add(t); c.pipe(t); t.pipe(c); const end = () => { c.destroy(); t.destroy(); socks.delete(c); socks.delete(t); }; c.on("error", end); t.on("error", end); c.on("close", end); t.on("close", end); }).listen(listen, "127.0.0.1");
  return { set: (on: boolean) => { black = on; if (on) for (const x of socks) x.destroy(); }, close: () => srv.close() };
}
const BASE = process.env.BASE || "http://127.0.0.1:3380";
const WS = BASE.replace(/^http/, "ws") + "/ws";
const SHOTS = process.env.SHOTS || "/workspace/evidence/offline-inbox";
const ENGINES = (process.env.ENGINES || "chrome,webview,webkit").split(",");
const sleep = (m: number) => new Promise((x) => setTimeout(x, m));
const ph = () => `+1555${Math.floor(Math.random() * 9e6 + 1e6)}`;
const rnd = () => Math.random().toString(36).slice(2, 7);
const results: { engine: string; check: string; pass: boolean; note?: string }[] = [];

async function send(c: any, data: any) { for (let i = 0; i < 20; i++) { const r = await c.req("dm:send", data); if (r.ok) return r; if (!/Slow down/.test(r.error)) throw new Error(JSON.stringify(r)); await sleep(1500); } throw new Error("rate"); }
async function seed() {
  const U = await phoneLogin(WS, ph(), { firstName: "Donny", username: "donny_" + rnd() });
  const P = await phoneLogin(WS, ph(), { firstName: "Sky", username: "sky_" + rnd() });
  const Q = await phoneLogin(WS, ph(), { firstName: "Other", username: "other_" + rnd() });
  const uid = U.res.user.id, pid = P.res.user.id;
  for (let i = 1; i <= 24; i++) { const [a, to] = i % 2 ? [P, uid] : [U, pid]; await send(a.client, { to, text: `hist ${String(i).padStart(2, "0")}`, clientId: `h${i}${rnd()}` }); }
  await sleep(1500);
  const d = await send(U.client, { to: pid, text: "to be deleted", clientId: "del" + rnd() });
  if (!d.ok) throw new Error("seed send " + JSON.stringify(d));
  const del = await U.client.req("dm:delete", { peerId: pid, messageIds: [d.message.id], forEveryone: true });
  if (!del.ok) throw new Error("seed delete " + JSON.stringify(del));
  await send(P.client, { to: uid, text: "last from Sky", clientId: "l" + rnd() });
  const cred = (x: any) => ({ refresh: x.res.refresh ?? x.res.token, access: x.res.access, uid: x.res.user.id });
  return { U: cred(U), Q: cred(Q), P, pid, uid, close: () => { U.client.close(); Q.client.close(); } };
}

const setCreds = (u: any) => { localStorage.setItem("openlounge:session", u.refresh); localStorage.setItem("openlounge:access", JSON.stringify({ t: u.access, exp: Date.now() + 3e6 })); localStorage.setItem("openlounge:uid", u.uid); localStorage.setItem("openlounge:saved", String(Date.now())); sessionStorage.clear(); };

const br = { chromium: await pw.chromium.launch(), webkit: ENGINES.includes("webkit") ? await pw.webkit.launch() : null };
for (const engine of ENGINES) {
  const s = await seed();
  const ok = (check: string, pass: boolean, note?: string) => { results.push({ engine, check, pass, note }); console.log(`${pass ? "PASS" : "FAIL"} [${engine}] ${check}${note ? " — " + note : ""}`); };
  const AND = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36";
  const dev = engine === "webkit"
    ? { ...pw.devices["iPhone 13"], userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1" }
    : engine === "webview"
      ? { ...pw.devices["Pixel 7"], userAgent: AND.replace("Pixel 7)", "Pixel 7; wv)").replace("Chrome/", "Version/4.0 Chrome/") + " OpenLoungeAndroid/0.3.19" }
      : { ...pw.devices["Pixel 7"], userAgent: AND };
  const b = engine === "webkit" ? br.webkit! : br.chromium;
  const ctx = await b.newContext({ ...dev, serviceWorkers: "allow" });
  await ctx.addInitScript((u: any) => { if (localStorage.getItem("openlounge:uid")) return; localStorage.setItem("openlounge:session", u.refresh); localStorage.setItem("openlounge:access", JSON.stringify({ t: u.access, exp: Date.now() + 3e6 })); localStorage.setItem("openlounge:uid", u.uid); localStorage.setItem("openlounge:saved", String(Date.now())); }, s.U);
  const px = engine === "webkit" ? proxy(3389, Number(new URL(BASE).port)) : null;
  const B = px ? "http://127.0.0.1:3389" : BASE;
  const setOffline = async (off: boolean) => (px ? px.set(off) : ctx.setOffline(off));
  const page = await ctx.newPage();
  const row = () => page.locator("[data-testid=dm-row]").filter({ hasText: "Sky" }).first();
  try {
    // warm: online visit inbox + chat (fills IndexedDB + SW shell)
    await page.goto(`${B}/messages`);
    await row().waitFor({ timeout: 60000 });
    await page.evaluate(() => navigator.serviceWorker?.ready.then(() => true));
    await page.goto(`${B}/messages`); // now controlled by the SW → page copy cached
    await row().waitFor({ timeout: 60000 });
    await row().click();
    await page.getByText("last from Sky").first().waitFor({ timeout: 30000 });
    ok("online: deleted placeholder shown (baseline)", await page.getByTestId("msg-deleted-placeholder").last().waitFor({ state: "attached", timeout: 8000 }).then(() => true, () => false));
    await sleep(800);
    await page.goto(`${B}/messages`);
    await row().waitFor({ timeout: 30000 });
    await sleep(1200); // write-through debounce
    const warmUrl = page.url();

    // 1. offline cold open
    await setOffline(true);
    let opened = true;
    try { await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }); } catch { opened = false; }
    const rowOk = opened && (await row().waitFor({ timeout: 15000 }).then(() => true, () => false));
    ok("offline open: inbox shows cached chats", rowOk, opened ? undefined : "page did not load offline");
    const lastOk = rowOk && (await row().innerText()).includes("last from Sky");
    ok("offline open: last message + time on row", lastOk);
    const ind = await page.getByTestId("network-status").waitFor({ timeout: 5000 }).then(() => page.getByTestId("network-status").innerText(), () => "");
    ok("offline indicator shown", /Waiting for network|Connecting/.test(ind), ind);
    if (engine !== "webview") await page.screenshot({ path: `${SHOTS}/${engine}-1-offline-inbox.png` });

    // 2. open cached chat offline, history + deleted placeholder
    if (rowOk) await row().click();
    const histOk = await page.getByText("last from Sky").first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    ok("offline: cached chat opens with history", histOk);
    const phOk = await page.getByText("This message was deleted").first().waitFor({ timeout: 5000 }).then(() => true, () => false);
    ok("offline: deleted placeholder kept", phOk);
    if (!phOk && process.env.DEBUG) { console.log("DBG texts", JSON.stringify((await page.locator("[data-testid=dm-thread] , main").first().innerText()).slice(-600))); console.log("DBG idb", await page.evaluate(async () => { const db: IDBDatabase = await new Promise((r) => { const q = indexedDB.open("ol-chat-msgs"); q.onsuccess = () => r(q.result); }); const all: any[] = await new Promise((r) => { const g = db.transaction("msgs").objectStore("msgs").getAll(); g.onsuccess = () => r(g.result); }); return JSON.stringify(all.filter((x) => x.m.deleted || /deleted/.test(x.m.text ?? "")).map((x) => ({ id: x.id, gone: x.gone, prev: x.prev, del: x.m.deleted, t: x.m.text }))); })); await page.screenshot({ path: "/tmp/oi-ph.png" }); }
    ok("offline: deleted text never shown", (await page.getByText("to be deleted").count()) === 0);

    // 3. offline send queue (survives restart)
    const txt = `queued ${engine} ${rnd()}`;
    const input = page.getByTestId("composer-input");
    let sentOk = false;
    if (await input.isVisible().catch(() => false)) {
      await input.click(); await input.fill(txt);
      await page.getByRole("button", { name: "Send message" }).click();
      sentOk = await page.getByText(txt).first().waitFor({ timeout: 5000 }).then(() => true, () => false);
    }
    ok("offline send: bubble appears queued", sentOk);
    await sleep(500);
    try { await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }); } catch { /* */ }
    const keptOk = await page.getByText(txt).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    ok("offline send: queued message survives app restart", keptOk);
    if (engine !== "webview") await page.screenshot({ path: `${SHOTS}/${engine}-2-offline-chat-queued.png` });

    // 4. reconnect → sends once, no duplicates
    const got: string[] = [];
    s.P.client.ws.addEventListener?.("message", (e: any) => { if (String(e.data).includes(txt)) got.push("x"); });
    await setOffline(false);
    await sleep(9000);
    const hist = await s.P.client.req("dm:history", { peerId: s.uid, limit: 60 });
    const n = (hist.messages ?? []).filter((m: any) => m.text === txt).length;
    ok("reconnect: queued message delivered exactly once", n === 1, `server copies=${n}`);
    const dom = await page.getByText(txt).count();
    ok("reconnect: no duplicate bubble", dom === 1, `bubbles=${dom}`);
    const left = await page.evaluate((u) => localStorage.getItem("ol-pending:" + u), s.uid);
    ok("reconnect: outbox emptied", !left);
    if (engine === "chrome") await page.screenshot({ path: `${SHOTS}/${engine}-3-reconnected.png` });

    // 5. account switch on same device: never show the other account's cache
    await page.evaluate(setCreds, s.Q);
    await page.goto(`${B}/messages`);
    for (let i = 0; i < 60; i++) { const n = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem("ol-offline-me") || "{}").me?.name; } catch { return null; } }).catch(() => null); if (n === "Other") break; await sleep(500); }
    await sleep(1500);
    ok("switch: other account sees none of Donny's chats", (await page.locator("[data-testid=dm-row]").filter({ hasText: "Sky" }).count()) === 0);
    await setOffline(true);
    try { await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }); } catch { /* */ }
    await sleep(3000);
    ok("switch+offline: still none of Donny's chats", (await page.locator("[data-testid=dm-row]").filter({ hasText: "Sky" }).count()) === 0);
    const idb = await page.evaluate(async (uid) => { const dbs = (await (indexedDB as any).databases?.()) ?? []; for (const d of dbs) { if (!d.name?.startsWith("ol-chat") || d.name === "ol-chat-msgs") continue; const db: IDBDatabase = await new Promise((r, j) => { const q = indexedDB.open(d.name); q.onsuccess = () => r(q.result); q.onerror = j; }); if (!db.objectStoreNames.contains("inbox")) { db.close(); continue; } const v = await new Promise((r) => { const g = db.transaction("inbox").objectStore("inbox").get(uid); g.onsuccess = () => r(g.result); g.onerror = () => r(null); }); db.close(); if (v) return true; } return false; }, s.uid);
    ok("switch: previous account's inbox cache wiped", !idb);
    if (engine === "webkit") await page.screenshot({ path: `${SHOTS}/${engine}-4-switched-offline.png` });
    await setOffline(false);
  } catch (e) {
    ok("run", false, String(e).slice(0, 200));
    await page.screenshot({ path: `/tmp/oi-fail-${engine}.png` }).catch(() => {});
    console.log("URL", page.url());
  }
  await ctx.close();
  px?.close();
  s.close();
  s.P.client.close();
}
await br.chromium.close(); await br.webkit?.close();
const fails = results.filter((r) => !r.pass).length;
console.log(`\nTOTAL ${results.length - fails}/${results.length} pass`);
process.exit(fails ? 1 : 0);
