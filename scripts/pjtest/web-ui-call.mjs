import WebSocket from "ws";
const URL = "ws://127.0.0.1:3101/ws";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (c, l, e) => { if (!c) console.log("FAIL", l, JSON.stringify(e).slice(0,200)); };
function client(opts = {}) {
  const ws = new WebSocket(URL, opts);
  let seq = 0;
  const pending = new Map();
  const events = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "res") pending.get(m.id)?.(m.data), pending.delete(m.id);
    else if (m.t === "evt") {
      events.push({ ...m, at: Date.now() });
      for (const w of [...waiters]) if (w.ev === m.ev && w.pred(m.data)) waiters.splice(waiters.indexOf(w), 1), w.resolve(m.data);
    }
  });
  const open = new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  return {
    ws,
    open,
    events,
    req: (ev, data = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ t: "req", id, ev, data }));
        setTimeout(() => pending.has(id) && reject(new Error(`timeout ${ev}`)), 8000);
      }),
    emit: (ev, data = {}) => ws.send(JSON.stringify({ t: "evt", ev, data })),
    wait: (ev, pred = () => true, ms = 8000) =>
      new Promise((resolve, reject) => {
        waiters.push({ ev, pred, resolve });
        setTimeout(() => reject(new Error(`no ${ev} event within ${ms}ms`)), ms);
      }),
    close: () => ws.close(),
  };
}

async function signup(phone, first, username) {
  const c = client();
  await c.open;
  const r = await c.req("auth:requestCode", { phone });
  const v = await c.req("auth:verifyCode", { phone, code: r.demoCode ?? "000000" });
  const reg = await c.req("auth:register", { ticket: v.ticket, firstName: first, lastName: "Presence", username, bio: "", color: "#34d399", interests: [] });
  check(reg.ok && reg.token, `signup ${first}`, reg);
  // Match the web/native client contract: every authenticated socket reports its actual
  // foreground state instead of relying on a server-side visible-by-default assumption.
  c.emit("presence:visible", { visible: true });
  return { c, reg };
}
const log = (k, v) => console.log(k, typeof v === "object" ? JSON.stringify(v).slice(0, 240) : v);
const t = Date.now() % 100000;
const A = await signup(`+1555${String(t).padStart(7, "0")}`, "PjA", `pja${t}`);
const B = await signup(`+1556${String(t).padStart(7, "0")}`, "PjB", `pjb${t}`);
log("accounts", { a: !!A.reg, b: !!B.reg });
const bId = B.reg?.user?.id ?? B.reg?.me?.id ?? B.reg?.id; log("bId", bId);
const aId = A.reg?.user?.id ?? A.reg?.me?.id;
await A.c.req("user:follow", { userId: bId, follow: true }); await B.c.req("user:follow", { userId: aId, follow: true });
// REAL call screens, browser<->browser: two signed-in Chromium pages (fake camera/mic), A taps the DM call button,
// B taps Accept on the incoming screen. Media counted at the WS relay (/media-relay) = the WASM leg, no RTCPeerConnection.
const { chromium } = await import(process.env.PW_MODULE || "playwright");
const ORIGIN = process.env.ORIGIN || "https://turn.openlounge.app:8443";
const VIDEO = process.env.VIDEO === "1";
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const init = ({ token, uid }) => {
  try { localStorage.setItem("openlounge:session", token); localStorage.setItem("openlounge:uid", uid); localStorage.setItem("openlounge:saved", String(Date.now())); } catch {}
  const S = (window.__relay = { tx: 0, rx: 0, txBytes: 0, opened: 0 }); window.__pc = 0;
  const RPC = window.RTCPeerConnection; if (RPC) window.RTCPeerConnection = function (...a) { window.__pc++; return new RPC(...a); };
  const W = window.WebSocket;
  window.WebSocket = function (url, p) { const ws = new W(url, p); if (String(url).includes("/media-relay")) { S.opened++; const send = ws.send.bind(ws);
      ws.send = (d) => { S.tx++; S.txBytes += d.byteLength || d.length || 0; return send(d); }; ws.addEventListener("message", () => S.rx++); } return ws; };
  Object.assign(window.WebSocket, W);
};
const mk = async (who) => { const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 420, height: 860 }, permissions: ["camera", "microphone"] });
  await ctx.addInitScript(init, { token: who.reg.token, uid: who.reg.user?.id ?? who.reg.me?.id }); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); return { p, errs }; };
const PA = await mk(A), PB = await mk(B);
await PB.p.goto(ORIGIN + "/"); await PA.p.goto(ORIGIN + "/messages/" + bId);
await PA.p.waitForTimeout(6000); await PA.p.screenshot({ path: "/tmp/ui-pre-A.png" }); log("A url", PA.p.url());
await PA.p.locator(VIDEO ? '[data-testid="dm-video-call"]' : '[data-testid="dm-call"]').first().click({ timeout: 20000 });
log("A tapped", VIDEO ? "video call" : "call");
await PB.p.locator('[data-testid="call-accept"]').first().waitFor({ timeout: 25000 }); await PB.p.waitForTimeout(800); await PB.p.locator('[data-testid="call-accept"]').first().click({ force: true }); // pulsing button never "stable"
log("B tapped", "accept");
await PA.p.waitForTimeout(12000);
let pass = true;
for (const [n, P] of [["A", PA], ["B", PB]]) {
  const r = await P.p.evaluate(() => ({ relay: window.__relay, pc: window.__pc, endBtn: !!document.querySelector('[data-testid="call-end"]'),
    videos: [...document.querySelectorAll("video")].map((v) => ({ w: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(1) })) }));
  log(n, { ...r, errs: P.errs.slice(0, 3) });
  await P.p.screenshot({ path: `/tmp/ui-${VIDEO ? "video" : "audio"}-${n}.png` });
  if (!r.endBtn || r.relay.rx < 300 || r.relay.tx < 300 || r.pc > 0) pass = false;
  if (VIDEO && !(r.videos.filter((v) => v.w > 0).length >= 2)) pass = false;
}
await PA.p.locator('[data-testid="call-end"]').first().click().catch(() => {});
await PA.p.waitForTimeout(1500);
console.log(pass ? `UI_${VIDEO ? "VIDEO" : "AUDIO"}_PASS` : `UI_${VIDEO ? "VIDEO" : "AUDIO"}_FAIL`); await browser.close(); process.exit(pass ? 0 : 1);
