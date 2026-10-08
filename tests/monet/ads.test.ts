// Sponsored rooms + highlighted ads: flag gate, review queue, scheduling, frequency cap, room vs fallback card,
// aggregate-only stats + CSV, validation. Run via `npm run test:monet`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../server/monet/db";
import { AdsService } from "../../server/ads/service";
import { store } from "../../server/store";

useMemoryDb(true);
const ON = { ADS_ENABLED: "1" };

async function svc(env: Record<string, string> = ON) {
  const a = new AdsService(env);
  await a.init();
  return a;
}
const card = { advertiser: "Acme", kind: "card", placements: ["hallway", "explore"], title: "Try Acme", body: "Hi", ctaUrl: "https://acme.example/x", capPerDay: 2 };

test("validation: https links only, cards need title+link, rooms need a real host, end after start", async () => {
  const a = await svc();
  assert.equal((await a.create("admin", { ...card, ctaUrl: "http://acme.example" })).ok, false);
  assert.equal((await a.create("admin", { ...card, ctaUrl: "javascript:alert(1)" })).ok, false);
  assert.equal((await a.create("admin", { ...card, title: "" })).ok, false);
  assert.equal((await a.create("admin", { advertiser: "A", kind: "room", hostId: "@nobody_here_xyz" })).ok, false);
  assert.equal((await a.create("admin", { ...card, startsAt: 2000, endsAt: 1000 })).ok, false);
  assert.equal((await a.create("admin", { ...card, advertiser: "" })).ok, false);
});

test("review queue: only approved, in-schedule campaigns are served; edits go back to review", async () => {
  const a = await svc();
  const c = await a.create("admin", card);
  assert.ok(c.ok);
  assert.equal(c.campaign.status, "draft");
  assert.equal(a.slot("u1", "hallway"), null, "drafts never serve");
  assert.equal((await a.transition("admin", c.campaign.id, "approve", "")).ok, false, "must be submitted first");
  assert.ok((await a.transition("admin", c.campaign.id, "submit", "")).ok);
  assert.equal(a.slot("u1", "hallway"), null, "pending review never serves");
  assert.equal((await a.transition("admin", c.campaign.id, "reject", "")).ok, false, "reject needs a note");
  assert.ok((await a.transition("admin", c.campaign.id, "approve", "ok")).ok);
  const ad = a.slot("u1", "hallway");
  assert.ok(ad && ad.title === "Try Acme" && ad.kind === "card");
  assert.ok(!("contact" in ad!) && !("booking" in ad!), "viewers never see booking/contact");
  // content edit → back to review; booking-only edit stays approved
  assert.equal((await a.update("admin", c.campaign.id, { booking: { priceCents: 25000, reference: "INV-1" } })).campaign?.status, "approved");
  assert.equal((await a.update("admin", c.campaign.id, { title: "New title" })).campaign?.status, "pending_review");
  assert.equal(a.slot("u2", "hallway"), null);
  await a.transition("admin", c.campaign.id, "approve", "");
  assert.ok((await a.transition("admin", c.campaign.id, "pause", "")).ok);
  assert.equal(a.slot("u3", "hallway"), null, "paused never serves");
  assert.equal((await a.remove(c.campaign.id)).ok, true);
});

test("flag off (default): nothing served, no events, admin still works", async () => {
  const a = await svc({});
  const c = await a.create("admin", card);
  await a.transition("admin", c.campaign!.id, "submit", "");
  await a.transition("admin", c.campaign!.id, "approve", "");
  assert.equal(a.slot("u1", "hallway"), null);
  assert.equal(a.event("u1", c.campaign!.id, "hallway", "click"), false);
});

test("schedule + frequency cap + placements", async () => {
  const a = await svc();
  const now = Date.now();
  const later = await a.create("admin", { ...card, startsAt: now + 3_600_000 });
  await a.transition("admin", later.campaign!.id, "submit", "");
  await a.transition("admin", later.campaign!.id, "approve", "");
  assert.equal(a.slot("u1", "hallway"), null, "not started yet");
  assert.ok(a.slot("u1", "hallway", now + 3_700_000), "starts on time");
  const c = await a.create("admin", { ...card, placements: ["explore"], capPerDay: 2 });
  await a.transition("admin", c.campaign!.id, "submit", "");
  await a.transition("admin", c.campaign!.id, "approve", "");
  assert.equal(a.slot("u9", "hallway"), null, "explore-only campaign not in hallway");
  assert.ok(a.slot("u9", "explore"));
  assert.ok(a.slot("u9", "explore"));
  assert.equal(a.slot("u9", "explore"), null, "cap 2/day reached");
  assert.ok(a.slot("u10", "explore"), "cap is per person");
  assert.equal(a.slot("u9", "nowhere"), null);
});

test("sponsored room: features the host's live room, falls back to the card when offline", async () => {
  const a = await svc();
  const host = [...store.users.values()].find((u) => !u.isBot) ?? [...store.users.values()][0];
  if (!host) return;
  const c = await a.create("admin", { advertiser: "Podcast Co", kind: "room", hostId: `@${host.username}`, placements: ["hallway"], title: "Our show", ctaUrl: "https://pod.example" });
  assert.ok(c.ok, JSON.stringify(c));
  await a.transition("admin", c.campaign.id, "submit", "");
  await a.transition("admin", c.campaign.id, "approve", "");
  const live = store.listRooms().find((r) => r.hostId === host.id);
  const ad = a.slot("viewer", "hallway");
  assert.ok(ad);
  if (live) assert.equal(ad!.room?.id, live.id);
  else assert.equal(ad!.kind, "card", "offline host → fallback card");
});

test("stats: aggregate counters only, click/join once per person per day, only after being served; CSV", async () => {
  const a = await svc();
  const c = await a.create("admin", card);
  await a.transition("admin", c.campaign!.id, "submit", "");
  await a.transition("admin", c.campaign!.id, "approve", "");
  const id = c.campaign!.id;
  assert.equal(a.event("never-served", id, "hallway", "click"), false);
  a.slot("u1", "hallway");
  a.slot("u2", "hallway");
  assert.ok(a.event("u1", id, "hallway", "click"));
  assert.ok(a.event("u1", id, "hallway", "click"), "dupe accepted but not counted");
  assert.equal(a.event("u1", id, "hallway", "steal"), false);
  const d = new Date().toISOString().slice(0, 10);
  const rows = await a.report(d, d);
  const r = rows.find((x) => x.campaignId === id && x.placement === "hallway")!;
  assert.deepEqual([r.impressions, r.clicks, r.joins], [2, 1, 0]);
  assert.ok(!JSON.stringify(rows).includes("u1"), "no user ids in stats");
  const csv = await a.reportCsv(d, d);
  assert.match(csv, /^day,campaign_id,advertiser,title,placement,impressions,clicks,joins,ctr\n/);
  assert.match(csv, /Acme,Try Acme,hallway,2,1,0,50\.00%/);
});
