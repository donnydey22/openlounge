// A stand-in for the olcall Go server's POST /v1/call-event in the integration tests. The backend now rings only after
// the call server's callee leg reports Ringing (strict gate), so every test process gets this stub answering exactly as
// olcall/server/events.go applyRequest does for the happy path: call:start -> both legs Ringing, anything else 200.
// It does not verify the HMAC (olcallEvent.test.ts pins the token byte-for-byte against the Go vector).
import { createServer } from "node:http";

process.env.OLCALL_TOKEN_SECRET ||= "olcall-integration-test-secret-0123456789";
if (!process.env.OLCALL_EVENT_URL) {
  const calls = new Map<string, { caller: string; callee: string; seq: number }>();
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      let callId = "", event = "";
      try {
        const token = String(JSON.parse(body).token ?? "");
        ({ callId, event } = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")));
      } catch { res.writeHead(400).end(); return; }
      // the happy-path slice of states.go: start -> Ringing, accept -> Answering, any terminal request -> Terminal
      const legs = (calls.get(callId) ?? (event === "call:start" ? { caller: "idle", callee: "idle", seq: 0 } : null));
      res.setHeader("content-type", "application/json");
      if (!legs) { res.writeHead(404).end("{}"); return; }
      calls.set(callId, legs);
      const next: Record<string, string> = { "call:start": "ringing", "call:accept": "answering" };
      for (const k of ["caller", "callee"] as const) if (legs[k] !== "terminal") legs[k] = next[event] ?? "terminal";
      legs.seq += 1;
      const snap = (leg: "caller" | "callee") => ({ callId, leg, state: legs[leg], seq: legs.seq, event });
      res.writeHead(200);
      res.end(JSON.stringify({ caller: snap("caller"), callee: snap("callee") }));
    });
  });
  srv.listen(0, "127.0.0.1", () => {
    const a = srv.address();
    if (a && typeof a === "object") process.env.OLCALL_EVENT_URL = `http://127.0.0.1:${a.port}/v1/call-event`;
  });
  srv.unref();
}
