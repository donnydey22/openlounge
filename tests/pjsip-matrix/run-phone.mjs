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
const PHONE = process.env.PHONE || "linux", SECONDS = Number(process.env.CELL_SECONDS || 30);
const SLACK = Number(process.env.PHONE_SLACK || { linux: 3, android: 20, ios: 240 }[PHONE]); // phone process launch time
const out = path.resolve("tests/pjsip-matrix/results"); fs.mkdirSync(out, { recursive: true });
const tone = path.resolve("tests/pjsip-matrix/tone.wav");
const key = () => Buffer.from(Array.from({ length: 30 }, () => Math.floor(Math.random() * 256))).toString("base64");

const drivers = {
  linux: async (p) => { const { stdout, stderr } = await run(path.resolve("tests/pjsip-matrix/engine/olsfu_cli"), [p.ip, p.port, p.tx, p.rx, p.ssrc, p.txPt, p.rxPt, SECONDS], { timeout: (SECONDS + 30) * 1000, maxBuffer: 1 << 26 });
    const log = fs.existsSync("/tmp/olsfu.log") ? fs.readFileSync("/tmp/olsfu.log", "utf8").split("\n").filter((l) => /strm|srtp|udp|conf|Error|fail|pkt|RX|TX/i.test(l)).slice(0, 80).join("\n") : "";
    console.log("[olsfu_cli]", log, stderr.slice(-2000)); return JSON.parse(stdout.split("\n").find((l) => l.startsWith("{"))); },
  android: async (p) => { const args = ["shell", "am", "instrument", "-w", "-e", "class", "com.donnydey.openlounge.pjsip.SfuLegTest"];
    for (const [k, v] of Object.entries({ ...p, ip: "10.0.2.2", seconds: SECONDS })) args.push("-e", k, String(v));
    const { stdout } = await run("adb", [...args, "com.donnydey.openlounge.callengine.test/androidx.test.runner.AndroidJUnitRunner"], { timeout: (SECONDS + 90) * 1000 });
    const m = /olresult=(\{.*\})/.exec(stdout); if (!m) { const lc = crashHead((await run("adb", ["logcat", "-d", "-b", "all", "-t", "3000"], { maxBuffer: 1 << 26 })).stdout); console.log("[logcat]\n" + lc); throw new Error(`no olresult: ${stdout.slice(-800)}`); } return JSON.parse(m[1]); },
  ios: async (p) => { const f = "/tmp/olsfu-ios.json"; fs.rmSync(f, { force: true });
    const env = { ...process.env }; for (const [k, v] of Object.entries({ ...p, seconds: SECONDS, out: f })) env[`TEST_RUNNER_OL_${k.toUpperCase()}`] = String(v);
    await run("bash", ["-c", process.env.IOS_TEST_CMD], { env, timeout: (SECONDS + 300) * 1000, maxBuffer: 1 << 26 });
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

if (!fs.existsSync(tone)) await import("./run-browser.mjs?tone-only").catch(() => {});
const stack = await startCiSfu({ httpPort: 8099 });
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${tone}`, "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ permissions: ["microphone", "camera"] }); const W = await ctx.newPage();
W.on("pageerror", (e) => console.log("[web] pageerror", e.message));
await W.goto(`${stack.base}/tests/pjsip-matrix/browser/call.html`); await W.waitForFunction(() => window.olReady); await W.evaluate(() => window.olSignal("web"));
const phoneWs = new WebSocket(`${stack.base.replace("http", "ws")}/signal?token=phone`); const pmsgs = []; phoneWs.on("message", (d) => pmsgs.push(JSON.parse(d)));
await new Promise((r) => phoneWs.on("open", r));
const pwait = async (t) => { for (let i = 0; i < 300; i++) { const k = pmsgs.findIndex((m) => m.t === t); if (k >= 0) return pmsgs.splice(k, 1)[0]; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`phone: no ${t}`); };
const rpc = async (callId, method, payload = {}) => { const r = await fetch(`${stack.base}/rpc`, { method: "POST", body: JSON.stringify({ callId, userId: "phone", method, payload }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };

async function oneCall(phoneCalls) {
  let callId;
  if (phoneCalls) { phoneWs.send(JSON.stringify({ t: "call:new", to: "web", kind: "audio", route: "sfu" })); callId = (await W.evaluate(() => window.__sig.wait("call:incoming"))).callId; await W.evaluate((id) => window.__sig.send({ t: "call:accept", callId: id }), callId); await pwait("call:accepted"); }
  else { await W.evaluate(() => window.__sig.send({ t: "call:new", to: "phone", kind: "audio", route: "sfu" })); callId = (await pwait("call:incoming")).callId; phoneWs.send(JSON.stringify({ t: "call:accept", callId })); await W.evaluate(() => window.__sig.wait("call:accepted")); }
  const webP = W.evaluate((o) => window.olCall(o), { callId, userId: "web", relayUrl: stack.relayUrl, video: false, seconds: SECONDS + SLACK });
  const c = await rpc(callId, "plain:create"); const tx = key(); const ssrc = 100000 + Math.floor(Math.random() * 1e6);
  await rpc(callId, "plain:connect", { srtpParameters: { cryptoSuite: "AES_CM_128_HMAC_SHA1_80", keyBase64: tx } });
  await rpc(callId, "plain:produce", { kind: "audio", ssrc, payloadType: 111 });
  let cons = []; for (let i = 0; i < 100 && !cons.length; i++) { cons = (await rpc(callId, "plain:consume")).consumers; if (!cons.length) await new Promise((r) => setTimeout(r, 200)); }
  if (!cons.length) throw new Error("phone: browser producer never appeared");
  const phone = await drivers[PHONE]({ ip: c.ip, port: c.port, tx, rx: c.srtpParameters.keyBase64, ssrc, txPt: 111, rxPt: cons[0].payloadType }).catch((e) => ({ error: String(e.message).slice(0, 400) }));
  if (process.env.TSTATS !== "0") console.log("[tstats]", JSON.stringify(await (await fetch(`${stack.base}/tstats`)).json()).slice(0, 6000));
  await rpc(callId, "plain:close"); const web = await webP;
  phoneWs.send(JSON.stringify({ t: "call:leave", callId })); await new Promise((r) => setTimeout(r, 800));
  const st = await (await fetch(`${stack.base}/stats`)).json(); const clean = st.sessions === 0 && st.transports === 0 && st.calls === 0;
  const webOk = web.srtpErr === 0 && web.rms > 0.05;
  return { phone: { ...phone, pass: phonePass(phone), srtpErr: phone.error ? 1 : 0, teardownClean: clean }, web: { ...web, pass: webOk, teardownClean: clean } };
}
const runId = process.env.GITHUB_RUN_ID ?? "local"; const name = PHONE === "ios" ? "iphone" : PHONE;
for (const phoneCalls of [true, false]) {
  const a = await oneCall(phoneCalls), b = await oneCall(phoneCalls);
  const cells = phoneCalls ? { [`${name}-browser-audio-fwd`]: ["web", a, b], [`${name}-browser-audio-rev`]: ["phone", a, b] } : { [`browser-${name}-audio-fwd`]: ["phone", a, b], [`browser-${name}-audio-rev`]: ["web", a, b] };
  for (const [id, [side, x, y]] of Object.entries(cells)) {
    const r = { id, run: runId, ...x[side], redialPass: y[side].pass && y[side].teardownClean, redial: y[side] };
    if (PHONE !== "linux") fs.writeFileSync(path.join(out, `${id}.json`), JSON.stringify(r, null, 1));
    console.log(id, JSON.stringify({ pass: r.pass, redial: r.redialPass, teardown: r.teardownClean, rms: r.rms, rxPkt: r.rxPkt, txPkt: r.txPkt, avgLevel: r.avgLevel, error: r.error }));
  }
}
await browser.close(); await stack.close(); process.exit(0);
