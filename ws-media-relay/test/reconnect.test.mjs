import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import WebSocket from "ws";
import { createRelay, GRACE_MS } from "../src/relay.mjs";

const pkt = (n) => Buffer.from([0x80, 0x6f, 0, n, 0, 0, 0, 160, 1, 2, 3, 4, 9]);
async function setup(graceMs) {
  const sfu = dgram.createSocket("udp4"); await new Promise((r) => sfu.bind(0, "127.0.0.1", r));
  let resolves = 0;
  const wss = createRelay({ port: 0, graceMs, verify: (t) => (t === "good" ? "u1" : null), resolveTarget: () => (resolves++, { host: "127.0.0.1", port: sfu.address().port }) });
  await new Promise((r) => wss.on("listening", r));
  const open = async () => { const ws = new WebSocket(`ws://127.0.0.1:${wss.address().port}/?token=good&callId=c`); await new Promise((r) => ws.on("open", r)); return ws; };
  const up = (ws, n) => new Promise((r) => { sfu.once("message", (m, i) => r(i.port)); ws.send(pkt(n)); });
  return { sfu, wss, open, up, resolves: () => resolves };
}

test("grace matches tweb CALL_REQUEST_TIMEOUT (45 s)", () => assert.equal(GRACE_MS, 45_000));

test("reconnect inside grace reattaches to the same UDP socket (same tuple at the SFU), both directions", async () => {
  const { sfu, wss, open, up, resolves } = await setup(1000);
  const a = await open(); const p1 = await up(a, 1);
  a.close(); await new Promise((r) => setTimeout(r, 50));
  assert.equal(wss.legs.size, 1, "leg kept during grace");
  const b = await open(); const p2 = await up(b, 2);
  assert.equal(p2, p1, "same source port -> mediasoup comedia tuple still matches");
  assert.equal(resolves(), 1, "no new target resolution");
  const down = pkt(3);
  const got = await new Promise((r) => { b.once("message", (m) => r(Buffer.from(m))); sfu.send(down, p2, "127.0.0.1"); });
  assert.deepEqual(got, down);
  b.close(); sfu.close(); wss.close();
});

test("socket closes after the grace; a later connect gets a fresh leg", async () => {
  const { sfu, wss, open, up } = await setup(80);
  const a = await open(); const p1 = await up(a, 1);
  a.close(); await new Promise((r) => setTimeout(r, 200));
  assert.equal(wss.legs.size, 0, "leg closed after grace");
  const b = await open(); const p2 = await up(b, 2);
  assert.notEqual(p2, p1);
  b.close(); sfu.close(); wss.close();
});

test("a second WS for the same leg replaces the first", async () => {
  const { sfu, wss, open } = await setup(1000);
  const a = await open();
  const closed = new Promise((r) => a.on("close", (c) => r(c)));
  const b = await open();
  assert.equal(await closed, 4009);
  assert.equal(wss.legs.size, 1);
  b.close(); sfu.close(); wss.close();
});
