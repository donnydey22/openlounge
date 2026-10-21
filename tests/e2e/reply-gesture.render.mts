// Reply gesture behavior matrix: Chromium, Firefox, WebKit × 375/412/820/1280.
// Run: node --import tsx tests/e2e/reply-gesture.render.mts
import assert from "node:assert/strict";
import { build } from "esbuild";

const pw = (await import("playwright")).default;
const bundle = (await build({
  entryPoints: ["tests/e2e/reply-gesture.entry.tsx"],
  bundle: true,
  write: false,
  format: "iife",
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"test"' },
})).outputFiles[0].text;

const ENGINES = (process.env.ENGS || "chromium,firefox,webkit").split(",") as ("chromium" | "firefox" | "webkit")[];
const SIZES: [number, number][] = (process.env.SIZES || "375x812,412x915,820x1180,1280x800")
  .split(",")
  .map((value) => value.split("x").map(Number) as [number, number]);

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>html,body{margin:0;font:16px system-ui}button{font:inherit}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`;
const swipe = async (page: import("playwright").Page, selector: string, id: number, x: number, y: number, dx: number, dy = 0) => {
  const target = page.locator(selector);
  await target.dispatchEvent("pointerdown", { pointerId: id, pointerType: "touch", isPrimary: true, clientX: x, clientY: y });
  await target.dispatchEvent("pointermove", { pointerId: id, pointerType: "touch", isPrimary: true, clientX: x + dx, clientY: y + dy });
  await target.dispatchEvent("pointerup", { pointerId: id, pointerType: "touch", isPrimary: true, clientX: x + dx, clientY: y + dy });
};
const replyLog = async (page: import("playwright").Page) => (await page.locator("[data-testid=reply-log]").textContent()) || "";

let passed = 0;
for (const engine of ENGINES) {
  const browser = await pw[engine].launch();
  for (const [width, height] of SIZES) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, ...(engine === "chromium" && width < 1000 ? { isMobile: true } : {}) });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent(html);

    await swipe(page, "#text-target", 1, 80, 100, 70);
    await swipe(page, "#visual-target", 2, 80, 120, 70);
    await swipe(page, "#album-owned-target", 3, 80, 140, 70);
    await swipe(page, "#album-edge-target", 4, 80, 160, 70);
    await swipe(page, "#voice-target", 5, 80, 180, 70);
    await swipe(page, "#control-target", 6, 80, 200, 70);
    await swipe(page, "#back-target", 7, 8, 220, 70);
    await swipe(page, "#vertical-target", 8, 80, 240, 8, 70);
    await swipe(page, "#threshold-target", 9, 80, 260, 45);
    await page.locator("#text-gesture [data-testid=reply-desktop]").click();

    const tag = `${engine} ${width}x${height}`;
    assert.equal(await replyLog(page), "text,visual,album-edge,text", `${tag}: only normal text/visual media/edge album swipe and desktop action reply`);
    assert.equal(errors.length, 0, `${tag}: no page errors`);
    passed++;
    await context.close();
  }
  await browser.close();
}
console.log(`${passed}/${ENGINES.length * SIZES.length} reply gesture browser cases passed`);
