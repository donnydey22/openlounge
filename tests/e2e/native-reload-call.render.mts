// Automated two-person call: two real browsers, two fresh test accounts, local server + LiveKit dev SFU.
// A calls B (audio, then video) from the DM; B accepts; both reach "connected" with remote media flowing; hang up.
// Run: BASE=http://127.0.0.1:3350 node --import tsx tests/e2e/two-person-call.render.mts
import { phoneLogin } from "../unified-auth/harness";
const pw = (await import(process.env.PW_MODULE || "playwright")).default;
const BASE = process.env.BASE || "http://127.0.0.1:3350", WS = BASE.replace("http", "ws") + "/ws";
const ph = () => `+1555${Math.floor(Math.random() * 9e6 + 1e6)}`, r = () => Math.random().toString(36).slice(2, 7);
// Native wrapper (CallKit / Android call screen) reloads the WebView after a lock-screen answer + unlock:
// the answered call must survive and the callee's new page must rejoin (2026-10-15 Keiko drop).
const sleep = (m: number) => new Promise((x) => setTimeout(x, m));
let pass = 0, fail = 0; const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : x); };
const launch = () => pw.chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
async function open(br: any, u: any, native: boolean) {
  const ctx = await br.newContext({ viewport: { width: 375, height: 812 }, ...(process.env.UA ? { userAgent: process.env.UA } : {}), permissions: ["camera", "microphone"] });
  await ctx.addInitScript((u: any) => { if (localStorage.getItem("openlounge:uid")) return; localStorage.setItem("openlounge:session", u.refresh); localStorage.setItem("openlounge:access", JSON.stringify({ t: u.access, exp: Date.now() + 3e6 })); localStorage.setItem("openlounge:uid", u.uid); }, u);
  if (native) await ctx.addInitScript(() => { (window as any).__olNativeCalls = 1; (window as any).ReactNativeWebView = { postMessage() {} }; });
  const p = await ctx.newPage(); const errs: string[] = []; p.on("pageerror", (e: Error) => errs.push(e.message)); return { ctx, p, errs };
}
const status = (p: any) => p.locator("[data-testid=call-status]").innerText().catch(() => "");
const running = async (p: any) => /\d+:\d\d/.test(await status(p));
for (const reloadSide of ["callee", "caller"]) {
  const t = `native ${reloadSide} reload mid-call`;
  const brA = await launch(), brB = await launch();
  try {
    const a = await phoneLogin(WS, ph(), { firstName: "Ann", username: "ann_" + r() }), b = await phoneLogin(WS, ph(), { firstName: "Ben", username: "ben_" + r() });
    await a.client.req("dm:send", { to: b.res.user.id, text: "hi" }); await b.client.req("dm:send", { to: a.res.user.id, text: "hey" });
    const U = (x: any) => ({ refresh: x.res.refresh ?? x.res.token, access: x.res.access, uid: x.res.user.id });
    const A = await open(brA, U(a), true), B = await open(brB, U(b), true);
    await B.p.goto(`${BASE}/messages`); await A.p.goto(`${BASE}/messages/${b.res.user.id}`); await sleep(2500);
    for (const P of [A.p, B.p]) { const nn = P.getByRole("button", { name: "Not now" }); if (await nn.isVisible().catch(() => false)) await nn.click(); }
    await A.p.locator("[data-testid=dm-call]:visible").first().click();
    await B.p.locator("[data-testid=call-accept]").waitFor({ timeout: 15000 });
    await B.p.locator("[data-testid=call-accept]").click({ force: true });
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && !((await running(A.p)) && (await running(B.p)))) await sleep(500);
    check(`${t}: connected`, (await running(A.p)) && (await running(B.p)));
    const R = reloadSide === "callee" ? B : A, O = reloadSide === "callee" ? A : B;
    await R.p.reload();
    await sleep(12000);
    check(`${t}: other side still in call`, await running(O.p), await status(O.p));
    check(`${t}: reloaded side rejoined`, await running(R.p), await status(R.p));
    const live = await R.p.evaluate(() => [...document.querySelectorAll("audio,video")].some((m: any) => m.srcObject && (m.srcObject as MediaStream).getTracks().some((x) => x.readyState === "live")));
    check(`${t}: reloaded side has remote media`, live);
    await O.p.locator("[data-testid=call-end]").first().click({ force: true }).catch(() => {});
    await sleep(2500);
    check(`${t}: hang-up still ends both`, !(await A.p.locator("[data-testid=call-screen]").isVisible().catch(() => false)) && !(await B.p.locator("[data-testid=call-screen]").isVisible().catch(() => false)));
  } catch (e) { check(`${t}: run`, false, String(e).slice(0, 300)); }
  await brA.close(); await brB.close();
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
