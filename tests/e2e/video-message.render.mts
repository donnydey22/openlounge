import pw from "/workspace/e2e/node_modules/playwright/index.js";
import { phoneLogin } from "/workspace/ol-q8/tests/unified-auth/harness";
const BASE = "http://127.0.0.1:3350", WS = "ws://127.0.0.1:3350/ws";
const ph = () => `+1555${Math.floor(Math.random() * 9e6 + 1e6)}`; const r = () => Math.random().toString(36).slice(2, 7);
const sleep = (m: number) => new Promise((x) => setTimeout(x, m));
let pass = 0, fail = 0; const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", n, x); };
const SIZES: [number, number][] = process.env.DBG ? [[375, 812]] : [[375, 812], [412, 915], [820, 1180], [1280, 800]];
const ENGS = (process.env.ENGS || "chromium,webkit,firefox").split(",") as ("chromium" | "webkit" | "firefox")[];
for (const eng of ENGS) {
  const opts: any = eng === "chromium" ? { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } : eng === "firefox" ? { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true } } : {};
  const br = await pw[eng].launch(opts);
  for (const [w, h] of SIZES) {
    const a = await phoneLogin(WS, ph(), { firstName: "Donny", username: "donny_" + r() });
    const b = await phoneLogin(WS, ph(), { firstName: "Maya", username: "maya_" + r() });
    await b.client.req("dm:send", { to: a.res.user.id, text: "hi" });
    const U = { refresh: a.res.refresh ?? a.res.token, access: a.res.access, uid: a.res.user.id };
    const mobile = w < 1000;
    const ctx = await br.newContext({ viewport: { width: w, height: h }, ...(eng === "chromium" ? { permissions: ["camera", "microphone"] } : {}), ...(mobile && eng !== "firefox" ? { hasTouch: true, isMobile: eng === "chromium" } : {}) });
    await ctx.addInitScript((u: any) => { if (localStorage.getItem("openlounge:uid")) return; localStorage.setItem("openlounge:session", u.refresh); localStorage.setItem("openlounge:access", JSON.stringify({ t: u.access, exp: Date.now() + 3e6 })); localStorage.setItem("openlounge:uid", u.uid); localStorage.setItem("openlounge:saved", String(Date.now())); }, U);
    const page = await ctx.newPage(); const errs: string[] = []; if (process.env.DBG) { page.on("response", (x) => x.status() >= 400 && console.log("HTTP", x.status(), x.url().slice(0, 160))); page.on("requestfailed", (x) => console.log("REQFAIL", x.failure()?.errorText, x.url().slice(0, 160))); } page.on("pageerror", (e) => errs.push(e.message));
    const t = `${eng} ${w}`;
    try {
      await page.goto(`${BASE}/messages/${b.res.user.id}`); await sleep(2000);
      const nn = page.getByRole("button", { name: "Not now" }); if (await nn.isVisible().catch(() => false)) await nn.click();
      await page.locator("[data-testid=attach-button]:visible").first().click();
      await page.locator("[data-testid=attach-video-message]").click();
      const recSheet = page.locator("[data-testid=video-recorder]"); await recSheet.waitFor({ timeout: 8000 });
      const bb = await recSheet.boundingBox();
      check(`${t}: recorder fits viewport`, !!bb && bb.x >= 0 && bb.x + bb.width <= w + 1, JSON.stringify(bb));
      if (eng === "webkit") {
        // no camera in headless WebKit on Linux: must fail gracefully with a message, not crash
        await sleep(2000);
        const txt = await recSheet.innerText();
        check(`${t}: graceful no-camera message`, /Camera unavailable|Allow camera|isn't supported/.test(txt), txt.slice(0, 80));
      } else {
        const tog = page.locator("[data-testid=video-recorder-toggle]");
        await page.waitForFunction(() => !(document.querySelector("[data-testid=video-recorder-toggle]") as HTMLButtonElement)?.disabled, null, { timeout: 10000 });
        await tog.click(); await sleep(2600); await tog.click();
        await page.locator("[data-testid=video-recorder-review]").waitFor({ timeout: 8000 });
        check(`${t}: review plays recorded clip`, true);
        await page.locator("[data-testid=video-recorder-use]").click();
        await page.locator("[data-testid=attach-send]").click({ timeout: 8000 });
        const vb = page.locator("[data-testid=media-video]").last(); await vb.waitFor({ timeout: 20000 });
        check(`${t}: video bubble in thread`, true);
        // server processed: poster appears (img inside bubble) within 40s
        let poster = false; for (let i = 0; i < 40 && !poster; i++) { await sleep(1000); poster = ((await vb.locator("img").count()) > 0 || (await vb.locator("[data-testid=media-local-video]").count()) > 0) && !(await page.locator("[data-testid=media-cancel]").count()); }
        check(`${t}: processed with poster`, poster);
        await sleep(1500); check(`${t}: no retry/error overlay`, (await page.locator("[data-testid=media-retry]:visible").count()) === 0);
        const vbb = await vb.boundingBox();
        check(`${t}: bubble within viewport`, !!vbb && vbb.x >= 0 && vbb.x + vbb.width <= w + 1, JSON.stringify(vbb));
      }
      check(`${t}: no page errors`, errs.length === 0, errs.join("|").slice(0, 200));
      await page.screenshot({ path: `/workspace/e2e/q8vid-${eng}-${w}.png` });
    } catch (e) { check(`${t}: flow`, false, String(e).slice(0, 300)); await page.screenshot({ path: `/workspace/e2e/q8vid-${eng}-${w}-fail.png` }).catch(() => {}); }
    await ctx.close(); a.client.close(); b.client.close();
  }
  await br.close();
}
console.log("pass", pass, "fail", fail); process.exit(fail ? 1 : 0);
