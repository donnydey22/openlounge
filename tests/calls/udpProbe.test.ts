// Back to UDP after landing on TCP (in-place ICE restart probe) + SFU gateway liveness (Donny, Oct 16 2026).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectedProtocol, anyOnTcp, udpProbeDelay, UDP_PROBE_DELAYS_MS } from "../../src/lib/calls/udpProbe";
const eng = readFileSync("src/lib/calls/engine.ts", "utf8");
const sfu = readFileSync("media-sfu/src/index.mjs", "utf8");
const rep = (rows: object[]) => new Map(rows.map((r: any, i) => [r.id ?? String(i), r]));

test("selectedProtocol: via transport.selectedCandidatePairId", () => {
  const r = rep([{ id: "T", type: "transport", selectedCandidatePairId: "P" }, { id: "P", type: "candidate-pair", localCandidateId: "L" }, { id: "L", type: "local-candidate", protocol: "tcp" }]);
  assert.equal(selectedProtocol(r), "tcp");
});
test("selectedProtocol: falls back to the nominated succeeded pair; udp", () => {
  const r = rep([{ id: "P", type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L" }, { id: "L", type: "local-candidate", protocol: "udp" }]);
  assert.equal(selectedProtocol(r), "udp");
});
test("selectedProtocol: unknown → null; anyOnTcp only true with a TCP pair", () => {
  assert.equal(selectedProtocol(rep([])), null);
  const udp = rep([{ id: "P", type: "candidate-pair", selected: true, localCandidateId: "L" }, { id: "L", type: "local-candidate", protocol: "udp" }]);
  const tcp = rep([{ id: "P", type: "candidate-pair", selected: true, localCandidateId: "L" }, { id: "L", type: "local-candidate", protocol: "tcp" }]);
  assert.equal(anyOnTcp([udp, udp]), false);
  assert.equal(anyOnTcp([udp, tcp]), true);
});
test("probe backoff never gives up (caps at the last delay)", () => {
  assert.equal(udpProbeDelay(0), UDP_PROBE_DELAYS_MS[0]);
  assert.equal(udpProbeDelay(999), UDP_PROBE_DELAYS_MS.at(-1));
});
test("engine: probe = in-place ICE restart (no teardown) while on TCP, started after connect and after recovery", () => {
  const p = eng.slice(eng.indexOf("private startUdpProbe("), eng.indexOf("// ---------- reconnect ----------"));
  assert.match(p, /anyOnTcp\(/);
  assert.match(p, /restartIceAll\(\)/);
  assert.doesNotMatch(p, /dropMediaForRejoin|connectMediasoup|parkMediaForSwitch|mediaFallback/);
  assert.match(eng, /this\.startQualityGuard\(session\);\s*\n\s*this\.startUdpProbe\(session\);/);
  assert.match(eng, /const done = [\s\S]{0,200}this\.startUdpProbe\(this\.mediasoup\)/);
  assert.equal((eng.match(/this\.stopUdpProbe\(\);/g) ?? []).length >= 3, true);
});
test("SFU gateway: ping interval + dead timeout → terminate (close handler reconnects)", () => {
  assert.match(sfu, /GATEWAY_PING_MS = Number\(process\.env\.MEDIASOUP_GATEWAY_PING_MS\) \|\| 10_000/);
  assert.match(sfu, /GATEWAY_DEAD_MS = Number\(process\.env\.MEDIASOUP_GATEWAY_DEAD_MS\) \|\| 25_000/);
  assert.match(sfu, /Date\.now\(\) - lastSeen > GATEWAY_DEAD_MS[\s\S]{0,120}ws\.terminate\(\)/);
  assert.match(sfu, /ws\.on\("pong", seen\)/);
  assert.match(sfu, /ws\.on\("message", async \(raw\) => \{\s*\n\s*seen\(\);/);
  assert.match(sfu, /clearInterval\(pinger\)/);
  assert.match(sfu, /setTimeout\(connectGateway, delay\)/);
});
test("SFU gateway: a reconnect handshake that hangs is terminated too", () => {
  assert.match(sfu, /ws\.readyState === WebSocket\.CONNECTING && Date\.now\(\) - lastSeen > GATEWAY_DEAD_MS[\s\S]{0,160}ws\.terminate\(\)/);
});

test("Oct 23: a TURN relay over TLS/TCP counts as TCP (so the UDP upgrade probe keeps running); relay over UDP is UDP", async () => {
  const { selectedProtocol, selectedPath } = await import("../../src/lib/calls/udpProbe");
  const rep = (local: Record<string, unknown>) => {
    const m = new Map<string, Record<string, unknown>>([
      ["t", { type: "transport", selectedCandidatePairId: "p" }],
      ["p", { type: "candidate-pair", id: "p", localCandidateId: "l", state: "succeeded", nominated: true }],
      ["l", { type: "local-candidate", id: "l", ...local }],
    ]);
    return { forEach: (cb: (v: never) => void) => m.forEach((v) => cb(v as never)), get: (k: string) => m.get(k) };
  };
  assert.equal(selectedProtocol(rep({ protocol: "udp", candidateType: "relay", relayProtocol: "tls" }) as never), "tcp");
  assert.equal(selectedProtocol(rep({ protocol: "udp", candidateType: "relay", relayProtocol: "tcp" }) as never), "tcp");
  assert.equal(selectedProtocol(rep({ protocol: "udp", candidateType: "relay", relayProtocol: "udp" }) as never), "udp");
  assert.equal(selectedProtocol(rep({ protocol: "udp", candidateType: "srflx" }) as never), "udp");
  assert.equal(selectedPath(rep({ protocol: "udp", candidateType: "relay", relayProtocol: "tls" }) as never), "relay-tls");
  assert.equal(selectedPath(rep({ protocol: "udp", candidateType: "host" }) as never), "udp");
});
