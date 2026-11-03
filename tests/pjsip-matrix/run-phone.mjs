// Phone <-> browser audio cells through the CI mediasoup stack. PHONE=android (emulator, instrumented test drives the
// real :callengine ol_sfu.c), PHONE=ios (simulator XCTest drives OpenLoungeCallEngine ol_sfu.c), PHONE=linux (same
// ol_sfu.c on the runner; engine sanity only, not a matrix cell). Signaling = call-signal protocol over WS.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { chromium } from "playwright";
import { startCiSfu } from "./ci-sfu.mjs";
const run = promisify(execFile);
const PHONE = process.env.PHONE || "linux", MEDIA = (process.env.MEDIA || "audio").split(","), SECONDS = Number(process.env.CELL_SECONDS || 30);
const HEADLESS_PACING = process.env.HEADLESS_PACING ? process.env.HEADLESS_PACING === "1" : process.platform === "darwin"; // CI test peer only
const SLACK = Number(process.env.PHONE_SLACK || { linux: 3, android: 20, ios: 240 }[PHONE]); // phone process launch time
const out = path.resolve("tests/pjsip-matrix/results"); fs.mkdirSync(out, { recursive: true });
const tone = path.resolve("tests/pjsip-matrix/tone.wav");
const key = () => Buffer.from(Array.from({ length: 30 }, () => Math.floor(Math.random() * 256))).toString("base64");

const drivers = {
  linux: async (p) => { const env = { ...process.env }; for (const k of ["vip", "vport", "vtx", "vrx", "vssrcs", "vpt"]) if (p[k] !== undefined) env[`OL_${k.toUpperCase()}`] = String(p[k]);
    const { stdout, stderr } = await run(path.resolve("tests/pjsip-matrix/engine/olsfu_cli"), [p.ip, p.port, p.tx, p.rx, p.ssrc, p.txPt, p.rxPt, SECONDS], { env, timeout: (SECONDS + 30) * 1000, maxBuffer: 1 << 26 });
    const log = fs.existsSync("/tmp/olsfu.log") ? fs.readFileSync("/tmp/olsfu.log", "utf8").split("\n").filter((l) => /strm|srtp|udp|conf|Error|fail|pkt|RX|TX/i.test(l)).slice(0, 80).join("\n") : "";
    console.log("[olsfu_cli]", log, stderr.slice(-2000)); return JSON.parse(stdout.split("\n").find((l) => l.startsWith("{"))); },
  android: async (p) => { const args = ["shell", "am", "instrument", "-w", "-e", "class", "com.donnydey.openlounge.pjsip.SfuLegTest"];
    for (const [k, v] of Object.entries({ ...p, ip: "10.0.2.2", seconds: SECONDS })) args.push("-e", k, String(v));
    const { stdout } = await run("adb", [...args, "com.donnydey.openlounge.callengine.test/androidx.test.runner.AndroidJUnitRunner"], { timeout: (SECONDS + 90) * 1000 });
    const m = /olresult=(\{.*\})/.exec(stdout); if (!m) { const lc = crashHead((await run("adb", ["logcat", "-d", "-b", "all", "-t", "3000"], { maxBuffer: 1 << 26 })).stdout); console.log("[logcat]\n" + lc); throw new Error(`no olresult: ${stdout.slice(-800)}`); } return JSON.parse(m[1]); },
  ios: async (p) => { const f = "/tmp/olsfu-ios.json"; fs.rmSync(f, { force: true });
    const env = { ...process.env }; for (const [k, v] of Object.entries({ ...p, seconds: SECONDS, out: f })) env[`TEST_RUNNER_OL_${k.toUpperCase()}`] = String(v);
    await run("bash", ["-c", p.vip ? process.env.IOS_TEST_CMD.replace("testAudioLeg", "testVideoLeg") : process.env.IOS_TEST_CMD], { env, timeout: (SECONDS + 300) * 1000, maxBuffer: 1 << 26 });
    return JSON.parse(fs.readFileSync(f, "utf8")); },
};
/** Tombstone head: signal/abort/cause lines + the first 25 native frames (the deep ART/JUnit frames are noise). */
function crashHead(text) {
  const L = text.split("\n"); const i = L.findIndex((l) => /\*\*\* \*\*\* \*\*\*|Fatal signal/.test(l)); const keep = [];
  for (const l of i < 0 ? L : L.slice(i)) { if (/#(\d+) pc/.test(l) && Number(/#(\d+) pc/.exec(l)[1]) >= 25) continue;
    if (/Fatal signal|signal \d+|Abort message|Cause:|backtrace:|#\d+ pc|AndroidRuntime|UnsatisfiedLink|olpjsip|pjsua|ol_sfu/.test(l)) keep.push(l); }
  return keep.slice(0, 80).join("\n");
}
const phonePass = (r) => !r.error && r.rxPkt >= SECONDS * 50 * 0.8 && r.avgLevel > 10;
// Video (PLAN §14 matrix): phone HW-decoded the browser's WASM H.264 at >= 15 fps, non-black, no decode errors, keyframes seen.
const phoneVideoPass = (r) => !r.error && !r.videoError && r.decFps >= 15 && r.nonBlack > 0 && r.decErr === 0 && r.rxKey >= 2;
const webVideoPass = (w) => w.srtpErr === 0 && w.fps >= 15 && w.nonBlack > 0 && w.decodeErr === 0;

if (!fs.existsSync(tone)) await import("./run-browser.mjs?tone-only").catch(() => {});
const stack = await startCiSfu({ httpPort: 8099 });
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${tone}`, "--autoplay-policy=no-user-gesture-required",
  // macOS runner: the simulator starves a backgrounded Chrome; without these the WASM capture/encode loop drops to ~24-38 pkt/s
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=IntensiveWakeUpThrottling"] });
const ctx = await browser.newContext({ permissions: ["microphone", "camera"] }); const W = await ctx.newPage();
W.on("pageerror", (e) => console.log("[web] pageerror", e.message));
await W.goto(`${stack.base}/tests/pjsip-matrix/browser/call.html`); await W.waitForFunction(() => window.olReady); await W.evaluate(() => window.olSignal("web"));
const phoneWs = new WebSocket(`${stack.base.replace("http", "ws")}/signal?token=phone`); const pmsgs = []; phoneWs.on("message", (d) => pmsgs.push(JSON.parse(d)));
await new Promise((r) => phoneWs.on("open", r));
const pwait = async (t) => { for (let i = 0; i < 300; i++) { const k = pmsgs.findIndex((m) => m.t === t); if (k >= 0) return pmsgs.splice(k, 1)[0]; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`phone: no ${t}`); };
const rpc = async (callId, method, payload = {}) => { const r = await fetch(`${stack.base}/rpc`, { method: "POST", body: JSON.stringify({ callId, userId: "phone", method, payload }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };

async function oneCall(phoneCalls, media = "audio") {
  let callId;
  if (phoneCalls) { phoneWs.send(JSON.stringify({ t: "call:new", to: "web", kind: media, route: "sfu" })); callId = (await W.evaluate(() => window.__sig.wait("call:incoming"))).callId; await W.evaluate((id) => window.__sig.send({ t: "call:accept", callId: id }), callId); await pwait("call:accepted"); }
  else { await W.evaluate((k) => window.__sig.send({ t: "call:new", to: "phone", kind: k, route: "sfu" }), media); callId = (await pwait("call:incoming")).callId; phoneWs.send(JSON.stringify({ t: "call:accept", callId })); await W.evaluate(() => window.__sig.wait("call:accepted")); }
  const webP = W.evaluate((o) => window.olCall(o), { callId, userId: "web", relayUrl: stack.relayUrl, video: media === "video", seconds: SECONDS + SLACK + 600, headlessPacing: HEADLESS_PACING }); // cap only; stopped right after the phone leg ends
  const c = await rpc(callId, "plain:create"); const tx = key(); const ssrc = 100000 + Math.floor(Math.random() * 1e6);
  await rpc(callId, "plain:connect", { srtpParameters: { cryptoSuite: "AES_CM_128_HMAC_SHA1_80", keyBase64: tx } });
  let v = {};
  if (media === "video") { // Video spec v2: own "video" transport, own SRTP key, 3 simulcast SSRCs distinct from audio
    const vc = await rpc(callId, "plain:create", { purpose: "video" }); const vtx = key(); const vs = [1, 2, 3].map((i) => 7_000_000 + i * 100_000 + Math.floor(Math.random() * 90_000));
    await rpc(callId, "plain:connect", { purpose: "video", srtpParameters: { cryptoSuite: "AES_CM_128_HMAC_SHA1_80", keyBase64: vtx } });
    await rpc(callId, "plain:produce", { kind: "video", ssrcs: vs, payloadType: 102, platform: PHONE === "android" ? "android" : "ios" });
    v = { vip: vc.ip, vport: vc.port, vtx, vrx: vc.srtpParameters.keyBase64, vssrcs: vs.join(","), vpt: 102 }; }
  await rpc(callId, "plain:produce", { kind: "audio", ssrc, payloadType: 111 });
  const want = media === "video" ? 2 : 1;
  let cons = []; for (let i = 0; i < 100 && cons.length < want; i++) { cons = cons.concat((await rpc(callId, "plain:consume")).consumers); if (cons.length < want) await new Promise((r) => setTimeout(r, 200)); }
  if (cons.length < want) throw new Error("phone: browser producer never appeared");
  const acons = cons.find((x) => x.kind === "audio");
  const phone = await drivers[PHONE]({ ip: c.ip, port: c.port, tx, rx: c.srtpParameters.keyBase64, ssrc, txPt: 111, rxPt: acons.payloadType, ...v }).catch((e) => ({ error: String(e.message).slice(0, 400) }));
  if (process.env.TSTATS !== "0") console.log("[tstats]", JSON.stringify(await (await fetch(`${stack.base}/tstats`)).json()).slice(0, 6000));
  await W.evaluate(() => window.olStop()); await rpc(callId, "plain:close"); const web = await webP;
  phoneWs.send(JSON.stringify({ t: "call:leave", callId })); await new Promise((r) => setTimeout(r, 800));
  const st = await (await fetch(`${stack.base}/stats`)).json(); const clean = st.sessions === 0 && st.transports === 0 && st.calls === 0;
  const webOk = web.srtpErr === 0 && web.rms > 0.05 && (media === "audio" || webVideoPass(web));
  return { phone: { ...phone, pass: phonePass(phone) && (media === "audio" || phoneVideoPass(phone)), srtpErr: phone.error ? 1 : 0, teardownClean: clean }, web: { ...web, pass: webOk, teardownClean: clean } };
}
let failed = 0;
const runId = process.env.GITHUB_RUN_ID ?? "local"; const name = PHONE === "ios" ? "iphone" : PHONE;
for (const media of MEDIA) for (const phoneCalls of [true, false]) {
  const a = await oneCall(phoneCalls, media), b = await oneCall(phoneCalls, media);
  const cells = phoneCalls ? { [`${name}-browser-${media}-fwd`]: ["web", a, b], [`${name}-browser-${media}-rev`]: ["phone", a, b] } : { [`browser-${name}-${media}-fwd`]: ["phone", a, b], [`browser-${name}-${media}-rev`]: ["web", a, b] };
  for (const [id, [side, x, y]] of Object.entries(cells)) {
    const r = { id, run: runId, pacing: HEADLESS_PACING ? "headless pacing" : "audio clock", ...x[side], redialPass: y[side].pass && y[side].teardownClean, redial: y[side] };
    if (PHONE !== "linux") fs.writeFileSync(path.join(out, `${id}.json`), JSON.stringify(r, null, 1));
    if (!(r.pass && r.redialPass && r.teardownClean)) failed++;
    const vk = media === "video" ? { fps: r.fps, nonBlack: r.nonBlack, decodeErr: r.decodeErr, encoder: r.encoder, decFps: r.decFps, decErr: r.decErr, rxAu: r.rxAu, rxKey: r.rxKey, txAu: r.txAu, codec: r.codec, videoError: r.videoError } : {};
    console.log(id, HEADLESS_PACING ? "[headless pacing]" : "", JSON.stringify({ pass: r.pass, redial: r.redialPass, teardown: r.teardownClean, rms: r.rms, rxPkt: r.rxPkt, txPkt: r.txPkt, avgLevel: r.avgLevel, error: r.error, ...vk, diag: r.diag }));
  }
}
await browser.close(); await stack.close(); process.exit(failed && process.env.CELLS_ENFORCE !== "0" ? 1 : 0);
