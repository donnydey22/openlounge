// Call start/end smoothness: the real CallOverlay with a stub engine + fake camera feeds, recorded at 25 fps, every
// frame classified (ringing screen / black / light theme flash / remote / native / faded). Two scenarios:
//   web    — Android / web callee or caller: ringing → connect → first remote frame 300 ms later → hang up
//   native — iPhone app caller (app-owned RTCViews under a transparent page, theme-coloured app root behind it)
// Run: OUT=/tmp/cse LINGER=650 node --import tsx tests/e2e/call-start-end.render.mts
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
const pw = (await import(process.env.PW_MODULE || "playwright")).default;
const OUT = process.env.OUT || "/tmp/call-start-end";
const LINGER = Number(process.env.LINGER || 650); // engine linger for a connected video call (before this branch: 1800)
const THEME_BG = process.env.THEME_BG || "#f4f4f5"; // iOS app root view colour (light theme shows the flash best)
mkdirSync(OUT, { recursive: true });

const stub = (p: string) => path.resolve("tests/e2e/stubs", p);
const res = await build({
  entryPoints: ["tests/e2e/call-start-end.entry.tsx"], bundle: true, write: false, format: "iife", outdir: "/tmp/cse-build", tsconfig: "tsconfig.json",
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
const html = (native: boolean) => `<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${tw}\n${css}\nhtml,body{margin:0;background:${THEME_BG};font-family:system-ui}
#native-rtc{position:fixed;inset:0;visibility:hidden;background:linear-gradient(160deg,#059669,#065f46);color:#fff;font:bold 40px sans-serif;display:grid;place-items:center}</style></head>
<body><div id="phase" style="position:fixed;left:0;bottom:0;width:12px;height:12px;z-index:2147483647;background:#000"></div>${native ? '<div id="native-rtc">NATIVE KEIKO</div>' : ""}<div id="root"></div><script>${js}</script></body></html>`;

const W = 390, H = 844;
const call = (phase: string) => ({ id: "c1", video: true, phase, callerId: "me", caller: { id: "me", name: "Donny", color: "#10b981", photoUrl: null }, callee: { id: "k", name: "Keiko", color: "#ec4899", photoUrl: null }, createdAt: Date.now(), expiresAt: Date.now() + 60000 });

type Cls = "ringing" | "black" | "light" | "remote" | "native" | "local" | "other";
function classify(rgb: number[]): Cls {
  const [r, g, b] = rgb;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum > 200) return "light";
  if (lum < 10) return "black";
  if (r > 150 && g > 70 && g < 150 && b < 70) return "remote";
  if (g > 70 && g > r + 30 && g > b) return "native";
  if (b > 150 && r < 80) return "local";
  if (lum < 60) return "ringing";
  return "other";
}

const results: Record<string, { timeline: string; counts: Record<string, number>; startGapFrames: number; endFrames: number; end: Record<string, number> }> = {};
// ENG=chromium|firefox|webkit, DEVICE="iPhone 13"|"Pixel 7" (touch + mobile UA; viewport stays W×H so frames compare)
const ENG = (process.env.ENG || "chromium") as "chromium" | "firefox" | "webkit";
const DEV = process.env.DEVICE ? pw.devices[process.env.DEVICE] : null;
const browser = await pw[ENG].launch(ENG === "chromium" ? { args: ["--autoplay-policy=no-user-gesture-required"] } : ENG === "firefox" ? { firefoxUserPrefs: { "media.autoplay.default": 0, "media.autoplay.blocking_policy": 0 } } : {});
// END variants (who hangs up / how): local = I hang up (engine stops tracks, then ended snapshot); remote = the other
// side hangs up (their track ends first, ended arrives ~150 ms later); drop = network drop (remote freezes, 1.5 s of
// "Reconnecting…", then the call ends). web = Android / desktop browser + Android WebView wrapper (same DOM video
// path); native = iPhone app (app-owned RTCViews under a transparent page).
const SCEN = (process.env.SCEN || "web,native,web-remote,web-drop,web-callee,native-remote,web-callee-perm-remote,web-callee-perm-local,web-perm-local").split(",");
for (const scenario of SCEN) {
  const native = scenario.startsWith("native");
  const how = scenario.includes("remote") ? "remote" : scenario.includes("drop") ? "drop" : "local";
  const role = scenario.includes("callee") ? "callee" : "caller";
  // perm-*: a real OS camera/mic prompt is up after Accept / connect: the engine already says camOn (accept(withVideo))
  // but the camera track arrives only when the user taps Allow, PERM ms later (1.5–4 s on phones). perm-remote: the
  // other side's video arrives while the prompt is still up; perm-local: our camera first, the remote later.
  const perm = scenario.includes("perm") ? Number(process.env.PERM || 2500) : 0;
  const permRemoteFirst = scenario.includes("perm-remote");
  const vdir = `${OUT}/vid-${scenario}`;
  rmSync(vdir, { recursive: true, force: true });
  const devOpts = DEV ? { userAgent: DEV.userAgent, hasTouch: true, ...(ENG !== "firefox" ? { isMobile: DEV.isMobile, deviceScaleFactor: 1 } : {}) } : {};
  const ctx = await browser.newContext({ ...devOpts, viewport: { width: W, height: H }, recordVideo: { dir: vdir, size: { width: W, height: H } } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(html(native));
  await page.waitForTimeout(500);
  const S = (fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (window as any).callStub[f as string](...(a as unknown[])), [fn, args] as const);
  const t0 = Date.now();
  const marks: Record<string, number> = {};
  const PHASE: Record<string, string> = { outgoing: "#ff0000", connect: "#00ff00", end: "#0000ff", gone: "#ffffff" };
  const mark = async (k: string) => {
    marks[k] = Date.now() - t0;
    await page.evaluate((c) => (document.getElementById("phase")!.style.background = c), PHASE[k]);
  };
  // ringing (outgoing video call)
  await mark("outgoing");
  await S("set", { call: call("ringing"), role, ui: role === "caller" ? "outgoing" : "incoming", camOn: !perm });
  if (!native && !perm) await S("feed", "local", true);
  await page.waitForTimeout(1500);
  // answered
  await mark("connect");
  await S("set", { call: call("active"), ui: "active", connectedAt: Date.now(), camOn: true, nativeAudio: native, nativeVideo: native, remoteCam: !native });
  if (perm) {
    await S("set", { call: call("active"), ui: "connecting", camOn: true, remoteCam: false, nativeAudio: false, nativeVideo: false });
    const remoteAt = permRemoteFirst ? 600 : perm + 700;
    setTimeout(() => void S("feed", "local", true), perm);
    setTimeout(() => void S("set", { ui: "active", connectedAt: Date.now(), remoteCam: true }).then(() => S("feed", "remote", true)), remoteAt);
    await page.waitForTimeout(Math.max(perm, remoteAt) + 2000);
  } else {
  await S("set", { call: call("active"), ui: "active", connectedAt: Date.now(), camOn: true, nativeAudio: native, nativeVideo: native, remoteCam: !native });
  if (!native) setTimeout(() => void S("feed", "remote", true), 300);
  else setTimeout(() => void S("set", { remoteCam: true }), 500);
  await page.waitForTimeout(3000);
  }
  // hang up: engine tears media down and shows the ended state, then clears after its linger
  if (how === "remote") {
    // far side hung up: their video stops (native: the app's remote RTCView stops updating) ~150 ms before call:ended
    await S("stall", "remote");
    await page.waitForTimeout(150);
  } else if (how === "drop") {
    await S("stall", "remote");
    await S("set", { reconnecting: true });
    await page.waitForTimeout(1500);
  }
  await mark("end");
  // ground truth next to the recording: the screen's computed opacity on every animation frame until unmount
  await page.evaluate(`(() => { const out = (window.__op = []); const tick = () => { const el = document.querySelector('[data-testid="call-screen"]'); if (!el) return; out.push(+getComputedStyle(el).opacity); requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);

  await page.evaluate(() => { const n = document.getElementById("native-rtc"); if (n) n.style.visibility = "hidden"; });
  // same order as engine.endWith: freeze tiles (no-op before the fix), stop tracks, then publish the ended snapshot
  await S("freeze");
  await S("feed", "remote", false);
  await S("feed", "local", false);
  await S("set", { call: call("ended"), ui: "ended", endedText: "Call ended · 0:03", endedVideo: true, reconnecting: false });
  await page.waitForTimeout(LINGER);
  await S("reset");
  await mark("gone");
  await page.waitForTimeout(800);
  const op: number[] = await page.evaluate(() => (window as any).__op);
  const opReversals = op.filter((v, i) => i > 0 && v > op[i - 1] + 0.01).length;
  if (process.env.DEBUG_OP) console.log("OP", scenario, op.length, op.slice(0, 20).map((v) => v.toFixed(2)).join(" "));
  await page.screenshot({ path: `${OUT}/${scenario}-after-gone.png` });
  await ctx.close();
  const f = readdirSync(vdir)[0];
  renameSync(`${vdir}/${f}`, `${OUT}/${scenario}.webm`);
  rmSync(vdir, { recursive: true, force: true });
  // frames → classes (sample the centre band, away from the name/status text and controls)
  const fdir = `${OUT}/frames-${scenario}`;
  rmSync(fdir, { recursive: true, force: true });
  mkdirSync(fdir);
  execFileSync("ffmpeg", ["-loglevel", "error", "-i", `${OUT}/${scenario}.webm`, "-vf", "fps=25,crop=200:160:95:330,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", `${fdir}/px.raw`]);
  const raw = readFileSync(`${fdir}/px.raw`);
  const cls: Cls[] = [];
  for (let i = 0; i + 2 < raw.length; i += 3) cls.push(classify([raw[i], raw[i + 1], raw[i + 2]]));
  // full-res filmstrip around connect and end
  execFileSync("ffmpeg", ["-loglevel", "error", "-i", `${OUT}/${scenario}.webm`, "-vf", "fps=25", `${fdir}/f%04d.png`]);
  const fr = (ms: number) => Math.round((ms / 1000) * 25);
  const nFrames = readdirSync(fdir).filter((x) => x.endsWith(".png")).length;
  // phase marker pixel per frame (bottom-left 12px square)
  execFileSync("ffmpeg", ["-loglevel", "error", "-i", `${OUT}/${scenario}.webm`, "-vf", `fps=25,crop=6:6:3:${H - 9},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", `${fdir}/ph.raw`]);
  const praw = readFileSync(`${fdir}/ph.raw`);
  const phase: string[] = [];
  for (let i = 0; i + 2 < praw.length; i += 3) {
    const [r, g, b] = [praw[i], praw[i + 1], praw[i + 2]];
    phase.push(r > 200 && g > 200 && b > 200 ? "gone" : r > 150 && g < 100 ? "outgoing" : g > 150 && r < 100 ? "connect" : b > 150 && r < 100 ? "end" : "pre");
  }
  const at = (k: string) => phase.indexOf(k, phase.indexOf("outgoing"));
  if (process.env.DBG) console.log("phases", phase.reduce((o: [string, number][], c) => (o.length && o[o.length - 1][0] === c ? o[o.length - 1][1]++ : o.push([c, 1]), o), []).map(([c, n]) => `${c}×${n}`).join(" "), [...praw.slice(praw.length - 30)]);
  const startWin = cls.slice(at("connect"), at("end"));
  const endWin = cls.slice(at("end"), Math.min(cls.length, at("gone") + fr(400)));
  const firstVideo = startWin.findIndex((c) => c === "remote" || c === "native");
  const flash = startWin.slice(0, firstVideo < 0 ? startWin.length : firstVideo).filter((c) => c === "black" || c === "light").length;
  // whole start window (not only before the first video): any black / theme flash, and any fall back to the ringing
  // screen after video was shown (curtain re-shown / tile swap) = a visible blip
  const startBlack = startWin.filter((c) => c === "black" || c === "light").length;
  const isVid = (c: Cls) => c === "remote" || c === "local" || c === "native";
  const steady = startWin.findIndex((c, i) => isVid(c) && isVid(startWin[i + 1]) && isVid(startWin[i + 2])); // 3 frames: not a 1-frame encoder artifact
  const backToRinging = steady < 0 ? 0 : startWin.slice(steady).filter((c) => c === "ringing").length;
  const rle = (a: Cls[]) => a.reduce((o: [Cls, number][], c) => (o.length && o[o.length - 1][0] === c ? o[o.length - 1][1]++ : o.push([c, 1]), o), []).map(([c, n]) => `${c}×${n}`).join(" ");
  // overlay fully gone = first frame showing what is behind it (app shell / theme)
  const goneIdx = endWin.findIndex((c, i) => i > 0 && c === "light");
  // END quality on the raw centre-band colour (one pixel per frame after the 1×1 scale):
  //  staleHold  = frames after the first post-hangup frame still showing the video opaque (≈ the pre-hangup colour)
  //  black      = black frames between hang-up and gone; flicker = the fade reversing direction (a flash / jump)
  //  leftover   = any video-coloured frame after the overlay is gone (a tile left behind)
  const px = (i: number) => [raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]];
  const e0 = at("end");
  const ref = px(Math.max(0, e0 - 2));
  const bg = px(Math.min(cls.length - 1, at("gone") + fr(600)));
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let staleHold = 0, black = 0, flicker = 0, leftover = 0;
  let prev = dist(ref, bg);
  const endIdx = Math.min(cls.length, at("gone") + fr(400));
  for (let i = e0; i < endIdx; i++) {
    const c = px(i), d = dist(c, bg);
    if (i > e0 + 1 && dist(c, ref) < 12 && cls[i] !== "light") staleHold++;
    if (cls[i] === "black") black++;
    if (d > prev + 25) flicker++;
    prev = Math.min(prev, d);
    if (i >= at("gone") && (cls[i] === "remote" || cls[i] === "local" || cls[i] === "native")) leftover++;
  }
  results[scenario] = {
    timeline: `CONNECT: ${rle(startWin)}  ||  END: ${rle(endWin)}`,
    counts: { flashFramesBeforeFirstVideo: flash, startBlackFrames: startBlack, backToRingingFrames: backToRinging, msToFirstVideo: firstVideo * 40, msEndToGone: goneIdx * 40 },
    // whole-window counts apply to the permission scenarios (their start window has no stall / reconnect phase);
    // the original scenarios keep their original measure (web-drop's window includes the 1.5 s frozen-network phase)
    startGapFrames: flash + (perm ? startBlack + backToRinging : 0),
    endFrames: goneIdx,
    end: { staleHoldFrames: staleHold, blackFrames: black, flickerFrames: flicker, leftoverFrames: leftover, opacityReversals: opReversals, msEndToGone: goneIdx * 40 },
  };
  const fi0 = { connect: at("connect"), end: at("end") };
  for (const [k, fi] of Object.entries(fi0)) {
    const pick = Array.from({ length: 10 }, (_, i) => Math.min(nFrames, Math.max(1, fi + 1 + i * 3)));
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...pick.flatMap((n) => ["-i", `${fdir}/f${String(n).padStart(4, "0")}.png`]), "-filter_complex", `${pick.map((_, i) => `[${i}:v]scale=195:422[v${i}]`).join(";")};${pick.map((_, i) => `[v${i}]`).join("")}hstack=inputs=${pick.length}`, `${OUT}/${scenario}-${k}-strip.png`]);
  }
  if (errors.length) console.log("PAGE ERRORS", scenario, errors);
  console.log(scenario, JSON.stringify(results[scenario], null, 1));
}
await browser.close();
// must-pass gate (GATE=1): 0 stale / black / flicker / leftover frames at the end, start gap 0
const bad = Object.entries(results).filter(([, r]) => r.startGapFrames || r.end.staleHoldFrames || r.end.blackFrames || r.end.flickerFrames || r.end.leftoverFrames || r.end.opacityReversals);
console.log("SUMMARY", JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, r]) => [k, { start: r.startGapFrames, ...r.end }]))));
if (process.env.GATE && bad.length) { console.log("GATE FAIL", bad.map(([k]) => k).join(",")); process.exit(1); }
if (process.env.GATE) console.log("GATE PASS");
