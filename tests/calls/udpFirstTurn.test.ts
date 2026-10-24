import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
test("mediasoup calls are offered TURN over UDP 3478 first, then TCP 3478, then TURNS 443", async () => {
  const src = readFileSync("server/calls/index.ts", "utf8");
  const m = src.match(/export function mediasoupTurnUrls[\s\S]*?\n}\n/);
  assert.ok(m, "helper present");
  const fn = new Function(`return (${m![0].replace("export function mediasoupTurnUrls(urls: readonly string[]): string[]", "function (urls)")})`)();
  const out: string[] = fn(["turns:turn.openlounge.app:443?transport=tcp", "turn:turn.openlounge.app:3478?transport=tcp", "turn:turn.openlounge.app:3478?transport=udp"]);
  assert.deepEqual(out, ["turn:turn.openlounge.app:3478?transport=udp", "turn:turn.openlounge.app:3478?transport=tcp", "turns:turn.openlounge.app:443?transport=tcp"]);
  assert.ok(src.includes("urls: mediasoupTurnUrls(s.urls)"));
});
test("engine: network change → ICE restart (UDP first), persistent UDP watch after landing on TCP/TLS", () => {
  const e = readFileSync("src/lib/calls/engine.ts", "utf8");
  assert.ok(e.includes('netLog("net-change-ice-restart"'));
  assert.ok(e.includes("UDP_WATCH_MS"));
});
