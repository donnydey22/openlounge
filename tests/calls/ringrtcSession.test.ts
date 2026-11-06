import { test } from "node:test";
import assert from "node:assert/strict";
import { OlKeyStore, memoryKv, SealedSignaling } from "../../src/lib/calls/ringrtc";
import { OlSession } from "../../src/lib/calls/ringrtc/olx3dh";
import { RcRelay } from "../../server/calls/rcRelay";

async function pair() {
  const a = new OlKeyStore(memoryKv()), b = new OlKeyStore(memoryKv());
  const pub = await b.publishable();
  return { a, b, bundle: { userId: "b", deviceId: pub.deviceId, ikDh: pub.ikDh, ikSig: pub.ikSig, spkId: pub.spkId, spk: pub.spk, spkSig: pub.spkSig, opkId: pub.opks[0].id, opk: pub.opks[0].pub } };
}

test("X3DH both directions, out-of-order, replay rejected, OPK one-time", async () => {
  const { a, b, bundle } = await pair();
  const sa = await OlSession.initiate(await a.identity(), bundle);
  const e0 = await sa.seal(new TextEncoder().encode("offer")), e1 = await sa.seal(new TextEncoder().encode("ice"));
  const sb = await OlSession.respond(await b.identity(), await b.spkPriv(e0.pre!.spkId), await b.takeOpk(e0.pre!.opkId), e0.pre!);
  assert.equal(new TextDecoder().decode(await sb.open(e1)), "ice");
  assert.equal(new TextDecoder().decode(await sb.open(e0)), "offer");
  await assert.rejects(sb.open(e0));
  const r = await sb.seal(new TextEncoder().encode("answer"));
  assert.equal(new TextDecoder().decode(await sa.open(r)), "answer");
  await assert.rejects(b.takeOpk(e0.pre!.opkId));
});

test("tampered signed prekey rejected", async () => {
  const { a, bundle } = await pair();
  await assert.rejects(OlSession.initiate(await a.identity(), { ...bundle, spk: bundle.opk! }));
});

test("SealedSignaling end-to-end through RcRelay: server sees only ciphertext", async () => {
  const ka = new OlKeyStore(memoryKv()), kb = new OlKeyStore(memoryKv());
  const handlers: Record<string, Record<string, ((d: unknown) => void)[]>> = { a: {}, b: {} };
  const seen: unknown[] = [];
  const relay = new RcRelay({ call: () => ({ callerId: "a", calleeId: "b", phase: "active" }), emitUser: (u, ev, d) => { seen.push(d); (handlers[u][ev] ?? []).forEach((f) => f(d)); } });
  const sock = (uid: string) => ({
    on: (ev: string, f: (d: unknown) => void) => void (handlers[uid][ev] ??= []).push(f),
    off: () => {},
    request: async (ev: string, d?: any): Promise<any> => ev === "rc:msg" ? relay.msg(uid, d) : ev === "rc:keys:fetch" ? relay.fetchFor(uid, d) : relay.keys.publish(uid, d),
  });
  const kb2 = new OlKeyStore(memoryKv()); // callee's second device (fan-out; must not see answer-locked traffic)
  await sock("b").request("rc:keys:publish", await kb.publishable());
  await sock("b").request("rc:keys:publish", await kb2.publishable());
  const A = new SealedSignaling(sock("a"), ka, { callId: "c1", role: "caller", peerUserId: "b" });
  const B = new SealedSignaling(sock("b"), kb, { callId: "c1", role: "callee", peerUserId: "a" });
  const gotB: any[] = [], gotA: any[] = [];
  const B2 = new SealedSignaling(sock("b"), kb2, { callId: "c1", role: "callee", peerUserId: "a" });
  const gotB2: any[] = []; B2.on("rtc:signal", (d) => gotB2.push(d));
  B.on("rtc:signal", (d) => gotB.push(d)); A.on("rtc:signal", (d) => gotA.push(d));
  assert.deepEqual(await B.request("rtc:signal", { kind: "ready" }), { ok: true }); // held pre-session
  await A.request("rtc:signal", { callId: "c1", kind: "offer", sdp: "v=0 secret" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gotB[0].sdp, "v=0 secret");
  assert.equal(gotA[0].kind, "ready");
  assert.equal(gotB2[0].sdp, "v=0 secret"); // pre-lock fan-out reached both devices
  await A.request("rtc:signal", { callId: "c1", kind: "candidate" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(gotB.length, 2); assert.equal(gotB2.length, 1); // locked to the device that answered
  assert.ok(!JSON.stringify(seen).includes("secret"));
  assert.equal((await relay.fetchFor("a", { userId: "zzz", callId: "c1" })).ok, false);
});

test("olx3dh.ts matches node:crypto vectors (cross-platform contract)", async () => {
  const fs = await import("node:fs");
  const v = JSON.parse(fs.readFileSync(new URL("./olx3dh-vectors.json", import.meta.url), "utf8"));
  const { b64 } = await import("../../src/lib/calls/ringrtc/olx3dh");
  const hx = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
  const jwk = (p: string, x: string) => crypto.subtle.importKey("jwk", { kty: "OKP", crv: "X25519", d: Buffer.from(p, "hex").toString("base64url"), x: Buffer.from(x, "hex").toString("base64url") }, { name: "X25519" }, true, ["deriveBits"]);
  const me = { dh: { pub: hx(v.pubHex.ikb), priv: await jwk(v.privHex.ikb, v.pubHex.ikb) }, sig: { pub: new Uint8Array(32), priv: null as any } };
  const s = await OlSession.respond(me, await jwk(v.privHex.spkb, v.pubHex.spkb), await jwk(v.privHex.opkb, v.pubHex.opkb), { ikDh: b64(hx(v.pubHex.ika)), ikSig: "", ek: b64(hx(v.pubHex.eka)), spkId: 1, opkId: 1 });
  assert.equal(new TextDecoder().decode(await s.open({ v: 1, n: 0, ct: v.msg0.ctB64u })), v.msg0.plaintext);
});


test("concurrent trickle ICE sealing/opening advances each ratchet exactly once", async () => {
  const { a, b, bundle } = await pair();
  const sa = await OlSession.initiate(await a.identity(), bundle);
  const envs = await Promise.all(Array.from({ length: 24 }, (_, i) => sa.seal(new TextEncoder().encode(`ice-${i}`))));
  const pre = envs[0].pre!;
  const sb = await OlSession.respond(await b.identity(), await b.spkPriv(pre.spkId), await b.takeOpk(pre.opkId), pre);
  const plain = await Promise.all(envs.map(e => sb.open(e)));
  assert.deepEqual(plain.map(x => new TextDecoder().decode(x)), Array.from({length:24}, (_,i)=>`ice-${i}`));
});

test("tampered ciphertext cannot consume receive ratchet or skipped keys", async () => {
  const { a, b, bundle } = await pair();
  const sa = await OlSession.initiate(await a.identity(), bundle);
  const env = await sa.seal(new TextEncoder().encode("offer"));
  const pre = env.pre!;
  const sb = await OlSession.respond(await b.identity(), await b.spkPriv(pre.spkId), await b.takeOpk(pre.opkId), pre);
  await assert.rejects(sb.open({...env, ct: (env.ct[0] === "A" ? "B" : "A") + env.ct.slice(1)}));
  assert.equal(new TextDecoder().decode(await sb.open(env)), "offer");
});


test("durable DO public-key directory survives restart and concurrent fetches consume distinct OPKs", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { filePreKeyStore } = await import("../../server/calls/preKeyFileStore");
  const { PreKeyDirectory } = await import("../../server/calls/rcRelay");
  const dir = await mkdtemp(join(tmpdir(), "ol-prekeys-"));
  try {
    const k = new OlKeyStore(memoryKv());
    const first = new PreKeyDirectory(filePreKeyStore(dir));
    assert.ok((await first.publish("peer", await k.publishable())).ok);
    const restarted = new PreKeyDirectory(filePreKeyStore(dir));
    const replies = await Promise.all(Array.from({length:10},()=>restarted.fetch("peer")));
    assert.equal(new Set(replies.map(x=>x[0].opkId)).size,10);
    assert.ok(replies.every(x=>x[0].deviceId));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
