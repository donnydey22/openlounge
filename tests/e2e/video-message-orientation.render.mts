import fs from "node:fs";
import path from "node:path";
import pw from "playwright";
import { phoneLogin } from "../unified-auth/harness";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3356";
const WS = process.env.WS_URL ?? BASE.replace(/^http/, "ws") + "/ws";
const OUT = process.env.ORIENTATION_OUT ?? "/home/ubuntu/validation/video-message-orientation";
const SIZES: [number, number][] = [[375, 812], [412, 915], [820, 1180], [1280, 800]];
const ENGINES = (process.env.ENGINES ?? "chromium,firefox,webkit").split(",") as ("chromium" | "firefox" | "webkit")[];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const phone = () => `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
const suffix = () => Math.random().toString(36).slice(2, 8);
const results: { engine: string; viewport: string; checks: { name: string; ok: boolean; detail?: string }[] }[] = [];

function report(engine: string, viewport: string, name: string, ok: boolean, detail?: string) {
  const row = results.find((entry) => entry.engine === engine && entry.viewport === viewport)!;
  row.checks.push({ name, ok, detail });
  console.log(ok ? "PASS" : "FAIL", `${engine} ${viewport}: ${name}`, detail ?? "");
}

async function openRecorder(page: pw.Page) {
  await page.locator("[data-testid=attach-button]:visible").first().click();
  await page.locator("[data-testid=attach-video-message]").click();
  const sheet = page.locator("[data-testid=video-recorder]");
  await sheet.waitFor({ timeout: 10_000 });
  return sheet;
}

async function recordAndSend(page: pw.Page, facing: "user" | "environment", engine: string, viewport: string) {
  const sheet = await openRecorder(page);
  if (facing === "environment") {
    await page.getByRole("button", { name: "Switch camera" }).click();
  }
  const toggle = page.locator("[data-testid=video-recorder-toggle]");
  await page.waitForFunction(() => !(document.querySelector("[data-testid=video-recorder-toggle]") as HTMLButtonElement | null)?.disabled, null, { timeout: 12_000 });
  const liveTransform = await page.locator("[data-testid=video-recorder-live]").evaluate((node) => getComputedStyle(node).transform);
  const liveIsMirrored = liveTransform.startsWith("matrix(-1,");
  report(engine, viewport, `${facing} live preview mirror`, facing === "user" ? liveIsMirrored : !liveIsMirrored, liveTransform);

  await toggle.click();
  await sleep(1_050);
  await toggle.click();
  const review = page.locator("[data-testid=video-recorder-review]");
  await review.waitFor({ timeout: 12_000 });
  const reviewTransform = await review.evaluate((node) => getComputedStyle(node).transform);
  report(engine, viewport, `${facing} saved preview has no CSS transform (flip is in the pixels)`, reviewTransform === "none", reviewTransform);
  await page.screenshot({ path: path.join(OUT, `${engine}-${viewport}-${facing}-review.png`) });

  await page.locator("[data-testid=video-recorder-use]").click();
  await page.locator("[data-testid=attach-send]").click({ timeout: 12_000 });
  const bubble = page.locator("[data-testid=media-video]").last();
  await bubble.waitFor({ timeout: 20_000 });
  const mirroredDescendant = await bubble.locator("video").evaluateAll((nodes) => nodes.some((node) => getComputedStyle(node).transform !== "none"));
  report(engine, viewport, `${facing} rendered bubble has no mirror transform`, !mirroredDescendant);
  await page.screenshot({ path: path.join(OUT, `${engine}-${viewport}-${facing}-sent.png`) });
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const engine of ENGINES) {
  const browser = await pw[engine].launch(
    engine === "chromium"
      ? { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] }
      : engine === "firefox"
        ? { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true } }
        : {},
  );
  for (const [width, height] of SIZES) {
    const viewport = `${width}x${height}`;
    results.push({ engine, viewport, checks: [] });
    const sender = await phoneLogin(WS, phone(), { firstName: "Orientation", username: `orientation_${suffix()}` });
    const recipient = await phoneLogin(WS, phone(), { firstName: "Viewer", username: `viewer_${suffix()}` });
    await recipient.client.req("dm:send", { to: sender.res.user.id, text: "video orientation fixture" });
    const context = await browser.newContext({
      viewport: { width, height },
      ...(engine === "chromium" ? { permissions: ["camera", "microphone"] as any } : {}),
      ...(width < 1000 && engine !== "firefox" ? { hasTouch: true, isMobile: engine === "chromium" } : {}),
    });
    await context.addInitScript(
      (session) => {
        localStorage.setItem("openlounge:session", session.refresh);
        localStorage.setItem("openlounge:access", JSON.stringify({ t: session.access, exp: Date.now() + 3_600_000 }));
        localStorage.setItem("openlounge:uid", session.uid);
        localStorage.setItem("openlounge:saved", String(Date.now()));
      },
      { refresh: sender.res.refresh ?? sender.res.token, access: sender.res.access, uid: sender.res.user.id },
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${BASE}/messages/${recipient.res.user.id}`, { waitUntil: "networkidle" });
      const notNow = page.getByRole("button", { name: "Not now" });
      if (await notNow.isVisible().catch(() => false)) await notNow.click();
      if (engine === "webkit") {
        const sheet = await openRecorder(page);
        await sleep(1_500);
        const text = await sheet.innerText();
        report(engine, viewport, "headless WebKit camera failure is graceful", /Camera unavailable|Allow camera|isn't supported/.test(text), text.slice(0, 120));
        await page.screenshot({ path: path.join(OUT, `${engine}-${viewport}-graceful.png`) });
      } else {
        await recordAndSend(page, "user", engine, viewport);
        await recordAndSend(page, "environment", engine, viewport);
      }
      report(engine, viewport, "no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    } catch (error) {
      report(engine, viewport, "orientation flow", false, String(error).slice(0, 300));
      await page.screenshot({ path: path.join(OUT, `${engine}-${viewport}-failure.png`) }).catch(() => {});
    } finally {
      await context.close();
      sender.client.close();
      recipient.client.close();
    }
  }
  await browser.close();
}

fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2) + "\n");
const failures = results.flatMap((row) => row.checks.filter((check) => !check.ok).map((check) => `${row.engine} ${row.viewport}: ${check.name}`));
console.log(`checks=${results.reduce((sum, row) => sum + row.checks.length, 0)} failures=${failures.length}`);
if (failures.length) process.exit(1);
