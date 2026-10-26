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
    await swipe(page, "#threshold-target", 9, 80, 260, 25);
    await swipe(page, "#diagonal-target", 10, 80, 280, 64, 40);
    await page.locator("#text-gesture [data-testid=reply-desktop]").click();

    const tag = `${engine} ${width}x${height}`;
    assert.equal(await replyLog(page), "text,visual,album-edge,diagonal,text", `${tag}: only normal text/visual media/edge album swipe and desktop action reply`);

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

    // Links and reaction chips keep their clicks; a drag that starts on them never replies.
    await mpage.locator("#link-target").click();
    await mpage.locator("#reaction-target").click();
    log = await replyLog(mpage);
    assert.ok(log.endsWith("link-click,reaction-click"), `${tag}: link + reaction clicks pass through (${log})`);
    for (const sel of ["#link-target", "#reaction-target"]) {
      const b = (await mpage.locator(sel).boundingBox())!;
      await mpage.mouse.move(b.x + 4, b.y + b.height / 2);
      await mpage.mouse.down();
      await mpage.mouse.move(b.x + 90, b.y + b.height / 2, { steps: 8 });
      await mpage.mouse.up();
      await mpage.evaluate(() => window.getSelection()?.removeAllRanges());
    }
    log = await replyLog(mpage);
    assert.ok(!/(^|,)(link|reaction)(,|$)/.test(log), `${tag}: drags starting on a link/reaction never reply (${log})`);

    // Own (right-aligned) messages swipe the same way.
    p = await start("#own-target");
    await mpage.mouse.move(p.x, p.y);
    await mpage.mouse.down();
    await mpage.mouse.move(p.x + 75, p.y, { steps: 8 });
    await mpage.mouse.up();
    assert.ok((await replyLog(mpage)).endsWith(",own"), `${tag}: own message swipe replies`);
    await mpage.waitForTimeout(450);

    // Trackpad: a horizontal two-finger swipe (wheel deltaX < 0) replies once; vertical scrolling never does.
    await mpage.locator("#wheel-target").scrollIntoViewIfNeeded();
    let wb = (await mpage.locator("#wheel-target").boundingBox())!;
    await mpage.mouse.move(wb.x + 40, wb.y + wb.height / 2);
    const offs: number[] = [];
    for (let i = 0; i < 8; i++) { await mpage.mouse.wheel(-12, 0); await mpage.waitForTimeout(16); offs.push(Math.round(await offsetOf("#wheel-target"))); }
    if (process.env.DBG) console.log("wheel offsets", offs.join(","));
    const wheelMid = await offsetOf("#wheel-target");
    assert.ok(wheelMid > 20, `${tag}: trackpad swipe moves the bubble (${wheelMid})`);
    await mpage.waitForTimeout(600);
    log = await replyLog(mpage);
    assert.ok(log.endsWith(",wheel"), `${tag}: trackpad swipe past the threshold replies once (${log})`);
    assert.ok(Math.abs(await offsetOf("#wheel-target")) < 0.6, `${tag}: trackpad swipe springs home`);
    wb = (await mpage.locator("#wheel-vert-target").boundingBox())!;
    await mpage.mouse.move(wb.x + 40, wb.y + wb.height / 2);
    const y0 = await mpage.evaluate(() => scrollY);
    for (let i = 0; i < 8; i++) { await mpage.mouse.wheel(-3, 40); await mpage.waitForTimeout(16); }
    await mpage.waitForTimeout(600);
    assert.ok(!(await replyLog(mpage)).includes("wheel-vert"), `${tag}: vertical trackpad scroll never replies`);
    assert.ok((await mpage.evaluate(() => scrollY)) > y0, `${tag}: vertical trackpad scroll still scrolls the page`);
    // Leftward horizontal swipe (browser-back direction) is ignored.
    await mpage.locator("#wheel-target").scrollIntoViewIfNeeded();
    wb = (await mpage.locator("#wheel-target").boundingBox())!;
    await mpage.mouse.move(wb.x + 40, wb.y + wb.height / 2);
    const before = await replyLog(mpage);
    for (let i = 0; i < 8; i++) { await mpage.mouse.wheel(12, 0); await mpage.waitForTimeout(16); }
    await mpage.waitForTimeout(600);
    assert.equal(await replyLog(mpage), before, `${tag}: leftward trackpad swipe ignored`);

    // Keyboard: Tab reaches each message's Reply button (visible on focus); Enter replies. Alt+R from a focused link replies.
    await mpage.locator("#text-gesture [data-testid=reply-desktop]").focus();
    await mpage.keyboard.press("Tab");
    const focusedId = await mpage.evaluate(() => document.activeElement?.closest("[data-gesture]")?.getAttribute("data-gesture"));
    assert.equal(focusedId, "visual", `${tag}: Tab moves on through messages (${focusedId})`);
    await mpage.keyboard.press("Shift+Tab");
    const btnOpacity = await mpage.evaluate(() => getComputedStyle(document.activeElement!).opacity);
    assert.equal(btnOpacity, "1", `${tag}: focused Reply button is visible`);
    await mpage.keyboard.press("Enter");
    assert.ok((await replyLog(mpage)).endsWith(",text"), `${tag}: Enter on the focused Reply button replies`);
    await mpage.locator("#link-target").focus();
    await mpage.keyboard.press("Alt+KeyR");
    assert.ok((await replyLog(mpage)).endsWith(",link"), `${tag}: Alt+R inside a message replies to it`);
    await mcontext.close();

    // prefers-reduced-motion: still replies, no spring animation (home immediately).
    const rcontext = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    const rpage = await rcontext.newPage();
    rpage.on("pageerror", (error) => errors.push(error.message));
    await rpage.setContent(html);
    await rpage.locator("#mouse-target").scrollIntoViewIfNeeded(); // WebKit lays the phone page out taller: target can be below the fold
    const rb = (await rpage.locator("#mouse-target").boundingBox())!;
    await rpage.mouse.move(rb.x + 30, rb.y + rb.height / 2);
    await rpage.mouse.down();
    await rpage.mouse.move(rb.x + 120, rb.y + rb.height / 2, { steps: 8 });
    await rpage.mouse.up();
    await rpage.waitForTimeout(60);
    assert.equal(await replyLog(rpage), "mouse", `${tag}: reduced motion still replies`);
    const rOff = await rpage.locator("#mouse-target").evaluate((el) => new DOMMatrix(getComputedStyle(el.closest("[data-testid=reply-swipe-body]")!).transform).m41);
    assert.ok(Math.abs(rOff) < 0.6, `${tag}: reduced motion snaps home without a spring (${rOff})`);
    await rcontext.close();
    assert.equal(errors.length, 0, `${tag}: no page errors`);
    passed++;
    await context.close();
  }
  await browser.close();
}
console.log(`${passed}/${ENGINES.length * SIZES.length} reply gesture browser cases passed`);
