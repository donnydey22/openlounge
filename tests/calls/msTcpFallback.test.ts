// UDP-first direct media with the TCP fallback on the SAME mediasoup server (Donny, Oct 15 2026). LiveKit is only
// reached if the SFU has no TCP port configured or TCP cannot connect either.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const sfu = readFileSync("media-sfu/src/index.mjs", "utf8");
const eng = readFileSync("src/lib/calls/engine.ts", "utf8");
const ses = readFileSync("src/lib/calls/mediasoupSession.ts", "utf8");

test("SFU: default transport is UDP + same-server ICE-TCP, UDP preferred", () => {
  assert.match(sfu, /enableUdp: !tcpOnly,\s*\n\s*enableTcp: cfg\.tcpPort !== null,\s*\n\s*preferUdp: !tcpOnly,/);
});
test("SFU: tcpOnly refused unless MEDIASOUP_ENABLE_TCP configured the port", () => {
  assert.match(sfu, /if \(tcpOnly && cfg\.tcpPort === null\) throw new Error\("TCP transport not enabled"\)/);
});
test("client asks for TCP-only transports only on the explicit fallback", () => {
  assert.equal((ses.match(/this\.opts\.tcpOnly \? \{ tcpOnly: true \} : \{\}/g) ?? []).length, 2);
});
test("engine: fallback tries same-SFU TCP before LiveKit; netAdapt floor uses the same requestTcpFallback", () => {
  const fb = eng.slice(eng.indexOf("private async requestTcpFallback("), eng.indexOf("private onMediaFallback"));
  assert.ok(fb.indexOf("switchToMediasoupTcp") > 0 && fb.indexOf("switchToMediasoupTcp") < fb.indexOf("call:mediaFallback"));
  assert.match(eng, /a\.type === "tcp"[\s\S]{0,300}requestTcpFallback\(\)/);
});
test("engine: on same-SFU TCP, udpRecovery returns to UDP; state cleared on teardown", () => {
  assert.match(eng, /p === "mediasoup" && this\.msTcp[\s\S]{0,300}restoreMediasoupUdp\(\)/);
  assert.match(eng, /private teardownMedia\(\) \{\s*\n\s*stopTones\(\);\s*\n\s*this\.msTcp = false;/);
});
test("server: mediasoup media carries only the TURNS/443 (TLS) relay, never plain TURN", () => {
  const idx = readFileSync("server/calls/index.ts", "utf8");
  assert.match(idx, /u\.startsWith\("turns:"\)/);
  assert.match(idx, /provider: "mediasoup"[\s\S]{0,200}iceServers: turns/);
});
test("engine: failed first connect (UDP + ICE-TCP both offered) skips the redundant tcpOnly retry", () => {
  assert.match(eng, /this\.netLog\("ms-connect-failed", \{ recovering \}\);[\s\S]{0,500}if \(!recovering\) await this\.requestTcpFallback\(true\)/);
  assert.match(eng, /if \(!skipSameSfu && \(await this\.switchToMediasoupTcp\(\)/);
});
