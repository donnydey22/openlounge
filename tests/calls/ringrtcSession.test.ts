import { test } from "node:test";
import assert from "node:assert/strict";
import { OlKeyStore, memoryKv, SealedSignaling } from "../../src/lib/calls/ringrtc";
import { OlSession } from "../../src/lib/calls/ringrtc/olx3dh";
import { RcRelay } from "../../server/calls/rcRelay";

async function pair() {
  const a = new OlKeyStore(memoryKv()), b = new OlKeyStore(memoryKv());
  const pub = await b.publishable();
  return { a, b, bundle: { userId: "b", ikDh: pub.ikDh, ikSig: pub.ikSig, spkId: pub.spkId, spk: pub.spk, spkSig: pub.spkSig, opkId: pub.opks[0].id, opk: pub.opks[0].pub } };
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
  await sock("b").request("rc:keys:publish", await kb.publishable());
  const A = new SealedSignaling(sock("a"), ka, { callId: "c1", role: "caller", peerUserId: "b" });
  const B = new SealedSignaling(sock("b"), kb, { callId: "c1", role: "callee", peerUserId: "a" });
  const gotB: any[] = [], gotA: any[] = [];
  B.on("rtc:signal", (d) => gotB.push(d)); A.on("rtc:signal", (d) => gotA.push(d));
  assert.deepEqual(await B.request("rtc:signal", { kind: "ready" }), { ok: true }); // held pre-session
  await A.request("rtc:signal", { callId: "c1", kind: "offer", sdp: "v=0 secret" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gotB[0].sdp, "v=0 secret");
  assert.equal(gotA[0].kind, "ready");
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
