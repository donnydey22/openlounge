// Presence smoke test: two users, multi-tab, visibility, heartbeat timeout, last seen.
//   node scripts/smoke-presence.mjs [ws://localhost:3000/ws]
// Run the server with short graces to keep it quick, e.g.
//   PRESENCE_HIDDEN_GRACE_MS=3000 npm run dev
import WebSocket from "ws";

const URL = process.argv[2] ?? "ws://localhost:3000/ws";
let failures = 0;
const check = (cond, label, extra) => {
  console.log(`${cond ? "✓" : "✗"} ${label}${!cond && extra !== undefined ? " — " + JSON.stringify(extra) : ""}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(opts = {}) {
  const ws = new WebSocket(URL, opts);
  let seq = 0;
  const pending = new Map();
  const events = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "res") pending.get(m.id)?.(m.data), pending.delete(m.id);
    else if (m.t === "evt") {
      events.push({ ...m, at: Date.now() });
      for (const w of [...waiters]) if (w.ev === m.ev && w.pred(m.data)) waiters.splice(waiters.indexOf(w), 1), w.resolve(m.data);
    }
  });
  const open = new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  return {
    ws,
    open,
    events,
    req: (ev, data = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ t: "req", id, ev, data }));
        setTimeout(() => pending.has(id) && reject(new Error(`timeout ${ev}`)), 8000);
      }),
    emit: (ev, data = {}) => ws.send(JSON.stringify({ t: "evt", ev, data })),
    wait: (ev, pred = () => true, ms = 8000) =>
      new Promise((resolve, reject) => {
        waiters.push({ ev, pred, resolve });
        setTimeout(() => reject(new Error(`no ${ev} event within ${ms}ms`)), ms);
      }),
    close: () => ws.close(),
  };
}

async function signup(phone, first, username) {
  const c = client();
  await c.open;
  const r = await c.req("auth:requestCode", { phone });
  const v = await c.req("auth:verifyCode", { phone, code: r.demoCode ?? "000000" });
  const reg = await c.req("auth:register", { ticket: v.ticket, firstName: first, lastName: "Presence", username, bio: "", color: "#34d399", interests: [] });
  check(reg.ok && reg.token, `signup ${first}`, reg);
  // Match the web/native client contract: every authenticated socket reports its actual
  // foreground state instead of relying on a server-side visible-by-default assumption.
  c.emit("presence:visible", { visible: true });
  return { c, token: reg.token, id: reg.user.id };
}

async function tab(token, opts) {
  const c = client(opts);
  await c.open;
  const r = await c.req("session:resume", { token });
  if (!r.ok) throw new Error("resume failed");
  c.emit("presence:visible", { visible: true });
  return c;
}

const isUpd = (id, online) => (d) => d.userId === id && d.online === online;
const stamp = Date.now().toString().slice(-6);
const A = await signup(`+1556${stamp}1`.slice(0, 12), "Ana", `ana${stamp}`);
const B = await signup(`+1556${stamp}2`.slice(0, 12), "Ben", `ben${stamp}`);
const watcher = A.c;

// ping round trip (client heartbeat)
const pong = await watcher.req("ping");
check(pong.ok && pong.now, "ping → pong");

// B's signup socket is tab 1; open tab 2 (another device)
const B2 = await tab(B.token);
let list = await watcher.req("users:list");
check(list.users.find((u) => u.id === B.id)?.online === true, "users:list: B online");

// close tab 1 → B must stay online (tab 2 still open)
const noFlip = watcher.wait("presence:update", isUpd(B.id, false), 7000).then(() => true, () => false);
B.c.close();
check(!(await noFlip), "closing one of two tabs does NOT mark B offline");

// background tab 2 (visibilitychange → hidden) → offline after the hidden grace
let t0 = Date.now();
const wentHidden = watcher.wait("presence:update", isUpd(B.id, false), 40_000);
B2.emit("presence:visible", { visible: false });
const off1 = await wentHidden;
check(off1.lastSeenAt && Math.abs(off1.lastSeenAt - t0) < 2000, `backgrounded → offline after ${Date.now() - t0} ms with lastSeenAt`, off1);

// foreground again → online immediately
t0 = Date.now();
const back = watcher.wait("presence:update", isUpd(B.id, true), 3000);
B2.emit("presence:visible", { visible: true });
await back;
check(true, `foreground → online in ${Date.now() - t0} ms`);

// close the last tab → offline after close grace
t0 = Date.now();
const closed = watcher.wait("presence:update", isUpd(B.id, false), 10_000);
B2.close();
const off2 = await closed;
check(off2.lastSeenAt, `last tab closed → offline in ${Date.now() - t0} ms`, off2);
list = await watcher.req("users:list");
const bRow = list.users.find((u) => u.id === B.id);
check(bRow?.online === false && bRow?.lastSeenAt === off2.lastSeenAt, "users:list: B offline with lastSeenAt", bRow);
const prof = await watcher.req("user:get", { userId: B.id });
check(prof.profile?.user.online === false && prof.profile.user.lastSeenAt, "user:get: lastSeenAt on profile", prof.profile?.user);

// snapshot on (re)connect carries lastSeen
const A2 = await tab(A.token);
await sleep(200);
const snap = A2.events.find((e) => e.ev === "presence:snapshot")?.data;
check(snap?.onlineIds.includes(A.id) && !snap.onlineIds.includes(B.id) && snap.lastSeen?.[B.id], "presence:snapshot: onlineIds + lastSeen", snap);
A2.close();

// half-open connection: client stops answering pings → server kills it (heartbeat) → offline
t0 = Date.now();
const deadOn = watcher.wait("presence:update", isUpd(B.id, true), 3000);
const dead = await tab(B.token, { autoPong: false });
await deadOn;
const deadOff = watcher.wait("presence:update", isUpd(B.id, false), 40_000);
await deadOff;
check(true, `unresponsive socket (no pongs) → offline in ${Date.now() - t0} ms`);
dead.ws.terminate();

// room keeps a backgrounded listener online
const b3On = watcher.wait("presence:update", isUpd(B.id, true), 3000);
const B3 = await tab(B.token);
await b3On;
const room = await watcher.req("room:create", { title: "Presence room", topic: "Tech" });
await watcher.req("room:join", { roomId: room.roomId });
const jb = await B3.req("room:join", { roomId: room.roomId });
check(jb.ok, "B joins room");
// in-room presence dot (room:state participants[].presence)
const pres = (st, id) => st.participants.find((p) => p.userId === id)?.presence;
check(pres(jb.room, B.id) === "online", "room:state: B presence = online after join", jb.room.participants);
const toAway = watcher.wait("room:state", (st) => pres(st, B.id) === "away", 3000);
B3.emit("presence:visible", { visible: false });
await toAway;
check(true, "room:state: B backgrounded → presence away");
const toOnline = watcher.wait("room:state", (st) => pres(st, B.id) === "online", 3000);
B3.emit("presence:visible", { visible: true });
await toOnline;
check(true, "room:state: B foreground → presence online");
const stay = watcher.wait("presence:update", isUpd(B.id, false), 8000).then(() => true, () => false);
B3.emit("presence:visible", { visible: false });
check(!(await stay), "backgrounded but listening in a room → stays online");
const leaveOff = watcher.wait("presence:update", isUpd(B.id, false), 40_000);
await B3.req("room:leave", { roomId: room.roomId });
await leaveOff;
check(true, "left room while backgrounded → offline");
// connection drop: seat held for the grace window → "away" (+ away flag), then back online on rejoin
const B5 = await tab(B.token);
await B5.req("room:join", { roomId: room.roomId });
const dropAway = watcher.wait("room:state", (st) => pres(st, B.id) === "away" && st.participants.find((p) => p.userId === B.id)?.away === true, 5000);
B5.ws.terminate();
await dropAway;
check(true, "room:state: ws dropped → presence away (seat held)");
const B6 = await tab(B.token);
const rj = await B6.req("room:join", { roomId: room.roomId });
check(pres(rj.room, B.id) === "online", "room:state: rejoined → presence online");
const gone = watcher.wait("room:state", (st) => !st.participants.some((p) => p.userId === B.id), 3000);
await B6.req("room:leave", { roomId: room.roomId });
await gone;
check(true, "room:state: left → no dot (participant removed)");
const b6Off = watcher.wait("presence:update", isUpd(B.id, false), 40_000);
B6.close();
await b6Off;
await watcher.req("room:end", { roomId: room.roomId });

// logout → offline immediately
const b4On = watcher.wait("presence:update", isUpd(B.id, true), 3000);
const B4 = await tab(B.token);
await b4On;
t0 = Date.now();
const lo = watcher.wait("presence:update", isUpd(B.id, false), 3000);
await B4.req("session:logout");
await lo;
check(true, `logout → offline in ${Date.now() - t0} ms`);

B3.close();
B4.close();
watcher.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll presence checks passed");
process.exit(failures ? 1 : 0);
