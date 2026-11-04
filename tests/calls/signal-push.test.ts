// call-signal push() -> app /api/internal/call-signal-push -> mocked APNs VoIP + FCM high-priority; delivered log on connect.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { handleSignalPush, SIGNAL_PUSH_PATH } from "../../server/calls/signalPush";

const SECRET = "test-secret-0123456789abcdef0123456789";
process.env.CALL_SIGNAL_PUSH_SECRET = SECRET;

test("signal push: auth, APNs VoIP + FCM sent, call-signal logs sent + pushToConnectMs", async () => {
  const sent: string[] = [];
  const deps = {
    voipRing: async (to: string, p: Record<string, string>) => { sent.push(`voip:${to}:${p.type}:${p.callId}`); return 1; },
    fcmIncoming: async (to: string, c: { id: string }, o: { skipIos: boolean }) => { sent.push(`fcm:${to}:${c.id}:skipIos=${o.skipIos}`); return "sent"; },
    user: () => ({ name: "Keiko", photoUrl: null }),
    mintDecline: () => "dtok",
  };
  const json = (res: http.ServerResponse, s: number, b: unknown) => { res.statusCode = s; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); };
  const readJson = (req: http.IncomingMessage) => new Promise<Record<string, unknown>>((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(JSON.parse(b || "{}"))); });
  const srv = http.createServer((req, res) => { if (req.url === SIGNAL_PUSH_PATH) return void handleSignalPush(req, res, json, readJson, deps); res.statusCode = 404; res.end(); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}${SIGNAL_PUSH_PATH}`;
  try {
    const bad = await fetch(url, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    assert.equal(bad.status, 401);
    process.env.CALL_SIGNAL_PUSH_URL = url;
    const logs: string[] = []; const orig = console.log; console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      // call-signal side: real core + real signalPush (index.mjs not imported: it starts a server); same function shape
      // @ts-ignore untyped .mjs
      const { createSignal } = await import("../../call-signal/src/core.mjs");
      // @ts-ignore untyped .mjs
      const { signalPushFor } = await import("../../call-signal/src/push.mjs");
      const doPush = signalPushFor({ url, secret: SECRET });
      let online = false; const pending: Promise<unknown>[] = [];
      const s = createSignal({ send: () => {}, online: () => online, push: (u: string, p: Record<string, unknown>) => pending.push(doPush(u, p)), setTimer: () => 0, clearTimer: () => {} });
      const r = s.handle("keiko", { t: "call:new", to: "donny", kind: "audio" }) as { callId: string };
      await Promise.all(pending);
      await new Promise((x) => setTimeout(x, 30)); online = true; s.connected("donny");
      assert.deepEqual(sent, [`voip:donny:call_incoming:${r.callId}`, `fcm:donny:${r.callId}:skipIos=true`]);
      assert.ok(logs.some((l) => /\[push\] sent call=.* http=200 voipSent=1 fcm=sent/.test(l)), logs.join("\n"));
      assert.ok(logs.some((l) => /\[push\] delivered call=.* pushToConnectMs=\d+/.test(l)), logs.join("\n"));
      assert.ok(!logs.some((l) => l.includes(SECRET)), "secret must never be logged");
    } finally { console.log = orig; }
  } finally { srv.close(); }
});
