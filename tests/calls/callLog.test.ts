// OL call log (server/calls/callLog.ts, t5375): reason tags, sanitizing, token auth, durable store across restart,
// Railway server events, Pion merge, per-call summary + device matrix, HTTP ingest/review.
// Postgres path: set CALL_LOG_TEST_PG=postgresql://... (PGlite socket in CI-less runs); otherwise skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  failureTag, FAILURE_TAGS, sanitizeClientEvent, verifyOlcallTokenForLog, CallLogStore, recordServerEvent, pionTimeline, summarizeCall,
  matrixRollup, handleCallLogIngest, handleCallLogReview, reviewKeyOk, pionReadSig, TOKEN_GRACE_S, type CallLogEvent,
} from "../../server/calls/callLog";
import { signOlcallToken } from "../../server/calls/olcallToken";

const secret = "olcall-public-test-vector-secret-0123456789";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "calllog-"));

test("every Android/iOS diagnose() reason maps to one of the six tags", () => {
  const cases: [string, string][] = [
    ["offer-never-sent:ws-failure", "offer_never_sent"], ["offer-never-arrived:tg-failed", "offer_never_sent"],
    ["answer-never-arrived:ws-closed:1006", "answer_timeout"], ["answer-never-sent:tg-failed", "answer_timeout"],
    ["ice-stalled:tg-failed", "ice_failure"], ["ice-stalled:ws-failure", "connection_stalled"],
    ["join-never-acked:ws-failure", "connection_stalled"], ["after-connect:ws-closed:1001", "connection_stalled"],
    ["audio-session-activation-failed", "audio_session_handoff_failure"], ["adm:open-report:ok=0", "audio_session_handoff_failure"],
    ["turn-alloc-failed:401", "turn_relay_failure"], ["no_turn", "turn_relay_failure"], ["ice-Failed", "ice_failure"],
    ["join-timeout", "answer_timeout"], ["ws-closed-before-media", "connection_stalled"], ["something new", "connection_stalled"],
    ["permission-denied", "permission_denied"], ["olcall-unavailable", "engine_unavailable"], ["join-never-acked:server-error:unauthorized", "join_rejected"],
  ];
  for (const [raw, tag] of cases) assert.equal(failureTag(raw), tag, raw);
  for (const t of FAILURE_TAGS) assert.equal(failureTag(t), t);
  assert.equal(failureTag("ice-stalled:tg-failed", { turnServers: 0 }), "turn_relay_failure");
  assert.equal(failureTag("ice-stalled:tg-failed", { relayOnly: true }), "turn_relay_failure");
});

test("client events: failed always carries a tag + raw detail; secrets, blobs and junk are dropped", () => {
  const e = sanitizeClientEvent({ callId: "c1", source: "android", kind: "state", from: "offering", to: "failed", reason: "offer-never-sent:ws-failure", t: 812, ts: 1, media: "video", role: "caller",
    device: "Google Pixel 8", os: "Android 15 (API 35)", appVersion: "0.3.37 (54)",
    extra: { token: "abc", turnPassword: "x", turnServers: 4, blobB64: "QUJD", note: "A".repeat(200), ok: true } }, { userId: "u1" }, 5)!;
  assert.equal(e.reason, "offer_never_sent");
  assert.equal(e.detail, "offer-never-sent:ws-failure");
  assert.equal(e.media, "video"); assert.equal(e.role, "caller"); assert.equal(e.userId, "u1"); assert.equal(e.tsServer, 5);
  assert.deepEqual(e.extra, { turnServers: 4, ok: true });
  assert.equal(sanitizeClientEvent({ callId: "c1", source: "android", kind: "state", to: "bogus" }, { userId: "u" }), null);
  assert.equal(sanitizeClientEvent({ callId: "c1", source: "desktop" }, { userId: "u" }), null);
  assert.equal(sanitizeClientEvent({ callId: "bad id!", source: "ios" }, { userId: "u" }), null);
  // token-scoped: only that call
  assert.equal(sanitizeClientEvent({ callId: "other", source: "ios", kind: "event", event: "x" }, { userId: "u", callId: "c1" }), null);
  assert.equal(sanitizeClientEvent({ source: "ios", kind: "event", event: "x" }, { userId: "u", callId: "c1" })!.callId, "c1");
});

test("olcall token auth: valid signature within 7-day grace only", () => {
  const now = Date.now();
  const tok = signOlcallToken(secret, { callId: "c9", userId: "u9", role: "callee", exp: Math.floor(now / 1000) + 300 });
  const s = Buffer.from(secret);
  assert.equal(verifyOlcallTokenForLog(tok, s, now)?.callId, "c9");
  assert.equal(verifyOlcallTokenForLog(tok, s, now + (TOKEN_GRACE_S + 400) * 1000), null);
  assert.equal(verifyOlcallTokenForLog(tok, Buffer.from(secret + "x"), now), null);
  assert.equal(verifyOlcallTokenForLog(tok.slice(0, -2) + "AA", s, now), null);
  assert.equal(verifyOlcallTokenForLog("garbage", s, now), null);
  assert.equal(verifyOlcallTokenForLog(tok, null, now), null);
});

const ev = (o: Partial<CallLogEvent>): CallLogEvent => ({ eventId: Math.random().toString(36).slice(2), callId: "c1", userId: "u1", role: "caller", source: "android", platform: "android", device: "Pixel 8", os: "Android 15", appVersion: "0.3.37 (54)", engine: "e", media: "audio", kind: "state", event: null, fromState: "idle", toState: "joining", reason: "join-sent", detail: null, tsClient: 1, tCallMs: 0, tsServer: Date.now(), extra: {}, ...o });

test("JSONL store (no DATABASE_URL) survives a restart: new instance, same dir, same events; dedupe by eventId on read", async () => {
  const dir = tmp();
  const a = new CallLogStore({ databaseUrl: null, dir });
  assert.equal(await a.add([ev({ eventId: "e1" }), ev({ eventId: "e2", fromState: "joining", toState: "offering" })]), "jsonl");
  await a.close();
  const b = new CallLogStore({ databaseUrl: null, dir }); // "restart"
  const got = await b.query({ callId: "c1" });
  assert.deepEqual(got.map((e) => e.eventId), ["e1", "e2"]);
  assert.equal((await b.query({ userId: "u1" })).length, 2);
  assert.equal((await b.query({ callId: "nope" })).length, 0);
});

test("retention: spool files older than 90 days are removed", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "call-events-2020-01-01.jsonl"), "{}\n");
  const s = new CallLogStore({ databaseUrl: null, dir });
  await s.add([ev({})]);
  await s.maybePrune(true);
  assert.equal(fs.existsSync(path.join(dir, "call-events-2020-01-01.jsonl")), false);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test("Railway CallService log lines become server events (only lines naming a call)", async () => {
  const dir = tmp();
  const s = new CallLogStore({ databaseUrl: null, dir });
  assert.ok(recordServerEvent("call start", { callId: "c1", video: true, callerId: "u1", calleeId: "u2", callerPlatform: "android" }, s));
  assert.ok(recordServerEvent("call accept", { callId: "c1", ringMs: 900, userId: "u2", calleePlatform: "ios" }, s));
  assert.ok(recordServerEvent("call end", { callId: "c1", outcome: "completed", durationSec: 12, by: "caller" }, s));
  assert.equal(recordServerEvent("call start", { video: true }, s), null);
  assert.equal(recordServerEvent("unrelated line", { callId: "c1" }, s), null);
  await new Promise((r) => setTimeout(r, 30));
  const got = await s.query({ callId: "c1" });
  assert.deepEqual(got.map((e) => e.event), ["call_start", "call_accept", "call_end"]);
  assert.equal(got[0].media, "video");
});

test("Pion crumbs -> per-leg states + relay/direct path; summary gives the device-matrix combo and failure tags", () => {
  const crumbs = [
    { ts: "t1", leg: "caller", category: "ws", message: "join:tgcalls" },
    { ts: "t1", leg: "caller", category: "ws", message: "meta:platform=android:device=Pixel 8:os=Android 15" },
    { ts: "t2", leg: "callee", category: "ws", message: "join:tgcalls" },
    { ts: "t3", leg: "caller", category: "ice", message: "connected" },
    { ts: "t3", leg: "caller", category: "ice", message: "selected:remote=relay:local=host:proto=udp4" },
    { ts: "t9", leg: "callee", category: "leg", message: "closed:ice-connect: timeout" },
  ];
  const legs = pionTimeline(crumbs);
  assert.equal(legs.caller.path, "relay");
  assert.deepEqual(legs.caller.states.map((x) => x.to), ["joining", "connected"]);
  assert.deepEqual(legs.callee.states.map((x) => x.to), ["joining", "failed"]);
  assert.equal(legs.callee.states[1].reason, "ice_failure");
  const evs = [
    ev({ source: "railway", role: null, userId: null, kind: "event", event: "call_start", media: "video", extra: { callerId: "u1", calleeId: "u2", callerPlatform: "android" } }),
    ev({ userId: "u1", role: "caller", toState: "connected", fromState: "offering", reason: "tg-established" }),
    ev({ userId: "u2", role: "callee", source: "ios", platform: "ios", device: "iPhone15,2", fromState: "answering", toState: "failed", reason: "ice_failure", detail: "ice-stalled:tg-failed" }),
    ev({ source: "railway", role: null, userId: null, kind: "event", event: "call_end", extra: { outcome: "completed", durationSec: 3 } }),
  ];
  const s = summarizeCall("c1", evs, legs);
  assert.equal(s.matrix, "android/Pixel 8 -> ios/iPhone15,2 video relay");
  assert.equal(s.connected, true);
  assert.deepEqual(s.failureTags, ["ice_failure"]);
  assert.equal(s.callee.failure?.detail, "ice-stalled:tg-failed");
  assert.equal(s.outcome, "completed");
  const m = matrixRollup([s, s]);
  assert.equal(m[0].calls, 2); assert.equal(m[0].tags.ice_failure, 2);
});

test("Pion read signature is HMAC over callId + exp", () => {
  const a = pionReadSig(Buffer.from(secret), "c1", 100), b = pionReadSig(Buffer.from(secret), "c1", 101);
  assert.notEqual(a, b); assert.match(a, /^[A-Za-z0-9_-]{43}$/);
});

// ---- HTTP handlers with fake req/res
function fakeReq(method: string, url: string, headers: Record<string, string> = {}) { const r = new EventEmitter() as never as import("node:http").IncomingMessage; Object.assign(r, { method, url, headers }); return r; }
function fakeRes() { const o: { status?: number; body?: unknown } = {}; return { o, res: {} as import("node:http").ServerResponse, json: (_r: unknown, status: number, body: unknown) => { o.status = status; o.body = body; } }; }

test("ingest: session bearer or olcall token; 401 otherwise; token scoped to its call", async () => {
  process.env.OLCALL_TOKEN_SECRET = secret;
  const dir = tmp(); const s = new CallLogStore({ databaseUrl: null, dir });
  const auth = async (b: string) => (b === "good" ? { ok: true as const, userId: "u1" } : { ok: false as const });
  const evs = [{ callId: "c1", source: "android", kind: "state", from: "idle", to: "joining", reason: "join-sent" }, { callId: "c2", source: "android", kind: "state", from: "joining", to: "failed", reason: "join-never-acked:ws-failure" }];
  let f = fakeRes();
  await handleCallLogIngest(fakeReq("POST", "/api/call-log", { authorization: "Bearer good" }), f.res, f.json, async () => ({ events: evs }), auth, s);
  assert.equal(f.o.status, 200); assert.deepEqual(f.o.body, { ok: true, stored: 2, dropped: 0, where: "jsonl" });
  const tok = signOlcallToken(secret, { callId: "c1", userId: "u7", role: "callee", exp: Math.floor(Date.now() / 1000) - 3600 });
  f = fakeRes();
  await handleCallLogIngest(fakeReq("POST", "/api/call-log"), f.res, f.json, async () => ({ events: evs, olcallToken: tok }), auth, s);
  assert.deepEqual(f.o.body, { ok: true, stored: 1, dropped: 1, where: "jsonl" });
  f = fakeRes();
  await handleCallLogIngest(fakeReq("POST", "/api/call-log", { authorization: "Bearer bad" }), f.res, f.json, async () => ({ events: evs }), auth, s);
  assert.equal(f.o.status, 401);
  const failed = (await s.query({ callId: "c2" }))[0];
  assert.equal(failed.reason, "connection_stalled"); assert.equal(failed.detail, "join-never-acked:ws-failure");
  assert.equal((await s.query({ callId: "c1" })).find((e) => e.userId === "u7")?.role, null);
});

test("review: admin or review key only; call timeline + summary; matrix rollup", async () => {
  const dir = tmp(); const s = new CallLogStore({ databaseUrl: null, dir });
  await s.add([ev({ eventId: "a1" }), ev({ eventId: "a2", fromState: "joining", toState: "offering", reason: "joined" })]);
  const noPion = async () => ({ ok: false, crumbs: [], error: "not_configured" });
  let f = fakeRes();
  await handleCallLogReview(fakeReq("GET", "/api/admin/call-log?call=c1"), f.res, f.json, false, s, noPion);
  assert.equal(f.o.status, 403);
  process.env.CALL_LOG_REVIEW_KEY = "k".repeat(40);
  assert.equal(reviewKeyOk("k".repeat(40)), true); assert.equal(reviewKeyOk("k".repeat(39)), false);
  f = fakeRes();
  await handleCallLogReview(fakeReq("GET", "/api/admin/call-log?call=c1", { "x-call-log-key": "k".repeat(40) }), f.res, f.json, false, s, noPion);
  assert.equal(f.o.status, 200);
  const b = f.o.body as { timeline: CallLogEvent[]; summary: ReturnType<typeof summarizeCall> };
  assert.equal(b.timeline.length, 2); assert.equal(b.summary.caller.reached, "offering");
  f = fakeRes();
  await handleCallLogReview(fakeReq("GET", "/api/admin/call-log?matrix=1"), f.res, f.json, true, s, noPion);
  assert.equal((f.o.body as { matrix: unknown[] }).matrix.length, 1);
  delete process.env.CALL_LOG_REVIEW_KEY;
});

const PG = process.env.CALL_LOG_TEST_PG;
test("Postgres store: table created lazily, insert idempotent, survives a restart (new pool), spool drained", { skip: !PG && "set CALL_LOG_TEST_PG" }, async () => {
  const dir = tmp();
  const id = `pg-${Date.now()}`;
  const a = new CallLogStore({ databaseUrl: PG!, dir });
  assert.equal(await a.add([ev({ eventId: `${id}-1`, callId: id }), ev({ eventId: `${id}-1`, callId: id })]), "postgres");
  await a.close();
  // an event that went to the spool while Postgres was "down"
  fs.writeFileSync(path.join(dir, `call-events-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify(ev({ eventId: `${id}-2`, callId: id, toState: "offering", fromState: "joining" })) + "\n");
  const b = new CallLogStore({ databaseUrl: PG!, dir }); // restart
  await b.add([ev({ eventId: `${id}-3`, callId: id, toState: "connected", fromState: "offering" })]);
  await b.drainSpool();
  const got = await b.query({ callId: id });
  assert.deepEqual(got.map((e) => e.eventId).sort(), [`${id}-1`, `${id}-2`, `${id}-3`]);
  assert.ok(fs.readdirSync(dir).every((f) => f.endsWith(".drained")));
  await b.close();
});
