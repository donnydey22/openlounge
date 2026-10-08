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
  assert.match(full.headers.get("cache-control") ?? "", /private/);
  const bytes = Buffer.from(await full.arrayBuffer());
  const after = await sharp(bytes).metadata();
  assert.equal(after.exif, undefined, "GPS / camera EXIF must be stripped");
  assert.equal(bytes.includes(Buffer.from("TestPhone")), false);
  const ranged = await fetch(base + urls.full, { headers: { Range: "bytes=0-99" } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  // tampered / other viewer's URL
  assert.equal((await fetch(base + urls.full.replace(/s=[^&]+/, "s=AAAA"))).status, 403);
  assert.equal((await fetch(base + urls.full.replace(`u=${id(B)}`, `u=${id(C)}`))).status, 403);
  // C isn't in the conversation
  assert.ok((await sign(C, m.id)).gone);
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
  const upd = await waitFor(() => events[id(B)].find((e) => e.ev === "media:update" && e.data.media.id === wm.id && e.data.media.status === "ready"), 30_000);
  assert.equal(upd.data.media.mime, "video/mp4");
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
