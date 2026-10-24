// Donny t3300u (Oct 24 2026 4:11 AM MST, call 574e953a, iPhone b62 → Keiko Android 0.3.20-36).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ov = readFileSync("src/components/calls/CallOverlay.tsx", "utf8");
const prov = readFileSync("src/components/calls/CallProvider.tsx", "utf8");
const eng = readFileSync("src/lib/calls/engine.ts", "utf8");

test("FX-061 remote tile only: big tile is always remote, self-view only in the PiP", () => {
  assert.match(ov, /const bigWhich: "local" \| "remote" = "remote";/);
  assert.match(ov, /<Pip which="local"/);
  assert.match(ov, /data-testid="call-remote-placeholder"/);
  assert.doesNotMatch(ov, /setSwap/);
  assert.match(ov, /pip: pip \? \{ kind: "local"/); // iPhone app layout record: remote big, local PiP
});

// Pure copy of the engine rule, exercised against the CallKit race that made the button flicker.
const ECHO = Number(/export const MUTE_ECHO_MS = (\d+);/.exec(eng)![1]);
function ignore(intent: { muted: boolean; at: number } | null, muted: boolean, current: boolean, now: number) {
  if (muted === current) return true;
  return !!intent && now - intent.at < ECHO && intent.muted !== muted;
}
test("FX-063 mute stable: queued CallKit echoes of earlier taps never flip the button", () => {
  assert.match(eng, /export function ignoreNativeMute\(/);
  assert.match(eng, /if \(ignoreNativeMute\(this\.muteIntent, muted, this\.s\.muted\)\) return;/);
  assert.match(eng, /if \(from === "user"\) postNative\(\{ type: "call:muted", muted \}\);/);
  assert.match(prov, /e_\.setMuted\(d\.muted, "native"\)/);
  assert.doesNotMatch(prov, /call:mute"[^\n]*toggleMute/);
  // tap mute (t=0), tap unmute (t=200): CallKit then performs both queued actions (true @300, false @400)
  let muted = false; let intent: { muted: boolean; at: number } | null = null; const states: boolean[] = [];
  const tap = (t: number) => { muted = !muted; intent = { muted, at: t }; states.push(muted); };
  const native = (v: boolean, t: number) => { if (!ignore(intent, v, muted, t)) { muted = v; states.push(muted); } };
  tap(0); tap(200); native(true, 300); native(false, 400);
  assert.deepEqual(states, [true, false]);
  assert.equal(muted, false);
  // a real CallKit-screen mute long after the last tap is still honoured
  native(true, 5000);
  assert.equal(muted, true);
});
