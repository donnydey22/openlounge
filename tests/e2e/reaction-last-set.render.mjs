import pw from "playwright";
import { execSync } from "node:child_process";
const BASE = process.env.BASE || "http://127.0.0.1:3346";
const U = JSON.parse(execSync("npx tsx /workspace/e2e/mkdm.mts", { cwd: "/workspace/rx2" }).toString());
const SIZES = [[375, 812, true], [412, 915, true], [800, 1280, true], [820, 1180, true], [1280, 800, false]];
let pass = 0, fail = 0; const sleep = (m) => new Promise((r) => setTimeout(r, m));
const check = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", n, x); };
async function openPicker(page) {
  await page.goto(`${BASE}/messages/${U.b.uid}`);
  const n = page.getByRole("button", { name: "Not now" }); await sleep(400); if (await n.isVisible().catch(() => false)) await n.click();
  const el = page.locator("[data-testid=dm-list] [data-testid=dm-bubble]").last();
  await el.waitFor({ timeout: 20000 }); await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  const p = { clientX: b.x + 20, clientY: b.y + 12, pointerType: "touch", isPrimary: true, bubbles: true, pointerId: 3 };
  await el.dispatchEvent("pointerdown", p);
  await page.locator("[data-testid=reaction-bar]").waitFor({ timeout: 8000 });
  await el.dispatchEvent("pointerup", p); await sleep(400);
  await page.locator("[data-testid=reaction-more]").click();
  await page.locator("[data-testid=emoji-tab-emoji]").waitFor(); await sleep(500);
}
const sel = (page) => page.locator("[role=tablist][aria-label='Emoji sets'] [aria-selected=true]").getAttribute("data-testid");
for (const eng of ["chromium", "webkit", "firefox"]) {
  const br = await pw[eng].launch();
  for (const [w, h, mobile] of SIZES) {
    const o = { viewport: { width: w, height: h } };
    if (mobile && eng !== "firefox") Object.assign(o, { isMobile: eng === "chromium", hasTouch: true });
    const ctx = await br.newContext(o);
    await ctx.addInitScript((u) => { if (localStorage.getItem("openlounge:uid")) return; localStorage.setItem("openlounge:session", u.refresh); localStorage.setItem("openlounge:access", JSON.stringify({ t: u.access, exp: Date.now() + 3e6 })); localStorage.setItem("openlounge:uid", u.uid); localStorage.setItem("openlounge:saved", String(Date.now())); }, U.a);
    const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    const t = `${eng} ${w}`;
    try {
      await openPicker(page);
      check(`${t}: new device opens on Google`, (await sel(page)) === "emoji-tab-google", await sel(page));
      await page.locator("[data-testid=emoji-tab-fluent]").click(); await sleep(500);
      await page.reload(); await openPicker(page);
      check(`${t}: Fluent + reload → opens on Fluent`, (await sel(page)) === "emoji-tab-fluent", await sel(page));
      await page.locator("[data-testid=emoji-tab-emoji]").click(); await sleep(300);
      await page.reload(); await openPicker(page);
      check(`${t}: static emoji tab not remembered (still Fluent)`, (await sel(page)) === "emoji-tab-fluent", await sel(page));
      await page.locator("[data-testid=emoji-tab-google]").click(); await sleep(300);
      await page.reload(); await openPicker(page);
      check(`${t}: Google + reload → opens on Google`, (await sel(page)) === "emoji-tab-google", await sel(page));
      const k = await page.evaluate(() => [localStorage.getItem("ol:reactionSet"), localStorage.getItem("ol:emojiTab")]);
      check(`${t}: composer tab key untouched`, k[0] === "google" && k[1] === null, JSON.stringify(k));
      check(`${t}: no page errors`, errs.length === 0, errs.join("|").slice(0, 200));
    } catch (e) { check(`${t}: run`, false, String(e).slice(0, 250)); }
    await ctx.close();
  }
  await br.close();
}
console.log(JSON.stringify({ pass, fail })); process.exit(0);
