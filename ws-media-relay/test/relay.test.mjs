import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import WebSocket from "ws";
import { createRelay } from "../src/relay.mjs";

test("WS binary frames <-> UDP SFU leg, unchanged bytes, auth enforced", async () => {
  const sfu = dgram.createSocket("udp4"); await new Promise((r) => sfu.bind(0, "127.0.0.1", r));
  const sfuPort = sfu.address().port;
  const wss = createRelay({ port: 0, verify: (t) => (t === "good" ? "u1" : null), resolveTarget: () => ({ host: "127.0.0.1", port: sfuPort }) });
  await new Promise((r) => wss.on("listening", r)); const port = wss.address().port;
  const bad = new WebSocket(`ws://127.0.0.1:${port}/?token=bad&callId=c`);
  assert.equal(await new Promise((r) => bad.on("close", (c) => r(c))), 4001);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=good&callId=c`); await new Promise((r) => ws.on("open", r));
  const pkt = Buffer.from([0x80, 0x6f, 0, 1, 0, 0, 0, 160, 1, 2, 3, 4, 9, 9, 9]);
  const [up, rinfo] = await new Promise((r) => { sfu.once("message", (m, i) => r([m, i])); ws.send(pkt); });
  assert.deepEqual(up, pkt);
  const down = Buffer.from([0x80, 0x6f, 0, 2, 0, 0, 1, 64, 5, 6, 7, 8, 7]);
  const got = await new Promise((r) => { ws.once("message", (m) => r(m)); sfu.send(down, rinfo.port, "127.0.0.1"); });
  assert.deepEqual(Buffer.from(got), down);
  ws.close(); sfu.close(); wss.close();
});
