import test from "node:test";
import assert from "node:assert/strict";
import { GroupRinger } from "../../server/calls/groupRing";

const mk = () => {
  const ev: Array<[string, string, unknown]> = []; const rang: string[] = []; const cancelled: string[] = []; const missed: string[] = [];
  const g = new GroupRinger((u, e, d) => ev.push([u, e, d]), {
    roomOf: (u: string) => (u === "a" ? "room1" : null), members: () => ["a", "b", "c", "d"], policy: (_a: string, b: string) => ({ ok: b !== "d" }) as never,
    user: () => ({ name: "Ann", photoUrl: null }), ringNative: (t: string) => void rang.push(t), cancelNative: (t: string) => void cancelled.push(t), missed: (t: string) => void missed.push(t),
  } as never);
  return { g, ev, rang, cancelled, missed };
};

test("group ring: fans out to every allowed member except the caller on in-app + native; answer stops that member only", () => {
  const { g, ev, rang, cancelled, missed } = mk();
  const r = g.start("a", { groupId: "g1" });
  assert.ok(r.ok);
  assert.deepEqual(rang, ["b", "c"]);
  assert.equal(ev.filter((e) => e[1] === "ring:incoming").length, 2);
  const id = (r as { id: string }).id;
  assert.equal(g.respond(id, "b", true).roomId, "room1");
  assert.deepEqual(cancelled, ["b"]);
  assert.ok(g.cancel(id, "a").ok);
  assert.deepEqual(cancelled, ["b", "c"]);
  assert.deepEqual(missed, ["c"], "only the member who never answered gets a missed call");
});

test("group ring: caller must be in a room or pass one; non-members can't ring a group", () => {
  const { g } = mk();
  assert.equal(g.start("b", { groupId: "g1" }).ok, false);
  assert.equal(g.start("x", { groupId: "g1", roomId: "r2" }).ok, false);
  assert.ok(g.start("b", { groupId: "g1", roomId: "r2" }).ok);
});
