// After `npm run smoke` and a server restart: sessions + DMs must survive.
import fs from "node:fs";
import WebSocket from "ws";
const { tokenB, peerA } = JSON.parse(fs.readFileSync("/tmp/openlounge-smoke.json", "utf8"));
const ws = new WebSocket(process.argv[2] ?? "ws://localhost:3000/ws");
let id = 0;
const pend = new Map();
ws.on("message", (r) => { const m = JSON.parse(r); if (m.t === "res") pend.get(m.id)?.(m.data); });
const req = (ev, data) => new Promise((res) => { pend.set(++id, res); ws.send(JSON.stringify({ t: "req", id, ev, data })); });
ws.on("open", async () => {
  const s = await req("session:resume", { token: tokenB });
  const h = await req("dm:history", { peerId: peerA });
  const ok = s.ok && h.ok && h.messages.some((m) => m.text === "psst");
  console.log(ok ? "✓ session + DM history survived restart" : "✗ persistence failed", ok ? "" : JSON.stringify({ s, h }));
  process.exit(ok ? 0 : 1);
});
