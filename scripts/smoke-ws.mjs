// End-to-end smoke test for the raw WebSocket protocol. Run with the server up:
//   npm run smoke            (or: node scripts/smoke-ws.mjs ws://host:port/ws)
import WebSocket from "ws";

const URL = process.argv[2] ?? "ws://localhost:3000/ws";
const HTTP = URL.replace(/^ws/, "http").replace(/\/ws$/, "");
let failures = 0;
const check = (cond, label, extra) => {
  console.log(`${cond ? "✓" : "✗"} ${label}${!cond && extra !== undefined ? " — " + JSON.stringify(extra) : ""}`);
  if (!cond) failures++;
};

function client() {
  const ws = new WebSocket(URL);
  let seq = 0;
  const pending = new Map();
  const events = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "res") pending.get(m.id)?.(m.data), pending.delete(m.id);
    else if (m.t === "evt") {
      events.push(m);
      for (const w of [...waiters]) if (w.ev === m.ev && w.pred(m.data)) waiters.splice(waiters.indexOf(w), 1), w.resolve(m.data);
    }
  });
  const open = new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  return {
    open,
    req: (ev, data = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ t: "req", id, ev, data }));
        setTimeout(() => pending.has(id) && reject(new Error(`timeout ${ev}`)), 8000);
      }),
    wait: (ev, pred = () => true, ms = 8000) =>
      new Promise((resolve, reject) => {
        const hit = events.find((e) => e.ev === ev && pred(e.data));
        if (hit) return resolve(hit.data);
        waiters.push({ ev, pred, resolve });
        setTimeout(() => reject(new Error(`no ${ev} event`)), ms);
      }),
    close: () => ws.close(),
  };
}

async function signup(phone, first, username) {
  const c = client();
  await c.open;
  const r = await c.req("auth:requestCode", { phone });
  check(r.ok && /^\d{6}$/.test(r.demoCode ?? ""), `requestCode ${phone} (demo code shown)`, r);
  const wrong = r.demoCode === "111111" ? "222222" : "111111";
  const bad = await c.req("auth:verifyCode", { phone, code: wrong });
  check(!bad.ok, "wrong code rejected", bad);
  const v = await c.req("auth:verifyCode", { phone, code: r.demoCode });
  check(v.ok && v.status === "new" && v.ticket, "verify → new-account ticket", v);
  const u = await c.req("auth:checkUsername", { username });
  check(u.ok && u.available, `username @${username} available`, u);
  const reg = await c.req("auth:register", { ticket: v.ticket, firstName: first, lastName: "Tester", username, bio: "smoke", color: "#34d399", interests: ["Tech"] });
  check(reg.ok && reg.token && reg.user?.username === username, "register → session", reg);
  return { c, token: reg.token, user: reg.user };
}

const stamp = Date.now().toString().slice(-6);
const phoneA = `+1555${stamp}1`.slice(0, 12);
const phoneB = `+1555${stamp}2`.slice(0, 12);
const A = await signup(phoneA, "Ada", `ada${stamp}`);
const B = await signup(phoneB, "Bo", `bo${stamp}`);

const dup = await A.c.req("auth:checkUsername", { username: `bo${stamp}` });
check(dup.ok && !dup.available, "taken username reported", dup);

// returning login (resend is throttled for 30 s; demo mode also accepts 000000)
{
  const c = client();
  await c.open;
  const rc = await c.req("auth:requestCode", { phone: phoneA });
  const v = await c.req("auth:verifyCode", { phone: phoneA, code: rc.demoCode ?? "000000" });
  check(v.ok && v.status === "existing" && v.user?.id === A.user.id, "returning user → existing session", v);
  c.close();
}

{
  const c = client();
  await c.open;
  const r = await c.req("session:resume", { token: A.token });
  check(r.ok && r.user?.id === A.user.id, "session:resume with token", r);
  const bad = await c.req("session:resume", { token: "nope" });
  check(!bad.ok, "bogus token rejected");
  c.close();
}

const created = await A.c.req("room:create", { title: "Smoke test room", topic: "Tech" });
check(created.ok && created.roomId, "room:create", created);
const roomId = created.roomId;
const ja = await A.c.req("room:join", { roomId });
check(ja.ok && ja.audio, `host joins (audio.enabled=${ja.audio?.enabled})`, ja);
const jb = await B.c.req("room:join", { roomId });
check(jb.ok && Array.isArray(jb.chat), "listener joins with chat history", jb);
const gotChat = B.c.wait("chat:message", (m) => m.text === "hello from Ada");
const sent = await A.c.req("chat:send", { roomId, text: "hello from Ada" });
check(sent.ok, "chat:send", sent);
const msg = await gotChat;
check(msg.authorName && msg.authorRole === "host" && msg.createdAt, "chat delivered with author/role/timestamp", msg);
await B.c.req("room:leave", { roomId });
const rejoined = await B.c.req("room:join", { roomId });
check(rejoined.ok && rejoined.chat?.some((m) => m.id === msg.id), "room chat history restored after rejoin", rejoined);

{
  const res = await fetch(`${HTTP}/api/livekit/token`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${A.token}` }, body: JSON.stringify({ roomId }) });
  const body = await res.json();
  check(ja.audio?.enabled ? res.ok && body.token : res.status === 503, `/api/livekit/token → ${res.status}`, body);
}

const clientId = `smoke-${stamp}`;
const gotDm = B.c.wait("dm:message", (m) => m.text === "psst");
const dm = await A.c.req("dm:send", { to: B.user.id, text: "psst", clientId });
check(dm.ok, "dm:send", dm);
const dmMsg = await gotDm;
check(dmMsg.fromId === A.user.id, "DM delivered in real time", dmMsg);
const retry = await A.c.req("dm:send", { to: B.user.id, text: "psst", clientId });
check(retry.ok && retry.message?.id === dm.message?.id, "repeated DM send is idempotent", retry);
const list = await B.c.req("dm:list");
check(list.ok && list.conversations?.some((c) => c.peer?.id === A.user.id && c.unread >= 1), "dm:list shows unread conversation", list);
const hist = await B.c.req("dm:history", { peerId: A.user.id });
check(hist.ok && hist.messages?.filter((m) => m.text === "psst").length === 1, "DM history contains only one retried send", hist);
const catchUp = await B.c.req("dm:since", { after: dmMsg.createdAt - 1 });
check(catchUp.ok && catchUp.messages?.some((m) => m.id === dmMsg.id), "dm:since returns missed messages after reconnect", catchUp);
const receiptWait = A.c.wait("dm:read-receipt", (r) => r.readerId === B.user.id && r.peerId === A.user.id);
const read = await B.c.req("dm:read", { peerId: A.user.id, upToMessageId: dmMsg.id });
check(read.ok, "dm:read advances the recipient read cursor", read);
const receipt = await receiptWait;
check(receipt.upToMessageId === dmMsg.id && receipt.readAt, "sender receives the matching read receipt", receipt);
const readList = await B.c.req("dm:list");
check(readList.conversations?.find((c) => c.peer?.id === A.user.id)?.unread === 0, "read receipt clears the conversation unread count", readList);

const ended = B.c.wait("room:ended");
const end = await A.c.req("room:end", { roomId });
check(end.ok, "room:end", end);
await ended;
check(true, "room:ended broadcast to listeners");

A.c.close();
B.c.close();
// state for the optional restart check (scripts/smoke-persist.mjs)
import("node:fs").then((fs) => fs.writeFileSync("/tmp/openlounge-smoke.json", JSON.stringify({ tokenB: B.token, peerA: A.user.id })));
await new Promise((r) => setTimeout(r, 50));
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
