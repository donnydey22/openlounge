// Production WS->UDP media relay (browser WASM call leg -> mediasoup PlainTransport). TLS on its own port with the
// droplet's Let's Encrypt cert (reloaded every 12 h). Auth + target come from the server-minted token (WS_RELAY_SECRET).
import https from "node:https";
import fs from "node:fs";
import { createRelay } from "./relay.mjs";
import { verifyRelayToken } from "./token.mjs";
const SECRET = process.env.WS_RELAY_SECRET; if (!SECRET) { console.error("missing WS_RELAY_SECRET"); process.exit(1); }
const ALLOW = (process.env.RELAY_ALLOWED_HOSTS || "").split(",").filter(Boolean);
const L = process.env.RELAY_CERT_DIR || "/etc/letsencrypt/live/turn.openlounge.app/";
const creds = () => ({ key: fs.readFileSync(L + "privkey.pem"), cert: fs.readFileSync(L + "fullchain.pem") });
const tok = new Map();
const server = https.createServer(creds(), (q, r) => { r.end(q.url === "/health" ? "ok" : ""); });
setInterval(() => { try { server.setSecureContext(creds()); } catch { /* keep old */ } }, 12 * 3600_000).unref();
createRelay({ server,
  verify: (t) => { const j = verifyRelayToken(SECRET, t); if (!j || (ALLOW.length && !ALLOW.includes(j.h))) return null; const k = `${j.u}|${j.c}`; tok.set(k, j); return k; },
  resolveTarget: ({ userId: k }) => { const j = tok.get(k); tok.delete(k); return j ? { host: j.h, port: j.p } : null; } });
server.listen(Number(process.env.PORT || 8444), "::");
