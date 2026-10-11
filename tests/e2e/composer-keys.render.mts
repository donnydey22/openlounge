import pw from "/workspace/e2e/node_modules/playwright/index.js";
import { phoneLogin } from "/workspace/ol-q8/tests/unified-auth/harness";
const BASE = "http://127.0.0.1:3350", WS = "ws://127.0.0.1:3350/ws";
const ph = () => `+1555${Math.floor(Math.random() * 9e6 + 1e6)}`; const r = () => Math.random().toString(36).slice(2, 7);
const sleep = (m: number) => new Promise((x) => setTimeout(x, m));
let pass = 0, fail = 0; const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", n, x); };
const SIZES: [number, number][] = [[375, 812], [412, 915], [820, 1180], [1280, 800]];
const ENGS = (process.env.ENGS || "chromium,webkit,firefox").split(",") as ("chromium" | "webkit" | "firefox")[];
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
      const ta = page.locator("[data-testid=composer-input]:visible").first(); await ta.waitFor();
      const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches);
      const val = () => ta.inputValue();
      await ta.click();
      // list continuation + indentation carry (Shift+Enter works everywhere)
      await ta.type("- one"); await ta.press("Shift+Enter");
      check(`${t}: list continues`, (await val()) === "- one\n- ", JSON.stringify(await val()));
      await ta.press("Shift+Enter");
      check(`${t}: empty item ends list`, (await val()) === "- one\n", JSON.stringify(await val()));
      await ta.type("  code"); await ta.press("Shift+Enter");
      check(`${t}: indentation carries`, (await val()) === "- one\n  code\n  ", JSON.stringify(await val()));
      // Tab indents a multi-line selection, Shift+Tab outdents
      await ta.fill("a\nb"); await ta.press("ControlOrMeta+a"); await ta.press("Tab");
      check(`${t}: Tab indents lines`, (await val()) === "  a\n  b", JSON.stringify(await val()));
      await ta.press("Shift+Tab");
      check(`${t}: Shift+Tab outdents`, (await val()) === "a\nb", JSON.stringify(await val()));
      // auto-grow and cap
      await ta.fill(""); await ta.type("1"); const h1 = (await ta.boundingBox())!.height;
      for (let i = 2; i <= 12; i++) { await ta.press("Shift+Enter"); await ta.type(String(i)); }
      const h2 = (await ta.boundingBox())!.height;
      check(`${t}: grows multi-line`, h2 > h1 * 2, `${h1}→${h2}`);
      check(`${t}: capped ≤200px`, h2 <= 201, String(h2));
      // Enter: desktop sends, phones newline
      await ta.fill("first"); await ta.press("Enter");
      if (coarse) {
        check(`${t}: [coarse] Return = newline`, (await val()) === "first\n", JSON.stringify(await val()));
        await ta.type("second");
        await page.getByRole("button", { name: "Send message" }).first().click();
      } else {
        check(`${t}: [fine] Enter sends`, (await val()) === "", JSON.stringify(await val()));
        await ta.type("x"); await ta.press("Shift+Enter"); await ta.type("y"); await ta.press("Enter");
      }
      await sleep(1200);
      const lastText = await page.locator("[data-testid=dm-list] [data-testid=dm-bubble]").last().innerText();
      check(`${t}: multi-line message delivered`, coarse ? /first\s*\n\s*second/.test(lastText) : /x\s*\n\s*y/.test(lastText), JSON.stringify(lastText.slice(0, 60)));
      check(`${t}: composer cleared + shrunk`, (await val()) === "" && (await ta.boundingBox())!.height <= h1 + 2);
      // regression: formatting shortcut still works, emoji + attach + sticker buttons present
      await ta.fill("bold"); await ta.press("ControlOrMeta+a"); await ta.press("ControlOrMeta+b");
      check(`${t}: Ctrl/Cmd+B formatting intact`, /^\*{1,2}bold\*{1,2}$/.test(await val()), JSON.stringify(await val()));
      check(`${t}: attach button present`, await page.locator("[data-testid=attach-button]:visible").count() > 0);
      const fs = await ta.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      if (w < 640) check(`${t}: ≥16px on phones (no iOS zoom)`, fs >= 16, String(fs));
      const box = await page.locator("[data-testid=composer]:visible").first().boundingBox();
      check(`${t}: composer within viewport`, !!box && box.x >= 0 && box.x + box.width <= w + 1);
      check(`${t}: no page errors`, errs.length === 0, errs.join("|").slice(0, 200));
      await page.screenshot({ path: `/workspace/e2e/q8comp-${eng}-${w}.png` });
    } catch (e) { check(`${t}: flow`, false, String(e).slice(0, 300)); await page.screenshot({ path: `/workspace/e2e/q8comp-${eng}-${w}-fail.png` }).catch(() => {}); }
    await ctx.close(); a.client.close(); b.client.close();
  }
  await br.close();
}
console.log("pass", pass, "fail", fail); process.exit(fail ? 1 : 0);
