// FX-089 regression: REAL CDP touch input (not synthetic pointer events). Every swipe, incl. slow starts and diagonal drift, must reply.
// Run: node --import tsx tests/e2e/reply-gesture.realtouch.mts
import { build } from "esbuild";
const pw = (await import("playwright")).default;
const bundle = (await build({ entryPoints: ["tests/e2e/reply-gesture.entry.tsx"], bundle: true, write: false, format: "iife", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"test"' } })).outputFiles[0].text;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><div style="height:2000px"></div><script>${bundle}</script></body></html>`;
const b = await pw.chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage(); page.on("console", m => console.log(m.text()));
await page.setContent(html);
await page.evaluate(() => { (window as any).L = []; const o=TouchEvent.prototype.preventDefault; TouchEvent.prototype.preventDefault=function(){(window as any).L.push("PD");return o.call(this)}; for (const t of ["pointerdown","pointermove","pointerup","pointercancel","lostpointercapture","touchstart","touchmove","touchend","touchcancel"]) document.addEventListener(t, (e: any) => (window as any).L.push(t + (e.cancelable===false?"!":"") + (t==="touchstart"||t==="pointerdown" ? "@"+(e.target.id||e.target.tagName+"."+(e.target.dataset?.testid||"")) : "")), true); });
const cdp = await ctx.newCDPSession(page);
for (const [hold, drift] of [[0, 0], [200, 3], [500, 4], [0, 10], [300, 6]]) {
  const box = await page.locator("#text-target").boundingBox();
  const x0 = box!.x + 110, y0 = box!.y + box!.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0 }] });
  await page.waitForTimeout(hold);
  let maxT = "";
  for (let i = 1; i <= 12; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + i * 4, y: y0 + (drift * i) / 12 }] });
    await page.waitForTimeout(16);
    const t = await page.evaluate(() => { const el = document.querySelector("#text-target")?.closest("[data-testid=reply-swipe-body]") as HTMLElement | null; const inner = el?.querySelector("*") as HTMLElement; return (el?.style.transform || "") + "|" + (inner?.style.transform || ""); });
    if (i === 6) maxT = t;
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(900);
  console.log("hold", hold, "drift", drift, "mid transform:", maxT, "log:", await page.locator("[data-testid=reply-log]").textContent(), "scrollY", await page.evaluate(() => scrollY));
  console.log(await page.evaluate(() => { const l=(window as any).L.join(" "); (window as any).L=[]; return l.replace(/(touchmove pointermove )+/g,"[moves] "); }));
}
await b.close();
