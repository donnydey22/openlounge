// Shared Telegram-style media contract: a normal photo and an image deliberately sent as a file.
// The matrix runs all supported engines at phone, tablet and desktop widths. Use an HTTPS origin for WebKit:
//   BASE=https://<sandbox-or-staging-host> npm run test:shared-media:render
import pw from "playwright";
import { phoneLogin } from "../unified-auth/harness";

const BASE = process.env.BASE || "http://127.0.0.1:3350";
const WS = BASE.replace(/^http/, "ws") + "/ws";
const PHOTO = process.env.PHOTO || `${process.env.TMPDIR || "/tmp"}/vs-photo.jpg`;
const ENGS = (process.env.ENGS || "chromium,webkit,firefox").split(",") as ("chromium" | "webkit" | "firefox")[];
const SIZES: [number, number][] = (process.env.SIZES || "375x812,412x915,820x1180,1280x800").split(",").map((spec) => {
  const [width, height] = spec.split("x").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error(`Invalid SIZES viewport: ${spec}`);
  return [width, height];
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const phone = () => `+1555${Math.floor(Math.random() * 9e6 + 1e6)}`;
const suffix = () => Math.random().toString(36).slice(2, 8);
let passed = 0, failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  ok ? passed++ : failed++;
  console.log(ok ? "PASS" : "FAIL", label, detail);
};

for (const engine of ENGS) {
  const browser = await pw[engine].launch();
  for (const [width, height] of SIZES) {
    const label = `${engine} ${width}`;
    const sender = await phoneLogin(WS, phone(), { firstName: "Media", username: `media_${suffix()}` });
    const peer = await phoneLogin(WS, phone(), { firstName: "Peer", username: `peer_${suffix()}` });
    await peer.client.req("dm:send", { to: sender.res.user.id, text: "media fixture" });
    const mobile = width < 1000;
    const context = await browser.newContext({ viewport: { width, height }, ...(mobile && engine !== "firefox" ? { hasTouch: true, isMobile: engine === "chromium" } : {}) });
    await context.addInitScript((creds: { refresh: string; access: string; uid: string }) => {
      localStorage.setItem("openlounge:session", creds.refresh);
      localStorage.setItem("openlounge:access", JSON.stringify({ t: creds.access, exp: Date.now() + 3_000_000 }));
      localStorage.setItem("openlounge:uid", creds.uid);
      localStorage.setItem("openlounge:saved", String(Date.now()));
    }, { refresh: sender.res.refresh ?? sender.res.token, access: sender.res.access, uid: sender.res.user.id });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      await page.goto(`${BASE}/messages/${peer.res.user.id}`, { waitUntil: "networkidle", timeout: 60_000 });
      const defer = page.getByRole("button", { name: "Not now" });
      if (await defer.isVisible().catch(() => false)) await defer.click();
      // Both attachment inputs are intentionally hidden and activated by their visible composer buttons.
      // Playwright may still assign files to an attached hidden input.
      await page.locator("[data-testid=attach-input-media]").first().waitFor({ state: "attached", timeout: 20_000 });

      // Photos from upload/paste/gallery retain the existing PR #26 bubble path.
      await page.locator("[data-testid=attach-input-media]").first().setInputFiles(PHOTO);
      await page.locator("[data-testid=attach-send]").click({ timeout: 8_000 });
      const photo = page.locator("[data-testid=media-photo]").last();
      await photo.waitFor({ timeout: 25_000 });
      const photoReady = await page.waitForFunction("() => !document.querySelector('[data-testid=media-cancel]')", null, { timeout: 25_000 }).then(() => true, () => false);
      check(`${label}: uploaded photo uses shared bubble`, photoReady && (await photo.count()) === 1);

      // Slow only the rendered image response. The document tile must keep its icon/blurred placeholder until
      // decode, never introduce a spinner, then cross-fade the sharp thumbnail into place.
      let delayedImages = 0;
      await page.route(/\/media\//, async (route) => {
        if (route.request().resourceType() === "image") {
          delayedImages++;
          await pause(850);
        }
        await route.continue();
      });
      await page.locator("[data-testid=attach-input-file]").first().setInputFiles(PHOTO);
      await page.locator("[data-testid=attach-send]").click({ timeout: 8_000 });
      const documentTile = page.locator("[data-testid=media-document]").last();
      await documentTile.waitFor({ timeout: 25_000 });
      const documentThumb = documentTile.locator("[data-testid=media-document-thumb]");
      await documentThumb.waitFor({ timeout: 25_000 });
      // Upload progress may legitimately use a progress ring. Start watching only once the sent document's
      // signed thumbnail exists, which is the slow-load state covered by the Telegram-style contract.
      await page.evaluate(`(() => {
        const w = window;
        w.__olSharedMediaSpinner = 0;
        w.__olSharedMediaRaf = requestAnimationFrame(function tick() {
          const tiles = document.querySelectorAll("[data-testid=media-document]");
          const tile = tiles.item(tiles.length - 1);
          for (const element of tile?.querySelectorAll(".animate-spin") ?? []) {
            const rect = element.getBoundingClientRect();
            if (rect.width && rect.height && getComputedStyle(element).visibility !== "hidden") w.__olSharedMediaSpinner++;
          }
          w.__olSharedMediaRaf = requestAnimationFrame(tick);
        });
      })()`);
      const initialImageState = await page.evaluate(`(() => {
        const images = document.querySelectorAll("[data-testid=media-document-thumb]");
        const image = images.item(images.length - 1);
        return image ? { opacity: getComputedStyle(image).opacity, className: image.className, complete: image.complete } : null;
      })()`);
      const hiddenBeforeDecode = initialImageState?.opacity === "0";
      const decoded = await page.waitForFunction(`() => {
        const images = document.querySelectorAll("[data-testid=media-document-thumb]");
        const image = images.item(images.length - 1);
        return !!image && image.complete && getComputedStyle(image).opacity === "1";
      }`, null, { timeout: 25_000 }).then(() => true, () => false);
      const spinnerFrames = await page.evaluate(`(() => {
        const w = window;
        if (w.__olSharedMediaRaf) cancelAnimationFrame(w.__olSharedMediaRaf);
        return w.__olSharedMediaSpinner ?? -1;
      })()`);
      check(`${label}: image sent as file is decode-gated`, hiddenBeforeDecode && decoded, `delayed=${delayedImages} initial=${JSON.stringify(initialImageState)}`);
      check(`${label}: shared image file uses no loading wheel`, spinnerFrames === 0, String(spinnerFrames));
      await page.unroute(/\/media\//).catch(() => {});
      check(`${label}: no browser page errors`, pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
    } catch (error) {
      check(`${label}: shared media flow`, false, String(error).slice(0, 500));
      await page.screenshot({ path: `${process.env.TMPDIR || "/tmp"}/openlounge-shared-media-${engine}-${width}.png`, fullPage: true }).catch(() => {});
    } finally {
      await context.close();
      sender.client.close();
      peer.client.close();
    }
  }
  await browser.close();
}

console.log("pass", passed, "fail", failed);
process.exit(failed ? 1 : 0);
