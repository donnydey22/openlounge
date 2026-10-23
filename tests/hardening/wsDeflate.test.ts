// WS_DEFLATE=1: permessage-deflate is negotiated, big JSON frames shrink on the wire, small ones and requests still work.
// Off by default: no extension is negotiated.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";

async function hub(deflate: boolean) {
  if (deflate) process.env.WS_DEFLATE = "1";
  else delete process.env.WS_DEFLATE;
  const mod = await import("../../server/ws");
  const server = http.createServer();
  const h = new mod.WsHub(server, "/ws", () => true);
  h.onConnection((c: { on: (ev: string, fn: (d: unknown, ack: (r: unknown) => void) => void) => void }) => {
    c.on("page", (_d, ack) => ack({ messages: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, fromId: "u_a", toId: "u_b", text: `message number ${i} lorem ipsum`, createdAt: 1_800_000_000_000 + i })) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`, close: () => { h.close?.(); server.closeAllConnections?.(); server.close(); } };
}

async function roundTrip(url: string) {
  const ws = new WebSocket(url, { perMessageDeflate: true, headers: { origin: "http://localhost" } });
  let wire = 0;
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  (ws as unknown as { _socket: import("node:net").Socket })._socket.on("data", (b: Buffer) => (wire += b.length));
  const res = await new Promise<{ data: { messages: unknown[] } }>((r) => {
    ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.t === "res") r(m); });
    ws.send(JSON.stringify({ t: "req", id: 1, ev: "page", data: {} }));
  });
  const ext = ws.extensions;
  ws.close();
  return { ext, wire, n: res.data.messages.length };
}

test("deflate on: negotiated, 200-message page shrinks several-fold, content intact", async () => {
  const h = await hub(true);
  try {
    const r = await roundTrip(h.url);
    assert.match(r.ext, /permessage-deflate/);
    assert.equal(r.n, 200);
    const raw = JSON.stringify({ messages: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, fromId: "u_a", toId: "u_b", text: `message number ${i} lorem ipsum`, createdAt: 1_800_000_000_000 + i })) }).length;
    assert.ok(r.wire * 4 < raw, `wire ${r.wire} B vs raw ${raw} B`);
    console.log(`deflate: ${raw} B JSON → ${r.wire} B on the wire`);
  } finally { h.close(); }
});

test("deflate off (default): no extension, same content", async () => {
  const h = await hub(false);
  try {
    const r = await roundTrip(h.url);
    assert.equal(r.ext, "");
    assert.equal(r.n, 200);
  } finally { h.close(); }
});
