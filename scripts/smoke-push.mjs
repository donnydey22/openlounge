// Integration smoke for push/notifications/contacts/firebase endpoints. Server must be up:
//   node scripts/smoke-push.mjs ws://localhost:3100/ws [fcmTokenForRealSend]
import WebSocket from "ws";
import { createHash } from "node:crypto";

const URL = process.argv[2] ?? "ws://localhost:3000/ws";
const REAL_TOKEN = process.argv[3] ?? "";
const HTTP = URL.replace(/^ws/, "http").replace(/\/ws$/, "");
let failures = 0;
const check = (c, l, x) => (console.log(`${c ? "✓" : "✗"} ${l}${!c && x !== undefined ? " — " + JSON.stringify(x) : ""}`), c || failures++);

function client() {
  const ws = new WebSocket(URL);
  let seq = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "res") pending.get(m.id)?.(m.data), pending.delete(m.id);
  });
  const open = new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  return {
    open,
    ws,
    req: (ev, data = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ t: "req", id, ev, data })); setTimeout(() => pending.has(id) && rej(new Error("timeout " + ev)), 8000); }),
  };
}
const api = async (path, token, body) => {
  const r = await fetch(HTTP + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, j: await r.json() };
};
async function signup(phone, first, username) {
  const c = client();
  await c.open;
  await c.req("auth:requestCode", { phone });
  const v = await c.req("auth:verifyCode", { phone, code: "000000" });
  const reg = await c.req("auth:register", { ticket: v.ticket, firstName: first, username, color: "#34d399" });
  check(reg.ok, `signup ${username}`, reg);
  return { c, access: reg.access, id: reg.user.id };
}
const sfx = Date.now().toString().slice(-6);
const a = await signup(`+1415${sfx}1`.slice(0, 12), "Alice", `alice${sfx}`);
const b = await signup(`+1415${sfx}2`.slice(0, 12), "Bob", `bob${sfx}`);

const cfg = await a.c.req("auth:config");
check(cfg.ok && cfg.firebase === true && cfg.demoOtp === true, "auth:config reports firebase on + demo OTP on", cfg);
const fb = await fetch(HTTP + "/api/auth/firebase", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: "eyJhbGciOiJSUzI1NiJ9.forged.token-xxxxxxxxxxxxxxxx" }) });
check(fb.status === 401, "POST /api/auth/firebase rejects a forged ID token (real firebase-admin verifier)", fb.status);

check((await api("/api/push/register", "bad", { token: "x".repeat(40), platform: "android" })).status === 401, "push register requires auth");
const fake = "fake-fcm-token-" + "x".repeat(140);
check((await api("/api/push/register", b.access, { token: fake, platform: "android" })).j.ok, "push register (fake token) for Bob");
if (REAL_TOKEN) check((await api("/api/push/register", b.access, { token: REAL_TOKEN, platform: "android" })).j.ok, "push register (real emulator token) for Bob");
const p = await api("/api/notifications/prefs", b.access);
check(p.j.ok && p.j.prefs.dm === true && p.j.prefs.contactsOptIn === false, "prefs defaults", p.j);
const p2 = await api("/api/notifications/prefs", b.access, { newFollower: true, quietHours: null });
check(p2.j.ok, "prefs update");

// Bob is backgrounded (no visible socket) → DM push via FCM; the fake token should be pruned as invalid
b.c.ws.close();
await new Promise((r) => setTimeout(r, 500));
const dm = await a.c.req("dm:send", { to: b.id, text: "Hey Bob — push test from smoke-push" });
check(dm.ok, "Alice → Bob DM sent");
const f = await a.c.req("user:follow", { userId: b.id, follow: true });
check(f.ok, "Alice follows Bob (new follower push)");
await new Promise((r) => setTimeout(r, 4000));

// contacts
const h = (e) => createHash("sha256").update(e).digest("hex");
const m0 = await api("/api/contacts/match", a.access, { hashes: [h("+15550000001")] });
check(m0.status === 400, "contacts match requires opt-in");
await api("/api/notifications/prefs", a.access, { contactsOptIn: true });
const bobPhone = `+1415${sfx}2`.slice(0, 12);
const m1 = await api("/api/contacts/match", a.access, { hashes: [h(bobPhone), h("+15550000001")] });
check(m1.j.ok && m1.j.users.length === 1 && m1.j.users[0].id === b.id, "contacts match finds Bob", m1.j);
const del = await api("/api/contacts/delete", a.access, {});
check(del.j.ok, "delete uploaded contacts");
const card = await fetch(`${HTTP}/api/users/by-handle/bob${sfx}`).then((r) => r.json());
check(card.ok && card.user.name === "Bob" && !("phone" in card.user), "public profile card (no phone)", card);
const page = await fetch(`${HTTP}/@bob${sfx}`).then((r) => r.text());
check(page.includes(`og:title`) && page.includes("Bob"), "/@handle renders with Open Graph tags");
console.log(failures ? `FAILED (${failures})` : "PASSED");
process.exit(failures ? 1 : 0);
