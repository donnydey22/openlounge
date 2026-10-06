// Restart durability test (works with Postgres or the db.json fallback). Two phases around a server restart:
//   node scripts/smoke-restart.mjs setup  [ws://host:port/ws]   → creates users, follows, profile edits, photo,
//                                                                 DMs + read cursor, an open room, an ended room,
//                                                                 a revoked session; saves ids to /tmp
//   (restart the server)
//   node scripts/smoke-restart.mjs verify [ws://host:port/ws]   → checks all of it came back
import fs from "node:fs";
import WebSocket from "ws";

const phase = process.argv[2];
const URL = process.argv[3] ?? "ws://localhost:3000/ws";
const STATE = "/tmp/openlounge-restart.json";
let failures = 0;
const check = (cond, label, extra) => {
  console.log(`${cond ? "✓" : "✗"} ${label}${!cond && extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 400) : ""}`);
  if (!cond) failures++;
};

function client() {
  const ws = new WebSocket(URL);
  let seq = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "res") pending.get(m.id)?.(m.data), pending.delete(m.id);
  });
  const open = new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  const req = (ev, data = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ t: "req", id, ev, data }));
      setTimeout(() => pending.has(id) && reject(new Error(`timeout ${ev}`)), 8000);
    });
  return { open, req, close: () => ws.close() };
}

async function signup(phone, first, username, interests) {
  const c = client();
  await c.open;
  const r = await c.req("auth:requestCode", { phone });
  const v = await c.req("auth:verifyCode", { phone, code: r.demoCode ?? "000000" });
  const reg = await c.req("auth:register", { ticket: v.ticket, firstName: first, lastName: "Restart", username, bio: "before", color: "#34d399", interests });
  check(reg.ok && reg.token, `signup @${username}`, reg);
  return { c, token: reg.token, user: reg.user, phone };
}

// 1×1 PNG
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const I = ["🔊 Drop-in talks", "🛠️ Builders & makers", "🧪 Experiments"];

if (phase === "setup") {
  const stamp = Date.now().toString().slice(-6);
  const A = await signup(`+1666${stamp}1`.slice(0, 12), "Ada", `rada${stamp}`, [I[0], I[1]]);
  const B = await signup(`+1666${stamp}2`.slice(0, 12), "Bo", `rbo${stamp}`, [I[0]]);

  const upd = await A.c.req("user:update", { bio: "Persisted bio ✨", interests: [I[1], I[2]] });
  check(upd.ok && upd.user.bio === "Persisted bio ✨", "A edits bio + interests", upd);
  const ph = await A.c.req("user:photo", { photo: PNG });
  check(ph.ok && ph.user.photoUrl, "A uploads photo", ph);
  check((await A.c.req("user:follow", { userId: B.user.id, follow: true })).ok, "A follows B");
  check((await A.c.req("user:follow", { userId: "bot-maya", follow: true })).ok, "A follows bot-maya");
  check((await A.c.req("user:follow", { userId: "bot-jordan", follow: true })).ok, "A follows bot-jordan");
  check((await A.c.req("user:follow", { userId: "bot-jordan", follow: false })).ok, "A unfollows bot-jordan");
  check((await B.c.req("user:follow", { userId: A.user.id, follow: true })).ok, "B follows A");

  check((await A.c.req("dm:send", { to: B.user.id, text: "hello across restarts" })).ok, "A → B DM");
  await new Promise((r) => setTimeout(r, 20));
  check((await B.c.req("dm:send", { to: A.user.id, text: "reply from Bo" })).ok, "B → A DM");
  check((await A.c.req("dm:send", { to: "bot-maya", text: "hi maya" })).ok, "A → bot DM");

  const open = await A.c.req("room:create", { title: "Survives restart", topic: "Tech", description: "persisted room" });
  check(open.ok, "A creates a room (left open)", open);
  const gone = await A.c.req("room:create", { title: "Ended before restart", topic: "Tech" });
  await A.c.req("room:join", { roomId: gone.roomId });
  check((await A.c.req("room:end", { roomId: gone.roomId })).ok, "A creates + ends a second room");

  // a second session for A that gets revoked
  const c2 = client();
  await c2.open;
  const rc = await c2.req("auth:requestCode", { phone: A.phone });
  const v2 = await c2.req("auth:verifyCode", { phone: A.phone, code: rc.demoCode ?? "000000" });
  check(v2.ok && v2.status === "existing", "A signs in again (2nd session)", v2);
  check((await c2.req("session:logout")).ok, "2nd session logged out (revoked)");
  c2.close();

  await new Promise((r) => setTimeout(r, 2500)); // let the bot DM reply land + debounced save run
  fs.writeFileSync(
    STATE,
    JSON.stringify({ A: { id: A.user.id, token: A.token, phone: A.phone, username: A.user.username }, B: { id: B.user.id, token: B.token }, revoked: v2.token, roomId: open.roomId, endedRoomId: gone.roomId }),
  );
  A.c.close();
  B.c.close();
} else if (phase === "verify") {
  const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const a = client();
  await a.open;
  const ra = await a.req("session:resume", { token: s.A.token });
  check(ra.ok && ra.user?.id === s.A.id, "A's session survived restart", ra);
  check(ra.user?.bio === "Persisted bio ✨", "A's bio survived", ra.user);
  check(JSON.stringify(ra.user?.interests) === JSON.stringify([I[1], I[2]]), "A's interests survived (order kept)", ra.user?.interests);
  check(ra.user?.username === s.A.username && ra.user?.phoneMasked, "username + masked phone survived", ra.user);
  check(typeof ra.user?.photoUrl === "string" && ra.user.photoUrl.includes(s.A.id), "photo version survived", ra.user?.photoUrl);
  check(JSON.stringify([...(ra.following ?? [])].sort()) === JSON.stringify([s.B.id, "bot-maya"].sort()), "A's follows survived (unfollow too)", ra.following);
  const http = URL.replace(/^ws/, "http").replace(/\/ws$/, "");
  const img = await fetch(http + ra.user.photoUrl);
  check(img.ok && img.headers.get("content-type") === "image/png", `avatar file served (${img.status})`);

  const prof = await a.req("user:get", { userId: s.A.id });
  check(prof.ok && prof.profile.followers.some((u) => u.id === s.B.id), "B shows in A's followers", prof.profile?.followers?.map((u) => u.id));

  const revoked = await client();
  await revoked.open;
  check(!(await revoked.req("session:resume", { token: s.revoked })).ok, "revoked session stays revoked");
  revoked.close();

  const list = await a.req("dm:list");
  const withB = list.conversations?.find((c) => c.peer.id === s.B.id);
  check(withB && withB.lastMessage.text === "reply from Bo" && withB.unread === 1, "A's DM list: last message + unread survived", withB);
  const withBot = list.conversations?.find((c) => c.peer.id === "bot-maya");
  check(withBot, "DM thread with a bot survived", list.conversations?.map((c) => c.peer.id));
  const hist = await a.req("dm:history", { peerId: s.B.id });
  check(hist.ok && hist.messages.map((m) => m.text).join("|") === "hello across restarts|reply from Bo", "DM history survived in order", hist.messages?.map((m) => m.text));

  const b = client();
  await b.open;
  const rb = await b.req("session:resume", { token: s.B.token });
  check(rb.ok && rb.unreadDms === 0, "B's session + read cursor survived (0 unread)", rb);
  check(rb.following?.includes(s.A.id), "B's follow survived");

  const rooms = await a.req("rooms:list");
  const room = rooms.rooms.find((r) => r.id === s.roomId);
  check(room && room.title === "Survives restart" && room.hostId === s.A.id && room.description === "persisted room", "open room survived restart", room);
  check(!rooms.rooms.some((r) => r.id === s.endedRoomId), "ended room did not come back");
  const join = await a.req("room:join", { roomId: s.roomId });
  check(join.ok && join.room.hostId === s.A.id, "host can rejoin the persisted room", join);

  const taken = await b.req("auth:checkUsername", { username: s.A.username });
  check(taken.ok && !taken.available, "A's username still taken");
  const c = client();
  await c.open;
  const rc = await c.req("auth:requestCode", { phone: s.A.phone });
  const v = await c.req("auth:verifyCode", { phone: s.A.phone, code: rc.demoCode ?? "000000" });
  check(v.ok && v.status === "existing" && v.user?.id === s.A.id, "phone login finds the same account", v);
  a.close();
  b.close();
  c.close();
} else {
  console.error("usage: node scripts/smoke-restart.mjs setup|verify [ws://host:port/ws]");
  process.exit(2);
}
await new Promise((r) => setTimeout(r, 50));
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
