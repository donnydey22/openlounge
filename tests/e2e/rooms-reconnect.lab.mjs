// Mid-call drop tests. A = Chromium on the host. B = ENGINE inside the olcall netns (netlab/), so B's network can be
// cut (all traffic DROPped = signal lost) or just its app WebSocket killed (tcp reset), for exact durations.
// Media flow is measured from RTCPeerConnection inbound-rtp byte counters on both sides.
import { chromium } from "/workspace/dm-e2e/node_modules/playwright/index.mjs";
import { execSync } from "node:child_process";
import fs from "node:fs";
const BASE = "http://127.0.0.1:3331";
const ENGINE = process.env.ENGINE || "chromium";
const DROPS = (process.env.DROPS || "3,10,30").split(",").map(Number);
// loss = packets silently dropped (tunnel, lift, dead Wi-Fi); offline = the OS also reports offline (Wi-Fi switched off / airplane mode)
const MODES = (process.env.MODES || "loss,offline").split(",").filter((m) => m && m !== "none");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok, extra }); console.log(ok ? "PASS" : "FAIL", name, typeof extra === "string" ? extra : JSON.stringify(extra)); };
const sh = (c) => execSync(c, { stdio: "pipe" }).toString().trim();
const U = JSON.parse(execSync("npx tsx /workspace/calls/mkusers.mts", { cwd: "/workspace/openlounge", env: { ...process.env, WS: "ws://127.0.0.1:3331/ws" } }).toString());
sh("/workspace/calls/netlab/setup.sh");
sh("/workspace/calls/netlab/drop.sh off");
const ep = sh(`/workspace/calls/netlab/bstart.sh ${ENGINE}`).split("\n").pop();
const btype = ENGINE === "webkit" ? (await import("/workspace/dm-e2e/node_modules/playwright/index.mjs")).webkit : ENGINE === "firefox" ? (await import("/workspace/dm-e2e/node_modules/playwright/index.mjs")).firefox : chromium;
const bB = await btype.connect(ep);
const bA = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const pcHook = () => {
  const O = window.RTCPeerConnection;
  if (!O || window.__pcs) return;
  window.__pcs = [];
  window.RTCPeerConnection = function (...a) { const pc = new O(...a); window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = O.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, O);
};
async function ctx(browser, u, perms) {
  const c = await browser.newContext({ viewport: { width: 420, height: 860 }, bypassCSP: true, ...(perms ? { permissions: ["microphone", "camera"] } : {}) });
  await c.addInitScript((u) => {
    if (localStorage.getItem("openlounge:uid")) return;
    localStorage.setItem("openlounge:session", u.refresh);
    localStorage.setItem("openlounge:access", JSON.stringify({ t: u.access, exp: Date.now() + 3e6 }));
    localStorage.setItem("openlounge:uid", u.uid);
    localStorage.setItem("openlounge:saved", String(Date.now()));
  }, u);
  await c.addInitScript(pcHook);
  await c.addInitScript(() => {
    const W = window.WebSocket; window.__wsLog = [];
    window.WebSocket = function (u, p) { const ws = new W(u, p); if (String(u).includes("/ws")) { const t0 = Date.now(); window.__wsLog.push("new@" + (t0 % 100000)); ws.addEventListener("open", () => window.__wsLog.push("open@" + (Date.now() % 100000))); ws.addEventListener("close", (e) => window.__wsLog.push("close" + e.code + "@" + (Date.now() % 100000))); } return ws; };
    window.WebSocket.prototype = W.prototype; Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  });
  await c.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { const st = document.createElement("style"); st.textContent = '[data-testid="notif-prompt"]{display:none!important}'; document.head.appendChild(st); }));
  return c;
}
const a = await (await ctx(bA, U.a, true)).newPage();
const b = await (await ctx(bB, U.b, ENGINE !== "firefox")).newPage();
// ---- rooms: A hosts a room (Chromium, host network), B (ENGINE, netns) joins as listener; cut B's network for DROPS seconds
const inBytes = (p) => p.evaluate(async () => { let n = 0; for (const pc of window.__pcs || []) { if (pc.connectionState === "closed") continue; const s = await pc.getStats(); s.forEach((r) => { if (r.type === "inbound-rtp" && r.kind === "audio") n += r.bytesReceived || 0; }); } return n; });
const status = (p) => p.evaluate(() => document.querySelector("[data-audio-status]")?.getAttribute("data-audio-status") || "?");
const flowing = async (p, ms = 1500) => { const x = await inBytes(p); await sleep(ms); return (await inBytes(p)) > x + 500; };
await a.goto(`${BASE}/`);
await a.getByRole("button", { name: /Start a room/ }).click();
await a.getByPlaceholder("What do you want to talk about?").fill("reconnect lab " + ENGINE);
await a.locator("[data-letsgo-btn]").click();
await a.waitForURL(/\/room\//, { timeout: 15000 });
const url = a.url();
await a.waitForSelector('[data-audio-status="connected"]', { timeout: 20000 });
const mic = a.getByTestId("mic-toggle"); if (await mic.count()) { const lab = (await mic.getAttribute("aria-label")) || ""; if (/unmute/i.test(lab)) await mic.click(); }
await b.goto(url);
const join = b.getByRole("button", { name: /^Join/ }); if (await join.count()) await join.first().click().catch(() => {});
await b.waitForSelector('[data-audio-status="connected"]', { timeout: 30000 });
await b.evaluate(() => { window.__st = []; let last = ""; setInterval(() => { const s = document.querySelector("[data-audio-status]")?.getAttribute("data-audio-status"); if (s !== last) { window.__st.push(s + "@" + Date.now()); last = s; } }, 100); });
let t0 = Date.now(); while (!(await flowing(b)) && Date.now() - t0 < 15000);
check(`${ENGINE} room: host audio reaches listener before the drops`, await flowing(b));
for (const mode of MODES) for (const s of DROPS) {
  sh("/workspace/calls/netlab/drop.sh on"); if (mode === "offline") await b.context().setOffline(true);
  await sleep(s * 1000);
  const during = await status(b);
  sh("/workspace/calls/netlab/drop.sh off"); if (mode === "offline") await b.context().setOffline(false);
  const back = Date.now(); let ok = false;
  while (Date.now() - back < 45000) { if ((await status(b)) === "connected" && (await flowing(b, 1000))) { ok = true; break; } await sleep(300); }
  const path = (await b.evaluate(() => window.__st.splice(0))).map((x) => x.split("@")[0]).join(">");
  check(`${ENGINE} room: ${s}s ${mode} → listener rejoins, host audio resumes`, ok, { during, backMs: Date.now() - back, path, url: b.url() === url });
  await sleep(2000);
}
check(`${ENGINE} room: still in the room (not kicked to hallway)`, b.url() === url);
fs.mkdirSync("/workspace/calls/rooms-reconnect-results", { recursive: true });
fs.writeFileSync(`/workspace/calls/rooms-reconnect-results/${ENGINE}.json`, JSON.stringify({ pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results }, null, 1));
console.log(JSON.stringify({ engine: ENGINE, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length }));
await bA.close(); await bB.close().catch(() => {});
process.exit(0);
