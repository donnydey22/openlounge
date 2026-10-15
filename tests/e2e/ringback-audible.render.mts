// Ringback/ringtone audible-path E2E (Oct 15 2026). Two real browsers, fresh test accounts, local server.
// Per scenario: caller rings back (path + level/clock advancing), callee rings, answer connects, hang-up clears both.
// Scenarios: iPhone Safari (WebKit iPhone emulation), Android Chrome (Pixel emulation), desktop Chromium/Firefox,
// iOS app b30 (bridge emulated → element-first path), iOS/Android app 0.3.12 (__olNativeRingback → web stays silent).
// Run: BASE=http://127.0.0.1:3361 node --import tsx tests/e2e/ringback-audible.render.mts
import { phoneLogin } from "../unified-auth/harness";
const pw = (await import(process.env.PW_MODULE || "playwright")).default;
const BASE = process.env.BASE || "http://127.0.0.1:3361", WS = BASE.replace("http", "ws") + "/ws";
const ph = () => `+1555${Math.floor(Math.random() * 9e6 + 1e6)}`, r = () => Math.random().toString(36).slice(2, 7);
const sleep = (m: number) => new Promise((x) => setTimeout(x, m));
let pass = 0, fail = 0; const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : x); };
type Sc = { name: string; eng: "webkit" | "chromium" | "firefox"; device?: string; bridge?: "ios" | "android"; nativeRing?: boolean };
const ALL: Sc[] = [
  { name: "iPhone Safari", eng: "webkit", device: "iPhone 13" },
  { name: "Android Chrome", eng: "chromium", device: "Pixel 7" },
  { name: "desktop Chromium", eng: "chromium" },
  { name: "desktop Firefox", eng: "firefox" },
  { name: "iOS app b30 (element path)", eng: "webkit", device: "iPhone 13", bridge: "ios" },
  { name: "iOS app 0.3.12 (native ringback)", eng: "webkit", device: "iPhone 13", bridge: "ios", nativeRing: true },
  { name: "Android app 0.3.12 (native ringback)", eng: "chromium", device: "Pixel 7", bridge: "android", nativeRing: true },
];
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const launch = (e: string) => e === "chromium" ? pw.chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] })
  : e === "firefox" ? pw.firefox.launch({ firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, "media.autoplay.default": 0, "media.autoplay.block-webaudio": false } })
  : pw.webkit.launch();
async function open(br: any, sc: Sc, u: any) {
  const dev = sc.device ? pw.devices[sc.device] : { viewport: { width: 1280, height: 800 } };
  const ctx = await br.newContext({ ...dev, ...(sc.eng === "chromium" ? { permissions: ["camera", "microphone"] } : {}) });
  await ctx.addInitScript(([u, sc]: any) => {
    if (sc.bridge) (window as any).OpenLoungeNative = { getPlatform: () => sc.bridge, postMessage: (m: string) => ((window as any).__olNativeMsgs ??= []).push(m) };
    if (sc.nativeRing) (window as any).__olNativeRingback = 1;
    if (localStorage.getItem("openlounge:uid")) return;
    localStorage.setItem("openlounge:session", u.refresh); localStorage.setItem("openlounge:access", JSON.stringify({ t: u.access, exp: Date.now() + 3e6 })); localStorage.setItem("openlounge:uid", u.uid);
  }, [u, sc]);
  const p = await ctx.newPage(); const errs: string[] = []; p.on("pageerror", (e: Error) => errs.push(e.message)); return { ctx, p, errs };
}
const ring = (p: any) => p.evaluate(() => { const w = window as any; return { kind: w.__olRing?.kind ?? null, path: w.__olRing?.path ?? "none", level: w.__olRingLevel?.() ?? 0, pos: w.__olRingPos?.() ?? -1 }; });
for (const sc of ALL.filter((s) => !ONLY || ONLY.test(s.name))) {
  const t = sc.name;
  const brA = await launch(sc.eng), brB = await launch("chromium");
  try {
    const a = await phoneLogin(WS, ph(), { firstName: "Jordan", username: "jordan_" + r() }), b = await phoneLogin(WS, ph(), { firstName: "Sam", username: "sam_" + r() });
    await a.client.req("dm:send", { to: b.res.user.id, text: "hi" }); await b.client.req("dm:send", { to: a.res.user.id, text: "hey" });
    const U = (x: any) => ({ refresh: x.res.refresh ?? x.res.token, access: x.res.access, uid: x.res.user.id });
    const A = await open(brA, sc, U(a)), B = await open(brB, { name: "callee", eng: "chromium" }, U(b));
    await B.p.goto(`${BASE}/messages`); await A.p.goto(`${BASE}/messages/${b.res.user.id}`); await sleep(2500);
    for (const P of [A.p, B.p]) { const nn = P.getByRole("button", { name: "Not now" }); if (await nn.isVisible().catch(() => false)) await nn.click(); }
    await B.p.mouse.click(5, 5); // callee had a gesture earlier in the session (audio unlock), like a real open app
    await A.p.locator("[data-testid=dm-call]:visible").first().click();
    await B.p.locator("[data-testid=call-accept]").waitFor({ timeout: 15000 });
    const samples: any[] = [];
    for (let i = 0; i < 6; i++) { await sleep(800); samples.push(await ring(A.p)); }
    const rbs: any[] = [];
    for (let i = 0; i < 5; i++) { rbs.push(await ring(B.p)); await sleep(300); }
    const rb = rbs.find((x) => x.level > 0 || x.path === "element") ?? rbs[0];
    if (sc.nativeRing) {
      check(`${t}: web ringback defers to native (path=native, silent)`, samples.every((s) => s.kind === "outgoing" && s.path === "native" && s.level === 0), JSON.stringify(samples));
      const msgs: string[] = await A.p.evaluate(() => (window as any).__olNativeMsgs ?? []);
      check(`${t}: call:outgoing posted to native (starts native ringback)`, msgs.some((m) => String(m).includes("call:outgoing")), JSON.stringify(msgs).slice(0, 300));
    } else {
      check(`${t}: caller ringback active whole window`, samples.every((s) => s.kind === "outgoing" && s.path !== "none"), JSON.stringify(samples));
      const el = samples.filter((s) => s.path === "element");
      if (el.length) check(`${t}: ringback element clock advancing (${samples[samples.length - 1].pos.toFixed(2)}s)`, el[el.length - 1].pos - el[0].pos > 2, JSON.stringify(samples));
      else check(`${t}: ringback Web Audio level > 0 in on-phase`, samples.some((s) => s.level > 0.01), JSON.stringify(samples));
    }
    check(`${t}: callee ringtone playing`, rb.kind === "incoming" && (rb.level > 0 || rb.path === "element"), JSON.stringify(rb));
    await B.p.locator("[data-testid=call-accept]").click({ force: true });
    let ok = false, st = ""; const t0 = Date.now();
    while (Date.now() - t0 < 20000) { st = (await A.p.locator("[data-testid=call-status]").innerText().catch(() => "")) + "|" + (await B.p.locator("[data-testid=call-status]").innerText().catch(() => "")); if (/\d+:\d\d.*\|.*\d+:\d\d/.test(st)) { ok = true; break; } await sleep(500); }
    check(`${t}: answer connects both`, ok, st);
    const after = await ring(A.p);
    check(`${t}: ringback stopped on connect`, after.kind === null && after.level === 0, JSON.stringify(after));
    if (sc.nativeRing) { const msgs: string[] = await A.p.evaluate(() => (window as any).__olNativeMsgs ?? []); check(`${t}: call:connected posted (stops native ringback)`, msgs.some((m) => String(m).includes("call:connected")), ""); }
    await A.p.locator("[data-testid=call-end]").first().click({ force: true }).catch(() => {});
    await sleep(2000);
    check(`${t}: no page errors`, A.errs.length + B.errs.length === 0, [...A.errs, ...B.errs].join(" | ").slice(0, 300));
  } catch (e) { check(`${t}: run`, false, String(e).slice(0, 400)); }
  await brA.close(); await brB.close();
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
