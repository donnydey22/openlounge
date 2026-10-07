#!/usr/bin/env node
// One-time local consent flow → prints a Gmail API refresh token (scope gmail.send) for GMAIL_REFRESH_TOKEN.
// Usage: GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/gmail-oauth.mjs
// Uses a loopback redirect (http://127.0.0.1:<port>) — needs a "Desktop app" OAuth client. Run it on a machine
// with a browser (or open the printed URL in the browser on the same box). No dependencies.
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";

const id = process.env.GMAIL_CLIENT_ID?.trim(), secret = process.env.GMAIL_CLIENT_SECRET?.trim();
if (!id || !secret) { console.error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in the environment first."); process.exit(1); }
const port = Number(process.env.PORT || 53682);
const redirect = `http://127.0.0.1:${port}/callback`;
const state = randomBytes(16).toString("hex");
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
  client_id: id, redirect_uri: redirect, response_type: "code", scope: "https://www.googleapis.com/auth/gmail.send",
  access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256",
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect);
  if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
  if (u.searchParams.get("state") !== state) { res.writeHead(400).end("state mismatch"); return; }
  const code = u.searchParams.get("code");
  if (!code) { res.writeHead(400).end(`error: ${u.searchParams.get("error")}`); server.close(); return; }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier }),
  });
  const j = await r.json();
  if (!j.refresh_token) { res.writeHead(500).end("No refresh token returned — see terminal."); console.error("Token exchange failed:", j.error, j.error_description); server.close(); process.exitCode = 1; return; }
  res.writeHead(200, { "content-type": "text/plain" }).end("Done — you can close this tab and return to the terminal.");
  console.log("\nGMAIL_REFRESH_TOKEN (store it as a secret; do not commit or paste it anywhere public):\n");
  console.log(j.refresh_token + "\n");
  server.close();
});
server.listen(port, "127.0.0.1", () => console.log(`Open this URL, sign in as the sender Gmail account, and allow "Send email on your behalf":\n\n${url}\n`));
