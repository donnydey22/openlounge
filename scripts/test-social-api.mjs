// API test for POST /api/me/social-links. Run with the server up: node scripts/test-social-api.mjs [http://localhost:3000]
import WebSocket from "ws";

const HTTP = process.argv[2] ?? "http://localhost:3000";
const WS = HTTP.replace(/^http/, "ws") + "/ws";
let fail = 0;
const check = (c, label, extra) => (console.log(`${c ? "✓" : "✗"} ${label}${!c && extra !== undefined ? " — " + JSON.stringify(extra) : ""}`), c || fail++);

function client() {
  const ws = new WebSocket(WS);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "res") pending.get(m.id)?.(m.data), pending.delete(m.id);
    else if (m.t === "evt") events.push(m);
  });
  return {
    open: new Promise((r, j) => (ws.once("open", r), ws.once("error", j))),
    events,
    req: (ev, data = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ t: "req", id, ev, data })); }),
    close: () => ws.close(),
  };
}
async function signup(phone, username) {
  const c = client();
  await c.open;
  const r = await c.req("auth:requestCode", { phone });
  const v = await c.req("auth:verifyCode", { phone, code: r.demoCode });
  const reg = await c.req("auth:register", { ticket: v.ticket, firstName: "Soc", lastName: "Test", username, bio: "", color: "#34d399", interests: ["Tech"] });
  check(reg.ok && reg.token, `signup @${username}`, reg);
  return { c, token: reg.token, user: reg.user };
}
const post = (token, body, extra = {}) =>
  fetch(`${HTTP}/api/me/social-links`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: JSON.stringify(body) });

const stamp = Date.now().toString().slice(-6);
const A = await signup(`+1555${stamp}7`.slice(0, 12), `soc${stamp}`);
const B = await signup(`+1555${stamp}8`.slice(0, 12), `soc${stamp}b`);

let r = await post(null, { links: { x: "@a" } });
check(r.status === 401, "no token → 401");
r = await post("garbage", { links: { x: "@a" } });
check(r.status === 401, "bad token → 401");
r = await post(A.token, { links: { x: "@a" } }, { Origin: "https://evil.example" });
check(r.status === 403, "foreign origin → 403");

r = await post(A.token, { links: { x: "@jack", instagram: "instagram.com/donny", website: "example.com", telegram: "t.me/durov", snapchat: "snapuser", threads: "@zuck" } });
let b = await r.json();
check(r.status === 200 && b.ok && b.user.socialLinks.x === "https://x.com/jack" && b.user.socialLinks.website === "https://example.com/" && b.user.socialLinks.threads === "https://www.threads.net/@zuck", "save normalizes", b);
await new Promise((res) => setTimeout(res, 300));
check(A.c.events.some((e) => e.ev === "me:update" && e.data.user?.socialLinks?.x), "me:update pushed to own sockets");

r = await post(A.token, { links: { website: "ftp://example.com", x: "bad handle!" } });
b = await r.json();
check(r.status === 400 && b.errors?.website && b.errors?.x, "invalid → 400 with per-field errors", b);

r = await post(A.token, { links: { x: "", instagram: null } });
b = await r.json();
check(r.ok && !b.user.socialLinks.x && !b.user.socialLinks.instagram && b.user.socialLinks.telegram, "clear some, keep others", b);

const prof = await B.c.req("user:get", { userId: A.user.id }).catch(() => null);
if (prof && prof.ok !== undefined) check(prof.profile?.user?.socialLinks?.telegram === "https://t.me/durov", "other users see links on profile", prof);

const v = await fetch(`${HTTP}/auth/validate`, { headers: { Authorization: `Bearer ${A.token}` } }).then((x) => x.json());
check(v.ok && v.user.socialLinks.telegram === "https://t.me/durov", "auth/validate still works and includes links", v);

let limited = false;
for (let i = 0; i < 12; i++) if ((await post(A.token, { links: { youtube: "@yt" + "abc" } })).status === 429) limited = true;
check(limited, "rate limited (429) after 10 saves/min");

A.c.close(); B.c.close();
console.log(fail ? `FAILED (${fail})` : "PASSED");
process.exit(fail ? 1 : 0);
