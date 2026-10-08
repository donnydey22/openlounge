// Search index + privacy against a real Postgres (HX_TEST_DATABASE_URL with migrations 001…020 applied).
// Skips when no test database is configured.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { parseSearchQuery as Q } from "../../src/lib/searchQuery";

const URL_ = process.env.HX_TEST_DATABASE_URL;
const t = URL_ ? test : test.skip;
let db: pg.Client;
let hx: typeof import("../../server/chatSearch");
const P = `t${Date.now().toString(36)}`;
const id = (s: string) => `${P}_${s}`;
const ids = (r: { id: string }[]) => r.map((x) => x.id);

before(async () => {
  if (!URL_) return;
  process.env.DATABASE_URL = URL_;
  db = new pg.Client({ connectionString: URL_ });
  await db.connect();
  hx = await import("../../server/chatSearch");
  const u = (k: string, bio = "", deleted: number | null = null) =>
    db.query("INSERT INTO users (id,name,username,color,bio,created_at,deleted_at) VALUES ($1,$2,$3,'#10B981',$4,1,$5)", [id(k), `${k} Name`, `${P}${k}`.slice(0, 20), bio, deleted]);
  await u("me", "into #Jazz");
  await u("bob", "#jazz and #blues");
  await u("eve");
  await u("gone", "#jazz forever", 123);
  await u("blk", "#jazz too");
  await u("maya", "singer");
  const h = (k: string) => `@${`${P}${k}`.slice(0, 20)}`;
  const cv = (a: string, b: string) => [id(a), id(b)].sort().join("|");
  const dm = (mid: string, from: string, to: string, text: string, at: number, conv?: string) =>
    db.query("INSERT INTO dms (id,conversation_id,from_id,from_name,from_color,to_id,text,created_at) VALUES ($1,$2,$3,$3,'#fff',$4,$5,$6)", [
      id(mid), conv ?? cv(from, to), id(from), id(to), text, at,
    ]);
  await dm("m1", "me", "bob", `tonight #Jazz at 9 with ${h("maya")}`, 10);
  await dm("m2", "bob", "me", "late #jazz session https://x.com/#jazz telephoto", 20);
  await dm("m3", "bob", "eve", `secret #jazz between bob and eve ${h("maya")}`, 30); // not mine
  await dm("m4", "gone", "me", "#jazz from a deleted account", 40);
  await dm("m5", "blk", "me", "#jazz from someone I blocked", 50);
  await dm("m6", "me", "bob", "code `#jazz` only, dinner plans", 60);
  await db.query("INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES ($1,$2,1)", [id("me"), id("blk")]);
  await db.query("INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2)", [id("me"), id("maya")]);
  for (const [g, del] of [["g_in", null], ["g_out", null], ["g_del", 5]] as const)
    await db.query("INSERT INTO conversations (id,type,title,created_at,updated_at,deleted_at) VALUES ($1,'group',$2,1,1,$3)", [id(g), g, del]);
  await db.query("INSERT INTO conversation_members (conversation_id,user_id,joined_at) VALUES ($1,$2,1),($1,$3,1),($4,$3,1),($5,$2,1)", [id("g_in"), id("me"), id("bob"), id("g_out"), id("g_del")]);
  await dm("g1", "bob", "g_in", `group #jazz hello ${h("maya")} #music`, 70, id("g_in"));
  await dm("g2", "bob", "g_out", "other group #jazz", 80, id("g_out"));
  await dm("g3", "bob", "g_del", "deleted group #jazz", 90, id("g_del"));
  await db.query("INSERT INTO rooms (id,title,topic,description,host_id,created_at) VALUES ($1,'Late #Jazz','music','',$2,1),($3,'Maya live #music','music','',$4,2)", [
    id("r1"), id("bob"), id("r2"), id("maya"),
  ]);
});

after(async () => {
  if (!URL_) return;
  for (const tb of ["dms", "rooms", "conversations", "users"]) await db.query(`DELETE FROM ${tb} WHERE id LIKE $1`, [P + "%"]);
  await db.end();
  await (globalThis as unknown as { __olHxPool?: pg.Pool }).__olHxPool?.end();
});

t("#tag: only my 1:1s + groups I'm in, newest first; deleted/blocked/code/URL-fragment excluded", async () => {
  const r = await hx.search(id("me"), Q("#jazz"), { scope: "all" });
  assert.deepEqual(ids(r.messages), [id("g1"), id("m2"), id("m1")]);
  assert.equal(r.total, 3);
  assert.equal(r.messages[1].href, `/messages/${id("bob")}?m=${id("m2")}`);
  assert.deepEqual(ids(r.rooms), [id("r1")]);
  assert.deepEqual(ids(r.people).sort(), [id("bob"), id("me")].sort());
});

t("in-chat: keyword prefix + partial word, from: filter, pagination, delete drops out", async () => {
  const kw = await hx.search(id("me"), Q("photo"), { scope: "chat", chat: id("bob") }); // partial word (telephoto)
  assert.deepEqual(ids(kw.messages), [id("m2")]);
  const din = await hx.search(id("me"), Q("dinn"), { scope: "chat", chat: id("bob") });
  assert.deepEqual(ids(din.messages), [id("m6")]);
  const from = await hx.search(id("me"), Q(""), { scope: "chat", chat: id("bob"), from: id("bob") });
  assert.deepEqual(ids(from.messages), [id("m2")]);
  const p1 = await hx.search(id("me"), Q("#jazz"), { scope: "chat", chat: id("bob"), limit: 1 });
  assert.deepEqual(ids(p1.messages), [id("m2")]);
  assert.equal(p1.total, 2);
  const p2 = await hx.search(id("me"), Q("#jazz"), { scope: "chat", chat: id("bob"), limit: 1, before: hx.parseCursor(p1.next) });
  assert.deepEqual(ids(p2.messages), [id("m1")]);
  await db.query("DELETE FROM dms WHERE id = $1", [id("m2")]);
  const after = await hx.search(id("me"), Q("#jazz"), { scope: "chat", chat: id("bob") });
  assert.deepEqual(ids(after.messages), [id("m1")]);
  const grp = await hx.search(id("me"), Q("hello"), { scope: "chat", chat: id("g_in") });
  assert.deepEqual(ids(grp.messages), [id("g1")]);
  const notMine = await hx.search(id("me"), Q("other"), { scope: "chat", chat: id("g_out") });
  assert.deepEqual(ids(notMine.messages), []);
});

t("@mention: profile card + mentioning messages in my chats only + their rooms; '@maya #music' intersects", async () => {
  const handle = `@${`${P}maya`.slice(0, 20)}`;
  const r = await hx.search(id("me"), Q(handle), { scope: "all" });
  assert.deepEqual(ids(r.profiles), [id("maya")]);
  assert.equal(r.profiles[0].following, true);
  assert.deepEqual(ids(r.messages), [id("g1"), id("m1")]); // not m3 (bob↔eve)
  assert.deepEqual(ids(r.rooms), [id("r2")]);
  const both = await hx.search(id("me"), Q(`${handle} #music`), { scope: "all" });
  assert.deepEqual(ids(both.messages), [id("g1")]);
  assert.deepEqual(ids(both.rooms), [id("r2")]);
  const blocked = await hx.search(id("me"), Q(`@${`${P}blk`.slice(0, 20)}`), { scope: "all" });
  assert.deepEqual(blocked.profiles, []);
});

t("suggestions: #prefix tags by my use; @prefix people (followed first, blocked/deleted hidden)", async () => {
  assert.ok((await hx.suggestTags(id("me"), "j")).some((x) => x.tag === "jazz"));
  assert.deepEqual((await hx.suggestTags(id("me"), "%")).length, 0);
  const people = await hx.suggestPeople(id("me"), P.slice(0, 6));
  assert.equal(people[0].id, id("maya"));
  assert.ok(!people.some((x) => x.id === id("blk") || x.id === id("gone")));
  const mem = await hx.chatMembers(id("me"), id("g_in"));
  assert.deepEqual(mem?.map((x) => x.id), [id("me"), id("bob")]);
  assert.equal(await hx.chatMembers(id("me"), id("g_out")), null);
});
