// Creator & business accounts: flag gate, verification (docs private + deleted on decision, paid via the shared
// PayPal pipeline, refund handling), badges, branding/slug rules, series schedule, analytics sampler.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { useMemoryDb } from "../../server/monet/db";
import { MemoryStickerRepo } from "../../server/stickers/repo";
import { StickerService, setStickerService } from "../../server/stickers/service";
import { CreatorService, setCreatorService, VERIFY_DOCS, zonedTime, weekdayIn } from "../../server/creator/service";
import { badgesOf } from "../../server/monet/registry";
import "../../server/creator/routes"; // registers the verified badge provider
import { store } from "../../server/store";
import { fakePayPal, hook, PAID_ENV } from "./fake-paypal";

useMemoryDb(true);
const ON = { ...PAID_ENV, CREATOR_ENABLED: "1" };
const png = async () => "data:image/png;base64," + (await (await import("sharp")).default({ create: { width: 40, height: 30, channels: 3, background: "#09f" } }).png().toBuffer()).toString("base64");
const pdf = "data:application/pdf;base64," + Buffer.from("%PDF-1.4\n%fake\n").toString("base64");

async function setup(env: Record<string, string> = ON) {
  const pp = fakePayPal();
  const svc = new StickerService({ repo: new MemoryStickerRepo(), env, fetchFn: pp.fetchFn, mailer: async () => true, users: { email: () => "me@example.com", name: () => "Me", exists: () => true } });
  setStickerService(svc);
  await svc.init();
  const c = new CreatorService(env);
  setCreatorService(c);
  await c.init({ sampler: false });
  return { svc, c, pp };
}
beforeEach(() => {
  setStickerService(null);
  setCreatorService(null);
});

test("flag off (default): everything refuses, no badges", async () => {
  const { c } = await setup({ ...PAID_ENV });
  assert.equal(c.config().enabled, false);
  assert.equal((await c.apply("u1", { kind: "creator", legalName: "A", country: "US", idDoc: await png() })).ok, false);
  assert.equal((await c.setProfile("u1", { type: "creator" })).ok, false);
  await c.badges.put({ id: "u1", verified: "creator", since: 1, requestId: "x" });
  assert.equal(c.verifiedOf("u1"), null);
  assert.equal(c.page("anything"), null);
});

test("verification: docs required + sanitised, paid through PayPal, admin approves → badge; docs deleted", async () => {
  const { c, svc } = await setup();
  assert.equal((await c.apply("u1", { kind: "creator", legalName: "Ann Lee", country: "US", idDoc: "data:text/html;base64,PGgxPg==" })).ok, false);
  assert.equal((await c.apply("u1", { kind: "creator", legalName: "Ann Lee", country: "US", idDoc: "data:application/pdf;base64," + Buffer.from("<html>").toString("base64") })).ok, false, "fake PDF rejected");
  assert.equal((await c.apply("u1", { kind: "business", legalName: "Ann Lee", country: "US", idDoc: await png() })).ok, false, "business needs a name");
  const r = await c.apply("u1", { kind: "creator", legalName: "Ann Lee", country: "us", website: "https://ann.example", idDoc: await png() });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.request.status, "awaiting_payment");
  assert.equal(r.request.feeCents, 1499);
  const docPath = path.join(VERIFY_DOCS, r.request.docs[0].id);
  assert.ok(fs.existsSync(docPath));
  assert.equal(fs.statSync(docPath).mode & 0o777, 0o600, "private file");
  assert.ok((await c.readDoc(r.request.docs[0].id))?.mime === "image/jpeg", "images re-encoded (EXIF stripped)");
  assert.equal(c.queue().length, 0, "unpaid requests aren't in the review queue");
  assert.equal(((await svc.createCheckout("u2", r.checkoutRef!, "paypal")) as any).status, 404, "someone else's request");
  assert.equal(((await svc.createCheckout("u1", r.checkoutRef!, "paypal", { wrapper: true })) as any).status, 403, "never in the apps");
  const co = await svc.createCheckout("u1", r.checkoutRef!, "paypal");
  assert.ok(co.ok);
  await svc.capture("u1", co.orderId);
  assert.equal(c.queue().length, 1);
  assert.equal((await c.decide("admin", r.request.id, false, "")).ok, false, "reject needs a reason");
  assert.ok((await c.decide("admin", r.request.id, true, "")).ok);
  assert.equal(c.verifiedOf("u1"), "creator");
  assert.deepEqual(badgesOf("u1"), { verified: "creator" });
  assert.ok(!fs.existsSync(docPath), "ID document deleted after the decision");
  assert.equal(c.requests.get(r.request.id)!.docs.length, 0);
  // refund after approval → badge revoked
  const [h, raw] = hook("E-V1", "PAYMENT.CAPTURE.REFUNDED", { id: "RF", links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/CAP-${co.orderId}` }] });
  assert.equal((await svc.webhook(h, raw)).status, 200);
  assert.equal(c.verifiedOf("u1"), null);
  assert.equal(c.requests.get(r.request.id)!.status, "revoked");
});

test("business verification needs a business document; fee waiver skips payment; reject deletes docs", async () => {
  const { c } = await setup({ ...ON, VERIFY_FEE_WAIVED: "1" });
  assert.equal((await c.apply("u3", { kind: "business", legalName: "Bo", businessName: "Bo LLC", country: "US", idDoc: await png() })).ok, false);
  const r = await c.apply("u3", { kind: "business", legalName: "Bo", businessName: "Bo LLC", country: "US", idDoc: await png(), businessDoc: pdf });
  assert.ok(r.ok && r.request.status === "pending" && r.checkoutRef === null);
  const files = r.request.docs.map((d) => path.join(VERIFY_DOCS, d.id));
  assert.ok(files.every((f) => fs.existsSync(f)));
  assert.ok((await c.decide("admin", r.request.id, false, "Registration document is unreadable")).ok);
  assert.ok(files.every((f) => !fs.existsSync(f)));
  assert.equal(c.verifiedOf("u3"), null);
});

test("branding: needs creator account, slug rules, colors, co-hosts; public page", async () => {
  const { c } = await setup();
  const users = [...store.users.values()];
  const host = users[0];
  if (!host) return;
  assert.equal((await c.saveBranding(host.id, { slug: "mybrand" })).ok, false, "creator account first");
  await c.setProfile(host.id, { type: "business" });
  assert.equal((await c.saveBranding(host.id, { slug: "ab" })).ok, false);
  assert.equal((await c.saveBranding(host.id, { slug: "admin" })).ok, false, "reserved");
  assert.equal((await c.saveBranding(host.id, { slug: "my_brand" })).ok, false);
  assert.equal((await c.saveBranding(host.id, { coHosts: ["@definitely_not_a_user_x"] })).ok, false);
  const b = await c.saveBranding(host.id, { slug: "My-Brand", accent: "#ff0000", background: "nope", displayName: "My Brand", logoData: await png(), coHosts: users[1] ? [users[1].id, host.id] : [] });
  assert.ok(b.ok, JSON.stringify(b));
  assert.equal(b.branding.slug, "my-brand");
  assert.equal(b.branding.accent, "#FF0000");
  assert.equal(b.branding.background, "#0B0B0D");
  assert.match(b.branding.logo!, /^\/creator-files\/.+-logo-[0-9a-f]{8}\.webp$/);
  assert.ok(!b.branding.coHosts.includes(host.id));
  if (users[1]) assert.ok(c.isCoHost(host.id, users[1].id));
  if (users[1]) {
    await c.setProfile(users[1].id, { type: "creator" });
    assert.equal((await c.saveBranding(users[1].id, { slug: "my-brand" })).ok, false, "slug taken");
  }
  const page = c.page("my-brand");
  assert.ok(page && page.host.id === host.id && page.branding.displayName === "My Brand");
});

test("series: validation and upcoming occurrences in the host's time zone", async () => {
  const { c } = await setup();
  await c.setProfile("h1", { type: "creator" });
  assert.equal((await c.saveSeries("h1", { title: "x", weekdays: [], time: "09:00" })).ok, false);
  assert.equal((await c.saveSeries("h1", { title: "x", weekdays: [1], time: "25:00" })).ok, false);
  const s = await c.saveSeries("h1", { title: "Morning show", weekdays: [1, 3, 5], time: "09:30", tz: "America/Phoenix", durationMin: 45 });
  assert.ok(s.ok);
  const up = c.upcoming("h1", Date.UTC(2026, 9, 5, 12)); // Mon Oct 5 2026 05:00 Phoenix
  assert.ok(up.length >= 3);
  for (const u of up) {
    assert.ok([1, 3, 5].includes(weekdayIn(u.at, "America/Phoenix")));
    assert.equal(new Date(u.at).getUTCHours() * 60 + new Date(u.at).getUTCMinutes(), 16 * 60 + 30, "09:30 Phoenix = 16:30 UTC");
  }
  assert.equal(zonedTime(Date.UTC(2026, 6, 1, 12), "09:00", "America/New_York"), Date.UTC(2026, 6, 1, 13), "DST aware");
  assert.equal((await c.deleteSeries("other", s.series.id)).ok, false);
  assert.ok((await c.deleteSeries("h1", s.series.id)).ok);
});

test("analytics: sampler records unique listeners, peak, listener-minutes, retention; only for creator hosts", async () => {
  const { c } = await setup();
  const rooms = (store as any).rooms as Map<string, any>;
  const room = { id: "r_test_analytics", title: "Show", hostId: "host1", ended: false, private: false, createdAt: 0, participants: new Map<string, any>() };
  rooms.set(room.id, room);
  const t0 = Date.UTC(2026, 9, 8, 10);
  room.createdAt = t0;
  try {
    room.participants.set("host1", { userId: "host1", role: "host" });
    room.participants.set("a", { userId: "a", role: "listener" });
    await c.sample(t0);
    assert.equal(c.sessions.get(room.id), null, "not a creator account → nothing recorded");
    await c.setProfile("host1", { type: "creator" });
    await c.sample(t0);
    room.participants.set("b", { userId: "b", role: "listener" });
    room.participants.set("c", { userId: "c", role: "speaker" });
    for (let m = 1; m <= 10; m++) {
      if (m === 3) room.participants.delete("b");
      await c.sample(t0 + m * 60_000);
    }
    let s = c.sessions.get(room.id)!;
    assert.equal(s.uniqueListeners, 3);
    assert.equal(s.peak, 3);
    assert.equal(s.endedAt, null);
    assert.ok(s.listenerMinutes >= 20 && s.listenerMinutes <= 22, String(s.listenerMinutes));
    assert.equal(s.retention.m5, 0.67, "b left after 2 min");
    assert.equal(s.retention.m30, null, "too early to tell");
    room.ended = true;
    await c.sample(t0 + 11 * 60_000);
    s = c.sessions.get(room.id)!;
    assert.equal(s.endedAt, t0 + 11 * 60_000);
    const a = c.analytics("host1", 3650);
    assert.equal(a.totals.rooms, 1);
    assert.equal(a.totals.peak, 3);
    assert.ok(a.followers.length >= 1, "daily follower snapshot");
    assert.ok(!JSON.stringify(a).match(/"a"|"b"|"c"/), "no listener ids stored");
  } finally {
    rooms.delete(room.id);
  }
});
