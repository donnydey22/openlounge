// Donny t6082u: call links survive a backend restart / redeploy (link record in the DB, additive table call_links).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CallService, type CallLinkRow } from "../../server/calls/service";
import type { CallMediaBackend } from "../../server/calls/mediaBackend";

const backend = (): CallMediaBackend => ({ provider: "olcall" as never, issue: async ({ callId, userId }) => ({ provider: "olcall" as never, url: "wss://x/v1/call", token: `${callId}-${userId}` }), close: () => {} });
function svc(db: Map<string, CallLinkRow>, events: string[] = []) {
  const idle = (id: string) => ({ status: 200, legs: { caller: { callId: id, leg: "caller", state: "idle", seq: 0 }, callee: { callId: id, leg: "callee", state: "idle", seq: 0 } } });
  return new CallService({
    emitUser: () => {}, isConnected: () => true, isForeground: () => true, peer: (id: string) => ({ id, name: id, color: "#000", photoUrl: null }),
    policy: () => ({ ok: true }), inRoom: () => false, appendCallMessage: () => {}, selectMedia: backend,
    olcallEvent: ((e: string, id: string) => { events.push(e); return Promise.resolve(idle(id)); }) as never,
    linkStore: { save: (l) => { db.set(l.id, l); }, load: async (id?: string) => (id ? [...db.values()].filter((l) => l.id === id) : [...db.values()]) },
  });
}

test("a link made before a restart is joinable after it (boot restore), empty, by both people, with no deadline", async () => {
  const db = new Map<string, CallLinkRow>();
  const a = svc(db);
  const r = await a.createLink("u1", "u2"); assert.ok(r.ok); if (!r.ok) return;
  assert.equal(db.size, 1);
  a.dispose();
  const ev: string[] = [];
  const b = svc(db, ev); // the redeployed backend
  try {
    assert.equal(await b.restoreLinks(), 1);
    const g = await b.get_(r.call.id, "u2"); assert.ok(g.ok); if (!g.ok) return;
    assert.equal(g.call.link, true); assert.equal(g.call.expiresAt, 0);
    const j1 = await b.joinLink(r.call.id, "u2", "c2"); assert.ok(j1.ok);
    const j2 = await b.joinLink(r.call.id, "u1", "c1"); assert.ok(j2.ok);
    assert.equal(ev.filter((e) => e === "call:link").length, 2); // re-registered with the call server on each tap
    b.hangup(r.call.id, "u2"); // leave
    const j3 = await b.joinLink(r.call.id, "u2", "c2b"); assert.ok(j3.ok); // rejoin the same link
    // outsiders still cannot see it
    assert.equal((await b.get_(r.call.id, "u3")).ok, false);
  } finally { b.dispose(); }
});

test("a link made by a sibling instance (deploy overlap) loads on first tap", async () => {
  const db = new Map<string, CallLinkRow>();
  const b = svc(db);
  try {
    db.set("sib-1", { id: "sib-1", callerId: "u1", calleeId: "u2", createdAt: 1 });
    const j = await b.joinLink("sib-1", "u1", "c1"); assert.ok(j.ok);
    assert.equal((await b.joinLink("nope", "u1", "c1")).ok, false);
  } finally { b.dispose(); }
});
