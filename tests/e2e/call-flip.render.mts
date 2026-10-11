// Flip camera + audio continuity across 3 engines x 4 widths with fake cameras, two real clients over a local LiveKit.
// Run: BASE=http://127.0.0.1:3361 npx tsx tests/e2e/call-flip.render.mts
import pw from "/workspace/e2e/node_modules/playwright/index.js";
import { phoneLogin } from "/workspace/ol-q8/tests/unified-auth/harness";
const BASE = process.env.BASE || "http://127.0.0.1:3361", WS = BASE.replace("http", "ws") + "/ws";
const ph = () => `+1555${Math.floor(Math.random() * 9e6 + 1e6)}`; const r = () => Math.random().toString(36).slice(2, 7);
const sleep = (m: number) => new Promise((x) => setTimeout(x, m));
let pass = 0, fail = 0; const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", n, x); };
const SIZES: [number, number][] = process.env.W ? [[+process.env.W, 900]] : [[375, 812], [412, 915], [820, 1180], [1280, 800]];
const ENGS = (process.env.ENGS || "chromium,webkit,firefox").split(",") as ("chromium" | "webkit" | "firefox")[];
const UA = {
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 OpenLoungeAndroid",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 OpenLoungeiOS",
  ipad: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
};
const PC_HOOK = () => {
  const O = window.RTCPeerConnection; const pcs: RTCPeerConnection[] = ((window as any).__pcs = []);
  (window as any).RTCPeerConnection = function (...a: any[]) { const pc = new (O as any)(...a); pcs.push(pc); return pc; };
  (window as any).RTCPeerConnection.prototype = O.prototype;
  Object.setPrototypeOf((window as any).RTCPeerConnection, O);
};
// controls auto-hide 4 s into a video call (existing UX): a tap on the screen wakes them, then tap the button for real
const tap = async (P: any, loc: any) => { await P.mouse.click(Math.floor(P.viewportSize().width / 2), 160).catch(() => {}); await sleep(300); await loc.click({ timeout: 4000 }); };
const audioIn = (p: any) => p.evaluate(async () => {
  let n = 0;
  for (const pc of (window as any).__pcs as RTCPeerConnection[]) {
    if (pc.connectionState === "closed") continue;
    (await pc.getStats()).forEach((s: any) => { if (s.type === "inbound-rtp" && s.kind === "audio") n += s.packetsReceived || 0; });
  }
  return n;
});
for (const eng of ENGS) {
  const opts: any = eng === "chromium" ? { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] } : eng === "firefox" ? { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, "media.autoplay.default": 0 } } : {};
  const br = await pw[eng].launch(opts);
  for (const [w, h] of SIZES) {
    const t = `${eng} ${w}`;
    const a = await phoneLogin(WS, ph(), { firstName: "Donny", username: "donny_" + r() });
    const b = await phoneLogin(WS, ph(), { firstName: "Maya", username: "maya_" + r() });
    await b.client.req("dm:send", { to: a.res.user.id, text: "hi" });
    await a.client.req("dm:send", { to: b.res.user.id, text: "hey" });
    const ua = w === 820 ? UA.ipad : w < 820 ? (eng === "webkit" ? UA.iphone : UA.android) : undefined;
    const mk = async (u: any) => {
      const ctx = await br.newContext({ viewport: { width: w, height: h }, ...(ua ? { userAgent: ua } : {}), ...(eng === "chromium" ? { permissions: ["camera", "microphone"] } : {}), ...(w < 1000 && eng !== "firefox" ? { hasTouch: true } : {}) });
      const U = { refresh: u.res.refresh ?? u.res.token, access: u.res.access, uid: u.res.user.id };
      await ctx.addInitScript((u: any) => { if (localStorage.getItem("openlounge:uid")) return; localStorage.setItem("openlounge:session", u.refresh); localStorage.setItem("openlounge:access", JSON.stringify({ t: u.access, exp: Date.now() + 3e6 })); localStorage.setItem("openlounge:uid", u.uid); localStorage.setItem("openlounge:saved", String(Date.now())); }, U);
      await ctx.addInitScript(PC_HOOK);
      const p = await ctx.newPage(); const errs: string[] = []; p.on("pageerror", (e) => errs.push(e.message));
      return { ctx, p, errs };
    };
    const A = await mk(a), B = await mk(b);
    const camWorks = eng !== "webkit"; // headless WebKit on Linux has no capture device (no mic, no camera)
    const desktop1cam = !ua; // desktop with one fake camera: Flip correctly hidden (shown on phones/tablets or >1 camera)

    try {
      await B.p.goto(`${BASE}/messages`); await A.p.goto(`${BASE}/messages/${b.res.user.id}`); await sleep(2500);
      for (const x of [A.p, B.p]) { const nn = x.getByRole("button", { name: "Not now" }); if (await nn.isVisible().catch(() => false)) await nn.click(); }
      await A.p.locator("[data-testid=dm-video-call]:visible").first().click();
      await B.p.locator("[data-testid=call-accept]").waitFor({ timeout: 15000 }); await sleep(600); await B.p.locator("[data-testid=call-accept]").click({ force: true });
      await A.p.locator("[data-testid=call-end]").waitFor({ timeout: 15000 }); await B.p.locator("[data-testid=call-end]").waitFor({ timeout: 15000 });
      // wait for audio A→B to flow
      let base = 0; for (let i = 0; i < 40 && base < 20; i++) { await sleep(500); base = await audioIn(B.p); }
      if (camWorks) check(`${t}: audio flowing A→B`, base >= 20, `pkts=${base}`);
      for (const [name, P] of [["caller", A.p], ["callee", B.p]] as const) {
        const flipVis = await P.locator("[data-testid=call-flip]").isVisible().catch(() => false);
        if (camWorks && desktop1cam) check(`${t}: Flip hidden on single-camera desktop for ${name}`, !flipVis);
        else if (camWorks) check(`${t}: Flip visible for ${name}`, flipVis);
        else check(`${t}: no Flip without a camera for ${name} (graceful)`, !flipVis);
        const bar = await P.locator("[data-testid=call-end]").locator("xpath=../..").boundingBox();
        check(`${t}: ${name} control bar fits`, !!bar && bar.x >= 0 && bar.x + bar.width <= w + 1, JSON.stringify(bar));
      }
      // stress: flips + camera toggles on the caller while sampling B's inbound audio every 250 ms
      let last = await audioIn(B.p), lastT = Date.now(), maxGap = 0, stop = false;
      const sampler = (async () => { while (!stop) { await sleep(250); const n = await audioIn(B.p); if (n > last) { maxGap = Math.max(maxGap, Date.now() - lastT); last = n; lastT = Date.now(); } } })();
      const flip = A.p.locator("[data-testid=call-flip]"), vid = A.p.locator("[data-testid=call-video]");
      for (let i = 0; i < 6; i++) {
        if (camWorks && (await flip.isVisible().catch(() => false))) { await tap(A.p, flip); await flip.click({ timeout: 2000 }).catch(() => {}); /* immediate 2nd tap → debounced */ }
        await sleep(700);
        if (i % 2) { await tap(A.p, vid); await sleep(900); await tap(A.p, vid); }
        await sleep(700);
      }
      await sleep(1500); stop = true; await sampler; maxGap = Math.max(maxGap, Date.now() - lastT - 250);
      if (camWorks) check(`${t}: audio continuous while flipping/toggling (max gap ${maxGap} ms)`, maxGap < 1500);
      const net: any[] = await A.p.evaluate(() => (window as any).__olCallNet ?? []);
      const evs = net.map((e) => e.ev);
      check(`${t}: no reconnect/rejoin during camera ops`, !evs.some((e) => /lk-reconnecting|rejoin-attempt|lk-disconnected|cam-publish-timeout/.test(e)), evs.join(","));
      if (camWorks) {
        const flips = evs.filter((e) => e === "cam-flipped").length;
        if (!desktop1cam) check(`${t}: flips applied and serialized (${flips} of 12 taps)`, flips >= 3 && flips <= 6);
        check(`${t}: no flip failures`, !evs.includes("cam-flip-failed"));
        const playing = await B.p.locator("video[data-playing='1']").count();
        check(`${t}: callee renders caller video (playing, poster hidden until then)`, playing >= 1, `playing=${playing}`);
        // callee flips too
        const bf = B.p.locator("[data-testid=call-flip]");
        if (!desktop1cam) { await tap(B.p, bf); await sleep(1500); }
        const bev: string[] = (await B.p.evaluate(() => (window as any).__olCallNet ?? [])).map((e: any) => e.ev);
        if (!desktop1cam) check(`${t}: callee flip works`, bev.includes("cam-flipped"), bev.join(","));
      }
      if (camWorks && w === 412) {
        // publish timeout: cancel only the video, audio keeps flowing, no reconnect
        await A.p.evaluate(() => localStorage.setItem("openlounge:campubms", "1"));
        const v = A.p.locator("[data-testid=call-video]");
        await tap(A.p, v); await sleep(800); await tap(A.p, v); await sleep(2500);
        const before = await audioIn(B.p); await sleep(2000); const after = await audioIn(B.p);
        const ev2: string[] = (await A.p.evaluate(() => (window as any).__olCallNet ?? [])).map((e: any) => e.ev);
        check(`${t}: publish timeout cancels video only`, ev2.includes("cam-publish-timeout") && !ev2.some((e) => /lk-reconnecting|rejoin-attempt|lk-disconnected/.test(e)) && after - before > 20, `${ev2.slice(-4).join(",")} audio+${after - before}`);
        await A.p.evaluate(() => localStorage.removeItem("openlounge:campubms"));
      }
      check(`${t}: still in call, no page errors`, (await A.p.locator("[data-testid=call-end]").isVisible()) && !A.errs.length && !B.errs.length, [...A.errs, ...B.errs].join("|").slice(0, 200));
      await A.p.locator("[data-testid=call-end]").click().catch(() => {});
    } catch (e) { check(`${t}: run`, false, String(e).slice(0, 300)); await A.p.screenshot({ path: `/tmp/flip-${eng}-${w}-A.png` }).catch(() => {}); await B.p.screenshot({ path: `/tmp/flip-${eng}-${w}-B.png` }).catch(() => {}); }
    await A.ctx.close(); await B.ctx.close(); a.client.close?.(); b.client.close?.();
  }
  await br.close();
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
