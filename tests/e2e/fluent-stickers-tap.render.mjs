import pw from "playwright";
import { execSync } from "node:child_process";
const BASE = "http://127.0.0.1:3345";
const U = JSON.parse(execSync("npx tsx /workspace/e2e/mkusers.mts", { cwd: "/workspace/fl-tap" }).toString());
let pass = 0, fail = 0;
const check = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", n, x); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const eng of ["chromium", "webkit", "firefox"]) {
  const b = await pw[eng].launch();
  for (const w of [375, 412, 800, 820, 1024, 1280]) {
    const c = await b.newContext({ viewport: { width: w, height: w < 500 ? 844 : 900 } });
    await c.addInitScript((u) => { if (localStorage.getItem("openlounge:uid")) return; localStorage.setItem("openlounge:session", u.refresh); localStorage.setItem("openlounge:access", JSON.stringify({ t: u.access, exp: Date.now() + 3e6 })); localStorage.setItem("openlounge:uid", u.uid); localStorage.setItem("openlounge:saved", String(Date.now())); }, U.a);
    const p = await c.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    const tag = `${eng} ${w}`;
    try {
      await p.goto(`${BASE}/stickers`); await p.waitForSelector('[data-testid="pack-row"]', { timeout: 20000 }); await sleep(800);
      const rowSrcs = await p.$$eval('img[src*="/sticker-files/fluent/"]', (e) => e.map((x) => x.getAttribute("src")));
      check(`${tag}: store rows show Fluent stills`, rowSrcs.length > 0 && rowSrcs.every((s) => s.includes("/fluent/p/")), `${rowSrcs.length} imgs`);
      await p.goto(`${BASE}/stickers/fluent-faces`); await sleep(2000);
      const srcs = await p.$$eval('img[src*="/sticker-files/fluent/"]', (e) => e.slice(0, 30).map((x) => [x.getAttribute("src"), x.complete && x.naturalWidth > 0]));
      check(`${tag}: pack view opens on still posters (loaded)`, srcs.length >= 12 && srcs.every(([s, ok]) => s.includes("/fluent/p/") && ok), `${srcs.length} imgs`);
      await p.screenshot({ path: `/workspace/fl-shots/${eng}-${w}-still.png` });
      const cell = p.locator('[role=img]').nth(2);
      const box = await cell.boundingBox();
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down(); await p.mouse.up();
      await sleep(400);
      const playing = await cell.locator("img").getAttribute("src");
      check(`${tag}: tap plays the animation`, /\/fluent\/[\w-]+\.webp$/.test(playing) && !playing.includes("/p/"), playing);
      await p.screenshot({ path: `/workspace/fl-shots/${eng}-${w}-tap.png` });
      await sleep(3500);
      const after = await p.locator('[role=img]').nth(2).locator("img").getAttribute("src");
      check(`${tag}: back to the still after one play`, after.includes("/fluent/p/"), after);
      const others = await p.$$eval('img[src*="/sticker-files/fluent/"]', (e) => e.filter((x) => !x.getAttribute("src").includes("/p/")).length);
      check(`${tag}: only the tapped sticker animated`, others === 0, String(others));
      await p.goto(`${BASE}/stickers/noto-faces`); await sleep(2500);
      const canv = await p.locator("canvas").count();
      check(`${tag}: Google pack unchanged (Lottie still auto-plays)`, canv > 0, `${canv} canvases`);
      check(`${tag}: no page errors`, errs.length === 0, errs.join("|").slice(0, 200));
    } catch (e) { check(`${tag}: run`, false, String(e).slice(0, 300)); }
    await c.close();
  }
  await b.close();
}
console.log(JSON.stringify({ pass, fail }));
process.exit(0);
