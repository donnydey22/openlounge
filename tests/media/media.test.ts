// Media pipeline: chunked/resumable uploads, MIME validation, caps, EXIF/GPS strip, thumbnails/posters, voice
// transcode + waveform, signed URLs (Range), block-aware access, self-destruct sweeper, view once, delete now, reconcile.
// Real app server (HTTP + WebSocket) against local Postgres; files in a temp UPLOAD_DIR.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import "./env";
import { setTestEnv, wipeDb, api, phoneLogin, sql } from "../unified-auth/harness";
import { makeFixtures } from "./fixtures";

/** public port: shared caches may hold a signed media response only while its link is valid, never more than 10 min */
function assertEdgeCache(v: string | null) {
  const m = /^public, max-age=(\d+), s-maxage=(\d+)$/.exec(v ?? "");
  assert.ok(m, `edge-bounded cache-control, got ${v}`);
  assert.equal(m[1], m[2]);
  assert.ok(Number(m[1]) > 0 && Number(m[1]) <= 600, `ttl ${m[1]} within (0, 600]`);
}

setTestEnv({ providers: false });
type L = Awaited<ReturnType<typeof phoneLogin>>;
let A: L, B: L, C: L;
let base = "";
let wsUrl = "";
let server: http.Server;
let f: (n: string) => string;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tok = (x: L) => x.res.access as string;
const id = (x: L) => x.res.user.id as string;
const events: Record<string, { ev: string; data: any }[]> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let media: any;

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
  wsUrl = base.replace("http", "ws") + "/ws";
  return store;
}

function listen(x: L) {
  const box: { ev: string; data: any }[] = [];
  x.client.ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "evt" && (m.ev === "media:update" || m.ev === "dm:message")) box.push({ ev: m.ev, data: m.data });
  });
  events[id(x)] = box;
  return box;
}

async function upload(x: L, file: string, kind: string, opts: { chunk?: number; name?: string } = {}) {
  const buf = fs.readFileSync(file);
  const start = await api(base, "/api/media/uploads", { kind, name: opts.name ?? file.split("/").pop(), size: buf.length, mime: "application/octet-stream" }, { token: tok(x) });
  if (start.status !== 200) return { start };
  const uploadId = start.data.uploadId;
  const chunk = opts.chunk ?? 64 * 1024;
  let off = 0;
  while (off < buf.length) {
    const part = buf.subarray(off, off + chunk);
    const r = await fetch(`${base}/api/media/uploads/${uploadId}?offset=${off}`, { method: "PUT", headers: { Authorization: `Bearer ${tok(x)}`, "Content-Type": "application/octet-stream" }, body: part });
    const j = (await r.json()) as any;
    if (r.status !== 200) return { start, chunkFail: { status: r.status, body: j } };
    off = j.received;
  }
  const done = await api(base, `/api/media/uploads/${uploadId}/complete`, {}, { token: tok(x) });
  return { start, uploadId, done };
}

async function sendMedia(x: L, to: L, mediaId: string, extra: Record<string, unknown> = {}) {
  return api(base, "/api/media/send", { to: id(to), mediaId, clientId: `c${uniq()}`, ...extra }, { token: tok(x) });
}
async function sign(x: L, mediaId: string, v: string[] = ["thumb", "full", "poster"]) {
  return (await api(base, "/api/media/sign", { items: [{ id: mediaId, v }] }, { token: tok(x) })).data.urls[mediaId];
}

before(async () => {
  f = await makeFixtures();
  await wipeDb();
  await startApp();
  A = await phoneLogin(wsUrl, phone(), { firstName: "Alice", username: `alice_${uniq()}` });
  B = await phoneLogin(wsUrl, phone(), { firstName: "Bob", username: `bob_${uniq()}` });
  C = await phoneLogin(wsUrl, phone(), { firstName: "Cara", username: `cara_${uniq()}` });
  listen(A);
  listen(B);
});
after(async () => {
  for (const x of [A, B, C]) x?.client.close();
  await media?.close();
  server?.closeAllConnections?.();
  await new Promise((r) => server?.close(() => r(null)));
  const { store } = await import("../../server/store");
  await store.flush();
});

test("photo: chunked upload, EXIF/GPS stripped, thumb + placeholder, signed URL with Range, send → dm:message", async () => {
  const sharp = (await import("sharp")).default;
  const before = await sharp(f("gps.jpg")).metadata();
  assert.ok(before.exif && before.exif.includes(Buffer.from("TestPhone")), "fixture has EXIF");
  const u = await upload(A, f("gps.jpg"), "photo", { chunk: 7_000 });
  assert.equal(u.done?.status, 200, JSON.stringify(u));
  const m = u.done!.data.media;
  assert.equal(m.kind, "photo");
  assert.equal(m.mime, "image/jpeg");
  assert.equal(m.w, 1600);
  assert.equal(m.h, 1200);
  assert.match(m.ph, /^data:image\/webp;base64,/);
  assert.ok(m.ph.length < 1500);
  // unsent: only the owner may sign
  assert.ok((await sign(B, m.id)).gone);
  const s = await sendMedia(A, B, m.id);
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.message.text, "📷 Photo");
  assert.equal(s.data.message.media.id, m.id);
  await sleep(100);
  assert.ok(events[id(B)].some((e) => e.ev === "dm:message" && e.data.media?.id === m.id));
  const urls = await sign(B, m.id);
  assert.ok(urls.full && urls.thumb);
  const full = await fetch(base + urls.full);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "image/jpeg");
  assertEdgeCache(full.headers.get("cache-control"));
  assert.equal(full.headers.get("set-cookie"), null, "media responses never set cookies (the edge would refuse to cache them)");
  const bytes = Buffer.from(await full.arrayBuffer());
  const after = await sharp(bytes).metadata();
  assert.equal(after.exif, undefined, "GPS / camera EXIF must be stripped");
  assert.equal(bytes.includes(Buffer.from("TestPhone")), false);
  const ranged = await fetch(base + urls.full, { headers: { Range: "bytes=0-99" } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  // tampered / other viewer's URL
  assert.equal((await fetch(base + urls.full.replace(/&t=[^&]+/, "&t=AAAA"))).status, 403);
  assert.equal((await fetch(base + urls.full.replace(`u=${id(B)}`, `u=${id(C)}`))).status, 403);
  // C isn't in the conversation
  assert.ok((await sign(C, m.id)).gone);
});

test("a photo reply keeps a trusted quote snapshot without a media URL", async () => {
  const original = await A.client.req("dm:send", { to: id(B), text: "Look at this when it arrives" });
  assert.equal(original.ok, true, JSON.stringify(original));
  const uploaded = await upload(B, f("gps.jpg"), "photo");
  assert.equal(uploaded.done?.status, 200, JSON.stringify(uploaded));
  const sent = await sendMedia(B, A, uploaded.done!.data.media.id, { replyToId: original.message.id });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.deepEqual(sent.data.message.replyTo, {
    messageId: original.message.id,
    senderId: id(A),
    senderName: "Alice",
    text: "Look at this when it arrives",
  });
  assert.equal("url" in sent.data.message.replyTo, false);
});

test("validation: caps, wrong kind rejected on the first chunk, resumable offsets, cancel, html served as download", async () => {
  const big = await api(base, "/api/media/uploads", { kind: "photo", name: "x.jpg", size: 26 * 1024 * 1024 }, { token: tok(A) });
  assert.equal(big.status, 413);
  const bigVid = await api(base, "/api/media/uploads", { kind: "video", name: "x.mp4", size: 201 * 1024 * 1024 }, { token: tok(A) });
  assert.equal(bigVid.status, 413);
  const okDoc = await api(base, "/api/media/uploads", { kind: "document", name: "x.zip", size: 99 * 1024 * 1024 }, { token: tok(A) });
  assert.equal(okDoc.status, 200);
  await api(base, `/api/media/uploads/${okDoc.data.uploadId}`, undefined, { token: tok(A), method: "DELETE" });
  const fake = await upload(A, f("notes.txt"), "photo", { name: "cat.jpg" });
  assert.equal(fake.chunkFail?.status, 415);
  // resumable: a wrong offset answers 409 with what the server has
  const buf = fs.readFileSync(f("doc.pdf"));
  const st = await api(base, "/api/media/uploads", { kind: "document", name: "doc.pdf", size: buf.length }, { token: tok(A) });
  const up = st.data.uploadId;
  const r1 = await fetch(`${base}/api/media/uploads/${up}?offset=0`, { method: "PUT", headers: { Authorization: `Bearer ${tok(A)}` }, body: buf.subarray(0, 50) });
  assert.equal(r1.status, 200);
  const r2 = await fetch(`${base}/api/media/uploads/${up}?offset=0`, { method: "PUT", headers: { Authorization: `Bearer ${tok(A)}` }, body: buf.subarray(0, 50) });
  assert.equal(r2.status, 409);
  assert.equal(((await r2.json()) as any).received, 50);
  const status = await api(base, `/api/media/uploads/${up}`, undefined, { token: tok(A) });
  assert.equal(status.data.received, 50);
  // B can't touch A's upload
  assert.equal((await api(base, `/api/media/uploads/${up}`, undefined, { token: tok(B) })).status, 404);
  await fetch(`${base}/api/media/uploads/${up}?offset=50`, { method: "PUT", headers: { Authorization: `Bearer ${tok(A)}` }, body: buf.subarray(50) });
  const done = await api(base, `/api/media/uploads/${up}/complete`, {}, { token: tok(A) });
  assert.equal(done.data.media.mime, "application/pdf");
  assert.equal(done.data.media.kind, "document");
  // HTML is stored as text and always downloaded, never rendered
  const h = await upload(A, f("evil.html"), "document");
  assert.equal(h.done!.data.media.mime, "text/plain");
  await sendMedia(A, B, h.done!.data.media.id);
  const hu = await sign(B, h.done!.data.media.id, ["full"]);
  const hr = await fetch(base + hu.full);
  assert.match(hr.headers.get("content-disposition") ?? "", /^attachment/);
  assert.match(hr.headers.get("content-security-policy") ?? "", /sandbox/);
  // PDF opens inline (in-app viewer), with filename
  await sendMedia(A, B, done.data.media.id);
  const pu = await sign(B, done.data.media.id, ["full"]);
  const pr = await fetch(base + pu.full);
  assert.equal(pr.headers.get("content-type"), "application/pdf");
  assert.match(pr.headers.get("content-disposition") ?? "", /^inline; filename="doc.pdf"/);
});

test("PNG with alpha keeps transparency (WebP); animated GIF → silent looping mp4", async () => {
  const p = await upload(A, f("alpha.png"), "photo");
  assert.equal(p.done!.data.media.mime, "image/webp");
  const g = await upload(A, f("anim.gif"), "photo");
  const gm = g.done!.data.media;
  assert.equal(gm.kind, "video");
  assert.equal(gm.gif, true);
  assert.equal(gm.status, "processing");
  await sendMedia(A, B, gm.id);
  const upd = await waitFor(() => events[id(B)].find((e) => e.ev === "media:update" && e.data.media.id === gm.id && e.data.media.status === "ready"), 20_000);
  assert.equal(upd.data.media.mime, "video/mp4");
});

test("video: H.264 remuxed with faststart and no location metadata; VP9 transcoded to H.264 in the background", async () => {
  const v = await upload(A, f("h264.mp4"), "video", { chunk: 20_000 });
  const m = v.done!.data.media;
  assert.equal(m.status, "ready");
  assert.equal(m.poster, true);
  assert.ok(m.durMs >= 1900 && m.durMs <= 2200, String(m.durMs));
  await sendMedia(A, B, m.id);
  const urls = await sign(B, m.id, ["full", "poster"]);
  const body = Buffer.from(await (await fetch(base + urls.full)).arrayBuffer());
  fs.writeFileSync(f("served.mp4"), body);
  const tags = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format_tags", "-of", "json", f("served.mp4")]).toString();
  assert.doesNotMatch(tags, /location|33\.44/);
  assert.ok(body.indexOf("moov") < body.indexOf("mdat"), "faststart: moov before mdat");
  assert.equal((await fetch(base + urls.poster)).headers.get("content-type"), "image/webp");

  const w = await upload(A, f("vp9.webm"), "video");
  const wm = w.done!.data.media;
  assert.equal(wm.status, "processing");
  await sendMedia(A, B, wm.id);
  // while processing, the original is what "full" resolves to
  assert.ok((await sign(B, wm.id, ["full"])).full.includes("/original"));
  // "ready" now arrives as soon as the 240p HLS rung is playable; the MP4 fallback follows
  const upd = await waitFor(() => events[id(B)].find((e) => e.ev === "media:update" && e.data.media.id === wm.id && e.data.media.status === "ready"), 30_000);
  assert.equal(upd.data.media.mime, "video/mp4");
  assert.deepEqual(upd.data.media.hls, [240]);
  await waitFor(async () => ((await sign(B, wm.id, ["full"])).full.includes("/full") ? true : null), 30_000);
  const fu = await sign(B, wm.id, ["full"]);
  assert.ok(fu.full.includes("/full"));
  fs.writeFileSync(f("vp9-out.mp4"), Buffer.from(await (await fetch(base + fu.full)).arrayBuffer()));
  assert.match(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", f("vp9-out.mp4")]).toString(), /h264/);
});

test("voice: webm/opus (Chrome/Firefox) and mp4/aac (Safari) → AAC m4a with a 64-bar waveform; played dot", async () => {
  for (const [file, ms] of [["voice.webm", 2000], ["voice-safari.mp4", 1500]] as const) {
    const v = await upload(A, f(file), "voice");
    const m = v.done!.data.media;
    assert.equal(m.mime, "audio/mp4", file);
    assert.ok(Math.abs(m.durMs - ms) < 150, `${file} ${m.durMs}`);
    assert.equal(Buffer.from(m.wave, "base64").length, 64);
    const s = await sendMedia(A, B, m.id);
    assert.equal(s.data.message.text, "🎤 Voice message");
    const u = await sign(B, m.id, ["full"]);
    const r = await fetch(base + u.full);
    assert.equal(r.headers.get("content-type"), "audio/mp4");
    // sender's play doesn't count; recipient's does (once)
    await api(base, `/api/media/${m.id}/played`, {}, { token: tok(A) });
    assert.equal(media.row(m.id).playedAt, null);
    await api(base, `/api/media/${m.id}/played`, {}, { token: tok(B) });
    assert.ok(media.row(m.id).playedAt > 0);
  }
});

test("blocks cut access immediately (sign + already-issued URLs)", async () => {
  const u = await upload(A, f("gps.jpg"), "photo");
  const m = u.done!.data.media;
  await sendMedia(A, B, m.id);
  const urls = await sign(B, m.id, ["full"]);
  assert.equal((await fetch(base + urls.full)).status, 200);
  await api(base, "/api/me/blocks", { userId: id(A), block: true }, { token: tok(B) });
  assert.equal((await fetch(base + urls.full)).status, 404);
  assert.ok((await sign(B, m.id)).gone);
  await api(base, "/api/me/blocks", { userId: id(A), block: false }, { token: tok(B) });
  assert.equal((await fetch(base + urls.full)).status, 200);
});

test("self-destruct: timer starts at send, sweeper deletes file + row on time with recipient offline, tombstone + event, no-store", async () => {
  const u = await upload(A, f("gps.jpg"), "photo");
  const m = u.done!.data.media;
  const s = await sendMedia(A, B, m.id, { ttlSeconds: 5, caption: "secret caption" });
  const msg = s.data.message;
  assert.equal(msg.text, "📷 Photo", "self-destructing media carries no caption");
  assert.ok(msg.media.expiresAt - msg.createdAt >= 4900 && msg.media.expiresAt - msg.createdAt <= 5100);
  const urls = await sign(B, m.id, ["full"]);
  const r = await fetch(base + urls.full);
  assert.equal(r.headers.get("cache-control"), "no-store");
  B.client.ws.pause(); // "offline" recipient
  const dir = (await import("../../server/media/config")).MEDIA_DIR + `/${m.id.slice(0, 2)}/${m.id}`;
  assert.ok(fs.existsSync(dir));
  await waitFor(() => !fs.existsSync(dir), 9000);
  assert.equal((await sql("SELECT id FROM media WHERE id = $1", [m.id])).length, 0);
  const tomb = await sql<{ reason: string; kind: string }>("SELECT reason, kind FROM media_tombstones WHERE message_id = $1", [msg.id]);
  assert.deepEqual(tomb[0], { reason: "expired", kind: "photo" });
  assert.equal((await fetch(base + urls.full)).status, 404);
  const ev = events[id(A)].find((e) => e.ev === "media:update" && e.data.messageId === msg.id);
  assert.equal(ev?.data.media.gone.reason, "expired");
  B.client.ws.resume();
  // reconnect reconciliation + history both show the tombstone (and never a URL)
  const rec = await api(base, "/api/media/reconcile", { messageIds: [msg.id] }, { token: tok(B) });
  assert.equal(rec.data.items[0].media.gone.reason, "expired");
  const hist = await B.client.req("dm:history", { peerId: id(A) });
  assert.equal(hist.messages.find((x: any) => x.id === msg.id).media.gone.reason, "expired");
  assert.ok((await sign(B, m.id)).gone);
});

test("view once: no thumbnail, one open, deleted when the recipient closes it; sender can't open it", async () => {
  const u = await upload(A, f("gps.jpg"), "photo");
  const m = u.done!.data.media;
  const s = await sendMedia(A, B, m.id, { viewOnce: true });
  assert.equal(s.data.message.media.viewOnce, true);
  const urls = await sign(B, m.id, ["thumb", "full"]);
  assert.deepEqual(urls, {});
  assert.equal((await api(base, `/api/media/${m.id}/open`, {}, { token: tok(A) })).status, 403);
  const o = await api(base, `/api/media/${m.id}/open`, {}, { token: tok(B) });
  assert.equal(o.status, 200);
  assert.equal((await fetch(base + o.data.urls.full)).status, 200);
  await api(base, `/api/media/${m.id}/viewed`, {}, { token: tok(B) });
  assert.equal((await fetch(base + o.data.urls.full)).status, 404);
  const tomb = await sql<{ reason: string }>("SELECT reason FROM media_tombstones WHERE message_id = $1", [s.data.message.id]);
  assert.equal(tomb[0].reason, "viewed");
});

test("Delete now: sender only, removes it for both sides", async () => {
  const u = await upload(A, f("doc.pdf"), "document");
  const m = u.done!.data.media;
  const s = await sendMedia(A, B, m.id, { caption: "the contract" });
  assert.equal(s.data.message.text, "the contract");
  assert.equal(s.data.message.media.label, false);
  assert.equal((await api(base, `/api/media/${m.id}/delete`, {}, { token: tok(B) })).status, 403);
  assert.equal((await api(base, `/api/media/${m.id}/delete`, {}, { token: tok(A) })).status, 200);
  const ev = await waitFor(() => events[id(B)].find((e) => e.ev === "media:update" && e.data.messageId === s.data.message.id));
  assert.equal(ev.data.media.gone.reason, "deleted");
  assert.equal(ev.data.text, "📄 doc.pdf", "the caption goes with the file");
  // retried send of a deleted attachment doesn't resurrect it
  assert.equal((await sendMedia(A, B, m.id)).status, 404);
});

test("send is idempotent per clientId / mediaId and respects blocks", async () => {
  const u = await upload(A, f("gps.jpg"), "photo");
  const m = u.done!.data.media;
  const one = await api(base, "/api/media/send", { to: id(B), mediaId: m.id, clientId: "same-1" }, { token: tok(A) });
  const two = await api(base, "/api/media/send", { to: id(B), mediaId: m.id, clientId: "same-1" }, { token: tok(A) });
  assert.equal(one.data.message.id, two.data.message.id);
  // B can't send A's media
  const u2 = await upload(A, f("gps.jpg"), "photo");
  assert.equal((await sendMedia(B, A, u2.done!.data.media.id)).status, 404);
  await api(base, "/api/me/blocks", { userId: id(A), block: true }, { token: tok(C) });
  const blocked = await sendMedia(A, C, u2.done!.data.media.id);
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /can't message/);
});

test("albums: 2–10 photos/videos in one message, ordered; per-item delete; whole-album timer; reconcile; validation", async () => {
  const ids = [];
  for (const [file, kind] of [["gps.jpg", "photo"], ["h264.mp4", "video"], ["alpha.png", "photo"]] as const) ids.push((await upload(A, f(file), kind)).done!.data.media.id);
  const s = await api(base, "/api/media/send", { to: id(B), mediaIds: ids, caption: "", clientId: `al${uniq()}` }, { token: tok(A) });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const msg = s.data.message;
  assert.deepEqual(msg.attachments.map((x: any) => x.id), ids, "order kept");
  assert.equal(msg.media.id, ids[0], "media mirrors the cover for older clients");
  assert.equal(msg.text, "🖼️ Album · 2 photos, 1 video");
  const got = await waitFor(() => events[id(B)].find((e) => e.ev === "dm:message" && e.data.id === msg.id));
  assert.equal(got.data.attachments.length, 3);
  assert.ok(got);
  // retried send (lost ack) → the same message
  const again = await api(base, "/api/media/send", { to: id(B), mediaIds: ids, clientId: `al${uniq()}` }, { token: tok(A) });
  assert.equal(again.data.message.id, msg.id);
  // the recipient can load every item
  for (const mid of ids) {
    const u = await sign(B, mid, ["thumb", "poster"]);
    assert.ok(u.thumb || u.poster, `item ${mid} loads`);
  }
  // delete one item: list shrinks, auto label recounts
  assert.equal((await api(base, `/api/media/${ids[1]}/delete`, {}, { token: tok(A) })).status, 200);
  const ev = await waitFor(() => events[id(B)].find((e) => e.ev === "media:update" && e.data.messageId === msg.id));
  assert.deepEqual(ev.data.attachments.map((x: any) => x.id), [ids[0], ids[2]]);
  assert.equal(ev.data.text, "🖼️ Album · 2 photos");
  // reconcile (offline client) returns the album state
  const rc = await api(base, "/api/media/reconcile", { messageIds: [msg.id] }, { token: tok(B) });
  assert.equal(rc.data.items[0].attachments.length, 2);
  // C (not in the chat) gets nothing
  assert.equal((await api(base, "/api/media/reconcile", { messageIds: [msg.id] }, { token: tok(C) })).data.items.length, 0);
  // delete the whole album
  assert.equal((await api(base, `/api/media/${ids[0]}/delete`, { all: true }, { token: tok(A) })).status, 200);
  const gone = await waitFor(() => events[id(B)].filter((e) => e.ev === "media:update" && e.data.messageId === msg.id).find((e) => e.data.media.gone));
  assert.equal(gone.data.attachments, undefined);
  assert.ok(!fs.existsSync(`${process.env.UPLOAD_DIR ?? process.env.DATA_DIR + "/uploads"}/m/${ids[2].slice(0, 2)}/${ids[2]}`));

  // timer applies to the whole album
  const t = [(await upload(A, f("gps.jpg"), "photo")).done!.data.media.id, (await upload(A, f("gps.jpg"), "photo")).done!.data.media.id];
  const ts = await api(base, "/api/media/send", { to: id(B), mediaIds: t, ttlSeconds: 5, caption: "nope", viewOnce: true, clientId: `al${uniq()}` }, { token: tok(A) });
  assert.equal(ts.data.message.text, "🖼️ Album · 2 photos", "no caption on self-destructing media");
  assert.ok(ts.data.message.attachments.every((x: any) => x.expiresAt && !x.viewOnce), "albums can't be view once; timer on every item");
  const exp = await waitFor(() => events[id(B)].filter((e) => e.ev === "media:update" && e.data.messageId === ts.data.message.id).find((e) => e.data.media.gone), 12000);
  assert.equal(exp.data.media.gone.reason, "expired");

  // validation
  const d = (await upload(A, f("doc.pdf"), "document")).done!.data.media.id;
  const p = (await upload(A, f("gps.jpg"), "photo")).done!.data.media.id;
  const bad = await api(base, "/api/media/send", { to: id(B), mediaIds: [p, d] }, { token: tok(A) });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /photos and videos/);
  const tooMany = await api(base, "/api/media/send", { to: id(B), mediaIds: Array.from({ length: 11 }, (_, i) => `${p.slice(0, -2)}${String(i).padStart(2, "0")}`) }, { token: tok(A) });
  assert.equal(tooMany.status, 400);
  assert.equal((await api(base, "/api/media/send", { to: id(B), mediaIds: [p, ids[0]] }, { token: tok(A) })).status, 404, "a deleted item can't be re-sent");
});

test("caption edits from the chat layer: text becomes the caption, empty falls back to the label", async () => {
  const u = await upload(A, f("gps.jpg"), "photo");
  const s = await sendMedia(A, B, u.done!.data.media.id);
  const mid = s.data.message.id;
  assert.equal(s.data.message.text, "📷 Photo");
  assert.equal(media.onMessageEdited(mid, "  at the lake  "), "at the lake");
  let ev = await waitFor(() => events[id(B)].filter((e) => e.ev === "media:update" && e.data.messageId === mid).at(-1));
  assert.equal(ev.data.media.label, false);
  assert.equal(ev.data.text, "at the lake");
  assert.equal(media.onMessageEdited(mid, ""), "📷 Photo");
  ev = await waitFor(() => events[id(B)].filter((e) => e.ev === "media:update" && e.data.messageId === mid && e.data.media.label === true).at(-1));
  assert.equal(ev.data.text, "📷 Photo");
  assert.equal(media.onMessageEdited("not-a-media-message", "hi"), "hi");
});

async function waitFor<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await sleep(100);
  }
}

test("adaptive video: 240p first then the full ladder; master/rendition playlists, fMP4 segments, cache headers, tokens", async () => {
  const v = await upload(A, f("hd.mp4"), "video", { chunk: 512 * 1024 });
  const m = v.done!.data.media;
  assert.equal(m.status, "ready"); // H.264 → faststart MP4 right away
  await sendMedia(A, B, m.id);
  const first = await waitFor(() => events[id(B)].find((e) => e.ev === "media:update" && e.data.media.id === m.id && e.data.media.hls?.length === 1), 60_000);
  assert.deepEqual(first.data.media.hls, [240]);
  const full = await waitFor(() => events[id(B)].find((e) => e.ev === "media:update" && e.data.media.id === m.id && e.data.media.hls?.length === 4), 120_000);
  assert.deepEqual(full.data.media.hls, [240, 360, 480, 720]);

  const urls = await sign(B, m.id, ["hls", "hlsLow", "full", "poster"]);
  assert.match(urls.hls, /^\/media\/[0-9a-f]+\/v\d+\/hls\/master\.m3u8\?exp=\d+&p=%2Fmedia%2F[0-9a-f]+%2Fv\d+%2F&u=[^&]+&t=[\w-]+$/);
  // master: CODECS/RESOLUTION/BANDWIDTH, 360p first (native start), every URI carries the token query; final → immutable
  const mr = await fetch(base + urls.hls, { headers: { "accept-encoding": "identity" } });
  assert.equal(mr.status, 200);
  assert.equal(mr.headers.get("content-type"), "application/vnd.apple.mpegurl");
  assertEdgeCache(mr.headers.get("cache-control"));
  assert.equal(mr.headers.get("access-control-allow-origin"), "*");
  const master = await mr.text();
  assert.match(master, /#EXT-X-STREAM-INF:BANDWIDTH=\d+,AVERAGE-BANDWIDTH=\d+,RESOLUTION=640x360,CODECS="avc1\.4d401f,mp4a\.40\.2"/);
  assert.match(master, /RESOLUTION=1280x720,CODECS="avc1\.64001f,mp4a\.40\.2"/);
  const q = urls.hls.split("?")[1];
  const uris = master.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.equal(uris[0], `r360/index.m3u8?${q}`);
  assert.equal(uris.length, 4);
  const low = await (await fetch(base + urls.hlsLow)).text();
  assert.ok(low.split("\n").find((l) => l && !l.startsWith("#"))!.startsWith("r240/"));
  // rendition playlist: short first segment, ~4 s after, init + segments with the token
  const prefix = urls.hls.split("?")[0].replace(/master\.m3u8$/, "");
  const pl = await fetch(`${base}${prefix}r240/index.m3u8?${q}`);
  assertEdgeCache(pl.headers.get("cache-control"));
  const plText = await pl.text();
  assert.match(plText, new RegExp(`#EXT-X-MAP:URI="init\\.mp4\\?${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  const durs = [...plText.matchAll(/#EXTINF:([\d.]+)/g)].map((x) => Number(x[1]));
  // 1 s first segment, then segments ending on 4 s boundaries (1→4, 4→8, …)
  assert.ok(durs[0] <= 1.1 && Math.abs(durs[1] - 3) < 0.15 && (durs.length < 4 || Math.abs(durs[2] - 4) < 0.15), durs.join(","));
  const seg = await fetch(`${base}${prefix}r240/seg_00001.m4s?${q}`, { headers: { range: "bytes=0-99" } });
  assert.equal(seg.status, 206);
  assert.equal(seg.headers.get("content-type"), "video/iso.segment");
  assertEdgeCache(seg.headers.get("cache-control"));
  assert.match(seg.headers.get("content-range") ?? "", /^bytes 0-99\/\d+$/);
  const init = await fetch(`${base}${prefix}r720/init.mp4?${q}`);
  assert.equal(init.headers.get("content-type"), "video/mp4");
  // gzip for playlists only
  const gz = await fetch(base + urls.hls, { headers: { "accept-encoding": "gzip" } });
  assert.equal(gz.headers.get("vary"), "Accept-Encoding");
  // one token covers the directory, but not another media, not a tampered uid, not after expiry
  assertEdgeCache((await fetch(base + urls.poster)).headers.get("cache-control"));
  assert.equal((await fetch(`${base}${prefix}r240/index.m3u8?${q.replace(/&u=[^&]+/, `&u=${id(C)}`)}`)).status, 403);
  assert.equal((await fetch(`${base}${prefix}r240/index.m3u8?${q.replace(/&t=[\w-]+/, "&t=AAAA")}`)).status, 403);
  assert.equal((await fetch(`${base}${prefix}../../x?${q}`)).status, 404);
  assert.equal((await fetch(`${base}${prefix}r240/index.m3u8`)).status, 403);
  // a signed link for a non-member (valid token, no access) → 404 at the origin
  const { signedUrl } = await import("../../server/media/origin");
  const rev = Number(/\/v(\d+)\//.exec(prefix)![1]);
  const cUrl = signedUrl(m.id, rev, "hls/master.m3u8", id(C), Math.floor(Date.now() / 1000) + 60, { origin: true });
  assert.equal((await fetch(base + cUrl)).status, 404);
  const expired = signedUrl(m.id, rev, "hls/master.m3u8", id(B), Math.floor(Date.now() / 1000) - 5, { origin: true });
  assert.equal((await fetch(base + expired)).status, 403);
  // CORS preflight + health
  const pre = await fetch(base + urls.hls, { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Range/);
  const hz = (await (await fetch(`${base}/media/healthz`)).json()) as any;
  assert.equal(hz.ok, true);

  // internal origin (cache service side): same token rules, raw playlists (no rewrite, no gzip)
  const { handleMediaOrigin } = await import("../../server/media/origin");
  const internal = http.createServer((req, res) => void handleMediaOrigin(req, res, { internal: true }));
  await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
  const ib = `http://127.0.0.1:${(internal.address() as AddressInfo).port}`;
  const raw = await (await fetch(ib + urls.hls, { headers: { "accept-encoding": "gzip" } })).text();
  assert.ok(raw.includes("\nr360/index.m3u8\n"), raw);
  assert.equal((await fetch(ib + urls.hls.split("?")[0])).status, 403);
  internal.close();

  // purge hook: deleting the media tells the cache to drop /media/<id>/
  const got: any[] = [];
  const purge = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => (got.push({ auth: req.headers.authorization, body: JSON.parse(b) }), res.writeHead(204).end()));
  });
  await new Promise<void>((r) => purge.listen(0, "127.0.0.1", r));
  process.env.MEDIA_CACHE_PURGE_URL = `http://127.0.0.1:${(purge.address() as AddressInfo).port}/_purge`;
  process.env.MEDIA_CACHE_PURGE_SECRET = "purge-test";
  const del = await api(base, `/api/media/${m.id}/delete`, { all: true }, { token: tok(A) });
  assert.equal(del.status, 200);
  await waitFor(() => got.length > 0, 5000);
  assert.deepEqual(got[0], { auth: "Bearer purge-test", body: { prefixes: [`/media/${m.id}/`] } });
  delete process.env.MEDIA_CACHE_PURGE_URL;
  purge.close();
  assert.equal((await fetch(base + urls.hls)).status, 404);
});

test("photos get srcset thumbnails (320 WebP, 640/320 AVIF) on the same signed directory", async () => {
  const p = await upload(A, f("gps.jpg"), "photo");
  const m = p.done!.data.media;
  assert.equal(m.srcset, true);
  await sendMedia(A, B, m.id);
  const u = await sign(B, m.id, ["thumb", "thumbS", "thumbAvif", "thumbSAvif"]);
  for (const [k, type] of [["thumbS", "image/webp"], ["thumbAvif", "image/avif"], ["thumbSAvif", "image/avif"]] as const) {
    const r = await fetch(base + u[k]);
    assert.equal(r.status, 200, k);
    assert.equal(r.headers.get("content-type"), type);
  }
});

test("forward (Telegram-style): received photo + text to several chats; new copies; self-destruct and strangers refused", async () => {
  const { store } = await import("../../server/store");
  const u = await upload(A, f("gps.jpg"), "photo");
  const m = u.done!.data.media;
  const s = await sendMedia(A, B, m.id, { caption: "look" });
  assert.equal(s.status, 200);
  // B forwards what A sent to C and back to A, in one request
  const fw = await api(base, "/api/media/forward", { chatId: id(A), messageId: s.data.message.id, to: [id(C), id(A)] }, { token: tok(B) });
  assert.equal(fw.status, 200, JSON.stringify(fw.data));
  assert.equal(fw.data.results.length, 2);
  assert.ok(fw.data.results.every((r: any) => r.ok), JSON.stringify(fw.data.results));
  const toC = store.findDm([id(B), id(C)].sort().join("|"), fw.data.results[0].messageId)!;
  assert.equal(toC.text, "look", "caption travels");
  assert.notEqual(toC.media!.id, m.id, "a fresh attachment row");
  assert.ok((await sign(C, toC.media!.id)).thumb, "recipient can open the forwarded copy");
  // deleting the original leaves the forwarded copy intact
  assert.equal((await api(base, `/api/media/${m.id}/delete`, {}, { token: tok(A) })).status, 200);
  assert.ok((await sign(C, toC.media!.id)).thumb);
  // plain text
  const t = store.sendDm(id(A), id(B), `hello ${uniq()}`);
  assert.ok(t.ok);
  const ft = await api(base, "/api/media/forward", { chatId: id(A), messageId: (t as any).message.id, to: [id(C)] }, { token: tok(B) });
  assert.equal(ft.status, 200, JSON.stringify(ft.data));
  assert.equal(store.findDm([id(B), id(C)].sort().join("|"), ft.data.results[0].messageId)!.text, (t as any).message.text);
  // C can't forward a message from a chat it isn't in
  assert.equal((await api(base, "/api/media/forward", { chatId: id(A), messageId: (t as any).message.id, to: [id(B)] }, { token: tok(C) })).status, 400);
  // timer media is never forwardable
  const u2 = await upload(A, f("gps.jpg"), "photo");
  const s2 = await sendMedia(A, B, u2.done!.data.media.id, { ttlSeconds: 3600 });
  const f2 = await api(base, "/api/media/forward", { chatId: id(A), messageId: s2.data.message.id, to: [id(C)] }, { token: tok(B) });
  assert.equal(f2.status, 400);
  assert.match(f2.data.results[0].error, /Self-destructing/);
  // limits
  assert.equal((await api(base, "/api/media/forward", { chatId: id(A), messageId: s2.data.message.id, to: [] }, { token: tok(B) })).status, 400);
});
