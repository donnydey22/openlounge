// Sign the three EXISTING test accounts in (Firebase test numbers, sign-in only; never changes Firebase config).
// Writes sessions (mode 600) used by live-call-smoke.mjs. Prints no tokens.
import WebSocket from "ws"; import fs from "node:fs";
const key = "AIzaSyBYGoBfnu03JtFgqSd8G5iOgHF3RC3wvU0"; // public web API key (src/lib/firebaseClient.ts)
const post = (m, b) => fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${m}?key=${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const phone = async (num, code) => { const s = await post("sendVerificationCode", { phoneNumber: num }); return (await post("signInWithPhoneNumber", { sessionInfo: s.sessionInfo, code })).idToken; };
const viaRefresh = async (rt) => (await fetch(`https://securetoken.googleapis.com/v1/token?key=${key}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(rt)}` }).then((r) => r.json())).id_token;
const A = {
  tv: { out: "/workspace/lk-test/.live-tv.json", id: () => viaRefresh(JSON.parse(fs.readFileSync("/workspace/lk-test/fb-124.json")).refreshToken) },
  jordan: { out: "/workspace/keiko-fix/.kf-jordan.json", id: () => phone("+15555550125", "482917") },
  sam: { out: "/workspace/keiko-fix/.kf-sam.json", id: () => phone("+15555550130", fs.readFileSync(process.env.HOME + "/.secrets/firebase-test-15555550130.code", "utf8").trim()) },
};
for (const [who, a] of Object.entries(A)) {
  const idToken = await a.id().catch(() => null); if (!idToken) { console.log(who, "firebase sign-in failed"); continue; }
  const ws = new WebSocket("wss://openlounge.app/ws", { headers: { Origin: "https://openlounge.app" } }); await new Promise((r) => ws.once("open", r));
  const v = await new Promise((res) => { ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.t === "res" && m.id === 1) res(m.data); }); ws.send(JSON.stringify({ t: "req", id: 1, ev: "auth:verifyFirebase", data: { idToken, device: "gate-live" } })); setTimeout(() => res({}), 10000); });
  ws.close();
  if (!v?.user?.id) { console.log(who, "server sign-in failed", JSON.stringify(v).slice(0, 120)); continue; }
  fs.writeFileSync(a.out, JSON.stringify({ tok: v.refresh ?? v.token, id: v.user.id, username: v.user.username }), { mode: 0o600 });
  console.log(who, "ok", v.user.id, v.user.username);
}
process.exit(0);
