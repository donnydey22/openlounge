// Automated two-person call: two real browsers, two fresh test accounts, local server + LiveKit dev SFU.
// A calls B (audio, then video) from the DM; B accepts; both reach "connected" with remote media flowing; hang up.
// Run: BASE=http://127.0.0.1:3350 node --import tsx tests/e2e/two-person-call.render.mts
import { phoneLogin } from "../unified-auth/harness";
const pw = (await import(process.env.PW_MODULE || "playwright")).default;
const BASE = process.env.BASE || "http://127.0.0.1:3350", WS = BASE.replace("http", "ws") + "/ws";
const ph = () => `+1555${Math.floor(Math.random() * 9e6 + 1e6)}`, r = () => Math.random().toString(36).slice(2, 7);
const sleep = (m: number) => new Promise((x) => setTimeout(x, m));
let pass = 0, fail = 0; const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : x); };
const ENGS = (process.env.ENGS || "chromium,firefox").split(",") as ("chromium" | "firefox")[];
const SIZES: [number, number][] = process.env.DBG ? [[1280, 800]] : [[375, 812], [1280, 800]];
const launch = (e: string) => pw[e].launch(e === "chromium" ? { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] } : { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, "media.autoplay.default": 0, "media.autoplay.block-webaudio": false, "media.peerconnection.ice.loopback": true, "media.peerconnection.ice.obfuscate_host_addresses": false } });
async function open(br: any, eng: string, u: any, w: number, h: number) {
  const ctx = await br.newContext({ viewport: { width: w, height: h }, ...(process.env.UA ? { userAgent: process.env.UA } : {}), ...(eng === "chromium" ? { permissions: ["camera", "microphone"] } : {}) });
  await ctx.addInitScript((u: any) => { if (localStorage.getItem("openlounge:uid")) return; localStorage.setItem("openlounge:session", u.refresh); localStorage.setItem("openlounge:access", JSON.stringify({ t: u.access, exp: Date.now() + 3e6 })); localStorage.setItem("openlounge:uid", u.uid); }, u);
  const p = await ctx.newPage(); const errs: string[] = []; p.on("pageerror", (e: Error) => errs.push(e.message)); return { ctx, p, errs };
}
const media = (p: any) => p.evaluate(() => [...document.querySelectorAll("video,audio")].map((m: any) => ({ k: m.tagName, w: m.videoWidth || 0, live: !!(m.srcObject && (m.srcObject as MediaStream).getTracks().some((t) => t.readyState === "live")) })));
for (const ea of ENGS) for (const eb of ENGS) for (const [w, h] of SIZES) for (const video of [false, true]) {
  const t = `${ea}->${eb} ${w} ${video ? "video" : "audio"}`;
  const brA = await launch(ea), brB = await launch(eb);
  try {
    const a = await phoneLogin(WS, ph(), { firstName: "Ann", username: "ann_" + r() }), b = await phoneLogin(WS, ph(), { firstName: "Ben", username: "ben_" + r() });
    await a.client.req("dm:send", { to: b.res.user.id, text: "hi" }); await b.client.req("dm:send", { to: a.res.user.id, text: "hey" });
    const U = (x: any) => ({ refresh: x.res.refresh ?? x.res.token, access: x.res.access, uid: x.res.user.id });
    const A = await open(brA, ea, U(a), w, h), B = await open(brB, eb, U(b), w, h);
    await B.p.goto(`${BASE}/messages`); await A.p.goto(`${BASE}/messages/${b.res.user.id}`); await sleep(2500);
    for (const P of [A.p, B.p]) { const nn = P.getByRole("button", { name: "Not now" }); if (await nn.isVisible().catch(() => false)) await nn.click(); }
    if (process.env.DBG) { await A.p.screenshot({ path: "/tmp/tpc-a.png" }); console.log(A.p.url(), A.errs); }
    await A.p.locator(`[data-testid=${video ? "dm-video-call" : "dm-call"}]:visible`).first().click();
    await B.p.locator("[data-testid=call-accept]").waitFor({ timeout: 15000 }); check(`${t}: callee rings`, true);
    await B.p.locator("[data-testid=call-accept]").click({ force: true });
    let ok = false, st = ""; const t0 = Date.now();
    while (Date.now() - t0 < 20000) { st = (await A.p.locator("[data-testid=call-status]").innerText().catch(() => "")) + "|" + (await B.p.locator("[data-testid=call-status]").innerText().catch(() => "")); if (/\d+:\d\d.*\|.*\d+:\d\d/.test(st)) { ok = true; break; } await sleep(500); }
    check(`${t}: both connected (timer running)`, ok, st);
    await sleep(3000);
    const ma = await media(A.p), mb = await media(B.p);
    check(`${t}: remote media live both sides`, ma.some((m: any) => m.live) && mb.some((m: any) => m.live), JSON.stringify({ ma, mb }));
    if (video) check(`${t}: remote video frames both sides`, ma.some((m: any) => m.k === "VIDEO" && m.w > 0) && mb.some((m: any) => m.k === "VIDEO" && m.w > 0), JSON.stringify({ ma, mb }));
    await A.p.locator("[data-testid=call-screen]").click({ position: { x: 20, y: 200 } }).catch(() => {}); await sleep(400); // video controls auto-hide; tap to reveal
    await A.p.locator("[data-testid=call-end]").first().click({ force: true }).catch(() => {});
    await sleep(2500);
    check(`${t}: hang-up closes both screens`, !(await A.p.locator("[data-testid=call-screen]").isVisible().catch(() => false)) && !(await B.p.locator("[data-testid=call-screen]").isVisible().catch(() => false)));
    check(`${t}: no page errors`, A.errs.length + B.errs.length === 0, [...A.errs, ...B.errs].join(" | ").slice(0, 300));
  } catch (e) { check(`${t}: run`, false, String(e).slice(0, 300)); }
  await brA.close(); await brB.close();
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
