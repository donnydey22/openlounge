// Telegram-style video start: poster only (blur when slow), no spinner during start or stalls. 3 engines × 4 widths.
import pw from "/workspace/e2e/node_modules/playwright/index.js";
import { phoneLogin } from "../unified-auth/harness";
const BASE = process.env.BASE || "http://127.0.0.1:3350", WS = BASE.replace("http", "ws") + "/ws";
const CLIP = process.env.CLIP || `${process.env.TMPDIR || "/tmp"}/vs-clip.mp4`;
const ph = () => `+1555${Math.floor(Math.random() * 9e6 + 1e6)}`; const r = () => Math.random().toString(36).slice(2, 7);
const sleep = (m: number) => new Promise((x) => setTimeout(x, m));
let pass = 0, fail = 0; const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", n, x); };
const SIZES: [number, number][] = [[375, 812], [412, 915], [820, 1180], [1280, 800]];
const ENGS = (process.env.ENGS || "chromium,webkit,firefox").split(",") as ("chromium" | "webkit" | "firefox")[];
// records any visible spinner (animate-spin) anywhere in the viewer, sampled every animation frame
const WATCH = `(function () { var w = window; w.__spin = 0; w.__blur = 0;
  function tick() { document.querySelectorAll(".animate-spin").forEach(function (el) { var b = el.getBoundingClientRect(); if (b.width && getComputedStyle(el).visibility !== "hidden") w.__spin++; });
    if (document.querySelector('[data-testid=video-start-poster][data-blur="1"]')) w.__blur++; w.__raf = requestAnimationFrame(tick); }
  tick(); })()`;
for (const eng of ENGS) {
  const br = await pw[eng].launch();
  for (const [w, h] of SIZES) {
    const a = await phoneLogin(WS, ph(), { firstName: "Donny", username: "donny_" + r() });
    const b = await phoneLogin(WS, ph(), { firstName: "Maya", username: "maya_" + r() });
    await b.client.req("dm:send", { to: a.res.user.id, text: "hi" });
    const U = { refresh: a.res.refresh ?? a.res.token, access: a.res.access, uid: a.res.user.id };
    const mobile = w < 1000;
    const ctx = await br.newContext({ viewport: { width: w, height: h }, ...(mobile && eng !== "firefox" ? { hasTouch: true, isMobile: eng === "chromium" } : {}) });
    await ctx.addInitScript((u: any) => { if (localStorage.getItem("openlounge:uid")) return; localStorage.setItem("openlounge:session", u.refresh); localStorage.setItem("openlounge:access", JSON.stringify({ t: u.access, exp: Date.now() + 3e6 })); localStorage.setItem("openlounge:uid", u.uid); localStorage.setItem("openlounge:saved", String(Date.now())); }, U);
    const page = await ctx.newPage(); const errs: string[] = []; page.on("pageerror", (e) => errs.push(e.message));
    const t = `${eng} ${w}`;
    try {
      await page.goto(`${BASE}/messages/${b.res.user.id}`); await sleep(2000);
      const nn = page.getByRole("button", { name: "Not now" }); if (await nn.isVisible().catch(() => false)) await nn.click();
      await page.locator("[data-testid=attach-input-media]").first().setInputFiles(CLIP);
      await page.locator("[data-testid=attach-send]").click({ timeout: 8000 });
      const vb = page.locator("[data-testid=media-video]").last(); await vb.waitFor({ timeout: 20000 });
      let ok = false; for (let i = 0; i < 60 && !ok; i++) { await sleep(1000); ok = (await vb.locator("img").count()) > 0 && !(await page.locator("[data-testid=media-cancel]").count()) && !(await vb.locator(".animate-spin").count()); }
      check(`${t}: sent + processed with poster`, ok);
      for (const slow of [false, true]) {
        const tag = `${t} ${slow ? "slow" : "fast"}`;
        if (slow) await page.route(/\.(mp4|m3u8|ts|m4s)(\?|$)/, async (rt) => { await sleep(1500); await rt.continue().catch(() => {}); });
        await page.evaluate(WATCH);
        await vb.click();
        const v = page.locator("[data-testid=viewer-video]"); await v.waitFor({ timeout: 10000 });
        const played = await page.waitForFunction(() => { const x = document.querySelector("[data-testid=viewer-video]") as HTMLVideoElement; const p = document.querySelector("[data-testid=video-start-poster]") as HTMLElement | null; return x && x.currentTime > 0 && (!p || p.style.opacity === "0"); }, null, { timeout: 25000 }).then(() => true, () => false);
        check(`${tag}: poster → playback`, played);
        const dims = await page.evaluate(() => { const x = document.querySelector("[data-testid=viewer-video]") as HTMLVideoElement; return [x.videoWidth, x.videoHeight]; });
        check(`${tag}: rotated phone clip plays upright (portrait)`, dims[1] > dims[0], JSON.stringify(dims));
        // simulated buffering/stall mid-play: last frame stays, nothing overlays it
        await page.evaluate(() => { const x = document.querySelector("[data-testid=viewer-video]")!; for (const e of ["waiting", "stalled", "loadstart"]) x.dispatchEvent(new Event(e)); });
        await sleep(400);
        const st = await page.evaluate(() => { const w = window as any; cancelAnimationFrame(w.__raf); const p = document.querySelector("[data-testid=video-start-poster]") as HTMLElement | null; return { spin: w.__spin, blur: w.__blur, posterBack: !!p && p.style.opacity !== "0", blurNow: !!p && p.dataset.blur === "1" }; });
        check(`${tag}: no spinner at start or stall`, st.spin === 0, JSON.stringify(st));
        check(`${tag}: stall keeps last frame (no poster/blur back)`, !st.posterBack && !st.blurNow, JSON.stringify(st));
        if (slow) check(`${tag}: slow start blurred poster`, st.blur > 0, JSON.stringify(st));
        else console.log("INFO", tag, "blur frames on fast start:", st.blur);
        await page.keyboard.press("Escape"); await sleep(800);
        if (await v.count()) { await page.locator("[aria-label=Close]").first().click().catch(() => {}); await sleep(600); }
        if (slow) await page.unroute(/\.(mp4|m3u8|ts|m4s)(\?|$)/);
      }
      // pictures: blur/thumbnail until the full image decodes, cross-fade, never a spinner (slowed full download)
      await page.locator("[data-testid=attach-input-media]").first().setInputFiles(process.env.PHOTO || `${process.env.TMPDIR || "/tmp"}/vs-photo.jpg`);
      await page.locator("[data-testid=attach-send]").click({ timeout: 8000 });
      const pb = page.locator("[data-testid=media-photo]").last(); await pb.waitFor({ timeout: 20000 });
      let pok = false; for (let i = 0; i < 40 && !pok; i++) { await sleep(500); pok = !(await page.locator("[data-testid=media-cancel]").count()); }
      await sleep(1500);
      await page.reload(); await sleep(2500);
      await page.evaluate(WATCH);
      check(`${t} photo: bubble shows no spinner`, (await page.evaluate(() => (window as any).__spin)) === 0);
      await page.route(/\/media\//, async (rt) => { if (rt.request().resourceType() === "image") await sleep(1500); await rt.continue().catch(() => {}); });
      await page.evaluate(WATCH);
      await page.locator("[data-testid=media-photo]").last().click();
      const shown = await page.waitForFunction(() => { const im = document.querySelector("[data-testid=viewer-photo-full]") as HTMLImageElement | null; return !!im && im.complete && getComputedStyle(im).opacity === "1"; }, null, { timeout: 20000 }).then(() => true, () => false);
      check(`${t} photo: full image cross-faded in after decode`, shown);
      const ps = await page.evaluate(() => (window as any).__spin);
      check(`${t} photo: no spinner while full image loads`, ps === 0, String(ps));
      await page.unroute(/\/media\//);
      await page.keyboard.press("Escape"); await sleep(600);
      check(`${t}: no page errors`, errs.length === 0, errs.join("|").slice(0, 200));
    } catch (e) { check(`${t}: flow`, false, String(e).slice(0, 300)); await page.screenshot({ path: `/workspace/e2e/vstart-${eng}-${w}-fail.png` }).catch(() => {}); }
    await ctx.close(); a.client.close(); b.client.close();
  }
  await br.close();
}
console.log("pass", pass, "fail", fail); process.exit(fail ? 1 : 0);
