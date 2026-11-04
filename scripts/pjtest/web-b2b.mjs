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
// Browser<->browser over the WASM leg: node does the socket RPCs (same ones WasmCallSession issues); two headless
// Chromium pages loaded from the TEST instance run WASM Opus/RTP/SRTP through wss://.../media-relay -> mediasoup.
import { chromium } from "playwright";
const ORIGIN = process.env.ORIGIN || "https://turn.openlounge.app:8443";
const st = await A.c.req("call:start", { peerId: bId, video: false }); const callId = st.callId ?? st.call?.id; await sleep(400);
log("accept", await B.c.req("call:accept", { callId }));
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const legs = [];
for (const [n, x] of [["A", A], ["B", B]]) {
  await x.c.req("ms:join", { callId });
  const cr = await x.c.req("ms:plain:create", { callId });
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  await page.goto(ORIGIN + "/wasm-call/src/pcm-worklet.js");
  const tx = await page.evaluate(async () => (await import("/wasm-call/src/client.mjs")).newKeyB64());
  log(n + " connect", await x.c.req("ms:plain:connect", { callId, srtpParameters: { cryptoSuite: "AES_CM_128_HMAC_SHA1_80", keyBase64: tx } }));
  const ssrc = n === "A" ? 111111 : 222222;
  await page.evaluate(async ({ tx, rx, ssrc, token, callId, freq }) => {
    const { MediaCore } = await import("/wasm-call/src/client.mjs"); const factory = (await import("/wasm-call/dist/olwasm.mjs")).default;
    const core = (await MediaCore.load(factory)).open({ txKeyB64: tx, rxKeyB64: rx, ssrc });
    const ws = new WebSocket(`wss://${location.host}/media-relay/?token=${encodeURIComponent(token)}&callId=${callId}`); ws.binaryType = "arraybuffer";
    await new Promise((ok, no) => { ws.onopen = ok; ws.onclose = (e) => no(new Error("relay " + e.code)); });
    const S = (window.__s = { sent: 0, recv: 0, err: 0, rms: 0, n: 0 }); let ph = 0;
    setInterval(() => { const p = new Int16Array(960); for (let i = 0; i < 960; i++) { p[i] = Math.sin(ph) * 8000; ph += 2 * Math.PI * freq / 48000; } ws.send(core.send(p)); S.sent++; }, 20);
    ws.onmessage = (e) => { try { const o = core.recv(new Uint8Array(e.data)); if (!o.length) return; S.recv++; let s = 0; for (const v of o) s += v * v; S.rms += Math.sqrt(s / o.length); S.n++; } catch { S.err++; } };
  }, { tx, rx: cr.srtpParameters.keyBase64, ssrc, token: cr.relayToken, callId, freq: n === "A" ? 440 : 660 });
  log(n + " produce", await x.c.req("ms:plain:produce", { callId, kind: "audio", ssrc, payloadType: 111 }));
  legs.push({ n, x, page, cr: { ip: cr.ip, port: cr.port, token: !!cr.relayToken } });
}
for (const l of legs) log(l.n + " consume", await l.x.c.req("ms:plain:consume", { callId }));
await sleep(8000);
let pass = true;
for (const l of legs) { const s = await l.page.evaluate(() => window.__s); const rms = s.n ? Math.round(s.rms / s.n) : 0; log(l.n + " stats", { ...s, rms, sfu: l.cr }); if (s.recv < 200 || rms < 1000) pass = false; }
log("hangup", await A.c.req("call:hangup", { callId }));
console.log(pass ? "WEB_B2B_PASS" : "WEB_B2B_FAIL"); await browser.close(); process.exit(pass ? 0 : 1);
