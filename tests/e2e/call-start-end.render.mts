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

const results: Record<string, { timeline: string; counts: Record<string, number>; startGapFrames: number; endFrames: number }> = {};
const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
for (const scenario of ["web", "native"] as const) {
  const native = scenario === "native";
  const vdir = `${OUT}/vid-${scenario}`;
  rmSync(vdir, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: vdir, size: { width: W, height: H } } });
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
  await S("set", { call: call("ringing"), role: "caller", ui: "outgoing", camOn: true });
  if (!native) await S("feed", "local", true);
  await page.waitForTimeout(1500);
  // answered
  await mark("connect");
  await S("set", { call: call("active"), ui: "active", connectedAt: Date.now(), camOn: true, nativeAudio: native, nativeVideo: native, remoteCam: !native });
  if (!native) setTimeout(() => void S("feed", "remote", true), 300);
  else setTimeout(() => void S("set", { remoteCam: true }), 500);
  await page.waitForTimeout(3000);
  // hang up: engine tears media down and shows the ended state, then clears after its linger
  await mark("end");
  await page.evaluate(() => { const n = document.getElementById("native-rtc"); if (n) n.style.visibility = "hidden"; });
  // same order as engine.endWith: freeze tiles (no-op before the fix), stop tracks, then publish the ended snapshot
  await S("freeze");
  await S("feed", "remote", false);
  await S("feed", "local", false);
  await S("set", { call: call("ended"), ui: "ended", endedText: "Call ended · 0:03", endedVideo: true });
  await page.waitForTimeout(LINGER);
  await S("reset");
  await mark("gone");
  await page.waitForTimeout(800);
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
  const rle = (a: Cls[]) => a.reduce((o: [Cls, number][], c) => (o.length && o[o.length - 1][0] === c ? o[o.length - 1][1]++ : o.push([c, 1]), o), []).map(([c, n]) => `${c}×${n}`).join(" ");
  // overlay fully gone = first frame showing what is behind it (app shell / theme)
  const goneIdx = endWin.findIndex((c, i) => i > 0 && c === "light");
  results[scenario] = {
    timeline: `CONNECT: ${rle(startWin)}  ||  END: ${rle(endWin)}`,
    counts: { flashFramesBeforeFirstVideo: flash, msToFirstVideo: firstVideo * 40, msEndToGone: goneIdx * 40 },
    startGapFrames: flash,
    endFrames: goneIdx,
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
