// Photos / files / albums in groups: sent through server/media into the group fan-out, viewable by current members only,
// media:update reaches every member, view once refused (1:1 only), timers allowed. Real server + local Postgres.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
process.env.TEST_DATABASE_URL ||= "postgresql://ua@127.0.0.1:55433/groups_media_test";
process.env.MEDIA_SWEEP_MS ||= "500";
import path from "node:path";
import { setTestEnv, wipeDb, api, phoneLogin, sql } from "../unified-auth/harness";
import { makeFixtures } from "../media/fixtures";

setTestEnv({ providers: false });
type L = Awaited<ReturnType<typeof phoneLogin>>;
let A: L, B: L, C: L, D: L;
let base = "";
let server: http.Server;
let f: (n: string) => string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let media: any;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tok = (x: L) => x.res.access as string;
const id = (x: L) => x.res.user.id as string;
const box: Record<string, { ev: string; data: any }[]> = {};

async function startApp() {
  const { store } = await import("../../server/store");
  const { api: apiFn, isApiRequest } = await import("../../server/http");
  const { WsHub } = await import("../../server/ws");
  const { registerRealtime } = await import("../../server/realtime");
  const { originAllowed } = await import("../../server/auth");
  media = (await import("../../server/media/service")).media;
  await store.init();
  await media.ready();
  server = http.createServer((req, res) => {
    if (isApiRequest(req.url ?? "")) return void apiFn(req, res).catch((e) => (console.error(e), res.writeHead(503).end()));
    res.writeHead(404).end();
  });
  const hub = new WsHub(server, "/ws", (req: IncomingMessage) => originAllowed(req.headers.origin, req.headers.host));
  registerRealtime(hub);
  media.attachHub(hub);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function listen(x: L) {
  const b: { ev: string; data: any }[] = [];
  x.client.ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "evt") b.push({ ev: m.ev, data: m.data });
  });
  box[id(x)] = b;
}
async function upload(x: L, file: string, kind: string) {
  const buf = fs.readFileSync(file);
  const start = await api(base, "/api/media/uploads", { kind, name: file.split("/").pop(), size: buf.length, mime: "application/octet-stream" }, { token: tok(x) });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const uploadId = start.data.uploadId;
  const r = await fetch(`${base}/api/media/uploads/${uploadId}?offset=0`, { method: "PUT", headers: { Authorization: `Bearer ${tok(x)}`, "Content-Type": "application/octet-stream" }, body: buf });
  assert.equal(r.status, 200);
  const done = await api(base, `/api/media/uploads/${uploadId}/complete`, {}, { token: tok(x) });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  return done.data.media?.id ?? done.data.mediaId ?? done.data.id;
}
const sign = async (x: L, mediaId: string) => (await api(base, "/api/media/sign", { items: [{ id: mediaId, v: ["thumb", "full"] }] }, { token: tok(x) })).data.urls?.[mediaId];

before(async () => {
  f = await makeFixtures();
  await wipeDb();
  await startApp();
  const mk = (n: string) => phoneLogin(base.replace("http", "ws") + "/ws", phone(), { firstName: n, username: `${n.toLowerCase()}_${uniq()}` });
  [A, B, C, D] = await Promise.all(["Maya", "Ryan", "Cara", "Dan"].map(mk));
  for (const x of [A, B, C, D]) listen(x);
});
after(async () => {
  for (const x of [A, B, C, D]) x?.client.close();
  await media?.close?.();
  server?.close();
});

test("a photo in a group: one message to every member, signed URLs for members only, leaving revokes access", async () => {
  const g = await A.client.req("group:create", { title: "Photos " + uniq(), memberIds: [id(B), id(C)] });
  assert.equal(g.ok, true, JSON.stringify(g));
  const gid = g.group.id as string;
  const mid = await upload(A, f("gps.jpg"), "photo");
  assert.ok(mid, "upload id");
  const s = await api(base, "/api/media/send", { to: gid, mediaId: mid, clientId: `c${uniq()}`, caption: "camp spot" }, { token: tok(A) });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const msg = s.data.message;
  assert.equal(msg.toId, gid);
  assert.equal(msg.conversationId, gid);
  assert.equal(msg.media.kind, "photo");
  assert.equal(msg.text, "camp spot");
  await sleep(300);
  for (const x of [B, C]) assert.ok(box[id(x)].some((e) => e.ev === "dm:message" && e.data.id === msg.id && e.data.media?.id === mid), "members get the media message");
  assert.ok(!box[id(D)].some((e) => e.ev === "dm:message" && e.data.id === msg.id), "non-members get nothing");
  const h = await C.client.req("dm:history", { peerId: gid });
  assert.equal(h.messages.find((m: any) => m.id === msg.id)?.media?.id, mid, "history carries the attachment");
  assert.ok((await sign(B, mid))?.full, "a member can load it");
  assert.ok(!(await sign(D, mid))?.full, "an outsider can't");
  // retried send (lost ack) → same message
  const again = await api(base, "/api/media/send", { to: gid, mediaId: mid, clientId: `c${uniq()}` }, { token: tok(A) });
  assert.equal(again.data.message?.id, msg.id);
  // inbox preview reads the caption / label
  const row = (await B.client.req("conv:list")).items.find((x: any) => x.id === gid);
  assert.equal(row.lastMessage.id, msg.id);
  assert.equal((await C.client.req("group:leave", { id: gid })).ok, true);
  assert.ok(!(await sign(C, mid))?.full, "after leaving, no more access");
});

test("albums and voice notes go to groups; view once is refused (1:1 only); a timer is allowed and media:update reaches members", async () => {
  const g = await A.client.req("group:create", { title: "Album " + uniq(), memberIds: [id(B)] });
  const gid = g.group.id as string;
  const p1 = await upload(A, f("gps.jpg"), "photo");
  const p2 = await upload(A, f("alpha.png"), "photo");
  const al = await api(base, "/api/media/send", { to: gid, mediaIds: [p1, p2], clientId: `c${uniq()}` }, { token: tok(A) });
  assert.equal(al.status, 200, JSON.stringify(al.data));
  assert.equal(al.data.message.attachments.length, 2);
  const once = await upload(A, f("gps.jpg"), "photo");
  const vo = await api(base, "/api/media/send", { to: gid, mediaId: once, viewOnce: true, clientId: `c${uniq()}` }, { token: tok(A) });
  assert.equal(vo.status, 400);
  assert.match(String(vo.data.error), /1:1/);
  const t = await api(base, "/api/media/send", { to: gid, mediaId: once, ttlSeconds: 60, clientId: `c${uniq()}` }, { token: tok(A) });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  assert.ok(t.data.message.media.expiresAt > Date.now());
  const v = await upload(B, f("voice.webm"), "voice");
  const vs = await api(base, "/api/media/send", { to: gid, mediaId: v, clientId: `c${uniq()}` }, { token: tok(B) });
  assert.equal(vs.status, 200, JSON.stringify(vs.data));
  assert.equal(vs.data.message.media.kind, "voice");
  // sender deletes the timed photo → media:update to every member
  const del = await api(base, `/api/media/${once}/delete`, { all: true }, { token: tok(A) });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  await sleep(400);
  assert.ok(box[id(B)].some((e) => e.ev === "media:update" && e.data.messageId === t.data.message.id), "members hear media:update");
  // non-member can't send into the group
  const dm = await upload(D, f("gps.jpg"), "photo");
  const out = await api(base, "/api/media/send", { to: gid, mediaId: dm, clientId: `c${uniq()}` }, { token: tok(D) });
  assert.notEqual(out.status, 200);
});

const fileDir = async (id: string) => path.join((await import("../../server/media/config")).MEDIA_DIR, id.slice(0, 2), id);
const rowCount = async (id: string) => Number((await sql<{ n: string }>("SELECT count(*)::text AS n FROM media WHERE id = $1", [id]))[0]?.n ?? 0);

test("deleting a group message for everyone (sender or admin) erases its files and rows; albums go entirely", async () => {
  const g = await A.client.req("group:create", { title: "Cleanup " + uniq(), memberIds: [id(B)] });
  const gid = g.group.id as string;
  // B's own photo, deleted by B
  const p = await upload(B, f("gps.jpg"), "photo");
  const s1 = await api(base, "/api/media/send", { to: gid, mediaId: p, clientId: `c${uniq()}` }, { token: tok(B) });
  assert.equal(s1.status, 200);
  await sleep(200);
  assert.ok(fs.existsSync(await fileDir(p)), "file on disk after send");
  assert.equal((await B.client.req("group:deleteMessage", { id: gid, messageId: s1.data.message.id })).ok, true);
  await sleep(300);
  assert.ok(!fs.existsSync(await fileDir(p)), "file erased");
  assert.equal(await rowCount(p), 0, "media row removed");
  // B's album, deleted by the owner/admin A
  const a1 = await upload(B, f("gps.jpg"), "photo");
  const a2 = await upload(B, f("alpha.png"), "photo");
  const s2 = await api(base, "/api/media/send", { to: gid, mediaIds: [a1, a2], clientId: `c${uniq()}` }, { token: tok(B) });
  assert.equal(s2.status, 200);
  assert.equal((await A.client.req("group:deleteMessage", { id: gid, messageId: s2.data.message.id })).ok, true);
  await sleep(300);
  for (const x of [a1, a2]) {
    assert.ok(!fs.existsSync(await fileDir(x)), "album files erased");
    assert.equal(await rowCount(x), 0);
  }
  assert.ok(!(await sign(B, a1))?.full);
});

test("a deleted group (last member out) keeps its files (history is permanent); only self-destruct media is purged", async () => {
  const keep = await A.client.req("group:create", { title: "Keep " + uniq(), memberIds: [id(B)] });
  const kp = await upload(A, f("gps.jpg"), "photo");
  assert.equal((await api(base, "/api/media/send", { to: keep.group.id, mediaId: kp, clientId: `c${uniq()}` }, { token: tok(A) })).status, 200);
  const g = await A.client.req("group:create", { title: "Doomed " + uniq(), memberIds: [id(B)] });
  const gid = g.group.id as string;
  const ids = [await upload(A, f("gps.jpg"), "photo"), await upload(B, f("voice.webm"), "voice")];
  assert.equal((await api(base, "/api/media/send", { to: gid, mediaId: ids[0], clientId: `c${uniq()}` }, { token: tok(A) })).status, 200);
  assert.equal((await api(base, "/api/media/send", { to: gid, mediaId: ids[1], clientId: `c${uniq()}` }, { token: tok(B) })).status, 200);
  assert.equal((await B.client.req("group:leave", { id: gid })).ok, true);
  await sleep(200);
  for (const x of ids) assert.ok(fs.existsSync(await fileDir(x)), "still there while a member remains");
  const last = await A.client.req("group:leave", { id: gid });
  assert.equal(last.deleted, true);
  await sleep(400);
  for (const x of ids) {
    assert.ok(fs.existsSync(await fileDir(x)), "kept after the last member leaves");
    assert.equal(await rowCount(x), 1);
  }
  assert.ok(fs.existsSync(await fileDir(kp)), "another group's file is untouched");
});

test("sweeper: a group attachment whose message was deleted for everyone is erased; live ones stay", async () => {
  const { store } = await import("../../server/store");
  const g = await A.client.req("group:create", { title: "Trim " + uniq(), memberIds: [id(B)] });
  const gid = g.group.id as string;
  const gone = await upload(A, f("gps.jpg"), "photo");
  const live = await upload(A, f("alpha.png"), "photo");
  const s1 = await api(base, "/api/media/send", { to: gid, mediaId: gone, clientId: `c${uniq()}` }, { token: tok(A) });
  assert.equal((await api(base, "/api/media/send", { to: gid, mediaId: live, clientId: `c${uniq()}` }, { token: tok(A) })).status, 200);
  store.removeConversationMessage(gid, s1.data.message.id); // delete for everyone (leaves a content-free placeholder)
  await media.sweep();
  assert.ok(!fs.existsSync(await fileDir(gone)));
  assert.equal(await rowCount(gone), 0);
  assert.ok(fs.existsSync(await fileDir(live)), "attachments of live messages stay");
});
