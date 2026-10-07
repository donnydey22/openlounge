// Two-client presence check against a running server:  node scripts/verify-presence.mjs ws://localhost:3000/ws
// Measures online/offline flip latency as seen by a second client and checks that the lastSeenAt pushed in
// presence:update, the reconnect snapshot and the profile (user:get) are the SAME value.
import WebSocket from "ws";
const URL = process.argv[2] ?? "ws://localhost:3000/ws";
let fails = 0;
const check = (ok, label, extra) => (console.log(`${ok ? "✓" : "✗"} ${label}${extra !== undefined ? " — " + JSON.stringify(extra) : ""}`), ok || fails++);
function client() {
  const ws = new WebSocket(URL);
  let seq = 0; const pending = new Map(); const events = []; const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "res") pending.get(m.id)?.(m.data), pending.delete(m.id);
    else if (m.t === "evt") { m.at = Date.now(); events.push(m); for (const w of [...waiters]) if (w.ev === m.ev && w.pred(m.data)) waiters.splice(waiters.indexOf(w), 1), w.resolve(m); }
  });
  return {
    open: new Promise((r, j) => (ws.once("open", r), ws.once("error", j))),
    req: (ev, data = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ t: "req", id, ev, data })); setTimeout(() => pending.has(id) && reject(new Error(`timeout ${ev}`)), 8000); }),
    emit: (ev, data = {}) => ws.send(JSON.stringify({ t: "evt", ev, data })),
    wait: (ev, pred = () => true, ms = 10000) => new Promise((resolve, reject) => { waiters.push({ ev, pred, resolve }); setTimeout(() => reject(new Error(`no ${ev}`)), ms); }),
    close: () => ws.close(),
  };
}
async function signup(phone, first, username) {
  const c = client(); await c.open;
  const r = await c.req("auth:requestCode", { phone });
  const v = await c.req("auth:verifyCode", { phone, code: r.demoCode });
  const reg = await c.req("auth:register", { ticket: v.ticket, firstName: first, lastName: "T", username, bio: "", color: "#34d399", interests: ["Tech"] });
  if (!reg.ok) throw new Error(JSON.stringify(reg));
  return { c, token: reg.token, user: reg.user };
}
const stamp = Date.now().toString().slice(-6);
const A = await signup(`+1555${stamp}1`.slice(0, 12), "Ada", `ada${stamp}`);
const B = await signup(`+1555${stamp}2`.slice(0, 12), "Bo", `bo${stamp}`);
const isA = (s) => (d) => d.userId === A.user.id && d.status === s;

// 1) last socket closes → offline
let t = Date.now(); A.c.close();
let off = await B.c.wait("presence:update", isA("offline"));
const offMs = off.at - t;
check(offMs < 2000, `offline flip after close: ${offMs} ms (CLOSE_GRACE_MS 1.5 s refresh debounce)`);
const seen = off.data.lastSeenAt;
check(Math.abs(seen - t) < 200, "lastSeenAt = disconnect time", { lastSeenAt: seen, closedAt: t });
const prof = await B.c.req("user:get", { userId: A.user.id });
check(prof.profile.user.lastSeenAt === seen, "profile lastSeenAt === presence:update lastSeenAt", [prof.profile.user.lastSeenAt, seen]);

// 2) a fresh client's snapshot carries the same value
const C = client(); await C.open; const snapP = C.wait("presence:snapshot");
await C.req("session:resume", { token: B.token }); const snap = (await snapP).data;
check(snap.lastSeen[A.user.id] === seen && !snap.onlineIds.includes(A.user.id), "reconnect snapshot: A offline, same lastSeenAt", snap.lastSeen[A.user.id]);
check(typeof snap.now === "number" && Math.abs(snap.now - Date.now()) < 1000, "snapshot carries server now", snap.now);
check(!(B.user.id in snap.lastSeen), "online user has no stale lastSeen in snapshot");

// 3) reconnect → online immediately
const A2 = client(); await A2.open; t = Date.now();
const onP = B.c.wait("presence:update", isA("online")); await A2.req("session:resume", { token: A.token });
const on = await onP; check(on.at - t < 500, `online flip after connect: ${on.at - t} ms`);

// 4) backgrounded then socket dies → offline in seconds (was 120 s amber)
A2.emit("presence:visible", { visible: false });
await B.c.wait("presence:update", isA("away")); t = Date.now(); A2.close();
off = await B.c.wait("presence:update", isA("offline"), 15000);
check(off.at - t < 2500, `hidden socket closed → offline: ${off.at - t} ms (was 120000)`);

// 5) relative + absolute from the same value (viewer TZ)
const v = off.data.lastSeenAt; const agoS = Math.floor((Date.now() - v) / 1000);
console.log(`  label: "Active ${agoS < 60 ? "just now" : Math.floor(agoS / 60) + "m ago"}"  tooltip: ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(v)}`);
B.c.close(); C.close();
console.log(fails ? `FAILED (${fails})` : "PASSED"); process.exit(fails ? 1 : 0);
