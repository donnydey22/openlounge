// Runs matrix cells browser->browser (audio+video, both directions, + redial) in headless Google Chrome against the
// CI stack (ci-sfu.mjs). Writes results/<cell>.json. Phone cells are produced by the iOS/Android harnesses.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { startCiSfu } from "./ci-sfu.mjs";
const SECONDS = Number(process.env.CELL_SECONDS || 30);
const out = path.resolve("tests/pjsip-matrix/results"); fs.mkdirSync(out, { recursive: true });
const tone = path.resolve("tests/pjsip-matrix/tone.wav");
if (!fs.existsSync(tone)) { // 48 kHz mono 16-bit 440 Hz tone, amplitude 0.5, 10 s (looped by Chrome's fake mic)
  const n = 480000, b = Buffer.alloc(44 + n * 2); b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(96000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(16384 * Math.sin((2 * Math.PI * 440 * i) / 48000)), 44 + i * 2); fs.writeFileSync(tone, b); }
if (import.meta.url.endsWith('?tone-only')) { /* imported only to create tone.wav */ } else {
const stack = await startCiSfu();
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${tone}`, "--autoplay-policy=no-user-gesture-required"] });
const page = async (u) => { const ctx = await browser.newContext({ permissions: ["microphone", "camera"] }); const p = await ctx.newPage();
  p.on("console", (m) => m.type() === "error" && console.log(`[${u}]`, m.text())); p.on("pageerror", (e) => console.log(`[${u}] pageerror`, e.message));
  await p.goto(`${stack.base}/tests/pjsip-matrix/browser/call.html`); await p.waitForFunction(() => window.olReady); await p.evaluate((x) => window.olSignal(x), u); return p; };
const A = await page("alice"), B = await page("bob");
const stats = async () => (await fetch(`${stack.base}/stats`)).json();
async function oneCall(media) {
  await A.evaluate((k) => window.__sig.send({ t: "call:new", to: "bob", kind: k, route: "sfu", ack: 1 }), media);
  const inc = await B.evaluate(() => window.__sig.wait("call:incoming"));
  await B.evaluate((id) => window.__sig.send({ t: "call:accept", callId: id }), inc.callId);
  await A.evaluate(() => window.__sig.wait("call:accepted"));
  const opts = (u) => ({ callId: inc.callId, userId: u, relayUrl: stack.relayUrl, video: media === "video", seconds: SECONDS });
  const [ra, rb] = await Promise.all([A.evaluate((o) => window.olCall(o), opts("alice")), B.evaluate((o) => window.olCall(o), opts("bob"))]);
  await A.evaluate((id) => window.__sig.send({ t: "call:leave", callId: id }), inc.callId);
  await B.evaluate(() => window.__sig.wait("call:ended")); await new Promise((r) => setTimeout(r, 500));
  const st = await stats(); const clean = st.sessions === 0 && st.transports === 0 && st.calls === 0;
  const ok = (r) => r.srtpErr === 0 && r.rms > 0.05 && (media === "audio" || (r.fps >= 15 && r.nonBlack > 0 && r.decodeErr === 0));
  return { fwd: { ...rb, pass: ok(rb), teardownClean: clean }, rev: { ...ra, pass: ok(ra), teardownClean: clean } };
}
const run = process.env.GITHUB_RUN_ID ?? "local";
for (const media of ["audio", "video"]) {
  const first = await oneCall(media); const t = Date.now(); const redial = await oneCall(media);
  for (const d of ["fwd", "rev"]) {
    const r = { id: `browser-browser-${media}-${d}`, run, ...first[d], srtpErr: first[d].srtpErr + redial[d].srtpErr, redialPass: redial[d].pass && redial[d].teardownClean && Date.now() - t < (SECONDS + 30) * 1000, redial: redial[d] };
    fs.writeFileSync(path.join(out, `${r.id}.json`), JSON.stringify(r, null, 1)); console.log(r.id, JSON.stringify({ pass: r.pass, rms: +r.rms.toFixed(3), fps: +r.fps.toFixed(1), srtpErr: r.srtpErr, teardown: r.teardownClean, redial: r.redialPass }));
  }
}
await browser.close(); await stack.close(); process.exit(0);
}
