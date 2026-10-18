// Optional live prod call smoke (predeploy-gate.sh --live). EXISTING test accounts only:
// caller testverifier2, callee Jordan Ellis, third party Sam Rivera (busy/redial). Never real users.
// Chrome fake media with a tone file. Read-only to config; places short calls between test accounts only.
import { chromium } from "playwright";
import fs from "node:fs";
const BASE = process.env.OL_BASE || "https://openlounge.app";
const TONE = process.env.TONE || "/workspace/lk-test/beeps.wav";
const rd = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const CALLER = { name: "testverifier2", ...rd(process.env.TV || "/workspace/lk-test/.live-tv.json") };
const J = rd(process.env.JORDAN || "/workspace/keiko-fix/.kf-jordan.json"), S = rd(process.env.SAM || "/workspace/keiko-fix/.kf-sam.json");
const CALLEE = { name: "jordan", ...J }, THIRD = { name: "sam", ...S };
const ALLOWED = new Set([CALLER.id, CALLEE.id, THIRD.id]);
if (ALLOWED.size !== 3) throw new Error("account ids must be 3 distinct test accounts");
const res = []; const ok = (n, c, ev) => { res.push({ n, c: !!c, ev }); console.log(`${c ? "PASS" : "FAIL"}  live:${n}  ${JSON.stringify(ev ?? "")}`); };
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "chrome", headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${TONE}`, "--autoplay-policy=no-user-gesture-required"] });
const hook = () => { const O = window.RTCPeerConnection; window.__pcs = []; window.RTCPeerConnection = function (...a) { const p = new O(...a); window.__pcs.push(p); return p; }; window.RTCPeerConnection.prototype = O.prototype; Object.setPrototypeOf(window.RTCPeerConnection, O); };
async function open(u) {
  const ctx = await browser.newContext({ permissions: ["microphone", "camera"], viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(([t, id]) => { localStorage.setItem("openlounge:session", t); localStorage.setItem("openlounge:uid", id); }, [u.tok, u.id]);
  await ctx.addInitScript(hook);
  const p = await ctx.newPage(); p.__u = u; await p.goto(BASE + "/messages"); return p;
}
const audio = (p) => p.evaluate(async () => { let inB = 0, outB = 0, lvl = 0; for (const pc of window.__pcs) { if (pc.connectionState === "closed") continue; (await pc.getStats()).forEach((s) => { if (s.kind === "audio" && s.type === "inbound-rtp") { inB += s.bytesReceived || 0; lvl = Math.max(lvl, s.audioLevel || 0); } if (s.kind === "audio" && s.type === "outbound-rtp") outB += s.bytesSent || 0; }); } return { inB, outB, lvl: +lvl.toFixed(3) }; });
const hide = (p, h) => p.evaluate((h) => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") }); Object.defineProperty(document, "hidden", { configurable: true, get: () => h }); document.dispatchEvent(new Event("visibilitychange")); }, h);
const dial = async (from, to) => { await from.goto(`${BASE}/messages/${to.__u.id}`); await from.getByTestId("dm-call").click({ timeout: 20000 }); };
const hangup = (p) => p.getByTestId("call-end").click({ timeout: 8000 }).catch(() => {});
const mark = (s) => console.log(`MARK ${new Date().toISOString()} ${s}`);
let caller, callee, third;
try {
  [callee, caller, third] = await Promise.all([open(CALLEE), open(CALLER), open(THIRD)]);
  await caller.waitForTimeout(4000);
  // 1+2 connect with callee hidden: ring must reach the backgrounded page (socket ring + ack)
  await hide(callee, true); mark("dial caller->callee (callee hidden)"); const t0 = Date.now();
  await dial(caller, callee);
  const rang = await callee.getByTestId("call-accept").waitFor({ timeout: 30000 }).then(() => true, () => false);
  ok("ring-to-backgrounded-callee", rang, { ms: Date.now() - t0 });
  if (!rang) throw new Error("no ring");
  await hide(callee, false); await callee.getByTestId("call-accept").click({ force: true });
  mark("accepted"); await caller.waitForTimeout(3000);
  const a0 = await Promise.all([audio(caller), audio(callee)]); await caller.waitForTimeout(8000); const a1 = await Promise.all([audio(caller), audio(callee)]);
  const st = await caller.getByTestId("call-status").innerText().catch(() => "");
  ok("connect", a1[0].outB > 0 && a1[1].outB > 0, { callerStatus: st.slice(0, 40) });
  ok("audio-callee-hears-caller", a1[1].inB - a0[1].inB > 20000, { bytes8s: a1[1].inB - a0[1].inB, lvl: a1[1].lvl });
  ok("audio-caller-hears-callee", a1[0].inB - a0[0].inB > 20000, { bytes8s: a1[0].inB - a0[0].inB, lvl: a1[0].lvl });
  // background mid-call: hide callee 6 s, audio must keep flowing
  await hide(callee, true); const b0 = await audio(callee); await callee.waitForTimeout(6000); const b1 = await audio(callee); await hide(callee, false);
  ok("audio-while-callee-hidden", b1.inB - b0.inB > 15000 && b1.outB - b0.outB > 15000, { in: b1.inB - b0.inB, out: b1.outB - b0.outB });
  // 3 busy: Sam dials Jordan while Jordan is on a call
  mark("third->callee while busy"); await dial(third, callee);
  const busyTxt = await third.waitForFunction(() => /busy|on another call|unavailable/i.test(document.body.innerText), null, { timeout: 15000 }).then(() => true, () => false);
  const calleeRangAgain = await callee.getByTestId("call-accept").isVisible().catch(() => false);
  ok("busy-while-in-call", busyTxt && !calleeRangAgain, { busyShown: busyTxt, calleeSecondRing: calleeRangAgain });
  await hangup(third); await hangup(caller); mark("hangup caller");
  const ended = await callee.getByTestId("call-screen").waitFor({ state: "detached", timeout: 15000 }).then(() => true, () => false);
  ok("hangup-propagates", ended);
  // 4 redial after busy (stale busy self-heal): Sam calls Jordan again
  await third.waitForTimeout(3000); mark("redial third->callee");
  await dial(third, callee);
  const rang2 = await callee.getByTestId("call-accept").waitFor({ timeout: 30000 }).then(() => true, () => false);
  if (rang2) { await callee.getByTestId("call-accept").click({ force: true }); await third.waitForTimeout(3000); const r0 = await audio(callee); await callee.waitForTimeout(6000); const r1 = await audio(callee);
    ok("redial-after-busy", r1.inB - r0.inB > 15000, { bytes6s: r1.inB - r0.inB }); } else ok("redial-after-busy", false, "no ring");
  await hangup(third); await hangup(callee); mark("done");
} catch (e) { ok("harness", false, String(e.message).slice(0, 160)); for (const p of [caller, callee, third]) if (p) await hangup(p); }
await browser.close();
const f = res.filter((r) => !r.c).length; console.log(`LIVE: ${f ? "FAIL" : "PASS"} (${res.length - f}/${res.length})`); process.exit(f ? 1 : 0);
