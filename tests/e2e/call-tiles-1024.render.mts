// FX-061 (Donny t3300u, Oct 24 2026 4:11 AM MST, iPhone b62 → Keiko): the big "Keiko" tile showed Donny's own camera.
// Real CallOverlay + stub engine + fake camera feeds (ME = blue, KEIKO = orange). Must-pass:
//  1. video call connecting, our camera live, Keiko's video not here yet → big tile is a placeholder (never ME), PiP = ME
//  2. Keiko's video arrives → big tile = KEIKO, PiP = ME; tapping the PiP never puts ME in the big tile
// Run: OUT=/tmp/tiles node --import tsx tests/e2e/call-tiles-1024.render.mts
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
const pw = (await import(process.env.PW_MODULE || "playwright")).default;
const OUT = process.env.OUT || "/tmp/call-tiles-1024";
mkdirSync(OUT, { recursive: true });
const stub = (p: string) => path.resolve("tests/e2e/stubs", p);
const res = await build({
  entryPoints: ["tests/e2e/call-start-end.entry.tsx"], bundle: true, write: false, format: "iife", outdir: "/tmp/tiles-build", tsconfig: "tsconfig.json",
  loader: { ".css": "local-css" }, define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /^@\/lib\/calls\/engine$/ }, () => ({ path: stub("callEngineStub.ts") }));
    b.onResolve({ filter: /^@\/lib\/calls\/nativeMediaSession$/ }, () => ({ path: stub("nativeMediaStub.ts") }));
    b.onResolve({ filter: /^@\/components\/AppProvider$/ }, () => ({ path: stub("appProviderStub.ts") }));
  } }],
});
const js = res.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
const css = res.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const tw = execFileSync("node", ["--import", "tsx", "tests/e2e/stubs/tw.mts"], { encoding: "utf8" });
const html = `<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1"><style>${tw}\n${css}\nhtml,body{margin:0;background:#111;font-family:system-ui}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
const call = (phase: string) => ({ id: "c1", video: true, phase, callerId: "me", caller: { id: "me", name: "Donny", color: "#10b981", photoUrl: null }, callee: { id: "k", name: "Keiko", color: "#ec4899", photoUrl: null }, createdAt: Date.now(), expiresAt: Date.now() + 60000 });
const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.setContent(html);
await page.waitForTimeout(300);
const S = (fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (window as any).callStub[f as string](...(a as unknown[])), [fn, args] as const);
// centre pixel of the big tile (away from name/controls) and of the PiP
const px = async (x: number, y: number) => {
  const b = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const raw = execFileSync("ffmpeg", ["-loglevel", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { input: b });
  return [raw[0], raw[1], raw[2]];
};
const isMe = ([r, g, b]: number[]) => b > 150 && r < 90;
const isKeiko = ([r, g, b]: number[]) => r > 150 && g > 70 && g < 160 && b < 70;
let fail = 0;
const check = (ok: boolean, m: string) => { console.log(`${ok ? "ok" : "not ok"} - ${m}`); if (!ok) fail++; };

await S("set", { call: call("active"), role: "caller", ui: "active", connectedAt: Date.now(), camOn: true, remoteCam: false });
await S("feed", "local", true);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/1-connecting-no-remote.png` });
const pip = await page.locator('[data-testid="call-pip-video-local"]').boundingBox();
check(!!pip, "PiP is the local self-view while waiting");
check((await page.locator('[data-testid="call-video-local"]').count()) === 0, "big tile never mounts the local feed");
check(!isMe(await px(195, 600)), "big tile shows no local camera pixels before remote video");
if (pip) check(isMe(await px(pip.x + pip.width / 2, pip.y + pip.height / 2)), "PiP shows the local camera");

await S("set", { remoteCam: true });
await S("feed", "remote", true);
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT}/2-remote-arrived.png` });
check((await page.locator('[data-testid="call-video-remote"]').count()) === 1, "big tile = remote once it arrives");
check(isKeiko(await px(195, 600)), "big tile shows the remote camera");
const pip2 = await page.locator('[data-testid="call-pip-video-local"]').boundingBox();
if (pip2) {
  await page.mouse.click(pip2.x + pip2.width / 2, pip2.y + pip2.height / 2);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/3-after-pip-tap.png` });
  check(isKeiko(await px(195, 600)), "tapping the PiP never moves the self-view into the big tile");
} else check(false, "PiP present after remote video");
await browser.close();
if (errors.length) console.log("PAGE ERRORS", errors);
console.log(fail ? "GATE FAIL" : "GATE PASS");
process.exit(fail ? 1 : 0);
