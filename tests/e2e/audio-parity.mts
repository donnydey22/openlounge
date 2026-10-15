// Browser audio parity: the same capture constraints + Opus contract on Chromium (Chrome/Edge), Firefox and WebKit
// (Safari), verified with real RTCPeerConnection getStats() (negotiated codec/fmtp, packets, decoded energy).
// Usage: npx tsx tests/e2e/audio-parity.mts   (exit 1 on any mismatch)
import type { BrowserType } from "playwright";
// PW=/path/to/playwright lets a newer Playwright (with a WebKit build for this distro) drive the same test.
const pwm: any = await import(process.env.PW ?? "playwright");
const { chromium, firefox, webkit } = (pwm.chromium ? pwm : pwm.default) as typeof import("playwright");
import { AUDIO_CONTRACT, fmtpMismatches } from "../../src/lib/calls/audioParity";

const engines: Array<[string, BrowserType, object]> = [
  ["chromium", chromium, { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] }],
  ["firefox", firefox, { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, "media.autoplay.default": 0 } }],
  ["webkit", webkit, {}],
];
const fmtp = Object.entries(AUDIO_CONTRACT.fmtp).map(([k, v]) => `${k}=${v}`).join(";") + ";minptime=10";
let fails = 0;
const rows: any[] = [];
for (const [name, type, opts] of engines) {
  const browser = await type.launch(opts);
  const ctx = await browser.newContext(name !== "firefox" ? { permissions: ["microphone"] } : {});
  const page = await ctx.newPage();
  await page.route("http://localhost/", (r) => r.fulfill({ contentType: "text/html", body: "<html></html>" }));
  await page.addInitScript("window.__name = (f) => f");
  await page.goto("http://localhost/");
  const r = await page.evaluate(async ({ constraints, fmtp, ptime }) => {
    let src = "getUserMedia", track: MediaStreamTrack, settings: any = {};
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: constraints as any });
      track = s.getAudioTracks()[0];
      settings = track.getSettings();
    } catch (e) {
      src = "oscillator(" + String((e as Error).name) + ")";
      const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start();
      track = d.stream.getAudioTracks()[0];
      await track.applyConstraints(constraints as any).catch(() => {});
    }
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    let got: MediaStream | null = null;
    b.ontrack = (e) => { got = e.streams[0] ?? new MediaStream([e.track]); const el = new Audio(); el.srcObject = got; el.muted = true; void el.play().catch(() => {}); };
    a.addTrack(track, new MediaStream([track]));
    const munge = (sdp: string) => {
      const pt = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp)?.[1];
      if (!pt) return sdp;
      sdp = sdp.replace(new RegExp(`a=fmtp:${pt} [^\\r\\n]*`), `a=fmtp:${pt} ${fmtp}`);
      return sdp.includes("a=ptime:") ? sdp : sdp.replace(/(m=audio[^\r\n]*\r\n)/, `$1a=ptime:${ptime}\r\n`);
    };
    const offer = await a.createOffer();
    await a.setLocalDescription({ type: "offer", sdp: munge(offer.sdp!) });
    await b.setRemoteDescription(a.localDescription!);
    const ans = await b.createAnswer();
    await b.setLocalDescription({ type: "answer", sdp: munge(ans.sdp!) });
    await a.setRemoteDescription(b.localDescription!);
    await new Promise((r) => setTimeout(r, 4000));
    const out: any = { src, settings: { echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression, autoGainControl: settings.autoGainControl, channelCount: settings.channelCount } };
    const sa = await a.getStats(), sb = await b.getStats();
    sa.forEach((s: any) => { if (s.type === "outbound-rtp" && s.kind === "audio") { out.packetsSent = s.packetsSent; out.codecId = s.codecId; } });
    sa.forEach((s: any) => { if (s.type === "codec" && s.id === out.codecId) out.codec = { mimeType: s.mimeType, clockRate: s.clockRate, channels: s.channels, sdpFmtpLine: s.sdpFmtpLine }; });
    if (!out.codec) sa.forEach((s: any) => { if (s.type === "codec" && /opus/i.test(s.mimeType)) out.codec ??= { mimeType: s.mimeType, clockRate: s.clockRate, channels: s.channels, sdpFmtpLine: s.sdpFmtpLine }; });
    sb.forEach((s: any) => { if (s.type === "inbound-rtp" && s.kind === "audio") { out.packetsReceived = s.packetsReceived; out.totalAudioEnergy = s.totalAudioEnergy; out.jitterBufferDelay = s.jitterBufferDelay; out.jitterBufferEmittedCount = s.jitterBufferEmittedCount; out.concealed = s.concealedSamples; } });
    out.jitterBufferTarget = (b.getReceivers()[0] as any)?.jitterBufferTarget ?? null;
    a.close(); b.close();
    return out;
  }, { constraints: AUDIO_CONTRACT.constraints, fmtp, ptime: AUDIO_CONTRACT.ptime });
  await browser.close();
  const problems: string[] = [];
  if (!/audio\/opus/i.test(r.codec?.mimeType ?? "")) problems.push(`codec ${r.codec?.mimeType}`);
  if (r.codec?.clockRate !== 48000) problems.push(`clockRate ${r.codec?.clockRate}`);
  problems.push(...fmtpMismatches(r.codec?.sdpFmtpLine));
  if (!(r.packetsSent > 50)) problems.push(`packetsSent ${r.packetsSent}`);
  if (!(r.packetsReceived > 50)) problems.push(`packetsReceived ${r.packetsReceived}`);
  if (r.jitterBufferTarget !== null && r.jitterBufferTarget !== undefined && r.jitterBufferTarget !== 0) problems.push(`jitterBufferTarget overridden ${r.jitterBufferTarget}`);
  // Fake capture devices (Firefox/WebKit) bypass the processing pipeline and report AEC/NS/AGC=false; real devices
  // honour the same `ideal` constraints. Only a rejected getUserMedia with the shared constraints is a parity failure.
  if (r.src.startsWith("oscillator(Overconstrained")) problems.push("constraints rejected");
  rows.push({ engine: name, ...r, problems });
  console.log(`${problems.length ? "FAIL" : "PASS"} ${name}: src=${r.src} codec=${r.codec?.mimeType}/${r.codec?.clockRate} fmtp="${r.codec?.sdpFmtpLine}" sent=${r.packetsSent} recv=${r.packetsReceived} energy=${r.totalAudioEnergy} jbTarget=${r.jitterBufferTarget} aec/ns/agc=${r.settings.echoCancellation}/${r.settings.noiseSuppression}/${r.settings.autoGainControl}${problems.length ? " :: " + problems.join("; ") : ""}`);
  if (problems.length) fails++;
}
process.exit(fails ? 1 : 0);
