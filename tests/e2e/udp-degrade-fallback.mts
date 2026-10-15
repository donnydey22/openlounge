// Two Chromium peers (fake mic, Opus) over real UDP host candidates; the live getStats() counters feed the same
// QualityGuard the engine uses. Phase 1: clean → must NOT fall back. Phase 2: 30% loss via a local lossy UDP relay → MUST fall back.
// Usage: npx tsx tests/e2e/udp-degrade-fallback.mts
import { chromium } from "playwright";
import dgram from "node:dgram";
import { QualityGuard, QUALITY_SAMPLE_MS, countersFromStats } from "../../src/lib/calls/qualityGuard";

// Lossy UDP relay (kernel netem is unavailable in the sandbox): every candidate B offers to A is rewritten to this
// proxy, so all media A→B (B's inbound audio) crosses it; `loss` / `delayMs` are switched live per phase.
// Both directions go through their own relay so neither peer learns the other's real address (no prflx bypass).
let loss = 0, delayMs = 0;
async function relay() {
  const st = { target: null as { address: string; port: number } | null, src: null as dgram.RemoteInfo | null, seen: 0 };
  const sock = dgram.createSocket("udp4");
  sock.on("message", (m, r) => {
    const t = st.target;
    if (t && r.port === t.port) /* same socket may appear as 127.0.0.1 */ { if (st.src) sock.send(m, st.src.port, st.src.address); return; }
    st.src = r; st.seen++;
    if (!t || Math.random() < loss) return;
    setTimeout(() => { try { sock.send(m, t.port, t.address); } catch { /* closed */ } }, delayMs);
  });
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
  return { st, sock, port: sock.address().port };
}
const toB = await relay(), toA = await relay();
const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--allow-loopback-in-peer-connection", "--disable-features=WebRtcHideLocalIpsWithMdns"] });
const page = await browser.newPage();
await page.route("http://localhost/", (r) => r.fulfill({ contentType: "text/html", body: "<html></html>" }));
await page.addInitScript("window.__name = (f) => f"); // esbuild keepNames helper inside evaluate
await page.goto("http://localhost/"); // secure context for getUserMedia
await page.exposeFunction("__setTarget", (which: string, address: string, port: number) => { const r = which === "b" ? toB : toA; r.st.target ??= { address, port }; });
await page.evaluate(async ([pB, pA]: number[]) => {
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  const via = (from: string, to: RTCPeerConnection, port: number) => async (e: RTCPeerConnectionIceEvent) => {
    const c = e.candidate;
    if (!c || !/ udp /i.test(c.candidate) || !/typ host/.test(c.candidate) || (c.address ?? "").includes(":")) return;
    if ((window as any)["__p" + from]) return;
    (window as any)["__p" + from] = true;
    await (window as any).__setTarget(from, c.address, c.port);
    const parts = c.candidate.split(" "); parts[4] = "127.0.0.1"; parts[5] = String(port);
    const init = { candidate: parts.join(" "), sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex };
    // the far side may not have its remote description yet: retry until it takes
    for (let i = 0; i < 50; i++) { try { await to.addIceCandidate(init); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  };
  b.onicecandidate = via("b", a, pB);
  a.onicecandidate = via("a", b, pA);
  const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  s.getTracks().forEach((t) => a.addTrack(t, s));
  b.ontrack = (e) => { const el = document.createElement("audio"); el.srcObject = e.streams[0]; el.autoplay = true; document.body.append(el); };
  await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription!);
  (window as any).__pcs = [a, b];
  await new Promise<void>((r) => { const t = setInterval(() => b.connectionState === "connected" && (clearInterval(t), r()), 100); });
}, [toB.port, toA.port]);
const sample = async () => {
  const arr: Array<Array<[string, Record<string, unknown>]>> = await page.evaluate(async () =>
    Promise.all((window as any).__pcs.map(async (pc: RTCPeerConnection) => [...(await pc.getStats()).entries()].map(([k, v]) => [k, { ...v }]))));
  return countersFromStats(arr.map((x) => new Map(x)));
};
const run = async (label: string, seconds: number) => {
  const g = new QualityGuard();
  for (let t = 0; t < seconds * 1000; t += QUALITY_SAMPLE_MS) {
    await new Promise((r) => setTimeout(r, QUALITY_SAMPLE_MS));
    const c = await sample();
    const v = g.push(c);
    if (v) { console.log(`${label}: FALLBACK after ${(t + QUALITY_SAMPLE_MS) / 1000}s reasons=${v.reasons} loss=${v.lossPercent?.toFixed(1)}% rtt=${v.rttMs}`); return true; }
  }
  console.log(`${label}: no fallback in ${seconds}s`); return false;
};
let ok = false;
try {
  const clean = await run("clean UDP", 12);
  loss = 0.3; delayMs = 400;
  const degraded = await run("UDP 30% loss + 400ms one-way", 20);
  ok = !clean && degraded;
} finally { console.log(`relay packets a→b=${toB.st.seen} b→a=${toA.st.seen}`); toB.sock.close(); toA.sock.close(); await browser.close(); }
console.log(ok ? "PASS" : "FAIL"); process.exit(ok ? 0 : 1);
