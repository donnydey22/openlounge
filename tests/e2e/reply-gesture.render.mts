// Reply gesture behavior matrix: Chromium, Firefox, WebKit × 375/412/820/1280; touch + mouse.
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

    // Desktop pointer (a real mouse, pointerType "mouse"). Separate context without touch emulation: Playwright's
    // Firefox suppresses mouse pointer events when hasTouch is on.
    const mcontext = await browser.newContext({ viewport: { width, height } });
    const mpage = await mcontext.newPage();
    mpage.on("pageerror", (error) => errors.push(error.message));
    await mpage.setContent(html);
    // Mouse from the bubble padding: follows the pointer, arms at the threshold, replies on release.
    const start = async (sel: string) => {
      await mpage.locator(sel).scrollIntoViewIfNeeded();
      const box = (await mpage.locator(sel).boundingBox())!;
      return { x: box.x + 30, y: box.y + box.height / 2 };
    };
    const offsetOf = (sel: string) => mpage.locator(sel).evaluate((el) => new DOMMatrix(getComputedStyle(el.closest("[data-testid=reply-swipe-body]")!).transform).m41);
    const iconOf = (sel: string) => mpage.locator(sel).evaluate((el) => {
      const icon = el.closest(".group\\/reply")!.querySelector<HTMLElement>("[data-testid=reply-swipe-icon]")!;
      return { opacity: Number(icon.style.opacity), scale: new DOMMatrix(getComputedStyle(icon).transform).a };
    });
    let p = await start("#mouse-target");
    await mpage.mouse.move(p.x, p.y);
    await mpage.mouse.down();
    await mpage.mouse.move(p.x + 30, p.y, { steps: 6 });
    const mid = await offsetOf("#mouse-target");
    const midIcon = await iconOf("#mouse-target");
    assert.ok(Math.abs(mid - 30) < 1.5, `${tag}: bubble tracks the mouse 1:1 below the threshold (${mid})`);
    assert.ok(midIcon.opacity > 0.3 && midIcon.opacity < 0.8 && midIcon.scale > 0.5 && midIcon.scale < 0.95, `${tag}: icon reveals + scales with the drag (${JSON.stringify(midIcon)})`);
    await mpage.mouse.move(p.x + 120, p.y, { steps: 10 });
    const far = await offsetOf("#mouse-target");
    assert.ok(far > 56 && far <= 96 && far < 80, `${tag}: rubber band past the threshold (${far})`);
    assert.equal((await iconOf("#mouse-target")).opacity, 1, `${tag}: icon fully shown when armed`);
    await mpage.mouse.up();
    assert.ok((await replyLog(mpage)) === "mouse", `${tag}: mouse release past threshold replies`);
    await mpage.waitForTimeout(450);
    assert.ok(Math.abs(await offsetOf("#mouse-target")) < 0.6, `${tag}: springs fully home after release`);

    // Past the threshold then back below it cancels.
    p = await start("#mouse-cancel-target");
    await mpage.mouse.move(p.x, p.y);
    await mpage.mouse.down();
    await mpage.mouse.move(p.x + 80, p.y, { steps: 8 });
    await mpage.mouse.move(p.x + 20, p.y, { steps: 6 });
    await mpage.mouse.up();
    assert.ok(!(await replyLog(mpage)).includes("mouse-cancel"), `${tag}: dragging back below the threshold cancels`);

    // A horizontal drag never fires the tile's click; a plain click still does.
    p = await start("#click-guard-target");
    await mpage.mouse.move(p.x, p.y);
    await mpage.mouse.down();
    await mpage.mouse.move(p.x + 70, p.y, { steps: 8 });
    await mpage.mouse.up();
    let log = await replyLog(mpage);
    assert.ok(log === "mouse,click-guard", `${tag}: swipe replies without a click (${log})`);
    await mpage.waitForTimeout(450);
    p = await start("#click-guard-target");
    await mpage.mouse.click(p.x, p.y);
    assert.ok((await replyLog(mpage)) === "mouse,click-guard,click", `${tag}: plain click still reaches the tile`);

    // Mouse drag across text glyphs selects text as before (no reply, no movement).
    await mpage.locator("#select-target").scrollIntoViewIfNeeded();
    const sbox = (await mpage.locator("#select-target").boundingBox())!;
    await mpage.mouse.move(sbox.x + 10, sbox.y + sbox.height / 2);
    await mpage.mouse.down();
    await mpage.mouse.move(sbox.x + 200, sbox.y + sbox.height / 2, { steps: 10 });
    assert.ok(Math.abs(await offsetOf("#select-target")) < 0.5, `${tag}: text drag does not move the bubble`);
    await mpage.mouse.up();
    const selected = await mpage.evaluate(() => window.getSelection()?.toString() || "");
    assert.ok(selected.length >= 5, `${tag}: text drag still selects text ("${selected}")`);
    assert.ok(!(await replyLog(mpage)).includes("select"), `${tag}: text drag does not reply`);
    await mpage.evaluate(() => window.getSelection()?.removeAllRanges());
    await mcontext.close();
    assert.equal(errors.length, 0, `${tag}: no page errors`);
    passed++;
    await context.close();
  }
  await browser.close();
}
console.log(`${passed}/${ENGINES.length * SIZES.length} reply gesture browser cases passed`);
