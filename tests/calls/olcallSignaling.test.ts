// Donny t6081u item 1: desktop web signals to the olcall Pion webleg (join surface "browser", TURN-only joined list,
// offer/ice/answer), not the removed sealed rc:* exchange.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OlcallSignaling } from "../../src/lib/calls/rtc/OlcallSignaling";

class FakeWS {
  readyState = 0; sent: Record<string, unknown>[] = [];
  onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void; onerror?: () => void;
  constructor(public url: string) { setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
  push(f: unknown) { this.onmessage?.({ data: JSON.stringify(f) }); }
}

test("join as browser, TURN-only ICE from joined, offer/candidates out, answer/candidates in, media + hangup frames", async () => {
  const socks: FakeWS[] = [];
  const sig = new OlcallSignaling({ provider: "olcall", url: "wss://turn.openlounge.app/v1/call", token: "tok" } as never, {
    callId: "call-1", createSocket: (u) => { const w = new FakeWS(u); socks.push(w); return w as never; },
  });
  const got: Record<string, unknown>[] = [];
  sig.on("rtc:signal", (m) => got.push(m as Record<string, unknown>));
  const p = sig.connect();
  await new Promise((r) => setTimeout(r, 5));
  const ws = socks[0];
  assert.equal(ws.sent[0].t, "join"); assert.equal(ws.sent[0].surface, "browser"); assert.equal(ws.sent[0].token, "tok");
  // a candidate before joined is held, not sent
  await sig.request("rtc:signal", { gen: 1, kind: "candidate", candidate: { candidate: "c0" } });
  assert.equal(ws.sent.length, 1);
  ws.push({ t: "joined", callId: "call-1", leg: "caller", resume: "rk", iceServers: [{ urls: ["stun:x:3478"] }, { urls: ["turn:x:3478?transport=udp", "turns:y:443?transport=tcp"], username: "u", credential: "c" }] });
  const ice = await p;
  assert.deepEqual(ice.map((s) => s.urls), [["turn:x:3478?transport=udp", "turns:y:443?transport=tcp"]]);
  assert.deepEqual(((await sig.request("rtc:iceConfig")) as { config: { iceServers: unknown[] } }).config.iceServers, ice);
  await sig.request("rtc:signal", { gen: 1, kind: "offer", sdp: "v=0" });
  const types = ws.sent.map((f) => f.t);
  assert.ok(types.includes("ice") && types.includes("offer"));
  assert.ok(!types.some((t) => String(t).startsWith("rc:")));
  ws.push({ t: "answer", sdp: "v=0a" }); ws.push({ t: "ice", candidate: { candidate: "s1" } });
  assert.deepEqual(got.map((m) => [m.kind, m.gen]), [["answer", 1], ["candidate", 1]]);
  sig.mediaState(true, false);
  assert.deepEqual(ws.sent.at(-1), { t: "media", state: { muted: true, video: "inactive", rotation: 0, screencast: "inactive", lowBattery: false } });
  // socket drop: resumes the same leg with the resume key
  ws.onclose?.();
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(socks[1].sent[0], { t: "resume", callId: "call-1", leg: "caller", resume: "rk" });
  socks[1].push({ t: "resumed" });
  sig.hangup();
  assert.equal(socks[1].sent.at(-1)?.t === "hangup" || socks[1].sent.some((f) => f.t === "hangup"), true);
  sig.close();
});

test("the other side's media state (server 'media' frame) reaches onPeerMedia: Meet-style stage + mute badge (t6094u)", async () => {
  const socks: FakeWS[] = [];
  const seen: { muted?: boolean; video?: string }[] = [];
  const sig = new OlcallSignaling({ provider: "olcall", url: "wss://turn.openlounge.app/v1/call", token: "tok" } as never, {
    callId: "call-2", createSocket: (u) => { const w = new FakeWS(u); socks.push(w); return w as never; },
    onPeerMedia: (st) => seen.push(st),
  });
  const p = sig.connect();
  await new Promise((r) => setTimeout(r, 5));
  socks[0].push({ t: "joined", callId: "call-2", leg: "callee", resume: "rk", iceServers: [{ urls: ["turns:y:443?transport=tcp"], username: "u", credential: "c" }] });
  await p;
  socks[0].push({ t: "media", state: { muted: false, video: "active", rotation: 0, screencast: "inactive", lowBattery: false } });
  socks[0].push({ t: "media", state: { muted: true, video: "inactive" } });
  socks[0].push({ t: "media" }); // no state: ignored
  assert.deepEqual(seen.map((s) => [s.muted, s.video]), [[false, "active"], [true, "inactive"]]);
  sig.close();
});
