import pw from "/workspace/dm-e2e/node_modules/playwright/index.mjs";
import { execSync } from "node:child_process";
const BASE = "http://127.0.0.1:3345";
const U = JSON.parse(execSync("npx tsx /workspace/calls/mkusers.mts", { cwd: "/workspace/openlounge", env: { ...process.env, WS: "ws://127.0.0.1:3345/ws" } }).toString());
const W = [375, 820, 412, 1280];
let pass = 0, fail = 0;
const check = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", n, x); };
for (const eng of ["chromium", "webkit", "firefox"]) {
  const b = await pw[eng].launch();
  for (const w of W) {
    const c = await b.newContext({ viewport: { width: w, height: w < 500 ? 844 : 900 } });
    await c.addInitScript((u) => { if (localStorage.getItem("openlounge:uid")) return; localStorage.setItem("openlounge:session", u.refresh); localStorage.setItem("openlounge:access", JSON.stringify({ t: u.access, exp: Date.now() + 3e6 })); localStorage.setItem("openlounge:uid", u.uid); localStorage.setItem("openlounge:saved", String(Date.now())); }, U.a);
    const p = await c.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    await p.goto(`${BASE}/stickers`); await p.waitForSelector('[data-testid="pack-row"]', { timeout: 20000 });
    await p.waitForTimeout(800);
    const titles = await p.$$eval('[data-testid="pack-row"]', (els) => els.map((e) => e.textContent || ""));
    const gi = titles.findIndex((t) => t.includes("Celebrations")), fi = titles.findIndex((t) => t.includes("Fluent Faces"));
    check(`${eng} ${w}: Fluent packs listed after Google's five`, fi > gi && gi >= 0 && titles.filter((t) => t.includes("Fluent")).length === 8, `google@${gi} fluent@${fi} rows=${titles.length}`);
    const hscroll = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    check(`${eng} ${w}: no horizontal overflow`, !hscroll);
    await p.screenshot({ path: `/workspace/fluent-shots/${eng}-${w}-store.png`, fullPage: true });
    await p.goto(`${BASE}/stickers/fluent-faces`); await p.waitForTimeout(2500);
    const imgs = await p.$$eval('img[src*="/sticker-files/fluent/"]', (els) => els.slice(0, 24).map((e) => [e.complete && e.naturalWidth > 0, e.getAttribute("src")]));
    check(`${eng} ${w}: Fluent pack page renders animated stickers`, imgs.length >= 12 && imgs.every((x) => x[0]), `${imgs.length} imgs, ok=${imgs.filter((x) => x[0]).length}`);
    const attr = await p.locator('[data-testid="pack-attribution"]').textContent().catch(() => "");
    check(`${eng} ${w}: MIT / Microsoft attribution shown`, /MIT/.test(attr) && /Microsoft/.test(attr));
    await p.screenshot({ path: `/workspace/fluent-shots/${eng}-${w}-pack.png` });
    check(`${eng} ${w}: no page errors`, errs.length === 0, errs.join(" | ").slice(0, 200));
    await c.close();
  }
  await b.close();
}
console.log(JSON.stringify({ pass, fail }));
