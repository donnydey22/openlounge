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
if (process.env.LOSS_CELL === "1") { // 45 % UDP loss (tc netem on lo, UDP only = relay<->SFU media legs) for 10 s mid-call, then clean
  const { execSync } = await import("node:child_process"); const sh = (c) => { try { execSync(c, { stdio: "pipe" }); } catch (e) { console.log("[netem]", c, String(e.stderr || e.message).slice(0, 200)); } };
  const LOSS = Number(process.env.LOSS_PCT || 45); let lossOn = 0, lossOff = 0;
  setTimeout(() => { sh("sudo tc qdisc add dev lo root handle 1: prio"); sh(`sudo tc qdisc add dev lo parent 1:3 handle 30: netem loss ${LOSS}%`);
    sh("sudo tc filter add dev lo parent 1:0 protocol ip prio 1 u32 match ip protocol 17 0xff flowid 1:3"); lossOn = Date.now(); }, 10_000);
  setTimeout(() => { sh("sudo tc qdisc del dev lo root"); lossOff = Date.now(); }, 20_000);
  const r = await oneCall("audio"); sh("sudo tc qdisc del dev lo root");
  const per = (x) => { const b = x.audioSec || {}; const ks = Object.keys(b).map(Number).sort((a, c) => a - c);
    const inLoss = ks.filter((k) => k * 1000 >= lossOn + 1000 && (k + 1) * 1000 <= lossOff); const after = ks.filter((k) => k * 1000 >= lossOff);
    const rec = after.find((k) => b[k] >= 45); return { lossRxPct: inLoss.length ? Math.round(inLoss.reduce((a, k) => a + b[k], 0) / (inLoss.length * 50) * 100) : null,
      recoveryMs: rec !== undefined ? Math.max(0, (rec + 1) * 1000 - lossOff) : null, callSurvived: after.length > 0, rms: +x.rms.toFixed(3) }; };
  for (const d of ["fwd", "rev"]) { const m = per(r[d]); const cell = { id: `browser-browser-loss${LOSS}-${d}`, run, lossPct: LOSS, ...m, pass: m.callSurvived && m.recoveryMs !== null && m.recoveryMs <= 2000 && r[d].srtpErr === 0 };
    fs.writeFileSync(path.join(out, `${cell.id}.json`), JSON.stringify(cell, null, 1)); console.log(cell.id, JSON.stringify(cell)); }
}
await browser.close(); await stack.close(); process.exit(0);
}
