// Option B relay entry: auth + target both come from the main-server-minted token (WS_RELAY_SECRET).
import http from "node:http";
import { createRelay } from "./relay.mjs";
import { verifyRelayToken } from "./token.mjs";
const SECRET = process.env.WS_RELAY_SECRET; if (!SECRET) { console.error("missing WS_RELAY_SECRET"); process.exit(1); }
const ALLOW = (process.env.RELAY_ALLOWED_HOSTS || "").split(",").filter(Boolean);
const tok = new Map();
const server = http.createServer((q, r) => { r.end(q.url === "/health" ? "ok" : ""); });
createRelay({ server,
  verify: (t) => { const j = verifyRelayToken(SECRET, t); if (!j || (ALLOW.length && !ALLOW.includes(j.h))) return null; const k = `${j.u}|${j.c}`; tok.set(k, j); return k; },
  resolveTarget: ({ userId: k }) => { const j = tok.get(k); tok.delete(k); return j ? { host: j.h, port: j.p } : null; } });
server.listen(Number(process.env.PORT || 8092), "127.0.0.1");
