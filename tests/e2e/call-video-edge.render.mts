// #49 / #50 / ring / call bar — real browser checks on Chromium, Firefox, WebKit × 375/412/820/1280 with fake media
// (canvas.captureStream camera feeds). Run: node --import tsx tests/e2e/call-video-edge.render.mts
import { build } from "esbuild";
import { readFileSync } from "node:fs";
const pw = (await import(process.env.PW_MODULE || "playwright")).default;

const bundle = (await build({ entryPoints: ["tests/e2e/call-video-edge.entry.ts"], bundle: true, write: false, format: "iife", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"test"' } })).outputFiles[0].text;
// calls.module.css as plain CSS (no Next): unwrap :global(), keep class names, emulate safe areas by substitution
const moduleCss = (inset: { t: number; l: number; r: number }) =>
  readFileSync("src/components/calls/calls.module.css", "utf8")
    .replace(/:global\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, "$1")
    .replace(/env\(safe-area-inset-top, 0px\)/g, `${inset.t}px`).replace(/env\(safe-area-inset-left, 0px\)/g, `${inset.l}px`).replace(/env\(safe-area-inset-right, 0px\)/g, `${inset.r}px`);
const SIZES: [number, number][] = [[375, 812], [412, 915], [820, 1180], [1280, 800]];
const INSETS = [{ name: "none", t: 0, l: 0, r: 0 }, { name: "dynamic-island", t: 59, l: 0, r: 0 }, { name: "android-status", t: 24, l: 0, r: 0 }, { name: "landscape-notch", t: 0, l: 47, r: 0 }];
const ENGS = (process.env.ENGS || "chromium,firefox,webkit").split(",") as ("chromium" | "firefox" | "webkit")[];
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : x); };
const sleep = (m: number) => new Promise((r) => setTimeout(r, m));

const videoPage = (css: string) => `<!doctype html><html><head><script>window.__name=(f)=>f</script><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>html,body{margin:0;background:#fff}${css}</style></head><body>
<div class="screen" style="position:fixed;inset:0">
  <div class="videoStage" id=stage><video id=big class="stageVideo callVideo" autoplay playsinline muted></video><canvas id=bighold class="stageVideo holdFrame"></canvas></div>
  <div id=pip style="position:absolute;right:12px;top:12px;width:144px;aspect-ratio:9/16;overflow:hidden;background:#09090b;z-index:5"><video id=small class="callVideo" style="position:relative;z-index:1;width:100%;height:100%;object-fit:contain" autoplay playsinline muted></video><canvas id=smallhold class="holdFrame" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain"></canvas></div>
</div><script>${bundle}</script></body></html>`;

const barPage = (css: string, label: string) => `<!doctype html><html data-call-bar><head><script>window.__name=(f)=>f</script><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>html,body{margin:0}${css}.bar{animation:none!important}.sticky{position:sticky;top:0}header{padding-top:24px}</style></head><body>
<button id=bar class="bar" style="display:flex;width:100%;align-items:center;justify-content:center;background:#10b981;color:#fff;border:0;box-sizing:border-box;font:600 13px sans-serif"><span id=barin style="display:flex;height:28px;align-items:center;gap:8px"><span>Maya</span><span>${label}</span><span>· Tap to return</span></span></button>
<header data-app-header class="sticky" style="height:56px;background:#222;color:#fff">Header</header>
<main><h1 id=first style="margin:0">First line of content</h1><p style="height:2000px">…</p></main></body></html>`;

for (const eng of ENGS) {
  const br = await pw[eng].launch(eng === "chromium" ? { args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"] } : eng === "firefox" ? { firefoxUserPrefs: { "media.autoplay.default": 0, "media.autoplay.block-webaudio": false, "media.autoplay.blocking_policy": 0, "media.navigator.permission.disabled": true } } : {});
  for (const [w, h] of SIZES) {
    const t = `${eng} ${w}`;
    const ctx = await br.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const errs: string[] = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.setContent(videoPage(moduleCss({ t: 0, l: 0, r: 0 })));
    // ---------- #49 + #50 ----------
    const r = await page.evaluate(async () => {
      const W = window as any;
      const sleep = (m: number) => new Promise((x) => setTimeout(x, m));
      const cam = (hue: number, cw: number, ch: number) => {
        const c = document.createElement("canvas"); c.width = cw; c.height = ch; const g = c.getContext("2d")!;
        let on = true, n = 0;
        const draw = () => { if (!on) return; n++; g.fillStyle = `hsl(${(hue + n) % 360} 70% 45%)`; g.fillRect(0, 0, cw, ch); g.fillStyle = "#123"; g.fillRect((n * 4) % cw, ch / 3, 40, 40); };
        const id = setInterval(draw, 33); draw();
        const track = (c as any).captureStream(30).getVideoTracks()[0] as MediaStreamTrack;
        return { track, freeze: () => { on = false; }, stop: () => { on = false; clearInterval(id); track.stop(); } };
      };
      const big = document.getElementById("big") as HTMLVideoElement, bh = document.getElementById("bighold") as HTMLCanvasElement;
      const small = document.getElementById("small") as HTMLVideoElement, sh = document.getElementById("smallhold") as HTMLCanvasElement;
      W.holdFrames(big, bh); W.holdFrames(small, sh);
      const remote = cam(200, 720, 1280), local = cam(20, 720, 1280);
      W.swapVideoTrack(big, remote.track); W.swapVideoTrack(small, local.track);
      const bigStream = big.srcObject, smallStream = small.srcObject;
      const probe = document.createElement("canvas"); probe.width = 8; probe.height = 8; const pg = probe.getContext("2d", { willReadFrequently: true })!;
      // classify what is actually visible in a tile: held canvas if shown, else the live video frame
      const visible = (v: HTMLVideoElement, hold: HTMLCanvasElement): "ok" | "blank" | "white" => {
        const held = getComputedStyle(hold).visibility === "visible";
        const src: CanvasImageSource = held ? hold : v;
        if (!held && (!v.videoWidth || v.readyState < 2)) return "blank";
        try { pg.clearRect(0, 0, 8, 8); pg.drawImage(src, 0, 0, 8, 8); } catch { return "blank"; }
        const d = pg.getImageData(0, 0, 8, 8).data; let s = 0, white = 0, empty = 0;
        for (let i = 0; i < d.length; i += 4) { s++; if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) white++; if (d[i + 3] === 0 || d[i] + d[i + 1] + d[i + 2] < 6) empty++; }
        return white > s / 2 ? "white" : empty > s / 2 ? "blank" : "ok";
      };
      const deadline = Date.now() + 8000;
      while ((!big.videoWidth || !small.videoWidth) && Date.now() < deadline) await sleep(50);
      await sleep(700);
      const stage = document.getElementById("stage")!.getBoundingClientRect();
      const vr = big.getBoundingClientRect();
      const fit = getComputedStyle(big).objectFit;
      const expectFit = W.videoFit(big.videoWidth, big.videoHeight, innerWidth, innerHeight);
      // sampler across the blip
      const stats = { big: { ok: 0, blank: 0, white: 0 }, small: { ok: 0, blank: 0, white: 0 }, heldSeen: 0 };
      let run = true;
      const log: string[] = []; (stats as any).log = log; let phase = "pre";
      const tick = () => { if (!run) return; const vb = visible(big, bh); if (vb !== "ok") log.push(phase + ":" + getComputedStyle(bh).visibility + ":" + big.videoWidth + ":" + big.readyState + ":" + bh.width); stats.big[vb]++; stats.small[visible(small, sh)]++; if (getComputedStyle(bh).visibility === "visible") stats.heldSeen++; requestAnimationFrame(tick); };
      tick();
      // blip 1: mute + frames stop (network stall) on both
      phase = "mute"; remote.freeze(); local.freeze();
      remote.track.dispatchEvent(new Event("mute")); local.track.dispatchEvent(new Event("mute"));
      await sleep(1200);
      const heldPixelsDuringStall = visible(big, bh);
      // blip 2: tracks end, new tracks swapped into the same MediaStream (replaceTrack path)
      phase = "stop"; remote.stop(); local.stop();
      big.dispatchEvent(new Event("emptied"));
      await sleep(400);
      const remote2 = cam(120, 720, 1280), local2 = cam(300, 720, 1280);
      phase = "swap"; W.swapVideoTrack(big, remote2.track); W.swapVideoTrack(small, local2.track);
      remote2.track.dispatchEvent(new Event("unmute"));
      let resumedIn = -1; const t0 = performance.now();
      while (performance.now() - t0 < 4000) { if (getComputedStyle(bh).visibility === "hidden" && big.videoWidth) { resumedIn = Math.round(performance.now() - t0); break; } await sleep(16); }
      await sleep(300);
      const playing = !big.paused;
      run = false;
      remote2.stop(); local2.stop();
      return {
        stage: [stage.left, stage.top, stage.width, stage.height], video: [vr.left, vr.top, vr.width, vr.height], fit, expectFit,
        sameStream: big.srcObject === bigStream && small.srcObject === smallStream,
        poster: big.poster + small.poster, controls: big.controls || small.controls, stats, heldPixelsDuringStall, resumedIn, playing,
      };
    });
    check(`${t}: #50 stage fills viewport`, r.stage[0] === 0 && r.stage[1] === 0 && Math.round(r.stage[2]) === w && Math.round(r.stage[3]) === h, JSON.stringify(r.stage));
    check(`${t}: #50 video box edge to edge`, Math.round(r.video[2]) === w && Math.round(r.video[3]) === h, JSON.stringify(r.video));
    check(`${t}: #50 object-fit cover on every size (no bars)`, r.fit === "cover" && r.expectFit === "cover", `${r.fit}/${r.expectFit}`);
    check(`${t}: #49 no poster, no controls`, r.poster === "" && !r.controls, r.poster);
    check(`${t}: #49 srcObject never replaced across blip`, r.sameStream);
    check(`${t}: #49 last frame held during stall (pixels not blank/white)`, r.heldPixelsDuringStall === "ok" && r.stats.heldSeen > 0, JSON.stringify(r));
    check(`${t}: #49 remote never blank/white across blip`, r.stats.big.blank === 0 && r.stats.big.white === 0, JSON.stringify(r.stats.big) + " " + JSON.stringify((r.stats as any).log?.slice(0, 30)));
    check(`${t}: #49 self-view never white/blank`, r.stats.small.white === 0 && r.stats.small.blank === 0, JSON.stringify(r.stats.small));
    check(`${t}: #49 resumes live frames after swap`, r.resumedIn >= 0 && r.playing, String(r.resumedIn));
    check(`${t}: no page errors`, errs.length === 0, errs.join(" | "));
    // ---------- call bar (audio + video call labels, 4 safe-area profiles) ----------
    for (const inset of INSETS) for (const label of ["Audio call 1:23", "Video call 0:42"]) {
      await page.setContent(barPage(moduleCss(inset), label));
      const b = await page.evaluate(() => {
        scrollTo(0, 0);
        const bar = document.getElementById("bar")!.getBoundingClientRect(), inn = document.getElementById("barin")!.getBoundingClientRect();
        const cs = getComputedStyle(document.getElementById("bar")!);
        const hdr = document.querySelector("[data-app-header]")!.getBoundingClientRect(), first = document.getElementById("first")!.getBoundingClientRect();
        scrollTo(0, 600);
        const hdr2 = document.querySelector("[data-app-header]")!.getBoundingClientRect();
        return { barBottom: bar.bottom, pl: cs.paddingLeft, pr: cs.paddingRight, pt: cs.paddingTop, center: inn.left + inn.width / 2, vw: innerWidth, hdrTop: hdr.top, firstTop: first.top, hdrTopScrolled: hdr2.top };
      });
      const tag = `${t} bar ${inset.name} ${label.split(" ")[0]}`;
      check(`${tag}: symmetric padding`, b.pl === b.pr, `${b.pl}/${b.pr}`);
      check(`${tag}: content centered`, Math.abs(b.center - b.vw / 2) <= 1, `${b.center} vs ${b.vw / 2}`);
      check(`${tag}: height 28 + top inset`, Math.round(b.barBottom) === 28 + inset.t && b.pt === `${inset.t}px`, String(b.barBottom));
      check(`${tag}: header + content pushed below bar`, b.hdrTop >= b.barBottom - 0.5 && b.firstTop >= b.barBottom - 0.5 && b.hdrTopScrolled >= b.barBottom - 0.5, JSON.stringify(b));
    }
    // ---------- ring for the full window, stops on answer ----------
    if (w === 375) {
      await page.setContent(`<!doctype html><html><body><script>window.__name=(f)=>f</script><button id=tap>tap</button><script>${bundle}</script></body></html>`);
      await page.evaluate(() => (window as any).installAudioUnlock?.());
      await page.click("#tap");
      for (const kind of ["outgoing", "incoming"]) {
        const rr = await page.evaluate(async (kind) => {
          const W = window as any; const sleep = (m: number) => new Promise((x) => setTimeout(x, m));
          const WINDOW = 6000; // stand-in for the 45 s server window (same code path, shorter)
          W.startRing(kind, { untilMs: Date.now() + WINDOW });
          await sleep(WINDOW - 1700);
          let max = 0; const t0 = performance.now();
          while (performance.now() - t0 < 1400) { max = Math.max(max, W.__olRingLevel()); await sleep(20); }
          const before = { kind: W.__olRing.kind, max, path: W.__olRing.path, ctx: W.__olRing.ctx };
          W.stopTones(); // answer
          await sleep(150);
          return { before, after: { kind: W.__olRing.kind, level: W.__olRingLevel() } };
        }, kind);
        check(`${eng} ring ${kind}: ring state alive just before timeout`, rr.before.kind === kind, JSON.stringify(rr.before));
        if (rr.before.ctx === "running" || rr.before.path === "element") check(`${eng} ring ${kind}: audible just before timeout`, rr.before.max > 0, JSON.stringify(rr.before));
        else console.log("INFO", eng, kind, "headless browser has no running audio output; level not measurable", JSON.stringify(rr.before));
        check(`${eng} ring ${kind}: stops on answer`, rr.after.kind === null && rr.after.level === 0, JSON.stringify(rr.after));
      }
    }
    await ctx.close();
  }
  await br.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
