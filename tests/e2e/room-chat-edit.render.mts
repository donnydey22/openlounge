import pw from "/workspace/e2e/node_modules/playwright/index.js";
import { phoneLogin } from "/workspace/ol-q8/tests/unified-auth/harness";
const BASE = process.env.BASE || "http://127.0.0.1:3350", WS = "ws://127.0.0.1:3350/ws";
const ph = () => `+1555${Math.floor(Math.random() * 9e6 + 1e6)}`; const r = () => Math.random().toString(36).slice(2, 7);
const sleep = (m: number) => new Promise((x) => setTimeout(x, m));
let pass = 0, fail = 0; const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", n, x); };
const host = await phoneLogin(WS, ph(), { firstName: "Host", username: "host_" + r() });
const room = await host.client.req("room:create", { title: "Edit test" });
await host.client.req("room:join", { roomId: room.roomId });
const SIZES: [number, number][] = [[375, 812], [412, 915], [820, 1180], [1280, 800]];
for (const eng of (process.env.ENGS || "chromium,webkit,firefox").split(",") as ("chromium"|"webkit"|"firefox")[]) {
  const br = await pw[eng].launch();
  for (const [w, h] of SIZES) {
    const u = await phoneLogin(WS, ph(), { firstName: "Donny", username: "donny_" + r() });
    const U = { refresh: u.res.refresh ?? u.res.token, access: u.res.access, uid: u.res.user.id };
    const mobile = w < 1000;
    const ctx = await br.newContext({ viewport: { width: w, height: h }, ...(mobile && eng !== "firefox" ? { hasTouch: true, isMobile: eng === "chromium" } : {}) });
    await ctx.addInitScript((u: any) => { if (localStorage.getItem("openlounge:uid")) return; localStorage.setItem("openlounge:session", u.refresh); localStorage.setItem("openlounge:access", JSON.stringify({ t: u.access, exp: Date.now() + 3e6 })); localStorage.setItem("openlounge:uid", u.uid); localStorage.setItem("openlounge:saved", String(Date.now())); }, U);
    const page = await ctx.newPage(); const errs: string[] = []; page.on("pageerror", (e) => errs.push(e.message));
    const t = `${eng} ${w}`;
    try {
      await page.goto(`${BASE}/room/${room.roomId}`); await sleep(2500);
      const nn = page.getByRole("button", { name: "Not now" }); if (await nn.isVisible().catch(() => false)) await nn.click();
      if (mobile) await page.getByRole("button", { name: "Open room chat" }).click();
      const panel = page.locator("[data-testid=composer-input]:visible").first();
      await panel.waitFor({ timeout: 15000 });
      const orig = `orig ${t}`;
      await panel.fill(orig); await page.getByRole("button", { name: "Send message" }).locator("visible=true").first().click(); await sleep(800);
      const bubble = page.getByText(orig, { exact: true }).first(); await bubble.waitFor({ timeout: 8000 });
      await bubble.click(); await sleep(300);
      const ed = page.locator("[data-testid=room-chat-edit]:visible").first();
      await ed.click({ timeout: 5000 });
      check(`${t}: composer in edit mode`, await page.getByText("Edit message").first().isVisible());
      await panel.fill(`**edited** ${t}`); await page.getByRole("button", { name: "Save edit" }).locator("visible=true").first().click(); await sleep(1000);
      const strong = page.locator("strong, b").filter({ hasText: "edited" }).first();
      check(`${t}: edited text rendered bold`, await strong.isVisible().catch(() => false));
      check(`${t}: "edited" label`, await page.locator("[data-testid=room-chat-edited]:visible").first().isVisible().catch(() => false));
      check(`${t}: old text gone`, (await page.getByText(orig, { exact: true }).count()) === 0);
      const box = await page.locator("[data-testid=composer]:visible").first().boundingBox();
      check(`${t}: composer within viewport`, !!box && box.x >= 0 && box.x + box.width <= w + 1, JSON.stringify(box));
      check(`${t}: no page errors`, errs.length === 0, errs.join("|").slice(0, 200));
      await page.screenshot({ path: `/workspace/e2e/q8edit-${eng}-${w}.png` });
    } catch (e) { check(`${t}: flow`, false, String(e).slice(0, 300)); await page.screenshot({ path: `/workspace/e2e/q8edit-${eng}-${w}-fail.png` }).catch(() => {}); }
    await ctx.close(); u.client.close();
  }
  await br.close();
}
console.log("pass", pass, "fail", fail); process.exit(fail ? 1 : 0);
